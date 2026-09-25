import * as vscode from "vscode";
import {
    WorkspacesTreeProvider,
} from "@/views/WorkspacesTreeProvider";
import {FabricFileDecorationProvider} from "@/views/FabricFileDecorationProvider";
import {FabricItemStatusBar} from "@/views/FabricItemStatusBar";
import {FabricNotebookController} from "@/notebook/FabricNotebookController";
import {AirflowService} from "@/services/AirflowService";
import {FabricUriHandler} from "@/handlers/uriHandler";
import {getDIContext, requestDIContext, requireDIContext, classifyContextError, type ContextErrorKind} from "@/services/di-context";
import {registerChatParticipant, setChatGlobal} from "@/chats/chatParticipant";
import {getFabricEnvironment} from "data-integration";
import * as log from "@/utils/channel_log";
import * as sdkLog from "@/utils/sdk_log";
import * as bootstrap from "@/utils/bootstrap_log";
import {probeAzVersion} from "@/utils/az_probe";
import {registerSetupDoctor} from "@/services/setup_doctor";
import {assertDefined} from "@/utils/assert.utils";

/** Must match `contributes.walkthroughs[].id` in package.json. */
const SETUP_WALKTHROUGH_ID = "fabricDataFactorySetup";

export async function activate(
    context: vscode.ExtensionContext
): Promise<void> {
    // ── Bootstrap logger ─────────────────────────────────────
    // Must come first: the SDK trace client lives *inside* the DI context, so
    // any addon-load / auth / base-folder failure below happens before that
    // sink exists. This durable file sink (<globalStorage>/bootstrap.log) is
    // the only place such first-run failures can be captured.
    //
    // `context.globalStorageUri.fsPath` resolves to the extension's private
    // per-user global-storage dir (id = "<publisher>.<name>" =
    // "microsoft.fabric-data-factory"), so the log lands at:
    //   Linux    ~/.config/Code/User/globalStorage/microsoft.fabric-data-factory/bootstrap.log
    //   Windows  %APPDATA%\Code\User\globalStorage\microsoft.fabric-data-factory\bootstrap.log
    //   macOS    ~/Library/Application Support/Code/User/globalStorage/microsoft.fabric-data-factory/bootstrap.log
    //   Remote   ~/.vscode-server/data/User/globalStorage/microsoft.fabric-data-factory/bootstrap.log
    // The "Remote" path applies to *all* server-backed setups (Remote-SSH, WSL,
    // Dev Containers, Codespaces) — there the desktop dirs above don't exist, so
    // the log is under ~/.vscode-server (…-insiders for Insiders). Insiders/OSS
    // desktop builds swap "Code" for "Code - Insiders"/"VSCodium".
    bootstrap.init(context.globalStorageUri.fsPath);
    bootstrap.info("activation.start", {
        extensionVersion: context.extension.packageJSON.version,
        vscodeVersion: vscode.version,
        platform: process.platform,
        arch: process.arch,
    });

    // ── az CLI probe ─────────────────────────────────────────
    // Fire-and-forget: reproduce the addon's `az` lookup once and record what
    // the child shell actually sees (version / flavor, or "not found"). Runs
    // concurrently with addon init and works even if the addon fails to load,
    // so a broken first-run still leaves an `az.version` breadcrumb.
    probeAzVersion();

    // ── Output channel ───────────────────────────────────────
    context.subscriptions.push(log.getChannel());

    // ── Setup Doctor command ─────────────────────────────────
    // Registered unconditionally (before the addon-gated block below) so it's
    // available even when the addon failed to load — that's exactly when a
    // stuck first-run user needs it (unlike Export Diagnostic, which needs the
    // addon).
    context.subscriptions.push(registerSetupDoctor(context));

    // Same reasoning as Setup Doctor: the guided setup path has to survive the
    // failure it exists to walk the user out of.
    context.subscriptions.push(
        vscode.commands.registerCommand("fabricDataFactory.openSetupWalkthrough", () =>
            vscode.commands.executeCommand(
                "workbench.action.openWalkthrough",
                `${context.extension.id}#${SETUP_WALKTHROUGH_ID}`,
                false,
            ),
        ),
    );

    // ── Native addon context ─────────────────────────────────
    // Retained past the catch so the fallback registration below can tell the
    // user *why* the addon-gated commands are unavailable.
    let contextError: ContextErrorKind | undefined;
    try {
        let diContext = getDIContext(context);

        assertDefined(diContext, "Failed to initialize data-integration addon context #1");
        diContext = requireDIContext();
        assertDefined(diContext, "Failed to initialize data-integration addon context #2");
        // Suggest users to login if needed.
        requestDIContext()
        bootstrap.info("activation.result", { result: "success" });
        log.log("Data-integration addon loaded successfully.");
    } catch (err) {
        // This is the chicken-and-egg failure window: log.error() forwards to
        // the SDK client, which doesn't exist yet if the context failed to
        // load — so the bootstrap sink is what actually captures this.
        // `activation.result` is the single terminal record of how activation
        // went: on failure it carries the classified kind (az-missing /
        // not-signed-in / addon-load-failed / other) *and* the raw error, so
        // field reports are triageable without a repro. (The throw-site raw
        // error is also recorded by di-context's `context.create` breadcrumb;
        // base-folder mis-rooting by the `context.init` breadcrumb.)
        const reason = classifyContextError(err);
        contextError = reason;
        bootstrap.error("activation.result", err, { result: reason });
        log.error("Failed to initialise data-integration addon", err);
        log.show();
    }

    const diContext = requestDIContext();

    // Drives the `when` clauses on the view-title buttons and the setup-failed
    // welcome view. Deliberately failure-polarity: an unset key is falsy, so the
    // normal-startup window before this resolves reads as "not failed" and the
    // toolbar doesn't flash away and back.
    void vscode.commands.executeCommand(
        "setContext",
        "fabricDataFactory.setupFailed",
        !diContext,
    );

    if (diContext) {
        assertDefined(diContext, "Failed to initialize data-integration addon context #3");
        const treeProvider = new WorkspacesTreeProvider(context);

        // ── File decorations (show item names on GUID folders) ───
        const decorationProvider = new FabricFileDecorationProvider(context);
        context.subscriptions.push(
            vscode.window.registerFileDecorationProvider(decorationProvider),
        );

        // ── Status bar (show item name for open files) ───────────
        context.subscriptions.push(new FabricItemStatusBar(context));

        // ── Notebook controller ──────────────────────────────────
        context.subscriptions.push(new FabricNotebookController(context));

        // ── @di chat participant ─────────────────────────────────
        registerChatParticipant(context, log.getChannel());

        // ── Inject Fabric environment into chat globals ──────────
        // Surface the active environment (daily/dxt/msit/ppe/prod) so the
        // chat participant tells the LLM which hostnames to target, instead
        // of letting it default to prod URLs against a non-prod tenant.
        try {
            const env = getFabricEnvironment();
            setChatGlobal("fabricEnvName", env.name);
            setChatGlobal("fabricApiHost", env.fabricApiHost);
            setChatGlobal("fabricPowerbiApiHost", env.powerbiApiHost);
            setChatGlobal("fabricOnelakeDfsHost", env.onelakeDfsHost);
            setChatGlobal("fabricPortalHost", env.portalHost);
            // Upgrade the portal host to the tenant-aware value (applies the
            // MSIT override for Microsoft-corp accounts on prod). Best-effort:
            // if the auth token isn't ready yet, the configured base remains.
            diContext.fabricClient
                .portalHost()
                .then((host) => setChatGlobal("fabricPortalHost", host))
                .catch((e) =>
                    log.log(`[di-chat] tenant-aware portalHost resolve failed: ${e}`),
                );
        } catch (e) {
            log.error("Failed to inject Fabric environment into chat globals", e);
        }

        // ── Airflow service (singleton per window) ───────────────
        const airflowService = new AirflowService(context);
        context.subscriptions.push(airflowService);
        treeProvider.connectAirflowService(airflowService);

        // ── Diagnostic package export command ────────────────────
        // Only registered once we know the DI context has booted —
        // the underlying NAPI call needs the addon's tracing
        // subscriber installed before it can locate the log directory.
        context.subscriptions.push(
            vscode.commands.registerCommand(
                "fabricDataFactory.exportDiagnosticPackage",
                async () => {
                    try {
                        const dipkgPath = sdkLog.exportDiagnosticPackage();
                        if (!dipkgPath) {
                            vscode.window.showWarningMessage(
                                "Data-integration addon isn't ready yet — try again in a moment.",
                            );
                            return;
                        }
                        const choice = await vscode.window.showInformationMessage(
                            `Diagnostic package written to ${dipkgPath}`,
                            "Reveal in Explorer",
                            "Copy Path",
                        );
                        if (choice === "Reveal in Explorer") {
                            await vscode.commands.executeCommand(
                                "revealFileInOS",
                                vscode.Uri.file(dipkgPath),
                            );
                        } else if (choice === "Copy Path") {
                            await vscode.env.clipboard.writeText(dipkgPath);
                        }
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        log.error("Failed to export diagnostic package", e);
                        vscode.window.showErrorMessage(
                            `Failed to export diagnostic package: ${msg}`,
                        );
                    }
                },
            ),
        );

        // ── URI handler (deep-link) ──────────────────────────────
        context.subscriptions.push(
            vscode.window.registerUriHandler(new FabricUriHandler(treeProvider)),
        );
    } else {
        await registerUnavailableCommandFallbacks(context, contextError ?? "other");
    }
}

/**
 * Every `contributes.commands` entry whose handler lives behind the addon-gated
 * block above is left unregistered when the context fails to boot, so any menu
 * item, welcome-view link or palette entry that reaches one raises a bare
 * `command '<id>' not found`. Claim the leftovers with a handler that explains
 * the real problem instead.
 *
 * Derived from the manifest rather than a hand-kept list so a command added
 * later can't silently regress, and diffed against the live registry so the
 * handful already registered unconditionally (Setup Doctor) keep theirs.
 */
async function registerUnavailableCommandFallbacks(
    context: vscode.ExtensionContext,
    reason: ContextErrorKind,
): Promise<void> {
    const contributed: unknown = context.extension.packageJSON?.contributes?.commands;
    if (!Array.isArray(contributed)) {
        return;
    }
    const registered = new Set(await vscode.commands.getCommands(true));
    const claimed: string[] = [];
    for (const entry of contributed) {
        const id = (entry as {command?: unknown}).command;
        if (typeof id !== "string" || registered.has(id)) {
            continue;
        }
        context.subscriptions.push(
            vscode.commands.registerCommand(id, () => void promptSetupIncomplete(id, reason)),
        );
        claimed.push(id);
    }
    bootstrap.info("activation.fallback_commands", {reason, count: claimed.length});
    log.log(
        `Addon unavailable (${reason}) — ${claimed.length} command(s) registered as unavailable.`,
    );
}

/**
 * How to recover from each classified failure. A window reload only re-runs
 * `activate` — the extension host is forked from the main VS Code process and
 * keeps its launch-time env, so anything PATH-related needs a full restart.
 */
interface SetupRemedy {
    /** Omitted when the failure wasn't classified — don't assert an unproven cause. */
    cause?: string;
    remedy: string;
    canReload: boolean;
    /**
     * The walkthrough only covers install-`az` / `az login`, so failures it
     * can't address are sent to Setup Doctor instead.
     */
    guide: "walkthrough" | "doctor";
}

const SETUP_REMEDY: Record<ContextErrorKind, SetupRemedy> = {
    "az-missing": {
        cause: "The Azure CLI (`az`) wasn't found on PATH.",
        remedy: "Install it, then restart VS Code — a window reload keeps the stale PATH.",
        canReload: false,
        guide: "walkthrough",
    },
    "not-signed-in": {
        cause: "You're not signed in.",
        remedy: "Run `az login`, then reload the window.",
        canReload: true,
        guide: "walkthrough",
    },
    "addon-load-failed": {
        cause: "Its native addon failed to load.",
        remedy: "Reinstall a build that matches this platform, then restart VS Code.",
        canReload: false,
        guide: "doctor",
    },
    other: {
        remedy: "Check the log or run Setup Doctor for the underlying error.",
        canReload: true,
        guide: "doctor",
    },
};

/** Guard so a flurry of clicks can't stack duplicate notifications. */
let setupPromptShowing = false;

async function promptSetupIncomplete(
    commandId: string,
    reason: ContextErrorKind,
): Promise<void> {
    if (setupPromptShowing) {
        return;
    }
    setupPromptShowing = true;
    try {
        const {cause, remedy, canReload, guide} = SETUP_REMEDY[reason];
        const guideLabel = guide === "walkthrough" ? "Open Setup Walkthrough" : "Run Setup Doctor";
        const actions = [guideLabel, "Show Log"];
        if (canReload) {
            actions.push("Reload Window");
        } else if (reason === "az-missing") {
            actions.push("Install Azure CLI");
        }
        const choice = await vscode.window.showWarningMessage(
            `Fabric Data Factory didn't finish starting, so "${commandId}" isn't available. ` +
            `${cause ? `${cause} ` : ""}${remedy}`,
            ...actions,
        );
        if (choice === "Open Setup Walkthrough") {
            await vscode.commands.executeCommand("fabricDataFactory.openSetupWalkthrough");
        } else if (choice === "Run Setup Doctor") {
            await vscode.commands.executeCommand("fabricDataFactory.runSetupDoctor");
        } else if (choice === "Show Log") {
            log.show();
        } else if (choice === "Reload Window") {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
        } else if (choice === "Install Azure CLI") {
            await vscode.env.openExternal(
                vscode.Uri.parse("https://learn.microsoft.com/cli/azure/install-azure-cli"),
            );
        }
    } finally {
        setupPromptShowing = false;
    }
}
