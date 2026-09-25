/**
 * Child-process sandbox worker for notebook cell execution.
 *
 * This script runs in a separate Node.js process, giving each notebook
 * its own event loop. It:
 *
 * 1. Creates a fresh DI context (its own copy of all clients).
 * 2. Runs user code cells inside a `vm.createContext` sandbox.
 * 3. Wraps setTimeout/setInterval so we can wait for user-scheduled
 *    timers to drain before reporting results.
 * 4. Captures console output and sends it back via IPC.
 *
 * The parent communicates via `process.send()` / `process.on("message")`.
 *
 * Message protocol (parent → worker):
 *   { type: "run",      id: string, code: string }
 *   { type: "setGlobal", name: string, value: unknown }
 *
 * Message protocol (worker → parent):
 *   { type: "result",   id: string, value: unknown, outputs: string[] }
 *   { type: "error",    id: string, message: string, outputs: string[] }
 *   { type: "ready" }
 */

import * as vm from "node:vm";
import * as nodeModule from "node:module";

// Pre-injected Node.js built-in modules — exposed as sandbox globals so
// LLM-generated scripts can write `fs.writeFileSync(...)` directly without
// a `require()` boilerplate line. Mirrored in `GLOBALS_PREAMBLE` so the
// chat type-checker accepts them.
//
// Note: `url` is intentionally NOT pre-injected because `url` is a very
// common local variable name (e.g. `const url = "https://..."`) and a
// global would shadow/conflict. Use the global `URL` class for parsing or
// `require("node:url")` for the legacy `url.parse`/`url.format` API.
import * as fsModule from "node:fs";
import * as pathModule from "node:path";
import * as osModule from "node:os";
import * as cryptoModule from "node:crypto";
import * as childProcessModule from "node:child_process";
import * as utilModule from "node:util";
import * as streamModule from "node:stream";
import * as eventsModule from "node:events";
import * as stringDecoderModule from "node:string_decoder";
import * as httpModule from "node:http";
import * as httpsModule from "node:https";
import * as netModule from "node:net";
import * as tlsModule from "node:tls";
import * as dnsModule from "node:dns";
import * as querystringModule from "node:querystring";
import * as assertModule from "node:assert";
import * as bufferModule from "node:buffer";
import * as zlibModule from "node:zlib";
import * as readlineModule from "node:readline";
import * as workerThreadsModule from "node:worker_threads";

import type { SandboxInit, ParentMessage, WorkerMessage, InferredGlobal } from "./common";
import {
    // Context + core clients
    createContext,
    createFabricClient,
    createAirflowClient,
    createAirflowRunner,
    createCopyJobClient,
    createDataflowClient,
    createPipelineClient,
    createDbtClient,
    createOneLakeClient,
    createWarehouseClient,
    createSqlEndpointClient,
    createItemSyncService,
    createPyHelperClient,
    createConfigClient,
    createNodeAzureAuth,
    createCancellationToken,
    createLocalAirflowClient,
    createConnectionClient,
    createGatewayClient,
    // Pipeline + Copy/CopyJob builder factories
    createPipelineBuilder,
    createCopyActivityBuilder,
    createCopyJobBuilder,
    createCopySource,
    createCopySink,
    createCopyJobSource,
    createCopyJobSink,
    createCopyJobTableSource,
    createCopyJobTableSink,
    createIfConditionBuilder,
    createLookupActivityBuilder,
    pipelineExpression,
    // Mashup document + pattern factories
    makeBlankDocument,
    makeLetBuilder,
    makeReferencePattern,
    makeUnknownPattern,
    makePatternFromConnection,
    makeNavigationPattern,
    makeTableNavigationPattern,
    makeSchemaItemNavigationPattern,
    makeOdataFeedPattern,
    makeSqlDatabasePattern,
    makeSqlDatabasesPattern,
    makeSharePointFilesPattern,
    makeSharePointTablesPattern,
    makeFileFormatPattern,
    makeFolderContentsPattern,
    makeNativeQueryPattern,
    makeWebBrowserContentsPattern,
    // Enum objects, exported by the addon at runtime.
    ActivityState,
    CopyJobMode,
    CopyJobSinkKind,
    CopyJobSourceKind,
    CopySinkKind,
    CopySourceKind,
    DependencyCondition,
    FabricItemType,
    HttpMethod,
    InactiveMarkAs,
    ParameterType,
    ScriptParameterDirection,
    ScriptParameterType,
    ScriptQueryType,
    VariableType,
} from "data-integration";

// ── Bootstrap ────────────────────────────────────────────────────────────────

interface WorkerInit extends SandboxInit {}

const init: WorkerInit = JSON.parse(process.env.SANDBOX_INIT ?? "{}");

if (!init.baseFolder) {
    process.stderr.write("sandbox-worker: SANDBOX_INIT.baseFolder is required\n");
    process.exit(1);
}

// Create a DI context with Azure CLI auth inside this process.
const diCtx = createContext({
    baseFolder: init.baseFolder
});

// ── Timer tracking ───────────────────────────────────────────────────────────
// Wrap setTimeout/setInterval so we can track user-scheduled timers and wait
// for them to complete. This only catches timers created by user code via the
// sandbox globals — NOT internal timers from Node.js HTTP/TLS/DNS (which is
// exactly what we want).

const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
let drainResolve: (() => void) | null = null;

function checkDrained(): void {
    if (pendingTimers.size === 0 && drainResolve) {
        drainResolve();
        drainResolve = null;
    }
}

const sandboxSetTimeout = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id: ReturnType<typeof setTimeout> = setTimeout((...a: unknown[]) => {
        pendingTimers.delete(id);
        callback(...a);
        checkDrained();
    }, ms, ...args);
    pendingTimers.add(id);
    return id;
};

const sandboxClearTimeout = (id: ReturnType<typeof setTimeout>) => {
    if (pendingTimers.delete(id)) {
        clearTimeout(id);
        checkDrained();
    } else {
        clearTimeout(id);
    }
};

function waitForTimers(timeoutMs: number): Promise<void> {
    if (pendingTimers.size === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        drainResolve = resolve;
        const timer = setTimeout(() => {
            drainResolve = null;
            // Clear all pending user timers
            for (const id of pendingTimers) clearTimeout(id);
            pendingTimers.clear();
            reject(new Error(`Cell timed out after ${timeoutMs}ms waiting for timers to complete`));
        }, timeoutMs);
        timer.unref?.();
    });
}

// ── VM context (shared across cells, like a Jupyter kernel) ──────────────────

// Controlled require — only allows Node.js built-in modules.
const builtinRequire = nodeModule.createRequire(__filename);
const sandboxRequire = (id: string) => {
    if (nodeModule.isBuiltin(id)) {
        return builtinRequire(id);
    }
    throw new Error(
        `Cannot require("${id}"): only Node.js built-in modules are allowed. ` +
        `Use "node:${id}" or a built-in module name.`,
    );
};

// CJS module/exports shim so transpiled TS `import` statements work.
const cellModule = { exports: {} as Record<string, unknown> };

/**
 * Buffered single-shot HTTP(S) request helper exposed as a sandbox global.
 *
 * A typed, ergonomic alternative to hand-rolling `https.request(...)` (which
 * LLM-generated scripts repeatedly get wrong — untyped `unknown` results,
 * missing stream plumbing). Performs one request, buffers the entire response
 * body, and resolves `{ status, ok, headers, body, json() }`. `fetch` is also
 * available for the common case; this is the belt-and-suspenders fallback.
 */
function httpRequest(
    url: string,
    opts: {
        method?: string;
        headers?: Record<string, string>;
        body?: string | Uint8Array | null;
        timeoutMs?: number;
    } = {},
): Promise<{
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    body: string;
    json<T = unknown>(): T;
}> {
    return new Promise((resolve, reject) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch (e) {
            reject(new Error(`httpRequest: invalid URL "${url}": ${(e as Error).message}`));
            return;
        }
        const transport = parsed.protocol === "http:" ? httpModule : httpsModule;
        const req = transport.request(
            parsed,
            { method: opts.method ?? "GET", headers: opts.headers },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
                res.on("end", () => {
                    const bodyStr = Buffer.concat(chunks).toString("utf-8");
                    const headers: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers)) {
                        headers[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
                    }
                    const status = res.statusCode ?? 0;
                    resolve({
                        status,
                        ok: status >= 200 && status < 300,
                        headers,
                        body: bodyStr,
                        json<T = unknown>(): T {
                            return JSON.parse(bodyStr) as T;
                        },
                    });
                });
            },
        );
        req.on("error", reject);
        if (opts.timeoutMs && opts.timeoutMs > 0) {
            req.setTimeout(opts.timeoutMs, () => {
                req.destroy(new Error(`httpRequest: timed out after ${opts.timeoutMs}ms`));
            });
        }
        if (opts.body != null) req.write(opts.body);
        req.end();
    });
}

const sandboxGlobals: Record<string, unknown> = {
    // DI clients from context
    ...(diCtx as unknown as Record<string, unknown>),

    // ── Enum runtime objects ──────────────────────────────────────────────
    // Referenced from the addon, never transcribed: hand-written copies of these
    // silently lost members as connectors were added (e.g. CopySinkKind.DataWarehouse).
    ActivityState,
    CopyJobMode,
    CopyJobSinkKind,
    CopyJobSourceKind,
    CopySinkKind,
    CopySourceKind,
    DependencyCondition,
    FabricItemType,
    HttpMethod,
    InactiveMarkAs,
    ParameterType,
    ScriptParameterDirection,
    ScriptParameterType,
    ScriptQueryType,
    VariableType,

    // ── DI factory functions ──────────────────────────────────────────────
    createContext,
    createFabricClient,
    createAirflowClient,
    createAirflowRunner,
    createCopyJobClient,
    createDataflowClient,
    createPipelineClient,
    createDbtClient,
    createOneLakeClient,
    createWarehouseClient,
    createSqlEndpointClient,
    createItemSyncService,
    createPyHelperClient,
    createConfigClient,
    createNodeAzureAuth,
    createCancellationToken,
    createLocalAirflowClient,
    createConnectionClient,
    createGatewayClient,

    // ── Pipeline / Copy / CopyJob builder factories ───────────────────────
    createPipelineBuilder,
    createCopyActivityBuilder,
    createCopyJobBuilder,
    createCopySource,
    createCopySink,
    createCopyJobSource,
    createCopyJobSink,
    createCopyJobTableSource,
    createCopyJobTableSink,
    createIfConditionBuilder,
    createLookupActivityBuilder,
    pipelineExpression,

    // ── Mashup document + pattern factories ───────────────────────────────
    makeBlankDocument,
    makeLetBuilder,
    makeReferencePattern,
    makeUnknownPattern,
    makePatternFromConnection,
    makeNavigationPattern,
    makeTableNavigationPattern,
    makeSchemaItemNavigationPattern,
    makeOdataFeedPattern,
    makeSqlDatabasePattern,
    makeSqlDatabasesPattern,
    makeSharePointFilesPattern,
    makeSharePointTablesPattern,
    makeFileFormatPattern,
    makeFolderContentsPattern,
    makeNativeQueryPattern,
    makeWebBrowserContentsPattern,

    // CJS module support (for transpiled TS imports)
    require: sandboxRequire,
    module: cellModule,
    exports: cellModule.exports,

    // ── Node.js built-in modules ──────────────────────────────────────────
    // Exposed as globals so LLM-generated scripts can skip the
    // `const fs = require("fs")` boilerplate entirely. Anything not in
    // this list is still reachable via `require("node:xxx")` — e.g.
    // `url` (intentionally not a global; see import-block note above),
    // `perf_hooks`, `cluster`, `dgram`, etc.
    fs: fsModule,
    path: pathModule,
    os: osModule,
    crypto: cryptoModule,
    child_process: childProcessModule,
    util: utilModule,
    stream: streamModule,
    events: eventsModule,
    string_decoder: stringDecoderModule,
    http: httpModule,
    https: httpsModule,
    net: netModule,
    tls: tlsModule,
    dns: dnsModule,
    querystring: querystringModule,
    assert: assertModule,
    buffer: bufferModule,
    zlib: zlibModule,
    readline: readlineModule,
    worker_threads: workerThreadsModule,

    // Node `process` global — needed for `process.env.X` env-passthrough,
    // `process.platform`, `process.cwd()`, etc. `vm.createContext` does NOT
    // inherit `process` from the parent realm, so we must inject it.
    process,

    // Wrapped timers — only these are tracked for drain
    setTimeout: sandboxSetTimeout,
    clearTimeout: sandboxClearTimeout,
    setInterval,
    clearInterval,

    // Safe built-ins — console is overridden per-cell execution
    console,
    JSON,
    Promise,
    Buffer,
    Date,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    RegExp,
    Error,
    TypeError,
    RangeError,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    structuredClone,
    fetch,
    httpRequest,
};

const vmContext = vm.createContext(sandboxGlobals, {
    name: "notebook-sandbox",
    codeGeneration: { strings: false, wasm: false },
});

// Snapshot of the initial context keys — used to detect user-defined globals.
const builtinKeys = new Set(Object.keys(vmContext as Record<string, unknown>));

// ── Runtime type inference ───────────────────────────────────────────────────

/**
 * Infer a TypeScript type string from a runtime value.
 * Handles primitives, arrays, plain objects (structural), and functions.
 * Falls back to `any` for complex/circular values.
 */
function inferType(value: unknown, depth = 0): string {
    if (depth > 3) return "any"; // prevent deep/circular recursion

    if (value === null) return "null";
    if (value === undefined) return "undefined";

    switch (typeof value) {
        case "string":   return "string";
        case "number":   return "number";
        case "boolean":  return "boolean";
        case "bigint":   return "bigint";
        case "symbol":   return "symbol";
        case "function": return "(...args: any[]) => any";
    }

    // Array
    if (Array.isArray(value)) {
        if (value.length === 0) return "any[]";
        // Infer from first element
        return `${inferType(value[0], depth + 1)}[]`;
    }

    // Plain object — infer structural type
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length === 0) return "Record<string, unknown>";
        const props = entries.map(
            ([k, v]) => `${/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k)}: ${inferType(v, depth + 1)}`,
        );
        return `{ ${props.join("; ")} }`;
    }

    // Class instances, Maps, Sets, etc. — too complex to structurally infer
    return "any";
}

/**
 * Detect globals that were added to the vm context after cell execution
 * (i.e., not in the original `builtinKeys` set).
 * Reads `__decl_kinds__` to annotate with const/let/var.
 */
function detectNewGlobals(): InferredGlobal[] {
    const ctx = vmContext as Record<string, unknown>;
    const declKinds = (ctx.__decl_kinds__ ?? {}) as Record<string, "const" | "let" | "var">;
    const globals: InferredGlobal[] = [];
    for (const key of Object.keys(ctx)) {
        if (builtinKeys.has(key)) continue;
        if (key === "__decl_kinds__") continue;
        globals.push({
            name: key,
            typeStr: inferType(ctx[key]),
            kind: declKinds[key] ?? "let",
        });
    }
    return globals;
}

// ── Cell execution ───────────────────────────────────────────────────────────

function send(msg: WorkerMessage): void {
    process.send!(msg);
}

/** Streaming-only caps. The buffered `outputs` array is never truncated or capped. */
const MAX_STREAMED_LINE_CHARS = 500;
const MAX_STREAMED_LINES = 500;

async function runCell(id: string, code: string): Promise<void> {
    const outputs: string[] = [];

    // Buffer every line (terminal result) AND forward it immediately, so a poll
    // loop's own progress reaches the user during the wait rather than at exit.
    let streamedLines = 0;
    const emit = (line: string): void => {
        outputs.push(line);
        if (streamedLines >= MAX_STREAMED_LINES) return;
        streamedLines++;
        send({
            type: "output",
            id,
            line: line.length > MAX_STREAMED_LINE_CHARS ? `${line.slice(0, MAX_STREAMED_LINE_CHARS)}…` : line,
        });
    };

    // Override console to capture output for this cell
    (vmContext as Record<string, unknown>).console = Object.freeze({
        log: (...args: unknown[]) => emit(args.map(String).join(" ")),
        warn: (...args: unknown[]) => emit(`⚠ ${args.map(String).join(" ")}`),
        error: (...args: unknown[]) => emit(`✗ ${args.map(String).join(" ")}`),
        info: (...args: unknown[]) => emit(args.map(String).join(" ")),
        debug: (...args: unknown[]) => emit(`DEBUG ${args.map(String).join(" ")}`),
        dir: (obj: unknown) => emit(JSON.stringify(obj, null, 2)),
        table: (data: unknown) => emit(JSON.stringify(data, null, 2)),
    });

    // Reset CJS module/exports for each cell
    cellModule.exports = {};
    (vmContext as Record<string, unknown>).exports = cellModule.exports;

    try {
        // Clear any leftover timer state
        pendingTimers.clear();
        drainResolve = null;

        const wrapped = `(async function() {\n${code}\n}).call(this)`;
        const script = new vm.Script(wrapped, { filename: "cell.js" });
        const result = await (script.runInContext(vmContext) as Promise<unknown>);

        // Wait for any user-scheduled setTimeout callbacks to finish
        await waitForTimers(120_000);

        // Serialize the result — only send JSON-safe values
        let serializedResult: unknown = undefined;
        if (result !== undefined && result !== null) {
            try {
                serializedResult = JSON.parse(JSON.stringify(result));
            } catch {
                serializedResult = String(result);
            }
        }

        send({ type: "result", id, value: serializedResult, outputs, globals: detectNewGlobals() });
    } catch (e: unknown) {
        // Clean up on error
        for (const tid of pendingTimers) clearTimeout(tid);
        pendingTimers.clear();
        drainResolve = null;

        const message = e instanceof Error ? e.message : String(e);
        send({ type: "error", id, message, outputs, globals: detectNewGlobals() });
    }
}

// ── IPC message handler ──────────────────────────────────────────────────────

process.on("message", (msg: ParentMessage) => {
    switch (msg.type) {
        case "run":
            void runCell(msg.id, msg.code);
            break;

        case "setGlobal":
            (vmContext as Record<string, unknown>)[msg.name] = msg.value;
            break;
    }
});

// Signal ready
send({ type: "ready" });
