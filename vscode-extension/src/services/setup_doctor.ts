/**
 * "Fabric: Run Setup Doctor" — a self-serve first-run diagnostic that runs
 * **without** the native addon (unlike Export Diagnostic, which needs the very
 * component that may have failed to load — S9).
 *
 * It reproduces the addon's `az` dependency chain from the extension host and
 * reports a structured verdict:
 *   - host platform/arch and whether the addon loaded (+ shipped `.node` files)
 *   - `az` on PATH and its version (S1/S3)
 *   - `az account show` — signed-in user, tenant, cloud (S8)
 *   - a token for the Fabric scope can actually be acquired (S3/S8)
 *   - **end-to-end**: the addon's own Fabric client can reach the API with a
 *     harmless stateless read (`listWorkspaces`) — the real path the extension
 *     uses, catching proxy/TLS/firewall (S7) and tenant/cloud (S8) problems the
 *     `az`-only checks can't see
 *
 * The verdict is written to the bootstrap sink (`setup.doctor`), copied to the
 * clipboard, and offered as an editor document — so a stuck user can hand us a
 * report today. **The Fabric token's value is never captured** (we only record
 * whether acquisition succeeded); `az account show` fields (tenant/user/cloud)
 * are not secrets and are included for triage.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as bootstrap from "@/utils/bootstrap_log";
import { tryGetDIContext } from "@/services/di-context";
import { runShell } from "@/utils/shell";
import { classifyNetworkError } from "@/utils/network_error";
import { classifyFabricAccess, fabricAccessAdvice } from "@/utils/fabric_access_error";

const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";

/** Cap the end-to-end addon call so a blocked network can't hang the doctor. */
const ADDON_CALL_TIMEOUT_MS = 15000;

type CheckStatus = "ok" | "fail" | "warn";

interface Check {
    name: string;
    status: CheckStatus;
    detail: string;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", fail: "✗", warn: "!" };

/** Register the `fabricDataFactory.runSetupDoctor` command. Addon-independent. */
export function registerSetupDoctor(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand("fabricDataFactory.runSetupDoctor", () =>
        runSetupDoctor(context),
    );
}

async function runSetupDoctor(context: vscode.ExtensionContext): Promise<void> {
    const checks = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Fabric: running Setup Doctor…" },
        () => collectChecks(context),
    );

    const report = formatReport(checks);

    // Persist a structured record (no secrets) and hand the user the report.
    bootstrap.info("setup.doctor", {
        checks: checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
    });
    await vscode.env.clipboard.writeText(report);

    const worst = checks.some((c) => c.status === "fail")
        ? "fail"
        : checks.some((c) => c.status === "warn")
          ? "warn"
          : "ok";
    const summary =
        worst === "ok"
            ? "Setup Doctor: all checks passed. Report copied to clipboard."
            : "Setup Doctor found problems. Report copied to clipboard.";

    const choice = await vscode.window.showInformationMessage(summary, "Show Report");
    if (choice === "Show Report") {
        const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: "markdown",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
    }
}

// ── Checks ──────────────────────────────────────────────────────────────────

async function collectChecks(context: vscode.ExtensionContext): Promise<Check[]> {
    const checks: Check[] = [];

    // 1. Host + addon.
    const host = `${process.platform}-${process.arch}`;
    const addonLoaded = tryGetDIContext() !== undefined;
    const binaries = listShippedBinaries(context);
    checks.push({
        name: "Native addon",
        status: addonLoaded ? "ok" : "warn",
        detail: addonLoaded
            ? `loaded (host ${host})`
            : `not loaded (host ${host}); shipped binaries: ${binaries.join(", ") || "none found"}`,
    });

    // 2. az version.
    const ver = await runShell("az", ["version", "-o", "json"]);
    if (ver.spawnError || ver.timedOut || !ver.ok) {
        const notFound = azLooksMissing(ver.code, ver.stderr, ver.spawnError);
        checks.push({
            name: "Azure CLI (`az`)",
            status: "fail",
            detail: notFound
                ? "not found on the extension's PATH — install Azure CLI, then restart VS Code so it inherits your PATH"
                : `\`az version\` failed${ver.timedOut ? " (timed out)" : ""}: ${firstLine(ver.stderr) || `exit ${ver.code}`}`,
        });
        // No `az` → the account/token checks can't run.
        return checks;
    }
    const azVersion = parseAzVersion(ver.stdout);
    checks.push({
        name: "Azure CLI (`az`)",
        status: azVersion ? "ok" : "warn",
        detail: azVersion ?? "installed, but `az version` output was not the expected JSON (a wrapper/alias?)",
    });

    // 3. az account show (signed-in identity / tenant / cloud).
    const acct = await runShell("az", ["account", "show", "-o", "json"]);
    if (acct.ok) {
        const info = parseAccount(acct.stdout);
        checks.push({
            name: "Azure sign-in",
            status: "ok",
            detail: info
                ? `${info.user ?? "unknown user"}  tenant=${info.tenantId ?? "?"}  cloud=${info.cloud ?? "?"}`
                : "signed in (could not parse account details)",
        });
    } else {
        checks.push({
            name: "Azure sign-in",
            status: "fail",
            detail: `not signed in — run \`az login\`${firstLine(acct.stderr) ? `: ${firstLine(acct.stderr)}` : ""}`,
        });
    }

    // 4. Fabric-scope token acquisition. We NEVER capture the token itself,
    //    only whether it could be minted.
    const tok = await runShell("az", [
        "account",
        "get-access-token",
        "--scope",
        FABRIC_SCOPE,
        "-o",
        "json",
    ]);
    checks.push({
        name: "Fabric token",
        status: tok.ok ? "ok" : "fail",
        detail: tok.ok
            ? `acquired for ${FABRIC_SCOPE}`
            : `could not acquire for ${FABRIC_SCOPE}${firstLine(tok.stderr) ? `: ${firstLine(tok.stderr)}` : ""}`,
    });

    // 5. End-to-end: exercise the addon's own Fabric client with a harmless,
    //    stateless read (`listWorkspaces`). This is the *real* path the
    //    extension uses — addon → az credential → network → Fabric API — so it
    //    catches proxy/TLS/firewall (S7) and wrong-tenant/cloud (S8) problems
    //    that the `az`-only checks above can't see. Only workspace *count* is
    //    recorded — no names/ids, no token.
    const di = tryGetDIContext();
    if (!di) {
        checks.push({
            name: "Fabric API (native)",
            status: "warn",
            detail: "native addon not loaded — end-to-end check skipped",
        });
        return checks;
    }
    try {
        const workspaces = await withTimeout(
            di.fabricClient.listWorkspaces(),
            ADDON_CALL_TIMEOUT_MS,
        );
        checks.push({
            name: "Fabric API (native)",
            status: "ok",
            detail: `reached Fabric — ${workspaces.length} workspace(s) visible`,
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const access = classifyFabricAccess(e);
        checks.push({
            name: "Fabric API (native)",
            status: "fail",
            detail: access
                ? `listWorkspaces failed (${access}): ${fabricAccessAdvice(access)}`
                : `listWorkspaces failed (${classifyNetworkError(msg)}): ${firstLine(msg) || msg}`,
        });
    }

    return checks;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** List `.node` binaries shipped with the extension (best-effort, shallow). */
function listShippedBinaries(context: vscode.ExtensionContext): string[] {
    const roots = [context.extensionPath, path.join(context.extensionPath, "assets")];
    const found = new Set<string>();
    for (const dir of roots) {
        try {
            for (const name of fs.readdirSync(dir)) {
                if (name.endsWith(".node")) {
                    found.add(name);
                }
            }
        } catch {
            // Directory may not exist in every packaging layout — ignore.
        }
    }
    return [...found];
}

/** True when an `az` invocation looks like "command not found". */
function azLooksMissing(
    code: number | null,
    stderr: string,
    spawnError?: NodeJS.ErrnoException,
): boolean {
    if (spawnError?.code === "ENOENT") {
        return true;
    }
    const s = stderr.toLowerCase();
    return (
        code === 127 ||
        s.includes("not found") ||
        s.includes("not recognized") ||
        s.includes("no such file")
    );
}

function parseAzVersion(stdout: string): string | undefined {
    try {
        const v = JSON.parse(stdout) as { "azure-cli"?: string; "azure-cli-core"?: string };
        if (!v["azure-cli"]) {
            return undefined;
        }
        return `${v["azure-cli"]} (core ${v["azure-cli-core"] ?? "?"})`;
    } catch {
        return undefined;
    }
}

function parseAccount(
    stdout: string,
): { user?: string; tenantId?: string; cloud?: string } | undefined {
    try {
        const a = JSON.parse(stdout) as {
            user?: { name?: string };
            tenantId?: string;
            environmentName?: string;
        };
        return { user: a.user?.name, tenantId: a.tenantId, cloud: a.environmentName };
    } catch {
        return undefined;
    }
}

function firstLine(s: string): string {
    return s.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** Reject if `p` doesn't settle within `ms` — keeps the doctor from hanging. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
            },
        );
    });
}

function formatReport(checks: Check[]): string {
    const lines = [
        "# Fabric Data Factory — Setup Doctor",
        "",
        `Generated: ${new Date().toISOString()}`,
    ];
    const bootstrapPath = bootstrap.filePath();
    if (bootstrapPath) {
        lines.push(`Bootstrap log: ${bootstrapPath}`);
    }
    lines.push("");
    for (const c of checks) {
        lines.push(`- ${MARK[c.status]} **${c.name}** — ${c.detail}`);
    }
    lines.push(
        "",
        "_The Fabric token's value is never captured — only whether it could be acquired._",
    );
    return lines.join("\n");
}
