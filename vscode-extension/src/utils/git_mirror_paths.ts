/**
 * Path resolution helpers for mapping a locally-synced Fabric item file
 * (under `.workspaces/<workspaceId>/<itemId>/...`) to its counterpart inside
 * the workspace's git mirror clone (`.fabric-git/<workspaceId>/...`, managed
 * by `gitHelperService`).
 *
 * Fabric's git integration stores each item in a folder named
 * `<DisplayName>.<ItemType>` (optionally nested under the connection's
 * `directoryName`), with the display name sanitized by replacing
 * Windows-reserved filename characters with `_` so the folder name works
 * across every OS the repo might be cloned on.
 */

import * as fs from "fs";
import * as path from "path";

/** Windows-reserved filename characters Fabric's git integration replaces with `_`. */
const INVALID_GIT_FOLDER_CHARS = /[<>:"/\\|?*]/g;

/**
 * Sanitize a display name the same way Fabric's git integration does when
 * deriving an item's folder name (`<sanitized>.<itemType>`).
 */
export function sanitizeGitItemName(displayName: string): string {
    return displayName.replace(INVALID_GIT_FOLDER_CHARS, "_");
}

/**
 * Resolve the folder Fabric's git integration uses for an item under
 * `searchRoot` (the mirror repo root, or its `directoryName` subfolder).
 *
 * Tries the exact `<sanitized displayName>.<itemType>` match first, then
 * falls back to a case-insensitive scan of `searchRoot`'s immediate
 * children so minor naming differences (case, alternate sanitization)
 * don't break the lookup. Returns `undefined` if `searchRoot` doesn't
 * exist or no match is found.
 */
export function resolveItemGitFolder(searchRoot: string, displayName: string, itemType: string): string | undefined {
    const expected = `${sanitizeGitItemName(displayName)}.${itemType}`;
    const exact = path.join(searchRoot, expected);
    try {
        if (fs.statSync(exact).isDirectory()) {
            return exact;
        }
    } catch {
        // Doesn't exist (or can't be stat'd) — fall through to the
        // case-insensitive scan below.
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(searchRoot, {withFileTypes: true});
    } catch {
        return undefined;
    }
    const expectedLower = expected.toLowerCase();
    const match = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === expectedLower);
    return match ? path.join(searchRoot, match.name) : undefined;
}
