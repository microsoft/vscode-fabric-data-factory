import * as vscode from "vscode";
import {
  aggregateFailures,
  formatDiagnostic,
  parseDiagnostic,
  summarizeAggregate,
  type Diagnostic,
} from "./diagnostic";
import type { AccountInfoJs } from "data-integration";
import { resolveMicrosoftAccount } from "./msft.tenant.utils";
import { openAdoBugReport } from "./reportError.utils";
import * as sdkLog from "./sdk_log";

const channel = vscode.window.createOutputChannel("Fabric Data Factory");

/**
 * Static `source` label attached to every record this module forwards
 * to the SDK tracing files, so SDK consumers (and `DI_CODE_LOG=js`
 * filters) can tell channel-originated records apart from records
 * emitted directly via {@link sdkLog}.
 */
const SDK_SOURCE = "vscode-extension-channel";

/** Log an informational message to the output channel. */
export function log(message: string): void {
  channel.appendLine(`[${timestamp()}] ${message}`);
  sdkLog.info(message, SDK_SOURCE);
}

/** Log a debug message to the output channel. */
export function debug(message: string): void {
  channel.appendLine(`[${timestamp()}] DEBUG ${message}`);
  sdkLog.debug(message, SDK_SOURCE);
}

/** Log a warning to the output channel. */
export function warn(message: string): void {
  channel.appendLine(`[${timestamp()}] ⚠ ${message}`);
  sdkLog.warn(message, SDK_SOURCE);
}

/** Log an error to the output channel. */
export function error(message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ? String(err) : "";
  channel.appendLine(`[${timestamp()}] ✗ ${message}${detail ? `: ${detail}` : ""}`);
  // Forward the full error (stack included) to the SDK trace files —
  // the user-facing channel intentionally keeps just the short
  // single-line detail to stay readable, but the trace file is the
  // place we expect engineers to look for the full stack.
  sdkLog.error(err === undefined ? message : sdkLog.fmt(message, err), SDK_SOURCE);
}

/**
 * Marker emitted by the Rust addon's legacy aggregate path (pre-Diagnostic).
 * Kept only as a fallback for the unmigrated paths — the new path uses
 * `DIAGNOSTIC_MARKER` from `./diagnostic.ts` and carries a full JSON envelope.
 */
const DETAILS_MARKER = "---<DETAILS>---";

/**
 * Report an error to the user.
 *
 * When the addon's error carries a structured [`Diagnostic`] envelope
 * (the modern path), this function:
 *   1. Logs the full multi-line formatted diagnostic to the output
 *      channel (so cause chain, per-item failures, backtrace, and
 *      origin all survive past the toast lifetime).
 *   2. Surfaces a short toast whose text and action buttons adapt to
 *      the diagnostic kind:
 *        - `Cancelled` → demoted to an info-level log, no toast.
 *        - `Auth`      → toast offers *Sign In*.
 *        - `Aggregate` → toast summarises by kind (e.g. "3 Http, 1 Auth").
 *        - else        → toast offers *Show Output* / *Copy Details*.
 *
 * Falls back to the legacy `---<DETAILS>---` split when the addon
 * hasn't been rebuilt yet, and to a plain first-line summary as a
 * last resort.
 */
export async function reportError(message: string, err: unknown): Promise<void> {
  const raw = err instanceof Error ? err.message : String(err);
  const diagnostic = parseDiagnostic(err);

  // Cancellation is user-initiated — never noisy-toast it.
  if (diagnostic?.kind === "Cancelled") {
    log(`${message}: ${diagnostic.summary}`);
    return;
  }

  // Always log the full detail (formatted or raw) to the output channel
  // so the user can dig in via "Show Output" or by inspecting the log
  // file directly even after the toast disappears.
  channel.appendLine(`[${timestamp()}] ✗ ${message}:`);
  if (diagnostic) {
    channel.appendLine(formatDiagnostic(diagnostic));
  } else {
    channel.appendLine(raw);
  }

  const summary = computeSummary(message, raw, diagnostic);
  const msftAccount = await resolveMicrosoftAccount();
  const actions = computeActions(diagnostic, !!msftAccount);
  const choice = await vscode.window.showErrorMessage(summary, ...actions);
  await handleAction(choice, message, raw, diagnostic, msftAccount);
}

/** Short toast text — prefer the structured summary, with aggregate breakdown. */
function computeSummary(
  message: string,
  raw: string,
  d: Diagnostic | undefined,
): string {
  if (d) {
    const body = d.kind === "Aggregate" ? summarizeAggregate(d) : d.summary;
    return `${message}: ${truncate(body, 240)}`;
  }
  // Legacy fallback: split on the old DETAILS marker so we don't dump
  // multi-line walls into a toast.
  const markerIdx = raw.indexOf(DETAILS_MARKER);
  const summary =
    (markerIdx >= 0 ? raw.slice(0, markerIdx) : raw)
      .split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.trim() ?? raw;
  return `${message}: ${truncate(summary, 240)}`;
}

/** Kind-specific action buttons. */
function computeActions(d: Diagnostic | undefined, msft: boolean): string[] {
  const base: string[] = (() => {
    if (!d) return ["Show Output", "Copy Details"];
    switch (d.kind) {
      case "Auth":
        return ["Sign In", "Show Output", "Copy Details"];
      case "Timeout":
      case "Aggregate":
      default:
        return ["Show Output", "Copy Details"];
    }
  })();
  // "Export Diagnostic" appears on every error toast so users can
  // hand the SDK team an encrypted (.dipkg) bundle of the rotating
  // structured logs covering whatever just blew up. Safe to share
  // over public networks — only the SDK private identity can decrypt.
  const withExport = [...base, "Export Diagnostic"];
  // The "Report Bug" action only appears for Microsoft-tenant accounts
  // because the target ADO project is internal-only.
  return msft ? [...withExport, "Report Bug"] : withExport;
}

async function handleAction(
  choice: string | undefined,
  message: string,
  raw: string,
  d: Diagnostic | undefined,
  msftAccount: AccountInfoJs | undefined,
): Promise<void> {
  switch (choice) {
    case "Show Output":
      channel.show(true);
      return;
    case "Copy Details": {
      const body = d ? formatDiagnostic(d) : raw;
      await vscode.env.clipboard.writeText(`${message}\n${body}`);
      vscode.window.setStatusBarMessage("Error details copied to clipboard", 3000);
      return;
    }
    case "Sign In": {
      // Auth failures in this codebase always mean an expired or
      // missing Azure CLI token. Match the pattern in
      // `services/di-context.ts`: spawn an "Azure CLI" terminal and
      // queue `az login` so the user can hit Enter (or cancel) without
      // having to hunt for the right command.
      const terminal = vscode.window.createTerminal("Azure CLI");
      terminal.show();
      terminal.sendText("az login");
      return;
    }
    case "Export Diagnostic":
      // Delegate to the command registered in extension.ts so the
      // success/failure toast and "Reveal in Explorer" affordance
      // stay defined in exactly one place.
      await vscode.commands.executeCommand(
        "fabricDataFactory.exportDiagnosticPackage",
      );
      return;
    case "Report Bug":
      await openAdoBugReport(message, raw, d, msftAccount);
      return;
    default:
      return;
  }
}

/** Re-exports for consumers that want to inspect the diagnostic directly. */
export { parseDiagnostic, formatDiagnostic, aggregateFailures };
export type { Diagnostic };

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Show the output channel in the panel. */
export function show(): void {
  channel.show(true);
}

/** Get the underlying OutputChannel (e.g. to push into subscriptions). */
export function getChannel(): vscode.OutputChannel {
  return channel;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}
