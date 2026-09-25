// @ts-check
import * as esbuild from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

import * as fs from "fs";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Resolve a bare path to a file, trying .ts and /index.ts suffixes. */
function resolveTs(base) {
  // Try the file-with-extension candidates BEFORE the bare path, and only
  // accept a candidate that is an actual file. Otherwise a sibling directory
  // of the same name (e.g. `chatParticipant/` next to `chatParticipant.ts`)
  // wins via `existsSync` and esbuild tries to read the directory as a file.
  for (const candidate of [`${base}.ts`, `${base}.tsx`, base, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return base;
}

/** @type {esbuild.Plugin} */
const aliasPlugin = {
  name: "alias-at",
  setup(build) {
    // Resolve @/* → src/*
    build.onResolve({ filter: /^@\// }, (args) => ({
      path: resolveTs(path.resolve(__dirname, "src", args.path.slice(2))),
    }));

    // Rewrite "data-integration" → "../assets/data-integration.js" (external)
    // At runtime, CJS require resolves relative to dist/extension.js,
    // so ../assets/data-integration.js → <extensionPath>/assets/data-integration.js
    build.onResolve({ filter: /^data-integration$/ }, () => ({
      path: "../assets/data-integration.js",
      external: true,
    }));
  },
};

/** @type {esbuild.Plugin} */
const typecheckPlugin = {
  name: "typecheck",
  setup(build) {
    build.onStart(() => {
      try {
        execSync("tsc --noEmit", { cwd: __dirname, stdio: "inherit" });
      } catch {
        return { errors: [{ text: "TypeScript type check failed. Fix errors above." }] };
      }
    });
  },
};

/** @type {esbuild.BuildOptions} */
const extensionBuildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  plugins: [typecheckPlugin, aliasPlugin],
};

/** @type {esbuild.BuildOptions} */
const workerBuildOptions = {
  entryPoints: ["src/services/vm/sandbox-worker.ts"],
  bundle: true,
  outfile: "dist/sandbox-worker.js",
  external: [],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  plugins: [aliasPlugin],
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context({
      ...extensionBuildOptions,
      plugins: [
        ...extensionBuildOptions.plugins,
        {
          name: "watch-log",
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length > 0) {
                console.log(`[esbuild] Build failed with ${result.errors.length} error(s).`);
              } else {
                console.log("[esbuild] Extension build complete.");
              }
            });
          },
        },
      ],
    });
    await ctx.watch();

    // Also watch the worker
    const workerCtx = await esbuild.context({
      ...workerBuildOptions,
      plugins: [
        ...workerBuildOptions.plugins,
        {
          name: "watch-log-worker",
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length > 0) {
                console.log(`[esbuild] Worker build failed with ${result.errors.length} error(s).`);
              } else {
                console.log("[esbuild] Worker build complete.");
              }
            });
          },
        },
      ],
    });
    await workerCtx.watch();
  } else {
    await Promise.all([
      esbuild.build(extensionBuildOptions),
      esbuild.build(workerBuildOptions),
    ]);
    console.log("[esbuild] Build complete.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
