import * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "./FabricNotebookController";

/**
 * Serializer for `.fabricnb` notebook files.
 *
 * Format: JSON with `{ cells: [{ language, value }] }`.
 * Each cell has a language (`typescript` or `markdown`) and a text value.
 */
export class FabricNotebookSerializer implements vscode.NotebookSerializer {
    async deserializeNotebook(
        content: Uint8Array,
        _token: vscode.CancellationToken,
    ): Promise<vscode.NotebookData> {
        const text = new TextDecoder().decode(content);

        let raw: { cells?: Array<{ language?: string; value?: string }> };
        try {
            raw = text.trim() ? JSON.parse(text) : { cells: [] };
        } catch {
            raw = { cells: [] };
        }

        const cells = (raw.cells ?? []).map((cell) => {
            const language = cell.language ?? "typescript";
            const kind =
                language === "markdown"
                    ? vscode.NotebookCellKind.Markup
                    : vscode.NotebookCellKind.Code;
            return new vscode.NotebookCellData(kind, cell.value ?? "", language);
        });

        // Default: one empty TS cell if the notebook is blank
        if (cells.length === 0) {
            cells.push(
                new vscode.NotebookCellData(
                    vscode.NotebookCellKind.Code,
                    "// Type your code here\n",
                    "typescript",
                ),
            );
        }

        return new vscode.NotebookData(cells);
    }

    async serializeNotebook(
        data: vscode.NotebookData,
        _token: vscode.CancellationToken,
    ): Promise<Uint8Array> {
        const cells = data.cells.map((cell) => ({
            language: cell.languageId,
            value: cell.value,
        }));
        const json = JSON.stringify({ cells }, null, 2);
        return new TextEncoder().encode(json);
    }
}

/** Notebook type constant re-exported for convenience. */
export { NOTEBOOK_TYPE };
