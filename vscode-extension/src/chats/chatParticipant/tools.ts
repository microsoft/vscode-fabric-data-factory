/**
 * Tool surface for the `@di` chat participant — extracted from
 * `chatParticipant.ts` to keep that file focused on the agent loop.
 *
 * Provides:
 *  - {@link getToolDefinitions}: the declarative `LanguageModelChatTool[]`
 *    schema the model sees each turn (run_script, apply_file_edit, ask_user_*, …).
 *  - The **stateless** tool executors that don't touch participant state:
 *    {@link executeReadFile}, {@link executeLoadReference},
 *    {@link executeSearchDocs}, {@link executeLookupType},
 *    {@link executeListSymbols}, {@link executeAskUserInput},
 *    {@link executeAskUserChoice}.
 *
 * The stateful sandbox tools (`run_script` / `await_handle` and the
 * pending-sandbox registry) intentionally stay in `chatParticipant.ts`
 * because they own mutable state that `/reportError` reads.
 *
 * ## Documentation tools: progressive disclosure
 *
 * The SDK's docs are large and grow with it (~332 KB of reference markdown,
 * plus a ~337 KB generated `.d.ts`). Returning whole files would spend most
 * of the model's context on text it never reads — and keep spending it,
 * since tool results persist in the message history. So the doc surface is
 * three tools that narrow progressively:
 *
 *  - `search_docs`  — rank *sections* (and SDK symbols) against a query.
 *  - `load_reference` — fetch one section, a table of contents, or (for
 *    small docs) the whole file.
 *  - `lookup_type`  — one exact declaration out of the `.d.ts` symbol table.
 *
 * See `docsIndex.ts` and `typeIndex.ts` for the machinery behind them.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "node:path";
import { log } from "@/utils/channel_log";
import { showChoiceStep } from "@/chats/chatParticipant/userForm";
import {
    loadDocsIndex,
    loadDoc,
    searchDocs,
    type DocsIndex,
} from "@/chats/chatParticipant/docsIndex";
import {
    loadTypeIndex,
    lookupType,
    listSymbols,
    searchSymbols,
    type TypeIndex,
} from "@/chats/chatParticipant/typeIndex";

// ── Tool definitions ─────────────────────────────────────────

/**
 * Build the declarative tool schema advertised to the model each turn.
 * `referenceNames` (the on-disk per-client API reference filenames) is
 * folded into the `load_reference` description so the model knows what it
 * can load.
 */
export function getToolDefinitions(referenceNames: string[]): vscode.LanguageModelChatTool[] {
    const referenceListText = referenceNames.length > 0
        ? ` Available reference names: ${referenceNames.join(", ")}.`
        : "";
    return [
        {
            name: "run_script",
            description: "Execute a TypeScript script in the DI sandbox. The script has access to all DI clients " +
                "(fabricClient, onelakeClient, syncService, etc.) and Node.js built-ins. " +
                "Use console.log() for output. Returns JSON { output, returnValue, success, error } — " +
                "or { pending: true, handle } if the script is still running after chatScriptTimeout " +
                "(typically for long-running DAGs). Resume via await_handle.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    script: {
                        type: "string",
                        description: "TypeScript code to execute. Must be valid TS — no prose, no markdown fences.",
                    },
                },
                required: ["script"],
            },
        },
        {
            name: "await_handle",
            description: "Resume waiting for a run_script call that previously returned " +
                "`{ pending: true, handle }`. Races the still-running script against chatScriptTimeout " +
                "again and returns either the final result (same JSON shape as run_script) or another " +
                "`{ pending: true, handle }` if the script is still in flight. The child process stays " +
                "alive between calls. Use this for long-running awaits (e.g. DAGs > 10 min) that would " +
                "otherwise blow the per-script timeout.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    handle: {
                        type: "string",
                        description: "The handle returned by a previous run_script (or await_handle) call.",
                    },
                },
                required: ["handle"],
            },
        },
        {
            name: "read_local_file",
            description: "Read a local file from the filesystem. Useful for inspecting DAG outputs, " +
                "config files, or any file written by a previous script.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute path to the file to read.",
                    },
                    maxLines: {
                        type: "number",
                        description: "Maximum number of lines to return (default: 200).",
                    },
                },
                required: ["path"],
            },
        },
        {
            name: "search_docs",
            description: "SEARCH the data-integration SDK documentation and type surface. " +
                "This is the DEFAULT way to find anything in the API docs — prefer it over loading a whole " +
                "reference. Ranks individual doc SECTIONS (not whole files) against your query and also " +
                "returns matching SDK symbol names. Use it whenever you're unsure which client/method to use, " +
                "or which reference covers a topic. " +
                "Returns JSON { hits: [{ ref, headingPath, chars, score, snippet }], symbols: [name] }. " +
                "Then load exactly what you need: load_reference({ name, section }) for a hit's prose, " +
                "or lookup_type({ symbol }) for an exact TypeScript signature." + referenceListText,
            inputSchema: {
                type: "object" as const,
                properties: {
                    query: {
                        type: "string",
                        description: "What you're looking for — a method name, symbol, or short phrase (e.g. 'stream warehouse rows', 'createCopyActivityBuilder').",
                    },
                    scope: {
                        type: "string",
                        description: "Optional reference name to search within (e.g. 'pipeline-client'). Omit to search all references.",
                    },
                    k: {
                        type: "number",
                        description: "Max hits to return (default 6, max 20).",
                    },
                },
                required: ["query"],
            },
        },
        {
            name: "load_reference",
            description: "Load the API reference markdown for a data-integration client — a single SECTION, " +
                "or the whole document when it's small. " +
                "Call with just `name` to get the document (small docs) or its table of contents with " +
                "addressable section ids (large docs). Call with `name` + `section` to get exactly that " +
                "section — this is the efficient path and what you should normally do, using a section id " +
                "from search_docs, from the docs map in your instructions, or from a table of contents. " +
                "Pass full:true only when you genuinely need an entire large document. " +
                "For an exact TypeScript signature prefer lookup_type — it returns one declaration instead " +
                "of pages of prose. " +
                "Do NOT try to read these files via read_local_file — they ship inside the extension, not " +
                "the workspace, and are only reachable through this tool." + referenceListText,
            inputSchema: {
                type: "object" as const,
                properties: {
                    name: {
                        type: "string",
                        description: "Reference name without the .md extension (e.g. 'onelake-client'). A combined 'name#section' ref from search_docs also works.",
                    },
                    section: {
                        type: "string",
                        description: "Section id within the document (e.g. 'querying-rows'). Strongly preferred over loading the whole file.",
                    },
                    full: {
                        type: "boolean",
                        description: "Return the entire document even if it is large. Use sparingly — it can consume a large share of the context window.",
                    },
                },
                required: ["name"],
            },
        },
        {
            name: "lookup_type",
            description: "Get the EXACT TypeScript declaration of one SDK symbol from the generated " +
                "data-integration type definitions — the authoritative source for signatures, parameter " +
                "names, optional fields, and enum values. " +
                "Accepts a top-level name ('WarehouseClient', 'FabricItem', 'createPipelineBuilder') or a " +
                "member path ('WarehouseClient.query'). The 'Node' prefix is optional — 'WarehouseClient' " +
                "and 'NodeWarehouseClient' both resolve. " +
                "ALWAYS use this instead of guessing a signature from memory or from a prose example. " +
                "A class too large to inline comes back as its signature plus a member index; re-query with " +
                "'Class.member' for the one you need. Use list_symbols to discover names.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    symbol: {
                        type: "string",
                        description: "Symbol name, or 'Owner.member' for a class/interface member.",
                    },
                },
                required: ["symbol"],
            },
        },
        {
            name: "list_symbols",
            description: "List SDK symbol names (classes, interfaces, functions, enums, type aliases) from " +
                "the generated type definitions, optionally filtered by name substring and kind. " +
                "Cheap discovery when you don't know the exact name to pass to lookup_type — it returns " +
                "names and one-line summaries only, never full declarations.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    prefix: {
                        type: "string",
                        description: "Case-insensitive name filter (e.g. 'warehouse', 'copyjob').",
                    },
                    kind: {
                        type: "string",
                        enum: ["class", "interface", "function", "enum", "type", "variable"],
                        description: "Restrict to one declaration kind.",
                    },
                    limit: {
                        type: "number",
                        description: "Max entries to return (default 40, max 200).",
                    },
                },
                required: [],
            },
        },
        {
            name: "apply_file_edit",
            description: "Create or overwrite a local project file (DAGs, JSON, configs, etc.) with the " +
                "FULL new file content. Writes to disk immediately, RE-READS to verify the bytes " +
                "actually landed, and shows the user a reviewable diff in chat. Returns JSON " +
                "{ success, status, displayPath, path, error } where status is " +
                "\"created\" | \"edited\" | \"unchanged\" | \"error\". " +
                "ALWAYS prefer this over fs.writeFileSync in run_script when editing a file the user " +
                "should see changed. Never claim a file was changed unless a tool result confirmed " +
                "success:true. Relative paths resolve against the workspace root (baseFolder).",
            inputSchema: {
                type: "object" as const,
                properties: {
                    path: {
                        type: "string",
                        description: "File path. Absolute, or relative to the workspace root (baseFolder).",
                    },
                    content: {
                        type: "string",
                        description: "The COMPLETE new content of the file (not a patch/fragment).",
                    },
                },
                required: ["path", "content"],
            },
        },
        {
            name: "ask_user_input",
            description: "Ask the user to TYPE a SINGLE value (e.g. a missing credential, connection name, " +
                "file path, or free-text answer) via a VS Code input box. Re-read the user's request and " +
                "the earlier turns FIRST: if the value is already stated there (a quoted name, a path, an " +
                "id), use it instead of asking. If you still need to confirm it, pass it as `value` so the " +
                "box is pre-filled and the user confirms with one keystroke — never ask an OPEN question " +
                "for a value they already typed. Do ask when the value is genuinely missing or not " +
                "derivable from a tool — never guess it. " +
                "Use ONLY for one value: to collect 2+ related values use ask_user_form (do NOT chain " +
                "multiple ask_user_input/ask_user_choice calls). " +
                "Returns JSON { value } with what they typed, or { cancelled: true } if they dismissed it. " +
                "For secrets set password:true — the value is then NEVER returned to you; it is stored in " +
                "VS Code SecretStorage under secretKey (if given) and you only get { provided: true, secretKey }.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    question: {
                        type: "string",
                        description: "The prompt shown to the user in the input box.",
                    },
                    placeholder: {
                        type: "string",
                        description: "Optional placeholder/hint text shown inside the empty input box.",
                    },
                    value: {
                        type: "string",
                        description: "Optional pre-filled default value (ignored when password:true).",
                    },
                    password: {
                        type: "boolean",
                        description: "Mask the input and withhold the value from you. Use for secrets/credentials.",
                    },
                    secretKey: {
                        type: "string",
                        description: "When password:true, the SecretStorage key to store the entered secret under.",
                    },
                },
                required: ["question"],
            },
        },
        {
            name: "ask_user_choice",
            description: "Ask the user to PICK a SINGLE choice (or several) from a list via a VS Code " +
                "quick-pick. Use this to disambiguate (which workspace/table/connection?) or to confirm " +
                "a decision before acting. If the user's request or an earlier turn already names the " +
                "thing, there is nothing to disambiguate — use it; when you are confirming rather than " +
                "disambiguating, list that value FIRST so accepting it is one keystroke. " +
                "Use ONLY for one question: to collect 2+ related values use " +
                "ask_user_form (do NOT chain multiple ask_user_input/ask_user_choice calls). " +
                "Set allowCustom:true to also let the user type their own answer " +
                "instead of only picking from the list. Returns JSON { selected } — a string, or an array of " +
                "strings when canSelectMany:true — or { cancelled: true } if the user dismissed the picker.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    question: {
                        type: "string",
                        description: "The prompt shown above the list of options.",
                    },
                    options: {
                        type: "array",
                        items: { type: "string" },
                        description: "The list of options the user can choose from.",
                    },
                    canSelectMany: {
                        type: "boolean",
                        description: "Allow selecting multiple options (the result is then an array).",
                    },
                    allowCustom: {
                        type: "boolean",
                        description: "Also let the user type their own custom answer instead of only picking (single-select only).",
                    },
                },
                required: ["question", "options"],
            },
        },
        {
            name: "ask_user_form",
            description: "Ask the user MULTIPLE related questions in ONE guided, multi-step form (wizard) " +
                "with Back/Next navigation — the user can move backward to revise earlier answers. Use this " +
                "WHENEVER you need to collect 2+ related values at once (e.g. host + database + username + " +
                "password) — do NOT chain several ask_user_input/ask_user_choice calls for that; use " +
                "ask_user_input/ask_user_choice only for a SINGLE value. Each step is a text input or a choice. " +
                "Returns JSON { answers: { <key>: value, … } } (choice steps with canSelectMany return an " +
                "array; a password step returns { provided: true, secretKey } and NEVER reveals the value), " +
                "or { cancelled: true } if the user dismissed the form.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    title: {
                        type: "string",
                        description: "Optional form title shown on every step.",
                    },
                    steps: {
                        type: "array",
                        description: "Ordered list of fields to collect from the user.",
                        items: {
                            type: "object",
                            properties: {
                                key: {
                                    type: "string",
                                    description: "Result key this step's answer is stored under in `answers`.",
                                },
                                kind: {
                                    type: "string",
                                    enum: ["input", "choice"],
                                    description: "Field type: free-text input or pick-from-list choice.",
                                },
                                question: {
                                    type: "string",
                                    description: "The prompt shown for this step.",
                                },
                                placeholder: {
                                    type: "string",
                                    description: "input: placeholder/hint text.",
                                },
                                value: {
                                    type: "string",
                                    description: "input: pre-filled default value.",
                                },
                                password: {
                                    type: "boolean",
                                    description: "input: mask + withhold from you; stored in SecretStorage.",
                                },
                                secretKey: {
                                    type: "string",
                                    description: "input: when password:true, the SecretStorage key to store under.",
                                },
                                options: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "choice: the options to pick from.",
                                },
                                canSelectMany: {
                                    type: "boolean",
                                    description: "choice: allow selecting multiple options.",
                                },
                                allowCustom: {
                                    type: "boolean",
                                    description: "choice: also let the user type their own answer (single-select only).",
                                },
                            },
                            required: ["key", "kind", "question"],
                        },
                    },
                },
                required: ["steps"],
            },
        },
        {
            name: "reveal_in_file",
            description: "Open a project file in the editor and highlight a region to draw the user's " +
                "attention — e.g. to point them at a config line and warn about it. READ-ONLY: it NEVER " +
                "edits the file (use apply_file_edit to change content). Prefer locating the region with " +
                "`anchor` (a short, unique snippet of the exact text to highlight) rather than line numbers, " +
                "since line numbers drift. Falls back to startLine/endLine if no anchor is given. " +
                "Returns JSON { opened, matched, line, preview } — check `matched` to confirm the anchor " +
                "resolved; if false, the file was opened at the top with no highlight, so re-anchor.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    path: {
                        type: "string",
                        description: "File path. Absolute, or relative to the workspace root (baseFolder).",
                    },
                    anchor: {
                        type: "string",
                        description: "Preferred: exact text to locate and highlight (a short, unique snippet). " +
                            "Matched literally (not a regex).",
                    },
                    anchorOccurrence: {
                        type: "number",
                        description: "Which match of `anchor` to use, 1-based (default 1).",
                    },
                    startLine: {
                        type: "number",
                        description: "Fallback when no `anchor`: 1-based line to highlight from.",
                    },
                    endLine: {
                        type: "number",
                        description: "Fallback: 1-based last line to highlight (defaults to startLine).",
                    },
                    message: {
                        type: "string",
                        description: "Optional short note shown as a hover tooltip on the highlighted region.",
                    },
                    highlight: {
                        type: "string",
                        enum: ["warning", "info", "selection"],
                        description: "Highlight style (default 'warning'). 'selection' just selects the range " +
                            "instead of adding a colored decoration.",
                    },
                },
                required: ["path"],
            },
        },
    ];
}

// ── Stateless executors ──────────────────────────────────────

/** `read_local_file` — read a file (capped at `maxLines`, default 200). */
export function executeReadFile(filePath: string, maxLines?: number): string {
    try {
        const limit = maxLines ?? 200;
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        if (lines.length > limit) {
            return lines.slice(0, limit).join("\n") + `\n... (${lines.length - limit} more lines)`;
        }
        return content;
    } catch (e) {
        return `Error reading file: ${e instanceof Error ? e.message : String(e)}`;
    }
}

/** Shared context for the documentation tools. */
export interface DocsToolOptions {
    /** The extension root URI (docs + declarations ship under `assets/`). */
    extensionUri: vscode.Uri;
    /**
     * Refs already served this turn (`"doc#section"` / `"type:Symbol"`).
     * Mutated by the executors.
     *
     * Models routinely re-request the same reference within a single turn —
     * usually right after a failed script — and each repeat pays full price
     * because the earlier result is still sitting in the message history.
     * Returning a pointer instead of the payload keeps the loop honest
     * without hiding anything the model can't recover.
     */
    served: Set<string>;
}

/** Cached corpora, keyed off the extension URI they were built from. */
function indexes(extensionUri: vscode.Uri): { docs: DocsIndex; types: TypeIndex } {
    return { docs: loadDocsIndex(extensionUri), types: loadTypeIndex(extensionUri) };
}

/**
 * `search_docs` — rank documentation sections (and SDK symbol names)
 * against a free-text query.
 */
export function executeSearchDocs(input: Record<string, unknown>, opts: DocsToolOptions): string {
    const query = String(input.query ?? "").trim();
    if (!query) {
        return JSON.stringify({ error: "No query given. Example: search_docs({ query: \"stream warehouse rows\" })." });
    }
    const { docs, types } = indexes(opts.extensionUri);
    const scope = typeof input.scope === "string" ? input.scope : undefined;

    if (scope && !docs.docs.has(scope.replace(/\.md$/i, ""))) {
        return JSON.stringify({
            error: `Unknown scope '${scope}'.`,
            availableScopes: [...docs.docs.keys()],
        });
    }

    const hits = searchDocs(docs, query, {
        scope,
        k: typeof input.k === "number" ? input.k : undefined,
    });
    const symbols = searchSymbols(types, query);

    log(`[di-chat] search_docs("${query}")${scope ? ` scope=${scope}` : ""} → ${hits.length} hit(s), ${symbols.length} symbol(s)`);

    if (hits.length === 0 && symbols.length === 0) {
        return JSON.stringify({
            query,
            hits: [],
            symbols: [],
            note:
                "No matches. Try fewer or more general terms, or list_symbols({ prefix }) to browse " +
                "the SDK surface.",
            availableReferences: [...docs.docs.keys()],
        });
    }

    return JSON.stringify({
        query,
        hits,
        symbols,
        note:
            "Load a hit with load_reference({ name, section }) using the part of `ref` before/after '#'. " +
            "For an exact signature call lookup_type({ symbol }).",
    });
}

/**
 * `load_reference` — serve a reference document at section granularity
 * (see {@link loadDoc} for how the granularity is chosen).
 */
export function executeLoadReference(input: Record<string, unknown>, opts: DocsToolOptions): string {
    const { docs } = indexes(opts.extensionUri);
    const name = String(input.name ?? "");
    const section = typeof input.section === "string" ? input.section : undefined;
    const full = input.full === true;

    const result = loadDoc(docs, name, { section, full });

    // Only dedupe successful, targeted loads: a table of contents is cheap
    // and re-reading it is legitimate navigation, while an error must always
    // be reported so the model can correct course.
    if (result.kind === "section" || result.kind === "whole" || result.kind === "full") {
        const key = `${name}#${section ?? "*"}`;
        if (opts.served.has(key)) {
            log(`[di-chat] load_reference(${key}) — already served this turn, returning pointer`);
            return (
                `Already loaded earlier in this turn: \`${key}\`. ` +
                `Scroll back to that tool result instead of re-loading it. ` +
                `If you need different content, request another section or use search_docs.`
            );
        }
        opts.served.add(key);
    }

    log(`[di-chat] load_reference(${name}${section ? `#${section}` : ""}${full ? ", full" : ""}) → ${result.kind}, ${result.text.length} chars`);
    return result.text;
}

/** `lookup_type` — exact declaration for one SDK symbol. */
export function executeLookupType(input: Record<string, unknown>, opts: DocsToolOptions): string {
    const { types } = indexes(opts.extensionUri);
    const symbol = String(input.symbol ?? "");
    const text = lookupType(types, symbol);

    const key = `type:${symbol}`;
    if (!text.startsWith("Error:") && opts.served.has(key)) {
        log(`[di-chat] lookup_type(${symbol}) — already served this turn, returning pointer`);
        return `Already returned earlier in this turn: \`${symbol}\`. Scroll back to that tool result.`;
    }
    if (!text.startsWith("Error:")) opts.served.add(key);

    log(`[di-chat] lookup_type(${symbol}) → ${text.length} chars`);
    return text;
}

/** `list_symbols` — browse the SDK surface without loading declarations. */
export function executeListSymbols(input: Record<string, unknown>, opts: DocsToolOptions): string {
    const { types } = indexes(opts.extensionUri);
    return listSymbols(types, {
        prefix: typeof input.prefix === "string" ? input.prefix : undefined,
        kind: typeof input.kind === "string" ? input.kind : undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined,
    });
}

/**
 * `ask_user_input` — pop a VS Code input box so the user can type a value
 * (a missing credential, connection name, path, free-text answer, …).
 *
 * Returns JSON `{ value }` with what they typed, or `{ cancelled: true }`
 * if they dismissed it. Secret hygiene: when `password` is set the raw
 * value is NEVER handed back to the model — it is stored in VS Code
 * SecretStorage under `secretKey` (when provided) and the result only
 * confirms `{ provided: true, secretKey }`.
 */
export async function executeAskUserInput(
    input: Record<string, unknown>,
    token: vscode.CancellationToken,
    secrets: vscode.SecretStorage,
): Promise<string> {
    const question = String(input.question ?? "").trim() || "Please enter a value";
    const password = input.password === true;
    const placeholder = typeof input.placeholder === "string" ? input.placeholder : undefined;
    const value = typeof input.value === "string" ? input.value : undefined;

    // How long the user sat in front of the box is the whole signal for a modal
    // they never noticed — every duration so far had to be derived from timestamps.
    const askedAt = Date.now();
    const answer = await vscode.window.showInputBox({
        title: question,
        prompt: question,
        placeHolder: placeholder,
        value: password ? undefined : value,
        password,
        ignoreFocusOut: true,
    }, token);
    const waitedMs = Date.now() - askedAt;

    if (answer === undefined) {
        log(`[di-chat] ask_user_input: outcome=cancelled waitedMs=${waitedMs}`);
        return JSON.stringify({ cancelled: true });
    }

    // Secret hygiene: never round-trip a password through the model.
    if (password) {
        const secretKey = typeof input.secretKey === "string" ? input.secretKey.trim() : "";
        if (secretKey) {
            await secrets.store(secretKey, answer);
            log(`[di-chat] ask_user_input: outcome=answered waitedMs=${waitedMs} stored secret under '${secretKey}'`);
            return JSON.stringify({ provided: true, secretKey });
        }
        log(`[di-chat] ask_user_input: outcome=answered waitedMs=${waitedMs} secret provided (not stored — no secretKey given)`);
        return JSON.stringify({ provided: true });
    }

    log(`[di-chat] ask_user_input: outcome=answered waitedMs=${waitedMs} value provided`);
    return JSON.stringify({ value: answer });
}

/**
 * `ask_user_choice` — pop a VS Code quick-pick so the user can select one
 * (or several) options from a list. Returns JSON `{ selected }` (a string,
 * or an array of strings when `canSelectMany` is set), or
 * `{ cancelled: true }` if the picker was dismissed. Options may be plain
 * strings or objects with a `label`; both are normalized to labels. When
 * `allowCustom` is set (single-select only) the user may also type a value
 * that isn't in the list and pick it.
 */
export async function executeAskUserChoice(
    input: Record<string, unknown>,
    token: vscode.CancellationToken,
): Promise<string> {
    const question = String(input.question ?? "").trim() || "Please choose an option";
    const raw = Array.isArray(input.options) ? input.options : [];
    const items = raw
        .map(o => (typeof o === "string" ? o : String((o as { label?: unknown })?.label ?? "")))
        .map(s => s.trim())
        .filter(s => s.length > 0);

    if (items.length === 0) {
        log("[di-chat] ask_user_choice: no options provided");
        return JSON.stringify({ error: "No options were provided to choose from." });
    }

    const askedAt = Date.now();
    const outcome = await showChoiceStep({
        question,
        options: items,
        canSelectMany: input.canSelectMany === true,
        allowCustom: input.allowCustom === true,
    }, token);
    const waitedMs = Date.now() - askedAt;

    if (outcome.kind !== "value") {
        log(`[di-chat] ask_user_choice: outcome=cancelled waitedMs=${waitedMs}`);
        return JSON.stringify({ cancelled: true });
    }
    const selected = outcome.value;
    log(`[di-chat] ask_user_choice: outcome=answered waitedMs=${waitedMs} selected ${Array.isArray(selected) ? selected.length + " option(s)" : "1 option"}`);
    return JSON.stringify({ selected });
}

// ── reveal_in_file ───────────────────────────────────────────

/** How long a reveal highlight stays before it auto-clears (ms). */
const REVEAL_DECORATION_TTL_MS = 12_000;

/** Options for {@link executeRevealInFile}. */
export interface RevealInFileOptions {
    /** Workspace root that relative paths resolve against. */
    baseFolder: string;
    /**
     * Called with a freshly created decoration so the participant can track it
     * for later disposal (replacing any prior reveal). Only invoked when a
     * colored decoration is actually applied — not for `highlight: 'selection'`
     * or when the region can't be resolved.
     */
    registerDecoration: (decoration: vscode.TextEditorDecorationType) => void;
}

/** Build a whole-line decoration type for the requested highlight style. */
function makeRevealDecoration(style: "warning" | "info"): vscode.TextEditorDecorationType {
    const isInfo = style === "info";
    return vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor(
            isInfo ? "inputValidation.infoBackground" : "inputValidation.warningBackground",
        ),
        border: "1px solid",
        borderColor: new vscode.ThemeColor(
            isInfo ? "inputValidation.infoBorder" : "inputValidation.warningBorder",
        ),
        overviewRulerColor: new vscode.ThemeColor(
            isInfo ? "editorInfo.foreground" : "editorWarning.foreground",
        ),
        overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
}

/**
 * `reveal_in_file` — open a file in the editor and highlight a region to draw
 * the user's attention (e.g. warn about a config line). Read-only: it never
 * edits the file.
 *
 * The region is located by `anchor` (literal text search, preferred) or by
 * `startLine`/`endLine` (1-based fallback). A colored whole-line decoration is
 * applied (auto-clearing via the participant's `registerDecoration` tracking),
 * unless `highlight: 'selection'` is requested, which selects the range
 * instead. Returns JSON `{ opened, matched, line, preview }` so the model has
 * ground truth about whether the anchor actually resolved.
 */
export async function executeRevealInFile(
    input: Record<string, unknown>,
    token: vscode.CancellationToken,
    opts: RevealInFileOptions,
): Promise<string> {
    const rawPath = String(input.path ?? "").trim();
    if (!rawPath) {
        log("[di-chat] reveal_in_file: no path provided");
        return JSON.stringify({ opened: false, error: "No path was provided." });
    }

    const filePath = path.isAbsolute(rawPath) ? rawPath : path.join(opts.baseFolder, rawPath);
    if (!fs.existsSync(filePath)) {
        log(`[di-chat] reveal_in_file: file not found (${filePath})`);
        return JSON.stringify({ opened: false, error: `File not found: ${filePath}` });
    }

    let doc: vscode.TextDocument;
    try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[di-chat] reveal_in_file: open failed (${msg})`);
        return JSON.stringify({ opened: false, error: `Could not open file: ${msg}` });
    }
    if (token.isCancellationRequested) {
        return JSON.stringify({ opened: false, error: "Cancelled." });
    }

    const anchor = typeof input.anchor === "string" ? input.anchor : "";
    const occurrence = Math.max(1, Math.floor(Number(input.anchorOccurrence)) || 1);
    const style = input.highlight === "info"
        ? "info"
        : input.highlight === "selection"
            ? "selection"
            : "warning";
    const message = typeof input.message === "string" ? input.message.trim() : "";

    // Resolve the target range: anchor search (preferred) → line range fallback.
    let range: vscode.Range | undefined;
    let matched = false;
    if (anchor) {
        const text = doc.getText();
        let idx = -1;
        for (let n = 0; n < occurrence; n++) {
            idx = text.indexOf(anchor, idx + 1);
            if (idx === -1) break;
        }
        if (idx !== -1) {
            range = new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + anchor.length));
            matched = true;
        }
    } else if (typeof input.startLine === "number" && doc.lineCount > 0) {
        const start = Math.min(doc.lineCount - 1, Math.max(0, Math.floor(input.startLine) - 1));
        const endRaw = typeof input.endLine === "number" ? Math.floor(input.endLine) - 1 : start;
        const end = Math.min(doc.lineCount - 1, Math.max(start, endRaw));
        range = new vscode.Range(new vscode.Position(start, 0), doc.lineAt(end).range.end);
        matched = true;
    }

    const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        selection: range,
    });

    if (range) {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        if (style === "selection") {
            editor.selection = new vscode.Selection(range.start, range.end);
        } else {
            const decoration = makeRevealDecoration(style);
            editor.setDecorations(decoration, [{
                range,
                hoverMessage: message ? new vscode.MarkdownString(message) : undefined,
            }]);
            opts.registerDecoration(decoration);
        }
    }

    const line = range ? range.start.line + 1 : null;
    const preview = range ? doc.lineAt(range.start.line).text.trim().slice(0, 200) : "";
    log(`[di-chat] reveal_in_file: ${filePath} (matched=${matched}, line=${line ?? "-"})`);
    return JSON.stringify({
        opened: true,
        matched,
        line,
        preview,
        note: anchor && !matched
            ? "Anchor text not found — opened the file at the top with no highlight. Re-anchor with a snippet that exists in the file."
            : undefined,
    });
}
