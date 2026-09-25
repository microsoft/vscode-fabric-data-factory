/**
 * Shared TypeScript language service infrastructure for both the
 * notebook controller and the @di chat participant.
 *
 * Contains:
 * - GLOBALS_PREAMBLE: ambient declarations for sandbox globals
 * - DILanguageServiceHost: configurable TS LanguageServiceHost
 * - Type resolution helpers for @types/node and TS lib files
 */

import * as ts from "typescript";
import * as fs from "fs";
import * as vscode from "vscode";
import type { InferredGlobal } from "@/services/vm/common";
import {
    CELL_FILENAME,
    DI_TYPES_FILENAME,
    getNodeTypesDir,
    initTypeDirs,
    listAllNodeTypeDts,
    resolveLibFile,
    resolveNodeBuiltinTypes,
} from "@/utils/ts_assets";

// Re-exported for callers that already import these names from this module.
export { CELL_FILENAME, DI_TYPES_FILENAME };

// ── Globals preamble ────────────────────────────────────────────────────────

/**
 * TypeScript declarations injected at the top of every cell/script.
 * Declares the DI context clients as global variables so the TS language
 * service knows about them without explicit imports.
 */
export const GLOBALS_PREAMBLE = `
import type {
  NodeFabricClient,
  NodeAirflowClient,
  NodePipelineClient,
  NodeCopyJobClient,
  NodeDataflowClient,
  NodeDbtClient,
  LocalDbtClient,
  NodeDbtCommandStream,
  NodeOneLakeClient,
  NodeWarehouseClient,
  NodeWarehouseRowStream,
  NodeSqlEndpointClient,
  NodeSqlEndpointRowStream,
  NodeQueryRowStream,
  NodeItemSyncService,
  NodePyHelperClient,
  NodeAirflowRunner,
  NodeConfigClient,
  NodeAuthClient,
  NodeConnectionClient,
  NodeGatewayClient,
  NodeAzureKeyVaultClient,
  NodeGitHelperService,
  NodeTracingClient,
  FabricItem,
  Workspace,
  ItemSyncState,
  PathEntry,
  CommitInfo,
  NodeDeltaTable,
  NodeDeltaView,
  CancellationToken,
  LocalAirflowClient,
  NodeAzureAuth,
  Connection,
  ConnectionDetails,
  ConnectionRoleAssignment,
  CredentialDetails,
  Gateway,
  GatewayDatasource,
  GatewayClusterDatasource,
  GatewayClusterDatasourceUser,
  DataflowConnection,
  TestConnectionResult,
  DatasourceStatusResult,
  CopyActivityBuilder,
  CopyJobBuilder,
  IfConditionBuilder,
  LookupActivityBuilder,
  PipelineBuilder,
  PipelineExpression,
  MashupDocument,
  MashupLetBuilder,
  MashupPattern,
} from "data-integration";

// Node.js globals available in the sandbox
declare const console: {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
  dir(obj: any): void;
  table(data: any): void;
};
declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearTimeout(id: any): void;
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): any;
declare function clearInterval(id: any): void;

// ── Web fetch API (Node.js 18+ global) ──────────────────────────────────────
// Minimal, self-contained typings so the sandbox type-checker accepts \`fetch\`,
// \`Response\`, \`Headers\`, and \`RequestInit\` WITHOUT pulling in lib.dom or
// resolving undici-types. The runtime provides the real Node global \`fetch\`.
// \`interface\` (not \`type\`) is used so these merge harmlessly if @types/node's
// web globals are ever also in scope.
interface Headers {
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callback: (value: string, key: string) => void): void;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
}
type HeadersInit = Headers | Record<string, string> | Array<[string, string]>;
interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array | ArrayBuffer | null;
  signal?: any;
  redirect?: "follow" | "error" | "manual";
  [key: string]: any;
}
interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string;
  readonly redirected: boolean;
  readonly bodyUsed: boolean;
  json(): Promise<any>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  clone(): Response;
}
declare var Response: { new (body?: any, init?: any): Response; prototype: Response };
declare function fetch(input: string | URL, init?: RequestInit): Promise<Response>;

// Typed convenience HTTP helper (pre-injected). A belt-and-suspenders
// alternative to \`fetch\` / hand-rolled \`https.request(...)\` — performs one
// request, buffers the whole response, and resolves a typed result.
//   const res = await httpRequest("https://api.example.com/x", { method: "POST", body });
//   if (res.ok) console.log(res.json());
declare function httpRequest(
  url: string,
  opts?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | null;
    timeoutMs?: number;
  },
): Promise<{
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  json<T = any>(): T;
}>;

// Node.js require — for built-in modules only (fs, path, os, child_process, etc.)
declare function require(id: string): any;
declare const process: { env: Record<string, string | undefined>; cwd(): string; [key: string]: any };

// Pre-injected Node.js built-in modules — available as globals so scripts can
// call e.g. \`fs.writeFileSync(...)\` directly without a \`require()\` line.
// Mirrors the runtime injection in vm/sandbox-worker.ts. Anything not in this
// list (e.g. \`url\`, \`perf_hooks\`, \`cluster\`) is still reachable via
// \`require("node:xxx")\`.
//
// \`url\` is intentionally NOT a pre-injected global because it's a very
// common local variable name (\`const url = "https://..."\`) and would
// shadow/conflict. Use the global \`URL\` class for parsing.
declare const fs: typeof import("fs");
declare const path: typeof import("path");
declare const os: typeof import("os");
declare const crypto: typeof import("crypto");
declare const child_process: typeof import("child_process");
declare const util: typeof import("util");
declare const stream: typeof import("stream");
declare const events: typeof import("events");
declare const string_decoder: typeof import("string_decoder");
declare const http: typeof import("http");
declare const https: typeof import("https");
declare const net: typeof import("net");
declare const tls: typeof import("tls");
declare const dns: typeof import("dns");
declare const querystring: typeof import("querystring");
declare const assert: typeof import("assert");
declare const buffer: typeof import("buffer");
declare const zlib: typeof import("zlib");
declare const readline: typeof import("readline");
declare const worker_threads: typeof import("worker_threads");

// \`Buffer\` is exposed at runtime by the sandbox. Declaring it explicitly
// (rather than relying on transitive global augmentation from \`@types/node\`)
// guarantees that \`Buffer.from(...)\`, \`Buffer.alloc(...)\`, etc. type-check.
declare const Buffer: typeof import("buffer").Buffer;

// Enum runtime objects the sandbox injects. Derived from the package rather than
// transcribed, so a new member cannot go missing here.
type ActivityState = import("data-integration").ActivityState;
declare const ActivityState: typeof import("data-integration").ActivityState;
type CopyJobMode = import("data-integration").CopyJobMode;
declare const CopyJobMode: typeof import("data-integration").CopyJobMode;
type CopyJobSinkKind = import("data-integration").CopyJobSinkKind;
declare const CopyJobSinkKind: typeof import("data-integration").CopyJobSinkKind;
type CopyJobSourceKind = import("data-integration").CopyJobSourceKind;
declare const CopyJobSourceKind: typeof import("data-integration").CopyJobSourceKind;
type CopySinkKind = import("data-integration").CopySinkKind;
declare const CopySinkKind: typeof import("data-integration").CopySinkKind;
type CopySourceKind = import("data-integration").CopySourceKind;
declare const CopySourceKind: typeof import("data-integration").CopySourceKind;
type DependencyCondition = import("data-integration").DependencyCondition;
declare const DependencyCondition: typeof import("data-integration").DependencyCondition;
type FabricItemType = import("data-integration").FabricItemType;
declare const FabricItemType: typeof import("data-integration").FabricItemType;
type HttpMethod = import("data-integration").HttpMethod;
declare const HttpMethod: typeof import("data-integration").HttpMethod;
type InactiveMarkAs = import("data-integration").InactiveMarkAs;
declare const InactiveMarkAs: typeof import("data-integration").InactiveMarkAs;
type ParameterType = import("data-integration").ParameterType;
declare const ParameterType: typeof import("data-integration").ParameterType;
type ScriptParameterDirection = import("data-integration").ScriptParameterDirection;
declare const ScriptParameterDirection: typeof import("data-integration").ScriptParameterDirection;
type ScriptParameterType = import("data-integration").ScriptParameterType;
declare const ScriptParameterType: typeof import("data-integration").ScriptParameterType;
type ScriptQueryType = import("data-integration").ScriptQueryType;
declare const ScriptQueryType: typeof import("data-integration").ScriptQueryType;
type VariableType = import("data-integration").VariableType;
declare const VariableType: typeof import("data-integration").VariableType;

declare const baseFolder: string;
declare const fabricClient: NodeFabricClient;
declare const airflowClient: NodeAirflowClient;
declare const pipelineClient: NodePipelineClient;
declare const copyJobClient: NodeCopyJobClient;
declare const dataflowClient: NodeDataflowClient;
declare const dbtClient: NodeDbtClient;
declare const onelakeClient: NodeOneLakeClient;
declare const warehouseClient: NodeWarehouseClient;
declare const sqlEndpointClient: NodeSqlEndpointClient;
declare const syncService: NodeItemSyncService;
declare const pyHelperClient: NodePyHelperClient;
declare const configClient: NodeConfigClient;
declare const connectionClient: NodeConnectionClient;
declare const gatewayClient: NodeGatewayClient;
declare const keyVaultClient: NodeAzureKeyVaultClient;
declare const gitHelperService: NodeGitHelperService;
declare const tracingClient: NodeTracingClient;
declare const auth: NodeAuthClient;
declare const airflowRunner: NodeAirflowRunner | undefined;
declare let fabricItem: FabricItem | undefined;
/** Local filesystem path to the current item's folder (for exports). */
declare let itemFolder: string | undefined;

// Airflow globals injected by AirflowService when a local server is running
declare let airflowPort: number | undefined;
declare let airflowItemFolder: string | undefined;
declare let airflowBaseUrl: string | undefined;
declare let airflowVersion: string | undefined;

// Fabric environment globals injected at activation (always set).
// Build URLs from these instead of hard-coding api.fabric.microsoft.com /
// app.fabric.microsoft.com so non-prod environments (daily/dxt/msit/ppe) work.
declare let fabricEnvName: string | undefined;
declare let fabricApiHost: string | undefined;
declare let fabricPowerbiApiHost: string | undefined;
declare let fabricOnelakeDfsHost: string | undefined;
declare let fabricPortalHost: string | undefined;

// Factory functions available in the sandbox
// Derived from the package rather than restated, so adding a client to
// \`createContext\` cannot leave this preamble stale.
declare function createContext(opts: {
  baseFolder: string,
  auth?: {
    getAccessToken: () => Promise<string | null>,
    getOneLakeToken: () => Promise<string | null>,
    getDatabaseToken?: () => Promise<string | null>,
  },
}): ReturnType<typeof import("data-integration").createContext>;
declare function createFabricClient(auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> }): NodeFabricClient;
declare function createAirflowClient(auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> }): NodeAirflowClient;
declare function createAirflowRunner(opts: { baseFolder: string, auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> } }): NodeAirflowRunner;
declare function createPipelineClient(opts: { baseFolder: string, auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> } }): NodePipelineClient;
declare function createCopyJobClient(auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> }): NodeCopyJobClient;
declare function createDataflowClient(opts: { baseFolder: string, auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> } }): NodeDataflowClient;
declare function createDbtClient(opts: { baseFolder: string, auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> } }): NodeDbtClient;
declare function createOneLakeClient(auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> }): NodeOneLakeClient;
declare function createWarehouseClient(auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null>, getDatabaseToken?: () => Promise<string | null> }): NodeWarehouseClient;
declare function createSqlEndpointClient(auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null>, getDatabaseToken?: () => Promise<string | null> }): NodeSqlEndpointClient;
declare function createItemSyncService(opts: { baseFolder: string, auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> } }): NodeItemSyncService;
declare function createPyHelperClient(baseFolder: string): NodePyHelperClient;
declare function createConfigClient(baseFolder: string): NodeConfigClient;
declare function createNodeAzureAuth(): NodeAzureAuth;
declare function createCancellationToken(): CancellationToken;
declare function createLocalAirflowClient(baseFolder: string): LocalAirflowClient;
declare function createConnectionClient(auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> }): NodeConnectionClient;
declare function createGatewayClient(auth?: { getAccessToken: () => Promise<string | null>, getOneLakeToken: () => Promise<string | null> }): NodeGatewayClient;

// Pipeline / Copy / CopyJob builder factories
declare function createPipelineBuilder(): PipelineBuilder;
declare function createCopyActivityBuilder(name: string): CopyActivityBuilder;
declare function createCopyJobBuilder(jobMode: CopyJobMode): CopyJobBuilder;
declare function createCopySource(input: any): any;
declare function createCopySink(input: any): any;
declare function createCopyJobSource(input: any): any;
declare function createCopyJobSink(input: any): any;
declare function createCopyJobTableSource(input: any): any;
declare function createCopyJobTableSink(input: any): any;
declare function createIfConditionBuilder(name: string, expression: string): IfConditionBuilder;
declare function createLookupActivityBuilder(name: string): LookupActivityBuilder;
declare function pipelineExpression(value: string): PipelineExpression;

// Mashup document + pattern factories
declare function makeBlankDocument(sectionName?: string | undefined | null): MashupDocument;
declare function makeLetBuilder(): MashupLetBuilder;
declare function makeReferencePattern(identifier: string): MashupPattern;
declare function makeUnknownPattern(script: string): MashupPattern;
declare function makePatternFromConnection(connection: Connection): MashupPattern;
declare function makeNavigationPattern(options: { input: string, keys?: Array<{ name: string, value: string }>, indexKey?: string, memberAccess?: string, function?: string, isKeyAccessOptional?: boolean, isMemberAccessOptional?: boolean }): MashupPattern;
declare function makeTableNavigationPattern(input: string, tableName: string): MashupPattern;
declare function makeSchemaItemNavigationPattern(input: string, schema: string, item: string): MashupPattern;
declare function makeOdataFeedPattern(options: { url: string, apiVersion?: string, moreColumns?: boolean, implementation?: string }): MashupPattern;
declare function makeSqlDatabasePattern(options: { server: string, database: string, query?: string, createNavigationProperties?: boolean, hierarchicalNavigation?: boolean, multiSubnetFailover?: boolean }): MashupPattern;
declare function makeSqlDatabasesPattern(options: { server: string, query?: string, createNavigationProperties?: boolean, hierarchicalNavigation?: boolean, multiSubnetFailover?: boolean }): MashupPattern;
declare function makeSharePointFilesPattern(options: { url: string }): MashupPattern;
declare function makeSharePointTablesPattern(options: { url: string, implementation?: string, viewMode?: string }): MashupPattern;
declare function makeFileFormatPattern(options: {
    source:
        | { kind: "filePath", path: string }
        | { kind: "webUrl", url: string }
        | { kind: "rawExpression", rawExpression: string },
    format:
        | { kind: "csv", delimiter?: string, encoding?: number }
        | { kind: "json", encoding?: number }
        | { kind: "parquet" }
        | { kind: "excel", useHeaders?: boolean, delayTypes?: boolean }
        | { kind: "xml", encoding?: number }
        | { kind: "pdf", implementation?: string }
        | { kind: "xmlDocument", encoding?: number }
        | { kind: "lines", quoteStyleCsv?: boolean, includeLineSeparators?: boolean, encoding?: number }
        | { kind: "webPage", commandTimeoutMinutes?: number }
}): MashupPattern;
declare function makeFolderContentsPattern(path: string): MashupPattern;
declare function makeNativeQueryPattern(options: { source: string, query: string, enableFolding?: boolean }): MashupPattern;
declare function makeWebBrowserContentsPattern(options: { url: string, selector?: string, timeoutMinutes?: number }): MashupPattern;
`;

// ── Type resolution helpers ─────────────────────────────────────────────────
// Filenames, init, and resolver helpers live in `@/utils/ts_assets`. They are
// imported above and the constants are re-exported for backward compatibility
// with `ChatLanguageProvider` and `NotebookLanguageProvider`.

// ── Shared LanguageServiceHost ──────────────────────────────────────────────

/**
 * Reusable TS LanguageServiceHost for both notebook cells and chat scripts.
 * Manages one virtual file with the preamble + user code.
 */
export class DILanguageServiceHost implements ts.LanguageServiceHost {
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

    setDynamicGlobals(globals: InferredGlobal[]): void {
        this._dynamicGlobals = globals
            .map((g) => `declare ${g.kind === "const" ? "const" : "let"} ${g.name}: ${g.typeStr};`)
            .join("\n");
    }

    get preambleLength(): number {
        return GLOBALS_PREAMBLE.length + 1 + this._dynamicGlobals.length + 1;
    }

    getScriptFileNames(): string[] {
        return [CELL_FILENAME, DI_TYPES_FILENAME, ...listAllNodeTypeDts()];
    }

    getScriptVersion(fileName: string): string {
        return fileName === CELL_FILENAME ? String(this._cellVersion) : "1";
    }

    getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
        if (fileName === CELL_FILENAME) {
            return ts.ScriptSnapshot.fromString(this._cellContent);
        }
        if (fileName === DI_TYPES_FILENAME) {
            return ts.ScriptSnapshot.fromString(this._diTypesContent);
        }
        const nodeTypesDir = getNodeTypesDir();
        if (nodeTypesDir && fileName.startsWith(nodeTypesDir) && fs.existsSync(fileName)) {
            return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
        }
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
        if (fileName === CELL_FILENAME || fileName === DI_TYPES_FILENAME) return true;
        const nodeTypesDir = getNodeTypesDir();
        if (nodeTypesDir && fileName.startsWith(nodeTypesDir)) return fs.existsSync(fileName);
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

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Convert a TS ScriptElementKind to a VS Code CompletionItemKind. */
export function convertTsKind(kind: ts.ScriptElementKind): vscode.CompletionItemKind {
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
