/**
 * File-edit support for the `@di` chat participant — extracted from
 * `chatParticipant.ts` to keep that file focused on the agent loop.
 *
 * Provides:
 *  - {@link OriginalContentProvider}: a `TextDocumentContentProvider` that
 *    serves pre-edit file snapshots so `vscode.diff` can render a real
 *    side-by-side diff against the version written to disk.
 *  - {@link applyFileEdit}: the ground-truth write (write → re-read → verify)
 *    behind the `apply_file_edit` tool.
 *  - {@link renderFileEditSummary}: end-of-turn consolidated "Files changed"
 *    view (filetree + per-file diff buttons) — a stable-API approximation of
 *    VS Code's native chat-edits working set.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "@/utils/channel_log";

/**
 * Virtual-document scheme that serves the *pre-edit* snapshot of a file
 * so `vscode.diff` can render a real side-by-side diff against the
 * version written to disk. Each `apply_file_edit` stashes the "before"
 * content under a unique `di-original:` URI.
 */
export const ORIGINAL_SCHEME = "di-original";

/** Cap on retained pre-edit snapshots (least-recently-used evicted first). */
const MAX_DIFF_SNAPSHOTS = 75;

/**
 * Backs the native diff editor: holds pre-edit file snapshots keyed by
 * a unique `di-original:` URI. Registered once as a
 * `TextDocumentContentProvider`. Bounded with a Map-based LRU — every
 * read (the diff editor fetching the "before" side) bumps the entry to
 * the most-recently-used end, so eviction drops genuinely stale
 * snapshots rather than just the oldest-inserted one.
 */
export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _snapshots = new Map<string, string>();

    provideTextDocumentContent(uri: vscode.Uri): string {
        const key = uri.toString();
        const content = this._snapshots.get(key);
        if (content === undefined) return "";
        // LRU bump: re-insert so this entry becomes most-recently-used.
        // (Map iterates in insertion order, so a delete+set moves it to the end.)
        this._snapshots.delete(key);
        this._snapshots.set(key, content);
        return content;
    }

    /** Stash a pre-edit snapshot and return the URI to diff against. */
    store(displayPath: string, content: string): vscode.Uri {
        const uri = vscode.Uri.from({
            scheme: ORIGINAL_SCHEME,
            path: "/" + displayPath.replace(/\\/g, "/"),
            query: randomUUID(),
        });
        this._snapshots.set(uri.toString(), content);
        // Evict least-recently-used entries: the first key is the LRU because
        // both inserts (store) and reads (provideTextDocumentContent) append
        // to the end of the Map.
        while (this._snapshots.size > MAX_DIFF_SNAPSHOTS) {
            const lru = this._snapshots.keys().next().value;
            if (lru === undefined) break;
            this._snapshots.delete(lru);
        }
        return uri;
    }
}

/**
 * Result of an `apply_file_edit`, as a discriminated union on `status`.
 * Returned directly (not via a JSON string) so callers get compile-time
 * narrowing and we serialize exactly once — at the LLM boundary.
 */
export type FileEditResult =
    | { status: "created" | "edited"; path: string; displayPath: string; originalUri: string }
    | { status: "unchanged"; path: string; displayPath: string }
    | { status: "error"; path?: string; displayPath?: string; error: string };

/** Options for {@link applyFileEdit}. */
export interface ApplyFileEditOptions {
    /** Workspace root that relative paths resolve against. */
    baseFolder: string;
    /** Snapshot store backing the native diff editor. */
    provider: OriginalContentProvider;
    /** Optional sink for failures (e.g. the participant's recent-error ring). */
    onError?: (label: string, message: string) => void;
}

/**
 * Ground-truth file write for the `apply_file_edit` tool.
 *
 * Unlike `fs.writeFileSync` inside a sandbox script, this:
 *   1. Resolves relative paths against `baseFolder`.
 *   2. Writes the file (creating parent dirs as needed).
 *   3. RE-READS the file and compares against the requested content
 *      so the result fed back to the LLM is the truth on disk — the
 *      model can't falsely claim a write succeeded.
 *   4. Stashes the pre-edit content under a `di-original:` URI so the
 *      chat UI can open VS Code's native diff editor (before vs after).
 *
 * Returns a typed {@link FileEditResult} — no JSON round-trip.
 */
export function applyFileEdit(rawPath: string, content: string, opts: ApplyFileEditOptions): FileEditResult {
    const { baseFolder, provider, onError } = opts;
    try {
        const filePath = path.isAbsolute(rawPath) ? rawPath : path.join(baseFolder, rawPath);
        const displayPath = vscode.workspace.asRelativePath(filePath, false);

        const existed = fs.existsSync(filePath);
        const oldContent = existed ? fs.readFileSync(filePath, "utf-8") : "";
        if (existed && oldContent === content) {
            log(`[di-chat] apply_file_edit: ${displayPath} unchanged`);
            return { status: "unchanged", path: filePath, displayPath };
        }

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");

        // Ground-truth verify: re-read and confirm the bytes landed.
        const onDisk = fs.readFileSync(filePath, "utf-8");
        if (onDisk !== content) {
            const errText = "Write verification failed: file on disk does not match the requested content.";
            log(`[di-chat] apply_file_edit: ${displayPath} — ${errText}`);
            onError?.(`apply_file_edit ${displayPath}`, errText);
            return { status: "error", path: filePath, displayPath, error: errText };
        }

        // Stash the "before" snapshot for the native diff editor.
        const originalUri = provider.store(displayPath, oldContent);
        log(`[di-chat] apply_file_edit: ${existed ? "edited" : "created"} ${displayPath}`);
        return {
            status: existed ? "edited" : "created",
            path: filePath, displayPath, originalUri: originalUri.toString(),
        };
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log(`[di-chat] apply_file_edit failed: ${errMsg}`);
        onError?.(`apply_file_edit ${rawPath}`, errMsg);
        return { status: "error", error: errMsg };
    }
}

/**
 * Build a nested {@link vscode.ChatResponseFileTree} from a flat list of
 * workspace-relative, '/'-separated paths. Directories are coalesced so the
 * overview reads like VS Code's native changed-files tree.
 */
function buildFileTree(displayPaths: string[]): vscode.ChatResponseFileTree[] {
    const root: vscode.ChatResponseFileTree[] = [];
    for (const p of displayPaths) {
        const parts = p.split("/").filter(Boolean);
        let level = root;
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i];
            let node = level.find((n) => n.name === name);
            if (!node) {
                node = { name };
                level.push(node);
            }
            if (i < parts.length - 1) {
                node.children ??= [];
                level = node.children;
            }
        }
    }
    return root;
}

/**
 * Render a single end-of-turn "Files changed" summary (Option A): one
 * working-set-style view for ALL `apply_file_edit`s in the turn, instead of an
 * inline diff button after each one. This is the closest stable-API analogue
 * of VS Code's native chat-edits working set (the real thing \u2014 `textEdit`
 * parts with Keep/Undo \u2014 is proposed API only and can't ship to the
 * Marketplace).
 *
 * Behavior:
 *  - Dedups by file path, keeping the FIRST pre-edit snapshot so a file edited
 *    several times in one turn shows a single *cumulative* diff.
 *  - Emits a filetree overview (click \u2192 open file) plus a per-file
 *    "Review changes" button (click \u2192 native before/after diff).
 *  - Lists any failed edits at the end. No-op when nothing changed.
 */
export function renderFileEditSummary(
    stream: vscode.ChatResponseStream,
    edits: FileEditResult[],
    baseUri: vscode.Uri,
): void {
    if (edits.length === 0) return;

    const changed = new Map<string, { displayPath: string; path: string; originalUri: string; created: boolean }>();
    const errors: Array<{ displayPath: string; error: string }> = [];
    for (const e of edits) {
        if (e.status === "error") {
            errors.push({ displayPath: e.displayPath ?? e.path ?? "file", error: e.error });
            continue;
        }
        if (e.status === "unchanged") continue;
        // created | edited
        const existing = changed.get(e.path);
        if (existing) {
            // Keep the first snapshot (existing.originalUri) for a cumulative
            // diff; a file is "created" if any edit in the turn created it.
            existing.created = existing.created || e.status === "created";
        } else {
            changed.set(e.path, {
                displayPath: e.displayPath,
                path: e.path,
                originalUri: e.originalUri,
                created: e.status === "created",
            });
        }
    }

    if (changed.size === 0 && errors.length === 0) return;

    stream.markdown("\n---\n");

    if (changed.size > 0) {
        const files = [...changed.values()];
        stream.markdown(`**Files changed (${files.length})**\n\n`);
        stream.filetree(buildFileTree(files.map((f) => f.displayPath)), baseUri);
        for (const f of files) {
            const verb = f.created ? "Created" : "Edited";
            stream.markdown(`${f.created ? "\u2728" : "\ud83d\udcdd"} **${verb}** `);
            stream.anchor(vscode.Uri.file(f.path), f.displayPath);
            stream.markdown("\n\n");
            stream.button({
                command: "fabricDataFactory.di.reviewFileEdit",
                title: "$(diff) Review changes",
                arguments: [f.originalUri, vscode.Uri.file(f.path).toString(), `${f.displayPath} (changes)`],
            });
        }
    }

    if (errors.length > 0) {
        stream.markdown(`\n\u26a0\ufe0f **${errors.length} file edit(s) failed:**\n`);
        for (const er of errors) {
            stream.markdown(`- \`${er.displayPath}\`: ${er.error}\n`);
        }
    }
}
