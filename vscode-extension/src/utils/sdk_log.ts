/**
 * Thin wrapper around the addon's `NodeTracingClient` so the extension
 * can write log records into the **same rotating files** as the Rust
 * core. Records are routed through `tracing` with the static target
 * `"js"`, letting users filter via `DI_CODE_LOG=js=debug` (or silence
 * with `js=off`) without touching Rust-side targets.
 *
 * Usage:
 * ```ts
 * import * as sdkLog from "@/utils/sdk_log";
 * sdkLog.info("workspace pulled", "extension/sync");
 * sdkLog.error("failed to start standalone", "extension/airflow");
 * ```
 *
 * The DI context is fetched lazily via {@link tryGetDIContext} on every
 * call until it's available, then cached for the rest of the extension
 * lifetime. Calls made before the context is initialised are silently
 * dropped (the SDK isn't loaded yet, so there's nowhere to write them).
 */

import type { NodeTracingClient } from "data-integration";
import { tryGetDIContext } from "@/services/di-context";

// ── Cached client ───────────────────────────────────────────────────────────

let cachedClient: NodeTracingClient | undefined;

/**
 * Resolve the tracing client on demand. Once the DI context exists we
 * latch onto its `tracingClient` and never re-fetch — the addon's
 * client is a stable reference for the process lifetime.
 *
 * Returns `undefined` if the context isn't initialised yet; callers
 * silently drop the record in that case rather than crashing on what
 * is, by design, best-effort observability.
 */
function getClient(): NodeTracingClient | undefined {
  if (cachedClient) {
    return cachedClient;
  }
  const ctx = tryGetDIContext();
  if (ctx) {
    cachedClient = ctx.tracingClient;
  }
  return cachedClient;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Emit a `TRACE` record into the SDK log files. */
export function trace(message: string, source?: string): void {
  getClient()?.trace(message, source);
}

/** Emit a `DEBUG` record into the SDK log files. */
export function debug(message: string, source?: string): void {
  getClient()?.debug(message, source);
}

/** Emit an `INFO` record into the SDK log files (default verbosity). */
export function info(message: string, source?: string): void {
  getClient()?.info(message, source);
}

/** Emit a `WARN` record into the SDK log files. */
export function warn(message: string, source?: string): void {
  getClient()?.warn(message, source);
}

/** Emit an `ERROR` record into the SDK log files. */
export function error(message: string, source?: string): void {
  getClient()?.error(message, source);
}

/**
 * Emit an **encrypted, compressed** telemetry event carrying an arbitrary
 * JSON property bag (e.g. one chat turn: prompt, tool calls, results).
 *
 * The addon gzip-compresses, age-encrypts (to the team recipient), and
 * base64-encodes the payload, then emits it as a single OTLP log record whose
 * body is `enc.age.gz:<base64>` — opaque to anyone reading the logs/ADX without
 * the private identity. Decrypt with `cargo xtask decrypt-field`. Best-effort:
 * silently dropped if the SDK context isn't ready.
 */
export function logEncGzEvent(payloadJson: string, source?: string): void {
  getClient()?.logEncGzEvent(payloadJson, source);
}

/**
 * Process-wide session id (UUID v4) for this addon load — the same
 * `session.id` resource attribute stamped on every exported span/log.
 * Lets the host surface the id (e.g. in a bug report) so a record can be
 * correlated against the addon's telemetry in ADX.
 *
 * Returns `undefined` if the DI context isn't ready yet (the SDK hasn't
 * loaded, so no session id exists).
 */
export function sessionId(): string | undefined {
  return getClient()?.sessionId ?? undefined;
}

/**
 * Absolute path to the directory the SDK is writing rotating log files
 * into, or `undefined` if the context isn't ready (or the host has no
 * data directory — vanishingly rare). Handy for `Reveal in Explorer`
 * commands and bug-report attachments.
 */
export function logDir(): string | undefined {
  return getClient()?.logDir ?? undefined;
}

/**
 * Bundle every structured rotating log file into a single encrypted
 * diagnostic package (`.dipkg`) under the host's Downloads directory.
 *
 * The package is an `age` X25519-encrypted envelope wrapping a Parquet
 * payload of the JSONL records, so it can safely be attached to bug
 * reports / uploaded over public networks — only holders of the SDK
 * team's private identity can decrypt it.
 *
 * Returns the absolute path of the written `.dipkg`, or `undefined`
 * when the DI context isn't ready yet (the SDK hasn't loaded, so
 * there's nothing to export).
 *
 * Throws if the addon refuses the export (e.g. no log files exist
 * yet, or the platform exposes no Downloads directory) — callers
 * should `try/catch` and surface the failure to the user.
 */
export function exportDiagnosticPackage(): string | undefined {
  return getClient()?.exportDiagnosticPackage();
}

// ── Formatting helpers ──────────────────────────────────────────────────────
//
// The native client takes a single `string` per record, so anything
// richer (Errors, objects, mixed positional args) has to be flattened
// at the call site. These helpers keep that flattening consistent —
// matching Node's `console.log` conventions as closely as possible —
// so log lines stay grep-able and the same value never renders two
// different ways across the codebase.

/**
 * Stringify an arbitrary value into a human-readable line (or pretty
 * block for objects), tolerant of every shape that naturally turns
 * up in extension logs.
 *
 * Specifically handles:
 *   - `null` / `undefined` → the literal strings (so they're visible).
 *   - `Error` → full stack trace (so it survives past the toast and
 *     you can grep the log file for a frame).
 *   - `string` → returned as-is.
 *   - `number` / `boolean` / `bigint` → toString.
 *   - `function` → `[Function: <name>]` (matches Node's `util.inspect`).
 *   - `symbol` → its description.
 *   - Everything else → `JSON.stringify` with circular-reference
 *     protection. Falls back to `String(value)` if that still throws
 *     (e.g. a poisoned `toJSON` getter).
 *
 * `pretty` defaults to `true` (2-space indent) so an object dumped on
 * its own line stays readable; pass `false` for a compact single line
 * when interpolating into a wider message.
 */
export function format(value: unknown, pretty = true): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  const t = typeof value;
  if (t === "string") return value as string;
  if (t === "number" || t === "boolean" || t === "bigint") {
    return String(value);
  }
  if (t === "function") {
    const name = (value as { name?: string }).name || "anonymous";
    return `[Function: ${name}]`;
  }
  if (t === "symbol") {
    return (value as symbol).toString();
  }
  try {
    return JSON.stringify(value, circularReplacer(), pretty ? 2 : undefined) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * `console.log`-style join of an arbitrary list of values.
 *
 * Each value is run through {@link format} (compact mode for inline
 * cleanliness) and joined with single spaces. Multi-line results
 * (e.g. an `Error` stack) are pushed onto their own line so the
 * leading values stay scannable.
 *
 * ```ts
 * sdkLog.info(sdkLog.fmt("pulled item", item.id, { count: 12 }), "extension/sync");
 * sdkLog.error(sdkLog.fmt("sync failed for", item.id, err), "extension/sync");
 * ```
 */
export function fmt(...values: readonly unknown[]): string {
  if (values.length === 0) return "";
  const parts: string[] = [];
  for (const v of values) {
    const s = format(v, /* pretty */ false);
    parts.push(s.includes("\n") ? `\n${s}` : s);
  }
  return parts.join(" ");
}

/**
 * Pretty-printed (2-space indent) `JSON.stringify` with circular
 * protection. Use when you want a structured object on its own line
 * (e.g. a request payload dump) — equivalent to `format(value, true)`
 * but reads more naturally at call sites:
 *
 * ```ts
 * sdkLog.debug(`req body:\n${sdkLog.inspect(payload)}`, "extension/http");
 * ```
 */
export function inspect(value: unknown): string {
  return format(value, /* pretty */ true);
}

/**
 * Build a `JSON.stringify` replacer that swaps repeat references for
 * `"[Circular]"`. Hoisted into a factory so each call starts with a
 * fresh `WeakSet` — sharing one across calls would falsely mark
 * unrelated objects as circular.
 *
 * Also rewrites `bigint` (which `JSON.stringify` refuses) into a
 * trailing-`n` literal so it round-trips visually.
 */
function circularReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (value !== null && typeof value === "object") {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    if (typeof value === "bigint") return `${value}n`;
    return value;
  };
}
