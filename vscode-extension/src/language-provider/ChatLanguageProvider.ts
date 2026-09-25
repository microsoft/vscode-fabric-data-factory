/**
 * TypeScript type-checker for the @di chat participant.
 *
 * Unlike the notebook provider, this doesn't register VS Code UI
 * providers (completions, diagnostics). It only exposes a
 * `typeCheck(code)` method for pre-execution validation.
 */

import * as ts from "typescript";
import * as vscode from "vscode";
import { log } from "@/utils/channel_log";
import type { InferredGlobal } from "@/services/vm/common";
import {
    DILanguageServiceHost,
    CELL_FILENAME,
} from "./common";

// ── Types ────────────────────────────────────────────────────

export interface TypeCheckResult {
    errors: Array<{ line: number; column: number; message: string; code: number }>;
    hasErrors: boolean;
}

/**
 * Lightweight TS type-checker for chat-generated scripts.
 *
 * ```ts
 * const checker = new ChatLanguageProvider(extensionUri);
 * const result = checker.typeCheck("const x: number = 'oops';");
 * if (result.hasErrors) {
 *     console.log(result.errors);
 * }
 * ```
 */
export class ChatLanguageProvider implements vscode.Disposable {
    private readonly _host: DILanguageServiceHost;
    private readonly _service: ts.LanguageService;

    constructor(extensionUri: vscode.Uri) {
        const diTypesPath = vscode.Uri.joinPath(
            extensionUri, "assets", "data-integration.d.ts",
        ).fsPath;

        this._host = new DILanguageServiceHost(diTypesPath, extensionUri);
        this._service = ts.createLanguageService(
            this._host, ts.createDocumentRegistry(),
        );

        log("[di-chat] Chat language service initialized.");
    }

    dispose(): void {
        this._service.dispose();
    }

    /** Register globals discovered after script execution. */
    setDynamicGlobals(globals: InferredGlobal[]): void {
        this._host.setDynamicGlobals(globals);
    }

    /**
     * Type-check a TypeScript code string.
     * Returns errors with line/column positions relative to the user code
     * (preamble is excluded).
     */
    /**
     * TypeScript diagnostic codes to suppress in chat scripts.
     * The LLM sometimes redeclares globals (e.g. `const createLocalAirflowClient = ...`)
     * that are already in the preamble. These are harmless at runtime.
     *
     * 1108 ("A 'return' statement can only be used within a function body") is
     * suppressed because the sandbox runtime wraps every script in an async
     * IIFE (`(async function () { … }).call(this)` in vm/sandbox-worker.ts), so
     * a top-level `return` is valid at execution time even though the
     * type-checker sees the bare module body. Matching runtime behaviour here
     * stops the model from burning rounds on a non-error.
     */
    private static readonly SUPPRESSED_DIAG_CODES = new Set([
        2451, // Cannot redeclare block-scoped variable
        2300, // Duplicate identifier
        1108, // A 'return' statement can only be used within a function body
    ]);

    typeCheck(code: string): TypeCheckResult {
        this._host.updateCell(code);

        const semanticDiags = this._service.getSemanticDiagnostics(CELL_FILENAME);
        const syntacticDiags = this._service.getSyntacticDiagnostics(CELL_FILENAME);
        const allDiags = [...syntacticDiags, ...semanticDiags]
            .filter((d) => !ChatLanguageProvider.SUPPRESSED_DIAG_CODES.has(d.code as number));

        const preambleLength = this._host.preambleLength;

        const errors = allDiags
            .filter((d) => d.start !== undefined && d.start >= preambleLength && d.category === ts.DiagnosticCategory.Error)
            .map((d) => {
                const start = d.start! - preambleLength;
                const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
                const lines = code.substring(0, start).split("\n");
                const line = lines.length;
                const column = (lines[lines.length - 1]?.length ?? 0) + 1;
                return { line, column, message, code: d.code };
            });

        return { errors, hasErrors: errors.length > 0 };
    }
}
