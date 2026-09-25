import * as vscode from "vscode";
import * as path from "path";
import { tryGetDIContext } from "@/services/di-context";
import { getBaseFolder } from "@/utils/folders";

/**
 * Shows a status bar item indicating which Fabric item the currently
 * open file belongs to. Updates automatically when the active editor changes.
 *
 * Only visible when the file is under `.workspaces/<wsId>/<itemId>/`.
 */
export class FabricItemStatusBar implements vscode.Disposable {
    private readonly _statusBarItem: vscode.StatusBarItem;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(private readonly context: vscode.ExtensionContext) {
        this._statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            50,
        );

        this._disposables.push(
            this._statusBarItem,
            vscode.window.onDidChangeActiveTextEditor(() => this.update()),
        );

        this.update();
    }

    dispose(): void {
        for (const d of this._disposables) {
            d.dispose();
        }
    }

    private update(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== "file") {
            this._statusBarItem.hide();
            return;
        }

        const fsPath = editor.document.uri.fsPath;
        const base = getBaseFolder(this.context);
        const workspacesDir = path.join(base, ".workspaces");

        if (!fsPath.startsWith(workspacesDir)) {
            this._statusBarItem.hide();
            return;
        }

        const relative = fsPath.slice(workspacesDir.length + 1);
        const segments = relative.split(path.sep).filter(Boolean);

        if (segments.length < 2) {
            this._statusBarItem.hide();
            return;
        }

        const wsId = segments[0];
        const itemId = segments[1];
        const di = tryGetDIContext();
        if (!di) {
            this._statusBarItem.hide();
            return;
        }

        const state = di.syncService.readItemState(wsId, itemId);
        if (!state) {
            this._statusBarItem.hide();
            return;
        }

        this._statusBarItem.text = `$(file) ${state.displayName}`;
        this._statusBarItem.tooltip = `${state.displayName} (${state.itemType})\nWorkspace: ${state.workspaceId}\nItem: ${state.itemId}\n\nClick to reveal in Explorer`;
        this._statusBarItem.command = {
            command: "revealInExplorer",
            title: "Reveal in Explorer",
            arguments: [vscode.Uri.file(
                path.join(workspacesDir, wsId, itemId),
            )],
        };
        this._statusBarItem.show();
    }
}
