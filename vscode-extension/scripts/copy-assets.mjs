/**
 * Copy assets from the installed SDK into the extension's assets/ folder.
 *
 * Run: node scripts/copy-assets.mjs
 */
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, "..");
const require = createRequire(import.meta.url);
const addonDir = dirname(require.resolve("data-integration"));
const sdkRoot = dirname(addonDir);
const assets = join(extRoot, "assets");
const target = process.env.FABRIC_DATA_FACTORY_TARGET || `${process.platform}-${process.arch}`;
const addonCandidates = [
  "di-addon.win32-x64-msvc.node",
  "di-addon.win32-arm64-msvc.node",
  "di-addon.linux-x64-gnu.node",
  "di-addon.linux-arm64-gnu.node",
  "di-addon.darwin-x64.node",
  "di-addon.darwin-arm64.node",
];
const addonFile = addonCandidates.find(
  name => name === `di-addon.${target}.node` || name === `di-addon.${target}-msvc.node` || name === `di-addon.${target}-gnu.node`,
);
if (!addonFile || !existsSync(join(addonDir, addonFile))) {
  throw new Error(`The installed data-integration package has no native addon for ${target}. Install a tarball built for this target.`);
}

// ── Helper: recursively copy a directory ──
function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy a directory so the destination is an EXACT mirror of the source,
 * deleting anything that no longer exists upstream.
 *
 * `copyDirSync` only ever adds and overwrites, so a renamed or deleted source
 * file lingers in `assets/` forever. For the reference corpus that is not
 * cosmetic: the chat participant enumerates `assets/references/*.md`, so a
 * deleted doc would keep appearing in the docs map and keep being loadable,
 * and its stale bytes would break the `index.json` freshness hash. Use this for
 * any directory that is purely a generated mirror.
 */
function mirrorDirSync(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  copyDirSync(src, dest);
}

mkdirSync(assets, { recursive: true });

// ── index.d.ts → assets/data-integration.d.ts ──
const dtsSource = join(addonDir, "index.d.ts");
copyFileSync(dtsSource, join(assets, "data-integration.d.ts"));
console.log("✓ data-integration.d.ts");

// ── SKILL.md → assets/SKILL.md ──
const skillSource = join(sdkRoot, "SKILL.md");
copyFileSync(skillSource, join(assets, "SKILL.md"));
console.log("✓ SKILL.md");

// ── references/ → assets/references/ ──
// Per-client reference markdown loaded on-demand by the chat participant,
// plus the `index.json` section catalog it slices them with.
const referencesSource = join(sdkRoot, "references");
const referencesDest = join(assets, "references");
verifyReferenceIndex(referencesSource);
mirrorDirSync(referencesSource, referencesDest);
const count = readdirSync(referencesSource).filter(f => f.endsWith(".md")).length;
console.log(`✓ references/ (${count} reference files → assets/references/)`);

/**
 * Verify the copied `index.json` still matches the markdown beside it.
 *
 * The catalog — which sections exist, and the line ranges the extension
 * slices them out of — is produced by `cargo xtask refs-index` and committed
 * with the docs. It is deliberately NOT regenerated here: reimplementing the
 * heading walk in JavaScript is how the two copies drift, and a drifted
 * section id fails silently at runtime as "unknown section" rather than at
 * build time.
 *
 * So this only checks freshness, via the `sourceHash` the generator publishes
 * (FNV-1a over each `<filename>\0<contents>\0`, files sorted by name — see
 * `Fnv1a` in `xtask/src/refs_index.rs`). Editing a reference without
 * regenerating fails the build here, naming the command that fixes it.
 */
function verifyReferenceIndex(dir) {
  const indexPath = join(dir, "index.json");
  if (!existsSync(indexPath)) {
    console.error(
      "✗ references/index.json is missing.\n" +
      "   Regenerate it in the SDK source with cargo xtask refs-index, then rebuild and reinstall the SDK tarball.",
    );
    process.exit(1);
  }

  const index = JSON.parse(readFileSync(indexPath, "utf-8"));
  const actual = hashReferenceSources(dir);
  if (index.sourceHash !== actual) {
    console.error(
      "✗ references/index.json is stale — the markdown changed after it was generated.\n" +
      `   expected sourceHash ${actual}, found ${index.sourceHash}\n` +
      "   Regenerate it in the SDK source with cargo xtask refs-index, then rebuild and reinstall the SDK tarball.",
    );
    process.exit(1);
  }

  const sectionCount = index.docs.reduce((n, d) => n + d.sections.length, 0);
  console.log(`✓ references/index.json verified (${index.docs.length} docs, ${sectionCount} sections)`);
}

/** FNV-1a (64-bit) over the reference sources — mirrors `Fnv1a` in `refs_index.rs`. */
function hashReferenceSources(dir) {
  const MASK = (1n << 64n) - 1n;
  const PRIME = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  const update = (bytes) => {
    for (const byte of bytes) {
      hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
    }
  };
  const zero = Uint8Array.of(0);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
    update(Buffer.from(file, "utf-8"));
    update(zero);
    // CRLF is normalized away so a Windows checkout (`core.autocrlf=true`)
    // hashes the same bytes as CI — matches `read_normalized` in refs_index.rs.
    update(Buffer.from(readFileSync(join(dir, file), "utf-8").replaceAll("\r\n", "\n"), "utf-8"));
    update(zero);
  }
  return hash.toString(16).padStart(16, "0");
}

// ── prompts/ → assets/prompts/ ──
// The @di system prompt, kept as markdown rather than a TypeScript template
// literal so it is reviewable in diffs and editable without escaping every
// backtick. See src/chats/chatParticipant/systemPrompt.ts.
const promptsSource = join(extRoot, "prompts");
const promptsDest = join(assets, "prompts");
if (existsSync(promptsSource)) {
  mirrorDirSync(promptsSource, promptsDest);
  verifyCorePrompt(join(promptsDest, "core.md"));
}

/**
 * Budget gate for the core system prompt.
 *
 * The prompt is `messages[0]` and is re-sent on every round of the agent loop,
 * so it competes directly with tool results for the context window — a bloated
 * prompt makes `compactIfNeeded` evict the actual evidence sooner. It also grew
 * to ~46 KB precisely because appending a paragraph was the cheapest fix for any
 * model misbehaviour and nobody saw the running total.
 *
 * So the total is enforced here. Crossing it should be a deliberate decision:
 * the usual right answer is to move explanatory material into
 * `xtask/assets/references/` where `search_docs` can retrieve it on demand.
 */
function verifyCorePrompt(corePath) {
  const BUDGET = 12_000;
  if (!existsSync(corePath)) {
    console.error("✗ prompts/core.md is missing — the @di agent would run with no system prompt.");
    process.exit(1);
  }
  const text = readFileSync(corePath, "utf-8");
  if (!text.includes("{{DOCS_MAP}}")) {
    console.error("✗ prompts/core.md has no {{DOCS_MAP}} placeholder — the model would get no documentation index.");
    process.exit(1);
  }
  if (text.length > BUDGET) {
    console.error(
      `✗ prompts/core.md is ${text.length} chars, over the ${BUDGET} budget.\n` +
      "   Move reference material into xtask/assets/references/ (retrieved on demand\n" +
      "   via search_docs) instead of growing the always-resident prompt.",
    );
    process.exit(1);
  }
  const pct = Math.round((text.length / BUDGET) * 100);
  console.log(`✓ prompts/ (core.md ${text.length}/${BUDGET} chars, ${pct}% of budget)`);
}

// ── Node loader (index.js) → assets/data-integration.js ──
// This is the napi-rs generated loader that does platform detection
// and require('./di-addon.<platform>.node').
const loaderSource = join(addonDir, "index.js");
copyFileSync(loaderSource, join(assets, "data-integration.js"));
console.log("✓ data-integration.js");

// ── Native addon (.node) ──
for (const candidate of addonCandidates) {
  if (candidate !== addonFile) {
    rmSync(join(assets, candidate), { force: true });
  }
}
copyFileSync(join(addonDir, addonFile), join(assets, addonFile));
console.log(`✓ ${addonFile}`);

// ── @types/node → assets/types_node/ ──
// Bundled so the notebook language service has Node.js types
// without depending on node_modules at runtime.
const nodeTypesSource = join(extRoot, "node_modules", "@types", "node");
const nodeTypesDest = join(assets, "types_node");
if (existsSync(nodeTypesSource)) {
  copyDirSync(nodeTypesSource, nodeTypesDest);
  const count = readdirSync(nodeTypesSource).filter(f => f.endsWith(".d.ts")).length;
  console.log(`✓ @types/node (${count} root .d.ts files → assets/types_node/)`);
} else {
  console.warn("⚠ @types/node not found in node_modules. Node.js types will not be available.");
}

// ── TypeScript lib.*.d.ts → assets/ts_lib/ ──
// The TS language service needs these for base type definitions (ES2022 etc.).
const tsLibSource = join(extRoot, "node_modules", "typescript", "lib");
const tsLibDest = join(assets, "ts_lib");
mkdirSync(tsLibDest, { recursive: true });
if (existsSync(tsLibSource)) {
  let libCount = 0;
  for (const entry of readdirSync(tsLibSource)) {
    if (entry.startsWith("lib.") && entry.endsWith(".d.ts")) {
      copyFileSync(join(tsLibSource, entry), join(tsLibDest, entry));
      libCount++;
    }
  }
  console.log(`✓ TypeScript lib files (${libCount} files → assets/ts_lib/)`);
} else {
  console.warn("⚠ TypeScript lib files not found. Language service will not work.");
}

console.log("\nAssets directory:", assets);
