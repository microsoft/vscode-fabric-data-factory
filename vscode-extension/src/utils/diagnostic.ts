/**
 * Diagnostic envelope: the JS-side mirror of
 * `di_core::common::diagnostic::Diagnostic`.
 *
 * The Rust addon embeds this envelope (as JSON) into every
 * `napi::Error::reason` string it produces, behind a sentinel marker.
 * Parsing it gives the extension structured access to the error kind,
 * cause chain, per-item failure list, and a captured backtrace (when
 * `RUST_BACKTRACE=1`) without trying to regex-match free-form strings.
 *
 * Wire format produced by the addon:
 * ```
 * {summary line — human readable}
 * ---<DIAGNOSTIC>---
 * {"kind":"Http","summary":"…","chain":[…],"fields":{…},"backtrace":…}
 * ```
 */

/**
 * Sentinel that separates the human summary from the JSON envelope in
 * the addon's `Error.reason` strings. Must stay in sync with
 * `crates/core/src/common/diagnostic.rs::DIAGNOSTIC_MARKER`.
 */
export const DIAGNOSTIC_MARKER = "---<DIAGNOSTIC>---";

/**
 * Stable kind discriminator emitted by the Rust side. New variants may
 * be appended on the Rust side — treat unknown kinds as "Other" rather
 * than throwing.
 */
export type DiagnosticKind =
  | "Http"
  | "Auth"
  | "Config"
  | "Io"
  | "Serialization"
  | "Cancelled"
  | "Validation"
  | "Timeout"
  | "Aggregate"
  | "Sync"
  | "Other";

/** Source location of the Rust-side conversion call site. */
export interface DiagnosticOrigin {
  file: string;
  line: number;
  module: string;
}

/** Single sub-failure inside an `Aggregate` diagnostic. */
export interface AggregateFailureFields {
  workspaceId?: string;
  itemId?: string;
  itemName?: string;
  itemType?: string;
  [k: string]: unknown;
}

/**
 * Mirror of the Rust `Diagnostic` envelope. `fields` is a free-form bag
 * of kind-specific data (HTTP status, item identity for aggregates, …)
 * — kind handlers know what to look for there.
 */
export interface Diagnostic {
  kind: DiagnosticKind;
  summary: string;
  chain: string[];
  fields: Record<string, unknown>;
  backtrace?: string;
  origin?: DiagnosticOrigin;
}

/**
 * Attempt to parse a structured diagnostic from a raw error message or
 * `Error`. Returns `undefined` when the message doesn't carry a
 * diagnostic envelope (i.e. the error came from JS code or a Rust
 * call site that hasn't been migrated yet).
 *
 * The parser is intentionally lenient:
 * - Missing marker → undefined (not an error).
 * - Marker present but JSON malformed → undefined + a console.warn.
 *   (We never throw from the error path — that would mask the real bug.)
 */
export function parseDiagnostic(err: unknown): Diagnostic | undefined {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!raw) return undefined;
  const markerIdx = raw.indexOf(DIAGNOSTIC_MARKER);
  if (markerIdx < 0) return undefined;
  // After the marker line there should be exactly one JSON line.
  const after = raw.slice(markerIdx + DIAGNOSTIC_MARKER.length);
  const json = after.replace(/^\r?\n/, "").trim();
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Partial<Diagnostic>;
    // Minimal shape validation — `kind` and `summary` are required.
    if (
      typeof parsed.kind !== "string" ||
      typeof parsed.summary !== "string"
    ) {
      return undefined;
    }
    return buildDiagnostic(parsed);
  } catch (e) {
    // Don't throw from the error path. Log once via console so a real
    // bug here surfaces in the Extension Host dev tools but the user's
    // original error still propagates.
    console.warn("parseDiagnostic: failed to parse envelope:", e);
    return undefined;
  }
}

/** Lift a `Partial<Diagnostic>` into a fully-typed [`Diagnostic`].
 *
 * Optional fields (`backtrace`, `origin`) are only set when present so
 * the runtime object's `exactOptionalPropertyTypes` shape matches the
 * declared interface — TypeScript would otherwise complain about
 * `string | undefined` not being assignable to optional `string`.
 */
function buildDiagnostic(p: Partial<Diagnostic>): Diagnostic {
  const out: Diagnostic = {
    kind: p.kind as DiagnosticKind,
    summary: p.summary as string,
    chain: Array.isArray(p.chain) ? p.chain.map(String) : [],
    fields: (p.fields as Record<string, unknown>) ?? {},
  };
  if (typeof p.backtrace === "string") out.backtrace = p.backtrace;
  if (p.origin) out.origin = p.origin;
  return out;
}

/**
 * Extract the per-item failures from an `Aggregate` diagnostic.
 * Returns an empty array if the diagnostic isn't an aggregate or the
 * failures field is missing/malformed.
 */
export function aggregateFailures(d: Diagnostic): Diagnostic[] {
  if (d.kind !== "Aggregate") return [];
  const raw = d.fields["failures"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => {
      if (!f || typeof f !== "object") return undefined;
      const obj = f as Partial<Diagnostic>;
      if (typeof obj.kind !== "string" || typeof obj.summary !== "string") {
        return undefined;
      }
      return buildDiagnostic(obj);
    })
    .filter((d): d is Diagnostic => d !== undefined);
}

/**
 * Build a multi-line human-readable rendering of a diagnostic suitable
 * for the output channel / clipboard. Includes the summary, all `caused
 * by` chain entries, per-item failures (for aggregates), origin, and
 * backtrace when present.
 */
export function formatDiagnostic(d: Diagnostic, indent = ""): string {
  const lines: string[] = [];
  lines.push(`${indent}[${d.kind}] ${d.summary}`);
  d.chain.forEach((c, i) => {
    lines.push(`${indent}  caused by [${i + 1}]: ${c}`);
  });
  // Render select fields inline. Skip the failures array — it's
  // rendered below with the recursive call.
  const skip = new Set(["failures", "total", "succeeded", "failed"]);
  for (const [k, v] of Object.entries(d.fields)) {
    if (skip.has(k)) continue;
    lines.push(`${indent}  ${k}: ${formatField(v)}`);
  }
  if (d.kind === "Aggregate") {
    const failures = aggregateFailures(d);
    if (failures.length > 0) {
      lines.push(`${indent}  failures (${failures.length}):`);
      for (const f of failures) {
        // Two-space child indent under "failures:".
        lines.push(formatDiagnostic(f, `${indent}    `));
      }
    }
  }
  if (d.origin) {
    lines.push(
      `${indent}  origin: ${d.origin.file}:${d.origin.line} (${d.origin.module})`,
    );
  }
  if (d.backtrace) {
    lines.push(`${indent}  backtrace:`);
    for (const line of d.backtrace.split(/\r?\n/)) {
      lines.push(`${indent}    ${line}`);
    }
  }
  return lines.join("\n");
}

function formatField(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Group an aggregate's per-item failures by kind for a short summary
 * like "3 HTTP, 1 Timeout, 1 Auth".
 */
export function summarizeAggregate(d: Diagnostic): string {
  const failures = aggregateFailures(d);
  if (failures.length === 0) return d.summary;
  const counts = new Map<DiagnosticKind, number>();
  for (const f of failures) {
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}`);
  return `${d.summary} (${parts.join(", ")})`;
}
