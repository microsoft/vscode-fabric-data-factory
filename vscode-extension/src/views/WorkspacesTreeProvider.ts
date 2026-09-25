import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {requestDIContext, tryGetDIContext} from "@/services/di-context";
import {getBaseFolder} from "@/utils/folders";
import {getSettings, GIT_INTEGRATION_SETTING} from "@/utils/settings";
import {type FabricItem, FabricItemType, type ItemSyncState, type NodeFabricClient, type Workspace} from "data-integration";
import {createCancellationToken} from "data-integration";
import {log, reportError} from "@/utils/channel_log";
import * as sdkLog from "@/utils/sdk_log";
import {parseDiagnostic} from "@/utils/diagnostic";
import {classifyNetworkError, isLikelyBlocked, type NetworkErrorKind} from "@/utils/network_error";
import {classifyFabricAccess, fabricAccessAdvice, type FabricAccessKind} from "@/utils/fabric_access_error";
import {resolveItemGitFolder, sanitizeGitItemName} from "@/utils/git_mirror_paths";
import {svgIcon, typeIcon} from "@/utils/icons";
import {
    openAirflowNotebook,
    openCopyJobNotebook,
    openDataflowNotebook,
    openDbtNotebook,
    openLakehouseNotebook,
    openPipelineNotebook,
    openWarehouseNotebook,
} from "@/notebook/notebook_builder";

// ── Item type display config ────────────────────────────────────────────────

const TYPE_LABELS: Partial<Record<FabricItemType, string>> = {
    [FabricItemType.DataPipeline]: "Pipelines",
    [FabricItemType.CopyJob]: "Copy Jobs",
    [FabricItemType.Dataflow]: "Dataflows Gen2",
    [FabricItemType.DataBuildToolJob]: "dbt Jobs",
    [FabricItemType.ApacheAirflowJob]: "Airflow Jobs",
    [FabricItemType.Lakehouse]: "Lakehouse",
    [FabricItemType.Warehouse]: "Warehouse",
    // [FabricItemType.SQLEndpoint]: "SQL Endpoints",
};

const ENABLED_TYPES = Object.keys(TYPE_LABELS) as FabricItemType[];

/**
 * Item types that support push (mirrors `FabricItemType::is_syncable()` on
 * the Rust side). Lakehouse, Warehouse, and SQLEndpoint items have no
 * `definition` to upload, so {@link WorkspacesTreeProvider.pushSelectedFiles}
 * skips any selected file that belongs to one of them instead of letting the
 * push fail with a confusing deserialization error.
 */
const PUSHABLE_ITEM_TYPES = new Set<FabricItemType>([
    FabricItemType.DataPipeline,
    FabricItemType.CopyJob,
    FabricItemType.Dataflow,
    FabricItemType.ApacheAirflowJob,
    FabricItemType.DataBuildToolJob,
]);

/**
 * Debounce window (ms) for `<baseFolder>/.fabric/**\/*.json` watcher events.
 *
 * A bulk `pullByConfig` can land dozens of state files back-to-back; if the
 * tree refreshed on every individual create/change/delete VS Code would
 * thrash through `readLocalItemStatesMap()` and re-render hundreds of times. The
 * 300ms window is short enough to feel instantaneous for single-item edits
 * while comfortably absorbing the burst from a multi-item pull.
 */
const FABRIC_WATCH_DEBOUNCE_MS = 300;

/**
 * URI scheme for a virtual document that always resolves to empty content.
 * Used by `compareWithGit` as the "before" side of a diff when the local
 * file has no counterpart in git yet (a new/untracked file) — VS Code then
 * diffs the real local file against this empty stand-in instead of failing
 * outright, so a newly added file's diff shows entirely as additions,
 * mirroring how the built-in Source Control diff handles added files.
 */
const EMPTY_GIT_FILE_SCHEME = "fabricGitEmptyFile";

/** Build a scheme-only URI (see {@link EMPTY_GIT_FILE_SCHEME}) that previews
 * as an empty version of `localUri`'s file name in the diff editor's tab. */
function emptyGitFileUri(localUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.from({scheme: EMPTY_GIT_FILE_SCHEME, path: `/${path.basename(localUri.fsPath)}`});
}

// ── Tree node types ─────────────────────────────────────────────────────────

type TreeElement = WorkspaceNode | TypeGroupNode | ItemNode | FileNode;

/** Git connection details for a workspace, as returned by `fabricClient.getGitConnection`. */
type GitConnectionInfo = Awaited<ReturnType<NodeFabricClient["getGitConnection"]>>;

/** Git status response for a workspace, as returned by `fabricClient.getGitStatus`. */
type GitStatusInfo = Awaited<ReturnType<NodeFabricClient["getGitStatus"]>>;

/** A single item's git change entry within a {@link GitStatusInfo}. */
type GitItemChange = GitStatusInfo["changes"][number];

/** Git provider details for a connected workspace, as returned by `fabricClient.getGitConnection`. */
type GitProviderDetails = NonNullable<GitConnectionInfo["gitProviderDetails"]>;

export class WorkspaceNode extends vscode.TreeItem {
    /**
     * True if `gitConnection` resolved to an actively-connected state (not
     * `"NotConnected"`) with `gitProviderDetails` present. Drives the
     * `workspace.git` contextValue suffix so the inline "Git Pull" button
     * (`fabricDataFactory.gitPullWorkspace`) only shows for workspaces
     * actually connected to git.
     */
    public readonly gitConnected: boolean;

    constructor(
        public readonly workspaceId: string,
        public readonly displayName: string,
        ctx: vscode.ExtensionContext,
        gitConnection?: GitConnectionInfo | null,
    ) {
        super(displayName, vscode.TreeItemCollapsibleState.Expanded);
        this.id = `ws:${workspaceId}`;
        this.iconPath = svgIcon(ctx, "c_group_workspace_64.svg");

        const details = gitConnection?.gitProviderDetails;
        this.gitConnected = !!gitConnection && gitConnection.gitConnectionState !== "NotConnected" && !!details;
        this.contextValue = this.gitConnected ? "workspace.git" : "workspace";
        if (this.gitConnected && gitConnection && details) {
            const providerLabel = details.gitProviderType === "AzureDevOps"
                ? `Azure DevOps — ${details.organizationName}/${details.projectName}/${details.repositoryName}`
                : `GitHub — ${details.ownerName}/${details.repositoryName}`;
            // `TreeItem.description` is plain text: `$(icon)` codicon syntax
            // only renders in hovers (MarkdownString), `StatusBarItem.text`,
            // and `QuickPickItem` labels — not here — so a plain glyph is
            // used instead. The icon itself is shown in the tooltip below,
            // which (as a MarkdownString) does support it.
            this.description = `⎇ ${details.branchName}`;
            const tooltip = new vscode.MarkdownString(undefined, true);
            tooltip.appendMarkdown(
                `${displayName}\n\n${workspaceId}\n\n` +
                `$(git-branch) ${providerLabel}\n\n` +
                `Branch: \`${details.branchName}\`\n\n` +
                `State: ${gitConnection.gitConnectionState}`,
            );
            this.tooltip = tooltip;
        } else {
            this.tooltip = `${displayName}\n${workspaceId}`;
        }
    }
}

export class TypeGroupNode extends vscode.TreeItem {
    constructor(
        public readonly workspaceId: string,
        public readonly itemType: FabricItemType,
        public readonly parent: WorkspaceNode,
        ctx: vscode.ExtensionContext,
    ) {
        super(
            TYPE_LABELS[itemType] ?? itemType,
            vscode.TreeItemCollapsibleState.Collapsed,
        );
        this.id = `type:${workspaceId}/${itemType}`;
        this.contextValue = "typeGroup";
        this.iconPath = typeIcon(ctx, itemType);
    }
}

export class ItemNode extends vscode.TreeItem {
    /**
     * Absolute path to the item's locally-synced folder
     * (`<baseFolder>/.workspaces/<workspaceId>/<itemId>`). The tree lists the
     * files and folders beneath this path as {@link FileNode} children so the
     * user can browse an item's contents inline without hunting for the folder
     * on disk.
     */
    public readonly itemFolder: string;

    constructor(
        public readonly item: FabricItem,
        modified: boolean,
        public readonly parent: TypeGroupNode,
        ctx: vscode.ExtensionContext,
        airflowActiveItemId?: string,
        gitChange?: GitItemChange,
    ) {
        // Resolve the folder before `super()` (no `this` access allowed yet) so
        // we can pick a collapsible state: only show the expand twistie when
        // the folder actually has contents on disk.
        const itemFolder = path.join(
            getBaseFolder(ctx),
            ".workspaces",
            item.workspaceId,
            item.id,
        );
        const hasChildren = dirHasEntries(itemFolder);
        super(
            item.displayName,
            hasChildren
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
        );
        this.itemFolder = itemFolder;
        this.id = `item:${item.workspaceId}/${item.id}`;
        const isAirflowRunning = item.itemType === FabricItemType.ApacheAirflowJob && airflowActiveItemId === item.id;
        const baseContextValue = item.itemType === FabricItemType.ApacheAirflowJob
            ? (isAirflowRunning ? "item.airflow.running" : "item.airflow")
            : item.itemType === FabricItemType.Lakehouse
                ? "item.lakehouse"
                : item.itemType === FabricItemType.DataBuildToolJob
                    ? "item.dbt"
                    : item.itemType === FabricItemType.Warehouse
                        ? "item.warehouse"
                        : "item.default";
        // A trailing `.added` / `.modified` / `.deleted` / `.conflict` suffix
        // marks items with a *committable* git change (a workspace-side change
        // or a conflict — a pure remote-only change has nothing to commit), so
        // the `fabricDataFactory.commitItemToGit` context-menu entry can gate
        // on it via a `viewItem =~ /\.(added|modified|deleted|conflict)$/`
        // `when` clause. There's no need for a separate ".git" marker: the
        // suffix's mere presence already implies the workspace is
        // git-connected (git status is only ever populated for connected
        // workspaces — see `ensureGitInfoCache`).
        const changeKind = gitChangeKind(gitChange);
        const commitKind = isCommittableChange(gitChange) ? changeKind : undefined;
        this.contextValue = commitKind ? `${baseContextValue}.${commitKind}` : baseContextValue;
        this.iconPath = typeIcon(ctx, item.itemType);
        const gitBadge = formatGitChangeBadge(gitChange);
        this.description = [
            isAirflowRunning ? "running" : undefined,
            modified ? "● modified" : undefined,
            gitBadge,
        ].filter((p): p is string => !!p).join("  ") || undefined;
        this.tooltip =
            `${item.displayName} (${item.itemType})` +
            (modified ? " • locally modified" : "") +
            (isAirflowRunning ? " • running locally" : "") +
            (gitChange ? ` • git: ${describeGitChange(gitChange)}` : "");
        // Set a synthetic resourceUri so a FileDecorationProvider can colorize
        // the label. Airflow's running state takes priority (an established,
        // rarely-overlapping decoration); otherwise a git change colors the
        // item green/yellow/red for added/modified/deleted (or orange for a
        // conflict), matching VS Code's own Source Control colors.
        if (isAirflowRunning) {
            this.resourceUri = vscode.Uri.parse(`fabric-airflow:/${item.id}`);
        } else if (changeKind) {
            this.resourceUri = vscode.Uri.parse(`fabric-git:/${item.id}/${changeKind}`);
        }
        // No `this.command`: clicking an item only selects/expands it. Opening
        // is an explicit action via the `fabricDataFactory.openItem` context
        // menu entry (see `view/item/context` in package.json).
    }
}

/**
 * A file or folder beneath an {@link ItemNode}'s synced folder.
 *
 * Uses `resourceUri` so VS Code renders the native file icon and label for the
 * entry automatically. Files open via the built-in `vscode.open` command;
 * folders are collapsible and lazily list their own children on expand.
 */
export class FileNode extends vscode.TreeItem {
    constructor(
        public readonly uri: vscode.Uri,
        public readonly isDirectory: boolean,
        public readonly parent: ItemNode | FileNode,
        /**
         * Whether the owning item's workspace is connected to git (and a
         * connection with `gitProviderDetails` was actually resolved).
         * Threaded down from the owning `ItemNode` through `listDirNodes` so
         * a file's `contextValue` can drive the `fabricDataFactory.fs.compareWithGit`
         * menu entry's `when` clause — hiding it entirely for files under a
         * non-git-connected workspace, rather than showing it and then
         * immediately warning "isn't connected to git" when clicked.
         */
        public readonly gitConnected: boolean,
    ) {
        super(
            uri,
            isDirectory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
        );
        this.id = `file:${uri.fsPath}`;
        // Only files get the `.git` suffix (compare is meaningless for a
        // directory); the plain `fileNode.dir` contextValue is left
        // untouched so existing exact-match `when` clauses (`fs.newFile`,
        // `fs.newFolder`, `fs.paste`) keep working unchanged.
        this.contextValue = isDirectory ? "fileNode.dir" : (gitConnected ? "fileNode.file.git" : "fileNode.file");
        if (!isDirectory) {
            this.command = {
                command: "vscode.open",
                title: "Open File",
                arguments: [uri],
            };
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** True if `dir` exists and contains at least one entry. */
function dirHasEntries(dir: string): boolean {
    try {
        // `readdirSync` stops as soon as the directory is read; for the tiny
        // per-item folders here this is cheap and avoids an extra `statSync`.
        return fs.readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

/**
 * List the immediate children of `dir` as {@link FileNode}s, folders first then
 * files, each group sorted case-insensitively by name. Returns `[]` if the
 * directory is missing or unreadable. `gitConnected` is forwarded verbatim to
 * every created {@link FileNode} (see its constructor doc).
 */
function listDirNodes(dir: string, parent: ItemNode | FileNode, gitConnected: boolean): FileNode[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
        return [];
    }
    return entries
        .sort((a, b) => {
            const aDir = a.isDirectory() ? 0 : 1;
            const bDir = b.isDirectory() ? 0 : 1;
            if (aDir !== bDir) {
                return aDir - bDir;
            }
            return a.name.localeCompare(b.name);
        })
        .map(
            (e) =>
                new FileNode(
                    vscode.Uri.file(path.join(dir, e.name)),
                    e.isDirectory(),
                    parent,
                    gitConnected,
                ),
        );
}

/** Convert an ItemSyncState to a FabricItem for API calls. */
function stateToItem(state: ItemSyncState): FabricItem {
    return {
        id: state.itemId,
        displayName: state.displayName,
        itemType: state.itemType,
        workspaceId: state.workspaceId,
    };
}

/**
 * Directory names excluded from a dbt item's folder-selection push (see
 * {@link collectFileNodePaths}). Mirrors the Rust-side `DBT_ARTIFACT_SKIP_DIRS`
 * in `crates/core/src/toolchain/sync.rs`'s `collect_config_files`: these are
 * generated by local `dbt build`/`dbt run` runs and can contain ANSI/binary
 * content Fabric's JSON parser rejects (errorCode 2011), so — just like a
 * full push — a partial push triggered by selecting a folder must never
 * include them either.
 */
const DBT_ARTIFACT_SKIP_DIRS = new Set(["target", "logs", "dbt_packages", "dbt_modules"]);

/**
 * Directory names excluded from every folder-selection push, regardless of
 * item type.
 *
 * `__pycache__` mirrors the Rust-side `collect_files_recursive` in
 * `crates/core/src/toolchain/sync.rs`, which always drops it (Python bytecode
 * cache, not part of any item's definition) even for single-definition item
 * types that pass an empty `skip_dirs` list — so it must be excluded here
 * unconditionally too, not just for dbt.
 *
 * `.git` has no Rust-side equivalent (item folders normally never contain
 * one — the extension's own git mirror lives under a separate `.fabric-git`
 * tree), but a stray repo landing in an item's local folder would be just as
 * unpushable as dbt's artifacts, so it's excluded here defensively.
 */
const ALWAYS_SKIP_DIRS = new Set(["__pycache__", ".git"]);

/**
 * Recursively collect absolute file paths under `dir`. Missing/unreadable
 * directories return `[]`. Directories in {@link ALWAYS_SKIP_DIRS}, or whose
 * name is in `excludeDirNames`, are skipped entirely (along with everything
 * beneath them).
 */
function collectFilesRecursiveAbs(dir: string, excludeDirNames?: ReadonlySet<string>): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
        return results;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (ALWAYS_SKIP_DIRS.has(entry.name) || excludeDirNames?.has(entry.name)) {
                continue;
            }
            results.push(...collectFilesRecursiveAbs(full, excludeDirNames));
        } else if (entry.isFile()) {
            results.push(full);
        }
    }
    return results;
}

/**
 * Absolute file paths represented by `node`: itself if it's a file, or
 * every file found recursively beneath it if it's a directory. Used by
 * {@link WorkspacesTreeProvider.pushSelectedFiles} to expand a folder
 * selection into the individual files `pushItem`'s partial-push `files`
 * parameter expects.
 *
 * {@link ALWAYS_SKIP_DIRS} is always excluded. For dbt items, folder
 * selections additionally exclude the generated artifact directories in
 * {@link DBT_ARTIFACT_SKIP_DIRS}, matching what a full push already excludes
 * — otherwise selecting (or selecting a folder that contains) a dbt item's
 * root would try to push `target/`/`logs/` content a full push would never
 * include, and Fabric would reject it.
 */
function collectFileNodePaths(node: FileNode): string[] {
    if (!node.isDirectory) {
        return [node.uri.fsPath];
    }

    // Walk up to the owning ItemNode so item-type-specific exclusions
    // (currently just dbt's) can be applied.
    let cur: ItemNode | FileNode = node;
    while (cur instanceof FileNode) {
        cur = cur.parent;
    }
    const excludeDirNames = cur instanceof ItemNode && cur.item.itemType === FabricItemType.DataBuildToolJob ? DBT_ARTIFACT_SKIP_DIRS : undefined;

    return collectFilesRecursiveAbs(node.uri.fsPath, excludeDirNames);
}

/**
 * Build an LLM-friendly single-line reference for `node`, or `undefined` if
 * `node` isn't a referenceable kind. Supports `WorkspaceNode`, `TypeGroupNode`,
 * and `ItemNode` — `FileNode`s are left out since a chat agent operates on
 * Fabric workspaces/items, not individual synced files.
 *
 * Feeds the `fabricDataFactory.copyItemReference` command: the copied text
 * gives the @di chat participant everything it needs to target a specific
 * workspace / item type / item without the user having to spell out GUIDs
 * themselves. Returns both the reference `text` and a short `label` for the
 * status-bar confirmation message.
 */
function buildChatReference(node?: TreeElement): {text: string; label: string} | undefined {
    if (node instanceof ItemNode) {
        // Escape `"` in the display name so the quoted span stays unambiguous.
        const safeName = node.item.displayName.replace(/"/g, '\\"');
        return {
            text:
                `Fabric ${node.item.itemType} "${safeName}" ` +
                `(workspaceId: ${node.item.workspaceId}, itemId: ${node.item.id})`,
            label: node.item.displayName,
        };
    }
    if (node instanceof TypeGroupNode) {
        const safeName = node.parent.displayName.replace(/"/g, '\\"');
        const typeLabel = TYPE_LABELS[node.itemType] ?? node.itemType;
        return {
            text:
                `All Fabric ${node.itemType} items in workspace "${safeName}" ` +
                `(workspaceId: ${node.workspaceId}, itemType: ${node.itemType})`,
            label: `${typeLabel} in "${node.parent.displayName}"`,
        };
    }
    if (node instanceof WorkspaceNode) {
        const safeName = node.displayName.replace(/"/g, '\\"');
        return {
            text: `Fabric workspace "${safeName}" (workspaceId: ${node.workspaceId})`,
            label: node.displayName,
        };
    }
    return undefined;
}

/**
 * Render a short badge for an item's git change, or `undefined` if there's no
 * change to show. A conflict (both sides changed) takes priority over a
 * plain workspace/remote change.
 *
 * This feeds `TreeItem.description`, which is plain text — unlike hovers, it
 * does not render `$(icon)` codicon syntax — so plain Unicode glyphs are used
 * instead (⚠ conflict, ↑ pending commit, ↓ pending update).
 */
function formatGitChangeBadge(change?: GitItemChange): string | undefined {
    if (!change) {
        return undefined;
    }
    if (change.conflictType === "Conflict") {
        return "⚠ git conflict";
    }
    if (change.workspaceChange) {
        return `↑ ${change.workspaceChange}`;
    }
    if (change.remoteChange) {
        return `↓ ${change.remoteChange}`;
    }
    return undefined;
}

/** Human-readable description of an item's git change, for tooltips. */
function describeGitChange(change: GitItemChange): string {
    if (change.conflictType === "Conflict") {
        return "conflicting changes (both workspace and remote modified)";
    }
    const parts: string[] = [];
    if (change.workspaceChange) {
        parts.push(`${change.workspaceChange} locally (needs commit)`);
    }
    if (change.remoteChange) {
        parts.push(`${change.remoteChange} in git (needs update)`);
    }
    return parts.length > 0 ? parts.join("; ") : "no pending changes";
}

/**
 * Classify a git change into one of the four kinds used for both the
 * `fabric-git:` decoration color and the `ItemNode.contextValue` suffix:
 * `"conflict"` (both sides changed), or `"added" | "modified" | "deleted"`
 * from whichever of `workspaceChange` / `remoteChange` is set (conflict wins,
 * then workspace, then remote — same priority as {@link formatGitChangeBadge}).
 * An unrecognized (future) change-type string still falls back to
 * `"modified"` rather than being dropped, so forward-compat values remain
 * visible/committable. Returns `undefined` only when there's no change at all.
 */
function gitChangeKind(change?: GitItemChange): "added" | "modified" | "deleted" | "conflict" | undefined {
    if (!change) {
        return undefined;
    }
    if (change.conflictType === "Conflict") {
        return "conflict";
    }
    const raw = change.workspaceChange ?? change.remoteChange;
    if (!raw) {
        return undefined;
    }
    if (raw === "Added") {
        return "added";
    }
    if (raw === "Deleted") {
        return "deleted";
    }
    return "modified";
}

/**
 * True if `change` represents something a `commitToGit` call could actually
 * commit — a conflict or a workspace-side change. A remote-only change has
 * nothing pending on the workspace side, so `fabricDataFactory.commitItemToGit`
 * should stay hidden for it (that direction needs an "update from git"
 * instead, not implemented yet).
 */
function isCommittableChange(change?: GitItemChange): boolean {
    return !!change && (change.conflictType === "Conflict" || !!change.workspaceChange);
}

// ── Tree data provider ──────────────────────────────────────────────────────

/**
 * Tree data provider for the Fabric Data Factory sidebar.
 *
 * Shows: Workspace → Type Group → Items.
 *
 * **Offline-first**: the tree reads from the local `.fabric/` sync index
 * populated by `pullByConfig`. No HTTP calls are made when expanding nodes.
 *
 * **Select Workspaces** updates `fabric-di.yaml` then triggers a full
 * `pullByConfig` with a cancellable progress notification.
 */
export class WorkspacesTreeProvider
    implements vscode.TreeDataProvider<TreeElement> {
    // ── Public fields ─────────────────────────────────────────

    readonly onDidChangeTreeData: vscode.Event<TreeElement | undefined>;

    // ── Private fields ────────────────────────────────────────

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<
        TreeElement | undefined
    >();

    /** The VS Code tree view instance. */
    private readonly _treeView: vscode.TreeView<TreeElement>;

    /** Cached workspaces keyed by ID. Populated lazily on first tree render. */
    private _workspacesById = new Map<string, Workspace>();

    /**
     * Git connection details per workspace, fetched lazily via
     * `fabricClient.getGitConnection`. Absent key = not yet fetched;
     * `null` = fetch failed (e.g. insufficient permissions) — rendered the
     * same as "not connected" (plain workspace node, no git badge).
     */
    private _gitConnectionByWorkspaceId = new Map<string, GitConnectionInfo | null>();

    /**
     * Per-item git change info for git-connected workspaces, fetched via
     * `fabricClient.getGitStatus` and keyed by the item's object ID (matches
     * `FabricItem.id`). Only populated for workspaces whose cached
     * `gitConnectionState` isn't `NotConnected`.
     */
    private _gitStatusByWorkspaceId = new Map<string, Map<string, GitItemChange>>();

    /**
     * Whether we've already emitted a `listWorkspaces` trace. The first fetch
     * is the earliest end-to-end proof that auth + network + tenant all line
     * up, so it's tagged `first` to stand out in the logs.
     */
    private _firstWorkspaceFetchTraced = false;

    /**
     * Guard so the S7 "can't reach Fabric" connectivity warning is shown at
     * most once per window — repeated tree refreshes shouldn't re-nag.
     */
    private _fabricUnreachableWarned = false;

    /** Access-failure kinds already surfaced this window, so refreshes don't re-nag. */
    private readonly _accessWarned = new Set<FabricAccessKind>();

    /** ID of the currently running Airflow item (for tree decoration). */
    private _airflowActiveItemId: string | undefined;

    /**
     * Pending debounce timer for `.fabric/` watcher events. Set when a watch
     * event fires, cleared once the debounce window elapses or on dispose.
     * Holding only the most recent handle means rapid bursts collapse into a
     * single trailing `refresh()` call.
     */
    private _fabricRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Debounce timer for `.workspaces/` watcher events. Separate from
     * `_fabricRefreshTimer` because those events drive a granular, per-item
     * refresh rather than a full-tree invalidation.
     */
    private _workspacesRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Item keys (`<workspaceId>/<itemId>`) touched by `.workspaces/` events
     * within the current debounce window. Flushed into targeted
     * `onDidChangeTreeData` fires so only the affected item subtrees re-render.
     */
    private readonly _pendingItemKeys = new Set<string>();

    /**
     * Set when a `.workspaces/` event can't be mapped to a single item (e.g. a
     * whole `<workspaceId>/` folder was created or deleted), forcing a full
     * refresh on the next debounce flush instead of per-item fires.
     */
    private _workspacesFullRefreshPending = false;

    /**
     * Currently-rendered `ItemNode`s keyed by `<workspaceId>/<itemId>`. Holds
     * the exact instances handed to VS Code so a `.workspaces/` change can fire
     * a targeted refresh for just that node. Rebuilt on every full render.
     */
    private readonly _renderedItemNodes = new Map<string, ItemNode>();

    /**
     * URIs staged by the "Copy" file command, pasted into a target folder by
     * the "Paste" command. Drives the `fabricDataFactory.fsClipboardFull`
     * context key that gates the Paste menu item.
     */
    private _fsClipboard: vscode.Uri[] = [];

    /**
     * Fires when a `fabric-git:` decoration (see {@link provideGitDecoration})
     * may need to be recomputed — i.e. whenever the tree refreshes, since
     * that's the only time git status can have changed.
     */
    private readonly _onDidChangeGitDecorations = new vscode.EventEmitter<
        vscode.Uri | vscode.Uri[] | undefined
    >();

    // ── Constructor ───────────────────────────────────────────

    constructor(private readonly context: vscode.ExtensionContext) {
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.updateHasWorkspace();

        // Create tree view
        this._treeView = vscode.window.createTreeView("fabricDataFactory", {
            treeDataProvider: this,
            showCollapseAll: true,
            canSelectMany: true,
        });

        context.subscriptions.push(
            this._treeView,
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration(GIT_INTEGRATION_SETTING)) {
                    // Drop whatever git state was (or wasn't) cached so the next
                    // render either re-fetches it or renders fully git-free.
                    this.invalidateGitInfoCache();
                    this.refresh();
                }
            }),
            vscode.window.registerFileDecorationProvider({
                onDidChangeFileDecorations: this._onDidChangeGitDecorations.event,
                provideFileDecoration: (uri) => this.provideGitDecoration(uri),
            }),
            vscode.workspace.registerTextDocumentContentProvider(EMPTY_GIT_FILE_SCHEME, {
                provideTextDocumentContent: () => "",
            }),
            vscode.commands.registerCommand("fabricDataFactory.pullAll", () =>
                this.pullAndRefresh(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.revealActiveFile",
                () => void this.revealActiveFile(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.selectWorkspaces",
                () => this.selectWorkspaces(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.openItem",
                (node?: ItemNode, preferNotebook?: boolean) => {
                    if (node) {
                        // Context-menu invocations only pass the node, so default
                        // to the notebook experience when the flag is omitted.
                        void this.openItem(node.item, preferNotebook ?? true);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.pushItem",
                (node?: ItemNode) => {
                    if (node) {
                        void this.pushItem(node.item);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.pushWorkspace",
                (node?: WorkspaceNode) => {
                    if (node) {
                        void this.pushWorkspace(node);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.pushTypeGroup",
                (node?: TypeGroupNode) => {
                    if (node) {
                        void this.pushTypeGroup(node);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.pullItem",
                (node?: ItemNode) => {
                    if (node) {
                        void this.pullItem(node.item);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.commitItemToGit",
                (node?: ItemNode) => {
                    if (node) {
                        void this.commitItemToGit(node.item);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.commitWorkspaceToGit",
                (node?: WorkspaceNode) => {
                    if (node) {
                        void this.commitWorkspaceToGit(node);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.openInPortal",
                async (node?: ItemNode) => {
                    const di = tryGetDIContext();
                    if (node && di) {
                        const fabricClient = di.fabricClient;
                        const portalHost = await fabricClient.portalHost();
                        let itemPath = "item";
                        switch (node.item.itemType) {
                            case FabricItemType.DataPipeline:
                                itemPath = "pipelines";
                                break;
                            case FabricItemType.CopyJob:
                                itemPath = "copyjobs";
                                break;
                            case FabricItemType.Dataflow:
                                itemPath = "dataflows-gen2";
                                break;
                            case FabricItemType.DataBuildToolJob:
                                itemPath = "dbtitems";
                                break;
                            case FabricItemType.ApacheAirflowJob:
                                itemPath = "apacheairflowprojects";
                                break;
                            case FabricItemType.Lakehouse:
                                itemPath = "lakehouses";
                                break;
                            case FabricItemType.Warehouse:
                                itemPath = "warehouses";
                                break;
                            case FabricItemType.SQLEndpoint:
                                itemPath = "mirroredwarehouses";
                                break;
                            default:
                                return;
                        }
                        const url = `https://${portalHost}/groups/${encodeURIComponent(node.item.workspaceId)}/${itemPath}/${encodeURIComponent(node.item.id)}?experience=fabric-developer`;
                        void vscode.env.openExternal(vscode.Uri.parse(url));
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.copyItemReference",
                async (node?: TreeElement) => {
                    const reference = buildChatReference(node);
                    if (!reference) {
                        return;
                    }
                    await vscode.env.clipboard.writeText(reference.text);
                    vscode.window.setStatusBarMessage(
                        `Copied reference for "${reference.label}" to clipboard.`,
                        3000,
                    );
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.setAirflowActive",
                (node?: ItemNode) => {
                    if (node) {
                        void this.setAirflowActive(node.item);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.setDefaultDbtItemConfig",
                (node?: ItemNode) => {
                    if (node) {
                        void this.setDefaultDbtItemConfig(node.item);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.expandAll",
                () => this.expandAll(),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.createItem",
                (node?: WorkspaceNode) => {
                    if (node) {
                        void this.createItem(node.workspaceId);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.gitPullWorkspace",
                (node?: WorkspaceNode) => {
                    if (node) {
                        void this.gitPullWorkspace(node);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.deleteItem",
                (node?: ItemNode) => {
                    if (node) {
                        void this.deleteRemoteAndLocalItem(node.item);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.newFile",
                (node?: TreeElement) => void this.fsNew(node, "file"),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.newFolder",
                (node?: TreeElement) => void this.fsNew(node, "folder"),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.rename",
                (node?: TreeElement) => void this.fsRename(node),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.delete",
                (node?: TreeElement, selected?: TreeElement[]) =>
                    void this.fsDelete(node, selected),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.copy",
                (node?: TreeElement, selected?: TreeElement[]) =>
                    this.fsCopy(node, selected),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.paste",
                (node?: TreeElement) => void this.fsPaste(node),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.copyPath",
                (node?: TreeElement, selected?: TreeElement[]) =>
                    void this.fsCopyPath(node, selected),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.copyRelativePath",
                (node?: TreeElement) => void this.fsCopyRelativePath(node),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.pushSelectedFiles",
                (node?: TreeElement, selected?: TreeElement[]) =>
                    void this.pushSelectedFiles(node, selected),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.compareWithGit",
                (node?: TreeElement) => {
                    if (node instanceof FileNode && !node.isDirectory) {
                        void this.compareWithGit(node);
                    }
                },
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.revealInExplorer",
                (node?: TreeElement) => this.runBuiltinOnNode("revealInExplorer", node),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.revealInOS",
                (node?: TreeElement) => this.runBuiltinOnNode("revealFileInOS", node),
            ),
            vscode.commands.registerCommand(
                "fabricDataFactory.fs.openInTerminal",
                (node?: TreeElement) =>
                    this.runBuiltinOnNode("openInIntegratedTerminal", node),
            ),
        );

        // ── Watch <baseFolder>/.fabric/ for out-of-band changes ─────────
        //
        // The tree is offline-first: every render reads from
        // `syncService.readLocalItemStatesMap()`, which scans the
        // `<baseFolder>/.fabric/<workspaceId>/<itemId>.json` index on disk.
        // If another SDK caller (a CLI, a co-installed extension, or a
        // concurrent `createItemAndPull` from this same extension) mutates
        // that folder, the tree should reflect the change without the user
        // having to manually re-pull.
        //
        // We use a `RelativePattern` rooted at the resolved base folder so
        // the watcher works even when `getBaseFolder()` resolves to a path
        // outside the open VS Code workspace (e.g. global storage). Events
        // are debounced via `FABRIC_WATCH_DEBOUNCE_MS` so a single
        // `pullByConfig` writing many state files in quick succession
        // produces exactly one trailing refresh.
        const baseFolder = getBaseFolder(context);
        const fabricWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(baseFolder, ".fabric/**/*.json"),
        );
        const scheduleFabricRefresh = () => {
            if (this._fabricRefreshTimer) {
                clearTimeout(this._fabricRefreshTimer);
            }
            this._fabricRefreshTimer = setTimeout(() => {
                this._fabricRefreshTimer = undefined;
                this.updateHasWorkspace();
                this.refresh();
            }, FABRIC_WATCH_DEBOUNCE_MS);
        };
        context.subscriptions.push(
            fabricWatcher,
            fabricWatcher.onDidCreate(scheduleFabricRefresh),
            fabricWatcher.onDidChange(scheduleFabricRefresh),
            fabricWatcher.onDidDelete(scheduleFabricRefresh),
            {
                dispose: () => {
                    if (this._fabricRefreshTimer) {
                        clearTimeout(this._fabricRefreshTimer);
                        this._fabricRefreshTimer = undefined;
                    }
                },
            },
        );

        // ── Watch <baseFolder>/.workspaces/ for out-of-band file edits ──
        //
        // `ItemNode`s expand to show the files/folders under
        // `<baseFolder>/.workspaces/<workspaceId>/<itemId>` (see `FileNode`).
        // The tree only renders entry *names*, so a file's content changing is
        // irrelevant — we listen to create/delete only. Each event is mapped
        // back to its owning item and, after a debounce, fired as a targeted
        // refresh so just that item's subtree re-renders (falling back to a
        // full refresh when an event spans multiple items or the item isn't
        // currently rendered). Stable `TreeItem.id`s preserve expansion and
        // selection across every refresh.
        const workspacesWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(baseFolder, ".workspaces/**"),
        );
        context.subscriptions.push(
            workspacesWatcher,
            workspacesWatcher.onDidCreate((uri) => this.scheduleWorkspaceItemRefresh(uri)),
            workspacesWatcher.onDidDelete((uri) => this.scheduleWorkspaceItemRefresh(uri)),
            {
                dispose: () => {
                    if (this._workspacesRefreshTimer) {
                        clearTimeout(this._workspacesRefreshTimer);
                        this._workspacesRefreshTimer = undefined;
                    }
                },
            },
        );
    }

    // ── Public methods ────────────────────────────────────────

    /** Add a workspace by ID (e.g. from a deep link) and pull. */
    setWorkspaceById(workspaceId: string): void {
        const di = tryGetDIContext();
        if (!di) {
            return;
        }
        const ids = this.getSelectedWorkspaceIds();
        if (!ids.includes(workspaceId)) {
            di.configClient.addPullWorkspace(workspaceId, null);
        }
        this.updateHasWorkspace();
        void this.pullAndRefresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
        this._onDidChangeGitDecorations.fire(undefined);
    }

    /**
     * Connect to the AirflowService so the tree shows running state.
     * Call this after both the tree provider and airflow service are created.
     */
    connectAirflowService(airflowService: {
        onDidChangeState: vscode.Event<{ state: string; item?: FabricItem }>;
        activeItem?: FabricItem
    }): void {
        this.context.subscriptions.push(
            airflowService.onDidChangeState(({item}) => {
                this._airflowActiveItemId = item?.id;
                this.refresh();
            }),
        );
        this._airflowActiveItemId = airflowService.activeItem?.id;
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        return element;
    }

    getParent(element: TreeElement): TreeElement | undefined {
        if (element instanceof FileNode) {
            return element.parent;
        }
        if (element instanceof ItemNode) {
            return element.parent;
        }
        if (element instanceof TypeGroupNode) {
            return element.parent;
        }
        return undefined;
    }

    async getChildren(element?: TreeElement): Promise<TreeElement[]> {
        const di = tryGetDIContext();
        if (!di) {
            return [];
        }

        // Read the local sync index — no HTTP calls
        const index = di.syncService.readLocalItemStatesMap();
        const states = Object.values(index);

        if (states.length === 0) {
            // No items pulled yet — show welcome view
            this.updateHasWorkspace();
            return [];
        }

        // Collect workspace IDs that have items
        const wsIds = [...new Set(states.map((s) => s.workspaceId))].sort();

        // Root: show workspace nodes
        if (!element) {
            // A full render rebuilds every node, so drop the stale item-node
            // registry; it repopulates as type groups render below.
            this._renderedItemNodes.clear();
            // Populate workspace display names and git connection info lazily,
            // in parallel — independent caches, independent HTTP calls.
            await Promise.all([this.ensureWorkspaceCache(), this.ensureGitInfoCache(wsIds)]);
            this.updateHasWorkspace();
            return wsIds.map((id) => {
                const ws = this._workspacesById.get(id);
                return new WorkspaceNode(id, ws?.displayName ?? id, this.context, this._gitConnectionByWorkspaceId.get(id));
            });
        }

        // Workspace node: show type groups (only types that have items)
        if (element instanceof WorkspaceNode) {
            const wsStates = states.filter(
                (s) => s.workspaceId === element.workspaceId,
            );
            const typesWithItems = new Set(wsStates.map((s) => s.itemType));
            return ENABLED_TYPES.filter((t) => typesWithItems.has(t)).map(
                (type) => new TypeGroupNode(element.workspaceId, type, element, this.context),
            );
        }

        // Type group: show items from local index
        if (element instanceof TypeGroupNode) {
            const gitChanges = this._gitStatusByWorkspaceId.get(element.workspaceId);
            const itemNodes = states
                .filter(
                    (s) =>
                        s.workspaceId === element.workspaceId &&
                        s.itemType === element.itemType,
                )
                .sort((a, b) => a.displayName.localeCompare(b.displayName))
                .map(
                    (s) => new ItemNode(stateToItem(s), s.locallyModified, element, this.context, this._airflowActiveItemId, gitChanges?.get(s.itemId)),
                );
            // Register the freshly-built nodes so `.workspaces/` events can fire
            // a targeted refresh at the exact instance VS Code holds.
            for (const node of itemNodes) {
                this._renderedItemNodes.set(
                    `${node.item.workspaceId}/${node.item.id}`,
                    node,
                );
            }
            return itemNodes;
        }

        // Item node: list files/folders from the synced item folder on disk.
        if (element instanceof ItemNode) {
            return listDirNodes(element.itemFolder, element, this.isGitConnected(element.item.workspaceId));
        }

        // Folder node: lazily list its own children on expand.
        if (element instanceof FileNode) {
            return element.isDirectory
                ? listDirNodes(element.uri.fsPath, element, element.gitConnected)
                : [];
        }

        return [];
    }

    // ── Private methods ───────────────────────────────────────

    /**
     * True if `workspaceId`'s cached git connection is resolved, connected,
     * and carries `gitProviderDetails` — i.e. `compareWithGit` could actually
     * do something useful for a file under this workspace. Drives the
     * `fileNode.file.git` contextValue suffix (see `FileNode`) so the
     * "Compare with Git" menu entry is hidden entirely for files under a
     * non-git-connected (or not-yet-resolved) workspace, instead of being
     * shown and immediately warning when clicked.
     */
    private isGitConnected(workspaceId: string): boolean {
        const connection = this._gitConnectionByWorkspaceId.get(workspaceId);
        return !!connection && connection.gitConnectionState !== "NotConnected" && !!connection.gitProviderDetails;
    }

    /**
     * Whether Fabric git integration is turned on (`fabricDataFactory.gitIntegration`,
     * default `true`). When off, no git connection/status calls are made at all,
     * so every workspace/item/file renders without a git contextValue suffix and
     * the git menu entries stay hidden.
     */
    private isGitIntegrationEnabled(): boolean {
        return getSettings().gitIntegration;
    }

    /**
     * Guard for the git commands that can still be reached with the feature
     * turned off (e.g. from a stale context menu, or the command palette).
     * Returns `true` when git integration is enabled; otherwise notifies and
     * returns `false`.
     */
    private ensureGitIntegrationEnabled(): boolean {
        if (this.isGitIntegrationEnabled()) {
            return true;
        }
        // Status bar rather than a warning toast: it auto-hides, like the
        // other transient notices in this file (see `fsCopy`).
        vscode.window.setStatusBarMessage(
            `⚠ Fabric git integration is disabled. Enable "${GIT_INTEGRATION_SETTING}" in settings to use git features.`,
            3000,
        );
        return false;
    }

    private getSelectedWorkspaceIds(): string[] {
        const di = tryGetDIContext();
        if (!di) {
            return [];
        }
        const cfg = di.configClient.load();
        return Object.keys(cfg.fabric.pull);
    }

    /**
     * Ensure the workspace cache is populated. Fetches all workspaces from
     * Fabric on first call, then returns the cached map. Call with
     * `force: true` to invalidate and re-fetch (e.g. before selectWorkspaces).
     */
    private async ensureWorkspaceCache(
        force = false,
    ): Promise<Map<string, Workspace>> {
        if (!force && this._workspacesById.size > 0) {
            return this._workspacesById;
        }

        const di = tryGetDIContext();
        if (!di) {
            return this._workspacesById;
        }

        // First-run observability: the first successful/failed listWorkspaces is
        // the earliest end-to-end proof that auth + network + tenant all line
        // up. Tag folder vs non-folder so those first runs are distinguishable.
        const first = !this._firstWorkspaceFetchTraced;
        const folderMode =
            (vscode.workspace.workspaceFolders?.length ?? 0) > 0 ? "folder" : "non-folder";
        const startedAt = Date.now();
        try {
            const all = await di.fabricClient.listWorkspaces();
            this._firstWorkspaceFetchTraced = true;
            sdkLog.info(
                `listWorkspaces ${first ? "first " : ""}ok count=${all.length} ` +
                    `folderMode=${folderMode} durationMs=${Date.now() - startedAt}`,
                "extension/workspaces",
            );
            this._workspacesById.clear();
            for (const ws of all) {
                this._workspacesById.set(ws.id, ws);
            }
            return this._workspacesById;
        } catch (err) {
            this._firstWorkspaceFetchTraced = true;
            const detail = err instanceof Error ? err.message : String(err);
            // Ask the service first (it names the reason), then the transport.
            const access = classifyFabricAccess(err);
            const netKind = classifyNetworkError(detail);
            sdkLog.error(
                `listWorkspaces ${first ? "first " : ""}failed ` +
                    `folderMode=${folderMode} kind=${access ?? netKind} durationMs=${Date.now() - startedAt}: ${detail}`,
                "extension/workspaces",
            );
            if (access) {
                this.warnFabricAccessOnce(access);
            } else if (isLikelyBlocked(netKind)) {
                // S7: we got past auth (a token was mintable) but the network to
                // Fabric looks blocked — proxy / TLS interception / firewall / DNS.
                // Surface the likely cause once, instead of a generic error.
                this.warnFabricUnreachableOnce(netKind);
            }
            throw err;
        }
    }

    /**
     * Fetch and cache git connection (+ status, if connected) info for any of
     * `wsIds` not already cached. Errors (insufficient permissions, transient
     * failures) are swallowed per-workspace — the tree falls back to
     * rendering that workspace as a plain (non-git) node rather than failing
     * the whole render. Call {@link invalidateGitInfoCache} to force a
     * re-fetch (e.g. after a pull).
     */
    private async ensureGitInfoCache(wsIds: string[]): Promise<void> {
        const di = tryGetDIContext();
        if (!di || !this.isGitIntegrationEnabled()) {
            return;
        }
        const missing = wsIds.filter((id) => !this._gitConnectionByWorkspaceId.has(id));
        if (missing.length === 0) {
            return;
        }
        await Promise.all(
            missing.map(async (workspaceId) => {
                try {
                    const connection = await di.fabricClient.getGitConnection(workspaceId);
                    this._gitConnectionByWorkspaceId.set(workspaceId, connection);
                    if (connection.gitConnectionState === "NotConnected") {
                        return;
                    }
                    if (connection.gitProviderDetails) {
                        // Cheap (no-op if a mirror is already cloned) and
                        // deduplicated/coalesced on the Rust side — safe to
                        // fire on every tree root render without re-cloning
                        // or re-fetching. Fire-and-forget: a slow first-time
                        // clone must never delay the tree from rendering or
                        // the git-status fetch below.
                        void this.ensureGitMirror(workspaceId, connection.gitProviderDetails);
                    }
                    try {
                        const status = await di.fabricClient.getGitStatus(workspaceId);
                        const changesByItemId = new Map<string, GitItemChange>();
                        for (const change of status.changes) {
                            const itemId = change.itemMetadata.itemIdentifier.objectId;
                            if (itemId) {
                                changesByItemId.set(itemId, change);
                            }
                        }
                        this._gitStatusByWorkspaceId.set(workspaceId, changesByItemId);
                    } catch {
                        // Status fetch failed (e.g. an Update From Git is in
                        // progress) — keep the connection badge, just skip
                        // per-item change decoration for this render.
                    }
                } catch {
                    this._gitConnectionByWorkspaceId.set(workspaceId, null);
                }
            }),
        );
    }

    /**
     * Ensure a local git mirror clone exists for `workspaceId`, warming up
     * `.fabric-git/<workspaceId>/` so a future "compare local vs. git"
     * feature always has something to diff against.
     *
     * This is deliberately fire-and-forget from {@link ensureGitInfoCache},
     * which only runs for workspaces missing from the git-connection cache —
     * so this fires once per cache fill (after a pull/push/commit/create/delete
     * invalidates it), not on every render. `gitHelperService.ensureRepoCloned`
     * is a cheap no-op once the mirror exists (a local read, no network) and
     * concurrent calls for the same workspace are coalesced on the Rust side.
     * A mirror that has never cloned successfully is the expensive case: each
     * cache fill re-attempts a full token + clone. Only an actual comparison
     * should force a fresh sync — see `gitHelperService.forceSyncRepo`.
     *
     * Failures (no `git` on PATH, an interactive credential prompt is
     * needed, network blocked, …) are logged but otherwise swallowed: the
     * mirror only backs a future diff feature, not the tree's core
     * pull/push/browse functionality.
     */
    private async ensureGitMirror(workspaceId: string, gitProviderDetails: GitProviderDetails): Promise<void> {
        const di = tryGetDIContext();
        if (!di) {
            return;
        }
        const startedAt = Date.now();
        try {
            const result = await di.gitHelperService.ensureRepoCloned(workspaceId, gitProviderDetails);
            sdkLog.info(
                `ensureRepoCloned ok workspace=${workspaceId} branch=${result.branch} ` +
                    `commit=${result.commitSha} durationMs=${Date.now() - startedAt}`,
                "extension/git-mirror",
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Transience is decided in Rust (`GitHelperError::is_transient`) and rides
            // across as a diagnostic field, so a bad remote minute doesn't bury the
            // real failures at ERROR.
            const transient = parseDiagnostic(e)?.fields.transient === true;
            const line = `ensureRepoCloned failed for workspace ${workspaceId} durationMs=${Date.now() - startedAt}: ${msg}`;
            if (transient) {
                sdkLog.warn(`${line} (transient — retried when the git-connection cache is next refreshed)`, "extension/git-mirror");
            } else {
                sdkLog.error(line, "extension/git-mirror");
            }
        }
    }

    /**
     * Drop the cached git connection/status info so the next tree render
     * re-fetches it from Fabric. Called after a pull, since that's the
     * natural point where the user expects git state to be up to date.
     *
     * Pass `workspaceIds` to drop just those workspaces' entries (e.g. after
     * committing a single item, or pushing a batch that spans several
     * workspaces); omit it to drop the whole cache (e.g. after a bulk pull
     * that may touch any of the selected workspaces).
     */
    private invalidateGitInfoCache(workspaceIds?: string[]): void {
        if (workspaceIds) {
            for (const id of workspaceIds) {
                this._gitConnectionByWorkspaceId.delete(id);
                this._gitStatusByWorkspaceId.delete(id);
            }
            return;
        }
        this._gitConnectionByWorkspaceId.clear();
        this._gitStatusByWorkspaceId.clear();
    }

    /**
     * Drop `workspaceIds`' cached git connection/status and re-fetch them
     * once, so the very next `refresh()` reflects up-to-date git state
     * instead of the stale pre-mutation snapshot.
     *
     * Call this after any operation that mutates an item's content on
     * Fabric — push, create, delete, commit — since each can change the
     * diff between the workspace and its connected git branch (e.g. pushing
     * new content is exactly what turns a clean item into a "Modified"
     * workspace change). Accepts multiple workspace IDs (mirroring
     * {@link ensureGitInfoCache}) so a batch operation spanning several
     * workspaces only needs a single call.
     */
    private async refreshGitInfoForWorkspaces(workspaceIds: string[]): Promise<void> {
        this.invalidateGitInfoCache(workspaceIds);
        await this.ensureGitInfoCache(workspaceIds);
    }

    /**
     * Color-codes `ItemNode` labels by git change kind — green for added,
     * yellow for modified, red for deleted, orange for a conflict — using
     * the same `gitDecoration.*ResourceForeground` theme colors VS Code's
     * own Source Control view uses, so items read consistently with the
     * rest of the editor's git UI.
     *
     * Triggered by `fabric-git:/<itemId>/<kind>` URIs set on
     * `ItemNode.resourceUri` (see the `ItemNode` constructor); `kind` is
     * the last path segment and is one of `added` / `modified` / `deleted`
     * / `conflict`.
     */
    private provideGitDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== "fabric-git") {
            return undefined;
        }
        switch (uri.path.split("/").pop()) {
            case "added":
                return {
                    color: new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
                    badge: "A",
                    tooltip: "Added in git",
                };
            case "modified":
                return {
                    color: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
                    badge: "M",
                    tooltip: "Modified in git",
                };
            case "deleted":
                return {
                    color: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
                    badge: "D",
                    tooltip: "Deleted in git",
                };
            case "conflict":
                return {
                    color: new vscode.ThemeColor("gitDecoration.conflictingResourceForeground"),
                    badge: "C",
                    tooltip: "Conflicting git changes",
                };
            default:
                return undefined;
        }
    }

    /**
     * Surface an access failure the user can act on once per window. This is not
     * a connectivity problem, so it deliberately does not reuse the S7 message —
     * that one would send the user chasing a proxy.
     */
    private warnFabricAccessOnce(kind: FabricAccessKind): void {
        if (this._accessWarned.has(kind)) {
            return;
        }
        this._accessWarned.add(kind);
        void vscode.window.showWarningMessage(fabricAccessAdvice(kind));
    }

    /**
     * One-time S7 connectivity warning: the token worked but Fabric couldn't be
     * reached, so a corporate proxy / TLS inspection / firewall is the likely
     * culprit. Offers the addon-independent Setup Doctor as the next step.
     */
    private warnFabricUnreachableOnce(kind: NetworkErrorKind): void {
        if (this._fabricUnreachableWarned) {
            return;
        }
        this._fabricUnreachableWarned = true;
        void vscode.window
            .showWarningMessage(
                `Couldn't reach Microsoft Fabric (${kind}). A corporate proxy, ` +
                    "TLS inspection, or firewall may be blocking api.fabric.microsoft.com.",
                "Run Setup Doctor",
            )
            .then((choice) => {
                if (choice === "Run Setup Doctor") {
                    void vscode.commands.executeCommand("fabricDataFactory.runSetupDoctor");
                }
            });
    }

    /**
     * Pull all items via `pullByConfig` with a cancellable progress
     * notification, then refresh the tree from local state.
     */
    private async pullAndRefresh(): Promise<void> {
        const di = requestDIContext();
        if (!di) {
            return;
        }

        const wsIds = this.getSelectedWorkspaceIds();
        if (wsIds.length === 0) {
            this.refresh();
            return;
        }

        const token = createCancellationToken();

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Pulling items from Fabric…",
                cancellable: true,
            },
            async (progress, vscodeToken) => {
                vscodeToken.onCancellationRequested(() => {
                    token.cancel();
                    log("Pull cancelled by user.");
                });

                try {
                    const results = await di.syncService.pullByConfig(
                        (_err, p) => {
                            if (!p) {
                                return;
                            }
                            const pct =
                                p.total > 0
                                    ? Math.round((p.completed / p.total) * 100)
                                    : 0;
                            progress.report({
                                message: `${p.completed}/${p.total} items (${pct}%)`,
                                increment: p.total > 0 ? 100 / p.total : 0,
                            });
                        },
                        token,
                    );
                    log(`Pulled ${results.length} item(s) from Fabric.`);
                } catch (e) {
                    // `reportError` parses the structured Diagnostic
                    // envelope produced by the addon and handles
                    // `Cancelled` (demote to log, no toast), `Auth`
                    // (offer "Sign In" button), and `Aggregate`
                    // (group-by-kind summary) automatically. The old
                    // string-includes heuristic is no longer needed.
                    await reportError("Pull failed", e);
                }
            },
        );

        // Git state (connection + status) may have changed as a result of the
        // pull, so drop the cache and let the next render re-fetch it.
        this.invalidateGitInfoCache();
        this.refresh();
    }

    private async selectWorkspaces(): Promise<void> {
        const di = requestDIContext();
        if (!di) {
            return;
        }

        try {
            // Fetch workspace list (only HTTP call in the tree lifecycle)
            const cache = await this.ensureWorkspaceCache(true);
            const allWorkspaces = [...cache.values()];
            if (allWorkspaces.length === 0) {
                vscode.window.showInformationMessage(
                    "No Fabric workspaces found. Check your Azure CLI login.",
                );
                return;
            }

            const currentIds = new Set(this.getSelectedWorkspaceIds());

            const picks = await vscode.window.showQuickPick(
                allWorkspaces.map((ws) => ({
                    label: ws.displayName,
                    description: ws.id,
                    picked: currentIds.has(ws.id),
                    workspace: ws,
                })),
                {
                    placeHolder: "Select one or more Fabric workspaces",
                    canPickMany: true,
                },
            );

            if (!picks) {
                return;
            }

            const selectedIds = new Set(picks.map((p) => p.workspace.id));

            // Update config: remove deselected, add newly selected
            for (const id of currentIds) {
                if (!selectedIds.has(id)) {
                    di.configClient.removePullWorkspace(id);
                }
            }
            for (const pick of picks) {
                if (!currentIds.has(pick.workspace.id)) {
                    di.configClient.addPullWorkspace(pick.workspace.id, null);
                }
            }

            this.updateHasWorkspace();

            // Pull everything according to the updated config
            await this.pullAndRefresh();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(
                `Failed to list workspaces: ${msg}`,
            );
        }
    }

    private async pushItem(item: FabricItem): Promise<void> {
        const di = requestDIContext();
        if (!di) {
            return;
        }

        const token = createCancellationToken();

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Pushing "${item.displayName}"…`,
                cancellable: true,
            },
            async (_progress, vscodeToken) => {
                vscodeToken.onCancellationRequested(() => {
                    token.cancel();
                    log(`Push cancelled by user for "${item.displayName}".`);
                });

                try {
                    const result = await di.syncService.pushItem(item, token);
                    log(`Pushed "${item.displayName}": ${result.configPartsPushed} config part(s).`);
                    vscode.window.showInformationMessage(
                        `Pushed "${item.displayName}" (${result.configPartsPushed} config part(s)).`,
                    );
                    // Pushing changes the item's content on Fabric, which is
                    // exactly what the git status diff compares against —
                    // refresh the cached git state so the tree picks up the
                    // new (likely "Modified") status.
                    await this.refreshGitInfoForWorkspaces([item.workspaceId]);
                    this.refresh();
                } catch (e) {
                    // `reportError` parses the structured Diagnostic
                    // envelope and demotes `Cancelled` to a log entry
                    // (no toast), so cancelling the progress just
                    // silently aborts the push.
                    await reportError(`Push failed for "${item.displayName}"`, e);
                }
            },
        );
    }

    private async pullItem(item: FabricItem): Promise<void> {
        const di = requestDIContext();
        if (!di) {
            return;
        }

        const token = createCancellationToken();

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Pulling "${item.displayName}"…`,
                cancellable: true,
            },
            async (_progress, vscodeToken) => {
                vscodeToken.onCancellationRequested(() => {
                    token.cancel();
                    log(`Pull cancelled by user for "${item.displayName}".`);
                });

                try {
                    const result = await di.syncService.pullItem(item, token);
                    log(`Pulled "${item.displayName}": ${result.filesWritten} file(s) written.`);
                    vscode.window.showInformationMessage(
                        `Pulled "${item.displayName}" (${result.filesWritten} file(s)).`,
                    );
                    // Refresh the tree so the ● modified marker clears.
                    this.refresh();
                } catch (e) {
                    // `reportError` parses the structured Diagnostic envelope and
                    // handles `Cancelled` / `Auth` / `Aggregate` cases automatically.
                    await reportError(`Pull failed for "${item.displayName}"`, e);
                }
            },
        );
    }

    /**
     * Push every locally-synced item in `node`'s workspace back to Fabric in
     * one batch. Wired to the `fabricDataFactory.pushWorkspace` context menu
     * command on `WorkspaceNode`s.
     */
    private async pushWorkspace(node: WorkspaceNode): Promise<void> {
        const di = tryGetDIContext();
        if (!di) {
            return;
        }
        const index = di.syncService.readLocalItemStatesMap();
        const items = Object.values(index)
            .filter((s) => s.workspaceId === node.workspaceId)
            .map(stateToItem);
        await this.pushItemsBatch(items, `Pushing all items in "${node.displayName}"…`, [node.workspaceId]);
    }

    /**
     * Push every locally-synced item of one type within a workspace back to
     * Fabric in one batch. Wired to the `fabricDataFactory.pushTypeGroup`
     * context menu command on `TypeGroupNode`s.
     */
    private async pushTypeGroup(node: TypeGroupNode): Promise<void> {
        const di = tryGetDIContext();
        if (!di) {
            return;
        }
        const index = di.syncService.readLocalItemStatesMap();
        const items = Object.values(index)
            .filter((s) => s.workspaceId === node.workspaceId && s.itemType === node.itemType)
            .map(stateToItem);
        const label = TYPE_LABELS[node.itemType] ?? node.itemType;
        await this.pushItemsBatch(items, `Pushing ${label} in "${node.parent.displayName}"…`, [node.workspaceId]);
    }

    /**
     * Shared batch-push implementation backing {@link pushWorkspace} and
     * {@link pushTypeGroup}: shows a single cancellable progress
     * notification for the whole set of `items`, delegates to
     * `syncService.pushItems` (the parallel batch push added alongside
     * `pullItems`), then refreshes cached git state + the tree.
     *
     * `items` is filtered down to {@link PUSHABLE_ITEM_TYPES} first, with a
     * status-bar notice for anything skipped — mirroring
     * {@link pushSelectedFiles}. Without this, a workspace/type-group
     * containing only Lakehouse/Warehouse items would silently push zero
     * items: the addon's `pushItems` itself drops non-syncable items before
     * running the batch, so the caller would otherwise see a misleadingly
     * successful "Pushed 0 item(s)" with no indication why.
     *
     * Per-item failures don't abort the batch — `pushItems` rejects with an
     * `Aggregate` diagnostic listing exactly which items failed and why
     * (handled by `reportError`), while items that succeeded are still
     * reflected as pushed.
     */
    private async pushItemsBatch(items: FabricItem[], title: string, workspaceIds: string[]): Promise<void> {
        if (items.length === 0) {
            vscode.window.showInformationMessage("No local items to push.");
            return;
        }

        const pushableItems = items.filter((i) => PUSHABLE_ITEM_TYPES.has(i.itemType));
        const skippedNonPushable = items.filter((i) => !PUSHABLE_ITEM_TYPES.has(i.itemType));
        if (skippedNonPushable.length > 0) {
            // Auto-hide via the status bar (see `pushSelectedFiles`'s
            // identical notice) rather than a manually-dismissed warning toast.
            vscode.window.setStatusBarMessage(
                `⚠ Skipped ${skippedNonPushable.map((i) => i.displayName).join(", ")}: this item type doesn't support push.`,
                3000,
            );
        }
        if (pushableItems.length === 0) {
            vscode.window.showInformationMessage("No pushable local items to push.");
            return;
        }

        const di = requestDIContext();
        if (!di) {
            return;
        }

        const token = createCancellationToken();

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: true,
            },
            async (progress, vscodeToken) => {
                vscodeToken.onCancellationRequested(() => {
                    token.cancel();
                    log(`Push cancelled by user for ${pushableItems.length} item(s).`);
                });

                try {
                    const results = await di.syncService.pushItems(
                        pushableItems,
                        (_err, p) => {
                            if (!p) {
                                return;
                            }
                            const pct =
                                p.total > 0
                                    ? Math.round((p.completed / p.total) * 100)
                                    : 0;
                            progress.report({
                                message: `${p.completed}/${p.total} items (${pct}%)`,
                                increment: p.total > 0 ? 100 / p.total : 0,
                            });
                        },
                        token,
                    );
                    log(`Pushed ${results.length} item(s) to Fabric.`);
                    vscode.window.showInformationMessage(`Pushed ${results.length} item(s) to Fabric.`);
                } catch (e) {
                    // `reportError` parses the structured Diagnostic envelope
                    // produced by the addon and handles `Cancelled` / `Auth`
                    // / `Aggregate` (per-item failure summary) automatically.
                    await reportError("Push failed", e);
                }
            },
        );

        // Pushing changes each item's content on Fabric, which is exactly
        // what the git status diff compares against — refresh the cached
        // git state for every touched workspace before re-rendering.
        await this.refreshGitInfoForWorkspaces(workspaceIds);
        this.refresh();
    }

    /**
     * Push a multi-selection of files and/or whole folders back to Fabric —
     * one `pushItem` call per *owning item*, dispatched in parallel, each
     * restricted to just the selected paths under that item via
     * `pushItem`'s partial-push `files` parameter, so the rest of every
     * item's remote definition is left untouched.
     *
     * Wired to the `fabricDataFactory.fs.pushSelectedFiles` context menu
     * command on `FileNode`s (files or folders — a folder expands to every
     * file found recursively beneath it). A selection spanning several
     * different items is grouped by owning `ItemNode` first; items whose
     * type doesn't support push (Lakehouse, Warehouse) are skipped with a
     * warning instead of failing. One item's push failure doesn't stop the
     * others (`Promise.allSettled`), and a single shared cancellation token
     * cancels every still-in-flight push.
     */
    private async pushSelectedFiles(node?: TreeElement, selected?: TreeElement[]): Promise<void> {
        const targets = this.fileNodeTargets(node, selected);
        if (targets.length === 0) {
            return;
        }

        const di = requestDIContext();
        if (!di) {
            return;
        }

        // Group selected paths by their owning item, converting each to a
        // path relative to the item's local folder (forward-slash, matching
        // `pushItem`'s `files` parameter).
        const groups = new Map<string, {item: FabricItem; itemFolder: string; relativePaths: Set<string>}>();
        const skippedNonPushable = new Set<string>();
        for (const target of targets) {
            const itemNode = this.itemNodeFor(target);
            if (!itemNode) {
                continue;
            }
            if (!PUSHABLE_ITEM_TYPES.has(itemNode.item.itemType)) {
                skippedNonPushable.add(itemNode.item.displayName);
                continue;
            }
            const key = `${itemNode.item.workspaceId}/${itemNode.item.id}`;
            let group = groups.get(key);
            if (!group) {
                group = {item: itemNode.item, itemFolder: itemNode.itemFolder, relativePaths: new Set()};
                groups.set(key, group);
            }
            for (const absPath of collectFileNodePaths(target)) {
                group.relativePaths.add(path.relative(group.itemFolder, absPath).split(path.sep).join("/"));
            }
        }

        if (skippedNonPushable.size > 0) {
            // `showWarningMessage` has no API to dismiss it early, so this
            // uses the status bar (auto-hides after 3s) like the other
            // transient confirmations in this file (see `fsCopy`,
            // `copyItemReference`).
            vscode.window.setStatusBarMessage(
                `⚠ Skipped ${[...skippedNonPushable].join(", ")}: this item type doesn't support push.`,
                3000,
            );
        }

        const groupList = [...groups.values()].filter((g) => g.relativePaths.size > 0);
        if (groupList.length === 0) {
            return;
        }

        const token = createCancellationToken();
        const total = groupList.length;
        let completed = 0;
        let succeeded = 0;
        const failures: {displayName: string; message: string}[] = [];

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title:
                    total === 1
                        ? `Pushing ${groupList[0].relativePaths.size} file(s) in "${groupList[0].item.displayName}"…`
                        : `Pushing selected files in ${total} item(s)…`,
                cancellable: true,
            },
            async (progress, vscodeToken) => {
                vscodeToken.onCancellationRequested(() => {
                    token.cancel();
                    log("Push (selected files) cancelled by user.");
                });

                await Promise.allSettled(
                    groupList.map(async (group) => {
                        const files = [...group.relativePaths];
                        try {
                            const result = await di.syncService.pushItem(group.item, token, files);
                            succeeded++;
                            log(
                                `Pushed ${files.length} file(s) for "${group.item.displayName}": ` +
                                `${result.configPartsPushed} config part(s) in the merged definition.`,
                            );
                        } catch (e) {
                            const message = e instanceof Error ? e.message : String(e);
                            failures.push({displayName: group.item.displayName, message});
                        } finally {
                            completed++;
                            progress.report({
                                message: `${completed}/${total} item(s)`,
                                increment: 100 / total,
                            });
                        }
                    }),
                );
            },
        );

        if (failures.length > 0) {
            const detail = failures.map((f) => `"${f.displayName}": ${f.message}`).join("; ");
            // Auto-hide via the status bar (see the skipped-items notice
            // above) rather than a manually-dismissed error toast.
            vscode.window.setStatusBarMessage(
                `⚠ Pushed ${succeeded}/${total} item(s); ${failures.length} failed: ${detail}`,
                3000,
            );
        } else {
            vscode.window.setStatusBarMessage(`Pushed selected files in ${succeeded} item(s).`, 3000);
        }

        // Pushing changes each item's content on Fabric, which is exactly
        // what the git status diff compares against.
        await this.refreshGitInfoForWorkspaces(groupList.map((g) => g.item.workspaceId));
        this.refresh();
    }

    /**
     * Commit a single item's pending changes to the workspace's connected
     * git branch, via `commitToGit` with `mode: "Selective"` and a one-item
     * `items` list (as opposed to `mode: "All"`, which would commit every
     * pending change in the workspace).
     *
     * Wired to the `fabricDataFactory.commitItemToGit` context menu command.
     * Only meaningful for items in a git-connected workspace, so this first
     * consults (and lazily populates) the cached `getGitConnection` result;
     * a not-connected workspace shows a warning instead of attempting the
     * commit.
     */
    private async commitItemToGit(item: FabricItem): Promise<void> {
        if (!this.ensureGitIntegrationEnabled()) {
            return;
        }
        const di = requestDIContext();
        if (!di) {
            return;
        }

        let connection = this._gitConnectionByWorkspaceId.get(item.workspaceId);
        if (connection === undefined) {
            try {
                connection = await di.fabricClient.getGitConnection(item.workspaceId);
                this._gitConnectionByWorkspaceId.set(item.workspaceId, connection);
            } catch {
                connection = null;
            }
        }
        if (!connection || connection.gitConnectionState === "NotConnected") {
            vscode.window.showWarningMessage(
                `"${item.displayName}"'s workspace isn't connected to git.`,
            );
            return;
        }

        const comment = await vscode.window.showInputBox({
            prompt: `Commit message for "${item.displayName}"`,
            placeHolder: "Optional — leave blank to let Fabric generate one",
        });
        if (comment === undefined) {
            // User cancelled the input box.
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Committing "${item.displayName}" to git…`,
            },
            async () => {
                try {
                    await di.fabricClient.commitToGit(item.workspaceId, {
                        mode: "Selective",
                        items: [{ objectId: item.id }],
                        comment: comment || undefined,
                    });
                    log(`Committed "${item.displayName}" (${item.id}) to git.`);
                    vscode.window.showInformationMessage(
                        `Committed "${item.displayName}" to git.`,
                    );
                    // The item's git status just changed — drop this workspace's
                    // cached connection/status, re-fetch it once, then refresh so
                    // the tree immediately reflects the new (clean) state.
                    await this.refreshGitInfoForWorkspaces([item.workspaceId]);
                    this.refresh();
                } catch (e) {
                    await reportError(`Failed to commit "${item.displayName}" to git`, e);
                }
            },
        );
    }

    /**
     * Commit *all* of a workspace's pending changes to its connected git
     * branch, via `commitToGit` with `mode: "All"` — the workspace-wide
     * counterpart to {@link commitItemToGit}'s single-item `mode: "Selective"`
     * commit.
     *
     * Wired to the `fabricDataFactory.commitWorkspaceToGit` context menu
     * command, shown only on `WorkspaceNode`s whose `contextValue` is
     * `"workspace.git"` (see `WorkspaceNode.gitConnected`) — i.e. only for
     * workspaces already known to be git-connected, so this never needs to
     * warn about a missing connection the way {@link commitItemToGit} does.
     */
    private async commitWorkspaceToGit(node: WorkspaceNode): Promise<void> {
        if (!this.ensureGitIntegrationEnabled()) {
            return;
        }
        const di = requestDIContext();
        if (!di) {
            return;
        }

        const comment = await vscode.window.showInputBox({
            prompt: `Commit message for "${node.displayName}"`,
            placeHolder: "Optional — leave blank to let Fabric generate one",
        });
        if (comment === undefined) {
            // User cancelled the input box.
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Committing "${node.displayName}" to git\u2026`,
            },
            async () => {
                try {
                    await di.fabricClient.commitToGit(node.workspaceId, {
                        mode: "All",
                        comment: comment || undefined,
                    });
                    log(`Committed all pending changes in "${node.displayName}" (${node.workspaceId}) to git.`);
                    vscode.window.showInformationMessage(
                        `Committed all pending changes in "${node.displayName}" to git.`,
                    );
                    // The workspace's git status just changed — drop the cached
                    // connection/status, re-fetch it once, then refresh so the
                    // tree immediately reflects the new (clean) state.
                    await this.refreshGitInfoForWorkspaces([node.workspaceId]);
                    this.refresh();
                } catch (e) {
                    await reportError(`Failed to commit "${node.displayName}" to git`, e);
                }
            },
        );
    }

    /**
     * Compare a locally-synced file against its counterpart in the
     * workspace's connected git repository, in VS Code's built-in diff
     * editor.
     *
     * - If the workspace isn't connected to git, or its git connection
     *   can't be resolved, shows a warning and stops.
     * - If the git mirror (`.fabric-git/<workspaceId>/`) hasn't been cloned
     *   locally yet, asks for confirmation first — cloning may pop up an
     *   interactive credential prompt (Git Credential Manager, or an Azure
     *   DevOps sign-in) if no usable token is already available.
     * - Either way, the mirror is always force-synced (fetch + hard-reset
     *   to the remote branch tip) before diffing, so the comparison is
     *   never against a stale clone from a previous session — only against
     *   the actual latest committed content.
     * - Finally resolves the file's path inside the mirror's
     *   `<DisplayName>.<ItemType>/` item folder (see
     *   `resolveItemGitFolder`) and opens `vscode.diff` against it. If no
     *   matching item folder or file exists in git yet (e.g. it was added
     *   locally after the last commit, or the item was never committed),
     *   the file is treated as brand-new: it's diffed against an empty
     *   virtual document (see `EMPTY_GIT_FILE_SCHEME`) instead of failing,
     *   so the diff simply shows the whole file as an addition.
     */
    private async compareWithGit(node: FileNode): Promise<void> {
        if (!this.ensureGitIntegrationEnabled()) {
            return;
        }
        const di = requestDIContext();
        if (!di) {
            return;
        }

        const itemNode = this.itemNodeFor(node);
        if (!itemNode) {
            vscode.window.showWarningMessage("Couldn't determine the owning item for this file.");
            return;
        }
        const {item} = itemNode;
        const relativePath = path.relative(itemNode.itemFolder, node.uri.fsPath);

        let connection = this._gitConnectionByWorkspaceId.get(item.workspaceId);
        if (connection === undefined) {
            try {
                connection = await di.fabricClient.getGitConnection(item.workspaceId);
                this._gitConnectionByWorkspaceId.set(item.workspaceId, connection);
            } catch (e) {
                await reportError(`Failed to read git connection for "${item.displayName}"'s workspace`, e);
                return;
            }
        }
        const gitProviderDetails = connection?.gitProviderDetails;
        if (!connection || connection.gitConnectionState === "NotConnected" || !gitProviderDetails) {
            vscode.window.showWarningMessage(`"${item.displayName}"'s workspace isn't connected to git.`);
            return;
        }

        const alreadyCloned = di.gitHelperService.isCloned(item.workspaceId);
        if (!alreadyCloned) {
            const choice = await vscode.window.showInformationMessage(
                `The git repository for "${item.displayName}"'s workspace hasn't been cloned locally yet. ` +
                "Clone it now to compare? This may prompt you to sign in.",
                "Clone & Compare",
            );
            if (choice !== "Clone & Compare") {
                return;
            }
        }

        // Always force-sync (never just `ensureRepoCloned`): a mirror that
        // already exists must be fetched + hard-reset to the remote tip so
        // the diff is never against stale content; a missing mirror is
        // cloned by this same call.
        const syncOk = await this.forceSyncGitMirror(item.workspaceId, item.displayName, gitProviderDetails);
        if (!syncOk) {
            return;
        }

        const mirrorRoot = di.gitHelperService.getRepoPath(item.workspaceId);
        const directoryName = gitProviderDetails.directoryName?.trim();
        const searchRoot = directoryName ? path.join(mirrorRoot, directoryName) : mirrorRoot;
        const itemFolderInGit = resolveItemGitFolder(searchRoot, item.displayName, item.itemType);

        // No matching item folder in git yet, or the item folder exists but
        // this particular file doesn't (e.g. added locally after the last
        // commit) — treat it as a brand-new file and diff against empty
        // content instead of failing outright, mirroring how the built-in
        // Source Control diff shows newly added files.
        let gitUri: vscode.Uri;
        let existsInGit = false;
        if (itemFolderInGit) {
            const gitFilePath = path.join(itemFolderInGit, relativePath);
            if (fs.existsSync(gitFilePath)) {
                gitUri = vscode.Uri.file(gitFilePath);
                existsInGit = true;
            } else {
                gitUri = emptyGitFileUri(node.uri);
            }
        } else {
            gitUri = emptyGitFileUri(node.uri);
        }

        const fileName = path.basename(node.uri.fsPath);
        const diffTitle = existsInGit ? `${fileName} (git ↔ local)` : `${fileName} (new file, git ↔ local)`;
        await vscode.commands.executeCommand("vscode.diff", gitUri, node.uri, diffTitle);
    }

    /**
     * Force-sync (fetch + hard-reset to the remote branch tip) the local git
     * mirror for `workspaceId`, showing a cancellable progress notification
     * titled with `displayName`. Clones the mirror first if it doesn't exist
     * yet — `gitHelperService.forceSyncRepo` handles both cases. Returns
     * `true` on success, `false` if the sync failed (an error is already
     * reported to the user via `reportError` in that case).
     *
     * Shared by {@link compareWithGit} (which needs the mirror up to date
     * before diffing) and {@link gitPullWorkspace} (the standalone "Git
     * Pull" command).
     */
    private async forceSyncGitMirror(
        workspaceId: string,
        displayName: string,
        gitProviderDetails: GitProviderDetails,
    ): Promise<boolean> {
        const di = requestDIContext();
        if (!di) {
            return false;
        }
        const alreadyCloned = di.gitHelperService.isCloned(workspaceId);
        const token = createCancellationToken();
        let syncOk = true;
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: alreadyCloned
                    ? `Fetching latest git content for "${displayName}"'s workspace…`
                    : `Cloning git repository for "${displayName}"'s workspace…`,
                cancellable: true,
            },
            async (_progress, vscodeToken) => {
                vscodeToken.onCancellationRequested(() => token.cancel());
                const startedAt = Date.now();
                try {
                    const result = await di.gitHelperService.forceSyncRepo(workspaceId, gitProviderDetails, token);
                    sdkLog.info(
                        `forceSyncRepo ok workspace=${workspaceId} branch=${result.branch} ` +
                            `commit=${result.commitSha} cloned=${!alreadyCloned} durationMs=${Date.now() - startedAt}`,
                        "extension/git-mirror",
                    );
                } catch (e) {
                    syncOk = false;
                    const msg = e instanceof Error ? e.message : String(e);
                    sdkLog.error(`forceSyncRepo failed for workspace ${workspaceId} durationMs=${Date.now() - startedAt}: ${msg}`, "extension/git-mirror");
                    await reportError(`Failed to sync git repository for "${displayName}"'s workspace`, e);
                }
            },
        );
        return syncOk;
    }

    /**
     * Force-pull the latest committed content into the local git mirror for
     * `node`'s workspace — i.e. fetch + hard-reset `.fabric-git/<workspaceId>/`
     * to the remote branch tip, discarding any local drift in the mirror.
     * This never touches the Fabric workspace itself; it only refreshes the
     * local clone that {@link compareWithGit} diffs against.
     *
     * Wired to the inline `fabricDataFactory.gitPullWorkspace` command,
     * shown only on `WorkspaceNode`s whose `contextValue` is
     * `"workspace.git"` (see `WorkspaceNode.gitConnected`) — i.e. only for
     * workspaces already known to be git-connected, so this never needs to
     * warn about a missing connection the way {@link compareWithGit} does.
     */
    private async gitPullWorkspace(node: WorkspaceNode): Promise<void> {
        if (!this.ensureGitIntegrationEnabled()) {
            return;
        }
        const di = requestDIContext();
        if (!di) {
            return;
        }

        let connection = this._gitConnectionByWorkspaceId.get(node.workspaceId);
        if (connection === undefined) {
            try {
                connection = await di.fabricClient.getGitConnection(node.workspaceId);
                this._gitConnectionByWorkspaceId.set(node.workspaceId, connection);
            } catch (e) {
                await reportError(`Failed to read git connection for "${node.displayName}"'s workspace`, e);
                return;
            }
        }
        const gitProviderDetails = connection?.gitProviderDetails;
        if (!connection || connection.gitConnectionState === "NotConnected" || !gitProviderDetails) {
            vscode.window.showWarningMessage(`"${node.displayName}"'s workspace isn't connected to git.`);
            return;
        }

        const syncOk = await this.forceSyncGitMirror(node.workspaceId, node.displayName, gitProviderDetails);
        if (syncOk) {
            vscode.window.showInformationMessage(`Pulled latest git content for "${node.displayName}"'s workspace.`);
        }
    }

    /**
     * Prompt the user for an item type + display name, then provision a
     * brand-new item in the given workspace via
     * `syncService.createItemAndPull`.
     *
     * Wired to the `fabricDataFactory.createItem` command from the
     * workspace-node context menu (see `viewItem == workspace` in
     * `package.json`). The combined create-and-pull call ensures the
     * new item lands in `.fabric/<workspaceId>/<itemId>.json` and the
     * local `.workspaces/...` folder atomically, so the tree refresh
     * picks it up without an extra round-trip.
     *
     * Lakehouses are created with `{ enableSchemas: true }` so the
     * user gets schema support out of the box (matches the default we
     * use in tests). All other types pass no `creationPayload`.
     */
    private async createItem(workspaceId: string): Promise<void> {
        const di = requestDIContext();
        if (!di) {
            return;
        }

        // Keep this list narrower than FabricItemType: discoverable item types
        // such as SQLDatabase are not necessarily supported by createItemAndPull.
        type CreateableItemType = Parameters<typeof di.syncService.createItemAndPull>[2];
        const typePicks = [
            {type: FabricItemType.DataPipeline, label: "Pipeline"},
            {type: FabricItemType.CopyJob, label: "Copy Job"},
            {type: FabricItemType.Dataflow, label: "Dataflow Gen2"},
            {type: FabricItemType.DataBuildToolJob, label: "dbt Job"},
            {type: FabricItemType.ApacheAirflowJob, label: "Airflow Job"},
            {type: FabricItemType.Lakehouse, label: "Lakehouse"},
            {type: FabricItemType.Warehouse, label: "Warehouse"},
        ] satisfies Array<{type: CreateableItemType; label: string}>;

        const typePick = await vscode.window.showQuickPick(typePicks, {
            placeHolder: "Select the item type to create",
            canPickMany: false,
            matchOnDescription: true,
        });
        if (!typePick) {
            return;
        }

        const rawName = await vscode.window.showInputBox({
            prompt: `Display name for the new ${typePick.label}`,
            placeHolder: `My${typePick.label.replace(/\s+/g, "")}`,
            validateInput: (value) => {
                if (!value.trim()) {
                    return "Display name is required.";
                }
                return undefined;
            },
        });
        if (!rawName) {
            return;
        }
        const displayName = rawName.trim();

        // Only Lakehouses need a creationPayload; all other types
        // accept the API default and we pass `undefined` to keep the
        // request body minimal.
        const creationPayload =
            typePick.type === FabricItemType.Lakehouse
                ? {enableSchemas: true}
                : undefined;

        const token = createCancellationToken();

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Creating ${typePick.label} "${displayName}"\u2026`,
                cancellable: true,
            },
            async (_progress, vscodeToken) => {
                vscodeToken.onCancellationRequested(() => {
                    token.cancel();
                    log(`Create cancelled by user for "${displayName}".`);
                });

                try {
                    const result = await di.syncService.createItemAndPull(
                        workspaceId,
                        displayName,
                        typePick.type,
                        creationPayload,
                        undefined,
                        token,
                    );
                    log(
                        `Created ${typePick.label} "${result.item.displayName}" (${result.item.id}); ` +
                        `pulled ${result.pullResult.filesWritten} file(s).`,
                    );
                    vscode.window.showInformationMessage(
                        `Created ${typePick.label} "${result.item.displayName}".`,
                    );
                    // A newly created item shows up as an "Added" git change,
                    // so refresh the cached git state alongside the sync-state
                    // refresh below.
                    await this.refreshGitInfoForWorkspaces([workspaceId]);
                    // The newly seeded `.fabric/...` state will surface
                    // on the next `readLocalItemStatesMap()` read.
                    this.refresh();
                } catch (e) {
                    // `reportError` demotes the addon's `Cancelled`
                    // diagnostic to a log entry (no toast), so cancelling
                    // the progress just silently aborts the create.
                    await reportError(
                        `Failed to create ${typePick.label} "${displayName}"`,
                        e,
                    );
                }
            },
        );
    }

    /**
     * Hard-delete an item from Fabric, then remove its local copy.
     *
     * The inverse of {@link createItem} / `createItemAndPull`: it calls
     * `syncService.deleteRemoteAndLocalItem`, which permanently deletes the
     * remote item (`hardDelete=true`, requires workspace Admin) and only
     * removes the local `.workspaces/...` folder + `.fabric/...` index entry
     * once the remote delete succeeds. Wired to the trash-icon
     * `fabricDataFactory.deleteItem` command on item nodes.
     *
     * A modal confirmation guards the operation since a hard delete is
     * irreversible.
     */
    private async deleteRemoteAndLocalItem(item: FabricItem): Promise<void> {
        const di = requestDIContext();
        if (!di) {
            return;
        }

        const choice = await vscode.window.showWarningMessage(
            `Permanently delete "${item.displayName}" from Fabric?\n\n` +
            "This hard-deletes the item on the service (requires workspace " +
            "Admin) and removes the local copy. It cannot be undone.",
            {modal: true},
            "Delete",
        );
        if (choice !== "Delete") {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Deleting "${item.displayName}"\u2026`,
            },
            async () => {
                try {
                    await di.syncService.deleteRemoteAndLocalItem(
                        item.workspaceId,
                        item.id,
                    );
                    log(
                        `Deleted "${item.displayName}" (${item.id}) from Fabric and locally.`,
                    );
                    vscode.window.showInformationMessage(
                        `Deleted "${item.displayName}".`,
                    );
                    // A deleted item shows up as a "Deleted" git change (or
                    // simply drops out of the diff if it was never committed),
                    // so refresh the cached git state alongside the sync-state
                    // refresh below.
                    await this.refreshGitInfoForWorkspaces([item.workspaceId]);
                    // The removed `.fabric/...` state surfaces on the next
                    // `readLocalItemStatesMap()` read.
                    this.refresh();
                } catch (e) {
                    await reportError(
                        `Failed to delete "${item.displayName}"`,
                        e,
                    );
                }
            },
        );
    }

    /**
     * Mark an Airflow item as the active one in `fabric-di.yaml` via
     * `configClient.setAirflowActive`, writing its `workspaceId` + `itemId`
     * into the root config's `airflow` section, then open the config file and
     * flash-highlight the lines we just wrote so the change is visible.
     *
     * Wired to the airflow-only `fabricDataFactory.setAirflowActive` context
     * menu command. Unlike `airflow.runItem` (which sets active *and* starts
     * the local server), this only records the selection — useful for picking
     * the target item without launching it.
     */
    private async setAirflowActive(item: FabricItem): Promise<void> {
        const di = tryGetDIContext();
        if (!di) {
            return;
        }
        try {
            di.configClient.setAirflowActive(item.workspaceId, item.id);
            log(`Set active Airflow item to "${item.displayName}" (${item.id}).`);
            // Reveal the change in-place rather than a status-bar toast: the two
            // lines we just wrote carry the workspaceId + itemId GUIDs, so we
            // highlight every line containing them.
            await this.revealConfigLines(di.configClient.configPath, [
                item.workspaceId,
                item.id,
            ]);
        } catch (e) {
            void reportError(
                `Failed to set active Airflow item "${item.displayName}"`,
                e,
            );
        }
    }

    /**
     * Seed a default per-item dbt config for the given item in `fabric-di.yaml`
     * via `configClient.setDefaultDbtItemConfig`, then open the config and
     * flash-highlight the entry so the user can tweak `env_path`.
     *
     * Wired to the dbt-only `fabricDataFactory.setDefaultDbtItemConfig` context
     * menu command. The addon seeds a `.dbt-envs/<itemId>` default (secrets
     * kept outside the pushed `Code/dbt/` tree) and is idempotent — an item
     * that already has an entry is left untouched.
     */
    private async setDefaultDbtItemConfig(item: FabricItem): Promise<void> {
        const di = tryGetDIContext();
        if (!di) {
            return;
        }
        try {
            di.configClient.setDefaultDbtItemConfig(item.workspaceId, item.id);
            log(`Seeded default dbt config for "${item.displayName}" (${item.id}).`);
            await this.revealConfigLines(di.configClient.configPath, [
                item.workspaceId,
                item.id,
            ]);
        } catch (e) {
            void reportError(
                `Failed to set default dbt config for "${item.displayName}"`,
                e,
            );
        }
    }

    /**
     * Open `configPath` and briefly highlight every line that contains one of
     * `needles` (e.g. the GUIDs just written), selecting and revealing the
     * first match. The whole-line highlight is a transient decoration that
     * disposes itself after a short delay, so it reads as a "flash" rather
     * than a permanent marker.
     */
    private async revealConfigLines(configPath: string, needles: string[]): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(configPath);
        const editor = await vscode.window.showTextDocument(doc, {preview: false});

        const ranges: vscode.Range[] = [];
        for (let i = 0; i < doc.lineCount; i++) {
            const text = doc.lineAt(i).text;
            if (needles.some((n) => text.includes(n))) {
                ranges.push(doc.lineAt(i).range);
            }
        }
        if (ranges.length === 0) {
            return;
        }

        editor.selection = new vscode.Selection(ranges[0].start, ranges[0].start);
        editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenter);

        const highlight = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor(
                "editor.findMatchHighlightBackground",
            ),
        });
        editor.setDecorations(highlight, ranges);
        // Clear the flash after a couple of seconds.
        setTimeout(() => highlight.dispose(), 2500);
    }

    private async openItem(item: FabricItem, preferNotebook?: boolean): Promise<void> {
        const itemFolder = path.join(
            getBaseFolder(this.context),
            ".workspaces",
            item.workspaceId,
            item.id,
        );

        const notebookFolder = path.join(
            getBaseFolder(this.context),
            ".fabricnb",
            item.workspaceId,
            item.id,
        );

        // For Lakehouses, open (or create) a query notebook with the item context pre-injected.
        if (item.itemType === FabricItemType.Lakehouse) {
            await openLakehouseNotebook(item, notebookFolder);
            return;
        } else if (item.itemType === FabricItemType.Warehouse) {
            await openWarehouseNotebook(item, notebookFolder);
            return;
        } else if (item.itemType === FabricItemType.DataBuildToolJob && preferNotebook) {
            await openDbtNotebook(item, notebookFolder);
            return;
        } else if (item.itemType === FabricItemType.ApacheAirflowJob && preferNotebook) {
            await openAirflowNotebook(item, notebookFolder);
            return;
        } else if (item.itemType === FabricItemType.DataPipeline && preferNotebook) {
            await openPipelineNotebook(item, notebookFolder);
            return;
        } else if (item.itemType === FabricItemType.CopyJob && preferNotebook) {
            await openCopyJobNotebook(item, notebookFolder);
            return;
        } else if (item.itemType === FabricItemType.Dataflow && preferNotebook) {
            await openDataflowNotebook(item, notebookFolder);
            return;
        }

        // Find the primary file to open from the local folder
        const primaryFile = this.findPrimaryFile(itemFolder, item.itemType);
        if (!primaryFile) {
            vscode.window.showWarningMessage(
                `No local files found for "${item.displayName}". Try Sync All first.`,
            );
            return;
        }

        try {
            const doc = await vscode.workspace.openTextDocument(primaryFile);
            await vscode.window.showTextDocument(doc);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to open item: ${msg}`);
        }
    }

    /**
     * Find the best file to open from a locally-synced item folder.
     * Mirrors the Rust `find_primary_project_file` logic.
     */
    private findPrimaryFile(
        itemFolder: string,
        itemType: FabricItemType,
    ): string | undefined {
        if (!fs.existsSync(itemFolder)) {
            return undefined;
        }

        // For definition-based items (except Airflow), prefer *-content.json
        const topFiles = this.listFilesFlat(itemFolder);
        const contentJson = topFiles.find((f) => f.endsWith("-content.json"));
        if (contentJson && itemType !== FabricItemType.ApacheAirflowJob) {
            return contentJson;
        }

        // For multi-file items, look in the files/ subfolder
        const filesDir = path.join(itemFolder, "files");
        const projectFiles = fs.existsSync(filesDir)
            ? this.listFilesRecursive(filesDir)
            : [];

        switch (itemType) {
            case FabricItemType.Dataflow:
                // Prefer mashup.pq, then any *.pq
                return (
                    topFiles.find((f) => path.basename(f) === "mashup.pq") ??
                    topFiles.find((f) => f.endsWith(".pq")) ??
                    topFiles[0]
                );

            case FabricItemType.DataBuildToolJob:
                // Prefer dbt_project.yml, then first .sql
                return (
                    projectFiles.find((f) => path.basename(f) === "dbt_project.yml") ??
                    projectFiles.find((f) => f.endsWith(".sql")) ??
                    projectFiles[0] ??
                    topFiles[0]
                );

            case FabricItemType.ApacheAirflowJob:
                // Prefer first .py in dags/, then any .py, then content.json
                return (
                    projectFiles.find(
                        (f) => f.includes(`${path.sep}dags${path.sep}`) && f.endsWith(".py"),
                    ) ??
                    projectFiles.find((f) => f.endsWith(".py")) ??
                    projectFiles[0] ??
                    contentJson ??
                    topFiles[0]
                );

            default:
                // Pipeline, CopyJob, etc. — first file in folder
                return projectFiles[0] ?? topFiles[0];
        }
    }

    /** List files (not directories) directly in a folder. */
    private listFilesFlat(dir: string): string[] {
        try {
            return fs
                .readdirSync(dir, {withFileTypes: true})
                .filter((e) => e.isFile())
                .map((e) => path.join(dir, e.name));
        } catch {
            return [];
        }
    }

    /** Recursively list all files under a directory. */
    private listFilesRecursive(dir: string): string[] {
        const results: string[] = [];
        try {
            for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    results.push(...this.listFilesRecursive(full));
                } else {
                    results.push(full);
                }
            }
        } catch {
            // ignore
        }
        return results;
    }

    private updateHasWorkspace(): void {
        const di = tryGetDIContext();
        const hasConfig = this.getSelectedWorkspaceIds().length > 0;
        const hasItems =
            di !== undefined &&
            Object.keys(di.syncService.readLocalItemStatesMap()).length > 0;
        vscode.commands.executeCommand(
            "setContext",
            "fabricDataFactory.hasWorkspace",
            hasConfig || hasItems,
        );
    }

    /**
     * Map a `.workspaces/` filesystem path back to its owning item key
     * (`<workspaceId>/<itemId>`), or `undefined` if the path is outside the
     * `.workspaces/` root or doesn't reach an item folder (e.g. the workspace
     * folder itself).
     */
    private itemKeyForPath(fsPath: string): string | undefined {
        const root = path.join(getBaseFolder(this.context), ".workspaces");
        const rel = path.relative(root, fsPath);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
            return undefined;
        }
        const parts = rel.split(path.sep).filter(Boolean);
        if (parts.length < 2) {
            // `<workspaceId>/` itself (or shallower) — can't target one item.
            return undefined;
        }
        return `${parts[0]}/${parts[1]}`;
    }

    /**
     * Queue a debounced, granular refresh for the item that owns `uri`. Bursts
     * (e.g. a multi-file pull) collapse into a single trailing flush.
     */
    private scheduleWorkspaceItemRefresh(uri: vscode.Uri): void {
        const key = this.itemKeyForPath(uri.fsPath);
        if (key) {
            this._pendingItemKeys.add(key);
        } else {
            this._workspacesFullRefreshPending = true;
        }
        if (this._workspacesRefreshTimer) {
            clearTimeout(this._workspacesRefreshTimer);
        }
        this._workspacesRefreshTimer = setTimeout(() => {
            this._workspacesRefreshTimer = undefined;
            this.flushWorkspaceItemRefresh();
        }, FABRIC_WATCH_DEBOUNCE_MS);
    }

    /**
     * Apply the queued `.workspaces/` refreshes: fire a targeted
     * `onDidChangeTreeData` for each affected, currently-rendered `ItemNode`
     * (updating its collapsible state in case the folder just became empty or
     * non-empty), and fall back to a single full refresh if any key can't be
     * resolved to a rendered node.
     */
    private flushWorkspaceItemRefresh(): void {
        const keys = [...this._pendingItemKeys];
        this._pendingItemKeys.clear();
        const fullPending = this._workspacesFullRefreshPending;
        this._workspacesFullRefreshPending = false;

        if (fullPending) {
            this.refresh();
            return;
        }

        let missed = false;
        for (const key of keys) {
            const node = this._renderedItemNodes.get(key);
            if (!node) {
                missed = true;
                continue;
            }
            // A create/delete may have flipped the folder between empty and
            // non-empty; keep the twistie in sync without collapsing a node the
            // user has already expanded.
            const hasChildren = dirHasEntries(node.itemFolder);
            if (!hasChildren) {
                node.collapsibleState = vscode.TreeItemCollapsibleState.None;
            } else if (node.collapsibleState === vscode.TreeItemCollapsibleState.None) {
                node.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            }
            this._onDidChangeTreeData.fire(node);
        }
        if (missed) {
            this.refresh();
        }
    }

    // ── Filesystem operations on FileNode folders ────────────
    //
    // All mutations go through `vscode.workspace.fs` (not Node `fs`) so they
    // work over remote/virtual filesystems too, and we lean on VS Code's
    // built-in resource commands (`copyFilePath`, `revealInExplorer`,
    // `revealFileInOS`, `openInIntegratedTerminal`) instead of re-implementing
    // them. We deliberately don't refresh the tree here: the `.workspaces/`
    // watcher already turns the resulting create/delete events into targeted
    // per-item refreshes.

    /**
     * Resolve the directory a create/paste should target: the folder itself
     * for a directory `FileNode`. Returns `undefined` for anything else — we
     * deliberately don't expose these operations on an item's root folder so
     * users can't freely restructure a synced item.
     */
    private targetDirFor(node?: TreeElement): vscode.Uri | undefined {
        if (node instanceof FileNode && node.isDirectory) {
            return node.uri;
        }
        return undefined;
    }

    /** Walk up a `FileNode`'s parents to the owning `ItemNode`. */
    private itemNodeFor(node: FileNode): ItemNode | undefined {
        let cur: ItemNode | FileNode = node;
        while (cur instanceof FileNode) {
            cur = cur.parent;
        }
        return cur instanceof ItemNode ? cur : undefined;
    }

    /** Walk up a `FileNode`'s parents to the owning item's root folder. */
    private itemFolderFor(node: FileNode): string | undefined {
        return this.itemNodeFor(node)?.itemFolder;
    }

    /** True if a resource already exists at `uri`. */
    private async pathExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Validate a new/renamed entry name: non-empty and free of path
     * separators. Collision checks are done asynchronously by the callers
     * (they need `vscode.workspace.fs.stat`).
     */
    private validateEntryName(value: string): string | undefined {
        const v = value.trim();
        if (!v) {
            return "A name is required.";
        }
        if (v === "." || v === ".." || /[\\/]/.test(v)) {
            return "The name can't contain path separators.";
        }
        return undefined;
    }

    /** Create a new empty file or folder inside the targeted directory. */
    private async fsNew(node: TreeElement | undefined, kind: "file" | "folder"): Promise<void> {
        const dir = this.targetDirFor(node);
        if (!dir) {
            return;
        }
        const name = await vscode.window.showInputBox({
            prompt: kind === "file" ? "New file name" : "New folder name",
            validateInput: async (v) => {
                const base = this.validateEntryName(v);
                if (base) {
                    return base;
                }
                return (await this.pathExists(vscode.Uri.joinPath(dir, v.trim())))
                    ? "An item with this name already exists."
                    : undefined;
            },
        });
        if (!name) {
            return;
        }
        const target = vscode.Uri.joinPath(dir, name.trim());
        try {
            if (kind === "file") {
                await vscode.workspace.fs.writeFile(target, new Uint8Array());
                await vscode.window.showTextDocument(target);
            } else {
                await vscode.workspace.fs.createDirectory(target);
            }
        } catch (e) {
            await reportError(`Failed to create ${kind} "${name.trim()}"`, e);
        }
    }

    /** Rename a file or folder in place. */
    private async fsRename(node: TreeElement | undefined): Promise<void> {
        if (!(node instanceof FileNode)) {
            return;
        }
        const dir = vscode.Uri.joinPath(node.uri, "..");
        const oldName = path.basename(node.uri.fsPath);
        const name = await vscode.window.showInputBox({
            prompt: "New name",
            value: oldName,
            validateInput: async (v) => {
                if (v.trim() === oldName) {
                    return undefined;
                }
                const base = this.validateEntryName(v);
                if (base) {
                    return base;
                }
                return (await this.pathExists(vscode.Uri.joinPath(dir, v.trim())))
                    ? "An item with this name already exists."
                    : undefined;
            },
        });
        if (!name || name.trim() === oldName) {
            return;
        }
        const target = vscode.Uri.joinPath(dir, name.trim());
        try {
            await vscode.workspace.fs.rename(node.uri, target, {overwrite: false});
        } catch (e) {
            await reportError(`Failed to rename "${oldName}"`, e);
        }
    }

    /** Permanently delete the selected file(s)/folder(s) after confirmation. */
    private async fsDelete(node?: TreeElement, selected?: TreeElement[]): Promise<void> {
        const targets = this.fileNodeTargets(node, selected);
        if (targets.length === 0) {
            return;
        }
        const label =
            targets.length === 1
                ? `"${path.basename(targets[0].uri.fsPath)}"`
                : `${targets.length} items`;
        const choice = await vscode.window.showWarningMessage(
            `Permanently delete ${label}? This cannot be undone.`,
            {modal: true},
            "Delete",
        );
        if (choice !== "Delete") {
            return;
        }
        for (const t of targets) {
            try {
                await vscode.workspace.fs.delete(t.uri, {
                    recursive: true,
                    useTrash: false,
                });
            } catch (e) {
                await reportError(
                    `Failed to delete "${path.basename(t.uri.fsPath)}"`,
                    e,
                );
            }
        }
    }

    /** Stage the selected file(s)/folder(s) for a later paste. */
    private fsCopy(node?: TreeElement, selected?: TreeElement[]): void {
        const targets = this.fileNodeTargets(node, selected);
        if (targets.length === 0) {
            return;
        }
        this._fsClipboard = targets.map((t) => t.uri);
        void vscode.commands.executeCommand(
            "setContext",
            "fabricDataFactory.fsClipboardFull",
            true,
        );
        vscode.window.setStatusBarMessage(
            `Copied ${targets.length} item(s) to the Fabric clipboard.`,
            3000,
        );
    }

    /** Paste the staged clipboard entries into the targeted folder. */
    private async fsPaste(node?: TreeElement): Promise<void> {
        const dir = this.targetDirFor(node);
        if (!dir || this._fsClipboard.length === 0) {
            return;
        }
        for (const src of this._fsClipboard) {
            const dest = await this.uniqueDestUri(dir, path.basename(src.fsPath));
            try {
                await vscode.workspace.fs.copy(src, dest, {overwrite: false});
            } catch (e) {
                await reportError(
                    `Failed to paste "${path.basename(src.fsPath)}"`,
                    e,
                );
            }
        }
    }

    /** Copy the node's absolute path via VS Code's built-in `copyFilePath`. */
    private async fsCopyPath(node?: TreeElement, selected?: TreeElement[]): Promise<void> {
        const targets = this.fileNodeTargets(node, selected);
        if (targets.length === 0) {
            return;
        }
        await vscode.commands.executeCommand(
            "copyFilePath",
            targets[0].uri,
            targets.map((t) => t.uri),
        );
    }

    /**
     * Copy the node's path relative to its owning item folder. Kept as our own
     * (rather than the built-in `copyRelativeFilePath`, which is relative to
     * the workspace root and breaks when `.workspaces/` lives outside it).
     */
    private async fsCopyRelativePath(node?: TreeElement): Promise<void> {
        if (!(node instanceof FileNode)) {
            return;
        }
        const itemFolder = this.itemFolderFor(node);
        const text = itemFolder
            ? path.relative(itemFolder, node.uri.fsPath)
            : path.basename(node.uri.fsPath);
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage("Copied relative path.", 3000);
    }

    /** Delegate to a built-in resource command for the given `FileNode`. */
    private runBuiltinOnNode(command: string, node?: TreeElement): void {
        if (node instanceof FileNode) {
            void vscode.commands.executeCommand(command, node.uri);
        }
    }

    /**
     * Narrow a command's `(node, selection)` args to the `FileNode`s they
     * refer to, preferring the multi-selection when present.
     */
    private fileNodeTargets(node?: TreeElement, selected?: TreeElement[]): FileNode[] {
        const source =
            selected && selected.length > 0 ? selected : node ? [node] : [];
        return source.filter((n): n is FileNode => n instanceof FileNode);
    }

    /**
     * Pick a non-colliding destination in `dir` for `name`, appending
     * " copy"/" copy N" before the extension when needed (mirrors the
     * Explorer's paste-into-same-folder behaviour).
     */
    private async uniqueDestUri(dir: vscode.Uri, name: string): Promise<vscode.Uri> {
        let candidate = vscode.Uri.joinPath(dir, name);
        if (!(await this.pathExists(candidate))) {
            return candidate;
        }
        const ext = path.extname(name);
        const base = path.basename(name, ext);
        let i = 1;
        do {
            candidate = vscode.Uri.joinPath(
                dir,
                `${base} copy${i > 1 ? ` ${i}` : ""}${ext}`,
            );
            i++;
        } while (await this.pathExists(candidate));
        return candidate;
    }

    private async expandAll(): Promise<void> {
        const roots = await this.getChildren();
        for (const root of roots) {
            await this._treeView.reveal(root, {expand: 3, select: false, focus: false});
        }
    }

    /**
     * The active editor's document URI, whether it's a plain text editor or
     * a notebook editor (`.fabricnb` files open in the custom notebook
     * editor, not a text editor). `undefined` if nothing is active.
     */
    private activeFileUri(): vscode.Uri | undefined {
        return vscode.window.activeTextEditor?.document.uri ?? vscode.window.activeNotebookEditor?.notebook.uri;
    }

    /**
     * Map a local file URI back to the `workspaceId` (and, where derivable,
     * `itemId`) it belongs to, based on which of the four Fabric-managed
     * root folders it lives under:
     *
     * - `.fabric/<workspaceId>/<itemId>.json` — the item's sync-state file;
     *   `itemId` comes straight from the filename.
     * - `.fabricnb/<workspaceId>/<itemId>/*.fabricnb` — notebook workspace;
     *   `itemId` is the folder name.
     * - `.workspaces/<workspaceId>/<itemId>/**` — the synced item folder;
     *   `itemId` is the folder name, and any further path segments become
     *   `relPath` — the file/folder's own path relative to the item's
     *   folder — so {@link findTreeElement} can walk down to the exact
     *   `FileNode`, not just the owning item.
     * - `.fabric-git/<workspaceId>/[directoryName/]<DisplayName>.<ItemType>/**`
     *   — the git mirror clone. There's no `itemId` in the path itself, so
     *   this scans the workspace's locally-synced items for one whose
     *   `<sanitized displayName>.<itemType>` folder name (see
     *   `sanitizeGitItemName`) matches any path segment after the
     *   workspace ID — that's the item's git folder, however deep the
     *   provider's `directoryName` nesting goes.
     *
     * Returns `undefined` if the URI isn't a local file under any of these
     * roots. `itemId` is omitted (workspace-level match only) when it can't
     * be derived — e.g. a `.fabric-git` path whose item folder isn't found
     * among the currently-synced items.
     */
    private locateFabricPath(uri: vscode.Uri): {workspaceId: string; itemId?: string; relPath?: string[]} | undefined {
        if (uri.scheme !== "file") {
            return undefined;
        }
        const rel = path.relative(getBaseFolder(this.context), uri.fsPath);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
            return undefined;
        }
        const parts = rel.split(path.sep).filter(Boolean);
        const [category, workspaceId, third] = parts;
        if (!workspaceId) {
            return undefined;
        }

        switch (category) {
            case ".fabric":
                return third?.endsWith(".json") ? {workspaceId, itemId: third.slice(0, -".json".length)} : {workspaceId};

            case ".fabricnb":
                return {workspaceId, itemId: third};

            case ".workspaces":
                return {workspaceId, itemId: third, relPath: parts.slice(3)};

            case ".fabric-git": {
                const di = tryGetDIContext();
                if (!di) {
                    return {workspaceId};
                }
                const byFolderName = new Map<string, string>();
                for (const state of Object.values(di.syncService.readLocalItemStatesMap())) {
                    if (state.workspaceId === workspaceId) {
                        byFolderName.set(`${sanitizeGitItemName(state.displayName)}.${state.itemType}`.toLowerCase(), state.itemId);
                    }
                }
                for (const segment of parts.slice(2)) {
                    const itemId = byFolderName.get(segment.toLowerCase());
                    if (itemId) {
                        return {workspaceId, itemId};
                    }
                }
                return {workspaceId};
            }

            default:
                return undefined;
        }
    }

    /**
     * Find the currently-rendered `WorkspaceNode` (and, if `itemId` is
     * given, the `ItemNode` beneath it) by walking the tree the same way
     * VS Code does — via `getChildren` — so the returned instances are
     * exactly what `TreeView.reveal` expects. Falls back to just the
     * `WorkspaceNode` if no matching item is found (e.g. it was removed
     * locally, or `itemId` wasn't derivable in the first place).
     *
     * When `relPath` is given (non-empty), keeps walking past the
     * `ItemNode` one path segment at a time — matching each segment
     * against a `FileNode`'s basename among that level's children — to
     * reach the exact file/folder node the segments describe. Stops and
     * returns the deepest match found so far if a segment can't be
     * resolved (e.g. the file was deleted or renamed since).
     */
    private async findTreeElement(workspaceId: string, itemId?: string, relPath?: string[]): Promise<TreeElement | undefined> {
        const roots = await this.getChildren();
        const workspaceNode = roots.find((n): n is WorkspaceNode => n instanceof WorkspaceNode && n.workspaceId === workspaceId);
        if (!workspaceNode || !itemId) {
            return workspaceNode;
        }
        const typeGroups = await this.getChildren(workspaceNode);
        let current: TreeElement | undefined;
        for (const group of typeGroups) {
            const items = await this.getChildren(group);
            const itemNode = items.find((n): n is ItemNode => n instanceof ItemNode && n.item.id === itemId);
            if (itemNode) {
                current = itemNode;
                break;
            }
        }
        if (!current) {
            return workspaceNode;
        }
        for (const segment of relPath ?? []) {
            const children = await this.getChildren(current);
            const match = children.find((n): n is FileNode => n instanceof FileNode && path.basename(n.uri.fsPath) === segment);
            if (!match) {
                break;
            }
            current = match;
        }
        return current;
    }

    /**
     * Locate and reveal, in the Workspaces view, the item (or workspace)
     * that owns the currently active file — VS Code's own "Reveal Active
     * File in Explorer View", but for the Fabric sync tree instead of the
     * native file Explorer.
     *
     * Wired to the `fabricDataFactory.revealActiveFile` view-title command.
     * Understands all four Fabric-managed roots (see
     * {@link locateFabricPath}); shows a transient status-bar message
     * instead of a toast (matching the rest of this file's low-friction
     * confirmations) when there's no active file, it isn't under a
     * Fabric-managed folder, or no matching workspace is currently synced.
     */
    private async revealActiveFile(): Promise<void> {
        const uri = this.activeFileUri();
        if (!uri) {
            vscode.window.setStatusBarMessage("No active file to locate.", 3000);
            return;
        }

        const located = this.locateFabricPath(uri);
        if (!located) {
            vscode.window.setStatusBarMessage("Active file isn't part of a synced Fabric workspace.", 3000);
            return;
        }

        const target = await this.findTreeElement(located.workspaceId, located.itemId, located.relPath);
        if (!target) {
            vscode.window.setStatusBarMessage("Couldn't find a matching workspace in the Workspaces view. Try pulling first.", 3000);
            return;
        }

        await this._treeView.reveal(target, {select: true, focus: true, expand: true});
    }
}
