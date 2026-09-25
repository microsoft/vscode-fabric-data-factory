/**
 * Section-level index over the shipped API reference markdown
 * (`assets/references/*.md`), backing the `@di` chat participant's
 * `search_docs` / `load_reference` tools.
 *
 * **Why sections instead of whole files.** The references are curated per
 * client and grow with the SDK — `pipeline-client.md` alone is ~71 KB
 * (~18k tokens) and the full set is ~332 KB (~83k tokens). Returning a whole
 * document to answer "what are the args to `createCopyActivityBuilder`?"
 * burns most of the model's context on prose it will never use, and that
 * cost is re-paid on every subsequent round because the tool result stays in
 * the message history. So the tools work search → narrow → load:
 *
 *   1. {@link searchDocs} ranks *sections* against a query (BM25).
 *   2. {@link loadDoc} returns one section, or a table of contents for an
 *      oversized doc, or the whole thing when it's small (or `full` is set).
 *
 * **This module does not decide where sections begin and end.** That split is
 * computed once, by `xtask/src/refs_index.rs`, and published as line ranges in
 * `assets/references/index.json`; here we just slice the markdown by those
 * ranges. Chunking independently would mean two implementations of the same
 * heading walk, and any disagreement between them would produce section ids
 * that exist for one consumer and not the other — a class of bug that fails
 * silently, at runtime, as "unknown section". Regenerate the catalog with
 * `cargo xtask refs-index`.
 *
 * Loading is lazy and cached — the corpus is a few hundred KB, so the first
 * search costs single-digit milliseconds and every later call is a map lookup.
 */

import * as fs from "fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { log } from "@/utils/channel_log";

// ── Tunables ─────────────────────────────────────────────────

/**
 * A document at or below this size is returned whole by `load_reference`
 * when no `section` is given — below this, a table of contents plus a
 * follow-up round-trip costs more than just handing over the content.
 */
const WHOLE_DOC_BUDGET_CHARS = 8_000;

/** Hard cap on the markdown returned for a single section load. */
const MAX_SECTION_RESULT_CHARS = 12_000;

/**
 * Hard cap for an explicit `full: true` load. Deliberately generous (it's
 * the documented escape hatch) but still bounded, so no single tool call
 * can blow the context window.
 */
const MAX_FULL_DOC_CHARS = 40_000;

/** Default / maximum number of hits returned by `search_docs`. */
const DEFAULT_SEARCH_HITS = 6;
const MAX_SEARCH_HITS = 20;

/** Max characters of surrounding text quoted per search hit. */
const SNIPPET_CHARS = 320;

/** BM25 free parameters (standard defaults). */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/**
 * Floor applied to a section's length during BM25 normalization, as a
 * fraction of the corpus mean.
 *
 * BM25 rewards short documents, which backfires here: a two-line stub like
 * "### Branch Builders" would outrank the substantive section that actually
 * explains the API, purely because its heading matched and it had almost no
 * other text to dilute the score. Clamping the effective length keeps
 * genuinely concise sections competitive without letting stubs dominate.
 */
const BM25_MIN_LENGTH_RATIO = 0.4;

/**
 * How many times a section's own heading trail is repeated in its term
 * vector. A query is nearly always a symbol or a heading phrase ("copy
 * activity builder", "queryRows"), so matching there is far more
 * informative than matching the same word buried in prose.
 */
const HEADING_TOKEN_WEIGHT = 4;

/**
 * Weight for the owning document's title. Lower than the section heading
 * because it is identical for every section of a document — useful for
 * routing a query to the right *file*, useless for choosing between that
 * file's sections, and actively harmful at a high weight (it would let an
 * arbitrary short section win on length normalization alone).
 */
const DOC_TITLE_TOKEN_WEIGHT = 2;

/**
 * Weight for a `symbols` entry from the catalog — applied only to sections
 * that actually mention that symbol, never to the whole document. Boosting
 * every section with the doc's full symbol list would make the strongest
 * signal in the index completely non-discriminative within a file.
 */
const SYMBOL_TOKEN_WEIGHT = 3;

// ── Catalog shape (mirrors xtask/src/refs_index.rs) ──────────

/** Catalog schema version this reader understands. */
const SUPPORTED_SCHEMA = 2;

interface CatalogSection {
    id: string;
    title: string;
    headingPath: string;
    level: number;
    /** Half-open line range into the raw `.md` file, frontmatter included. */
    startLine: number;
    endLine: number;
    chars: number;
}

interface CatalogDoc {
    name: string;
    title: string;
    summary: string;
    symbols: string[];
    chars: number;
    sections: CatalogSection[];
}

interface Catalog {
    schema: number;
    sourceHash: string;
    docs: CatalogDoc[];
}

// ── Types ────────────────────────────────────────────────────

/** One addressable chunk of a reference document. */
export interface DocSection {
    /** Slug unique within the owning document, e.g. `"querying-rows"`. */
    id: string;
    /** Fully-qualified reference, e.g. `"warehouse-client#querying-rows"`. */
    ref: string;
    /** Owning document name (filename without `.md`). */
    doc: string;
    /** Heading trail within the doc, e.g. `"Querying > queryRows()"`. */
    headingPath: string;
    /** Markdown heading depth this section starts at (1–4). */
    level: number;
    /** The section's own heading text. */
    title: string;
    /** Section body, including its heading line. */
    text: string;
    /** `text.length`, precomputed for budgeting. */
    chars: number;
    /** Term frequencies used for BM25 (heading/symbol tokens up-weighted). */
    terms: Map<string, number>;
    /** Total weighted token count (BM25 document length). */
    tokenCount: number;
}

/** One reference document: catalog metadata plus its sections. */
export interface DocEntry {
    /** Filename without `.md`, e.g. `"warehouse-client"`. */
    name: string;
    /** `# ` title line, e.g. `"WarehouseClient — Fabric Warehouse over TDS"`. */
    title: string;
    /** One-line summary from the document's frontmatter. */
    summary: string;
    /** The SDK names this document covers. */
    symbols: string[];
    /** Document size in characters, excluding frontmatter. */
    chars: number;
    /** Ordered sections; always at least one. */
    sections: DocSection[];
}

/** The loaded corpus plus the BM25 statistics derived from it. */
export interface DocsIndex {
    docs: Map<string, DocEntry>;
    sections: DocSection[];
    /** Document frequency per term across all sections. */
    df: Map<string, number>;
    /** Mean weighted token count across all sections. */
    avgTokenCount: number;
}

/** A single ranked result from {@link searchDocs}. */
export interface DocHit {
    ref: string;
    doc: string;
    headingPath: string;
    chars: number;
    score: number;
    snippet: string;
}

// ── Tokenization ─────────────────────────────────────────────

/**
 * Split text into search tokens.
 *
 * Emits the whole identifier *and* its camelCase / snake_case parts, so a
 * query for `queryRows` matches a doc that only writes `query_rows`, and a
 * query for "rows" matches `queryRows`. Single characters are dropped as
 * noise.
 */
function tokenize(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.split(/[^A-Za-z0-9_]+/)) {
        if (!raw) continue;
        const lower = raw.toLowerCase();
        if (lower.length > 1) out.push(lower);
        const parts = raw
            .split(/_+/)
            .flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/));
        if (parts.length > 1) {
            for (const part of parts) {
                const lp = part.toLowerCase();
                if (lp.length > 1 && lp !== lower) out.push(lp);
            }
        }
    }
    return out;
}

/**
 * Loose normalization used only to *match* a section reference the model
 * supplied against a known id — never to mint one. Ids come from the
 * catalog; see this module's header for why they aren't derived here.
 */
function normalizeRef(text: string): string {
    return text
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

// ── Index construction ───────────────────────────────────────

let cachedIndex: DocsIndex | undefined;

/** Absolute path of the shipped `assets/references` folder. */
function referencesDir(extensionUri: vscode.Uri): string {
    return vscode.Uri.joinPath(extensionUri, "assets", "references").fsPath;
}

/**
 * Load the section catalog and slice each document into its sections.
 * Cached for the life of the extension host — the corpus ships inside the
 * VSIX and cannot change at runtime.
 */
export function loadDocsIndex(extensionUri: vscode.Uri): DocsIndex {
    if (cachedIndex) return cachedIndex;

    const dir = referencesDir(extensionUri);
    const docs = new Map<string, DocEntry>();
    const sections: DocSection[] = [];

    for (const catalogDoc of readCatalog(dir)) {
        const raw = readDoc(dir, catalogDoc.name);
        if (raw === undefined) continue;
        const lines = raw.split("\n");

        const docSections: DocSection[] = [];
        for (const cs of catalogDoc.sections) {
            const text = lines.slice(cs.startLine, cs.endLine).join("\n").trim();
            if (!text) continue;
            docSections.push(
                buildSection(catalogDoc, cs, text),
            );
        }
        if (docSections.length === 0) continue;

        docs.set(catalogDoc.name, {
            name: catalogDoc.name,
            title: catalogDoc.title,
            summary: catalogDoc.summary,
            symbols: catalogDoc.symbols,
            chars: catalogDoc.chars,
            sections: docSections,
        });
        sections.push(...docSections);
    }

    // BM25 corpus statistics.
    const df = new Map<string, number>();
    let totalTokens = 0;
    for (const section of sections) {
        totalTokens += section.tokenCount;
        for (const term of section.terms.keys()) {
            df.set(term, (df.get(term) ?? 0) + 1);
        }
    }

    cachedIndex = {
        docs,
        sections,
        df,
        avgTokenCount: sections.length > 0 ? totalTokens / sections.length : 1,
    };
    return cachedIndex;
}

/** Drop the cached index (hot-reload safety valve). */
export function resetDocsIndex(): void {
    cachedIndex = undefined;
}

/**
 * Read `index.json`, or fall back to a whole-file-per-document catalog.
 *
 * The fallback exists so a packaging slip degrades the docs tools instead of
 * breaking them: the agent can still load a reference, just not a section of
 * one. It is not a second chunker — it deliberately produces one section per
 * file rather than guessing at boundaries the catalog owns.
 */
function readCatalog(dir: string): CatalogDoc[] {
    try {
        const catalog = JSON.parse(
            fs.readFileSync(path.join(dir, "index.json"), "utf-8"),
        ) as Catalog;
        if (catalog.schema !== SUPPORTED_SCHEMA) {
            log(`[di-chat] references/index.json schema ${catalog.schema} != ${SUPPORTED_SCHEMA} — regenerate with 'cargo xtask refs-index'`);
        }
        if (Array.isArray(catalog.docs) && catalog.docs.length > 0) {
            return catalog.docs;
        }
        log("[di-chat] references/index.json has no documents — falling back to whole files");
    } catch (e) {
        log(`[di-chat] references/index.json unreadable (${e instanceof Error ? e.message : String(e)}) — falling back to whole files`);
    }
    return wholeFileCatalog(dir);
}

/** Degraded catalog: every reference is a single unsplit section. */
function wholeFileCatalog(dir: string): CatalogDoc[] {
    let files: string[];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
        return [];
    }
    const docs: CatalogDoc[] = [];
    for (const file of files) {
        const name = file.replace(/\.md$/i, "");
        const raw = readDoc(dir, name);
        if (raw === undefined) continue;
        const lineCount = raw.split("\n").length;
        const title = /^#\s+(.+)$/m.exec(raw)?.[1].trim() ?? name;
        docs.push({
            name,
            title,
            summary: "",
            symbols: [],
            chars: raw.length,
            sections: [{
                id: "overview",
                title: "Overview",
                headingPath: "Overview",
                level: 1,
                startLine: 0,
                endLine: lineCount,
                chars: raw.length,
            }],
        });
    }
    return docs;
}

/** Read one reference's raw markdown, or `undefined` if unreadable. */
function readDoc(dir: string, name: string): string | undefined {
    try {
        return fs.readFileSync(path.join(dir, `${name}.md`), "utf-8");
    } catch {
        return undefined;
    }
}

/** Build the searchable {@link DocSection} for one catalog entry. */
function buildSection(doc: CatalogDoc, cs: CatalogSection, text: string): DocSection {
    const terms = new Map<string, number>();
    let tokenCount = 0;
    const add = (tokens: string[], weight: number) => {
        for (const t of tokens) {
            terms.set(t, (terms.get(t) ?? 0) + weight);
            tokenCount += weight;
        }
    };
    add(tokenize(text), 1);
    add(tokenize(cs.headingPath), HEADING_TOKEN_WEIGHT);
    add(tokenize(doc.title), DOC_TITLE_TOKEN_WEIGHT);
    // Only symbols this section actually mentions — see SYMBOL_TOKEN_WEIGHT.
    const lowerText = text.toLowerCase();
    const mentioned = doc.symbols.filter((s) => lowerText.includes(s.toLowerCase()));
    if (mentioned.length > 0) add(tokenize(mentioned.join(" ")), SYMBOL_TOKEN_WEIGHT);

    return {
        id: cs.id,
        ref: `${doc.name}#${cs.id}`,
        doc: doc.name,
        headingPath: cs.headingPath || cs.title,
        level: cs.level,
        title: cs.title,
        text,
        chars: text.length,
        terms,
        tokenCount,
    };
}

// ── Search ───────────────────────────────────────────────────

/**
 * Rank sections against `query` with BM25, optionally restricted to a
 * single document via `scope`.
 *
 * BM25 (not embeddings) is the right tool here: queries against API docs
 * are overwhelmingly symbol names and heading phrases, where exact lexical
 * overlap is the signal. It also needs no model, no build step, and is
 * deterministic — so the same query always yields the same context.
 */
export function searchDocs(
    index: DocsIndex,
    query: string,
    opts: { scope?: string; k?: number } = {},
): DocHit[] {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0) return [];

    const scope = opts.scope?.trim().replace(/\.md$/i, "");
    const pool = scope
        ? index.sections.filter((s) => s.doc === scope)
        : index.sections;
    const k = Math.min(MAX_SEARCH_HITS, Math.max(1, Math.floor(opts.k ?? DEFAULT_SEARCH_HITS)));
    const n = index.sections.length || 1;

    const scored: DocHit[] = [];
    for (const section of pool) {
        const effectiveLength = Math.max(
            section.tokenCount,
            index.avgTokenCount * BM25_MIN_LENGTH_RATIO,
        );
        let score = 0;
        for (const term of queryTerms) {
            const tf = section.terms.get(term);
            if (!tf) continue;
            const dfT = index.df.get(term) ?? 0;
            const idf = Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5));
            const norm =
                BM25_K1 * (1 - BM25_B + (BM25_B * effectiveLength) / index.avgTokenCount);
            score += idf * ((tf * (BM25_K1 + 1)) / (tf + norm));
        }
        if (score <= 0) continue;
        scored.push({
            ref: section.ref,
            doc: section.doc,
            headingPath: section.headingPath,
            chars: section.chars,
            score: Math.round(score * 100) / 100,
            snippet: buildSnippet(section, queryTerms),
        });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}

/**
 * Quote the most query-relevant window of a section.
 *
 * Picks the line with the highest count of distinct query terms and returns
 * it with one line of context either side — enough for the model to judge
 * whether the section is worth loading, without paying for the section.
 */
function buildSnippet(section: DocSection, queryTerms: string[]): string {
    const lines = section.text.split("\n");
    const wanted = new Set(queryTerms);
    let bestLine = 0;
    let bestScore = -1;
    for (let i = 0; i < lines.length; i++) {
        const hits = new Set(tokenize(lines[i]).filter((t) => wanted.has(t)));
        if (hits.size > bestScore) {
            bestScore = hits.size;
            bestLine = i;
        }
    }
    const from = Math.max(0, bestLine - 1);
    const window = lines.slice(from, from + 3).join("\n").trim();
    return window.length > SNIPPET_CHARS
        ? window.slice(0, SNIPPET_CHARS) + "…"
        : window;
}

// ── Loading ──────────────────────────────────────────────────

/** Result of a {@link loadDoc} call: markdown plus what was actually served. */
export interface LoadResult {
    text: string;
    /** `"section" | "toc" | "whole" | "full" | "error"` — for logging/UI. */
    kind: "section" | "toc" | "whole" | "full" | "error";
}

/**
 * Serve a reference document at the right granularity.
 *
 * - `section` given → just that chunk.
 * - no `section`, doc fits the budget → the whole doc.
 * - no `section`, doc is large → a table of contents, so the agent can pick
 *   a chunk instead of swallowing 18k tokens of prose.
 * - `full: true` → the whole doc regardless of size (bounded escape hatch).
 */
export function loadDoc(
    index: DocsIndex,
    rawName: string,
    opts: { section?: string; full?: boolean } = {},
): LoadResult {
    // Accept `name`, `name.md`, `references/name`, and `name#section`.
    let name = String(rawName ?? "")
        .replace(/\\/g, "/")
        .replace(/^references\//, "")
        .replace(/\.md$/i, "")
        .trim();
    let section = opts.section?.trim();
    const hashAt = name.indexOf("#");
    if (hashAt !== -1) {
        section = section || name.slice(hashAt + 1);
        name = name.slice(0, hashAt);
    }

    if (!name || name.includes("/") || name.includes("..")) {
        return {
            kind: "error",
            text: `Error: invalid reference name '${rawName}'. Use a bare name like 'onelake-client'.`,
        };
    }

    const doc = index.docs.get(name);
    if (!doc) {
        const available = [...index.docs.keys()].join(", ");
        return {
            kind: "error",
            text: `Error: unknown reference '${name}'. Available: ${available}.`,
        };
    }

    if (section) {
        const found = findSection(doc, section);
        if (!found) {
            return {
                kind: "error",
                text:
                    `Error: unknown section '${section}' in '${name}'.\n\n` +
                    renderToc(doc),
            };
        }
        return {
            kind: "section",
            text:
                `# ${doc.title} → ${found.headingPath}\n` +
                `_Section \`${found.ref}\` (${found.chars} chars). ` +
                `Other sections: use \`load_reference({ name: "${name}" })\` for the full table of contents._\n\n` +
                truncate(found.text, MAX_SECTION_RESULT_CHARS),
        };
    }

    const whole = doc.sections.map((s) => s.text).join("\n\n");
    if (opts.full) {
        return { kind: "full", text: truncate(whole, MAX_FULL_DOC_CHARS) };
    }
    if (doc.chars <= WHOLE_DOC_BUDGET_CHARS) {
        return { kind: "whole", text: truncate(whole, MAX_SECTION_RESULT_CHARS) };
    }
    return { kind: "toc", text: renderToc(doc) };
}

/**
 * Resolve a user/model-supplied section reference against a document.
 * Tolerant by design — the model will guess ids from the table of contents,
 * from `search_docs` hits, or from a heading it half-remembers, and a
 * near-miss should not cost a wasted round-trip.
 */
function findSection(doc: DocEntry, wanted: string): DocSection | undefined {
    const needle = wanted.replace(/^#/, "").trim();
    const slug = normalizeRef(needle);
    return (
        doc.sections.find((s) => s.id === needle) ??
        doc.sections.find((s) => s.id === slug) ??
        doc.sections.find((s) => s.title.toLowerCase() === needle.toLowerCase()) ??
        doc.sections.find((s) => s.id.startsWith(slug)) ??
        doc.sections.find((s) => s.headingPath.toLowerCase().includes(needle.toLowerCase()))
    );
}

/** Render a document's table of contents (the "too big to inline" response). */
function renderToc(doc: DocEntry): string {
    const rows = doc.sections
        .map((s) => `- \`${s.id}\` — ${s.headingPath} (${s.chars} chars)`)
        .join("\n");
    return (
        `# ${doc.title}\n` +
        (doc.summary ? `\n${doc.summary}\n` : "") +
        `\n_This reference is ${doc.chars} chars — too large to return whole. ` +
        `Load one section with \`load_reference({ name: "${doc.name}", section: "<id>" })\`, ` +
        `search within it via \`search_docs({ query: "…", scope: "${doc.name}" })\`, ` +
        `or pass \`full: true\` if you genuinely need the entire document._\n\n` +
        `## Sections\n${rows}\n` +
        (doc.symbols.length > 0
            ? `\n## Symbols covered\n${doc.symbols.join(", ")}\n` +
              `\n_For exact TypeScript signatures use \`lookup_type({ symbol })\`._\n`
            : "")
    );
}

/** Head+tail truncation with an explicit marker, mirroring `capRunScriptResult`. */
function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    const head = text.slice(0, Math.floor(max * 0.75));
    const tail = text.slice(-Math.floor(max * 0.15));
    return `${head}\n\n…[truncated ${text.length - head.length - tail.length} chars — narrow the request with \`section\` or \`search_docs\`]…\n\n${tail}`;
}

// ── Docs map (system prompt) ─────────────────────────────────

/** Max section ids listed per document in the compact docs map. */
const MAX_MAP_SECTIONS = 10;

/**
 * Render the compact catalog injected once into the system prompt.
 *
 * This is the progressive-disclosure payoff: for ~2 KB the model learns
 * every document, what it covers, and the section ids it can address
 * directly — so the common case becomes a single targeted `load_reference`
 * with no `search_docs` round-trip first.
 */
export function renderDocsMap(index: DocsIndex): string {
    const lines: string[] = [];
    for (const doc of index.docs.values()) {
        const ids = doc.sections.slice(0, MAX_MAP_SECTIONS).map((s) => s.id);
        const more = doc.sections.length - ids.length;
        const sectionList = ids.join(", ") + (more > 0 ? `, …+${more} more` : "");
        lines.push(
            `- **${doc.name}** — ${doc.summary || doc.title}\n` +
            `  sections: ${sectionList}`,
        );
    }
    return lines.join("\n");
}
