/**
 * Per-step UI strategy for the `@di` chat participant's agent loop —
 * extracted from `chatParticipant.ts` to keep that file focused on the
 * loop mechanics.
 *
 * The verbose (developer) and friendly (default) handlers share identical
 * control flow; these hooks isolate the few places where the two modes
 * intentionally differ in what they stream to the user.
 */

import * as vscode from "vscode";
import * as path from "node:path";

/**
 * Announce a pending `ask_user_*` question as a durable transcript line.
 *
 * `stream.progress()` alone is not enough: it renders one transient status line
 * the user cannot scroll back to, and the quick-input it refers to opens at the
 * top of the window — behind another panel or on a second monitor it is easy to
 * miss entirely. Both views therefore write the question into the chat, which is
 * where a stuck user looks first (observed twice: *"what response are you waiting
 * for"*).
 */
function announceAskUser(stream: vscode.ChatResponseStream, question: string): void {
    // Collapsed so a multi-line question can't break out of the blockquote.
    const oneLine = question.replace(/\s+/g, " ").trim();
    stream.markdown(
        `\n\n> ⌨️ **Waiting for your answer:** ${oneLine}\n>\n` +
        "> _Respond in the input box at the top of the VS Code window — or press `Esc` to skip it._\n\n",
    );
}

/** Max characters of a script's console line to show in the one-line progress slot. */
const PROGRESS_LINE_CHARS = 120;

/** Collapse a console line to something that fits the single-line progress slot. */
function progressLine(line: string): string {
    const oneLine = line.replace(/\s+/g, " ").trim();
    if (!oneLine) return "Evaluating…";
    return oneLine.length > PROGRESS_LINE_CHARS ? `${oneLine.slice(0, PROGRESS_LINE_CHARS)}…` : oneLine;
}

/**
 * Strategy object for the per-step user-facing UI inside the agent
 * loop. The verbose (developer) and friendly (default) handlers share
 * identical control flow — these hooks isolate the few places where
 * the two modes intentionally differ.
 */
export interface ChatView {
    /** Mode name used in debug log strings ("verbose" | "friendly"). */
    readonly mode: string;
    /** Fired once when agent-loop state is restored from a previous turn. */
    onContinueRestored(stream: vscode.ChatResponseStream): void;
    /** Fired just before `_executeRunScript` runs. */
    onRunScriptStart(stream: vscode.ChatResponseStream, script: string, scriptCount: number): void;
    /**
     * Fired for each console line the running script emits, while it is still
     * running. Deliberately transient (`stream.progress`): a poll loop prints
     * one line per pass and the user only needs the latest one to tell
     * "working" from "hung". The full output is still rendered on completion.
     */
    onRunScriptOutput(stream: vscode.ChatResponseStream, line: string): void;
    /** Fired after `_executeRunScript` returns and its JSON is parsed. */
    onRunScriptComplete(
        stream: vscode.ChatResponseStream,
        script: string,
        scriptCount: number,
        parsed: { output?: string; success: boolean; error?: string; pending?: boolean; message?: string },
    ): void;
    /** Fired just before `_executeAwaitHandle` runs (C.3 long-await resume). */
    onAwaitHandleStart(stream: vscode.ChatResponseStream, handle: string): void;
    /** Fired after `_executeAwaitHandle` returns and its JSON is parsed. */
    onAwaitHandleComplete(
        stream: vscode.ChatResponseStream,
        handle: string,
        parsed: { output?: string; success: boolean; error?: string; pending?: boolean; message?: string },
    ): void;
    /** Fired just before `_executeReadFile` runs. */
    onReadFile(stream: vscode.ChatResponseStream, path: string): void;
    /** Fired just before `_executeLoadReference` runs. */
    onLoadReference(stream: vscode.ChatResponseStream, name: string): void;
    /** Fired just before `search_docs` queries the reference index. */
    onSearchDocs(stream: vscode.ChatResponseStream, query: string): void;
    /** Fired just before `lookup_type` / `list_symbols` reads the type index. */
    onLookupType(stream: vscode.ChatResponseStream, symbol: string): void;
    /** Fired just before `applyFileEdit` runs. */
    onApplyFileEditStart(stream: vscode.ChatResponseStream, path: string): void;
    /** Fired just before `reveal_in_file` opens + highlights a file. */
    onRevealFile(stream: vscode.ChatResponseStream, path: string): void;
    /** Fired just before an `ask_user_*` tool prompts the user for input. */
    onAskUser(stream: vscode.ChatResponseStream, question: string): void;
    /** Fired just before an external (MCP / user-installed) tool is invoked. */
    onExternalTool(stream: vscode.ChatResponseStream, name: string): void;
}

/**
 * Developer / verbose view — streams script bodies, output dumps,
 * status icons (✅/❌) and a per-step View/Edit button. Used when
 * debugging the chat participant itself.
 */
export const VERBOSE_VIEW: ChatView = {
    mode: "verbose",
    onContinueRestored() { /* no extra progress line — debug log is enough */ },
    onRunScriptStart(stream) {
        stream.progress("Evaluating…");
    },
    onRunScriptOutput(stream, line) {
        stream.progress(progressLine(line));
    },
    onRunScriptComplete(stream, script, scriptCount, parsed) {
        if (parsed.output) stream.markdown("**Output:**\n```\n" + parsed.output + "\n```\n\n");
        if (parsed.pending) {
            stream.markdown(`⏳ **Step ${scriptCount}** — still running (pending handle issued). ${parsed.message ?? ""}\n\n`);
        } else {
            if (!parsed.success) stream.markdown(`⚠️ **Script error:** ${parsed.error}\n\n`);
            const lineCount = script.split("\n").length;
            const statusIcon = parsed.success ? "✅" : "❌";
            stream.markdown(`${statusIcon} **Step ${scriptCount}** — ${lineCount} lines\n\n`);
        }
        stream.button({ command: "fabricDataFactory.di.editScript", title: "👁️ View / Edit", arguments: [script] });
    },
    onAwaitHandleStart(stream, handle) {
        stream.progress(`Awaiting pending script (${handle.slice(0, 12)}…)…`);
    },
    onAwaitHandleComplete(stream, handle, parsed) {
        if (parsed.output) stream.markdown("**Output:**\n```\n" + parsed.output + "\n```\n\n");
        if (parsed.pending) {
            stream.markdown(`⏳ Still pending (${handle.slice(0, 12)}…). ${parsed.message ?? ""}\n\n`);
        } else if (parsed.success) {
            stream.markdown(`✅ Pending script completed (${handle.slice(0, 12)}…)\n\n`);
        } else {
            stream.markdown(`❌ Pending script failed (${handle.slice(0, 12)}…): ${parsed.error}\n\n`);
        }
    },
    onReadFile() { /* silent in verbose */ },
    onLoadReference() { /* silent in verbose */ },
    onSearchDocs() { /* silent in verbose */ },
    onLookupType() { /* silent in verbose */ },
    onApplyFileEditStart(stream, p) {
        stream.progress(`Editing ${path.basename(p)}…`);
    },
    onRevealFile(stream, p) {
        stream.progress(`Opening ${path.basename(p)}…`);
    },
    onAskUser(stream, question) {
        announceAskUser(stream, question);
        stream.progress(`Waiting for your answer: ${question}…`);
    },
    onExternalTool() { /* silent in verbose */ },
};

/**
 * Friendly / Copilot-style view — per-step UI reduced to
 * `stream.progress(…)` updates. Script failures are passed back to
 * the LLM via `toolResults` so the agent self-recovers silently;
 * only the agent's final markdown reaches the user.
 */
export const FRIENDLY_VIEW: ChatView = {
    mode: "friendly",
    onContinueRestored(stream) {
        stream.progress("Continuing…");
    },
    onRunScriptStart(stream, script) {
        const lineCount = script.split("\n").length;
        stream.progress(`Evaluating (${lineCount} lines)…`);
    },
    onRunScriptOutput(stream, line) {
        stream.progress(progressLine(line));
    },
    onRunScriptComplete() { /* agent sees the result via toolResults */ },
    onAwaitHandleStart(stream) {
        stream.progress("Waiting for a long-evaluation…");
    },
    onAwaitHandleComplete() { /* agent sees the result via toolResults */ },
    onReadFile(stream) {
        stream.progress("Reading file…");
    },
    onLoadReference(stream, name) {
        stream.progress(`Loading reference '${name}'…`);
    },
    onSearchDocs(stream, query) {
        stream.progress(`Searching docs for '${query}'…`);
    },
    onLookupType(stream, symbol) {
        stream.progress(`Looking up '${symbol}'…`);
    },
    onApplyFileEditStart(stream, p) {
        stream.progress(`Editing ${path.basename(p)}…`);
    },
    onRevealFile(stream, p) {
        stream.progress(`Opening ${path.basename(p)}…`);
    },
    onAskUser(stream, question) {
        // The one place friendly mode must break its progress-only rule: the user
        // has to act, and the question is what tells them how.
        announceAskUser(stream, question);
        stream.progress("Waiting for your response…");
    },
    onExternalTool(stream, name) {
        stream.progress(`Calling ${name}…`);
    },
};
