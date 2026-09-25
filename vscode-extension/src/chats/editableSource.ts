/**
 * Editable script support for the @di chat participant.
 *
 * Provides:
 * - CodeLens "▶ Run in DI Sandbox" on tracked script files
 * - Save-to-file + open-in-editor for generated scripts
 * - Direct execution from the editor (bypassing the LLM)
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {createFreshSandbox} from "@/chats/chatParticipant";

// ── CodeLens provider ────────────────────────────────────────

/**
 * Shows a "▶ Run in DI Sandbox" CodeLens at the top of tracked script files.
 * Only activates on files opened via "Edit Script" or the gallery.
 */
export class DICodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChange.event;

    private readonly _tracked = new Set<string>();

    /** Start showing CodeLens for this URI. */
    track(uri: vscode.Uri): void {
        this._tracked.add(uri.toString());
        this._onDidChange.fire();
    }

    /** Stop showing CodeLens for this URI. */
    untrack(uri: vscode.Uri): void {
        this._tracked.delete(uri.toString());
        this._onDidChange.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!this._tracked.has(document.uri.toString())) {
            return [];
        }
        return [
            new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                title: "▶ Run in DI Sandbox",
                command: "fabricDataFactory.di.runScript",
                arguments: [document.uri],
            }),
        ];
    }
}

// ── Edit script ──────────────────────────────────────────────

/**
 * Save a generated script to disk, open it in the editor, and
 * track it for CodeLens.
 */
export async function editScript(
    script: string,
    storagePath: string,
    codeLensProvider: DICodeLensProvider,
): Promise<void> {
    const scriptsDir = path.join(storagePath, "scripts");
    fs.mkdirSync(scriptsDir, {recursive: true});

    const filename = `di-script-${Date.now()}.ts`;
    const filePath = path.join(scriptsDir, filename);
    fs.writeFileSync(filePath, script);

    const uri = vscode.Uri.file(filePath);
    codeLensProvider.track(uri);

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {preview: false});
}

// ── Run script from editor ───────────────────────────────────

/**
 * Execute a TypeScript script file directly in the sandbox
 * and display results in the output channel.
 */
export async function runScript(
    uri: vscode.Uri,
    _context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const script = doc.getText();

    const sandbox = createFreshSandbox();

    try {
        outputChannel.appendLine(`▶ Running: ${path.basename(uri.fsPath)}`);
        outputChannel.show(true);

        const result = await sandbox.run(script);

        if (result.outputs.length > 0) {
            for (const line of result.outputs) {
                outputChannel.appendLine(line);
            }
        }

        if (result.value !== undefined && result.value !== null) {
            const formatted = typeof result.value === "string"
                ? result.value
                : JSON.stringify(result.value, null, 2);
            outputChannel.appendLine(formatted);
        }

        outputChannel.appendLine("✅ Script completed successfully.");
        vscode.window.showInformationMessage("Script executed successfully!");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Show partial output on error
        const partialOutputs = (err as Error & { outputs?: string[] }).outputs;
        if (partialOutputs?.length) {
            for (const line of partialOutputs) {
                outputChannel.appendLine(line);
            }
        }

        outputChannel.appendLine(`❌ Script failed: ${msg}`);
        vscode.window.showErrorMessage(`Script execution failed: ${msg}`);
    } finally {
        sandbox.dispose();
    }
}
