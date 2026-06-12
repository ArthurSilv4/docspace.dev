import * as vscode from 'vscode';
import { WorkspaceTreeItem } from './treeItem.js';
import { CategoryKey, GENERATED_DIR, generatedDirUri, getExclude, resolveCategoryRoot } from './config.js';
import { readDirChildren, safeReadDirectory } from './dirReader.js';
import { clearCaches, invalidatePath } from './scanCache.js';

const REFRESH_DEBOUNCE_MS = 300;

const CATEGORIES: Array<{ key: CategoryKey; label: string; icon: string }> = [
	{ key: 'docs',     label: 'Docs',     icon: 'book' },
	{ key: 'diagrams', label: 'Diagrams', icon: 'graph' },
	{ key: 'canvas',   label: 'Canvas',   icon: 'layout' },
];

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
		if (!element) {
			return CATEGORIES.map(({ key, label, icon }) =>
				new WorkspaceTreeItem('category', label, undefined, key, icon));
		}
		if (element.kind === 'category' && element.filterKey) {
			return this.categoryChildren(element.filterKey);
		}
		if (element.kind === 'folder' && element.uri && element.filterKey) {
			return readDirChildren(element.uri, element.filterKey, this.scanExclude());
		}
		if (element.kind === 'genFolder' && element.uri) {
			return generatedFiles(element.uri);
		}
		return [];
	}

	/** The generated folder is listed separately, never by the normal scan. */
	private scanExclude(): string[] {
		return [...getExclude(), GENERATED_DIR];
	}

	private async categoryChildren(key: CategoryKey): Promise<WorkspaceTreeItem[]> {
		const base = resolveCategoryRoot(key);
		if (!base) { return []; }

		const children = await readDirChildren(base, key, this.scanExclude());

		// Generated docs live under Docs, pinned on top with a distinct icon.
		if (key === 'docs') {
			const genNode = await generatedFolderNode();
			if (genNode) { children.unshift(genNode); }
		}
		return children;
	}
}

async function generatedFolderNode(): Promise<WorkspaceTreeItem | undefined> {
	const uri = generatedDirUri();
	if (!uri) { return undefined; }
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined; // not generated yet
	}
	return new WorkspaceTreeItem('genFolder', GENERATED_DIR, uri, 'docs', 'sparkle');
}

async function generatedFiles(dirUri: vscode.Uri): Promise<WorkspaceTreeItem[]> {
	const entries = await safeReadDirectory(dirUri);
	return entries
		.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
		.map(([name]) => name)
		.sort()
		.map((name) =>
			new WorkspaceTreeItem('genFile', name, vscode.Uri.joinPath(dirUri, name), 'docs', 'lock'));
}
