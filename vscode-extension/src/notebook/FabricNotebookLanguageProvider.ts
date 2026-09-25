/**
 * TypeScript language service for Fabric notebook cells.
 *
 * Creates an in-memory TS `LanguageService` with:
 * - The `data-integration.d.ts` types loaded as an ambient declaration
 * - Global variables (`fabricClient`, `onelakeClient`, `item`, etc.)
 *   declared so cells get full IntelliSense and diagnostics
 *
 * Provides:
 * - `CompletionItemProvider` for auto-suggestions
 * - `DiagnosticCollection` for type errors shown as squiggly lines
 */

import * as vscode from "vscode";
import * as ts from "typescript";
import * as fs from "fs";
import { NOTEBOOK_TYPE } from "./FabricNotebookController";
import { log } from "@/utils/channel_log";
import type { InferredGlobal } from "@/services/vm/common";
import { GLOBALS_PREAMBLE } from "@/language-provider/common";
import {
    CELL_FILENAME,
    DI_TYPES_FILENAME,
    getNodeTypesDir,
    initTypeDirs,
    listAllNodeTypeDts,
    resolveLibFile,
    resolveNodeBuiltinTypes,
} from "@/utils/ts_assets";

// Notebook cells run in the same sandbox as `@di` scripts, so they share one
// preamble — a local copy silently drifts out of date with the injected globals.

// ── Language service host ───────────────────────────────────────────────────
// Filenames, init, and resolver helpers live in `@/utils/ts_assets` and are
// imported above.

class NotebookLanguageServiceHost implements ts.LanguageServiceHost {
    private _cellContent = "";
    private _cellVersion = 0;
    private readonly _diTypesContent: string;
    private _dynamicGlobals = "";

    constructor(diTypesPath: string, extensionUri: vscode.Uri) {
        this._diTypesContent = fs.readFileSync(diTypesPath, "utf-8");
        initTypeDirs(extensionUri);
    }

    updateCell(content: string): void {
        this._cellContent = GLOBALS_PREAMBLE + "\n" + this._dynamicGlobals + "\n" + content;
        this._cellVersion++;
    }

    /**
     * Register globals discovered after cell execution so subsequent
     * cells get IntelliSense and pass type-checking for them.
     */
    setDynamicGlobals(globals: InferredGlobal[]): void {
        this._dynamicGlobals = globals
            .map((g) => `declare ${g.kind === "const" ? "const" : "let"} ${g.name}: ${g.typeStr};`)
            .join("\n");
    }

    /** Total length of the injected preamble (static + dynamic). */
    get preambleLength(): number {
        return GLOBALS_PREAMBLE.length + 1 + this._dynamicGlobals.length + 1;
    }

    // ── LanguageServiceHost implementation ───────────────────

    getScriptFileNames(): string[] {
        return [CELL_FILENAME, DI_TYPES_FILENAME, ...listAllNodeTypeDts()];
    }

    getScriptVersion(fileName: string): string {
        if (fileName === CELL_FILENAME) {
            return String(this._cellVersion);
        }
        return "1";
    }

    getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
        if (fileName === CELL_FILENAME) {
            return ts.ScriptSnapshot.fromString(this._cellContent);
        }
        if (fileName === DI_TYPES_FILENAME) {
            return ts.ScriptSnapshot.fromString(this._diTypesContent);
        }
        // Serve @types/node files from assets/types_node/
        const nodeTypesDir = getNodeTypesDir();
        if (nodeTypesDir && fileName.startsWith(nodeTypesDir)) {
            if (fs.existsSync(fileName)) {
                return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
            }
        }
        // Serve lib.*.d.ts files from assets/ts_lib/
        const libPath = resolveLibFile(fileName);
        if (libPath) {
            return ts.ScriptSnapshot.fromString(fs.readFileSync(libPath, "utf-8"));
        }
        return undefined;
    }

    getCompilationSettings(): ts.CompilerOptions {
        return {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
            moduleResolution: ts.ModuleResolutionKind.Node16,
            lib: ["lib.es2022.d.ts"],
            strict: false,
            noEmit: true,
            allowJs: true,
            esModuleInterop: true,
            skipLibCheck: true,
        };
    }

    getCurrentDirectory(): string {
        return "/";
    }

    getDefaultLibFileName(options: ts.CompilerOptions): string {
        return ts.getDefaultLibFileName(options);
    }

    fileExists(fileName: string): boolean {
        if (fileName === CELL_FILENAME || fileName === DI_TYPES_FILENAME) {
            return true;
        }
        // Check @types/node files in assets/types_node/
        const nodeTypesDir = getNodeTypesDir();
        if (nodeTypesDir && fileName.startsWith(nodeTypesDir)) {
            return fs.existsSync(fileName);
        }
        // Check TS lib files in assets/ts_lib/
        return resolveLibFile(fileName) !== undefined;
    }

    readFile(fileName: string): string | undefined {
        const snapshot = this.getScriptSnapshot(fileName);
        return snapshot?.getText(0, snapshot.getLength());
    }

    resolveModuleNameLiterals(
        moduleLiterals: readonly ts.StringLiteralLike[],
        _containingFile: string,
    ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
        return moduleLiterals.map((literal) => {
            if (literal.text === "data-integration") {
                return {
                    resolvedModule: {
                        resolvedFileName: DI_TYPES_FILENAME,
                        extension: ts.Extension.Dts,
                        isExternalLibraryImport: true,
                    },
                } as ts.ResolvedModuleWithFailedLookupLocations;
            }
            // Resolve Node.js built-in modules to @types/node
            const nodeTypesPath = resolveNodeBuiltinTypes(literal.text);
            if (nodeTypesPath) {
                return {
                    resolvedModule: {
                        resolvedFileName: nodeTypesPath,
                        extension: ts.Extension.Dts,
                        isExternalLibraryImport: true,
                    },
                } as ts.ResolvedModuleWithFailedLookupLocations;
            }
            return { resolvedModule: undefined } as ts.ResolvedModuleWithFailedLookupLocations;
        });
    }
}

// ── Provider ────────────────────────────────────────────────────────────────

/**
 * Provides TypeScript completions and diagnostics for Fabric notebook cells.
 */
export class FabricNotebookLanguageProvider implements vscode.Disposable {
    private readonly _host: NotebookLanguageServiceHost;
    private readonly _service: ts.LanguageService;
    private readonly _diagnostics: vscode.DiagnosticCollection;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(extensionUri: vscode.Uri) {
        const diTypesPath = vscode.Uri.joinPath(
            extensionUri,
            "assets",
            "data-integration.d.ts",
        ).fsPath;

        this._host = new NotebookLanguageServiceHost(diTypesPath, extensionUri);
        this._service = ts.createLanguageService(
            this._host,
            ts.createDocumentRegistry(),
        );
        this._diagnostics = vscode.languages.createDiagnosticCollection(
            "fabric-notebook",
        );

        // Register completion provider for notebook cells
        this._disposables.push(
            vscode.languages.registerCompletionItemProvider(
                { notebookType: NOTEBOOK_TYPE, language: "typescript" },
                {
                    provideCompletionItems: (doc, pos) =>
                        this.provideCompletions(doc, pos),
                },
                ".", // trigger on dot
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

        log("Fabric notebook language service initialized.");
    }

    dispose(): void {
        this._service.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }

    /**
     * Register globals discovered after cell execution.
     * Delegates to the host, which rebuilds the preamble.
     */
    setDynamicGlobals(globals: InferredGlobal[]): void {
        this._host.setDynamicGlobals(globals);
    }

    // ── Completions ─────────────────────────────────────────

    private provideCompletions(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] | undefined {
        this._host.updateCell(document.getText());

        const offset =
            this._host.preambleLength + document.offsetAt(position);

        const completions = this._service.getCompletionsAtPosition(
            CELL_FILENAME,
            offset,
            undefined,
        );

        if (!completions) {
            return undefined;
        }

        return completions.entries.map((entry) => {
            const item = new vscode.CompletionItem(
                entry.name,
                this.convertKind(entry.kind),
            );
            item.sortText = entry.sortText;
            item.insertText = entry.insertText ?? entry.name;

            // Lazy-resolve details
            const details = this._service.getCompletionEntryDetails(
                CELL_FILENAME,
                offset,
                entry.name,
                undefined,
                undefined,
                undefined,
                undefined,
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
     * Run TypeScript diagnostics on a notebook cell document.
     * Updates the diagnostic collection and returns the diagnostics.
     */
    updateDiagnostics(document: vscode.TextDocument): readonly vscode.Diagnostic[] {
        this._host.updateCell(document.getText());

        const semanticDiags = this._service.getSemanticDiagnostics(CELL_FILENAME);
        const syntacticDiags = this._service.getSyntacticDiagnostics(CELL_FILENAME);
        const allDiags = [...syntacticDiags, ...semanticDiags];

        const preambleLength = this._host.preambleLength;

        const vscodeDiags = allDiags
            .filter((d) => d.start !== undefined && d.start >= preambleLength)
            .map((d) => {
                const start = d.start! - preambleLength;
                const length = d.length ?? 0;
                const startPos = document.positionAt(start);
                const endPos = document.positionAt(start + length);
                const message = ts.flattenDiagnosticMessageText(
                    d.messageText,
                    "\n",
                );
                const severity =
                    d.category === ts.DiagnosticCategory.Error
                        ? vscode.DiagnosticSeverity.Error
                        : d.category === ts.DiagnosticCategory.Warning
                          ? vscode.DiagnosticSeverity.Warning
                          : vscode.DiagnosticSeverity.Information;
                const diag = new vscode.Diagnostic(
                    new vscode.Range(startPos, endPos),
                    message,
                    severity,
                );
                diag.source = "fabric-ts";
                diag.code = d.code;
                return diag;
            });

        this._diagnostics.set(document.uri, vscodeDiags);
        return vscodeDiags;
    }

    // ── Helpers ──────────────────────────────────────────────

    private convertKind(
        kind: ts.ScriptElementKind,
    ): vscode.CompletionItemKind {
        switch (kind) {
            case ts.ScriptElementKind.functionElement:
            case ts.ScriptElementKind.memberFunctionElement:
                return vscode.CompletionItemKind.Method;
            case ts.ScriptElementKind.variableElement:
            case ts.ScriptElementKind.localVariableElement:
            case ts.ScriptElementKind.letElement:
            case ts.ScriptElementKind.constElement:
                return vscode.CompletionItemKind.Variable;
            case ts.ScriptElementKind.memberVariableElement:
                return vscode.CompletionItemKind.Field;
            case ts.ScriptElementKind.classElement:
                return vscode.CompletionItemKind.Class;
            case ts.ScriptElementKind.interfaceElement:
                return vscode.CompletionItemKind.Interface;
            case ts.ScriptElementKind.typeElement:
                return vscode.CompletionItemKind.TypeParameter;
            case ts.ScriptElementKind.enumElement:
                return vscode.CompletionItemKind.Enum;
            case ts.ScriptElementKind.moduleElement:
                return vscode.CompletionItemKind.Module;
            case ts.ScriptElementKind.keyword:
                return vscode.CompletionItemKind.Keyword;
            case ts.ScriptElementKind.string:
                return vscode.CompletionItemKind.Text;
            default:
                return vscode.CompletionItemKind.Property;
        }
    }
}
