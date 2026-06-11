import * as vscode from 'vscode';
import { WorkspaceTreeItem } from './treeItem.js';
import { getConfig, workspaceRoot } from './config.js';
import { readDirChildren } from './dirReader.js';
import { folderModeChildren } from './folderMode.js';
import { clearCaches, invalidatePath } from './scanCache.js';

const REFRESH_DEBOUNCE_MS = 300;

export class DocspaceProvider implements vscode.TreeDataProvider<WorkspaceTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;

	/** Invalidate cached scan results for a single path, then refresh (debounced). */
	invalidate(uri: vscode.Uri): void {
		invalidatePath(uri);
		this.scheduleRefresh();
	}

	/** Drop all cached scan results, then refresh (debounced). */
	refreshAll(): void {
		clearCaches();
		this.scheduleRefresh();
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this._onDidChangeTreeData.fire();
		}, REFRESH_DEBOUNCE_MS);
	}

	dispose(): void {
		if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
		this._onDidChangeTreeData.dispose();
	}

	getTreeItem(element: WorkspaceTreeItem): WorkspaceTreeItem { return element; }

	async getChildren(element?: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
		const { mode, exclude } = getConfig();

		if (!element) {
			return mode === 'folder'
				? folderModeChildren(exclude)
				: [
					new WorkspaceTreeItem('category', 'Docs',     undefined, 'docs',     'book'),
					new WorkspaceTreeItem('category', 'Diagrams', undefined, 'diagrams', 'graph'),
					new WorkspaceTreeItem('category', 'Canvas',   undefined, 'canvas',   'layout'),
				];
		}

		if (element.kind === 'category' || element.kind === 'folder') {
			const filterKey = element.filterKey ?? 'all';
			const baseUri = element.uri ?? workspaceRoot();
			if (baseUri) {
				return readDirChildren(baseUri, filterKey, exclude);
			}
		}

		return [];
	}
}
