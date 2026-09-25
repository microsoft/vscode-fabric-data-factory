import * as vscode from "vscode";
import { getSettings } from "./settings";

/**
 * Where the resolved base folder came from. A `globalStorage` source means
 * neither the `projectFolder` setting nor an open workspace supplied a path —
 * the silent-mis-rooting fallback worth surfacing in telemetry.
 */
export type BaseFolderSource = "setting" | "workspace" | "globalStorage";

export interface ResolvedBaseFolder {
  folder: string;
  source: BaseFolderSource;
}

/**
 * Resolve the project base folder and report which source it came from.
 * Precedence: explicit `projectFolder` setting → first workspace folder →
 * the extension's global-storage dir (the silent fallback).
 */
export function resolveBaseFolder(
  extensionContext: vscode.ExtensionContext,
): ResolvedBaseFolder {
  const setting = getSettings().projectFolder;
  if (setting) {
    return { folder: setting, source: "setting" };
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceFolder) {
    return { folder: workspaceFolder, source: "workspace" };
  }
  return { folder: extensionContext.globalStorageUri.fsPath, source: "globalStorage" };
}

/**
 * Resolve the project base folder from settings, workspace, or global storage.
 */
export function getBaseFolder(extensionContext: vscode.ExtensionContext): string {
  return resolveBaseFolder(extensionContext).folder;
}
