/**
 * Assembles the `@di` chat participant's system prompt.
 *
 * # Why the prompt lives in `assets/prompts/`, not in a template literal
 *
 * The prompt used to be a ~500-line template literal inside
 * `chatParticipant.ts`. That made it unreviewable in diffs, hazardous to edit
 * (every backtick and `${` had to be escaped, so a stray character broke the
 * build), and — because appending a paragraph was the cheapest possible fix for
 * any model misbehaviour — it grew without anyone seeing the total. It reached
 * ~46 KB / ~11.5k tokens, re-sent on *every* round of the agent loop.
 *
 * # Layering
 *
 * The prompt now carries only what must be true before the model can act:
 * policy (the Ground Truth rule), the tool contract, the names in scope, and
 * the hard rules. Everything explanatory — the factory list, Node-global traps,
 * the mashup cookbook, the URL-host table — lives in the reference corpus and
 * is retrieved on demand via `search_docs` / `load_reference`. The docs map
 * gives the model the index it needs to do that in one hop.
 *
 * That matters beyond cost: the system prompt competes for the same window as
 * tool results, so every kilobyte here is a kilobyte `compactIfNeeded` has to
 * reclaim later by evicting the actual evidence.
 *
 * # Ordering is load-bearing
 *
 * Sections are emitted stable-first, volatile-last:
 *
 *   [ core.md + docs map ]  ← identical for the life of the installation
 *   [ current state ]       ← changes when Airflow starts / env switches
 *   [ verified facts ]      ← changes whenever a script records an `@fact`
 *
 * Providers cache on a *prefix* match, so a volatile block placed before a
 * stable one invalidates everything after it. Recording one fact would
 * otherwise re-bill the entire prompt that follows it.
 */

import * as fs from "fs";
import * as vscode from "vscode";
import { log } from "@/utils/channel_log";

/**
 * Budget for the static core prompt, in characters. Enforced at build time by
 * `scripts/copy-assets.mjs`; repeated here so a hand-edited install still warns
 * rather than silently regressing.
 *
 * The number is a ceiling, not a target — the point is that crossing it has to
 * be a deliberate decision rather than the accumulated result of a dozen "just
 * one more paragraph" fixes.
 */
const CORE_PROMPT_BUDGET_CHARS = 12_000;

/** Placeholder in `core.md` replaced with the generated documentation map. */
const DOCS_MAP_TOKEN = "{{DOCS_MAP}}";

/** Runtime inputs for {@link buildSystemPrompt}. */
export interface SystemPromptInput {
    extensionUri: vscode.Uri;
    /** Rendered documentation map (reference name → summary → section ids). */
    docsMap: string;
    /** Sandbox globals, used to derive the "Current state" block. */
    globals: ReadonlyMap<string, unknown>;
    /** Rendered verified-facts ledger, or `""` when nothing is recorded. */
    verifiedFacts: string;
}

let cachedCore: string | undefined;

/**
 * Read `assets/prompts/core.md`. Cached for the life of the extension host —
 * it ships inside the VSIX and cannot change at runtime.
 */
function loadCore(extensionUri: vscode.Uri): string {
    if (cachedCore !== undefined) return cachedCore;
    const path = vscode.Uri.joinPath(extensionUri, "assets", "prompts", "core.md").fsPath;
    try {
        cachedCore = fs.readFileSync(path, "utf-8");
        if (cachedCore.length > CORE_PROMPT_BUDGET_CHARS) {
            log(`[di-chat] core prompt is ${cachedCore.length} chars, over the ${CORE_PROMPT_BUDGET_CHARS} budget — move reference material into assets/references/`);
        }
    } catch (e) {
        // Without the prompt the participant would still "work" but with no
        // policy at all, which is worse than a loud failure — surface it.
        log(`[di-chat] FAILED to read assets/prompts/core.md (${e instanceof Error ? e.message : String(e)}) — the agent will run without its system prompt`);
        cachedCore = "";
    }
    return cachedCore;
}

/** Drop the cached core prompt (hot-reload safety valve). */
export function resetSystemPromptCache(): void {
    cachedCore = undefined;
}

/**
 * Describe the live sandbox state the model needs but cannot look up: which
 * Fabric environment is bound and whether a local Airflow is running.
 *
 * Only the resolved *values* go here. The env→host table, URL templates, and
 * the wrong-hostname examples live in the `fabric-environment` reference — this
 * block would otherwise re-inject a static table on every turn.
 */
function renderCurrentState(globals: ReadonlyMap<string, unknown>): string {
    const lines: string[] = [];

    if (globals.has("fabricEnvName")) {
        lines.push(
            `- Active Fabric environment: **${globals.get("fabricEnvName")}**. ` +
            `Build URLs from these hosts — do NOT compose one from the env name ` +
            `(load \`fabric-environment\` for the rules):\n` +
            `    fabricApiHost        = ${globals.get("fabricApiHost")}\n` +
            `    fabricPortalHost     = ${globals.get("fabricPortalHost")}\n` +
            `    fabricOnelakeDfsHost = ${globals.get("fabricOnelakeDfsHost")}`,
        );
    }
    if (globals.has("airflowPort")) {
        lines.push(
            `- Airflow is running locally (port=${globals.get("airflowPort")}, ` +
            `itemFolder=${globals.get("airflowItemFolder")}, ` +
            `version=${globals.get("airflowVersion")})`,
        );
    }

    return lines.length > 0 ? `\n\n## Current state\n\n${lines.join("\n")}` : "";
}

/** Render the verified-facts ledger block, or `""` when the ledger is empty. */
function renderVerifiedFacts(verifiedFacts: string): string {
    if (!verifiedFacts) return "";
    return (
        "\n\n## Verified facts\n\n" +
        "Recorded from earlier tool runs THIS session; each is timestamped. You MAY " +
        "cite these without re-running a tool, but ONLY if the underlying data cannot " +
        "have changed since then — when in doubt, re-verify. Any value NOT listed here " +
        `must be obtained with a tool.\n\n${verifiedFacts}`
    );
}

/**
 * Compose the full system prompt: static core (with the docs map substituted in)
 * followed by the volatile state blocks. See the module header for why that
 * order matters.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
    const core = loadCore(input.extensionUri).replace(DOCS_MAP_TOKEN, input.docsMap);
    return core + renderCurrentState(input.globals) + renderVerifiedFacts(input.verifiedFacts);
}
