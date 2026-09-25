/**
 * Wraps the native `data-integration` addon's `createContext()` so the rest
 * of the extension can consume it without worrying about load failures or
 * missing auth.
 *
 * Usage:
 * ```ts
 * import { getDIContext } from "./context";
 * const ctx = getDIContext(context, authService);
 * const workspaces = await ctx.fabricClient.listWorkspaces();
 * ```
 */

import * as vscode from "vscode";
import * as log from "@/utils/channel_log";
import * as bootstrap from "@/utils/bootstrap_log";
import {createContext} from "data-integration";
import {resolveBaseFolder} from "@/utils/folders";

// ── Types ───────────────────────────────────────────────────────────────────

export type DIContext = ReturnType<typeof createContext>;

// ── Singleton state ─────────────────────────────────────────────────────────

let cachedContext: DIContext | undefined;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get or create the shared DI context.
 *
 * The context is created lazily on first call and cached for the extension
 * lifetime. Auth callbacks bridge VS Code's authentication provider to the
 * native addon.
 *
 * If the addon fails to load (e.g. binary missing), or `createContext`
 * throws (e.g. no Azure CLI), an error notification is shown and the
 * error is re-thrown so callers can handle it.
 */
export function getDIContext(
    extensionContext: vscode.ExtensionContext,
    authService?: {
        getAccessToken: () => Promise<string | null>,
        getOneLakeToken: () => Promise<string | null>,
    },
): DIContext {
    if (cachedContext) {
        return cachedContext;
    }

    const {folder: baseFolder, source: baseFolderSource} = resolveBaseFolder(extensionContext);

    // Pre-context breadcrumb: which base folder we booted against and how it
    // was resolved (a `globalStorage` source means no workspace/setting — the
    // silent mis-rooting case), plus whether the VS Code auth bridge was wired
    // or we're relying solely on ambient `az`. Routed through the bootstrap
    // sink because the SDK trace client doesn't exist until createContext below.
    bootstrap.info("context.init", {
        baseFolder,
        baseFolderSource,
        authBridge: authService ? "wired" : "ambient-az",
    });
    log.log(`Creating DI context with base folder: ${baseFolder} (source: ${baseFolderSource})`);

    if (baseFolderSource === "globalStorage") {
        // S5: neither a `projectFolder` setting nor an open workspace supplied a
        // path, so the addon is rooted at global storage — easy to mistake for
        // "nothing happened". Surface it once (this block only runs on the
        // context-creating first call; later calls return the cache above).
        void vscode.window.showInformationMessage(
            "No project folder is open — Fabric Data Factory is using global storage as its base folder. " +
            "Open a folder or set `fabricDataFactory.projectFolder` to work against your project.",
        );
    }

    // Auth bridge (S6): callers may pass a VS Code auth service to bridge the
    // editor's sign-in to the addon. Today none is wired — the extension relies
    // entirely on ambient `az` (see `AzureAuthService` in the core crate), so
    // `authService` is undefined and `auth` stays undefined here. The
    // `context.init` breadcrumb above records which path was taken so we can
    // revisit with field data before adding a VS Code auth provider.
    const auth = authService
        ? {
            getAccessToken: async () =>
                (await authService.getAccessToken()) ?? null,
            getOneLakeToken: async () =>
                (await authService.getOneLakeToken()) ?? null,
        }
        : undefined;

    try {
        cachedContext = createContext({
            baseFolder,
            auth,
        }) as DIContext;
        return cachedContext;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Pre-context sink: createContext failing (addon .node load failure,
        // no `az`, bad base folder) happens before the SDK trace client exists,
        // so this is the only durable record of it.
        bootstrap.error("context.create", err);
        handleContextError(msg);
        throw err;
    }
}

/**
 * Try to get the DI context if it has been created, without creating it.
 * Returns `undefined` if not yet initialised.
 */
export function tryGetDIContext(): DIContext | undefined {
    return cachedContext;
}

/**
 * Get the DI context if available, prompting the user to sign in if not.
 *
 * Unlike `requireDIContext()` which throws, this returns `undefined`
 * and shows an actionable notification guiding the user to install
 * Azure CLI or run `az login`.
 */
export function requestDIContext(): DIContext | undefined {
    if (!cachedContext) {
        // No context at all: the addon didn't load, `az` wasn't found, or the
        // user wasn't signed in when it was created. Exactly one prompt — the
        // old second guard (`!cachedContext?.auth.getAccessToken()`) *also*
        // fired here, because `!undefined` is `true` when there's no context,
        // stacking a duplicate toast.
        void promptNoContext();
        return undefined;
    }

    // Context exists — verify a token can actually be acquired. getAccessToken()
    // is async (it shells out to `az`), so it must be awaited; the old code
    // tested the Promise itself (`!Promise` is always `false`) and so never
    // prompted even when sign-in was genuinely missing. Fire-and-forget so
    // callers keep the synchronous return value.
    void verifySignedIn(cachedContext);
    return cachedContext;
}

/** Guard so we never stack two auth prompts on top of each other. */
let authPromptShowing = false;

/** Prompt shown when no DI context exists (install `az` / sign in). */
async function promptNoContext(): Promise<void> {
    if (authPromptShowing) {
        return;
    }
    authPromptShowing = true;
    try {
        const choice = await vscode.window.showWarningMessage(
            "Azure CLI is required but not found or not signed in. " +
            "Install Azure CLI and run `az login`, or sign in via the Fabric Data Factory panel.",
            "Install Azure CLI",
            "Open Terminal",
        );
        if (choice === "Install Azure CLI") {
            void vscode.env.openExternal(
                vscode.Uri.parse("https://learn.microsoft.com/cli/azure/install-azure-cli"),
            );
        } else if (choice === "Open Terminal") {
            const terminal = vscode.window.createTerminal("Azure CLI");
            terminal.show();
            terminal.sendText("az login");
        }
    } finally {
        authPromptShowing = false;
    }
}

/**
 * Best-effort check that the existing context can actually mint a token. If the
 * token is missing (`null`) or acquisition throws (e.g. an expired `az login`),
 * prompt the user to sign in. Never throws; skips if a prompt is already up.
 */
async function verifySignedIn(ctx: DIContext): Promise<void> {
    let signedIn = false;
    try {
        signedIn = Boolean(await ctx.auth.getAccessToken());
    } catch {
        signedIn = false;
    }
    if (signedIn || authPromptShowing) {
        return;
    }
    authPromptShowing = true;
    try {
        const choice = await vscode.window.showWarningMessage(
            "Not signed in to Azure. Run `az login`, or sign in via the Fabric Data Factory panel.",
            "Run `az login`",
        );
        if (choice === "Run `az login`") {
            const terminal = vscode.window.createTerminal("Azure CLI");
            terminal.show();
            terminal.sendText("az login");
        }
    } finally {
        authPromptShowing = false;
    }
}


/**
 * Get the DI context, asserting it has been initialised.
 * Throws if the context was never created (e.g. addon failed to load).
 */
export function requireDIContext(): DIContext {
    if (!cachedContext) {
        throw new Error(
            "Data Integration context is not available. " +
            "The native addon may have failed to load.",
        );
    }
    return cachedContext;
}

/**
 * Reset the cached context. Call this on sign-out so a fresh context
 * is created on next sign-in with new auth callbacks.
 */
export function resetDIContext(): void {
    cachedContext = undefined;
}

// ── Error handling ──────────────────────────────────────────────────────────

/** Coarse classification of a context-creation / addon-load failure. */
export type ContextErrorKind =
    | "az-missing"
    | "not-signed-in"
    | "addon-load-failed"
    | "other";

/**
 * Classify a context-creation / addon-load error into a coarse kind for
 * telemetry breadcrumbs. Mirrors the branches in {@link handleContextError}
 * but distinguishes "az not found on PATH" from "not signed in" (which the
 * user-facing toast still lumps together).
 *
 * `az-missing` requires **Azure-CLI-specific** text alongside a generic
 * "not found" / "no such file" pattern, so a plain filesystem error (e.g. a
 * missing base folder / `ENOENT` on `mkdir`) isn't misreported as "Azure CLI
 * not found" — it falls through to `other` instead.
 */
export function classifyContextError(err: unknown): ContextErrorKind {
    const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (m.includes(".node") || m.includes("native addon")) {
        return "addon-load-failed";
    }

    const mentionsAzCli =
        /\baz(\.exe)?\b/.test(m) || m.includes("azure cli") || m.includes("azure-cli");
    if (
        mentionsAzCli &&
        (m.includes("not found") ||
            m.includes("not recognized") ||
            m.includes("no such file") ||
            m.includes("enoent"))
    ) {
        return "az-missing";
    }

    if (
        m.includes("az login") ||
        m.includes("not signed in") ||
        m.includes("not logged in") ||
        m.includes("please run")
    ) {
        return "not-signed-in";
    }
    return "other";
}

function handleContextError(message: string): void {
    switch (classifyContextError(message)) {
        case "addon-load-failed":
            void vscode.window
                .showErrorMessage(
                    `Data Integration addon failed to load: ${message}. ` +
                    "This may mean the extension is not compatible with your platform.",
                    RUN_DOCTOR_LABEL,
                )
                .then(onContextErrorChoice);
            return;

        case "az-missing":
            void vscode.window
                .showErrorMessage(
                    "Azure CLI (`az`) was not found on the extension's PATH. " +
                    "Install Azure CLI, then restart VS Code so it inherits your updated PATH.",
                    "Install Azure CLI",
                    RUN_DOCTOR_LABEL,
                    COPY_DIAG_LABEL,
                )
                .then(onContextErrorChoice);
            return;

        case "not-signed-in":
            void vscode.window
                .showErrorMessage(
                    "Not signed in to Azure. Run `az login`, " +
                    "or sign in via the Fabric Data Factory panel.",
                    "Run `az login`",
                    RUN_DOCTOR_LABEL,
                    COPY_DIAG_LABEL,
                )
                .then(onContextErrorChoice);
            return;

        default:
            void vscode.window
                .showErrorMessage(
                    `Failed to initialise Data Integration context: ${message}`,
                    RUN_DOCTOR_LABEL,
                    COPY_DIAG_LABEL,
                )
                .then(onContextErrorChoice);
    }
}

/**
 * The `az` command we ask a stuck user to run and share the output of.
 *
 * It projects away the `accessToken` field with `--query` so the user is never
 * asked to paste a live bearer token — only the non-secret triage fields
 * (expiry, subscription, tenant, token type) are shown, which still proves the
 * Fabric-scope token could be acquired. Double-quoted so the JMESPath survives
 * copy-paste into bash/zsh/PowerShell **and** cmd.exe (single quotes break on
 * cmd; unquoted braces brace-expand in bash).
 */
const AZ_DIAG_COMMAND =
    "az account get-access-token --scope https://api.fabric.microsoft.com/.default " +
    "--query \"{expiresOn:expiresOn,subscription:subscription,tenant:tenant,tokenType:tokenType}\" -o json";
/** Button label reused across the context-error toasts. */
const COPY_DIAG_LABEL = "Copy diagnostic command";
/** Button that launches the addon-independent Setup Doctor (self-serve triage). */
const RUN_DOCTOR_LABEL = "Run Setup Doctor";
const INSTALL_AZ_URL = "https://learn.microsoft.com/cli/azure/install-azure-cli";

/** Shared handler for the buttons on the context-error toasts. */
function onContextErrorChoice(choice: string | undefined): void {
    if (choice === "Install Azure CLI") {
        void vscode.env.openExternal(vscode.Uri.parse(INSTALL_AZ_URL));
    } else if (choice === "Run `az login`") {
        const terminal = vscode.window.createTerminal("Azure CLI");
        terminal.show();
        terminal.sendText("az login");
    } else if (choice === RUN_DOCTOR_LABEL) {
        void vscode.commands.executeCommand("fabricDataFactory.runSetupDoctor");
    } else if (choice === COPY_DIAG_LABEL) {
        void vscode.env.clipboard.writeText(AZ_DIAG_COMMAND);
        void vscode.window.showInformationMessage(
            "Diagnostic command copied (excludes the access token). " +
            "Run it in a terminal and share the output.",
        );
    }
}

