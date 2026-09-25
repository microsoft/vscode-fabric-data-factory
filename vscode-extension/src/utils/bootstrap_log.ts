/**
 * Pre-context bootstrap logger.
 *
 * The SDK trace client ({@link import("./sdk_log")}) lives *inside* the native
 * DI context, so any failure that stops the context from loading — the addon's
 * `.node` binary failing to load, `az` not being on the inherited PATH, a
 * surprising base-folder resolution — happens **before** the trace sink exists
 * and is therefore un-loggable through the normal path. Those are exactly the
 * first-run failures users report ("nothing works after I installed it").
 *
 * This module breaks that chicken-and-egg with a dead-simple, dependency-free
 * sink: append JSONL records to `<globalStorage>/bootstrap.log` using
 * synchronous writes, so a record survives even if the process is about to
 * fail right after. It is **best-effort** — every write is wrapped so a logging
 * failure can never break activation. The file is size-bounded: {@link init}
 * rotates it to `bootstrap.log.1` once it exceeds ~1 MiB, so it can never grow
 * without limit across repeated activations.
 *
 * Usage:
 * ```ts
 * import * as bootstrap from "@/utils/bootstrap_log";
 * bootstrap.init(context.globalStorageUri.fsPath);
 * bootstrap.info("activation.start", { version });
 * bootstrap.error("addon.load", err);
 * ```
 *
 * Once the SDK context is up, prefer {@link import("./sdk_log")} /
 * {@link import("./channel_log")} for normal observability — this sink is only
 * for the pre-context window (and as a durable backstop for activation).
 */

import * as fs from "fs";
import * as path from "path";

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Rotate once the active log reaches this size. A single activation only ever
 * writes a handful of small records, so the file can't blow past this within
 * one run — checking (and rotating) once at {@link init} is enough and keeps
 * the per-write path free of any `stat`/size logic.
 */
const MAX_LOG_BYTES = 1024 * 1024; // 1 MiB

// ── Module state ────────────────────────────────────────────────────────────

/** Absolute path to the bootstrap log file, or `undefined` until {@link init}. */
let logFilePath: string | undefined;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Point the bootstrap logger at `<globalStorageFsPath>/bootstrap.log`,
 * creating the directory if needed. Safe to call more than once (last call
 * wins). Never throws — on any failure the logger simply stays disabled and
 * subsequent records fall back to `console`.
 *
 * @param globalStorageFsPath `context.globalStorageUri.fsPath` — the one
 *   directory guaranteed to exist for the extension regardless of whether a
 *   workspace/folder is open. It resolves to the extension's private per-user
 *   global-storage dir (id = "microsoft.fabric-data-factory"), e.g.:
 *   - Linux   `~/.config/Code/User/globalStorage/microsoft.fabric-data-factory`
 *   - Windows `%APPDATA%\Code\User\globalStorage\microsoft.fabric-data-factory`
 *   - macOS   `~/Library/Application Support/Code/User/globalStorage/microsoft.fabric-data-factory`
 *   - Remote  `~/.vscode-server/data/User/globalStorage/microsoft.fabric-data-factory`
 *   The Remote path applies to all server-backed setups (Remote-SSH, WSL, Dev
 *   Containers, Codespaces), where the desktop dirs above don't exist.
 */
export function init(globalStorageFsPath: string): void {
    try {
        fs.mkdirSync(globalStorageFsPath, { recursive: true });
        logFilePath = path.join(globalStorageFsPath, "bootstrap.log");
        rotateIfNeeded(logFilePath);
    } catch (e) {
        // Last-resort: the one place we can't self-log.
        console.error("[bootstrap_log] failed to initialise", e);
        logFilePath = undefined;
    }
}

/** Emit an `info`-level bootstrap record. */
export function info(event: string, detail?: unknown): void {
    write("info", event, detail);
}

/** Emit a `warn`-level bootstrap record. */
export function warn(event: string, detail?: unknown): void {
    write("warn", event, detail);
}

/**
 * Emit an `error`-level bootstrap record. Accepts an `Error` (message + stack
 * are captured) or any value (stringified). Optional `extra` fields are merged
 * into the record alongside the error — handy for attaching a classification
 * (e.g. `{ result: "az-missing" }`) so one record carries both the raw error
 * and the triage kind.
 */
export function error(event: string, err: unknown, extra?: Record<string, unknown>): void {
    const norm = normalizeError(err);
    if (extra === undefined) {
        write("error", event, norm);
        return;
    }
    const errObj = typeof norm === "string" ? { error: norm } : norm;
    write("error", event, { ...extra, ...errObj });
}

/**
 * Absolute path to the bootstrap log file, or `undefined` if {@link init}
 * hasn't run (or failed). Handy for surfacing in a bug report / Setup Doctor.
 */
export function filePath(): string | undefined {
    return logFilePath;
}

// ── Internals ───────────────────────────────────────────────────────────────

type Level = "info" | "warn" | "error";

/**
 * Keep the log bounded: when it reaches {@link MAX_LOG_BYTES}, move it aside to
 * `<file>.1` (overwriting any prior generation) and start fresh. This retains
 * one previous generation for post-mortems while capping total disk use at
 * ~2×{@link MAX_LOG_BYTES}. Best-effort — a rotation failure must never stop
 * the logger from initialising.
 */
function rotateIfNeeded(file: string): void {
    try {
        if (fs.statSync(file).size < MAX_LOG_BYTES) {
            return;
        }
        // rename replaces an existing destination, so a prior `.1` is
        // atomically overwritten (POSIX rename on Linux/macOS; MoveFileExW with
        // MOVEFILE_REPLACE_EXISTING on Windows). We therefore keep exactly one
        // previous generation — it never accumulates `.2`, `.3`, …
        fs.renameSync(file, `${file}.1`);
    } catch (e) {
        // Missing file (nothing to rotate) is the common, expected case — only
        // surface anything else.
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
            console.error("[bootstrap_log] rotation failed", e);
        }
    }
}

/**
 * Append one JSONL record. Synchronous on purpose: a bootstrap failure is
 * often followed immediately by the process/activation bailing out, and a sync
 * write guarantees the line is on disk before that happens. Wrapped so a
 * logging failure can never propagate into activation.
 */
function write(level: Level, event: string, detail?: unknown): void {
    const record = {
        ts: new Date().toISOString(),
        level,
        event,
        ...(detail === undefined ? {} : { detail }),
    };

    let line: string;
    try {
        line = JSON.stringify(record);
    } catch {
        // Circular / non-serialisable detail — fall back to a stringified form.
        line = JSON.stringify({ ts: record.ts, level, event, detail: String(detail) });
    }

    if (!logFilePath) {
        // Not initialised (or init failed): don't lose the record entirely.
        console.error(`[bootstrap_log] ${line}`);
        return;
    }

    try {
        fs.appendFileSync(logFilePath, `${line}\n`);
    } catch (e) {
        console.error(`[bootstrap_log] write failed for "${event}"`, e, line);
    }
}

/** Flatten an unknown thrown value into a serialisable shape. */
function normalizeError(err: unknown): { message: string; stack?: string } | string {
    if (err instanceof Error) {
        return { message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
    }
    return String(err);
}
