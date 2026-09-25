/**
 * Package the VS Code extension into platform-specific VSIX files.
 *
 * Each VSIX contains only the native addon for its target platform,
 * keeping download size small.
 *
 * Usage:
 *   node scripts/package-vsix.mjs                      # build all available platforms
 *   node scripts/package-vsix.mjs win32-x64             # build a single platform
 *   node scripts/package-vsix.mjs win32-x64 linux-x64   # build specific platforms
 *
 * Prerequisites:
 *   - Run `cargo xtask build` first to produce the .node addons in crates/addon/.
 */

import { existsSync, mkdirSync, rmSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, "..");
const repoRoot = join(extRoot, "..");
const addonDir = join(repoRoot, "crates", "addon");
const assets = join(extRoot, "assets");
const outDir = join(extRoot, "vsix");

/**
 * Maps VS Code platform targets to the napi-rs addon file name produced by
 * `cargo xtask build` / `npx napi build --platform --target <triple>`.
 */
const PLATFORMS = {
  "win32-x64":    "di-addon.win32-x64-msvc.node",
  "linux-x64":    "di-addon.linux-x64-gnu.node",
  "linux-arm64":  "di-addon.linux-arm64-gnu.node",
  "darwin-x64":   "di-addon.darwin-x64.node",
  "darwin-arm64": "di-addon.darwin-arm64.node",
};

// ── Parse CLI args ──────────────────────────────────────────────────────────
const requestedPlatforms = process.argv.slice(2);
const platformsToBuild =
  requestedPlatforms.length > 0
    ? requestedPlatforms
    : Object.keys(PLATFORMS);

// ── Build a VSIX per platform ───────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });

let built = 0;
let skipped = 0;

for (const platform of platformsToBuild) {
  const addonFile = PLATFORMS[platform];
  if (!addonFile) {
    console.error(`✗ Unknown platform: ${platform}`);
    console.error(`  Valid platforms: ${Object.keys(PLATFORMS).join(", ")}`);
    process.exit(1);
  }

  const addonSrc = join(addonDir, addonFile);
  if (!existsSync(addonSrc)) {
    console.warn(`⚠ Skipping ${platform} — addon not found: ${addonFile}`);
    console.warn(`  Build it first: cargo xtask build --target <rust-triple>`);
    skipped++;
    continue;
  }

  // Clean assets/ and run copy-assets to populate with shared files,
  // then drop in the platform-specific addon.
  rmSync(assets, { recursive: true, force: true });
  execSync("node scripts/copy-assets.mjs", { cwd: extRoot, stdio: "inherit" });

  // Ensure only THIS platform's addon is in assets/
  // (copy-assets copies whichever .node it finds first on the current machine,
  //  but for cross-platform packaging we overwrite with the correct one)
  for (const other of Object.values(PLATFORMS)) {
    const f = join(assets, other);
    if (existsSync(f) && other !== addonFile) {
      rmSync(f);
    }
  }
  if (!existsSync(join(assets, addonFile))) {
    copyFileSync(addonSrc, join(assets, addonFile));
  }

  const vsixName = `fabric-data-factory-${platform}.vsix`;
  const vsixPath = join(outDir, vsixName);

  console.log(`\n── Packaging ${platform} ──`);
  console.log(`  addon: ${addonFile}`);
  console.log(`  vsix:  ${vsixName}`);

  try {
    const result = execSync(
      [
        "npx", "@vscode/vsce", "package",
        "--target", platform,
        "--allow-missing-repository",
        "--no-dependencies",
        "--skip-license",
        "--out", vsixPath,
      ].join(" "),
      { cwd: extRoot, input: "y\n", stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
    );
    // Print stdout, filtering out the large-file warning
    const lines = result.split("\n").filter(
      (l) => !l.includes("is large (") && !l.includes("Do you want to continue?"),
    );
    if (lines.length) console.log(lines.join("\n"));
    built++;
  } catch (err) {
    // execSync throws on non-zero exit; print captured output minus the warning
    const out = (err.stdout || "") + (err.stderr || "");
    const filtered = out.split("\n").filter(
      (l) => !l.includes("is large (") && !l.includes("Do you want to continue?"),
    ).join("\n").trim();
    if (filtered) console.error(filtered);
    console.error(`✗ Failed to package ${platform}`);
    process.exit(1);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`Built: ${built}  Skipped: ${skipped}`);
if (built > 0) {
  console.log(`VSIX files are in: ${outDir}/`);
}
