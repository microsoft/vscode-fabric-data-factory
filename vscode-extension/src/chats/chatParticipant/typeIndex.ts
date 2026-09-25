/**
 * Symbol-level index over the generated SDK declarations
 * (`assets/data-integration.d.ts`), backing the `@di` chat participant's
 * `lookup_type` / `list_symbols` tools.
 *
 * **Why this exists.** `data-integration.d.ts` is ~337 KB (~84k tokens) and
 * grows with every addition to the Rust addon. It was previously reachable
 * through `load_reference` as a whole document, which meant a single call
 * asking "what's the exact signature of `WarehouseClient.query`?" could
 * consume most of the model's context — and, because tool results stay in
 * the message history, keep consuming it on every later round.
 *
 * A `.d.ts` isn't really a document though; it's a symbol table. So instead
 * of paginating it, this module parses it once with the TypeScript compiler
 * API (already bundled for `ChatLanguageProvider`'s type-checking, so no new
 * dependency) and serves individual declarations — turning an 84k-token
 * request into a ~100-token one. Crucially the cost is now flat: adding 200
 * new types grows the index, not the context.
 *
 * The parse is lazy and cached; the declarations ship inside the VSIX and
 * cannot change at runtime.
 */

import * as fs from "fs";
import * as ts from "typescript";
import * as vscode from "vscode";

// ── Tunables ─────────────────────────────────────────────────

/**
 * Above this size a declaration is served as a signature + member index
 * instead of verbatim text. Some generated classes (e.g. the pipeline
 * builders) are thousands of lines on their own, which would defeat the
 * whole point of this module.
 */
const MAX_DECLARATION_CHARS = 6_000;

/** Default / maximum number of entries returned by `list_symbols`. */
const DEFAULT_SYMBOL_LIMIT = 40;
const MAX_SYMBOL_LIMIT = 200;

// ── Types ────────────────────────────────────────────────────

/** A class/interface member (method, property, accessor, constructor). */
export interface MemberEntry {
    name: string;
    kind: string;
    /** Verbatim declaration text, including its JSDoc comment. */
    text: string;
}

/** A top-level exported declaration. */
export interface SymbolEntry {
    name: string;
    kind: "class" | "interface" | "function" | "enum" | "type" | "variable";
    /** Verbatim declaration text, including its JSDoc comment. */
    text: string;
    /** First sentence of the JSDoc, when present. */
    doc: string;
    /** Declared members, for classes and interfaces. */
    members: Map<string, MemberEntry>;
    /** `text.length`, precomputed for budgeting. */
    chars: number;
}

/** The parsed declaration file. */
export interface TypeIndex {
    symbols: Map<string, SymbolEntry>;
    /**
     * Alternate spellings → canonical name. The generated classes are named
     * `NodeWarehouseClient` while every doc, prompt, and user says
     * `WarehouseClient`, so both must resolve. Keys are lowercased.
     */
    aliases: Map<string, string>;
}

// ── Index construction ───────────────────────────────────────

let cachedIndex: TypeIndex | undefined;

/**
 * Parse `assets/data-integration.d.ts` into a symbol table. Cached; returns
 * an empty index if the file is missing (e.g. assets not yet copied) rather
 * than throwing into the chat path.
 */
export function loadTypeIndex(extensionUri: vscode.Uri): TypeIndex {
    if (cachedIndex) return cachedIndex;

    const dtsPath = vscode.Uri.joinPath(extensionUri, "assets", "data-integration.d.ts").fsPath;
    let source: string;
    try {
        source = fs.readFileSync(dtsPath, "utf-8");
    } catch {
        cachedIndex = { symbols: new Map(), aliases: new Map() };
        return cachedIndex;
    }

    // `setParentNodes` makes `getFullText`/`getStart` reliable; the one-off
    // cost on a 337 KB file is negligible next to a single model round-trip.
    const sourceFile = ts.createSourceFile(
        "data-integration.d.ts",
        source,
        ts.ScriptTarget.ES2022,
        /*setParentNodes*/ true,
        ts.ScriptKind.TS,
    );

    const symbols = new Map<string, SymbolEntry>();
    const aliases = new Map<string, string>();

    for (const statement of sourceFile.statements) {
        const entry = describeStatement(statement, sourceFile);
        if (!entry) continue;
        symbols.set(entry.name, entry);

        aliases.set(entry.name.toLowerCase(), entry.name);
        // `NodeWarehouseClient` is also reachable as `WarehouseClient`.
        if (entry.name.startsWith("Node") && entry.name.length > 4) {
            aliases.set(entry.name.slice(4).toLowerCase(), entry.name);
        }
    }

    // `createWarehouseClient()` → the class it constructs, so looking up the
    // factory the model actually calls lands on something useful.
    for (const name of [...symbols.keys()]) {
        if (!name.startsWith("create")) continue;
        const bare = name.slice(6).toLowerCase();
        if (!aliases.has(bare)) continue;
        const target = aliases.get(bare);
        if (target && target !== name) {
            aliases.set(`${name.toLowerCase()}:class`, target);
        }
    }

    cachedIndex = { symbols, aliases };
    return cachedIndex;
}

/** Drop the cached index (tests / hot-reload). */
export function resetTypeIndex(): void {
    cachedIndex = undefined;
}

/** Convert one top-level statement into a {@link SymbolEntry}, if it's a declaration. */
function describeStatement(node: ts.Statement, sourceFile: ts.SourceFile): SymbolEntry | undefined {
    let name: string | undefined;
    let kind: SymbolEntry["kind"] | undefined;
    const members = new Map<string, MemberEntry>();

    if (ts.isClassDeclaration(node) && node.name) {
        name = node.name.text;
        kind = "class";
        collectMembers(node.members, sourceFile, members);
    } else if (ts.isInterfaceDeclaration(node)) {
        name = node.name.text;
        kind = "interface";
        collectMembers(node.members, sourceFile, members);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text;
        kind = "function";
    } else if (ts.isEnumDeclaration(node)) {
        name = node.name.text;
        kind = "enum";
    } else if (ts.isTypeAliasDeclaration(node)) {
        name = node.name.text;
        kind = "type";
    } else if (ts.isVariableStatement(node)) {
        const decl = node.declarationList.declarations[0];
        if (decl && ts.isIdentifier(decl.name)) {
            name = decl.name.text;
            kind = "variable";
        }
    }

    if (!name || !kind) return undefined;

    const text = declarationText(node, sourceFile);
    return { name, kind, text, doc: firstDocSentence(text), members, chars: text.length };
}

/** Index a class/interface's members by name. */
function collectMembers(
    nodes: ts.NodeArray<ts.ClassElement | ts.TypeElement>,
    sourceFile: ts.SourceFile,
    into: Map<string, MemberEntry>,
): void {
    for (const member of nodes) {
        const memberName = memberNameOf(member);
        if (!memberName) continue;
        let kind = "property";
        if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) kind = "method";
        else if (ts.isGetAccessor(member)) kind = "getter";
        else if (ts.isSetAccessor(member)) kind = "setter";
        else if (ts.isConstructorDeclaration(member)) kind = "constructor";
        into.set(memberName, {
            name: memberName,
            kind,
            text: declarationText(member, sourceFile).trim(),
        });
    }
}

/** Best-effort member name (identifiers, string literals, `constructor`). */
function memberNameOf(member: ts.ClassElement | ts.TypeElement): string | undefined {
    if (ts.isConstructorDeclaration(member)) return "constructor";
    const nameNode = member.name;
    if (!nameNode) return undefined;
    if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) return nameNode.text;
    return undefined;
}

/**
 * Verbatim source text for a node, including its leading JSDoc.
 *
 * `getFullText` returns everything back to the previous token — which is
 * exactly the JSDoc we want — plus any blank lines, which are trimmed.
 */
function declarationText(node: ts.Node, sourceFile: ts.SourceFile): string {
    try {
        return node.getFullText(sourceFile).replace(/^\s*\n/, "").trimEnd();
    } catch {
        return sourceFile.text.slice(node.pos, node.end).trim();
    }
}

/** First sentence of a leading JSDoc block, for one-line symbol listings. */
function firstDocSentence(text: string): string {
    const jsdoc = /^\s*\/\*\*([\s\S]*?)\*\//.exec(text);
    if (!jsdoc) return "";
    const body = jsdoc[1]
        .split("\n")
        .map((l) => l.replace(/^\s*\*\s?/, "").trim())
        .filter((l) => l.length > 0 && !l.startsWith("@"))
        .join(" ");
    const sentence = /^(.*?[.!?])(\s|$)/.exec(body);
    return (sentence ? sentence[1] : body).slice(0, 200);
}

// ── Lookup ───────────────────────────────────────────────────

/**
 * Resolve a symbol name the model supplied. Tolerates the spellings that
 * actually show up in practice: the canonical name, the `Node`-stripped
 * alias, any casing, and a `create…()` factory standing in for the class it
 * returns.
 */
function resolve(index: TypeIndex, name: string): SymbolEntry | undefined {
    const trimmed = name.trim().replace(/\(\)$/, "");
    const direct = index.symbols.get(trimmed);
    if (direct) return direct;
    const viaAlias = index.aliases.get(trimmed.toLowerCase());
    if (viaAlias) return index.symbols.get(viaAlias);
    const viaFactory = index.aliases.get(`${trimmed.toLowerCase()}:class`);
    if (viaFactory) return index.symbols.get(viaFactory);
    return undefined;
}

/** Find a member on a symbol, tolerating case and a `()` suffix. */
function resolveMember(entry: SymbolEntry, member: string): MemberEntry | undefined {
    const trimmed = member.trim().replace(/\(\)$/, "");
    const direct = entry.members.get(trimmed);
    if (direct) return direct;
    const lower = trimmed.toLowerCase();
    for (const [key, value] of entry.members) {
        if (key.toLowerCase() === lower) return value;
    }
    return undefined;
}

/**
 * Return the exact declaration for `symbol`, which may be a top-level name
 * (`WarehouseClient`, `FabricItem`, `createPipelineBuilder`) or a member
 * path (`WarehouseClient.query`).
 *
 * Oversized classes come back as a signature + member index rather than
 * thousands of lines, with an explicit hint to re-query for one member —
 * the same progressive-disclosure shape as `load_reference`'s table of
 * contents.
 */
export function lookupType(index: TypeIndex, symbol: string): string {
    const raw = String(symbol ?? "").trim();
    if (!raw) {
        return "Error: no symbol given. Example: lookup_type({ symbol: \"WarehouseClient.query\" }).";
    }

    // Split on the LAST dot so namespaced names still resolve.
    const dot = raw.lastIndexOf(".");
    if (dot > 0) {
        const ownerName = raw.slice(0, dot);
        const memberName = raw.slice(dot + 1);
        const owner = resolve(index, ownerName);
        if (owner) {
            const member = resolveMember(owner, memberName);
            if (member) {
                return (
                    `// ${owner.kind} ${owner.name} — member '${member.name}' (${member.kind})\n` +
                    `${member.text}\n`
                );
            }
            return (
                `Error: '${owner.name}' has no member '${memberName}'.\n\n` +
                renderMemberIndex(owner)
            );
        }
    }

    const entry = resolve(index, raw);
    if (!entry) {
        return (
            `Error: unknown symbol '${raw}'. ` +
            `Use list_symbols({ prefix: "${raw.slice(0, 4)}" }) to discover the right name, ` +
            `or search_docs({ query: "${raw}" }) for prose documentation.`
        );
    }

    if (entry.chars > MAX_DECLARATION_CHARS && entry.members.size > 0) {
        return renderMemberIndex(entry);
    }
    return `// ${entry.kind} ${entry.name}\n${entry.text}\n`;
}

/** Signature line + member listing for a class too large to inline. */
function renderMemberIndex(entry: SymbolEntry): string {
    const signature = entry.text
        .split("\n")
        .find((l) => l.includes(entry.name) && !l.trim().startsWith("*"))
        ?.trim() ?? `${entry.kind} ${entry.name}`;
    const members = [...entry.members.values()]
        .map((m) => `  ${m.kind} ${m.name}`)
        .join("\n");
    return (
        `// ${entry.kind} ${entry.name} — ${entry.chars} chars, too large to inline.\n` +
        `${signature}\n\n` +
        `// Members (${entry.members.size}). Request one with ` +
        `lookup_type({ symbol: "${entry.name}.<member>" }):\n${members}\n`
    );
}

/**
 * List declared symbols, optionally filtered by name prefix and kind.
 * The discovery counterpart to {@link lookupType} — cheap enough that the
 * model can browse the SDK surface without loading any declarations.
 */
export function listSymbols(
    index: TypeIndex,
    opts: { prefix?: string; kind?: string; limit?: number } = {},
): string {
    const prefix = opts.prefix?.trim().toLowerCase() ?? "";
    const kind = opts.kind?.trim().toLowerCase();
    const limit = Math.min(
        MAX_SYMBOL_LIMIT,
        Math.max(1, Math.floor(opts.limit ?? DEFAULT_SYMBOL_LIMIT)),
    );

    const matches = [...index.symbols.values()].filter((entry) => {
        if (kind && entry.kind !== kind) return false;
        if (!prefix) return true;
        const lower = entry.name.toLowerCase();
        // Match the `Node`-stripped alias too, so a "warehouse" prefix finds
        // `NodeWarehouseClient`.
        return (
            lower.includes(prefix) ||
            (lower.startsWith("node") && lower.slice(4).includes(prefix))
        );
    });

    if (matches.length === 0) {
        return `No symbols matched${prefix ? ` prefix '${opts.prefix}'` : ""}${kind ? ` kind '${opts.kind}'` : ""}.`;
    }

    matches.sort((a, b) => a.name.localeCompare(b.name));
    const shown = matches.slice(0, limit);
    const lines = shown.map((entry) => {
        const memberCount = entry.members.size > 0 ? ` (${entry.members.size} members)` : "";
        return `${entry.kind} ${entry.name}${memberCount}${entry.doc ? ` — ${entry.doc}` : ""}`;
    });
    const more = matches.length - shown.length;
    return (
        lines.join("\n") +
        (more > 0 ? `\n…and ${more} more — narrow with a longer prefix or a 'kind'.` : "") +
        `\n\n// Get an exact declaration with lookup_type({ symbol: "<name>" }).`
    );
}

/**
 * Symbol names matching a free-text query, used to enrich `search_docs`
 * results with SDK pointers. Returns names only — the caller is expected to
 * follow up with {@link lookupType} for anything it actually needs.
 */
export function searchSymbols(index: TypeIndex, query: string, limit = 8): string[] {
    const terms = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2);
    if (terms.length === 0) return [];

    const scored: Array<{ name: string; score: number }> = [];
    for (const entry of index.symbols.values()) {
        const lower = entry.name.toLowerCase();
        let score = 0;
        for (const term of terms) {
            if (lower === term) score += 5;
            else if (lower.includes(term)) score += 2;
        }
        for (const member of entry.members.keys()) {
            const memberLower = member.toLowerCase();
            for (const term of terms) {
                if (memberLower === term) score += 4;
                else if (memberLower.includes(term)) score += 1;
            }
        }
        if (score > 0) scored.push({ name: entry.name, score });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.slice(0, limit).map((s) => s.name);
}
