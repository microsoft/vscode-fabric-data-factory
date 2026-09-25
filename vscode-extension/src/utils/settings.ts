import * as vscode from "vscode";

const SECTION = "fabricDataFactory";

export interface FabricDataFactorySettings {
  projectFolder: string;
  vmTimeout: number;
  chatScriptTimeout: number;
  modelIdleTimeout: number;
  maxToolRounds: number;
  preferredModel: string;
  chatDeveloperMode: boolean;
  gitIntegration: boolean;
}

/** Configuration key of {@link FabricDataFactorySettings.gitIntegration}, for `onDidChangeConfiguration` filtering. */
export const GIT_INTEGRATION_SETTING = `${SECTION}.gitIntegration`;

export function getSettings(): FabricDataFactorySettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    projectFolder: cfg.get<string>("projectFolder", ""),
    vmTimeout: cfg.get<number>("vmTimeout", 120_000),
    chatScriptTimeout: cfg.get<number>("chatScriptTimeout", 600_000),
    modelIdleTimeout: cfg.get<number>("modelIdleTimeout", 60_000),
    maxToolRounds: cfg.get<number>("maxToolRounds", 15),
    preferredModel: cfg.get<string>("preferredModel", "claude-opus-4.6"),
    chatDeveloperMode: cfg.get<boolean>("chatDeveloperMode", false),
    gitIntegration: cfg.get<boolean>("gitIntegration", true),
  };
}
