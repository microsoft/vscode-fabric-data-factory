/**
 * TypeScript language service for Fabric notebook cells.
 *
 * Provides CompletionItemProvider and DiagnosticCollection for
 * notebook cells, backed by the shared DILanguageServiceHost.
 */

import * as vscode from "vscode";
import * as ts from "typescript";
import { log } from "@/utils/channel_log";
import type { InferredGlobal } from "@/services/vm/common";
import {
    DILanguageServiceHost,
    CELL_FILENAME,
    convertTsKind,
} from "./common";

/**
 * Provides TypeScript completions and diagnostics for Fabric notebook cells.
 */
export class NotebookLanguageProvider implements vscode.Disposable {
    private readonly _host: DILanguageServiceHost;
    private readonly _service: ts.LanguageService;
    private readonly _diagnostics: vscode.DiagnosticCollection;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(extensionUri: vscode.Uri, notebookType: string) {
        const diTypesPath = vscode.Uri.joinPath(
            extensionUri, "assets", "data-integration.d.ts",
        ).fsPath;

        this._host = new DILanguageServiceHost(diTypesPath, extensionUri);
        this._service = ts.createLanguageService(
            this._host, ts.createDocumentRegistry(),
        );
        this._diagnostics = vscode.languages.createDiagnosticCollection("fabric-notebook");

        // Register completion provider for notebook cells
        this._disposables.push(
            vscode.languages.registerCompletionItemProvider(
                { notebookType, language: "typescript" },
                { provideCompletionItems: (doc, pos) => this.provideCompletions(doc, pos) },
                ".",
            ),
        );

        // Update diagnostics on cell change
        this._disposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (
                    e.document.uri.scheme === "vscode-notebook-cell" &&
                    e.document.languageId === "typescript"
                ) {
                    this.updateDiagnostics(e.document);
                }
            }),
        );

        // Update diagnostics when switching cells
        this._disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (
                    editor?.document.uri.scheme === "vscode-notebook-cell" &&
                    editor.document.languageId === "typescript"
                ) {
                    this.updateDiagnostics(editor.document);
                }
            }),
        );

        this._disposables.push(this._diagnostics);

        log("Notebook language service initialized.");
    }

    dispose(): void {
        this._service.dispose();
        for (const d of this._disposables) d.dispose();
    }

    setDynamicGlobals(globals: InferredGlobal[]): void {
        this._host.setDynamicGlobals(globals);
    }

    // ── Completions ─────────────────────────────────────────

    private provideCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] | undefined {
        this._host.updateCell(document.getText());
        const offset = this._host.preambleLength + document.offsetAt(position);

        const completions = this._service.getCompletionsAtPosition(
            CELL_FILENAME, offset, undefined,
        );
        if (!completions) return undefined;

        return completions.entries.map((entry) => {
            const item = new vscode.CompletionItem(
                entry.name, convertTsKind(entry.kind),
            );
            item.sortText = entry.sortText;
            item.insertText = entry.insertText ?? entry.name;

            const details = this._service.getCompletionEntryDetails(
                CELL_FILENAME, offset, entry.name,
                undefined, undefined, undefined, undefined,
            );
            if (details?.documentation) {
                item.documentation = new vscode.MarkdownString(
                    ts.displayPartsToString(details.documentation),
                );
            }
            if (details?.displayParts) {
                item.detail = ts.displayPartsToString(details.displayParts);
            }
            return item;
        });
    }

    // ── Diagnostics ─────────────────────────────────────────

    /**
     * TypeScript diagnostic codes to suppress in notebook cells.
     * Notebooks allow re-running cells with the same variable names,
     * so redeclaration errors are expected and should be ignored.
     */
    private static readonly SUPPRESSED_DIAG_CODES = new Set([
        2451, // Cannot redeclare block-scoped variable 'x'
        2300, // Duplicate identifier 'x'
    ]);

    updateDiagnostics(document: vscode.TextDocument): readonly vscode.Diagnostic[] {
        this._host.updateCell(document.getText());

        const semanticDiags = this._service.getSemanticDiagnostics(CELL_FILENAME);
        const syntacticDiags = this._service.getSyntacticDiagnostics(CELL_FILENAME);
        const allDiags = [...syntacticDiags, ...semanticDiags]
            .filter((d) => !NotebookLanguageProvider.SUPPRESSED_DIAG_CODES.has(d.code as number));

        const preambleLength = this._host.preambleLength;

        const vscodeDiags = allDiags
            .filter((d) => d.start !== undefined && d.start >= preambleLength)
            .map((d) => {
                const start = d.start! - preambleLength;
                const length = d.length ?? 0;
                const startPos = document.positionAt(start);
                const endPos = document.positionAt(start + length);
                const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
                const severity =
                    d.category === ts.DiagnosticCategory.Error
                        ? vscode.DiagnosticSeverity.Error
                        : d.category === ts.DiagnosticCategory.Warning
                          ? vscode.DiagnosticSeverity.Warning
                          : vscode.DiagnosticSeverity.Information;
                const diag = new vscode.Diagnostic(
                    new vscode.Range(startPos, endPos), message, severity,
                );
                diag.source = "fabric-ts";
                diag.code = d.code;
                return diag;
            });

        this._diagnostics.set(document.uri, vscodeDiags);
        return vscodeDiags;
    }
}
