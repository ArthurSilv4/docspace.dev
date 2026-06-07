import * as vscode from 'vscode';
import { WorkspaceTreeItem } from './treeItem.js';
import { getConfig, workspaceRoot } from './config.js';
import { readDirChildren } from './dirReader.js';
import { folderModeCategories } from './folderMode.js';

export class DocspaceProvider implements vscode.TreeDataProvider<WorkspaceTreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh(): void { this._onDidChangeTreeData.fire(); }

	getTreeItem(element: WorkspaceTreeItem): WorkspaceTreeItem { return element; }

	async getChildren(element?: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
		const { mode, rootFolder, exclude } = getConfig();

		if (!element) {
			return mode === 'folder'
				? folderModeCategories(rootFolder)
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
