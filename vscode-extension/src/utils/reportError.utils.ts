import * as vscode from "vscode";
import * as os from "os";
import {
  aggregateFailures,
  formatDiagnostic,
  summarizeAggregate,
  type Diagnostic,
} from "./diagnostic";
import type { AccountInfoJs } from "data-integration";
import { resolveMicrosoftAccount } from "./msft.tenant.utils";
import { log } from "./channel_log";

/**
 * Default ADO bug-create endpoint + area path. Adjust the area to
 * route bugs to a different team if needed — the user can also edit
 * the area in the ADO form before submitting.
 */
const ADO_BUG_BASE =
  "https://msdata.visualstudio.com/Azure%20Data%20Factory/_workitems/create/Bug";
const ADO_DEFAULT_AREA = "Azure Data Factory\\ADF Shanghai UX";

/**
 * Hard cap on the **title** when it's embedded in the bug-create URL.
 *
 * The URL gets re-encoded twice when ADO bounces an unauthenticated
 * user through `login.microsoftonline.com`: once into `state=` and
 * again when Entra rebuilds the redirect. Each `%` becomes `%2525…`,
 * inflating ASCII text by ~3× per round and punctuation/specials by
 * up to 9×. Anything over a few hundred chars trips **AADSTS90015**
 * ("Requested query string is too long"). Title fits comfortably; the
 * description and repro steps never do, so they go on the clipboard
 * instead.
 */
const MAX_TITLE_IN_URL = 160;

/**
 * Build the bug-create URL with **only** title + area path in the
 * query string. The rich description / repro / cause chain always
 * goes on the clipboard (see callers) so the user can paste it after
 * sign-in completes — that bypasses the Entra query-string limit
 * entirely.
 *
 * ADO's deep-link API doesn't accept short aliases like `title=` or
 * `area=`; the parameter names must be the actual field-reference
 * names wrapped in `[...]` (which themselves need URL-encoding into
 * `%5B…%5D`). Example of a working URL:
 *
 *   …/create/Bug?%5BSystem.Title%5D=Foo&%5BSystem.AreaPath%5D=…
 *
 * We deliberately leave Priority / Severity unset — they default
 * sensibly in the form and the accepted string formats vary by
 * project (`"2"` vs `"2 - High"`), so it's safer to let the user pick
 * after the form opens.
 */
function buildBugUrl(title: string): string {
  const params: Array<[string, string]> = [
    ["[System.Title]", truncate(title, MAX_TITLE_IN_URL)],
    ["[System.AreaPath]", ADO_DEFAULT_AREA],
  ];
  const query = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${ADO_BUG_BASE}?${query}`;
}

/**
 * Show a one-shot info toast instructing the user to paste the
 * already-copied bug body into the ADO Description field. Used by
 * both the toast and `/reportError` flows after the browser opens.
 */
function notifyBugDraftOpened(): void {
  void vscode.window.showInformationMessage(
    "Bug draft opened — the full body (including diagnostic) was copied to your clipboard. Paste it into the **Description** field.",
    "Got it",
  );
}

/**
 * Open a prefilled ADO Bug-create form in the external browser,
 * populating title / description / area / priority / severity /
 * repro-steps from the captured error and environment.
 *
 * The browser URL has a practical length limit (~4 KB before some
 * intermediates start truncating), so we also drop a richer block
 * onto the clipboard for the user to paste into a bug comment or
 * attachment.
 *
 * Note: ADO Boards has no public API for attaching screenshots via a
 * deep link, so the toast nudges the user to paste a screenshot
 * manually after the form opens.
 */
export async function openAdoBugReport(
  message: string,
  raw: string,
  d: Diagnostic | undefined,
  msftAccount: AccountInfoJs | undefined,
): Promise<void> {
  const detail = d ? formatDiagnostic(d) : raw;
  const ext = vscode.extensions.getExtension("microsoft.fabric-data-factory");
  const extVersion = (ext?.packageJSON?.version as string | undefined) ?? "unknown";

  const title = buildBugTitle(message, d);
  const description = buildBugDescription({ message, d, msftAccount, extVersion });
  const reproSteps = buildBugReproSteps(detail);

  // Drop the full payload onto the clipboard before opening the URL.
  // The URL itself only carries the title — see `buildBugUrl` for why
  // we can't shove description/reproSteps into the query string.
  const clipboardPayload =
    `${title}\n\n${description}\n\n--- Repro steps ---\n${reproSteps}\n\n--- Full diagnostic ---\n${detail}`;
  await vscode.env.clipboard.writeText(clipboardPayload);

  const url = buildBugUrl(title);
  log(`Opening ADO bug report (${url.length} chars; full body on clipboard).`);
  await vscode.env.openExternal(vscode.Uri.parse(url));
  notifyBugDraftOpened();
}

function buildBugTitle(message: string, d: Diagnostic | undefined): string {
  const kind = d?.kind ? `[${d.kind}] ` : "";
  const head = d?.summary && d.summary !== message ? `: ${d.summary}` : "";
  return `[Fabric VS Code Ext] ${kind}${message}${head}`;
}

function buildBugDescription(args: {
  message: string;
  d: Diagnostic | undefined;
  msftAccount: AccountInfoJs | undefined;
  extVersion: string;
}): string {
  const { message, d, msftAccount, extVersion } = args;
  const lines: string[] = [];

  lines.push("### Summary");
  lines.push(message);
  if (d?.summary && d.summary !== message) {
    lines.push("");
    lines.push(d.summary);
  }
  lines.push("");

  lines.push("### Diagnostic");
  if (d) {
    lines.push(`- kind: \`${d.kind}\``);
    if (d.origin) {
      lines.push(
        `- origin: \`${d.origin.module}\` (${d.origin.file}:${d.origin.line})`,
      );
    }
    if (d.chain?.length) {
      lines.push("- cause chain:");
      for (const c of d.chain.slice(0, 8)) lines.push(`  - ${c}`);
    }
    if (d.kind === "Aggregate") {
      const failures = aggregateFailures(d);
      if (failures.length) {
        lines.push(`- aggregate breakdown: ${summarizeAggregate(d)}`);
      }
    }
  } else {
    lines.push("_(no structured diagnostic — raw error in repro steps)_");
  }
  lines.push("");

  lines.push("### Environment");
  lines.push(`- VS Code: ${vscode.version}`);
  lines.push(`- Extension: microsoft.fabric-data-factory@${extVersion}`);
  lines.push(`- Platform: ${os.platform()} (${os.arch()})`);
  if (msftAccount?.userPrincipalName) {
    lines.push(`- Reporter: ${msftAccount.userPrincipalName}`);
  } else if (msftAccount?.userDisplayName) {
    lines.push(`- Reporter: ${msftAccount.userDisplayName}`);
  }
  lines.push("");

  lines.push("### Notes");
  lines.push(
    "_Full diagnostic is on the clipboard — paste it as a comment if the form truncates the description._",
  );
  lines.push(
    "_Please attach a screenshot of the canvas / output panel before submitting._",
  );
  return lines.join("\n");
}

function buildBugReproSteps(detail: string): string {
  const head = [
    "1. Open the Fabric Data Factory extension in VS Code.",
    "2. Trigger the failing action (pull / push / run / authoring step).",
    "3. Observe the error captured below.",
    "",
    "--- Captured error ---",
  ].join("\n");
  return `${head}\n${detail}`;
}

/**
 * Payload for the public bug-report helpers used by the `/reportError`
 * chat command. The chat participant supplies a pre-summarised
 * `title` + `body` (typically produced by the LLM); these helpers
 * append the standard environment block and open the ADO form / copy
 * to clipboard.
 */
export interface BugReportPayload {
  title: string;
  body: string;
}

/**
 * Open a prefilled ADO Bug-create form populated with a caller-supplied
 * `title` + `body`. The standard environment block (VS Code version,
 * extension version, platform, reporter UPN) is appended automatically.
 *
 * Same URL-length safeguards as the internal `openAdoBugReport`: the
 * full payload is dropped onto the clipboard before the browser opens
 * so the user can paste it verbatim if the description query string
 * gets truncated.
 */
export async function openBugReport(payload: BugReportPayload): Promise<void> {
  const msftAccount = await resolveMicrosoftAccount();
  const ext = vscode.extensions.getExtension("microsoft.fabric-data-factory");
  const extVersion = (ext?.packageJSON?.version as string | undefined) ?? "unknown";

  const envLines: string[] = [
    "### Environment",
    `- VS Code: ${vscode.version}`,
    `- Extension: microsoft.fabric-data-factory@${extVersion}`,
    `- Platform: ${os.platform()} (${os.arch()})`,
  ];
  if (msftAccount?.userPrincipalName) {
    envLines.push(`- Reporter: ${msftAccount.userPrincipalName}`);
  } else if (msftAccount?.userDisplayName) {
    envLines.push(`- Reporter: ${msftAccount.userDisplayName}`);
  }
  const fullDescription = `${payload.body}\n\n${envLines.join("\n")}`;

  // Full body on the clipboard, title-only in the URL. The Entra
  // sign-in re-encoding pass blows past AADSTS90015's query-string
  // limit if we try to embed the description (see `buildBugUrl`).
  await vscode.env.clipboard.writeText(`${payload.title}\n\n${fullDescription}`);

  const url = buildBugUrl(payload.title);
  log(`Opening ADO bug report from /reportError (${url.length} chars; full body on clipboard).`);
  await vscode.env.openExternal(vscode.Uri.parse(url));
  notifyBugDraftOpened();
}

/** Copy a synthesized bug-report payload to the clipboard (no browser). */
export async function copyBugReport(payload: BugReportPayload): Promise<void> {
  await vscode.env.clipboard.writeText(`${payload.title}\n\n${payload.body}`);
  vscode.window.setStatusBarMessage("Bug report copied to clipboard.", 3000);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
