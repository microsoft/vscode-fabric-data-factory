import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {tryGetDIContext} from "@/services/di-context";
import {getBaseFolder} from "@/utils/folders";
import type {ItemSyncState} from "data-integration";

/**
 * Decorates `.workspaces/<wsId>/<itemId>/` folders and all files beneath
 * them with the Fabric item display name and type, so users can identify
 * items by name instead of GUIDs in the Explorer.
 *
 * Only active when a `fabric-di.yaml` exists at the project base folder.
 */
export class FabricFileDecorationProvider
    implements vscode.FileDecorationProvider {
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;

    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

    /** Cached item states keyed by itemId. */
    private _states: Record<string, ItemSyncState> = {};

    /** Whether the provider is active (fabric-di.yaml exists). */
    private _active = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.onDidChangeFileDecorations = this._onDidChange.event;
        this.refreshStates();
    }

    /** Reload sync states from disk and fire change event. */
    refreshStates(): void {
        const base = getBaseFolder(this.context);
        const configPath = path.join(base, "fabric-di.yaml");
        this._active = fs.existsSync(configPath);

        if (this._active) {
            const di = tryGetDIContext();
            this._states = di ? di.syncService.readLocalItemStatesMap() : {};
        } else {
            this._states = {};
        }

        this._onDidChange.fire(undefined);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (!this._active) {
            return undefined;
        }

        const base = getBaseFolder(this.context);
        const workspacesDir = path.join(base, ".workspaces");
        const fsPath = uri.fsPath;

        // Only decorate files/folders under .workspaces/
        if (!fsPath.startsWith(workspacesDir)) {
            return undefined;
        }

        const relative = fsPath.slice(workspacesDir.length + 1);
        const segments = relative.split(path.sep).filter(Boolean);

        if (segments.length < 2) {
            // .workspaces/ or .workspaces/<wsId>/ — show item count
            if (segments.length === 1) {
                const wsId = segments[0];
                const count = Object.values(this._states).filter(
                    (s) => s.workspaceId === wsId,
                ).length;
                if (count > 0) {
                    return new vscode.FileDecoration(
                        undefined,
                        `${count} items`,
                    );
                }
            }
            return undefined;
        }

        // .workspaces/<wsId>/<itemId>/ or any file/folder beneath it
        const itemId = segments[1];
        const state = this._states[itemId];
        if (!state) {
            return undefined;
        }

        return new vscode.FileDecoration(
            undefined,
            `${state.displayName} (${state.itemType})`,
        );
    }
}
