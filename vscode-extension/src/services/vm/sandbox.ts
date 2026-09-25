/**
 * Child-process-based sandbox for running notebook cells.
 *
 * Each sandbox spawns a child process (`sandbox-worker.js`) that:
 * - Creates its own DI context (separate copy of all clients)
 * - Maintains a persistent `vm.createContext` across cells (Jupyter-like)
 * - Uses `async_hooks` to wait for all async work to drain
 * - Captures console output and sends it back via IPC
 *
 * TypeScript code is transpiled to JavaScript before sending to the child.
 *
 * Usage:
 * ```ts
 * const sandbox = createSandbox({ baseFolder: "/path/to/project" });
 * const { result, outputs } = await sandbox.run("const x = 42; return x;");
 * sandbox.dispose();
 * ```
 */

import { fork, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as ts from "typescript";
import type { SandboxInit, WorkerMessage, ParentMessage, InferredGlobal } from "./common";

export type { SandboxInit, InferredGlobal } from "./common";

/** Options for creating a sandbox. */
export interface SandboxOptions {
    /** Maximum time in ms to wait for a cell to execute. Defaults to 120000 (2 min). */
    timeout?: number;
    /** Optional logger callback for debug output. */
    logger?: (msg: string) => void;
    /**
     * Called for each console line as the running cell produces it, before the
     * cell finishes. The same lines are still delivered in {@link CellResult.outputs};
     * this is an additional live feed, not a replacement.
     */
    onOutput?: (line: string) => void;
}

/** Result returned from a cell execution. */
export interface CellResult {
    /** The return value of the cell (JSON-serializable). */
    value: unknown;
    /** Captured console output lines. */
    outputs: string[];
    /** Globals added or updated by this cell (name + inferred TS type). */
    globals: InferredGlobal[];
}

/** A sandboxed execution environment for user scripts. */
export interface Sandbox {
    /**
     * Run user code in the sandbox. TypeScript is transpiled to JS automatically.
     * The code is wrapped in an async IIFE, so `await` works at the top level.
     * Use `return` to produce a result value.
     *
     * `timeout` semantics:
     * - `undefined` → use the sandbox's `defaultTimeout` (from {@link SandboxOptions.timeout}).
     * - positive number (ms) → reject with `Cell timed out after Nms` if not done in time;
     *   the worker is left running but its eventual result/error is silently dropped.
     * - `0` → **no parent-side timeout**. The returned promise stays pending until the
     *   worker completes or the sandbox is disposed. Use this when the *caller*
     *   wants to race the promise externally (e.g. the chat layer's pending-handle
     *   path for C.3 long awaits). Caller is responsible for eventually calling
     *   {@link Sandbox.dispose} — otherwise the child process leaks.
     */
    run(code: string, timeout?: number): Promise<CellResult>;

    /**
     * Set or update a global variable in the sandbox.
     * Only JSON-serializable values can be sent to the child process.
     */
    setGlobal(name: string, value: unknown): void;

    /** Kill the child process and release resources. */
    dispose(): void;
}

// ── TypeScript transpilation ─────────────────────────────────────────────────

const tsCompilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    strict: false,
    esModuleInterop: true,
    skipLibCheck: true,
    // No type-checking — just strip types and downlevel syntax
    isolatedModules: true,
    // Inline helpers (__importDefault, etc.) so they're available in the sandbox
    importHelpers: false,
};

function transpileTS(code: string): string {
    const result = ts.transpileModule(code, {
        compilerOptions: tsCompilerOptions,
        reportDiagnostics: false,
    });
    let jsCode = awaitLastExpression(result.outputText);
    jsCode = appendContextCopyBack(jsCode);
    return jsCode;
}

/**
 * Find the last expression statement in the transpiled JS and wrap it
 * with `await`. This ensures fire-and-forget patterns like
 * `(async () => { ... })()` are properly awaited by our outer IIFE wrapper.
 *
 * `await` on a non-thenable is a no-op, so this is safe for sync expressions.
 */
function awaitLastExpression(code: string): string {
    const sourceFile = ts.createSourceFile(
        "cell.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS,
    );

    // Walk backwards to find the last expression statement
    for (let i = sourceFile.statements.length - 1; i >= 0; i--) {
        const stmt = sourceFile.statements[i];
        if (!ts.isExpressionStatement(stmt)) continue;
        // Skip directive prologues ("use strict", etc.)
        if (ts.isStringLiteral(stmt.expression)) continue;

        const start = stmt.getStart(sourceFile);
        const end = stmt.getEnd();
        const exprText = code.substring(start, end).replace(/;\s*$/, "");
        return code.substring(0, start) + `await (${exprText})` + code.substring(end);
    }
    return code;
}

/**
 * A top-level variable with its declaration kind.
 */
interface ExtractedVar {
    name: string;
    kind: "const" | "let" | "var";
}

/**
 * Extract top-level variable declaration names and kinds from transpiled JS.
 * These need to be copied back to the vm context so they persist
 * across cells (Jupyter-like behavior).
 *
 * Handles: `let x = ...`, `const y = ...`, `var z = ...`,
 * and destructuring: `const { a, b } = ...`, `let [c, d] = ...`
 */
function extractTopLevelVars(code: string): ExtractedVar[] {
    const sourceFile = ts.createSourceFile(
        "cell.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS,
    );

    const vars: ExtractedVar[] = [];

    function declKind(flags: ts.NodeFlags): "const" | "let" | "var" {
        if (flags & ts.NodeFlags.Const) return "const";
        if (flags & ts.NodeFlags.Let) return "let";
        return "var";
    }

    function collectBindingNames(node: ts.BindingName, kind: "const" | "let" | "var"): void {
        if (ts.isIdentifier(node)) {
            vars.push({ name: node.text, kind });
        } else if (ts.isObjectBindingPattern(node)) {
            for (const el of node.elements) {
                collectBindingNames(el.name, kind);
            }
        } else if (ts.isArrayBindingPattern(node)) {
            for (const el of node.elements) {
                if (ts.isBindingElement(el)) {
                    collectBindingNames(el.name, kind);
                }
            }
        }
    }

    for (const stmt of sourceFile.statements) {
        if (ts.isVariableStatement(stmt)) {
            const kind = declKind(stmt.declarationList.flags);
            for (const decl of stmt.declarationList.declarations) {
                collectBindingNames(decl.name, kind);
            }
        } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            vars.push({ name: stmt.name.text, kind: "var" }); // functions are hoisted like var
        } else if (ts.isClassDeclaration(stmt) && stmt.name) {
            vars.push({ name: stmt.name.text, kind: "let" }); // classes are block-scoped
        }
    }

    return vars;
}

/**
 * Append code that copies top-level variables back to `this` (the vm context).
 * Also stores the declaration kinds in `this.__decl_kinds__` so the worker
 * can annotate InferredGlobal with const/let/var.
 */
function appendContextCopyBack(code: string): string {
    const vars = extractTopLevelVars(code);
    if (vars.length === 0) return code;
    const copyLines = vars.map((v) => `this[${JSON.stringify(v.name)}] = ${v.name};`).join("\n");
    const kindsObj = Object.fromEntries(vars.map((v) => [v.name, v.kind]));
    const kindsLine = `Object.assign(this.__decl_kinds__ || (this.__decl_kinds__ = {}), ${JSON.stringify(kindsObj)});`;
    return code + "\n" + copyLines + "\n" + kindsLine;
}

// ── Sandbox factory ──────────────────────────────────────────────────────────

/**
 * Create a child-process sandbox.
 *
 * @param init - Initialization data (baseFolder for DI context)
 * @param options - Optional configuration
 */
export function createSandbox(
    init: SandboxInit,
    options: SandboxOptions = {},
): Sandbox {
    const defaultTimeout = options.timeout ?? 120_000;
    const dbg = options.logger ?? (() => {});

    // Resolve the worker script path — sits next to the bundled extension.js
    const workerPath = path.join(__dirname, "sandbox-worker.js");
    dbg(`Spawning sandbox worker: ${workerPath}`);

    const child: ChildProcess = fork(workerPath, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: {
            ...process.env,
            SANDBOX_INIT: JSON.stringify(init),
        },
        // Don't inherit the parent's inspect flags (avoids port conflicts)
        execArgv: [],
    });

    let disposed = false;

    // Forward child stderr to logger
    child.stderr?.on("data", (data: Buffer) => {
        dbg(`[worker:stderr] ${data.toString().trimEnd()}`);
    });
    child.stdout?.on("data", (data: Buffer) => {
        dbg(`[worker:stdout] ${data.toString().trimEnd()}`);
    });

    // Log child lifecycle events
    child.on("error", (err: Error) => {
        dbg(`Child process error: ${err.message}`);
    });
    child.on("spawn", () => {
        dbg(`Child process spawned (pid=${child.pid})`);
    });
    child.on("exit", (code: number | null, signal: string | null) => {
        dbg(`Child process exited (code=${code}, signal=${signal})`);
    });

    // Pending run requests waiting for a response
    const pendingRuns = new Map<string, {
        resolve: (result: CellResult) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout> | undefined;
    }>();

    let nextId = 0;
    let readyResolve: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
        readyResolve = resolve;
        // If child doesn't send ready within 30s, something is wrong
        const readyTimer = setTimeout(() => {
            dbg(`Child process did not send 'ready' within 30s`);
        }, 30_000);
        readyTimer.unref?.();
        const origResolve = resolve;
        readyResolve = () => {
            clearTimeout(readyTimer);
            origResolve();
        };
    });

    // Handle messages from child
    child.on("message", (msg: WorkerMessage) => {
        // Handled before the dbg() below on purpose: the chat layer wires
        // `logger` to the telemetry-backed log(), and one entry per console
        // line would duplicate the whole script output into it.
        if (msg.type === "output") {
            if (pendingRuns.has(msg.id)) options.onOutput?.(msg.line);
            return;
        }
        dbg(`Received IPC: type=${msg.type}, id=${"id" in msg ? msg.id : "n/a"}`);
        if (msg.type === "ready") {
            readyResolve?.();
            readyResolve = null;
            return;
        }

        const pending = pendingRuns.get(msg.id);
        if (!pending) return;

        pendingRuns.delete(msg.id);
        clearTimeout(pending.timer);

        if (msg.type === "result") {
            pending.resolve({ value: msg.value, outputs: msg.outputs, globals: msg.globals });
        } else if (msg.type === "error") {
            const err = new Error(msg.message);
            // Attach outputs and globals so the controller can still use them
            (err as Error & { outputs: string[]; globals: InferredGlobal[] }).outputs = msg.outputs;
            (err as Error & { outputs: string[]; globals: InferredGlobal[] }).globals = msg.globals;
            pending.reject(err);
        }
    });

    // Handle child crash
    child.on("exit", (code: number | null) => {
        if (disposed) return;
        disposed = true;
        for (const [, pending] of pendingRuns) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`Sandbox process exited unexpectedly (code ${code})`));
        }
        pendingRuns.clear();
    });

    return {
        async run(code: string, timeout?: number): Promise<CellResult> {
            if (disposed) {
                throw new Error("Sandbox has been disposed");
            }

            // Wait for child to be ready (first-cell only)
            await readyPromise;

            const effectiveTimeout = timeout ?? defaultTimeout;
            const id = String(++nextId);

            // Transpile TypeScript → JavaScript
            const jsCode = transpileTS(code);
            dbg(`Sending run id=${id}, jsCode length=${jsCode.length}`);
            dbg(`Transpiled code:\n${jsCode}`);

            return new Promise<CellResult>((resolve, reject) => {
                // `timeout === 0` is the opt-in "no parent-side timeout" mode —
                // caller (e.g. the chat layer's pending-handle path) races the
                // promise externally. We do NOT install a timer; the entry
                // stays in `pendingRuns` until the worker actually completes
                // (or the sandbox is disposed).
                let timer: ReturnType<typeof setTimeout> | undefined;
                if (effectiveTimeout > 0) {
                    timer = setTimeout(() => {
                        pendingRuns.delete(id);
                        reject(new Error(`Cell timed out after ${effectiveTimeout}ms`));
                    }, effectiveTimeout);
                    timer.unref?.();
                }

                pendingRuns.set(id, { resolve, reject, timer });
                child.send({ type: "run", id, code: jsCode } satisfies ParentMessage);
            });
        },

        setGlobal(name: string, value: unknown): void {
            if (disposed) return;
            child.send({ type: "setGlobal", name, value } satisfies ParentMessage);
        },

        dispose(): void {
            if (disposed) return;
            disposed = true;

            // Reject all pending runs
            for (const [, pending] of pendingRuns) {
                clearTimeout(pending.timer);
                pending.reject(new Error("Sandbox disposed"));
            }
            pendingRuns.clear();

            // Kill the child process
            child.kill("SIGTERM");
        },
    };
}

