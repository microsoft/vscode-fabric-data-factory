/**
 * First-run `az version` probe.
 *
 * When a brand-new user "can't get the extension to work", the single most
 * useful fact after "did the addon load" is **what `az` the addon's child
 * shell actually sees** — is it on PATH at all, is it the real Azure CLI or a
 * wrapper/alias, and which version. The auth path shells out to `az` (see
 * `crates/core/src/common/azure_auth.rs`), so reproducing that lookup once at
 * activation and recording the result makes S1 (`az` not on PATH), S3 (wrong
 * flavor / too old) and S8 (cloud/tenant) diagnosable from telemetry.
 *
 * This deliberately lives on the **extension** side (Node `child_process`)
 * rather than going through the native addon: it must still run and report even
 * when the addon fails to load, and it writes to the pre-context
 * {@link import("./bootstrap_log") bootstrap sink}. Like the addon's
 * `NoWindowExecutor`, it hides the console window on Windows (`windowsHide`) and
 * goes through a shell so `az` / `az.cmd` resolves the same way the addon's
 * `/bin/sh -c` / `cmd /C` invocation does.
 *
 * Best-effort and fire-and-forget: it never throws, never blocks activation,
 * and caps its own runtime with a timeout.
 */

import * as bootstrap from "./bootstrap_log";
import { runShell } from "./shell";

/** Give `az version` this long before we give up and record a timeout. */
const AZ_PROBE_TIMEOUT_MS = 8000;

/**
 * Run `az version -o json` once and record the outcome to the bootstrap sink
 * under the `az.version` event. Never throws; safe to call fire-and-forget.
 *
 * Recorded `result` values:
 * - `ok` — parsed, with `azureCli` / `azureCliCore` / `extensions`
 * - `not-found` — `az` not resolvable on PATH (S1)
 * - `unparseable` — ran but output wasn't JSON (wrapper / alias / old flavor, S3)
 * - `nonzero-exit` — ran but exited non-zero for another reason
 * - `timeout` — didn't finish within {@link AZ_PROBE_TIMEOUT_MS}
 * - `spawn-error` — the shell itself couldn't be launched
 */
export function probeAzVersion(): void {
    const startedAt = Date.now();
    void runShell("az", ["version", "-o", "json"], { timeoutMs: AZ_PROBE_TIMEOUT_MS }).then((r) => {
        const durationMs = Date.now() - startedAt;

        if (r.timedOut) {
            bootstrap.warn("az.version", { result: "timeout", timeoutMs: AZ_PROBE_TIMEOUT_MS });
            return;
        }
        if (r.spawnError) {
            bootstrap.error("az.version", r.spawnError, {
                result: r.spawnError.code === "ENOENT" ? "not-found" : "spawn-error",
            });
            return;
        }
        if (!r.ok) {
            // With a shell, a missing `az` surfaces as a non-zero exit (not a
            // spawn error): exit 127 on POSIX, and "not recognized" on Windows.
            // Classify those as `not-found` (S1).
            const s = r.stderr.toLowerCase();
            const notFound =
                r.code === 127 ||
                s.includes("not found") ||
                s.includes("not recognized") ||
                s.includes("no such file");
            bootstrap.warn("az.version", {
                result: notFound ? "not-found" : "nonzero-exit",
                code: r.code,
                durationMs,
                stderr: r.stderr.trim().slice(0, 500) || undefined,
            });
            return;
        }

        try {
            const v = JSON.parse(r.stdout) as {
                "azure-cli"?: string;
                "azure-cli-core"?: string;
                extensions?: Record<string, string>;
            };
            bootstrap.info("az.version", {
                result: "ok",
                durationMs,
                azureCli: v["azure-cli"],
                azureCliCore: v["azure-cli-core"],
                extensions:
                    v.extensions && Object.keys(v.extensions).length > 0
                        ? v.extensions
                        : undefined,
            });
        } catch {
            // Ran, exited 0, but the output isn't the JSON the real CLI emits —
            // a wrapper / alias / very old `az` (S3). Keep a small sample.
            bootstrap.warn("az.version", {
                result: "unparseable",
                durationMs,
                sample: r.stdout.trim().slice(0, 300),
            });
        }
    });
}
