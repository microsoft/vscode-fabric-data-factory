/**
 * Starter-notebook builders for query-shaped Fabric items.
 *
 * Each `openXxxNotebook` function:
 *  1. Ensures the per-item notebook folder exists.
 *  2. Writes a starter `query.fabricnb` with cells tailored to the
 *     item type (only if the file doesn't already exist — opening
 *     the item a second time preserves the user's edits).
 *  3. Opens it as a VS Code notebook document.
 *
 * The sandbox pre-injects `fabricItem`, `itemFolder`, and all DI
 * clients (see `services/vm/sandbox-worker.ts`), so cells can refer
 * to them directly without any boilerplate.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type {FabricItem} from "data-integration";
import {log} from "@/utils/channel_log";

// ── Internal shape of a *.fabricnb file ──────────────────────────────────────

interface StarterCell {
    language: "markdown" | "typescript";
    value: string;
}

interface StarterNotebook {
    cells: StarterCell[];
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Write `cells` to `<notebookFolder>/query.fabricnb` if the file does
 * not already exist, then open it. Used by every per-item builder.
 */
async function ensureAndOpenNotebook(
    item: FabricItem,
    notebookFolder: string,
    cells: StarterCell[],
    kindLabel: string,
): Promise<void> {
    fs.mkdirSync(notebookFolder, {recursive: true});

    const notebookPath = path.join(notebookFolder, "query.fabricnb");

    if (!fs.existsSync(notebookPath)) {
        const starter: StarterNotebook = {cells};
        fs.writeFileSync(notebookPath, JSON.stringify(starter, null, 2), "utf-8");
        log(`Created starter notebook: ${notebookPath}`);
    }

    try {
        const uri = vscode.Uri.file(notebookPath);
        const notebook = await vscode.workspace.openNotebookDocument(uri);
        await vscode.window.showNotebookDocument(notebook);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(
            `Failed to open ${kindLabel} notebook for "${item.displayName}": ${msg}`,
        );
    }
}

/** Join an array of strings into a single newline-separated cell body. */
function lines(...parts: string[]): string {
    return parts.join("\n");
}

// ── Lakehouse ────────────────────────────────────────────────────────────────

/**
 * Open a query notebook for a Lakehouse item. Cells exercise the
 * `onelakeClient` API (listFiles, listTables, previewTable, queryView)
 * and demonstrate exporting query results to CSV / JSONL / Parquet.
 */
export async function openLakehouseNotebook(
    item: FabricItem,
    notebookFolder: string,
): Promise<void> {
    const cells: StarterCell[] = [
        {
            language: "markdown",
            value: lines(
                `# 🏠 ${item.displayName}`,
                "",
                `> **Lakehouse** · \`${item.workspaceId}…\``,
                "",
                "The `fabricItem` context is pre-injected — use it directly in code cells.",
                "",
                "| Global | Description |",
                "| --- | --- |",
                "| `fabricItem` | This Lakehouse item (id, workspaceId, displayName) |",
                `| \`itemFolder\` | Local path, ${notebookFolder}, to this item's folder (for exports) |`,
                "| `onelakeClient` | OneLake DFS client for files & Delta tables |",
                "| `fabricClient` | Fabric REST API client |",
                "",
                "---",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// List top-level files and folders in this Lakehouse",
                "const entries = await onelakeClient.listFiles(fabricItem!);",
                "for (const e of entries) {",
                "    const kind = e.isDirectory ? \"dir \" : \"file\";",
                "    console.log(`[${kind}] ${e.name} (${e.contentLength} bytes)`);",
                "}",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// List Delta tables and preview each",
                "const tables = await onelakeClient.listTables(fabricItem!);",
                "console.log(`Found ${tables.length} table(s):`);",
                "for (const t of tables) {",
                "    console.log(`  • ${t}`);",
                "    try {",
                "        const preview = await onelakeClient.previewTable(fabricItem!, t, 3);",
                "        console.log(preview);",
                "    } catch (e: any) {",
                "        console.log(`    (preview failed: ${e.message})`);",
                "    }",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 📝 Set your table name",
                "",
                "Pick a table from the list above and set `tableName` below.",
                "The next cell will query it with SQL and export the results.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// ✏️ Replace with a real table name from the output above",
                "const tableName = \"dbo.my_table\";",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Query the table with SQL, preview & export to local files",
                "",
                "const view = await onelakeClient.queryView(",
                "    fabricItem!,",
                "    [tableName],",
                "    `SELECT * FROM ${tableName.split(\".\").pop()} LIMIT 50`,",
                ");",
                "",
                "// Preview the query result",
                "console.log(await view.preview(10));",
                "",
                "// Export to local files under the item folder",
                "const outDir = itemFolder + \"/exports\";",
                "fs.mkdirSync(outDir, { recursive: true });",
                "",
                "await view.saveAsCsv(outDir + \"/query_result.csv\");",
                "console.log(\"Saved CSV:\", outDir + \"/query_result.csv\");",
                "",
                "await view.saveAsJsonl(outDir + \"/query_result.jsonl\");",
                "console.log(\"Saved JSONL:\", outDir + \"/query_result.jsonl\");",
                "",
                "await view.saveAsParquet(outDir + \"/query_result.parquet\");",
                "console.log(\"Saved Parquet:\", outDir + \"/query_result.parquet\");",
            ),
        },
    ];

    await ensureAndOpenNotebook(item, notebookFolder, cells, "Lakehouse");
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Open a query notebook for a `DataPipeline` item. Cells exercise the
 * `pipelineClient` API for manipulating an existing pipeline:
 * inspecting its current definition, re-authoring it with a
 * `PipelineBuilder`, pushing the new definition (`updateAndPush`),
 * triggering an on-demand run (`runOnDemand`), polling the job
 * instance (`getJobInstance`), inspecting per-activity outputs
 * (`queryActivityRuns`), and cancelling a run (`cancelJobInstance`).
 */
export async function openPipelineNotebook(
    item: FabricItem,
    notebookFolder: string,
): Promise<void> {
    const cells: StarterCell[] = [
        {
            language: "markdown",
            value: lines(
                `# 🔀 ${item.displayName}`,
                "",
                `> **Data Pipeline** · \`${item.workspaceId}…\``,
                "",
                "The `fabricItem` context is pre-injected — use it directly in code cells.",
                "",
                "| Global | Description |",
                "| --- | --- |",
                "| `fabricItem` | This DataPipeline item (id, workspaceId, displayName) |",
                `| \`itemFolder\` | Local path, ${notebookFolder}, to this item's folder |`,
                "| `pipelineClient` | Pipeline client (author, push, run, poll, query runs) |",
                "| `fabricClient` | Fabric REST API client (read/update raw definition) |",
                "| `connectionClient` | Fabric connection client (look up source/sink connections) |",
                "",
                "Authoring factories are also pre-injected as globals:",
                "`createPipelineBuilder`, `createCopyActivityBuilder`,",
                "`createLookupActivityBuilder`, `createIfConditionBuilder`,",
                "`createCopySource`, `createCopySink`, `pipelineExpression`, plus the",
                "`ParameterType` / `VariableType` / `DependencyCondition` /",
                "`CopySourceKind` / `CopySinkKind` enum objects.",
                "",
                "---",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Inspect the pipeline's current definition (base64-decoded parts)",
                "const definitionJson = await fabricClient.getItemDefinition(",
                "    fabricItem!.workspaceId,",
                "    fabricItem!.id,",
                ");",
                "// Shape: { definition: { parts: [{ path, payload, payloadType }] }, etag? }",
                "const response = JSON.parse(definitionJson);",
                "const parts = response.definition?.parts ?? [];",
                "",
                "console.log(`Definition has ${parts.length} part(s):`);",
                "for (const part of parts) {",
                "    console.log(`  • ${part.path} (${part.payloadType})`);",
                "}",
                "",
                "// Decode each part's Base64 payload and dump it. JSON parts are",
                "// pretty-printed; anything else is printed as raw text.",
                "for (const part of parts) {",
                "    const decoded = Buffer.from(part.payload, \"base64\").toString(\"utf-8\");",
                "    console.log(`\\n── ${part.path} ──`);",
                "    try {",
                "        console.log(JSON.stringify(JSON.parse(decoded), null, 2));",
                "    } catch {",
                "        console.log(decoded);",
                "    }",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ✍️ Re-author the pipeline",
                "",
                "`createPipelineBuilder()` returns an in-memory builder. Add",
                "activities, wire dependencies with `addDependency`, then push the new",
                "definition with `pipelineClient.updateAndPush(fabricItem, builder)` —",
                "which also stages `pipeline-content.json` under `itemFolder`.",
                "",
                "The example below overwrites the pipeline with two `Wait` activities",
                "run back-to-back. **Replace it** with the activities you actually",
                "want before running.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Build a new definition and push it to Fabric.",
                "const builder = createPipelineBuilder();",
                "builder.setDescription(\"Edited from the pipeline notebook\");",
                "",
                "builder.addWait(\"Warmup\", 5);",
                "builder.addWait(\"Cooldown\", 10);",
                "builder.addDependency(\"Cooldown\", \"Warmup\");",
                "",
                "// Preview the JSON that will be pushed.",
                "console.log(builder.buildPretty());",
                "",
                "await pipelineClient.updateAndPush(fabricItem!, builder);",
                "console.log(\"Pushed new pipeline definition.\");",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🔎 Schema-discovery Lookup (optional)",
                "",
                "A common pipeline pattern: a `Lookup` activity that reads a few rows",
                "and exposes them as `output.value` / `output.firstRow`. The cell",
                "below discovers an OData connection automatically by filtering",
                "`connectionClient.listConnections()` on",
                "`connectionDetails.type === \"OData\"` — no hard-coded connection id.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Find an OData connection instead of hard-coding an id.",
                "const conns = await connectionClient.listConnections();",
                "const odataConn = conns.find(",
                "    (c) => c.connectionDetails?.type === \"OData\",",
                ");",
                "",
                "if (!odataConn) {",
                "    console.log(",
                "        `No OData connection found among ${conns.length} connection(s). ` +",
                "        \"Create one in the Fabric portal (Manage connections) first.\",",
                "    );",
                "} else {",
                "    console.log(`Using OData connection \"${odataConn.displayName}\" (${odataConn.id}).`);",
                "",
                "    const lookup = createLookupActivityBuilder(\"DiscoverEntity\");",
                "    lookup.setSource({",
                "        kind: CopySourceKind.OData,",
                "        connection: odataConn,",
                "        path: \"Customers\", // ← replace with an entity set on your feed",
                "    });",
                "    lookup.setFirstRowOnly(true); // one row reveals all column names",
                "",
                "    const b = createPipelineBuilder();",
                "    b.addLookupActivity(lookup);",
                "    await pipelineClient.updateAndPush(fabricItem!, b);",
                "    console.log(\"Pushed lookup pipeline.\");",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ▶️ Run on demand & poll to completion",
                "",
                "`runOnDemand` returns a job-instance id. Poll `getJobInstance` until",
                "the status reaches a terminal value (`Completed`, `Failed`,",
                "`Cancelled`, or `Deduped`).",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Trigger a run and poll until terminal.",
                "const instanceId = await pipelineClient.runOnDemand(fabricItem!);",
                "console.log(\"Started job instance:\", instanceId);",
                "",
                "const TERMINAL = new Set([\"Completed\", \"Failed\", \"Cancelled\", \"Deduped\"]);",
                "const pollIntervalMs = 3_000;",
                "const timeoutMs = 10 * 60 * 1000; // 10 minutes",
                "",
                "// The poll loop is wrapped in an IIFE so the `JobInstance`-typed",
                "// `instance` stays function-scoped. (Top-level `let instance` would be",
                "// captured as an inferred global on the first run, and re-running the",
                "// cell would then fail to re-assign the wider `JobInstance` type back.)",
                "const finalStatus = await (async () => {",
                "    const start = Date.now();",
                "    let instance = await pipelineClient.getJobInstance(fabricItem!, instanceId);",
                "    while (!TERMINAL.has(instance.status)) {",
                "        const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);",
                "        console.log(`[${elapsedSec}s] status=${instance.status}`);",
                "        if (Date.now() - start >= timeoutMs) {",
                "            console.warn(`Timed out after ${timeoutMs / 1000}s — cancelling.`);",
                "            await pipelineClient.cancelJobInstance(fabricItem!, instanceId);",
                "            break;",
                "        }",
                "        await new Promise((r) => setTimeout(r, pollIntervalMs));",
                "        instance = await pipelineClient.getJobInstance(fabricItem!, instanceId);",
                "    }",
                "    if (instance.failureReason) {",
                "        console.log(\"Failure reason:\", JSON.stringify(instance.failureReason, null, 2));",
                "    }",
                "    return instance.status;",
                "})();",
                "console.log(\"Final status:\", finalStatus);",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 📊 Inspect per-activity runs",
                "",
                "`queryActivityRuns` returns one entry per activity, with typed",
                "`input` / `output` / `error`. It needs a",
                "`lastUpdatedAfter` / `lastUpdatedBefore` window (ISO 8601) — activity",
                "output only populates once the parent job leaves `NotStarted`.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// List per-activity runs for the instance triggered above.",
                "const runs = await pipelineClient.queryActivityRuns(",
                "    fabricItem!.workspaceId,",
                "    instanceId,",
                "    {",
                "        lastUpdatedAfter:  new Date(Date.now() - 3600_000).toISOString(),",
                "        lastUpdatedBefore: new Date(Date.now() +   60_000).toISOString(),",
                "    },",
                ");",
                "",
                "console.log(`Found ${runs.length} activity run(s):`);",
                "for (const r of runs) {",
                "    console.log(`  • ${r.activityName} (${r.activityType}) → ${r.status}`);",
                "    if (r.output && Object.keys(r.output).length > 0) {",
                "        console.log(\"    output:\", JSON.stringify(r.output));",
                "    }",
                "    // On success Fabric still returns an `error` object with empty",
                "    // fields, so only surface it when there's a real error code/message.",
                "    const err: any = r.error;",
                "    if (err && (err.errorCode || err.message)) {",
                "        console.log(\"    error:\", JSON.stringify(err));",
                "    }",
                "}",
            ),
        },
    ];

    await ensureAndOpenNotebook(item, notebookFolder, cells, "Pipeline");
}

// ── Copy Job ─────────────────────────────────────────────────────────────────

/**
 * Open a query notebook for a `CopyJob` item.
 *
 * The `NodeCopyJobClient` is deliberately small — it only exposes the
 * run lifecycle (`runOnDemand`, `getJobInstance`, `cancelJobInstance`)
 * and has **no** `updateAndPush` like the pipeline client. So the
 * authoring cells take the low-level route: read the raw definition with
 * `fabricClient.getItemDefinition`, decode the base64 `copyjob-content.json`
 * part to `itemFolder/copyjob-content.json` on disk, let the user edit it,
 * then re-encode and push it back with `fabricClient.updateItemDefinition`
 * (preserving the ETag for optimistic concurrency).
 */
export async function openCopyJobNotebook(
    item: FabricItem,
    notebookFolder: string,
): Promise<void> {
    const cells: StarterCell[] = [
        {
            language: "markdown",
            value: lines(
                `# 📋 ${item.displayName}`,
                "",
                `> **Copy Job** · \`${item.workspaceId}…\``,
                "",
                "The `fabricItem` context is pre-injected — use it directly in code cells.",
                "",
                "| Global | Description |",
                "| --- | --- |",
                "| `fabricItem` | This CopyJob item (id, workspaceId, displayName) |",
                `| \`itemFolder\` | Local path, ${notebookFolder}, to this item's folder (payload edits land here) |`,
                "| `copyJobClient` | Copy Job client (run, poll, cancel) |",
                "| `fabricClient` | Fabric REST API client (read/update raw definition) |",
                "| `connectionClient` | Fabric connection client (look up source/sink connections) |",
                "",
                "> ⚠️ **Experimental** — the Copy Job client is intentionally minimal.",
                "> Authoring is done by editing the raw `copyjob-content.json` payload",
                "> and pushing it via `fabricClient.updateItemDefinition`. Optional typed",
                "> authoring helpers are also pre-injected as globals:",
                "> `createCopyJobBuilder`, `createCopyJobSource`, `createCopyJobSink`,",
                "> `createCopyJobTableSource`, `createCopyJobTableSink`, plus the",
                "> `CopyJobMode` / `CopyJobSourceKind` / `CopyJobSinkKind` enum objects.",
                "",
                "---",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Inspect the copy job's current definition (base64-decoded parts)",
                "const definitionJson = await fabricClient.getItemDefinition(",
                "    fabricItem!.workspaceId,",
                "    fabricItem!.id,",
                ");",
                "// Shape: { definition: { parts: [{ path, payload, payloadType }] }, etag? }",
                "const response = JSON.parse(definitionJson);",
                "const parts = response.definition?.parts ?? [];",
                "",
                "console.log(`Definition has ${parts.length} part(s):`);",
                "for (const part of parts) {",
                "    console.log(`  • ${part.path} (${part.payloadType})`);",
                "}",
                "",
                "// Decode each part's Base64 payload and dump it. JSON parts are",
                "// pretty-printed; anything else is printed as raw text.",
                "for (const part of parts) {",
                "    const decoded = Buffer.from(part.payload, \"base64\").toString(\"utf-8\");",
                "    console.log(`\\n── ${part.path} ──`);",
                "    try {",
                "        console.log(JSON.stringify(JSON.parse(decoded), null, 2));",
                "    } catch {",
                "        console.log(decoded);",
                "    }",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 📝 Export the payload to disk",
                "",
                "Copy Job authoring has no typed `updateAndPush`, so we edit the raw",
                "`copyjob-content.json` payload directly. The cell below decodes the",
                "`copyjob-content.json` part and writes it to",
                "`itemFolder/copyjob-content.json` so you can open and edit it (the",
                "bundled JSON schema gives you IntelliSense). Save your edits, then run",
                "the **push** cell further down.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Decode the copyjob-content.json part and write it to itemFolder for editing.",
                "const definitionJson = await fabricClient.getItemDefinition(",
                "    fabricItem!.workspaceId,",
                "    fabricItem!.id,",
                ");",
                "const response = JSON.parse(definitionJson);",
                "const parts: Array<{ path: string; payload: string; payloadType: string }> =",
                "    response.definition?.parts ?? [];",
                "",
                "const contentPart = parts.find((p) => p.path === \"copyjob-content.json\");",
                "if (!contentPart) {",
                "    console.log(",
                "        \"No copyjob-content.json part found. Parts present: \" +",
                "        parts.map((p) => p.path).join(\", \"),",
                "    );",
                "} else {",
                "    const decoded = Buffer.from(contentPart.payload, \"base64\").toString(\"utf-8\");",
                "    const localPath = itemFolder + \"/copyjob-content.json\";",
                "    // Pretty-print so the on-disk file is easy to hand-edit.",
                "    fs.writeFileSync(localPath, JSON.stringify(JSON.parse(decoded), null, 2), \"utf-8\");",
                "    console.log(\"Wrote payload to:\", localPath);",
                "    console.log(\"Open it, edit the source/destination/mappings, then run the push cell.\");",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ☁️ Push the edited payload back",
                "",
                "Reads `itemFolder/copyjob-content.json` from disk, re-encodes it as",
                "Base64, and replaces the `copyjob-content.json` part in the item's",
                "definition. It re-fetches the definition first so the **latest ETag**",
                "is used for optimistic concurrency (Fabric rejects a stale ETag with",
                "`412 Conflict`).",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Read the locally-edited payload, re-encode it, and push the definition.",
                "const localPath = itemFolder + \"/copyjob-content.json\";",
                "if (!fs.existsSync(localPath)) {",
                "    throw new Error(`No local payload at ${localPath} — run the export cell first.`);",
                "}",
                "",
                "// Validate the edited JSON before pushing.",
                "const edited = JSON.parse(fs.readFileSync(localPath, \"utf-8\"));",
                "const encoded = Buffer.from(JSON.stringify(edited), \"utf-8\").toString(\"base64\");",
                "",
                "// Re-fetch to get the current parts + latest ETag.",
                "const current = JSON.parse(",
                "    await fabricClient.getItemDefinition(fabricItem!.workspaceId, fabricItem!.id),",
                ");",
                "const parts: Array<{ path: string; payload: string; payloadType: string }> =",
                "    current.definition?.parts ?? [];",
                "",
                "// Replace (or add) the copyjob-content.json part, leaving others intact.",
                "const nextParts = parts.filter((p) => p.path !== \"copyjob-content.json\");",
                "nextParts.push({",
                "    path: \"copyjob-content.json\",",
                "    payload: encoded,",
                "    payloadType: \"InlineBase64\",",
                "});",
                "",
                "const requestBody = JSON.stringify({ definition: { parts: nextParts } });",
                "await fabricClient.updateItemDefinition(",
                "    fabricItem!.workspaceId,",
                "    fabricItem!.id,",
                "    requestBody,",
                "    current.etag ?? null,",
                ");",
                "console.log(\"Pushed updated copyjob-content.json.\");",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ▶️ Run on demand & poll to completion",
                "",
                "`runOnDemand` returns a job-instance id. `getJobInstance` returns the",
                "instance as a **JSON string** (`JSON.parse` it). Poll until the status",
                "reaches a terminal value (`Completed`, `Failed`, `Cancelled`, or",
                "`Deduped`).",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Trigger a run and poll until terminal.",
                "const instanceId = await copyJobClient.runOnDemand(fabricItem!);",
                "console.log(\"Started job instance:\", instanceId);",
                "",
                "const TERMINAL = new Set([\"Completed\", \"Failed\", \"Cancelled\", \"Deduped\"]);",
                "const pollIntervalMs = 3_000;",
                "const timeoutMs = 10 * 60 * 1000; // 10 minutes",
                "const start = Date.now();",
                "",
                "while (true) {",
                "    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);",
                "    const instance = JSON.parse(",
                "        await copyJobClient.getJobInstance(fabricItem!, instanceId),",
                "    );",
                "    console.log(`[${elapsedSec}s] status=${instance.status}`);",
                "",
                "    if (TERMINAL.has(instance.status)) {",
                "        console.log(\"Final:\", JSON.stringify(instance, null, 2));",
                "        break;",
                "    }",
                "    if (Date.now() - start >= timeoutMs) {",
                "        console.warn(`Timed out after ${timeoutMs / 1000}s — cancelling.`);",
                "        await copyJobClient.cancelJobInstance(fabricItem!, instanceId);",
                "        break;",
                "    }",
                "    await new Promise((r) => setTimeout(r, pollIntervalMs));",
                "}",
            ),
        },
    ];

    await ensureAndOpenNotebook(item, notebookFolder, cells, "Copy Job");
}

// ── Dataflow Gen2 ────────────────────────────────────────────────────────────

/**
 * Open a query notebook for a `Dataflow` (Gen2) item.
 *
 * Focuses on what the `dataflowClient` does best today: **connection
 * management** (`listConnections` / `addConnection` / `removeConnection`)
 * and **structure discovery** by binding a Fabric `Connection`, building
 * the canonical Power Query navigator mashup with
 * `makeDocumentFromConnection`, and streaming the rows with
 * `executeQueryRows`. A closing refresh/poll cell exercises the run
 * lifecycle (`runRefresh` / `getJobInstance` / `cancelJobInstance`).
 *
 * Unlike the structure-discovery recipe in `dataflow-client.md` (which
 * spins up a throwaway scratch dataflow), these cells operate directly on
 * the opened `fabricItem`, so bindings are **additive** — the closing
 * cell removes what it added.
 */
export async function openDataflowNotebook(
    item: FabricItem,
    notebookFolder: string,
): Promise<void> {
    const cells: StarterCell[] = [
        {
            language: "markdown",
            value: lines(
                `# 🔷 ${item.displayName}`,
                "",
                `> **Dataflow Gen2** · \`${item.workspaceId}…\``,
                "",
                "The `fabricItem` context is pre-injected — use it directly in code cells.",
                "",
                "| Global | Description |",
                "| --- | --- |",
                "| `fabricItem` | This Dataflow item (id, workspaceId, displayName) |",
                `| \`itemFolder\` | Local path, ${notebookFolder}, to this item's folder |`,
                "| `dataflowClient` | Dataflow Gen2 client (connections, navigation, query, refresh) |",
                "| `connectionClient` | Fabric connection client (discover source connections) |",
                "| `fabricClient` | Fabric REST API client |",
                "",
                "This notebook covers the client's core surface today:",
                "**list / add / remove connections** and **navigation** (structure",
                "discovery) via `makeDocumentFromConnection` + `executeQueryRows`.",
                "Bindings here are **additive** to this dataflow — the last cell",
                "removes what the notebook added.",
                "",
                "---",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// List the connections currently bound in this dataflow's queryMetadata.json",
                "const bound = await dataflowClient.listConnections(fabricItem!);",
                "console.log(`Dataflow has ${bound.length} bound connection(s):`);",
                "for (const c of bound) {",
                "    console.log(`  • ${c.kind} → ${c.path}`);",
                "    console.log(`    connectionId=${c.connectionId} gatewayObjectId=${c.gatewayObjectId ?? \"(none)\"}`);",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🔗 Pick a Fabric connection to bind",
                "",
                "Structure discovery runs a Power Query mashup against a bound",
                "`Connection`. List the workspace connections, then set",
                "`connectionId` below to the one you want. The connector kind lives",
                "at `connectionDetails.type` (**not** `connection.kind`).",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Discover Fabric connections (filter by connectionDetails.type as needed).",
                "const conns = await connectionClient.listConnections();",
                "console.log(`Found ${conns.length} connection(s):`);",
                "for (const c of conns.slice(0, 25)) {",
                "    console.log(`  • ${c.displayName} — ${c.connectionDetails?.type ?? \"?\"} (${c.id})`);",
                "}",
                "if (conns.length > 25) console.log(`  … (+${conns.length - 25} more)`);",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// ✏️ Set the connection id you want to bind + query (from the list above).",
                "const connectionId = \"<connection-id>\";",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ➕ Bind the connection",
                "",
                "`makeDataflowConnection` resolves the hosting gateway cluster and",
                "produces the binding `queryMetadata.json` expects;",
                "`addConnection` merges it into the dataflow's connection set (a",
                "no-op if it's already bound). Use `setConnection` instead if you",
                "want this connection to be the *only* binding.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Resolve the Fabric connection into a dataflow binding and add it.",
                "const conn = await connectionClient.getConnection(connectionId);",
                "const dfConn = await dataflowClient.makeDataflowConnection(conn);",
                "await dataflowClient.addConnection(fabricItem!, dfConn);",
                "console.log(`Bound ${dfConn.kind} → ${dfConn.path}`);",
                "",
                "// Confirm it shows up in the bound set.",
                "const bound = await dataflowClient.listConnections(fabricItem!);",
                "console.log(\"Bound connections:\", bound.map((c) => c.kind));",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🧭 Navigate the source (top-level navigator)",
                "",
                "With no navigation steps, `makeDocumentFromConnection(conn)` returns",
                "the connector's **top-level navigator** — the catalog / schema /",
                "folder listing. The outer step is always named `query`, so pass",
                "`\"query\"` to `executeQueryRows`. The stream is bounded in JS with",
                "`break` (the streaming variant takes **no** `limit` argument), and we",
                "log only a compact sample so a wide navigator can't flood the output.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Build the \"look at the source\" mashup and stream the navigator rows.",
                "const conn = await connectionClient.getConnection(connectionId);",
                "const mashup = await dataflowClient.makeDocumentFromConnection(conn);",
                "",
                "const navStream = await dataflowClient.executeQueryRows(fabricItem!, \"query\", mashup);",
                "console.log(\"Navigator columns:\", navStream.schema.fields.map((f) => f.name));",
                "",
                "const preview: unknown[] = [];",
                "let total = 0;",
                "for await (const row of navStream) {",
                "    total++;",
                "    if (preview.length < 10) preview.push(row); // sample, don't accumulate all",
                "    if (total >= 1000) break;                    // streaming variant has no limit arg",
                "}",
                "console.log(`total=${total} (first ${preview.length})`);",
                "console.log(JSON.stringify(preview, null, 2));",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🔎 Drill into a specific table / entity",
                "",
                "Pass navigation steps to drill in. Keys are **connector-specific**",
                "(the factory doesn't infer them):",
                "",
                "| Connector | Step shape |",
                "| --- | --- |",
                "| SQL / PG / MySQL | `{ Schema: \"dbo\", Item: \"Customers\" }` |",
                "| OData | `{ Name: \"Customers\", Signature: \"table\" }` |",
                "| Snowflake | `{ Name: \"DB\", Kind: \"Database\" }` → `{ …, Kind: \"Schema\" }` → `{ …, Kind: \"Table\" }` |",
                "| ADLS Gen2 / Blob | `{ Name: \"my-container\" }` |",
                "",
                "**Replace** the example step below to match your connector.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// ✏️ Replace the navigation step to match your connector (see table above).",
                "const conn = await connectionClient.getConnection(connectionId);",
                "const mashup = await dataflowClient.makeDocumentFromConnection(conn, [",
                "    { Schema: \"dbo\", Item: \"Customers\" },",
                "]);",
                "",
                "const rowStream = await dataflowClient.executeQueryRows(fabricItem!, \"query\", mashup);",
                "console.log(\"Columns:\", rowStream.schema.fields.map((f) => f.name));",
                "",
                "const rows: unknown[] = [];",
                "let n = 0;",
                "for await (const row of rowStream) {",
                "    n++;",
                "    if (rows.length < 10) rows.push(row);",
                "    if (n >= 200) break;",
                "}",
                "console.log(`Got ${n} row(s) (first ${rows.length}):`);",
                "console.log(JSON.stringify(rows, null, 2));",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ➖ Unbind the connection",
                "",
                "`removeConnection` is symmetric with `addConnection` — pass the same",
                "`dfConn`. Removing a connection that isn't bound is a no-op. Run this",
                "to leave the dataflow exactly as you found it.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Unbind the connection this notebook added.",
                "const conn = await connectionClient.getConnection(connectionId);",
                "const dfConn = await dataflowClient.makeDataflowConnection(conn);",
                "await dataflowClient.removeConnection(fabricItem!, dfConn);",
                "",
                "const bound = await dataflowClient.listConnections(fabricItem!);",
                "console.log(\"Remaining bound connections:\", bound.map((c) => c.kind));",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ▶️ Refresh & poll to completion (optional)",
                "",
                "`runRefresh` triggers a refresh and returns a job-instance id;",
                "`runPublish` is the publish counterpart. `getJobInstance` returns the",
                "instance as a **JSON string** (`JSON.parse` it). Poll until the status",
                "reaches a terminal value (`Completed`, `Failed`, `Cancelled`, or",
                "`Deduped`).",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Trigger a refresh and poll until terminal.",
                "const instanceId = await dataflowClient.runRefresh(fabricItem!);",
                "console.log(\"Started refresh job instance:\", instanceId);",
                "",
                "const TERMINAL = new Set([\"Completed\", \"Failed\", \"Cancelled\", \"Deduped\"]);",
                "const pollIntervalMs = 5_000;",
                "const timeoutMs = 10 * 60 * 1000; // 10 minutes",
                "const start = Date.now();",
                "",
                "while (true) {",
                "    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);",
                "    const instance = JSON.parse(",
                "        await dataflowClient.getJobInstance(fabricItem!, instanceId),",
                "    );",
                "    console.log(`[${elapsedSec}s] status=${instance.status}`);",
                "",
                "    if (TERMINAL.has(instance.status)) {",
                "        console.log(\"Final:\", JSON.stringify(instance, null, 2));",
                "        break;",
                "    }",
                "    if (Date.now() - start >= timeoutMs) {",
                "        console.warn(`Timed out after ${timeoutMs / 1000}s — cancelling.`);",
                "        await dataflowClient.cancelJobInstance(fabricItem!, instanceId);",
                "        break;",
                "    }",
                "    await new Promise((r) => setTimeout(r, pollIntervalMs));",
                "}",
            ),
        },
    ];

    await ensureAndOpenNotebook(item, notebookFolder, cells, "Dataflow");
}

// ── Warehouse ────────────────────────────────────────────────────────────────

/**
 * Open a query notebook for a Warehouse item. Cells exercise the
 * `warehouseClient` TDS API (listSchemas, listTables, tableSchema,
 * previewTable, query, queryRows, execute, executeMany).
 */
export async function openWarehouseNotebook(
    item: FabricItem,
    notebookFolder: string,
): Promise<void> {
    const cells: StarterCell[] = [
        {
            language: "markdown",
            value: lines(
                `# 🏛️ ${item.displayName}`,
                "",
                `> **Warehouse** · \`${item.workspaceId}…\``,
                "",
                "The `fabricItem` context is pre-injected — use it directly in code cells.",
                "",
                "| Global | Description |",
                "| --- | --- |",
                "| `fabricItem` | This Warehouse item (id, workspaceId, displayName) |",
                `| \`itemFolder\` | Local path, ${notebookFolder}, to this item's folder (for exports) |`,
                "| `warehouseClient` | Warehouse TDS client (introspect, query, stream, execute) |",
                "| `fabricClient` | Fabric REST API client |",
                "",
                "---",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// List schemas in this Warehouse",
                "const schemas = await warehouseClient.listSchemas(fabricItem!);",
                "console.log(`Found ${schemas.length} schema(s):`);",
                "for (const s of schemas) {",
                "    console.log(`  • ${s}`);",
                "}",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// List tables (unscoped → 'schema.table'; scoped → bare names)",
                "const allTables = await warehouseClient.listTables(fabricItem!);",
                "console.log(`Found ${allTables.length} table(s) across all schemas:`);",
                "for (const t of allTables.slice(0, 20)) {",
                "    console.log(`  • ${t}`);",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 📝 Set your target schema and table",
                "",
                "Pick a row from the list above (`schema.table` format) and set the two",
                "constants below. Subsequent cells use them for schema inspection,",
                "previews, and SQL queries.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// ✏️ Replace with a real schema/table from the output above",
                "const schemaName = \"dbo\";",
                "const tableName  = \"my_table\";",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Inspect table columns and preview the top rows",
                "const columns = await warehouseClient.tableSchema(fabricItem!, schemaName, tableName);",
                "console.log(\"Columns:\", JSON.stringify(columns, null, 2));",
                "",
                "const preview = await warehouseClient.previewTable(fabricItem!, schemaName, tableName, 10);",
                "console.log(preview);",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Run an ad-hoc SQL query — returns all rows as a parsed array",
                "const rows = await warehouseClient.query(",
                "    fabricItem!,",
                "    `SELECT TOP 5 * FROM [${schemaName}].[${tableName}]`,",
                ");",
                "console.log(`Got ${rows.length} row(s):`);",
                "for (const row of rows) {",
                "    console.log(JSON.stringify(row));",
                "}",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Stream large result sets row-by-row via queryRows()",
                "const rowStream = await warehouseClient.queryRows(",
                "    fabricItem!,",
                "    `SELECT * FROM [${schemaName}].[${tableName}]`,",
                ");",
                "",
                "let count = 0;",
                "for await (const row of rowStream) {",
                "    count++;",
                "    if (count <= 3) console.log(JSON.stringify(row));",
                "    // `break` here will release the pooled TDS connection.",
                "    if (count >= 1000) break;",
                "}",
                "console.log(`Streamed ${count} row(s)`);",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ✏️ Write data (DDL / DML)",
                "",
                "Use `execute()` for single statements (returns affected-row count) and",
                "`executeMany()` for **transactional** batches — all statements commit",
                "together on success, or roll back together on any failure.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Example: create a scratch table, insert a few rows, then drop it.",
                "const scratch = \"_di_scratch\";",
                "",
                "await warehouseClient.execute(",
                "    fabricItem!,",
                "    `DROP TABLE IF EXISTS [${schemaName}].[${scratch}]`,",
                ");",
                "await warehouseClient.execute(",
                "    fabricItem!,",
                "    `CREATE TABLE [${schemaName}].[${scratch}] (id INT NOT NULL, label VARCHAR(50) NULL)`,",
                ");",
                "",
                "const counts = await warehouseClient.executeMany(fabricItem!, [",
                "    `INSERT INTO [${schemaName}].[${scratch}] VALUES (1, 'one')`,",
                "    `INSERT INTO [${schemaName}].[${scratch}] VALUES (2, 'two')`,",
                "    `INSERT INTO [${schemaName}].[${scratch}] VALUES (3, 'three')`,",
                "]);",
                "console.log(\"Per-statement counts:\", counts);",
                "",
                "const checkRows = await warehouseClient.query(",
                "    fabricItem!,",
                "    `SELECT * FROM [${schemaName}].[${scratch}] ORDER BY id`,",
                ");",
                "console.log(JSON.stringify(checkRows, null, 2));",
                "",
                "await warehouseClient.execute(",
                "    fabricItem!,",
                "    `DROP TABLE [${schemaName}].[${scratch}]`,",
                ");",
            ),
        },
    ];

    await ensureAndOpenNotebook(item, notebookFolder, cells, "Warehouse");
}

// ── dbt ──────────────────────────────────────────────────────────────────────

/**
 * Open a query notebook for a `DataBuildToolJob` item. Cells exercise:
 *   • the per-item `LocalDbtClient` returned by
 *     `dbtClient.makeLocalClientByItem(fabricItem)` — `getDbtContent`,
 *     `listProjectFiles`, `readProjectFile`, `updateDbtContent`,
 *     `runDbtCommand`, `push`.
 *   • the workspace-scoped `dbtClient` (`NodeDbtClient`) — `runOnDemand`,
 *     `getJobInstance`, `cancelJobInstance`.
 */
export async function openDbtNotebook(
    item: FabricItem,
    notebookFolder: string,
): Promise<void> {
    const cells: StarterCell[] = [
        {
            language: "markdown",
            value: lines(
                `# 🧱 ${item.displayName}`,
                "",
                `> **dbt** · \`${item.workspaceId}…\``,
                "",
                "The `fabricItem` context is pre-injected — use it directly in code cells.",
                "",
                "| Global | Description |",
                "| --- | --- |",
                "| `fabricItem` | This DataBuildToolJob item (id, workspaceId, displayName) |",
                `| \`itemFolder\` | Local path, ${notebookFolder}, to this item's folder |`,
                "| `dbtClient` | Workspace dbt client (`runOnDemand`, `getJobInstance`) |",
                "| `connectionClient` | Fabric connection client (look up PostgreSQL / Snowflake credentials) |",
                "| `fabricClient` | Fabric REST API client (list warehouses, etc.) |",
                "",
                "A per-item `LocalDbtClient` is **not** pre-injected — create one via",
                "`dbtClient.makeLocalClientByItem(fabricItem!)`.",
                "",
                "---",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Bind a LocalDbtClient to this item and inspect the staged dbt-content.json",
                "const local = dbtClient.makeLocalClientByItem(fabricItem!);",
                "",
                "const content: any = await local.getDbtContent();",
                "console.log(\"dbt-content.json:\");",
                "console.log(JSON.stringify(content, null, 2));",
                "console.log(\"projectDir:\", local.projectDir());",
                "",
                "if (content?.profile?.externalReferences?.connection) {",
                "    console.log(\"Connection used by dbt:\");",
                "    const conn = await connectionClient.getConnection(content.profile.externalReferences.connection);",
                "    console.log(JSON.stringify(conn, null, 2));",
                "}",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// List staged project files (relative to projectDir)",
                "const local = dbtClient.makeLocalClientByItem(fabricItem!);",
                "",
                "const files = local.listProjectFiles();",
                "console.log(`Project has ${files.length} file(s):`);",
                "for (const f of files.slice(0, 25)) console.log(\"  \" + f);",
                "if (files.length > 25) console.log(`  … (+${files.length - 25} more)`);",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Read a project file (defaults to dbt_project.yml when present)",
                "const local = dbtClient.makeLocalClientByItem(fabricItem!);",
                "",
                "const relPath = \"dbt_project.yml\";",
                "if (local.projectPathExists(relPath)) {",
                "    console.log(`── ${relPath} ──`);",
                "    console.log(local.readProjectFile(relPath));",
                "} else {",
                "    console.log(`${relPath} not found — pick one from listProjectFiles().`);",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🔗 Bind to a profile",
                "",
                "`updateDbtContent` declares which warehouse / database the dbt project",
                "should target. Pick **one** of the three templates below, fill in the",
                "schema and target item / connection ID, and run it.",
                "",
                "The call rewrites `dbt-content.json` + `profiles.yml`; pair it with",
                "`local.push()` (further down) to persist the change back to Fabric.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// ── Option A · Fabric Warehouse target ──────────────────────────────",
                "// const local = dbtClient.makeLocalClientByItem(fabricItem!);",
                "// const warehouses = await fabricClient.listItems(fabricItem!.workspaceId, \"Warehouse\");",
                "// const target = warehouses[0]; // ← pick the warehouse you want to target",
                "// await local.updateDbtContent(",
                "//     { kind: \"DataWarehouse\", schema: \"dbo\", item: target },",
                "// );",
                "",
                "// ── Option B · PostgreSQL connection target ─────────────────────────",
                "// const local = dbtClient.makeLocalClientByItem(fabricItem!);",
                "// const conn = await connectionClient.getConnection(\"<connection-id>\");",
                "// await local.updateDbtContent(",
                "//     { kind: \"PostgreSql\", schema: \"public\", connection: conn },",
                "//     { operation: \"Initialize\" },",
                "// );",
                "",
                "// ── Option C · Snowflake connection target ──────────────────────────",
                "// const local = dbtClient.makeLocalClientByItem(fabricItem!);",
                "// const conn = await connectionClient.getConnection(\"<connection-id>\");",
                "// await local.updateDbtContent(",
                "//     { kind: \"Snowflake\", schema: \"PUBLIC\", connection: conn },",
                "//     { operation: \"Initialize\" },",
                "// );",
                "",
                "console.log(\"Uncomment one of the templates above, then re-run this cell.\");",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ▶️ Run dbt locally",
                "",
                "`runDbtCommand` shells out to the bundled `dbt` CLI inside the staged",
                "project directory and streams output line-by-line. Common commands:",
                "`debug`, `deps`, `parse`, `build`, `run`, `test`, `seed`.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Stream `dbt debug` output to the cell log",
                "const local = dbtClient.makeLocalClientByItem(fabricItem!);",
                "",
                "const dbtStream = await local.runDbtCommand(",
                "    \"debug\",",
                "    [],",
                "    { target: \"remote\" },",
                ");",
                "try {",
                "    for await (const { stream: src, line } of dbtStream) {",
                "        console.log(`[${src}] ${line}`);",
                "    }",
                "} catch (e: any) {",
                "    console.error(`dbt debug failed: ${e.message}`);",
                "}",
            ),
        },
                {
            language: "typescript",
            value: lines(
                "// Stream `dbt build` output to the cell log",
                "const local = dbtClient.makeLocalClientByItem(fabricItem!);",
                "",
                "const dbtStream = await local.runDbtCommand(",
                "    \"build\",",
                "    [],",
                "    { target: \"remote\" },",
                ");",
                "try {",
                "    for await (const { stream: src, line } of dbtStream) {",
                "        console.log(`[${src}] ${line}`);",
                "    }",
                "} catch (e: any) {",
                "    console.error(`dbt debug failed: ${e.message}`);",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ☁️ Push + trigger a remote run",
                "",
                "`local.push()` uploads any locally modified project files back to the",
                "Fabric item. `dbtClient.runOnDemand(fabricItem)` then kicks off a",
                "server-side `Execute` job and the loop below polls until it reaches a",
                "terminal status (`Completed`, `Failed`, `Cancelled`, or `Deduped`).",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Push local edits, trigger a cloud fabric run, and poll until terminal",
                "const local = dbtClient.makeLocalClientByItem(fabricItem!);",
                "",
                "await local.push();",
                "console.log(\"Pushed local changes.\");",
                "",
                "const jobInstanceId = await dbtClient.runOnDemand(fabricItem!);",
                "console.log(\"Started job instance:\", jobInstanceId);",
                "",
                "const TERMINAL = new Set([\"Completed\", \"Failed\", \"Cancelled\", \"Deduped\"]);",
                "const pollIntervalMs = 10_000;",
                "const timeoutMs = 10 * 60 * 1000; // 10 minutes",
                "const start = Date.now();",
                "",
                "while (true) {",
                "    const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);",
                "    const instance = JSON.parse(",
                "        await dbtClient.getJobInstance(fabricItem!, jobInstanceId),",
                "    );",
                "    console.log(`[${elapsedSec}s] status=${instance.status} invoke=${instance.invokeType}`);",
                "",
                "    if (TERMINAL.has(instance.status)) {",
                "        console.log(\"Final:\", JSON.stringify(instance, null, 2));",
                "        break;",
                "    }",
                "    if (Date.now() - start >= timeoutMs) {",
                "        console.warn(`Timed out after ${timeoutMs / 1000}s — cancelling.`);",
                "        await dbtClient.cancelJobInstance(fabricItem!, jobInstanceId);",
                "        break;",
                "    }",
                "    await new Promise((r) => setTimeout(r, pollIntervalMs));",
                "}",
            ),
        },
    ];

    await ensureAndOpenNotebook(item, notebookFolder, cells, "dbt");
}

// ── Airflow ──────────────────────────────────────────────────────────────────

/**
 * Open a query notebook for an `ApacheAirflowJob` item. Cells exercise:
 *   • the workspace-scoped `airflowRunner` (`NodeAirflowRunner`) — venv
 *     setup, dep install, the typed Fabric SPN connection wrappers
 *     (`addFabricSpnConnection`, `listFabricSpnConnections`,
 *     `deleteFabricSpnConnectionById`), arbitrary `runAirflowCommand`,
 *     and the standalone-server lifecycle (`run`, `runByConfig`,
 *     `tryAttach`).
 *   • a per-item `LocalAirflowClient` created via
 *     `createLocalAirflowClient(baseFolder)` — `listDags`, `unpauseDag`,
 *     `runAndVerify`, etc.
 *
 * Airflow is POSIX-only, so `airflowRunner` is `undefined` on Windows.
 * The cells assert it before use.
 */
export async function openAirflowNotebook(
    item: FabricItem,
    notebookFolder: string,
): Promise<void> {
    const cells: StarterCell[] = [
        {
            language: "markdown",
            value: lines(
                `# ✈️ ${item.displayName}`,
                "",
                `> **Apache Airflow** · \`${item.workspaceId}…\``,
                "",
                "The `fabricItem` context is pre-injected — use it directly in code cells.",
                "",
                "| Global | Description |",
                "| --- | --- |",
                "| `fabricItem` | This ApacheAirflowJob item (id, workspaceId, displayName) |",
                `| \`itemFolder\` | Local path, ${notebookFolder}, to this item's folder |`,
                "| `baseFolder` | Workspace root — pass to `createLocalAirflowClient` |",
                "| `airflowRunner` | Local Airflow runner (`undefined` on Windows) |",
                "| `fabricClient` | Fabric REST API client |",
                "",
                "A `LocalAirflowClient` is **not** pre-injected — create one via",
                "`createLocalAirflowClient(baseFolder)` once the standalone server is up.",
                "",
                "---",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🛠️ One-time environment setup",
                "",
                "Creates `<baseFolder>/.venv`, then installs Apache Airflow + the",
                "Microsoft Fabric provider into it. Re-runs are cheap — `setupVenv`",
                "is a no-op when the venv already exists, and `pip install` skips",
                "already-installed wheels.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Ensure the venv exists and Airflow is installed",
                "if (!airflowRunner) throw new Error(\"airflowRunner is unavailable on this platform (Windows is not supported).\");",
                "",
                "await airflowRunner.setupVenv();",
                "const installLog = await airflowRunner.installAirflowDeps(\"2.10.5\");",
                "console.log(installLog.split(\"\\n\").slice(-20).join(\"\\n\"));",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🔌 Register a Fabric SPN connection",
                "",
                "`addFabricSpnConnection` is the typed wrapper around",
                "`airflow connections add` for Microsoft Fabric Service-Principal auth.",
                "All four fields are required and must be non-empty; `--conn-type` is",
                "hard-coded to `microsoft-fabric` and the `auth_type` is always `spn`.",
                "",
                "Fill in your SPN values below, then run the cell.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// ✏️ Replace with your SPN values before running",
                "const connectionId = \"fabric-integration\";",
                "const clientId     = \"<spn-client-id>\";",
                "const clientSecret = \"<spn-client-secret>\";",
                "const tenantId     = \"<tenant-id>\";",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Upsert the connection (delete + add, so the cell is idempotent).",
                "if (!airflowRunner) throw new Error(\"airflowRunner is unavailable on this platform.\");",
                "",
                "await airflowRunner",
                "    .deleteFabricSpnConnectionById(connectionId)",
                "    .catch(() => { /* not found — fine */ });",
                "",
                "const out = await airflowRunner.addFabricSpnConnection({",
                "    connectionId,",
                "    clientId,",
                "    secret: clientSecret,",
                "    tenantId,",
                "});",
                "console.log(out);",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 📋 List Fabric SPN connections",
                "",
                "`listFabricSpnConnections` runs `airflow connections list --output json`",
                "and **filters the returned rows down to `conn_type === \"microsoft-fabric\"`",
                "inside the Rust wrapper** before re-serializing. (Airflow 2.x's",
                "`connections list` has no `--conn-type` flag — only `--conn-id` —",
                "so client-side filtering is the only correct option.) Returns `\"[]\"`",
                "when no Fabric connection is registered — never rejects on \"not found\".",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Inspect every Fabric SPN connection currently in the metastore",
                "if (!airflowRunner) throw new Error(\"airflowRunner is unavailable on this platform.\");",
                "",
                "type FabricConnectionRow = {",
                "    conn_id: string;",
                "    conn_type: \"microsoft-fabric\";",
                "    login: string | null;          // unused by the SPN wrapper — typically null",
                "    password: string | null;       // unused by the SPN wrapper — typically null",
                "    // Holds the SPN fields the provider actually reads:",
                "    //   { tenantId, clientId, clientSecret, auth_type: \"spn\" }",
                "    extra_dejson: Record<string, unknown>;",
                "};",
                "",
                "const rows: FabricConnectionRow[] = JSON.parse(",
                "    await airflowRunner.listFabricSpnConnections(),",
                ");",
                "console.log(`Found ${rows.length} Fabric connection(s):`);",
                "for (const r of rows) {",
                "    const extra = r.extra_dejson as { tenantId?: string; clientId?: string };",
                "    console.log(`  • ${r.conn_id} (tenant=${extra.tenantId}, clientId=${extra.clientId})`);",
                "}",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🗑️ Delete a Fabric SPN connection",
                "",
                "`deleteFabricSpnConnectionById` wraps",
                "`airflow connections delete <id>`. Non-idempotent — rejects when",
                "the id doesn't exist. `.catch(() => {})` to swallow.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Remove the connection registered above",
                "if (!airflowRunner) throw new Error(\"airflowRunner is unavailable on this platform.\");",
                "",
                "await airflowRunner.deleteFabricSpnConnectionById(connectionId);",
                "",
                "// Confirm it's gone",
                "const after = JSON.parse(await airflowRunner.listFabricSpnConnections()) as Array<{ conn_id: string }>;",
                "console.log(\"Remaining:\", after.map((r) => r.conn_id));",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🧪 Run an arbitrary `airflow` CLI command",
                "",
                "`runAirflowCommand` execs the CLI inside the project venv with the",
                "shared `AIRFLOW_HOME` / metastore. Use it for anything the typed",
                "wrappers don't cover (`connections get|test|export`, `dags list`,",
                "`db check`, etc.).",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Example: dump the full connections table as JSON",
                "if (!airflowRunner) throw new Error(\"airflowRunner is unavailable on this platform.\");",
                "",
                "const json = await airflowRunner.runAirflowCommand([",
                "    \"connections\", \"list\", \"--output\", \"json\",",
                "]);",
                "console.log(JSON.parse(json));",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### ▶️ Start standalone & run a DAG end-to-end",
                "",
                "`run(fabricItem)` pulls the item from Fabric, installs its",
                "`requirements.txt`, then starts `airflow standalone`. If a",
                "standalone is already up for this base folder, `tryAttach()`",
                "returns its handle without spawning a second server.",
                "",
                "Once the webserver is ready, switch to `LocalAirflowClient` for",
                "DAG-level operations.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Start (or attach to) the standalone server for this item",
                "if (!airflowRunner) throw new Error(\"airflowRunner is unavailable on this platform.\");",
                "",
                "const proc = airflowRunner.tryAttach() ?? await airflowRunner.run(fabricItem!);",
                "console.log(`pid=${proc.pid} port=${proc.port} url=${proc.baseUrl}`);",
                "",
                "const ok = await proc.waitForPort(proc.port, 120_000);",
                "if (!ok) throw new Error(`Airflow webserver did not open port ${proc.port} within 120s`);",
                "console.log(\"Server is accepting connections.\");",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Connect a LocalAirflowClient and list the DAGs the scheduler sees",
                "const client = createLocalAirflowClient(baseFolder);",
                "console.log(`baseUrl=${client.baseUrl} dagsFolder=${client.dagsFolder}`);",
                "",
                "const dags = await client.listDags();",
                "console.log(`Found ${dags.length} DAG(s):`);",
                "for (const d of dags) {",
                "    console.log(`  • ${d.dagId} (paused=${d.isPaused})`);",
                "}",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// ✏️ Pick a DAG id from the list above, then trigger + verify",
                "const dagId = \"<dag-id-from-list-above>\";",
                "",
                "const client = createLocalAirflowClient(baseFolder);",
                "await client.unpauseDag(dagId);",
                "",
                "const result = await client.runAndVerify(dagId, { timeoutMs: 120_000 });",
                "console.log(`success=${result.success} state=${result.state} durationMs=${result.durationMs}`);",
            ),
        },
        {
            language: "markdown",
            value: lines(
                "### 🛑 Stop the standalone server",
                "",
                "`proc.kill()` signals the entire process group (the standalone",
                "launcher spawns scheduler + webserver as children). Call",
                "`proc.wait()` to drain the exit code if you own the handle —",
                "for *adopted* handles (`tryAttach()`) it resolves immediately.",
            ),
        },
        {
            language: "typescript",
            value: lines(
                "// Stop whatever standalone is running for this base folder",
                "if (!airflowRunner) throw new Error(\"airflowRunner is unavailable on this platform.\");",
                "",
                "const proc = airflowRunner.tryAttach();",
                "if (!proc) {",
                "    console.log(\"No standalone server is running for this base folder.\");",
                "} else {",
                "    proc.kill();",
                "    const exitCode = await proc.wait();",
                "    console.log(`Stopped Airflow (exit=${exitCode}).`);",
                "}",
            ),
        },
    ];

    await ensureAndOpenNotebook(item, notebookFolder, cells, "Airflow");
}
