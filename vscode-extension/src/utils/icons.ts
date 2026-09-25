import * as vscode from "vscode";
import { FabricItemType } from "data-integration";

/** SVG filename per item type, located in resources/svgs/. */
const TYPE_ICONS_SVG: Partial<Record<FabricItemType, string>> = {
    [FabricItemType.DataPipeline]: "c_pipeline_64.svg",
    [FabricItemType.CopyJob]: "c_copy_job_64.svg",
    [FabricItemType.Dataflow]: "c_dataflow_gen2_64.svg",
    [FabricItemType.ApacheAirflowJob]: "c_apache_airflow_64.svg",
    [FabricItemType.DataBuildToolJob]: "c_dbtitem_64.svg",
    [FabricItemType.Lakehouse]: "c_lakehouse_64.svg",
    [FabricItemType.Warehouse]: "c_data_warehouse_64.svg",
    [FabricItemType.SQLEndpoint]: "c_sql_database_64.svg",
};

/** Resolve a custom SVG icon from resources/svgs/. */
export function svgIcon(ctx: vscode.ExtensionContext, filename: string): vscode.Uri {
    return vscode.Uri.joinPath(ctx.extensionUri, "resources", "svgs", filename);
}

/** Get the icon for a Fabric item type. Falls back to a generic file icon. */
export function typeIcon(
    ctx: vscode.ExtensionContext,
    itemType: FabricItemType,
): vscode.Uri | vscode.ThemeIcon {
    const svg = TYPE_ICONS_SVG[itemType];
    return svg
        ? svgIcon(ctx, svg)
        : new vscode.ThemeIcon("file");
}
