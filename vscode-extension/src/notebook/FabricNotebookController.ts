import * as vscode from "vscode";
import * as path from "path";
import { createSandbox, type Sandbox } from "@/services/vm/sandbox";
import type { InferredGlobal } from "@/services/vm/common";
import { log, error } from "@/utils/channel_log";
import { getBaseFolder } from "@/utils/folders";
import { getSettings } from "@/utils/settings";
import type { FabricItem } from "data-integration";
import { FabricNotebookSerializer } from "./FabricNotebookSerializer";
import { NotebookLanguageProvider } from "@/language-provider/index";
import {requestDIContext} from "@/services/di-context";

/** Notebook type identifier — matches the `notebookSerializer` contribution. */
export const NOTEBOOK_TYPE = "fabric-notebook";

/**
 * Notebook controller that executes TypeScript code cells in a sandboxed
 * VM backed by the `data-integration` addon.
 *
 * Each notebook gets its own `Sandbox` instance with the DI context
 * pre-injected. Optionally, a `FabricItem` (e.g. a Lakehouse) can be
 * set as the `item` global so cells can use it directly.
 *
 * ```ts
 * // In a notebook cell:
 * const tables = await onelakeClient.listTables(item);
 * console.log(tables);
 * ```
 */
export class FabricNotebookController implements vscode.Disposable {
    readonly controllerId = "fabric-notebook-controller";
    readonly label = "Fabric Data Factory";
    readonly supportedLanguages = ["typescript", "javascript"];

    private readonly _controller: vscode.NotebookController;
    private readonly _sandboxes = new Map<string, Sandbox>();
    /**
     * In-flight (or resolved) `autoInjectGlobals` promise per notebook URI.
     *
     * Kicked off eagerly on `onDidOpenNotebookDocument` and awaited from
     * `executeCell` so that a user who hits *Run* immediately after the
     * notebook opens still waits for `fabricItem` / `itemFolder` to land
     * in the sandbox. Invalidated on kernel restart / interrupt.
     */
    private readonly _pendingInjects = new Map<string, Promise<void>>();
    /** Why `fabricItem` is missing for a notebook, when injection degraded. */
    private readonly _injectFailures = new Map<string, string>();
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _extensionContext: vscode.ExtensionContext;
    private readonly _languageProvider: NotebookLanguageProvider;

    constructor(context: vscode.ExtensionContext) {
        this._extensionContext = context;
        this._languageProvider = new NotebookLanguageProvider(context.extensionUri, NOTEBOOK_TYPE);
        this._controller = vscode.notebooks.createNotebookController(
            this.controllerId,
            NOTEBOOK_TYPE,
            this.label,
        );
        this._controller.supportedLanguages = this.supportedLanguages;
        this._controller.supportsExecutionOrder = true;
        this._controller.executeHandler = (cells, notebook, controller) =>
            this.executeAll(cells, notebook, controller);
        this._controller.interruptHandler = (notebook) =>
            this.interruptKernel(notebook);

        this._disposables.push(
            this._controller,
            vscode.workspace.registerNotebookSerializer(
                NOTEBOOK_TYPE,
                new FabricNotebookSerializer(),
            ),
            this._languageProvider,
            vscode.commands.registerCommand(
                "fabricDataFactory.restartKernel",
                () => this.restartKernel(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.setNotebookGlobalVariable",
                (notebookUri: string, name: string, value: unknown) => {
                    const sandbox = this.getOrCreateSandbox(notebookUri);
                    sandbox.setGlobal(name, value);
                    log(`Notebook ${notebookUri}: set global ${name}`);
                },
            ),
            // Auto-inject globals when a .fabricnb under .workspaces/ is opened
            vscode.workspace.onDidOpenNotebookDocument( async (notebook) => {
                if (notebook.notebookType !== NOTEBOOK_TYPE) return;
                await this.ensureGlobalsInjected(notebook);
            }),
        );
    }

    dispose(): void {
        for (const sandbox of this._sandboxes.values()) {
            sandbox.dispose();
        }
        this._sandboxes.clear();
        this._pendingInjects.clear();
        for (const d of this._disposables) {
            d.dispose();
        }
    }

    /**
     * Restart the kernel (sandbox) for the active notebook.
     * Disposes the current sandbox so a fresh one is created on the next execution.
     */
    restartKernel(): void {
        const notebook = vscode.window.activeNotebookEditor?.notebook;
        if (!notebook || notebook.notebookType !== NOTEBOOK_TYPE) {
            return;
        }
        const uri = notebook.uri.toString();
        const sandbox = this._sandboxes.get(uri);
        if (sandbox) {
            sandbox.dispose();
            this._sandboxes.delete(uri);
            this._pendingInjects.delete(uri);
            this._languageProvider.setDynamicGlobals([]);
            log(`Notebook ${uri}: kernel restarted`);
        }
        // Re-inject fabricItem/itemFolder into the fresh sandbox
        void this.ensureGlobalsInjected(notebook);
    }

    /**
     * Set the Fabric item context for a notebook. Call this when opening
     * a notebook from a tree item (e.g. Lakehouse).
     */
    setItemForNotebook(notebookUri: string, item: FabricItem): void {
        const sandbox = this.getOrCreateSandbox(notebookUri);
        sandbox.setGlobal("fabricItem", item);
        log(`Notebook ${notebookUri}: set fabricItem = ${item.displayName} (${item.itemType})`);
    }

    // ── Private ─────────────────────────────────────────────

    /**
     * Auto-inject `fabricItem` and `itemFolder` globals when a notebook
     * under `.workspaces/<wsId>/<itemId>/` is opened.
     *
     * Path pattern: `<baseFolder>/.fabricnb/<workspaceId>/<itemId>/<name>.fabricnb`
     */
    private async autoInjectGlobals(notebook: vscode.NotebookDocument): Promise<void> {
        const fsPath = notebook.uri.fsPath;
        // Match .../.workspaces/<wsId>/<itemId>/...
        const match = fsPath.match(/[/\\]\.fabricnb[/\\]([^/\\]+)[/\\]([^/\\]+)[/\\]/);
        if (!match) return;

        const workspaceId = match[1];
        const itemId = match[2];
        const itemFolder = path.dirname(fsPath);
        const notebookUri = notebook.uri.toString();

        const sandbox = this.getOrCreateSandbox(notebookUri);
        sandbox.setGlobal("itemFolder", itemFolder);

        const maybeDiContext = requestDIContext();

        if (maybeDiContext?.fabricClient){
            const fabricClient = maybeDiContext.fabricClient;
            try {
                const fabricItem = await fabricClient.getItem(workspaceId, itemId);
                sandbox.setGlobal("fabricItem", fabricItem);
                this._injectFailures.delete(notebookUri);
                log(`Auto-injected globals for ${notebookUri}: fabricItem=${itemId}, itemFolder=${itemFolder}`);
            } catch (e) {
                // The item can be gone (404) or inaccessible (401) while the
                // notebook folder still exists. Degrade instead of aborting:
                // `itemFolder` is already injected and most cells only need it.
                const detail = e instanceof Error ? e.message : String(e);
                this._injectFailures.set(
                    notebookUri,
                    `\`fabricItem\` was not injected: getItem(${workspaceId}, ${itemId}) failed — ` +
                    `${detail.split("\n")[0]}\nThe item may have been deleted or you may not have access. ` +
                    "`itemFolder` is still available.",
                );
                error(`autoInjectGlobals: getItem failed for workspace=${workspaceId} item=${itemId}`, e);
            }
        }

        log(`Auto-injected globals returned for ${notebookUri}: itemFolder=${itemFolder}, fabricItem=${this._injectFailures.has(notebookUri) ? "unavailable" : itemId}`);
    }

    /**
     * Ensure `autoInjectGlobals` has been kicked off for `notebook` and
     * return its (possibly already-resolved) promise. The result is cached
     * per notebook URI so that:
     *
     *  - the open-document handler and the first `executeCell` share a
     *    single `fabricClient.getItem` round-trip, and
     *  - executing a cell **before** the open-time inject has finished
     *    still waits (fixing the original race).
     *
     * The cache entry is invalidated by `restartKernel` / `interruptKernel`
     * so the next execution re-injects into the fresh sandbox.
     */
    private ensureGlobalsInjected(notebook: vscode.NotebookDocument): Promise<void> {
        const uri = notebook.uri.toString();
        let pending = this._pendingInjects.get(uri);
        if (!pending) {
            pending = this.autoInjectGlobals(notebook).catch((e) => {
                // Keep the error visible but don't blow up the caller —
                // executeCell will still proceed (`fabricItem` may legitimately
                // be missing for non-workspace notebooks).
                error(`autoInjectGlobals failed for ${uri}`, e);
                this._pendingInjects.delete(uri);
            });
            this._pendingInjects.set(uri, pending);
        }
        return pending;
    }

    private interruptKernel(notebook: vscode.NotebookDocument): void {
        const uri = notebook.uri.toString();
        const sandbox = this._sandboxes.get(uri);
        if (sandbox) {
            sandbox.dispose();
            this._sandboxes.delete(uri);
            this._pendingInjects.delete(uri);
            this._languageProvider.setDynamicGlobals([]);
            log(`Notebook ${uri}: kernel interrupted`);
        }
        // Re-inject fabricItem/itemFolder into the fresh sandbox
        void this.ensureGlobalsInjected(notebook);
    }

    private getOrCreateSandbox(notebookUri: string): Sandbox {
        let sandbox = this._sandboxes.get(notebookUri);
        if (sandbox) {
            return sandbox;
        }

        const settings = getSettings();
        const baseFolder = getBaseFolder(this._extensionContext);

        sandbox = createSandbox(
            { baseFolder },
            { timeout: settings.vmTimeout, logger: (msg) => log(`[sandbox] ${msg}`) },
        );

        this._sandboxes.set(notebookUri, sandbox);
        log(`Notebook ${notebookUri}: created sandbox (child process)`);
        return sandbox;
    }

    private async executeAll(
        cells: vscode.NotebookCell[],
        notebook: vscode.NotebookDocument,
        _controller: vscode.NotebookController,
    ): Promise<void> {
        for (const cell of cells) {
            await this.executeCell(cell, notebook);
        }
    }

    private async executeCell(
        cell: vscode.NotebookCell,
        notebook: vscode.NotebookDocument,
    ): Promise<void> {
        const execution = this._controller.createNotebookCellExecution(cell);
        execution.executionOrder = cell.index + 1;
        execution.start(Date.now());

        // Wait for any pending `autoInjectGlobals` (HTTP `fabricClient.getItem`
        // call from the open-document handler) so `fabricItem` / `itemFolder`
        // are guaranteed visible before user code runs.
        await this.ensureGlobalsInjected(notebook);

        // Run fresh TypeScript type-check before executing
        try {
            const diagnostics = this._languageProvider.updateDiagnostics(cell.document)
                .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);

            log(`Type-check: ${diagnostics.length} error(s) for cell ${cell.index}`);
            for (const d of diagnostics) {
                log(`  TS error: Line ${d.range.start.line + 1}: ${d.message}`);
            }

            if (diagnostics.length > 0) {
                const messages = diagnostics.map(
                    (d) => `Line ${d.range.start.line + 1}: ${d.message}`,
                );
                execution.replaceOutput([
                    new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.stderr(
                            `TypeScript errors:\n${messages.join("\n")}`,
                        ),
                    ]),
                ]);
                execution.end(false, Date.now());
                return;
            }
        } catch (e) {
            // Type-check failed — log and proceed to execution
            const msg = e instanceof Error ? e.stack ?? e.message : String(e);
            log(`Type-check threw for cell ${cell.index}: ${msg}`);
        }

        try {
            const sandbox = this.getOrCreateSandbox(notebook.uri.toString());
            const code = cell.document.getText();

            const { value, outputs, globals } = await sandbox.run(code);

            // Update language service with newly defined globals
            if (globals.length > 0) {
                this._languageProvider.setDynamicGlobals(globals);
                log(`Cell ${cell.index}: registered ${globals.length} global(s): ${globals.map(g => g.name).join(", ")}`);
            }

            const items: vscode.NotebookCellOutputItem[] = [];

            // Add captured console output
            if (outputs.length > 0) {
                items.push(
                    vscode.NotebookCellOutputItem.text(outputs.join("\n"), "text/plain"),
                );
            }

            // Add return value
            if (value !== undefined && value !== null) {
                const formatted = typeof value === "string"
                    ? value
                    : JSON.stringify(value, null, 2);
                items.push(
                    vscode.NotebookCellOutputItem.text(formatted, "text/plain"),
                );
            }

            if (items.length > 0) {
                execution.replaceOutput([new vscode.NotebookCellOutput(items)]);
            } else {
                execution.replaceOutput([]);
            }

            execution.end(true, Date.now());
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            error(`Notebook cell execution failed`, e);

            const outputItems: vscode.NotebookCellOutputItem[] = [];

            // Show partial console output even on error
            const partialOutputs = (e as Error & { outputs?: string[] }).outputs;
            if (partialOutputs && partialOutputs.length > 0) {
                outputItems.push(
                    vscode.NotebookCellOutputItem.text(partialOutputs.join("\n"), "text/plain"),
                );
            }

            // Update globals even on error (partial execution may have defined variables)
            const partialGlobals = (e as Error & { globals?: InferredGlobal[] }).globals;
            if (partialGlobals && partialGlobals.length > 0) {
                this._languageProvider.setDynamicGlobals(partialGlobals);
            }

            outputItems.push(
                vscode.NotebookCellOutputItem.error(
                    e instanceof Error ? e : new Error(msg),
                ),
            );

            // A missing global is usually blamed on the user's code; if the
            // injection is why, say so next to the error rather than only in
            // the output channel.
            const injectFailure = this._injectFailures.get(notebook.uri.toString());
            if (injectFailure && /fabricItem/.test(msg)) {
                outputItems.push(vscode.NotebookCellOutputItem.stderr(injectFailure));
            }

            execution.replaceOutput([
                new vscode.NotebookCellOutput(outputItems),
            ]);
            execution.end(false, Date.now());
        }
    }
}
