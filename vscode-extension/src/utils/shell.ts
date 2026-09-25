/**
 * Minimal best-effort shell runner shared by the `az` probe and the Setup
 * Doctor. Goes through a shell (`shell: true`) so `az` / `az.cmd` resolves the
 * same way the addon's `/bin/sh -c` / `cmd /C` credential lookup does, and hides
 * the console window on Windows (`windowsHide`). Never rejects — every outcome
 * (launch failure, timeout, non-zero exit) is returned as a {@link ShellResult}.
 *
 * SECURITY: callers pass **static** command + args only. Do not interpolate
 * user/tenant input into these — `shell: true` would otherwise be an injection
 * surface.
 */

import { spawn } from "child_process";

export interface ShellResult {
    /** True when the process launched and exited 0. */
    ok: boolean;
    /** Exit code, or `null` if it never exited (spawn error / timeout). */
    code: number | null;
    stdout: string;
    stderr: string;
    /** Set when the process couldn't be launched at all. */
    spawnError?: NodeJS.ErrnoException;
    /** True when we killed it after the timeout. */
    timedOut: boolean;
}

export interface RunShellOptions {
    /** Kill the process after this long (ms). Default 8000. */
    timeoutMs?: number;
    /** Cap captured stdout/stderr so a pathological child can't balloon memory. */
    maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/** Run `command args…` through a shell and resolve with a {@link ShellResult}. */
export function runShell(
    command: string,
    args: string[],
    opts: RunShellOptions = {},
): Promise<ShellResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

    return new Promise((resolve) => {
        let settled = false;
        let stdout = "";
        let stderr = "";
        // Declared before `finish` (and left `undefined` until assigned) so a
        // *synchronous* spawn throw can call `finish()` — which clears the timer
        // — without hitting the temporal dead zone of a later `const`.
        let timer: ReturnType<typeof setTimeout> | undefined = undefined;

        const finish = (r: ShellResult): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            resolve(r);
        };

        let child;
        try {
            child = spawn(command, args, { windowsHide: true, shell: true });
        } catch (e) {
            finish({
                ok: false,
                code: null,
                stdout,
                stderr,
                spawnError: e as NodeJS.ErrnoException,
                timedOut: false,
            });
            return;
        }

        timer = setTimeout(() => {
            child.kill();
            finish({ ok: false, code: null, stdout, stderr, timedOut: true });
        }, timeoutMs);
        timer.unref?.();

        child.stdout?.on("data", (d: Buffer) => {
            if (stdout.length < maxBytes) {
                stdout += d.toString();
            }
        });
        child.stderr?.on("data", (d: Buffer) => {
            if (stderr.length < maxBytes) {
                stderr += d.toString();
            }
        });
        child.on("error", (err: NodeJS.ErrnoException) => {
            finish({ ok: false, code: null, stdout, stderr, spawnError: err, timedOut: false });
        });
        child.on("close", (code) => {
            finish({ ok: code === 0, code, stdout, stderr, timedOut: false });
        });
    });
}
