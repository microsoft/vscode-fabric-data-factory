/**
 * Shared types for the sandbox IPC protocol between the parent
 * (sandbox.ts) and child process (sandbox-worker.ts).
 *
 * Keeping these in a single file ensures both sides stay in sync
 * when the protocol evolves.
 */

// ── Init ─────────────────────────────────────────────────────────────────────

/** Data passed to the child process via `SANDBOX_INIT` env var. */
export interface SandboxInit {
    baseFolder: string;
}

// ── Parent → Worker messages ─────────────────────────────────────────────────

export interface RunMessage {
    type: "run";
    id: string;
    code: string;
}

export interface SetGlobalMessage {
    type: "setGlobal";
    name: string;
    value: unknown;
}

/** Union of all messages the parent can send to the worker. */
export type ParentMessage = RunMessage | SetGlobalMessage;

// ── Shared types ─────────────────────────────────────────────────────────────

/**
 * A global variable discovered after cell execution, with its inferred
 * TypeScript type string. Used to populate the language service so
 * subsequent cells get IntelliSense for variables defined in earlier cells.
 */
export interface InferredGlobal {
    /** Variable name as it appears in the vm context. */
    name: string;
    /** TypeScript type string, e.g. `string`, `{ text: string }`, `any`. */
    typeStr: string;
    /** Original declaration kind. Defaults to "let" if unknown. */
    kind: "const" | "let" | "var";
}

// ── Worker → Parent messages ─────────────────────────────────────────────────

export interface ReadyMessage {
    type: "ready";
}

/**
 * One console line, forwarded as soon as the running cell produces it.
 *
 * Purely additive: the same line is still buffered into the terminal
 * {@link ResultMessage.outputs} / {@link ErrorMessage.outputs} array, which is
 * what the notebook controller and the chat agent read. This message exists so
 * a long-polling script's own progress is visible *during* the wait instead of
 * arriving all at once when it exits.
 */
export interface OutputMessage {
    type: "output";
    id: string;
    /** The line, truncated for streaming; the buffered copy is never truncated. */
    line: string;
}

export interface ResultMessage {
    type: "result";
    id: string;
    value: unknown;
    outputs: string[];
    /** New or updated globals after this cell execution. */
    globals: InferredGlobal[];
}

export interface ErrorMessage {
    type: "error";
    id: string;
    message: string;
    outputs: string[];
    /** New or updated globals even on error (partial execution may add vars). */
    globals: InferredGlobal[];
}

/** Union of all messages the worker can send to the parent. */
export type WorkerMessage = ReadyMessage | OutputMessage | ResultMessage | ErrorMessage;
