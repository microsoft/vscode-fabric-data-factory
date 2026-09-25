/**
 * Singleton Airflow service for running a local standalone server.
 *
 * At most one Airflow process runs per VS Code window. The service
 * manages the full lifecycle: venv setup → dependency install →
 * pull item → start server → monitor → stop.
 *
 * UI:
 * - Status bar item showing current state (click to toggle)
 * - Output channel for Airflow logs
 * - Commands for start/stop/restart/open UI
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type {AirflowProcess, FabricItem, NodeAirflowRunner} from "data-integration";
import {FabricItemType} from "data-integration";
import {requestDIContext} from "@/services/di-context";
import {getBaseFolder} from "@/utils/folders";
import {log, error, getChannel} from "@/utils/channel_log";
import {setChatGlobal} from "@/chats/chatParticipant";

// ── Module-level constants ───────────────────────────────────────────────────

/** Polling interval for the unexpected-exit / port-health monitor. */
const MONITOR_INTERVAL_MS = 5000;
/** Consecutive failed port probes required before declaring the webserver dead. */
const UNREACHABLE_STRIKES = 6;
/** Per-probe TCP connect timeout. */
const PROBE_TIMEOUT_MS = 2000;

// ── Types ────────────────────────────────────────────────────────────────────

enum AirflowState {
    Stopped = "stopped",
    Starting = "starting",
    Installing = "installing",
    Running = "running",
    Error = "error",
}

// ── Service ──────────────────────────────────────────────────────────────────

export class AirflowService implements vscode.Disposable {
    private _state: AirflowState = AirflowState.Stopped;
    private _runner: NodeAirflowRunner | undefined;
    private _process: AirflowProcess | undefined;
    private _item: FabricItem | undefined;
    private _port = 8080;
    private _adminPassword: string | undefined;

    private readonly _onDidChangeState = new vscode.EventEmitter<{ state: AirflowState; item?: FabricItem }>();
    /** Fires when the Airflow service state changes (started, stopped, error, etc.). */
    readonly onDidChangeState = this._onDidChangeState.event;

    /** The currently active Airflow item, or undefined if not running. */
    get activeItem(): FabricItem | undefined {
        return this._state === AirflowState.Stopped ? undefined : this._item;
    }

    private readonly _statusBar: vscode.StatusBarItem;
    private readonly _logChannel: vscode.OutputChannel;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _context: vscode.ExtensionContext;

    // Tail watcher for streaming log output
    private _logWatcher: fs.FSWatcher | undefined;
    private _logOffset = 0;

    // FileSystemWatcher that observes `<baseFolder>/.airflow/standalone-info.json`
    // and lets us passively adopt a standalone Airflow instance started by
    // any producer (the extension itself, a CLI in another shell, …).
    private _attachWatcher: vscode.FileSystemWatcher | undefined;
    // Set to `true` while `_tryAttach` is mid-flight so concurrent events
    // (onDidCreate immediately followed by onDidChange) don't race.
    private _attaching = false;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;

        // Reuse the shared "Fabric Data Factory" output channel
        this._logChannel = getChannel();

        // Status bar item
        this._statusBar = vscode.window.createStatusBarItem(
            "airflow-status",
            vscode.StatusBarAlignment.Left,
            50,
        );
        this._statusBar.command = "fabricDataFactory.airflow.startOrOpenBrowser";
        this._updateStatusBar();
        this._statusBar.show();

        // Register commands
        this._disposables.push(
            this._statusBar,
            this._onDidChangeState,
            vscode.commands.registerCommand(
                "fabricDataFactory.airflow.start",
                () => this.start(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.airflow.stop",
                () => this.stop(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.airflow.restart",
                () => this.restart(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.airflow.openUI",
                () => this.openUI(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.airflow.startOrOpenBrowser",
                // Status-bar click handler: start the server if it isn't
                // running yet; open the web UI if it already is. Stopping
                // is left to the explicit `airflow.stop` command (or the
                // status-bar context menu) so a click never accidentally
                // tears down a live server.
                () => this._state === AirflowState.Running ? this.openUI() : this.start(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.airflow.showLogs",
                () => this._logChannel.show(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.airflow.runItem",
                (node?: { item?: FabricItem }) => {
                    if (node?.item && node.item.itemType === FabricItemType.ApacheAirflowJob) {
                        const diContext = requestDIContext();
                        if (diContext) {
                            diContext.configClient.setAirflowActive(node.item.workspaceId, node.item.id);
                            void this.start(node.item);
                        }
                    }
                },
            ),
            // Airflow running decoration (green label for active item) ──
            vscode.window.registerFileDecorationProvider({
                onDidChangeFileDecorations: this.onDidChangeState as unknown as vscode.Event<vscode.Uri | vscode.Uri[] | undefined>,
                provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
                    if (uri.scheme === "fabric-airflow") {
                        return {
                            color: new vscode.ThemeColor("testing.iconPassed"),
                            badge: "▶",
                            tooltip: "Running locally",
                        };
                    }
                    return undefined;
                },
            }),
        );

        // Set up passive attach to externally-started Airflow processes.
        // We do this last so all disposables / event emitters are wired up
        // before any onDidCreate fires.
        try {
            this._startAttachWatcher(getBaseFolder(this._context));
        } catch (e) {
            // No workspace folder → nothing to watch. Not an error.
            log(`[airflow] attach watcher skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    dispose(): void {
        this.stop();
        for (const d of this._disposables) {
            d.dispose();
        }
    }

    // ── Public API ───────────────────────────────────────────

    get state(): AirflowState {
        return this._state;
    }

    get isRunning(): boolean {
        return this._state === AirflowState.Running && (this._process?.isRunning() ?? false);
    }

    /**
     * Start the Airflow standalone server.
     *
     * - If `item` is provided, runs that specific Airflow job.
     * - Otherwise, prompts the user to pick an Airflow job from synced items.
     * - Falls back to `runByConfig()` if no items are available.
     */
    async start(item?: FabricItem): Promise<void> {
        if (this._state === AirflowState.Running || this._state === AirflowState.Starting || this._state === AirflowState.Installing) {
            vscode.window.showWarningMessage("Airflow is already running or starting.");
            return;
        }

        const baseFolder = getBaseFolder(this._context);

        const diContext = requestDIContext();

        if (!diContext) {
            return;
        }

        if (!diContext.airflowRunner) {
            vscode.window.showErrorMessage(
                "Airflow standalone runner is only supported on POSIX platforms (Linux/macOS).",
            );
            return;
        }

        // If no item specified, let the user pick one from synced Airflow jobs
        if (!item) {
            const index = diContext.syncService.readLocalItemStatesMap();
            const airflowStates = Object.values(index).filter(
                (s) => s.itemType === FabricItemType.ApacheAirflowJob,
            );

            if (airflowStates.length === 1) {
                // Only one Airflow job — use it directly
                item = {
                    id: airflowStates[0].itemId,
                    workspaceId: airflowStates[0].workspaceId,
                    displayName: airflowStates[0].displayName,
                    itemType: airflowStates[0].itemType,
                };
            } else if (airflowStates.length > 1) {
                // Multiple Airflow jobs — show quick pick
                const pick = await vscode.window.showQuickPick(
                    airflowStates.map((s) => ({
                        label: s.displayName,
                        description: s.workspaceId.slice(0, 8),
                        state: s,
                    })),
                    {placeHolder: "Select an Airflow job to run locally"},
                );
                if (!pick) return; // user cancelled
                item = {
                    id: pick.state.itemId,
                    workspaceId: pick.state.workspaceId,
                    displayName: pick.state.displayName,
                    itemType: pick.state.itemType,
                };
            }
            // If no airflow items found, fall through to runByConfig()
        }

        this._runner = diContext.airflowRunner;

        // this._logChannel.clear();
        this._logChannel.show(true);
        this._logChannel.appendLine("=== Airflow Standalone Server ===");
        this._logChannel.appendLine(`Base folder: ${baseFolder}`);
        this._logChannel.appendLine("");

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Starting Airflow…",
                cancellable: true,
            },
            async (progress, token) => {
                // Handle cancellation: clean up immediately and reset state
                const cancelDisposable = token.onCancellationRequested(() => {
                    this._logChannel.appendLine("[cancel] Cancellation requested — cleaning up…");
                    this.stop();
                    this._logChannel.appendLine("[cancel] ✓ Cancelled");
                });

                try {
                    // ── 1. Hand off to the Rust orchestrator ──
                    //
                    // `startStandalone()` is the single entry point shared
                    // by *every* consumer (this extension, a future `di
                    // airflow start` CLI, integration tests). It runs venv
                    // setup → dep install → db migrate → admin user →
                    // spawn-airflow-standalone, then writes
                    // `<baseFolder>/.airflow/standalone-info.json` so any
                    // observer can adopt the process by PID.
                    //
                    // All steps are idempotent so cached venvs / installs
                    // are skipped.
                    //
                    // The progress callback streams human-readable status
                    // messages from Rust (e.g. "Installing apache-airflow
                    // ==2.10.5…") into both the output channel and the
                    // VS Code progress notification.
                    this._setState(AirflowState.Installing);
                    progress.report({message: "Preparing Airflow…"});

                    const onProgress = (_err: Error | null, message: string) => {
                        this._logChannel.appendLine(`[setup] ${message}`);
                        progress.report({message});
                    };

                    if (item) {
                        this._logChannel.appendLine(`[start] Item: ${item.displayName} (${item.id})`);
                        await this._runner!.startStandalone(item, "2.10.5", onProgress);
                    } else {
                        this._logChannel.appendLine("[start] Using fabric-di.yaml config");
                        await this._runner!.startStandaloneByConfig("2.10.5", onProgress);
                    }

                    if (token.isCancellationRequested) return;

                    // ── 2. Passive adoption ──
                    //
                    // The watcher on `standalone-info.json` will fire
                    // shortly (the file was just written by the Rust
                    // orchestrator), but we nudge `_tryAttach` here to
                    // avoid an arbitrary delay. The call is idempotent
                    // — if the watcher beat us, `_process` is already
                    // set and `_tryAttach` is a no-op.
                    //
                    // Hydration (state = Running, chat-globals,
                    // unexpected-exit monitor) happens entirely inside
                    // `_tryAttach → _hydrate`, not here.
                    this._setState(AirflowState.Starting);
                    progress.report({message: "Adopting Airflow process…"});
                    await this._tryAttach();

                    if (!this._process) {
                        throw new Error(
                            "Airflow setup completed but the standalone-info.json " +
                            "file could not be read. Check the output channel.",
                        );
                    }

                    if (token.isCancellationRequested) return;

                    // ── 3. Wait-for-port (UI feedback only) ──
                    //
                    // `waitForPort` only does a TCP connect probe — it
                    // works fine on the adopted handle (no Child needed).
                    progress.report({message: `Waiting for port ${this._port}…`});
                    const ready = await this._process.waitForPort(this._port, 120_000);

                    if (token.isCancellationRequested) return;

                    if (!ready) {
                        this._logChannel.appendLine(`[start] ⚠ Port ${this._port} did not become accessible within 2 minutes`);
                        vscode.window.showWarningMessage(
                            `Airflow started but port ${this._port} is not responding. Check the Airflow output channel.`,
                        );
                    }

                    // Try to recover admin password from the Airflow log.
                    // (The Rust orchestrator creates `admin/admin` for
                    // Airflow 2.x; this is a fallback for Airflow 3.x.)
                    if (!this._adminPassword) {
                        const logPath = path.join(baseFolder, ".airflow", "standalone-stdout.log");
                        this._adminPassword = this._process.getAdminPassword(logPath) ?? "admin";
                    }

                    this._logChannel.appendLine(`[start] ✓ Airflow is running on http://localhost:${this._port}`);
                    this._logChannel.appendLine(`[start] Login: username=admin, password=${this._adminPassword}`);
                    log(`Airflow started on port ${this._port} (pid=${this._process.pid})`);

                    // Notify user with an "Open UI" button
                    vscode.window.showInformationMessage(
                        `Airflow is running on port ${this._port}${item ? ` (${item.displayName})` : ""}`,
                        "Open Web UI",
                    ).then((choice) => {
                        if (choice === "Open Web UI") this.openUI();
                    });

                } catch (e) {
                    if (token.isCancellationRequested) return; // cancelled during an await — stop() already called
                    const msg = e instanceof Error ? e.message : String(e);
                    this._setState(AirflowState.Error);
                    this._logChannel.appendLine(`[error] ${msg}`);
                    error("Airflow start failed", e);
                    vscode.window.showErrorMessage(`Airflow start failed: ${msg}`);
                } finally {
                    cancelDisposable.dispose();
                }
            },
        );
    }

    /** Stop the running Airflow server. */
    stop(): void {
        this._stopLogTail();

        if (this._process?.isRunning()) {
            this._logChannel.appendLine("[stop] Killing Airflow process…");
            this._process.kill();
            this._logChannel.appendLine("[stop] ✓ Airflow stopped");
            log("Airflow stopped");
        }

        this._process = undefined;
        this._item = undefined;
        this._adminPassword = undefined;
        this._setState(AirflowState.Stopped);

        // Clear chat sandbox globals
        this._clearChatGlobals();
    }

    /** Restart the Airflow server. */
    async restart(): Promise<void> {
        const item = this._item;
        this.stop();
        await this.start(item);
    }

    /**
     * Open the Airflow web UI inside a VS Code editor tab (Simple Browser),
     * falling back to the external default browser if that command is
     * unavailable.
     *
     * Uses `vscode.env.asExternalUri` so the URL resolves correctly across
     * remote-SSH / Codespaces / Dev Containers (the editor host may be on a
     * different machine than the user's browser).
     */
    async openUI(): Promise<void> {
        if (this._state !== AirflowState.Running) {
            vscode.window.showWarningMessage("Airflow is not running.");
            return;
        }
        const localUri = vscode.Uri.parse(`http://localhost:${this._port}`);
        const externalUri = await vscode.env.asExternalUri(localUri);
        try {
            // Built-in Simple Browser — opens in a VS Code editor tab.
            await vscode.commands.executeCommand("simpleBrowser.show", externalUri.toString());
        } catch (e) {
            log(`[airflow] simpleBrowser.show failed, falling back to external browser: ${
                e instanceof Error ? e.message : String(e)
            }`);
            await vscode.env.openExternal(externalUri);
        }
    }

    // ── Private ──────────────────────────────────────────────

    /**
     * Promote this service to the "managing a live Airflow process" state.
     *
     * Called exclusively by `_tryAttach()` (the passive watcher path).
     * `start()` does **not** invoke this directly — it triggers
     * `_tryAttach()` after the Rust orchestrator writes the
     * `standalone-info.json` sentinel file, and adoption flows through
     * here. This keeps the extension's notion of "this process exists"
     * tied to the on-disk protocol that any external consumer (CLI,
     * tests, `kill <pid>` from a shell) also speaks.
     */
    private _hydrate(process: AirflowProcess): void {
        this._process = process;
        this._port = process.port;
        this._item = {
            id: process.itemId,
            workspaceId: process.workspaceId,
            displayName: process.itemDisplayName,
            itemType: FabricItemType.ApacheAirflowJob,
        };
        this._setState(AirflowState.Running);
        this._pushChatGlobals();
        this._monitorProcess();
    }

    /** Push Airflow connection info into the @di chat sandbox. */
    private _pushChatGlobals(): void {
        if (!this._process) return;
        setChatGlobal("airflowPort", this._process.port);
        setChatGlobal("airflowItemFolder", this._process.itemFolder);
        setChatGlobal("airflowBaseUrl", this._process.baseUrl);
        setChatGlobal("airflowVersion", this._process.airflowVersion);
    }

    /** Clear Airflow globals from the chat sandbox on stop. */
    private _clearChatGlobals(): void {
        setChatGlobal("airflowPort", undefined);
        setChatGlobal("airflowItemFolder", undefined);
        setChatGlobal("airflowBaseUrl", undefined);
        setChatGlobal("airflowVersion", undefined);
    }

    private _setState(state: AirflowState): void {
        this._state = state;
        this._updateStatusBar();
        this._onDidChangeState.fire({ state, item: this._item });
        vscode.commands.executeCommand("setContext", "fabricDataFactory.airflowRunning", state === AirflowState.Running);
        vscode.commands.executeCommand("setContext", "fabricDataFactory.airflowActiveItemId",
            state === AirflowState.Running || state === AirflowState.Starting || state === AirflowState.Installing
                ? this._item?.id ?? null
                : null,
        );
    }

    private _updateStatusBar(): void {
        const itemLabel = this._item ? ` (${this._item.displayName})` : "";
        switch (this._state) {
            case AirflowState.Stopped:
                this._statusBar.text = "$(circle-slash) Fabric Airflow";
                this._statusBar.tooltip = "Click to start Airflow";
                this._statusBar.backgroundColor = undefined;
                this._statusBar.color = undefined;
                break;
            case AirflowState.Installing:
                this._statusBar.text = `$(sync~spin) Fabric Airflow: Installing…${itemLabel}`;
                this._statusBar.tooltip = `Installing Airflow dependencies${itemLabel}`;
                this._statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
                this._statusBar.color = undefined;
                break;
            case AirflowState.Starting:
                this._statusBar.text = `$(sync~spin) Fabric Airflow: Starting…${itemLabel}`;
                this._statusBar.tooltip = `Starting Airflow server${itemLabel}`;
                this._statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
                this._statusBar.color = undefined;
                break;
            case AirflowState.Running:
                this._statusBar.text = `$(check) Fabric Airflow :${this._port}${itemLabel}`;
                this._statusBar.tooltip = `Airflow running on port ${this._port}${itemLabel}\nClick to open the web UI`;
                this._statusBar.backgroundColor = undefined;
                this._statusBar.color = new vscode.ThemeColor("testing.iconPassed");
                break;
            case AirflowState.Error:
                this._statusBar.text = `$(error) Fabric Airflow${itemLabel}`;
                this._statusBar.tooltip = `Airflow encountered an error${itemLabel}. Click to retry.`;
                this._statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
                this._statusBar.color = undefined;
                break;
        }
    }

    /**
     * Monitor the Airflow process for unexpected exit.
     *
     * Two failure modes are detected:
     *
     *   1. **Parent PID dead** — the `airflow standalone` orchestrator exited
     *      (covered by `isRunning()` which probes via `kill(pid, 0)`).
     *
     *   2. **Port 8080 unreachable while parent is still alive** — covers the
     *      case where the user (or some external tool) kills the webserver
     *      subprocess, e.g.
     *      `for p in 8080 8793 8794; do lsof -ti :$p | xargs -r kill -KILL; done`.
     *      Airflow standalone tries to respawn gunicorn workers, gives up
     *      after 120s ("No response from gunicorn master"), shuts down the
     *      webserver, but the parent + scheduler + triggerer keep running.
     *      From the user's perspective the service is dead — they can no
     *      longer reach the UI — so we treat it the same as case 1.
     *
     * We require {@link UNREACHABLE_STRIKES} consecutive failed probes
     * before declaring the port dead, so a brief blip (e.g. gunicorn worker
     * restart) doesn't trigger a false positive.
     */
    private _monitorProcess(): void {
        if (!this._process) return;

        let unreachableStrikes = 0;
        let probeInFlight = false;

        const interval = setInterval(() => {
            if (!this._process || this._state !== AirflowState.Running) {
                clearInterval(interval);
                return;
            }
            // Case 1 — parent PID dead.
            if (!this._process.isRunning()) {
                clearInterval(interval);
                // Distinguish a clean external stop from a crash by the
                // sentinel file: a graceful stop (the VS Code stop command, the
                // @di sandbox's stopStandalone()/kill(), or a CLI) removes
                // standalone-info.json; a crash leaves it behind.
                if (this._standaloneInfoExists()) {
                    this._handleUnexpectedExit("airflow standalone process exited");
                } else {
                    this._handleExternalStop("standalone-info.json removed");
                }
                return;
            }
            // Case 2 — port responsiveness. Skip if the previous probe
            // hasn't completed yet so a slow / hung connect doesn't pile up.
            if (probeInFlight) return;
            probeInFlight = true;
            // Capture the process handle at probe-start so a late callback
            // after stop()/restart() can't be mistaken for the new process.
            const probedProcess = this._process;
            void probedProcess.isPortOpen(PROBE_TIMEOUT_MS).then((alive) => {
                probeInFlight = false;
                // Guard against late callbacks after stop()/restart() —
                // either we're no longer running, or the handle has been
                // swapped out for a fresh one.
                if (this._process !== probedProcess || this._state !== AirflowState.Running) return;
                if (alive) {
                    unreachableStrikes = 0;
                    return;
                }
                unreachableStrikes++;
                if (unreachableStrikes >= UNREACHABLE_STRIKES) {
                    clearInterval(interval);
                    const seconds = (UNREACHABLE_STRIKES * MONITOR_INTERVAL_MS) / 1000;
                    this._handleUnexpectedExit(
                        `webserver port ${probedProcess.port} unreachable for ${seconds}s (parent still alive — likely webserver/gunicorn died)`,
                    );
                }
            });
        }, MONITOR_INTERVAL_MS);
    }

    /**
     * Common teardown for both "parent died" and "webserver wedged" cases.
     *
     * We invoke `_process.kill()` defensively even when the parent reports
     * dead — for the wedged-webserver case it cleans up the orphaned
     * scheduler/triggerer; for the already-dead case it's a no-op (the
     * underlying SIGTERM/SIGKILL just fails with ESRCH).
     */
    private _handleUnexpectedExit(reason: string): void {
        this._logChannel.appendLine(`[monitor] Airflow stopped unexpectedly: ${reason}`);
        log(`Airflow stopped unexpectedly: ${reason}`);
        this._stopLogTail();

        // Tear down any stragglers (scheduler/triggerer that survived the
        // partial outside-kill). Swallow errors — we're already in an
        // error path and just want to make a best-effort cleanup.
        if (this._process) {
            try {
                this._process.kill();
            } catch (e) {
                this._logChannel.appendLine(`[monitor] kill() during teardown failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        this._process = undefined;
        this._adminPassword = undefined;
        this._setState(AirflowState.Error);
        this._clearChatGlobals();

        vscode.window.showWarningMessage(
            `Airflow stopped unexpectedly (${reason}). Check the Airflow output channel.`,
            "Show Logs",
            "Restart",
        ).then((choice) => {
            if (choice === "Show Logs") this._logChannel.show();
            if (choice === "Restart") void this.restart();
        });
    }
    /**
     * Whether the `<baseFolder>/.airflow/standalone-info.json` sentinel still
     * exists. Used to tell a *clean* external stop (the owner removed the file)
     * from a *crash* (file left behind) when our managed pid goes away.
     */
    private _standaloneInfoExists(): boolean {
        try {
            return fs.existsSync(
                path.join(getBaseFolder(this._context), ".airflow", "standalone-info.json"),
            );
        } catch {
            return false;
        }
    }

    /**
     * Fast path for a clean external stop: the `standalone-info.json` sentinel
     * was deleted (the VS Code stop command, the @di sandbox's
     * `stopStandalone()` / `proc.kill()`, or an external CLI removed it).
     * Transition to `Stopped` immediately rather than waiting up to
     * `MONITOR_INTERVAL_MS` for the poll. No-op if we're not managing a
     * process, or if the pid is still alive (a transient atomic-rewrite blip,
     * not a real stop).
     */
    private _onSentinelDeleted(): void {
        if (!this._process) return;
        if (this._process.isRunning()) return;
        this._handleExternalStop("standalone-info.json removed (stopped externally)");
    }

    /**
     * Graceful teardown when the server was stopped *externally* — by the @di
     * sandbox (`stopStandalone()` / `proc.kill()`), a CLI in another shell, or
     * any other owner of the sentinel file. Mirrors the in-process `stop()`
     * command: drop our handle, clear the active item + chat globals, and
     * return to `Stopped` (grey status bar) with NO error state or warning
     * toast — distinct from `_handleUnexpectedExit` (a real crash → red Error).
     */
    private _handleExternalStop(reason: string): void {
        this._stopLogTail();
        this._logChannel.appendLine(`[monitor] Airflow stopped externally: ${reason}`);
        log(`Airflow stopped externally: ${reason}`);

        // Best-effort reap of any straggler the external stop left behind.
        if (this._process) {
            try {
                this._process.kill();
            } catch {
                // Already gone — nothing to clean up.
            }
        }

        this._process = undefined;
        this._item = undefined;
        this._adminPassword = undefined;
        this._setState(AirflowState.Stopped);
        this._clearChatGlobals();
    }
    /** Start tailing the Airflow stdout log file to the output channel. */
    private _startLogTail(logPath: string): void {
        this._stopLogTail();
        this._logOffset = 0;

        // Initial read if file exists
        this._readNewLogContent(logPath);

        // Watch for changes
        try {
            const dir = path.dirname(logPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, {recursive: true});
            }
            this._logWatcher = fs.watch(dir, (eventType, filename) => {
                if (filename === path.basename(logPath)) {
                    this._readNewLogContent(logPath);
                }
            });
        } catch {
            // Watching may fail on some platforms — not critical
        }
    }

    private _readNewLogContent(logPath: string): void {
        try {
            if (!fs.existsSync(logPath)) return;
            const content = fs.readFileSync(logPath, "utf-8");
            if (content.length > this._logOffset) {
                const newContent = content.slice(this._logOffset);
                this._logOffset = content.length;
                // Write each line to the output channel
                for (const line of newContent.split("\n")) {
                    if (line.trim()) {
                        this._logChannel.appendLine(line);
                    }
                }
            }
        } catch {
            // File may be locked — retry on next change
        }
    }

    private _stopLogTail(): void {
        if (this._logWatcher) {
            this._logWatcher.close();
            this._logWatcher = undefined;
        }
        this._logOffset = 0;
    }

    // ── Passive attach (cross-process IPC via standalone-info.json) ──

    /**
     * Watch `<baseFolder>/.airflow/standalone-info.json` and adopt any
     * standalone Airflow instance started outside this extension (for
     * example by `di airflow start` in another shell).
     *
     * The file is the protocol: it's written on start and removed on stop
     * by whichever process owns the server. We `_tryAttach` on:
     *
     *   • initial probe at construction time (in case the CLI started
     *     before VS Code did),
     *   • `onDidCreate` when a fresh file appears,
     *   • `onDidChange` when an existing file is rewritten (re-start).
     *
     * We also react to `onDidDelete`: when the sentinel is removed the owner is
     * stopping the server cleanly (the VS Code stop command, the @di sandbox's
     * `stopStandalone()`, or an external CLI), so we transition to `Stopped`
     * rather than letting the periodic `_monitorProcess()` poll misread it as a
     * crash. That poll remains the backstop if the delete event is missed.
     */
    private _startAttachWatcher(baseFolder: string): void {
        if (this._attachWatcher) return;

        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(baseFolder, ".airflow/standalone-info.json"),
        );
        watcher.onDidCreate(() => { void this._tryAttach(); });
        watcher.onDidChange(() => { void this._tryAttach(); });
        // onDidDelete: the sentinel was removed → someone stopped the server
        // cleanly (VS Code stop, @di sandbox stopStandalone(), external CLI).
        // Tear down to Stopped instead of letting the poll flag a crash.
        watcher.onDidDelete(() => { this._onSentinelDeleted(); });

        this._attachWatcher = watcher;
        this._disposables.push(watcher);

        // Initial probe: if a process is already running we want to see it
        // immediately rather than wait for the next file event.
        void this._tryAttach();
    }

    /**
     * Attempt to adopt the standalone Airflow process described by
     * `<baseFolder>/.airflow/standalone-info.json`.
     *
     * No-op if we're already managing a process or another attach is
     * in flight.
     */
    private async _tryAttach(): Promise<void> {
        // Already managing a process (whether we started it or already
        // attached to it) → nothing to do.
        if (this._process) return;
        if (this._attaching) return;

        const diContext = requestDIContext();
        if (!diContext?.airflowRunner) return;

        this._attaching = true;
        try {
            const adopted = diContext.airflowRunner.tryAttach();
            if (!adopted) return; // file missing or pid dead

            this._runner = diContext.airflowRunner;

            this._logChannel.appendLine("=== Airflow Standalone Server (attached) ===");
            this._logChannel.appendLine(
                `[attach] ✓ Adopted externally-started process (pid=${adopted.pid}, port=${adopted.port}, version=${adopted.airflowVersion})`,
            );
            this._logChannel.appendLine(`[attach] Item: ${adopted.itemDisplayName} (${adopted.itemId})`);

            // Resume log tailing so the user sees scheduler output.
            const baseFolder = getBaseFolder(this._context);
            const logPath = path.join(baseFolder, ".airflow", "standalone-stdout.log");
            this._startLogTail(logPath);

            // Hydrate via the same shared helper that `start()` uses.
            this._hydrate(adopted);

            log(`Airflow attached on port ${this._port} (pid=${adopted.pid})`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._logChannel.appendLine(`[attach] ⚠ Failed to adopt running process: ${msg}`);
            error("Airflow attach failed", e);
        } finally {
            this._attaching = false;
        }
    }
}
