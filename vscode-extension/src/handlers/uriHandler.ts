import * as vscode from "vscode";
import { FabricItemType } from "data-integration";
import type { WorkspacesTreeProvider } from "@/views/WorkspacesTreeProvider";
import { requestDIContext } from "@/services/di-context";
import * as log from "@/utils/channel_log";
import * as sdkLog from "@/utils/sdk_log";

/** Item types this extension can pull and open. */
const SUPPORTED_TYPES: ReadonlySet<FabricItemType> = new Set([
  FabricItemType.DataPipeline,
  FabricItemType.DataBuildToolJob,
  FabricItemType.ApacheAirflowJob,
  FabricItemType.CopyJob,
  FabricItemType.Dataflow,
]);

/** What the open path actually needs to locate and pull an item. */
export interface OpenParams {
  workspaceId: string;
  itemId: string;
}

export enum DeepLinkKind {
  Open = "Open",
  Unrecognized = "Unrecognized",
}

/** Outcome of parsing a deep-link URI. */
export type ParsedDeepLink =
  | { kind: DeepLinkKind.Open; params: OpenParams }
  | { kind: DeepLinkKind.Unrecognized; message: string };

/**
 * Pure parse/validate step for
 * `vscode://fabric-data-factory/open?workspaceId=...&itemId=...`.
 * Kept free of addon/view dependencies so the accepted-URI surface stays
 * testable without booting the DI context.
 *
 * Any `itemType` in the query is ignored — the type is checked against the
 * fetched item instead, so a crafted link can't misrepresent what it points to.
 */
export function parseDeepLink(uri: vscode.Uri): ParsedDeepLink {
  if (uri.path !== "/open") {
    return {
      kind: DeepLinkKind.Unrecognized,
      message: `Unknown Fabric Data Factory URI path: ${uri.path}`,
    };
  }

  const query = new URLSearchParams(uri.query);
  const workspaceId = query.get("workspaceId");
  const itemId = query.get("itemId");

  if (!workspaceId || !itemId) {
    return {
      kind: DeepLinkKind.Unrecognized,
      message: "Invalid deep-link: workspaceId and itemId are both required.",
    };
  }

  return { kind: DeepLinkKind.Open, params: { workspaceId, itemId } };
}

/**
 * Handles `vscode://fabric-data-factory/open?...` URIs: parses them, then pulls
 * the targeted item and opens it in an editor.
 */
export class FabricUriHandler implements vscode.UriHandler {
  constructor(private readonly treeProvider: WorkspacesTreeProvider) {}

  handleUri(uri: vscode.Uri): void {
    const parsed = parseDeepLink(uri);
    switch (parsed.kind) {
      case DeepLinkKind.Open:
        // `handleUri` is sync by contract — VS Code ignores any returned promise.
        void this.openItem(parsed.params);
        return;
      case DeepLinkKind.Unrecognized:
        void vscode.window.showErrorMessage(parsed.message);
        return;
    }
  }

  private async openItem(params: OpenParams): Promise<void> {
    // Resolved per-invocation rather than injected: a deep-link can arrive long
    // before the user signs in, and this prompts them when it hasn't happened.
    const diContext = requestDIContext();
    if (!diContext) {
      return;
    }

    try {
      const item = await diContext.fabricClient.getItem(
        params.workspaceId,
        params.itemId,
      );

      if (!SUPPORTED_TYPES.has(item.itemType)) {
        void vscode.window.showErrorMessage(
          `Cannot open "${item.displayName}": ${item.itemType} items aren't supported. ` +
            `Supported: ${[...SUPPORTED_TYPES].join(", ")}`,
        );
        return;
      }
      sdkLog.info(`deepLink/open itemType=${item.itemType}`, "extension/deeplink");

      this.treeProvider.setWorkspaceById(params.workspaceId);
      const primaryFileRes = await diContext.syncService.pullItem(item);
      const doc = await vscode.workspace.openTextDocument(
        primaryFileRes.primaryFile,
      );
      await vscode.window.showTextDocument(doc);
      this.treeProvider.refresh();
    } catch (e) {
      await log.reportError("Failed to open item from deep-link", e);
    }
  }
}
