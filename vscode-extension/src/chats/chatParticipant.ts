/**
 * `@di` chat participant — agentic tool-loop architecture.
 *
 * Instead of generating a single monolithic script and verifying it,
 * the agent iterates: it can call tools (run scripts, read files, list
 * items), see the results, reason about them, and decide the next action.
 *
 * Inspired by the Claude Code agent loop pattern:
 *   - No intent classifier — the LLM always has both text and tools
 *   - No separate verify step — the agent sees output and self-corrects
 *   - Conversational by default — responds naturally when no tools needed
 *   - Multi-step capable — chains tool calls for complex workflows
 *
 * Flow per chat turn:
 *   1. Build system prompt + user message
 *   2. Send to LLM with tool definitions (run_script, read_local_file)
 *   3. If LLM returns text → stream to user, done
 *   4. If LLM calls tools → execute them, feed results back, goto 2
 *   5. Repeat until LLM responds with text or max rounds reached
 *  6. Present verified result to the user
 */

import * as vscode from "vscode";
import * as fs from "fs";
import { randomUUID } from "node:crypto";
import { createSandbox, type Sandbox, type CellResult } from "@/services/vm/sandbox";
import { getBaseFolder } from "@/utils/folders";
import { getSettings } from "@/utils/settings";
import { log, error, debug } from "@/utils/channel_log";
import * as sdkLog from "@/utils/sdk_log";
import { isMicrosoftAccount } from "@/utils/msft.tenant.utils";
import { openBugReport, copyBugReport, type BugReportPayload } from "@/utils/reportError.utils";
import { DICodeLensProvider, editScript, runScript } from "@/chats/editableSource";
import { ChatLanguageProvider } from "@/language-provider/index";
import {
    ORIGINAL_SCHEME,
    OriginalContentProvider,
    applyFileEdit,
    renderFileEditSummary,
    type FileEditResult,
} from "@/chats/chatParticipant/fileEdit";
import {
    classifyLiveDataClaim,
    DISPUTE_REMINDER,
    looksLikeUserDispute,
    UNVERIFIED_CLAIM_NUDGE,
} from "@/chats/chatParticipant/groundTruthGuard";
import { VerifiedFactsLedger } from "@/chats/chatParticipant/verifiedFactsLedger";
import { compactIfNeeded } from "@/chats/chatParticipant/compaction";
import {
    getToolDefinitions,
    executeReadFile,
    executeLoadReference,
    executeSearchDocs,
    executeLookupType,
    executeListSymbols,
    executeAskUserInput,
    executeAskUserChoice,
    executeRevealInFile,
    type DocsToolOptions,
} from "@/chats/chatParticipant/tools";
import { loadDocsIndex, renderDocsMap } from "@/chats/chatParticipant/docsIndex";
import { buildSystemPrompt } from "@/chats/chatParticipant/systemPrompt";
import { executeAskUserForm } from "@/chats/chatParticipant/userForm";
import { type ChatView, VERBOSE_VIEW, FRIENDLY_VIEW } from "@/chats/chatParticipant/chatView";

const PARTICIPANT_ID = "fabricDataFactory.di";

/** Cap on the in-memory ring buffer that backs `/reportError`. */
const MAX_RECENT_SCRIPT_ERRORS = 50;

/**
 * Maximum size (chars) of a single `run_script` output fed back to the
 * LLM. The sandbox transpiler appends a `this[...] = ...` decl-capture
 * block to every script, and chatty `console.log`s can balloon a
 * tool_result into tens of thousands of tokens. We truncate the
 * `output` field (keeping head + tail) so the agent still sees the
 * meaningful parts without exploding the context window.
 *
 * 16 000 chars ≈ 4 000 tokens. Raised from 8 000 because Airflow task
 * logs (the most common large output) put the failure traceback in the
 * *tail*, and the 8 000 cap was clipping real tracebacks mid-stack.
 */
const MAX_TOOL_RESULT_OUTPUT_CHARS = 16_000;

/**
 * Loop guard: if the agent runs the *same* script (modulo whitespace and
 * the trailing decl-capture block) this many times in a row, we abort
 * the loop and tell the user — the model is stuck and burning tokens.
 */
const MAX_DUPLICATE_SCRIPT_RUNS = 3;

/**
 * Ground Truth guard (enhancement S1): max times per turn the loop re-prompts
 * the model for an unverified live-data claim before giving up and streaming
 * the answer with an explicit "unverified" caveat. Bounds the dead-end so a
 * stubborn model can't loop to `maxToolRounds` with no user-visible reply.
 */
const MAX_UNVERIFIED_INTERVENTIONS = 2;

/**
 * Cap on the number of concurrent pending-handle sandboxes a single
 * participant can keep alive (C.3 "trigger now, await later" path).
 * Each pending handle is a live child process, so we don't want the
 * agent to be able to leak processes by issuing many long awaits and
 * never resuming them. When the cap is hit we dispose the oldest pending
 * sandbox to make room. 8 is plenty for any realistic chat session —
 * the typical pattern is 1 pending DAG run at a time.
 */
const MAX_PENDING_SANDBOXES = 8;

/**
 * Indirection between a still-running sandbox and the chat stream that should
 * show its console lines. A run can outlive the turn that started it (the C.3
 * pending-handle path), and a closed stream must not be written to — so the
 * target is set to `undefined` whenever no turn is waiting, and re-pointed by
 * whichever `await_handle` call resumes the wait.
 */
interface OutputSink {
    emit?: (line: string) => void;
}

/**
 * How long a `reveal_in_file` highlight stays before it auto-clears. Kept in
 * sync with the executor-side constant so the decoration and the "it'll fade"
 * expectation match. A colored band that never disappears would linger on a
 * config file long after the chat turn ended.
 */
const REVEAL_DECORATION_TTL_MS = 12_000;

/** Heuristic: does this error look like a context/token-limit overflow? */
function isTokenLimitError(err: unknown): boolean {
    const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return m.includes("token limit")
        || m.includes("context length")
        || m.includes("context_length")
        || m.includes("maximum context")
        || m.includes("too many tokens")
        || m.includes("exceeds") && m.includes("token");
}

/** Normalize a script for duplicate detection: strip whitespace + the trailing decl-capture block. */
function normalizeScriptForLoopCheck(script: string): string {
    // Drop the sandbox-injected `this["x"] = x;` lines and the
    // `Object.assign(this.__decl_kinds__ ...)` tail before comparing.
    return script
        .replace(/this\["[^"]+"\]\s*=\s*[^;]+;\s*/g, "")
        .replace(/Object\.assign\(this\.__decl_kinds__[\s\S]*$/m, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Count quoted spans in the user's prompt. Used only as an observability signal
 * on `ask_user_*` calls: a quoted name/path/id in the prompt is the cheap tell
 * for the agent asking about a value the user already supplied (enhancement F1).
 */
function countQuotedSpans(text: string): number {
    return (text.match(/"[^"\r\n]{2,}"|'[^'\r\n]{2,}'/g) ?? []).length;
}

/** Truncate the `output` field of a run_script tool result JSON if it's huge. */
function capRunScriptResult(resultJson: string): string {
    if (resultJson.length <= MAX_TOOL_RESULT_OUTPUT_CHARS) return resultJson;
    try {
        const parsed = JSON.parse(resultJson) as { output?: string; [k: string]: unknown };
        const output = typeof parsed.output === "string" ? parsed.output : "";
        if (output.length > MAX_TOOL_RESULT_OUTPUT_CHARS) {
            const head = output.slice(0, Math.floor(MAX_TOOL_RESULT_OUTPUT_CHARS * 0.7));
            const tail = output.slice(-Math.floor(MAX_TOOL_RESULT_OUTPUT_CHARS * 0.2));
            parsed.output =
                `${head}\n\n…[truncated ${output.length - head.length - tail.length} chars]…\n\n${tail}`;
        }
        return JSON.stringify(parsed);
    } catch {
        return resultJson.slice(0, MAX_TOOL_RESULT_OUTPUT_CHARS) + "…[truncated]";
    }
}

// ── Singleton instance ───────────────────────────────────────

let instance: DIChatParticipant | undefined;

// ── Public API ───────────────────────────────────────────────

/** Create a fresh sandbox with pending globals injected. Used by editableSource.ts. */
export function createFreshSandbox(): Sandbox {
    if (!instance) throw new Error("DIChatParticipant not initialized");
    return instance.createFreshSandbox();
}

/** Set a global variable in the chat sandbox. Used by AirflowService. */
export function setChatGlobal(name: string, value: unknown): void {
    instance?.setChatGlobal(name, value);
}

/** Register the @di chat participant. Called from extension.ts. */
export function registerChatParticipant(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
): void {
    instance = new DIChatParticipant(context, outputChannel);
    context.subscriptions.push(instance);
}

// ── DIChatParticipant ────────────────────────────────────────

export class DIChatParticipant implements vscode.Disposable {
    private readonly _langProvider: ChatLanguageProvider;
    private readonly _codeLensProvider: DICodeLensProvider;
    private readonly _originalProvider = new OriginalContentProvider();
    private readonly _extensionContext: vscode.ExtensionContext;
    private readonly _outputChannel: vscode.OutputChannel;
    private readonly _statusBar: vscode.StatusBarItem;
    private readonly _disposables: vscode.Disposable[] = [];
    private _referenceNames: string[] | undefined;
    /**
     * Doc refs / symbols already served to the model during the current
     * turn, so a repeated `load_reference` or `lookup_type` returns a
     * pointer instead of re-spending the context on identical text.
     * Cleared at the start of every turn (see `_handleRequestImpl`).
     */
    private readonly _servedDocRefs = new Set<string>();
    private readonly _pendingGlobals = new Map<string, unknown>();
    /**
     * Verified-facts ledger (action #4): per-session store of `@fact label = value`
     * markers emitted by successful run_script / await_handle runs. Re-injected
     * into the system prompt each turn so the model can cite real, timestamped
     * values instead of re-asserting remembered numbers (and so the Ground Truth
     * guard can tell a ledgered citation from an assumption). Cleared on /reset.
     */
    private readonly _facts = new VerifiedFactsLedger();
    /**
     * Saved agent-loop state when a turn hits `maxToolRounds`. The next
     * turn submitted with `/continue` (typically via the followup button)
     * picks this up and resumes from where it left off, preserving the
     * full tool_use / tool_result history that the chat context would
     * otherwise drop.
     */
    private _pendingContinuation: {
        messages: vscode.LanguageModelChatMessage[];
        allTools: vscode.LanguageModelChatTool[];
        prompt: string;
        lastScript: string | undefined;
        scriptCount: number;
        totalToolCalls: number;
    } | undefined;

    /**
     * Recent `run_script` failures captured at execution time. Used by
     * the `/reportError` command so the LLM has ground-truth error
     * text to summarise, even though VS Code's chat history only
     * preserves the final rendered markdown of past turns (raw
     * tool_result blocks are dropped between turns).
     *
     * Bounded at `MAX_RECENT_SCRIPT_ERRORS` to keep memory predictable.
     */
    private readonly _recentScriptErrors: Array<{
        when: string;
        script: string;
        output: string;
        error: string;
    }> = [];

    /**
     * The most recent *successful* `run_script` (single slot, not a ring).
     * `/reportError` quotes this so the bug draft can include the last
     * known-good verifier output (e.g. "I verified rows = N") even when the
     * failure itself produced no output. Overwritten on every success;
     * `undefined` until the first successful script in the session.
     */
    private _lastSuccessfulScript: {
        when: string;
        script: string;
        output: string;
        returnValue: string | null;
    } | undefined;

    /**
     * Sandboxes whose `run()` promise is still pending after the
     * `chatScriptTimeout` budget expired (C.3 "trigger now, await later"
     * path). The child process is intentionally kept alive so a later
     * `await_handle` tool call can resume waiting for the result.
     *
     * Each entry MUST be disposed exactly once — either when the run
     * completes via `await_handle`, when the participant is disposed,
     * when `resetSandbox()` is called, or when the registry cap
     * ({@link MAX_PENDING_SANDBOXES}) is hit and we evict the oldest.
     */
    private readonly _pendingSandboxes = new Map<string, {
        sandbox: Sandbox;
        /** The still-pending `sb.run(script, 0)` promise. Resolves once the worker actually finishes. */
        promise: Promise<CellResult>;
        /** Original script text (echoed back in error/diagnostic paths only). */
        script: string;
        /** ms-since-epoch timestamp captured at `_executeRunScript` entry. */
        startedAt: number;
        /** Live-output target, re-pointed at whichever turn is currently awaiting. */
        outputSink: OutputSink;
    }>();

    /**
     * The currently active `reveal_in_file` highlight decoration (single slot).
     * Tracked so we can auto-clear it after a TTL, replace it on the next
     * reveal, and dispose it on `/reset` / `dispose()` — a lingering colored
     * band on a config file would otherwise confuse the user long after the
     * chat moved on. `undefined` until the first reveal.
     */
    private _activeReveal: {
        decoration: vscode.TextEditorDecorationType;
        timer: ReturnType<typeof setTimeout>;
    } | undefined;

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this._extensionContext = context;
        this._outputChannel = outputChannel;
        this._langProvider = new ChatLanguageProvider(context.extensionUri);
        this._codeLensProvider = new DICodeLensProvider();

        // Status bar
        this._statusBar = vscode.window.createStatusBarItem("di-sandbox", vscode.StatusBarAlignment.Right, 50);
        this._statusBar.command = "fabricDataFactory.di.resetSandbox";
        this._statusBar.tooltip = "Click to reset DI Chat sandbox";
        this._statusBar.text = "$(vm-running) DI Sandbox";
        this._statusBar.show();

        const participant = vscode.chat.createChatParticipant(
            PARTICIPANT_ID,
            (req, ctx, stream, token) => this._handleRequest(req, ctx, stream, token),
        );
        participant.iconPath = vscode.Uri.joinPath(
            context.extensionUri, "resources", "svgs", "data_factory_48_color.svg",
        );
        participant.followupProvider = {
            provideFollowups: (result) => {
                if (result.metadata?.maxRoundsHit) {
                    return [{
                        prompt: "Resume the previous agent loop.",
                        label: "▶ Continue",
                        command: "continue",
                    }];
                }
                return [];
            },
        };

        this._disposables.push(
            participant,
            this._langProvider,
            this._statusBar,

            vscode.languages.registerCodeLensProvider(
                { language: "typescript", scheme: "file" },
                this._codeLensProvider,
            ),

            vscode.workspace.registerTextDocumentContentProvider(
                ORIGINAL_SCHEME, this._originalProvider,
            ),

            vscode.commands.registerCommand("fabricDataFactory.di.reviewFileEdit",
                (originalUri: string, fileUri: string, title: string) =>
                    vscode.commands.executeCommand(
                        "vscode.diff",
                        vscode.Uri.parse(originalUri), vscode.Uri.parse(fileUri), title,
                    )),

            vscode.commands.registerCommand("fabricDataFactory.di.editScript",
                (script: string) => editScript(script, context.globalStorageUri.fsPath, this._codeLensProvider)),

            vscode.commands.registerCommand("fabricDataFactory.di.runScript",
                (uri: vscode.Uri) => runScript(uri, context, outputChannel)),

            vscode.commands.registerCommand("fabricDataFactory.di.rerun",
                (script: string) => this._rerunScript(script)),

            vscode.commands.registerCommand("fabricDataFactory.di.resetSandbox",
                () => this.resetSandbox()),

            vscode.commands.registerCommand("fabricDataFactory.di.reportBug",
                (payload: BugReportPayload) => openBugReport(payload)),

            vscode.commands.registerCommand("fabricDataFactory.di.copyBugReport",
                (payload: BugReportPayload) => copyBugReport(payload)),
        );

        log("[di-chat] DIChatParticipant initialized (agentic mode)");
    }

    dispose(): void {
        this._statusBar.hide();
        for (const d of this._disposables) d.dispose();
        // Dispose any pending-handle sandboxes so we don't leak child
        // processes when the extension reloads or shuts down.
        this._disposePendingSandboxes("DIChatParticipant disposed");
        // Clear any lingering reveal_in_file highlight.
        this._clearRevealDecoration();
        instance = undefined;
        log("[di-chat] DIChatParticipant disposed");
    }

    // ── Public ───────────────────────────────────────────────

    /** Create a fresh sandbox with pending globals injected. Caller must dispose it. */
    createFreshSandbox(): Sandbox {
        const settings = getSettings();
        const baseFolder = getBaseFolder(this._extensionContext);

        const sb = createSandbox(
            { baseFolder },
            { timeout: settings.chatScriptTimeout, logger: (msg) => log(`[di-chat] ${msg}`) },
        );

        for (const [name, value] of this._pendingGlobals) {
            sb.setGlobal(name, value);
        }

        return sb;
    }

    setChatGlobal(name: string, value: unknown): void {
        if (value === undefined) {
            this._pendingGlobals.delete(name);
        } else {
            this._pendingGlobals.set(name, value);
        }
        log(`[di-chat] Set global: ${name}`);
    }

    resetSandbox(): void {
        this._pendingGlobals.clear();
        this._langProvider.setDynamicGlobals([]);
        // Drop the verified-facts ledger so the user gets a clean slate.
        this._facts.clear();
        this._servedDocRefs.clear();
        // Kill any pending-handle children so the user gets a true
        // clean slate when they hit Reset (e.g. while debugging a
        // runaway DAG poll).
        this._disposePendingSandboxes("sandbox reset");
        // Drop any lingering reveal_in_file highlight.
        this._clearRevealDecoration();
        log("[di-chat] Sandbox globals cleared");
        vscode.window.showInformationMessage("DI Chat sandbox reset.");
    }

    // ── Private: System prompt ───────────────────────────────

    private _buildSystemPrompt(): string {
        return buildSystemPrompt({
            extensionUri: this._extensionContext.extensionUri,
            // Progressive disclosure: the model gets a compact catalog (name →
            // summary → section ids) rather than the documents themselves, so
            // the common case is one targeted `load_reference` with no
            // `search_docs` round-trip first.
            docsMap: renderDocsMap(loadDocsIndex(this._extensionContext.extensionUri)),
            globals: this._pendingGlobals,
            verifiedFacts: this._facts.render(),
        });
    }


    // ── Private: Tool definitions ────────────────────────────

    private _getToolDefinitions(): vscode.LanguageModelChatTool[] {
        return getToolDefinitions(this._listReferenceNames());
    }

    // ── Private: Tool execution ──────────────────────────────

    private async _executeRunScript(
        script: string,
        token: vscode.CancellationToken,
        onOutput?: (line: string) => void,
    ): Promise<string> {
        // Type-check first
        const check = this._langProvider.typeCheck(script);
        if (check.hasErrors) {
            const msgs = check.errors.map(e => `Line ${e.line}: ${e.message}`);
            log(`[di-chat] Type-check failed: ${check.errors.length} error(s)`);
            this._outputChannel.appendLine(`[di-chat] Type-check errors:\n${msgs.join("\n")}\n[di-chat] Script:\n${script}`);
            const errText = `TypeScript errors:\n${msgs.join("\n")}`;
            this._pushRecentScriptError(script, "", errText);
            return JSON.stringify({ success: false, error: errText, output: "", returnValue: null });
        }

        const { chatScriptTimeout } = getSettings();
        const baseFolder = getBaseFolder(this._extensionContext);
        // `timeout: 0` disables the parent-side timer — we race the run
        // ourselves below so we can convert a timeout into a pending handle
        // instead of an unrecoverable rejection (C.3).
        //
        // Live console lines go through a mutable sink because the stream they
        // target outlives neither the turn nor the run: once the run goes
        // pending, this turn's stream is closed and a later `await_handle`
        // re-points the sink at the turn that is actually waiting.
        const outputSink: OutputSink = { emit: onOutput };
        const sb = createSandbox(
            { baseFolder },
            {
                timeout: 0,
                logger: (msg) => log(`[di-chat] ${msg}`),
                onOutput: (line) => outputSink.emit?.(line),
            },
        );
        for (const [n, v] of this._pendingGlobals) sb.setGlobal(n, v);

        const runPromise = sb.run(script, 0);
        const raced = await this._raceWithTimeout(runPromise, chatScriptTimeout, token);

        if (raced.kind === "cancelled") {
            // User hit Stop / steered mid-run: SIGTERM the child + reject the
            // in-flight run(), then let the CancellationError end the turn.
            sb.dispose();
            log("[di-chat] Script cancelled mid-run — disposed sandbox");
            throw new vscode.CancellationError();
        }

        if (raced.kind === "timeout") {
            // Long-await path: keep the child alive, return a handle so the
            // agent can resume from a later round via `await_handle`.
            outputSink.emit = undefined;
            const handle = this._registerPendingSandbox(sb, runPromise, script, outputSink);
            const elapsed = chatScriptTimeout;
            log(`[di-chat] Script still pending after ${elapsed}ms — registered handle=${handle}`);
            return JSON.stringify({
                success: false,
                pending: true,
                handle,
                output: "",
                returnValue: null,
                error: null,
                message:
                    `Script is still running after ${Math.round(elapsed / 1000)}s (chatScriptTimeout). ` +
                    `Child process kept alive. Call await_handle({ handle: "${handle}" }) when you want ` +
                    `to wait again — typically in a later turn after doing other work, or immediately ` +
                    `if you have nothing else to do.`,
            });
        }

        // Resolved or rejected before the timeout — return final result and
        // dispose synchronously.
        try {
            if (raced.kind === "resolved") {
                const result = raced.value;
                const output = result.outputs.join("\n");
                const returnValue = result.value !== undefined && result.value !== null
                    ? (typeof result.value === "string" ? result.value : JSON.stringify(result.value))
                    : null;
                log(`[di-chat] Script OK (${result.outputs.length} output lines)`);
                this._recordSuccessfulScript(script, output, returnValue);
                return JSON.stringify({ success: true, output, returnValue, error: null });
            }
            const e = raced.error;
            const errMsg = e instanceof Error ? e.message : String(e);
            const output = (e as Error & { outputs?: string[] }).outputs?.join("\n") ?? "";
            log(`[di-chat] Script failed: ${errMsg}`);
            this._pushRecentScriptError(script, output, errMsg);
            return JSON.stringify({ success: false, error: errMsg, output, returnValue: null });
        } finally {
            outputSink.emit = undefined;
            sb.dispose();
        }
    }

    /**
     * Resume waiting on a script that previously returned `pending: true` (C.3).
     *
     * - Race the still-pending run promise against `chatScriptTimeout` again.
     * - If it resolves / rejects: dispose the sandbox, drop the handle,
     *   return the final result JSON in the same shape as `_executeRunScript`.
     * - If it times out again: leave the handle registered and return another
     *   `{ pending: true, handle }` so the agent can poll across more turns.
     */
    private async _executeAwaitHandle(
        handle: string,
        token: vscode.CancellationToken,
        onOutput?: (line: string) => void,
    ): Promise<string> {
        const entry = this._pendingSandboxes.get(handle);
        if (!entry) {
            log(`[di-chat] await_handle: unknown handle '${handle}'`);
            return JSON.stringify({
                success: false,
                error:
                    `Unknown pending handle '${handle}'. Either the run already completed ` +
                    `and was reaped, the sandbox was reset, or the handle was mistyped. ` +
                    `Issue a fresh run_script call instead.`,
                output: "",
                returnValue: null,
            });
        }

        const { chatScriptTimeout } = getSettings();
        // The child has been printing all along; point its output at this turn's
        // stream for as long as this turn is the one waiting.
        entry.outputSink.emit = onOutput;
        let raced;
        try {
            raced = await this._raceWithTimeout(entry.promise, chatScriptTimeout, token);
        } finally {
            entry.outputSink.emit = undefined;
        }

        if (raced.kind === "cancelled") {
            // User stopped while we were re-awaiting a pending handle: dispose
            // the kept-alive child, drop the handle, then end the turn.
            this._pendingSandboxes.delete(handle);
            entry.sandbox.dispose();
            log(`[di-chat] await_handle cancelled — disposed pending handle=${handle}`);
            throw new vscode.CancellationError();
        }

        if (raced.kind === "timeout") {
            const totalElapsedMs = Date.now() - entry.startedAt;
            log(`[di-chat] await_handle: handle=${handle} still pending after ${totalElapsedMs}ms total`);
            return JSON.stringify({
                success: false,
                pending: true,
                handle,
                output: "",
                returnValue: null,
                error: null,
                message:
                    `Script still running. Total wall-clock so far: ${Math.round(totalElapsedMs / 1000)}s. ` +
                    `Call await_handle({ handle: "${handle}" }) again to keep waiting.`,
            });
        }

        // Terminal — clear the handle and dispose the sandbox.
        this._pendingSandboxes.delete(handle);
        try {
            if (raced.kind === "resolved") {
                const result = raced.value;
                const output = result.outputs.join("\n");
                const returnValue = result.value !== undefined && result.value !== null
                    ? (typeof result.value === "string" ? result.value : JSON.stringify(result.value))
                    : null;
                const totalElapsedMs = Date.now() - entry.startedAt;
                log(`[di-chat] await_handle: handle=${handle} resolved after ${totalElapsedMs}ms (${result.outputs.length} output lines)`);
                this._recordSuccessfulScript(entry.script, output, returnValue);
                return JSON.stringify({ success: true, output, returnValue, error: null });
            }
            const e = raced.error;
            const errMsg = e instanceof Error ? e.message : String(e);
            const output = (e as Error & { outputs?: string[] }).outputs?.join("\n") ?? "";
            log(`[di-chat] await_handle: handle=${handle} rejected: ${errMsg}`);
            this._pushRecentScriptError(entry.script, output, errMsg);
            return JSON.stringify({ success: false, error: errMsg, output, returnValue: null });
        } finally {
            entry.sandbox.dispose();
        }
    }

    /**
     * Race a promise against a wall-clock timeout AND cancellation WITHOUT
     * rejecting the original promise. The original promise keeps running even
     * after a `timeout` win — the caller decides what to do with it (typically:
     * register it under a pending handle so a later turn can re-race). A
     * `cancelled` win means the user hit Stop / steered; the caller is
     * responsible for disposing the in-flight sandbox and throwing.
     */
    private async _raceWithTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        token: vscode.CancellationToken,
    ): Promise<{ kind: "resolved"; value: T } | { kind: "rejected"; error: unknown } | { kind: "timeout" } | { kind: "cancelled" }> {
        if (token.isCancellationRequested) return { kind: "cancelled" };
        const settled = promise.then(
            (value): { kind: "resolved"; value: T } => ({ kind: "resolved", value }),
            (error): { kind: "rejected"; error: unknown } => ({ kind: "rejected", error }),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        let sub: vscode.Disposable | undefined;
        const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
            timer.unref?.();
        });
        const cancelled = new Promise<{ kind: "cancelled" }>((resolve) => {
            sub = token.onCancellationRequested(() => resolve({ kind: "cancelled" }));
        });
        try {
            return await Promise.race([settled, timeout, cancelled]);
        } finally {
            if (timer) clearTimeout(timer);
            sub?.dispose();
        }
    }

    /**
     * Run ONE model round under an *idle* budget: the deadline is re-armed on
     * every stream part, so it bounds silence rather than total duration. A
     * long-but-steadily-streaming answer never trips it, while a provider that
     * accepts the request and then goes quiet — before the first part or
     * halfway through — ends the round instead of hanging it. The stall is in
     * the stream, not in `sendRequest`, so both legs are covered.
     *
     * On timeout the provider call is cancelled (best-effort) via a derived
     * token and abandoned; the user's own token still cancels normally and
     * surfaces as a rejection, exactly as before.
     */
    private async _sendModelRequest(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        tools: vscode.LanguageModelChatTool[],
        idleTimeoutMs: number,
        token: vscode.CancellationToken,
    ): Promise<
        | { kind: "ok"; text: string; toolCalls: vscode.LanguageModelToolCallPart[]; elapsedMs: number; parts: number }
        | { kind: "timeout"; elapsedMs: number; phase: "request" | "first-part" | "stream"; parts: number }
    > {
        const startedAt = Date.now();
        const cts = new vscode.CancellationTokenSource();
        const sub = token.onCancellationRequested(() => cts.cancel());

        // Race one step of progress against a fresh idle deadline. `settled`
        // never rejects, so abandoning it on `idle` cannot leak an unhandled
        // rejection.
        const step = async <T>(p: Promise<T> | Thenable<T>): Promise<
            { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "idle" }
        > => {
            const settled = Promise.resolve(p).then(
                (value) => ({ kind: "value" as const, value }),
                (error: unknown) => ({ kind: "error" as const, error }),
            );
            let timer: ReturnType<typeof setTimeout> | undefined;
            const idle = new Promise<{ kind: "idle" }>((resolve) => {
                timer = setTimeout(() => resolve({ kind: "idle" as const }), idleTimeoutMs);
                timer.unref?.();
            });
            try {
                return await Promise.race([settled, idle]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        };

        let parts = 0;
        try {
            const opened = await step(model.sendRequest(messages, { tools }, cts.token));
            if (opened.kind === "idle") {
                cts.cancel();
                return { kind: "timeout", elapsedMs: Date.now() - startedAt, phase: "request", parts };
            }
            // Before the error branch: on cancel the provider usually rejects with
            // its own error, and reporting that would show the user an error banner
            // for something they chose to stop.
            if (token.isCancellationRequested) throw new vscode.CancellationError();
            if (opened.kind === "error") throw opened.error;

            const iter = opened.value.stream[Symbol.asyncIterator]();
            let text = "";
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            for (;;) {
                const next = await step(iter.next());
                if (next.kind === "idle") {
                    cts.cancel();
                    return {
                        kind: "timeout",
                        elapsedMs: Date.now() - startedAt,
                        phase: parts === 0 ? "first-part" : "stream",
                        parts,
                    };
                }
                // Must throw, not break: returning `ok` here would let the caller
                // stream a partial answer and file the turn `complete` for a turn
                // the user cancelled.
                if (token.isCancellationRequested) throw new vscode.CancellationError();
                if (next.kind === "error") throw next.error;
                if (next.value.done) break;
                parts++;
                const part = next.value.value;
                if (part instanceof vscode.LanguageModelTextPart) text += part.value;
                else if (part instanceof vscode.LanguageModelToolCallPart) toolCalls.push(part);
            }
            return { kind: "ok", text, toolCalls, elapsedMs: Date.now() - startedAt, parts };
        } finally {
            // Order matters: drop the listener that calls `cts.cancel()` before
            // disposing the source it targets.
            sub.dispose();
            cts.dispose();
        }
    }

    /**
     * Register a still-running sandbox under a fresh handle so a later
     * `await_handle` call can resume waiting for the result. If the
     * registry is full, evict + dispose the oldest entry to make room
     * (the agent has clearly forgotten about it).
     */
    private _registerPendingSandbox(
        sb: Sandbox,
        promise: Promise<CellResult>,
        script: string,
        outputSink: OutputSink,
    ): string {
        if (this._pendingSandboxes.size >= MAX_PENDING_SANDBOXES) {
            const oldestKey = this._pendingSandboxes.keys().next().value;
            if (oldestKey !== undefined) {
                const evicted = this._pendingSandboxes.get(oldestKey);
                this._pendingSandboxes.delete(oldestKey);
                evicted?.sandbox.dispose();
                log(`[di-chat] Pending-sandbox cap (${MAX_PENDING_SANDBOXES}) hit — evicted oldest handle=${oldestKey}`);
            }
        }
        const handle = `sb-${randomUUID()}`;
        this._pendingSandboxes.set(handle, {
            sandbox: sb,
            promise,
            script,
            startedAt: Date.now(),
            outputSink,
        });
        // Always settle the promise so it doesn't become an
        // unhandledRejection if the agent never resumes — the result
        // is still served via the registry from `_executeAwaitHandle`.
        promise.catch(() => {});
        return handle;
    }

    /**
     * Tear down every entry in the pending-sandbox registry — used by
     * `dispose()` and `resetSandbox()` so we never leak child processes
     * across reloads or explicit resets.
     */
    private _disposePendingSandboxes(reason: string): void {
        if (this._pendingSandboxes.size === 0) return;
        const handles = [...this._pendingSandboxes.keys()];
        for (const [, entry] of this._pendingSandboxes) {
            try {
                entry.sandbox.dispose();
            } catch (e) {
                debug(`[di-chat] dispose() of pending sandbox threw: ${(e as Error).message}`);
            }
        }
        this._pendingSandboxes.clear();
        log(`[di-chat] Disposed ${handles.length} pending sandbox(es) (${reason}): ${handles.join(", ")}`);
    }

    /** Append a `run_script` failure to the bounded ring buffer used by `/reportError`. */
    private _pushRecentScriptError(script: string, output: string, errText: string): void {
        this._recentScriptErrors.push({
            when: new Date().toISOString(),
            script,
            output,
            error: errText,
        });
        while (this._recentScriptErrors.length > MAX_RECENT_SCRIPT_ERRORS) {
            this._recentScriptErrors.shift();
        }
    }

    /** Record the most recent successful `run_script` (single slot) for `/reportError`. */
    private _recordSuccessfulScript(script: string, output: string, returnValue: string | null): void {
        this._lastSuccessfulScript = {
            when: new Date().toISOString(),
            script,
            output,
            returnValue,
        };
    }

    /**
     * Emit ONE encrypted, compressed telemetry event capturing the whole chat
     * turn — prompt, and every iteration's assistant text, tool calls, and
     * tool results — as a JSON property bag. The addon gzip + age-encrypts it
     * (body `enc.age.gz:…`) so content stays opaque in ADX; decrypt with
     * `cargo xtask decrypt-field`. Best-effort: never throws into the chat path.
     */
    private _logChatTelemetry(
        turnId: string,
        prompt: string,
        mode: string,
        iterations: Array<Record<string, unknown>>,
        status: string,
        model?: vscode.LanguageModelChat,
    ): void {
        try {
            const bag = {
                schema: 1,
                kind: "chat.turn",
                ts: new Date().toISOString(),
                turnId,
                mode,
                status,
                env: this._pendingGlobals.get("fabricEnvName"),
                // Which LLM actually served the turn — the user can switch models
                // per-turn from the chat picker, so this is not a session constant.
                model: model && {
                    id: model.id,
                    name: model.name,
                    vendor: model.vendor,
                    family: model.family,
                    version: model.version,
                    maxInputTokens: model.maxInputTokens,
                },
                prompt,
                iterations,
            };
            sdkLog.logEncGzEvent(JSON.stringify(bag), "DIPartiV1");
        } catch (e) {
            debug(`[di-chat] telemetry emit failed: ${(e as Error).message}`);
        }
    }

    private _executeReadFile(filePath: string, maxLines?: number): string {
        return executeReadFile(filePath, maxLines);
    }

    private _executeAskUserInput(
        input: Record<string, unknown>,
        token: vscode.CancellationToken,
    ): Promise<string> {
        return executeAskUserInput(input, token, this._extensionContext.secrets);
    }

    private _executeAskUserChoice(
        input: Record<string, unknown>,
        token: vscode.CancellationToken,
    ): Promise<string> {
        return executeAskUserChoice(input, token);
    }

    private _executeAskUserForm(
        input: Record<string, unknown>,
        token: vscode.CancellationToken,
    ): Promise<string> {
        return executeAskUserForm(input, token, this._extensionContext.secrets);
    }

    private _executeRevealInFile(
        input: Record<string, unknown>,
        token: vscode.CancellationToken,
    ): Promise<string> {
        return executeRevealInFile(input, token, {
            baseFolder: getBaseFolder(this._extensionContext),
            registerDecoration: (decoration) => this._registerRevealDecoration(decoration),
        });
    }

    /**
     * Track a freshly applied `reveal_in_file` decoration in the single active
     * slot: dispose any prior reveal, then arm a TTL timer so the highlight
     * fades on its own if the user doesn't act on it.
     */
    private _registerRevealDecoration(decoration: vscode.TextEditorDecorationType): void {
        this._clearRevealDecoration();
        const timer = setTimeout(() => {
            decoration.dispose();
            if (this._activeReveal?.decoration === decoration) this._activeReveal = undefined;
        }, REVEAL_DECORATION_TTL_MS);
        timer.unref?.();
        this._activeReveal = { decoration, timer };
    }

    /** Dispose the active `reveal_in_file` highlight (if any) and clear its timer. */
    private _clearRevealDecoration(): void {
        if (!this._activeReveal) return;
        clearTimeout(this._activeReveal.timer);
        this._activeReveal.decoration.dispose();
        this._activeReveal = undefined;
    }

    /** Shared context handed to every documentation tool executor. */
    private _docsToolOptions(): DocsToolOptions {
        return {
            extensionUri: this._extensionContext.extensionUri,
            served: this._servedDocRefs,
        };
    }

    private _executeLoadReference(input: Record<string, unknown>): string {
        return executeLoadReference(input, this._docsToolOptions());
    }

    private _executeSearchDocs(input: Record<string, unknown>): string {
        return executeSearchDocs(input, this._docsToolOptions());
    }

    private _executeLookupType(input: Record<string, unknown>): string {
        return executeLookupType(input, this._docsToolOptions());
    }

    private _executeListSymbols(input: Record<string, unknown>): string {
        return executeListSymbols(input, this._docsToolOptions());
    }

    // ── Private: Agent loop ──────────────────────────────────

    /**
     * Convert `ChatContext.history` (the previous turns of this chat
     * session) into `LanguageModelChatMessage`s so the LLM keeps
     * conversational memory across turns.
     *
     * Note: VS Code only exposes the final rendered markdown for
     * past assistant turns — the raw tool_use / tool_result pairs
     * from the in-turn agent loop are NOT preserved, so previous
     * `run_script` outputs survive only via the "**Output:** …"
     * blocks we streamed to the user.
     */
    private _historyToMessages(
        history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
    ): vscode.LanguageModelChatMessage[] {
        const out: vscode.LanguageModelChatMessage[] = [];
        for (const turn of history) {
            if (turn instanceof vscode.ChatRequestTurn) {
                const text = turn.command ? `${turn.command}: ${turn.prompt}` : turn.prompt;
                if (text.trim()) out.push(vscode.LanguageModelChatMessage.User(text));
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const text = turn.response
                    .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                    .map(p => p.value.value)
                    .join("");
                if (text.trim()) out.push(vscode.LanguageModelChatMessage.Assistant(text));
            }
        }
        return out;
    }

    /**
     * Entry point: picks a `ChatView` (verbose vs. friendly) based on
     * the `fabricDataFactory.chatDeveloperMode` setting, then delegates
     * to the shared agent-loop implementation. Both modes run exactly
     * the same control flow — only the per-step UI differs.
     */
    private async _handleRequest(
        request: vscode.ChatRequest, context: vscode.ChatContext,
        stream: vscode.ChatResponseStream, token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> {
        const view = getSettings().chatDeveloperMode ? VERBOSE_VIEW : FRIENDLY_VIEW;
        return this._handleRequestImpl(request, context, stream, token, view);
    }

    /**
     * Shared agent-loop implementation. Per-step UI is delegated to
     * `view`'s hooks (`onRunScriptStart`, `onRunScriptComplete`, …) so
     * the verbose (developer) and friendly (default) modes stay in
     * lockstep on everything else: prompt building, tool dispatch,
     * tool_use/tool_result fidelity, max-rounds continuation, and
     * error/cancellation handling.
     */
    private async _handleRequestImpl(
        request: vscode.ChatRequest, context: vscode.ChatContext,
        stream: vscode.ChatResponseStream, token: vscode.CancellationToken,
        view: ChatView,
    ): Promise<vscode.ChatResult> {
        if (request.command === "reset") {
            this.resetSandbox();
            stream.markdown("🔄 DI Chat sandbox has been reset. All variables and state cleared.\n");
            return { metadata: { command: "reset" } };
        }

        if (request.command === "reportError") {
            return await this._handleReportError(request, context, stream, token);
        }

        let prompt: string;
        let messages: vscode.LanguageModelChatMessage[];
        let allTools: vscode.LanguageModelChatTool[];
        let lastScript: string | undefined;
        let totalToolCalls: number;
        let scriptCount: number;

        const isContinue = request.command === "continue" && !!this._pendingContinuation;
        if (isContinue) {
            const cont = this._pendingContinuation!;
            messages = cont.messages;
            allTools = cont.allTools;
            prompt = cont.prompt;
            lastScript = cont.lastScript;
            scriptCount = cont.scriptCount;
            totalToolCalls = cont.totalToolCalls;
            this._pendingContinuation = undefined;
            debug(`[di-chat] ── Continue (${view.mode}) ──────────────────────`);
            debug(`[di-chat] Resuming: ${messages.length} messages, ${totalToolCalls} prior tool call(s), step ${scriptCount}`);
            view.onContinueRestored(stream);
        } else {
            if (request.command === "continue") {
                stream.markdown("_No active session to continue. Treating as a fresh prompt._\n\n");
            }
            this._pendingContinuation = undefined;
            // `/continue` resumes the SAME logical turn — its earlier tool
            // results are still in `messages`, so the served-refs set is
            // deliberately kept across a continuation and only reset here,
            // when a genuinely new turn starts.
            this._servedDocRefs.clear();

            prompt = request.command ? `${request.command}: ${request.prompt}` : request.prompt;
            debug(`[di-chat] ── New request (${view.mode}) ──────────────────────`);
            debug(`[di-chat] Prompt: "${prompt.slice(0, 120)}${prompt.length > 120 ? "…" : ""}"`);
            const systemPrompt = this._buildSystemPrompt();
            debug(`[di-chat] System prompt: ${systemPrompt.length} chars`);
            const historyMessages = this._historyToMessages(context.history);
            debug(`[di-chat] History: ${context.history.length} turn(s) → ${historyMessages.length} message(s)`);

            const diTools = this._getToolDefinitions();

            // Include user-installed tools (e.g. MCP servers) plus a few safe,
            // read-only/UI-only Copilot built-ins (planning + diagram rendering),
            // but exclude Copilot-internal tools that would bypass the sandbox
            // (terminals, tasks, tests, browser) or are agent-orchestration
            // plumbing (subagents, tool_search) that just confuse the loop.
            const EXCLUDED_PREFIXES = ["copilot_", "vscode_", "inline_chat_"];
            const EXCLUDED_NAMES = new Set([
                "task_complete", "execution_subagent", "search_subagent",
                "run_in_terminal", "get_terminal_output", "kill_terminal",
                "send_to_terminal", "terminal_selection", "terminal_last_command",
                "run_task", "get_task_output", "create_and_run_task",
                "open_browser_page", "runSubagent",
                "runTests", "testFailure", "tool_search",
                // manage_todo_list is a host-provided planning scratchpad tied to
                // Copilot's own agent surface; it doesn't render usefully inside a
                // custom chat participant and only burns rounds when the model
                // decides to "plan". It was also absent in some hosts (e.g. dxt),
                // where the model wasted rounds calling a no-op tool. Exclude it.
                "manage_todo_list",
                // Intentionally NOT excluded (Bucket C — safe to expose):
                //   renderMermaidDiagram — renders a diagram in chat, no side effects
            ]);
            const externalTools = vscode.lm.tools
                .filter(t =>
                    !EXCLUDED_PREFIXES.some(p => t.name.startsWith(p)) &&
                    !EXCLUDED_NAMES.has(t.name),
                )
                .map(t => ({
                    name: t.name, description: t.description, inputSchema: t.inputSchema as object,
                }));

            allTools = [...diTools, ...externalTools];
            debug(`[di-chat] Tools: ${allTools.map(t => t.name).join(", ")} (${allTools.length} total, ${externalTools.length} external)`);

            messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt),
                ...historyMessages,
                vscode.LanguageModelChatMessage.User(prompt),
            ];
            // Action #5: if the user is disputing/distrusting a prior result
            // ("you didn't run it", "check again", "literally run the query"),
            // bias THIS turn toward a tool call instead of another re-assertion.
            if (looksLikeUserDispute(prompt)) {
                messages.push(vscode.LanguageModelChatMessage.User(DISPUTE_REMINDER));
                // `log`, not `debug`: this is the only signal for how often users
                // distrust an answer, and whether the bias alone is enough to
                // avoid escalating the guard (S1). `debug` does not reach ADX.
                log("[di-chat] guard=dispute outcome=reminder");
            }

            lastScript = undefined;
            totalToolCalls = 0;
            scriptCount = 0;
        }

        const { maxToolRounds, modelIdleTimeout } = getSettings();
        let hitMaxRounds = true;
        // Set when a round was ended by the model-idle budget rather than by
        // the model answering — kept out of the `complete` status bucket.
        let modelTimedOut = false;
        // The text actually shown to the user, so a turn that produced neither
        // an answer nor a tool call can be recorded as `empty` rather than
        // `complete` (a stalled provider used to be indistinguishable from a win).
        let finalAnswerText = "";
        // Tracks consecutive identical scripts (normalized) for loop detection.
        let lastNormalizedScript: string | undefined;
        let duplicateScriptRuns = 0;
        let abortedDueToLoop = false;
        // Ground Truth guard (action #3 / enhancement S1): count successful
        // data-reading tool runs (run_script / await_handle) this request, and
        // bound how many times we re-prompt for an unverified live-data claim.
        let liveDataToolRuns = 0;
        let unverifiedInterventions = 0;
        // Docs census (enhancement F4/S5): reference loads vs. type lookups before
        // the first script. The 08/12 grind was 17 lookups and 0 reference loads.
        let refDocLoads = 0;
        let typeLookups = 0;
        // First answer flagged by the guard, kept as a fallback so a nudged round
        // that returns nothing does not leave the turn with an empty reply.
        let preNudgeAnswer: string | undefined;
        debug(`[di-chat] maxToolRounds=${maxToolRounds}, pendingGlobals=[${[...this._pendingGlobals.keys()].join(", ")}]`);

        // Per-turn telemetry: one encrypted property bag capturing the prompt
        // and every iteration's assistant text + tool calls/results. Emitted
        // once at the end via `_logChatTelemetry` (addon gzip+age-encrypts it).
        const turnId = randomUUID();
        const telemetryIterations: Array<Record<string, unknown>> = [];
        // Option A: every apply_file_edit this turn is collected here and
        // rendered as ONE consolidated "Files changed" summary (filetree +
        // per-file diff buttons) at the end — a stable-API stand-in for VS
        // Code's native chat-edits working set.
        const fileEditsThisTurn: FileEditResult[] = [];
        const fileEditBaseUri = vscode.workspace.workspaceFolders?.[0]?.uri
            ?? vscode.Uri.file(getBaseFolder(this._extensionContext));

        try {
            for (let round = 0; round < maxToolRounds; round++) {
                if (token.isCancellationRequested) throw new vscode.CancellationError();

                stream.progress(round === 0 ? "Thinking…" : `Working… (step ${round + 1})`);

                // Proactive compaction (docs/chat_steering_and_compaction.md §2):
                // keep the running context under the current model's input budget
                // so long sessions don't drift or hit the hard token limit. No-op
                // until we approach the budget; cheap pre-filter avoids per-round
                // tokenizer round-trips.
                messages = await compactIfNeeded(request.model, messages, token, stream, {
                    renderFacts: () => this._facts.render(),
                    fallbackTrim: (m) => this._trimMessagesForRecovery(m),
                });

                log(`[di-chat] Round ${round + 1}: → model vendor=${request.model.vendor} family=${request.model.family} tools=${allTools.length} messages=${messages.length}`);
                const outcome = await this._sendModelRequest(request.model, messages, allTools, modelIdleTimeout, token);

                if (outcome.kind === "timeout") {
                    log(`[di-chat] Round ${round + 1}: ✗ model went silent for ${modelIdleTimeout}ms at phase=${outcome.phase} after ${outcome.elapsedMs}ms and ${outcome.parts} part(s) vendor=${request.model.vendor} family=${request.model.family} tools=${allTools.length}`);
                    stream.markdown(
                        `\n\n> ⚠️ **The language model stopped responding** — no output for `
                        + `${Math.round(modelIdleTimeout / 1000)}s. This is usually a transient provider `
                        + `issue — try again, pick a different model from the chat model picker, or raise `
                        + `\`fabricDataFactory.modelIdleTimeout\`.\n`,
                    );
                    modelTimedOut = true;
                    hitMaxRounds = false;
                    break;
                }

                const { text: responseText, toolCalls } = outcome;
                log(`[di-chat] Round ${round + 1}: ← model ok in ${outcome.elapsedMs}ms parts=${outcome.parts} text=${responseText.length} toolCalls=${toolCalls.length}`);
                debug(`[di-chat] Round ${round + 1}: text=${responseText.length} chars, toolCalls=${toolCalls.length}${toolCalls.length > 0 ? ` [${toolCalls.map(c => c.name).join(", ")}]` : ""}`);

                // No tool calls → the model wants to finalize this turn.
                if (toolCalls.length === 0) {
                    // Ground Truth guard (action #3 / enhancement S1): the model is
                    // finalizing a live-data answer (row counts, status, "succeeded
                    // / landed", "is empty", …) without having run ANY successful
                    // data-reading tool this request. Re-prompt it to re-derive the
                    // value with a tool, up to MAX_UNVERIFIED_INTERVENTIONS times,
                    // then stream the answer with an explicit "unverified" caveat
                    // rather than looping to maxToolRounds with no reply.
                    const claimBranch =
                        liveDataToolRuns === 0 && !this._facts.matches(responseText)
                            ? classifyLiveDataClaim(responseText)
                            : undefined;
                    const unverifiedClaim = claimBranch !== undefined;

                    if (unverifiedClaim && unverifiedInterventions < MAX_UNVERIFIED_INTERVENTIONS) {
                        unverifiedInterventions++;
                        log(`[di-chat] guard=groundTruth outcome=nudge branch=${claimBranch} round=${round + 1} attempt=${unverifiedInterventions}/${MAX_UNVERIFIED_INTERVENTIONS}`);
                        // Keep the first flagged answer: if a nudged round comes
                        // back empty, the user still gets a reply instead of a
                        // blank turn.
                        preNudgeAnswer ??= responseText;
                        // Only announce re-verification once the model has already
                        // ignored one nudge — a single silent retry avoids showing a
                        // "checking my work" spinner on a guard misfire.
                        if (unverifiedInterventions > 1) stream.progress("Verifying the answer with a tool…");
                        // Keep the model's own claim in context, then append the
                        // nudge as a user turn and let the loop run again.
                        messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
                        messages.push(vscode.LanguageModelChatMessage.User(UNVERIFIED_CLAIM_NUDGE));
                        continue;
                    }
                    const finalText = responseText.trim() ? responseText : (preNudgeAnswer ?? "");
                    if (finalText.trim()) {
                        finalAnswerText = finalText;
                        stream.markdown(finalText);
                    } else if (totalToolCalls === 0) {
                        // The provider returned no text and no tool calls, so the
                        // turn would otherwise end as a blank reply after a long
                        // spinner — say so instead of showing nothing.
                        log(`[di-chat] Round ${round + 1}: model returned no text and no tool calls — empty turn`);
                        stream.markdown(
                            "\n> ⚠️ **The language model returned an empty response.** Nothing was run and "
                            + "nothing was changed. Try re-sending the request, or pick a different model "
                            + "from the chat model picker.\n",
                        );
                    }
                    if (unverifiedClaim) {
                        // Interventions exhausted and still unverified — surface a
                        // visible caveat so the user knows the values are unconfirmed.
                        log(`[di-chat] guard=groundTruth outcome=caveat branch=${claimBranch} round=${round + 1} nudges=${unverifiedInterventions}`);
                        stream.markdown(
                            "\n\n> ⚠️ **Unverified.** I could not confirm the value(s) above by "
                            + "running a tool this turn — treat them as unconfirmed.\n",
                        );
                    } else if (unverifiedInterventions > 0) {
                        // Nudged earlier, and the final answer no longer trips the
                        // classifier. `toolRuns=0` is the case no other guard signal
                        // records: the claim left the guard without a tool ever
                        // running and without a caveat.
                        log(`[di-chat] guard=groundTruth outcome=postNudge round=${round + 1} nudges=${unverifiedInterventions} toolRuns=${liveDataToolRuns}`);
                    }
                    hitMaxRounds = false;
                    break;
                }

                // Stream any reasoning text before tool calls
                if (responseText.trim()) stream.markdown(responseText + "\n\n");

                // Execute tools and collect results — UI per step is owned by `view`
                messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));
                const toolResults: vscode.LanguageModelToolResultPart[] = [];
                // Content-bearing tool results for this round's telemetry bag.
                const roundResults: Array<Record<string, unknown>> = [];

                for (const call of toolCalls) {
                    totalToolCalls++;
                    const input = call.input as Record<string, unknown>;

                    if (call.name === "run_script") {
                        const script = input.script as string;
                        const normalized = normalizeScriptForLoopCheck(script);
                        if (normalized && normalized === lastNormalizedScript) {
                            duplicateScriptRuns++;
                        } else {
                            duplicateScriptRuns = 1;
                            lastNormalizedScript = normalized;
                        }
                        lastScript = script;
                        scriptCount++;
                        view.onRunScriptStart(stream, script, scriptCount);
                        log(`[di-chat] Round ${round + 1}: run_script (${script.length} chars, duplicateRuns=${duplicateScriptRuns})${scriptCount === 1 ? ` firstScript refDocs=${refDocLoads} typeLookups=${typeLookups}` : ""}`);

                        const resultJson = await this._executeRunScript(
                            script, token, (line) => view.onRunScriptOutput(stream, line),
                        );
                        const capped = capRunScriptResult(resultJson);
                        if (capped.length !== resultJson.length) {
                            debug(`[di-chat] Capped run_script result ${resultJson.length} → ${capped.length} chars`);
                        }
                        // Render the CAPPED parsed result — a 60 MB console.log
                        // would otherwise freeze the chat webview in verbose mode
                        // and make the agent loop look hung even after it has
                        // moved on.
                        const parsed = JSON.parse(capped);
                        view.onRunScriptComplete(stream, script, scriptCount, parsed);
                        // Ground Truth guard (action #3): a successful run means
                        // the model obtained live data this request.
                        if (parsed.success) {
                            liveDataToolRuns++;
                            // Verified-facts ledger (action #4): capture any
                            // `@fact label = value` markers the script emitted.
                            this._facts.recordFromOutput(parsed.output ?? "");
                        }

                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(capped),
                        ]));
                        roundResults.push({ tool: "run_script", script, result: capped });

                        if (duplicateScriptRuns >= MAX_DUPLICATE_SCRIPT_RUNS) {
                            abortedDueToLoop = true;
                            log(`[di-chat] Loop detected: same script ran ${duplicateScriptRuns} times — aborting`);
                            break;
                        }
                    } else if (call.name === "await_handle") {
                        const handle = String(input.handle ?? "");
                        log(`[di-chat] Round ${round + 1}: await_handle(${handle})`);
                        view.onAwaitHandleStart(stream, handle);
                        const resultJson = await this._executeAwaitHandle(
                            handle, token, (line) => view.onRunScriptOutput(stream, line),
                        );
                        const capped = capRunScriptResult(resultJson);
                        if (capped.length !== resultJson.length) {
                            debug(`[di-chat] Capped await_handle result ${resultJson.length} → ${capped.length} chars`);
                        }
                        const parsed = JSON.parse(capped);
                        view.onAwaitHandleComplete(stream, handle, parsed);
                        // Ground Truth guard (action #3): a resolved await means
                        // the model obtained live data this request.
                        if (parsed.success) {
                            liveDataToolRuns++;
                            // Verified-facts ledger (action #4): capture any
                            // `@fact label = value` markers the script emitted.
                            this._facts.recordFromOutput(parsed.output ?? "");
                        }
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(capped),
                        ]));
                        roundResults.push({ tool: "await_handle", handle, result: capped });
                    } else if (call.name === "read_local_file") {
                        const filePath = input.path as string;
                        log(`[di-chat] Round ${round + 1}: read_local_file(${filePath})`);
                        view.onReadFile(stream, filePath);
                        const content = this._executeReadFile(filePath, input.maxLines as number | undefined);
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(content),
                        ]));
                    } else if (call.name === "load_reference") {
                        const refName = String(input.name ?? "");
                        const refSection = typeof input.section === "string" ? input.section : undefined;
                        refDocLoads++;
                        log(`[di-chat] Round ${round + 1}: load_reference(${refName}${refSection ? `#${refSection}` : ""})`);
                        view.onLoadReference(stream, refSection ? `${refName}#${refSection}` : refName);
                        const content = this._executeLoadReference(input);
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(content),
                        ]));
                    } else if (call.name === "search_docs") {
                        const query = String(input.query ?? "");
                        refDocLoads++;
                        log(`[di-chat] Round ${round + 1}: search_docs("${query.slice(0, 60)}")`);
                        view.onSearchDocs(stream, query);
                        const content = this._executeSearchDocs(input);
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(content),
                        ]));
                    } else if (call.name === "lookup_type") {
                        const symbol = String(input.symbol ?? "");
                        typeLookups++;
                        log(`[di-chat] Round ${round + 1}: lookup_type(${symbol})`);
                        view.onLookupType(stream, symbol);
                        const content = this._executeLookupType(input);
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(content),
                        ]));
                    } else if (call.name === "list_symbols") {
                        const prefix = typeof input.prefix === "string" ? input.prefix : "";
                        typeLookups++;
                        log(`[di-chat] Round ${round + 1}: list_symbols(${prefix})`);
                        view.onLookupType(stream, prefix || "all symbols");
                        const content = this._executeListSymbols(input);
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(content),
                        ]));
                    } else if (call.name === "apply_file_edit") {
                        const filePath = String(input.path ?? "");
                        const fileContent = String(input.content ?? "");
                        log(`[di-chat] Round ${round + 1}: apply_file_edit(${filePath}, ${fileContent.length} chars)`);
                        view.onApplyFileEditStart(stream, filePath);
                        const result = applyFileEdit(filePath, fileContent, {
                            baseFolder: getBaseFolder(this._extensionContext),
                            provider: this._originalProvider,
                            onError: (label, msg) => this._pushRecentScriptError(label, "", msg),
                        });
                        // Option A: collect this edit and surface ALL of the
                        // turn's edits in one consolidated "Files changed"
                        // summary at the end (rendered below), rather than an
                        // inline diff button after every apply_file_edit.
                        fileEditsThisTurn.push(result);
                        // Feed a COMPACT confirmation back to the LLM (no diff — the
                        // user reviews changes in the native diff editor). Serialize
                        // once, here, at the model boundary. `status`/`success` give
                        // the model ground truth so it can't claim an unwritten edit.
                        const forLlm = JSON.stringify({
                            success: result.status !== "error",
                            status: result.status,
                            displayPath: result.displayPath,
                            path: result.path,
                            error: result.status === "error" ? result.error : undefined,
                        });
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(forLlm),
                        ]));
                        roundResults.push({ tool: "apply_file_edit", path: filePath, result: forLlm });
                    } else if (call.name === "ask_user_input") {
                        const question = String(input.question ?? "");
                        log(`[di-chat] Round ${round + 1}: ask_user_input("${question.slice(0, 60)}") promptQuoted=${countQuotedSpans(prompt)}`);
                        view.onAskUser(stream, question);
                        const resultJson = await this._executeAskUserInput(input, token);
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(resultJson),
                        ]));
                        roundResults.push({ tool: "ask_user_input", question, result: resultJson });
                    } else if (call.name === "ask_user_choice") {
                        const question = String(input.question ?? "");
                        log(`[di-chat] Round ${round + 1}: ask_user_choice("${question.slice(0, 60)}") promptQuoted=${countQuotedSpans(prompt)}`);
                        view.onAskUser(stream, question);
                        const resultJson = await this._executeAskUserChoice(input, token);
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(resultJson),
                        ]));
                        roundResults.push({ tool: "ask_user_choice", question, result: resultJson });
                    } else if (call.name === "ask_user_form") {
                        const stepCount = Array.isArray(input.steps) ? input.steps.length : 0;
                        const label = typeof input.title === "string" && input.title.trim()
                            ? input.title.trim()
                            : `${stepCount}-step form`;
                        log(`[di-chat] Round ${round + 1}: ask_user_form(${stepCount} step(s))`);
                        view.onAskUser(stream, label);
                        const resultJson = await this._executeAskUserForm(input, token);
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(resultJson),
                        ]));
                        roundResults.push({ tool: "ask_user_form", title: label, result: resultJson });
                    } else if (call.name === "reveal_in_file") {
                        const filePath = String(input.path ?? "");
                        log(`[di-chat] Round ${round + 1}: reveal_in_file(${filePath})`);
                        view.onRevealFile(stream, filePath);
                        const resultJson = await this._executeRevealInFile(input, token);
                        toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(resultJson),
                        ]));
                        roundResults.push({ tool: "reveal_in_file", path: filePath, result: resultJson });
                    } else {
                        // External tools (MCP, user-installed)
                        log(`[di-chat] Round ${round + 1}: external tool '${call.name}'`);
                        view.onExternalTool(stream, call.name);
                        try {
                            const result = await vscode.lm.invokeTool(call.name, {
                                input: call.input, toolInvocationToken: undefined,
                            }, token);
                            toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
                        } catch (e) {
                            toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, [
                                new vscode.LanguageModelTextPart(`Tool error: ${e instanceof Error ? e.message : String(e)}`),
                            ]));
                        }
                    }
                }

                messages.push(vscode.LanguageModelChatMessage.User(toolResults));
                telemetryIterations.push({
                    round: round + 1,
                    assistantText: responseText,
                    toolCalls: toolCalls.map((c) => ({ name: c.name, input: c.input })),
                    results: roundResults,
                });
                debug(`[di-chat] Round ${round + 1}: fed ${toolResults.length} tool result(s) back to LLM`);

                if (abortedDueToLoop) {
                    hitMaxRounds = false;
                    stream.markdown(
                        `\n⚠️ **Loop detected** — the agent ran the same script ${duplicateScriptRuns} times in a row without progress. ` +
                        `Stopping to avoid burning context. Try rephrasing your request, inspecting the last script (View / Edit), ` +
                        `or running \`/reset\` to clear sandbox state.\n`,
                    );
                    break;
                }
            }

            // Consolidated end-of-turn "Files changed" summary (Option A).
            renderFileEditSummary(stream, fileEditsThisTurn, fileEditBaseUri);

            if (hitMaxRounds) {
                this._pendingContinuation = {
                    messages, allTools, prompt, lastScript, scriptCount, totalToolCalls,
                };
                stream.markdown(`\n_Reached the ${maxToolRounds}-step limit. Click **▶ Continue** (or type \`/continue\`) to keep going._\n`);
                debug(`[di-chat] Saved continuation state (${view.mode}): ${messages.length} messages, ${totalToolCalls} tool call(s)`);
            } else {
                this._pendingContinuation = undefined;
            }

            const status = hitMaxRounds ? "max_rounds"
                : modelTimedOut ? "model_timeout"
                    : (totalToolCalls === 0 && !finalAnswerText.trim()) ? "empty"
                        : "complete";
            this._logChatTelemetry(turnId, prompt, view.mode, telemetryIterations, status, request.model);
            debug(`[di-chat] ── Request complete (${view.mode}): status=${status}, ${totalToolCalls} tool call(s), ${scriptCount} script(s), refDocs=${refDocLoads}, typeLookups=${typeLookups}, messages=${messages.length}, hitMax=${hitMaxRounds} ──`);

            return { metadata: { command: request.command, prompt, toolCalls: totalToolCalls, lastScript, maxRoundsHit: hitMaxRounds, abortedDueToLoop } };
        } catch (err) {
            // A cancelled turn is where the user gave up — the highest-signal
            // negative outcome we have, and until now the only one that emitted
            // nothing. Classify off the token, not the error type: on cancel a
            // provider may reject with its own error rather than CancellationError.
            const cancelled = token.isCancellationRequested || err instanceof vscode.CancellationError;
            this._logChatTelemetry(turnId, prompt, view.mode, telemetryIterations,
                cancelled ? "cancelled" : "error", request.model);
            if (cancelled) {
                // The `error(…)` call below is skipped on this path, so this is the
                // only record of how the provider reacted to the cancel.
                if (!(err instanceof vscode.CancellationError)) {
                    log(`[di-chat] cancelled turn surfaced a non-cancellation rejection: ${err instanceof Error ? err.message : String(err)}`);
                }
                throw err instanceof vscode.CancellationError ? err : new vscode.CancellationError();
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            this._outputChannel.appendLine(`❌ Chat handler error: ${errMsg}`);
            error("[di-chat] Handler error", err);

            // Still surface any files that were changed before the error.
            renderFileEditSummary(stream, fileEditsThisTurn, fileEditBaseUri);

            // Token-limit recovery: save continuation with a trimmed message
            // window so the user can `/continue` from a smaller context.
            if (isTokenLimitError(err)) {
                const trimmed = this._trimMessagesForRecovery(messages);
                this._pendingContinuation = {
                    messages: trimmed,
                    allTools, prompt, lastScript, scriptCount, totalToolCalls,
                };
                stream.markdown(
                    `\n⚠️ **Context window exceeded.** The conversation grew too large for the model. ` +
                    `I trimmed older tool results (${messages.length} → ${trimmed.length} messages). ` +
                    `Click **▶ Continue** (or type \`/continue\`) to resume from the smaller context, ` +
                    `or \`/reset\` to start fresh.\n`,
                );
                return { metadata: { command: request.command, prompt, toolCalls: totalToolCalls, lastScript, maxRoundsHit: true, tokenLimitHit: true } };
            }

            stream.markdown(`**Error:** ${errMsg}\n`);
            return { metadata: { command: request.command } };
        }
    }

    /**
     * Drop the oldest tool_use / tool_result pairs from the middle of the
     * conversation when the model returns a token-limit error, so the
     * user's `/continue` has room to make progress. Keeps:
     *   - the system prompt (index 0)
     *   - the original user prompt (index 1)
     *   - the most recent ~half of tool exchanges
     */
    private _trimMessagesForRecovery(
        messages: vscode.LanguageModelChatMessage[],
    ): vscode.LanguageModelChatMessage[] {
        if (messages.length <= 4) return messages;
        // Preserve the first two (system + user prompt) and the last half.
        const headKeep = 2;
        const tailKeep = Math.max(2, Math.floor((messages.length - headKeep) / 2));
        // Ensure the trimmed tail starts on an assistant tool_use so the
        // following user tool_result block has its matching parent.
        const tailStart = messages.length - tailKeep;
        let adjustedStart = tailStart;
        while (adjustedStart < messages.length
            && messages[adjustedStart].role !== vscode.LanguageModelChatMessageRole.Assistant) {
            adjustedStart++;
        }
        const head = messages.slice(0, headKeep);
        const tail = messages.slice(adjustedStart);
        const dropped = messages.length - head.length - tail.length;
        const marker = vscode.LanguageModelChatMessage.User(
            `[Context trimmed: ${dropped} older message(s) removed to fit the model's token limit. Continue from here.]`,
        );
        return [...head, marker, ...tail];
    }

    // ── Private: /reportError ────────────────────────────────

    /**
     * Handle `/reportError`: ask the LLM to summarise any errors from
     * the conversation (grounded in the recent-script-error ring
     * buffer + the visible chat history) and render an actionable bug
     * draft inline. The user can then click:
     *   - **Open ADO bug report** (Microsoft-tenant only) to launch a
     *     prefilled ADO Bug-create form with the title/body, environment
     *     block, and full payload also dropped on the clipboard, or
     *   - **Copy to clipboard** to grab the draft for any other tracker.
     *
     * The LLM is explicitly instructed *not to fabricate* errors —
     * grounding lives in `this._recentScriptErrors` (captured at
     * `_executeRunScript` time) and the assistant's prior markdown
     * turns. If nothing failed, the LLM is told to say so plainly.
     */
    private async _handleReportError(
        request: vscode.ChatRequest, context: vscode.ChatContext,
        stream: vscode.ChatResponseStream, token: vscode.CancellationToken,
    ): Promise<vscode.ChatResult> {
        debug("[di-chat] ── /reportError ──");

        // 1. Build the evidence block from the in-memory ring buffer.
        const recentErrorsBlock = this._recentScriptErrors.length === 0
            ? "_(no recent script errors captured in this session)_"
            : this._recentScriptErrors.map((e, i) => [
                `### Recent script error ${i + 1} — ${e.when}`,
                "Script:",
                "```ts",
                e.script,
                "```",
                "Output:",
                e.output ? "```\n" + e.output + "\n```" : "_(empty)_",
                "Error:",
                "```\n" + e.error + "\n```",
            ].join("\n")).join("\n\n");

        // Last known-good script (single slot). Helps the LLM contrast the
        // failure against the most recent successful verifier output — e.g.
        // "rows = N" — which the failing run itself may not have produced.
        const s = this._lastSuccessfulScript;
        const lastSuccessBlock = s
            ? [
                `### Last successful script — ${s.when}`,
                "Script:",
                "```ts",
                s.script,
                "```",
                "Output:",
                s.output ? "```\n" + s.output + "\n```" : "_(empty)_",
                "Return value:",
                s.returnValue ? "```\n" + s.returnValue + "\n```" : "_(none)_",
            ].join("\n")
            : "_(no successful script captured in this session)_";

        const userNote = (request.prompt ?? "").trim();
        const userNoteBlock = userNote
            ? `## User note (please weight this in your summary)\n${userNote}\n\n`
            : "";

        const summaryPrompt =
            "You are drafting a bug report for the Fabric Data Factory VS Code extension. " +
            "Read the conversation above and the recent script errors below, then produce " +
            "a concise bug report. **Do not fabricate errors that aren't in the evidence.** " +
            "If nothing failed, say so plainly and stop.\n\n" +
            "Output exactly this markdown structure (no surrounding code fence):\n\n" +
            "### Title\n<one-line summary suitable as a bug title (≤ 120 chars)>\n\n" +
            "### Summary\n<2–4 sentences: what was attempted, what failed, suspected cause>\n\n" +
            "### Evidence\n<bulleted list of the key error messages / tool outputs you grounded the summary in — quote verbatim>\n\n" +
            "### Suggested next step\n<one short action for the engineer triaging the bug>\n\n" +
            userNoteBlock +
            "## Recent script errors (in-memory buffer)\n" +
            recentErrorsBlock +
            "\n\n## Last successful script (for contrast)\n" +
            lastSuccessBlock;

        const messages: vscode.LanguageModelChatMessage[] = [
            ...this._historyToMessages(context.history),
            vscode.LanguageModelChatMessage.User(summaryPrompt),
        ];

        stream.progress("Summarising errors…");
        let fullText = "";
        try {
            const response = await request.model.sendRequest(messages, {}, token);
            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(part.value);
                    fullText += part.value;
                }
            }
        } catch (err) {
            if (err instanceof vscode.CancellationError) throw err;
            const m = err instanceof Error ? err.message : String(err);
            stream.markdown(`\n\n**Error producing summary:** ${m}\n`);
            error("[di-chat] /reportError summary failed", err);
            return { metadata: { command: "reportError" } };
        }

        // 2. Extract `{ title, body }` from the LLM's response.
        const { title, body } = this._splitBugReport(fullText);

        // Telemetry: log the generated bug-report draft via the SAME
        // encrypted + gzipped path as chat turns (`sdkLog.logEncGzEvent` inside
        // `_logChatTelemetry`), so `/reportError` content stays opaque in ADX.
        this._logChatTelemetry(
            randomUUID(),
            (request.prompt ?? "").trim(),
            "reportError",
            [{ kind: "bug_report_draft", title, bugReport: fullText }],
            "complete",
            request.model,
        );

        // 3. Render the action buttons. The ADO button is Microsoft-tenant
        //    gated, mirroring the existing toast policy in `log.ts`.
        const isMsft = await isMicrosoftAccount();
        stream.markdown("\n\n---\n");
        // Surface the SDK session id so the user can quote it in the bug —
        // it matches the `session.id` on every span/log this addon emits,
        // letting triage correlate the report against telemetry in ADX.
        const sid = sdkLog.sessionId();
        // Bake the session id INTO the report body so it travels with the ADO
        // form / clipboard payload — not just the streamed UI — giving triage a
        // traceable id even after the chat is gone.
        const bodyWithSid = sid
            ? `${body}\n\n---\nSession id: \`${sid}\` (for telemetry correlation)`
            : body;
        if (sid) {
            stream.markdown(`\n_Session id: \`${sid}\` — include this in your report so we can correlate it with telemetry._\n`);
        }
        if (isMsft) {
            stream.button({
                command: "fabricDataFactory.di.reportBug",
                title: "🐞 Open ADO bug report",
                arguments: [{ title, body: bodyWithSid } satisfies BugReportPayload],
            });
        }
        stream.button({
            command: "fabricDataFactory.di.copyBugReport",
            title: "📋 Copy bug report to clipboard",
            arguments: [{ title, body: bodyWithSid } satisfies BugReportPayload],
        });
        // The diagnostic package bundles the addon's rotating tracing
        // logs into an age-encrypted `.dipkg` envelope under Downloads,
        // so the user can attach it to the bug for SDK-side decryption
        // and analysis. The command itself reveals the file in the OS
        // file explorer and offers a "Copy Path" action.
        stream.button({
            command: "fabricDataFactory.exportDiagnosticPackage",
            title: "📦 Export diagnostic package (.dipkg)",
        });

        return { metadata: { command: "reportError" } };
    }

    /**
     * Split the LLM's bug-draft markdown into a `{title, body}` pair.
     * Falls back to a heuristic (first non-empty line as title) when
     * the model deviated from the requested layout.
     */
    private _splitBugReport(md: string): { title: string; body: string } {
        const trimmed = md.trim();
        const titleMatch = trimmed.match(/^###\s*Title\s*\r?\n+([^\r\n]+)/im);
        const rawTitle =
            (titleMatch?.[1]
                ?? trimmed.split(/\r?\n/).find(l => l.trim().length > 0)
                ?? "Bug report from @di chat").trim();
        return {
            title: rawTitle.slice(0, 200),
            body: trimmed,
        };
    }

    // ── Private: Re-run ──────────────────────────────────────

    private async _rerunScript(script: string): Promise<void> {
        try {
            const settings = getSettings();
            const baseFolder = getBaseFolder(this._extensionContext);
            const sb = createSandbox(
                { baseFolder },
                { timeout: settings.chatScriptTimeout, logger: (msg) => log(`[di-chat] ${msg}`) },
            );
            for (const [name, value] of this._pendingGlobals) sb.setGlobal(name, value);
            try {
                const result = await sb.run(script);
                if (result.outputs.length) this._outputChannel.appendLine(result.outputs.join("\n"));
                if (result.value !== undefined) {
                    this._outputChannel.appendLine(
                        typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2),
                    );
                }
                this._outputChannel.show();
            } finally {
                sb.dispose();
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Script execution failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // ── Private: References ──────────────────────────────────

    private _listReferenceNames(): string[] {
        if (this._referenceNames !== undefined) return this._referenceNames;
        const refDir = vscode.Uri.joinPath(
            this._extensionContext.extensionUri, "assets", "references",
        ).fsPath;
        let names: string[];
        try {
            names = fs.readdirSync(refDir)
                .filter((f: string) => f.endsWith(".md"))
                .map((f: string) => f.replace(/\.md$/i, ""))
                .sort();
        } catch {
            names = [];
        }
        // The generated TypeScript declarations are deliberately NOT in this
        // list: at ~337 KB they are served per-symbol via `lookup_type`
        // (see `typeIndex.ts`), never as a document.
        this._referenceNames = names;
        return names;
    }
}
