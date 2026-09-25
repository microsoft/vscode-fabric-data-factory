/**
 * Shared infrastructure for the bundled TypeScript language-service assets
 * (`assets/types_node/`, `assets/ts_lib/`, `assets/data-integration.d.ts`).
 *
 * Used by both:
 * - {@link DILanguageServiceHost} in `language-provider/common.ts`
 *   (chat participant + notebook provider)
 * - {@link NotebookLanguageServiceHost} in `notebook/FabricNotebookLanguageProvider.ts`
 *
 * Centralising this here avoids two parallel copies of the directory init,
 * the `@types/node` 22 peer-file workaround, and the lib resolver.
 */

import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { log } from "./channel_log";

// Virtual filenames used by the language service hosts.
export const CELL_FILENAME = "cell.ts";
export const DI_TYPES_FILENAME = "data-integration.d.ts";

// Directories for bundled type declarations (populated by copy-assets.mjs).
// Resolved lazily from the extension URI so they work in the vsix package.
// `undefined` = not initialised; `""` = initialised but missing on disk.
let _nodeTypesDir: string | undefined;
let _tsLibDir: string | undefined;

/**
 * Normalize a filesystem path to forward slashes.
 *
 * TypeScript normalises every path it handles to forward slashes internally,
 * so the language-service hosts receive forward-slash `fileName`s in
 * `getScriptSnapshot`/`fileExists`. On Windows `path.join`/`Uri.fsPath` emit
 * backslashes, which would make `fileName.startsWith(nodeTypesDir)` fail and
 * silently drop the bundled `@types/node` peer files (e.g. the
 * `buffer.buffer.d.ts` that carries `Buffer.from`) from the program — the
 * types then resolve on Linux but not on Windows. Node's `fs` accepts
 * forward slashes on Windows, so normalising everywhere is safe.
 */
function toUnixPath(p: string): string {
    return p.replace(/\\/g, "/");
}

export function initTypeDirs(extensionUri: vscode.Uri): void {
    if (_nodeTypesDir !== undefined) return; // already initialised

    const nodeDir = toUnixPath(vscode.Uri.joinPath(extensionUri, "assets", "types_node").fsPath);
    _nodeTypesDir = fs.existsSync(nodeDir) ? nodeDir : "";

    const tsDir = toUnixPath(vscode.Uri.joinPath(extensionUri, "assets", "ts_lib").fsPath);
    _tsLibDir = fs.existsSync(tsDir) ? tsDir : "";

    if (!_nodeTypesDir) log("⚠ assets/types_node/ not found — Node.js types unavailable");
    if (!_tsLibDir) log("⚠ assets/ts_lib/ not found — TS lib types unavailable");
}

/**
 * Accessor for the absolute path to `assets/types_node/`, or `""` if the
 * directory is missing on disk. Returns `undefined` before `initTypeDirs`
 * has been called. Hosts use this for `fileName.startsWith(...)` checks.
 */
export function getNodeTypesDir(): string | undefined {
    return _nodeTypesDir;
}

/**
 * Try to resolve a Node.js built-in module name to its canonical `.d.ts`
 * inside `assets/types_node/`. Handles both `node:xxx` and bare `xxx`.
 */
export function resolveNodeBuiltinTypes(moduleName: string): string | undefined {
    if (!_nodeTypesDir) return undefined;
    const bare = moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName;
    const candidate = toUnixPath(path.join(_nodeTypesDir, `${bare}.d.ts`));
    if (fs.existsSync(candidate)) return candidate;
    const indexCandidate = toUnixPath(path.join(_nodeTypesDir, bare, "index.d.ts"));
    if (fs.existsSync(indexCandidate)) return indexCandidate;
    return undefined;
}

/**
 * Resolve a TS lib filename (e.g. `lib.es2022.d.ts`) to its path inside
 * `assets/ts_lib/`.
 */
export function resolveLibFile(fileName: string): string | undefined {
    if (!_tsLibDir) return undefined;
    const candidate = toUnixPath(path.join(_tsLibDir, fileName));
    return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * Return every `.d.ts` file under `assets/types_node/` as an absolute path.
 *
 * `@types/node` 22 splits some module augmentations across sibling files
 * (e.g. the full `BufferConstructor.from()`/`alloc()`/`concat()` overloads
 * live in `buffer.buffer.d.ts`, not `buffer.d.ts`). `resolveNodeBuiltinTypes`
 * only resolves the canonical `<bare>.d.ts`, so these peer files would never
 * be added to the language-service program and the augmentations would be
 * lost.
 *
 * Including every `.d.ts` in `getScriptFileNames()` lets TypeScript see the
 * `declare module "<name>" { global { ... } }` augmentations from the peers
 * and merge them into the canonical module's types. Memoized: the directory
 * is read once per process.
 */
let _allNodeTypeDtsCache: string[] | undefined;
export function listAllNodeTypeDts(): string[] {
    if (_allNodeTypeDtsCache !== undefined) return _allNodeTypeDtsCache;
    if (!_nodeTypesDir) {
        _allNodeTypeDtsCache = [];
        return _allNodeTypeDtsCache;
    }
    const out: string[] = [];
    for (const name of fs.readdirSync(_nodeTypesDir)) {
        if (name.endsWith(".d.ts")) {
            out.push(toUnixPath(path.join(_nodeTypesDir, name)));
        }
    }
    _allNodeTypeDtsCache = out;
    return out;
}
