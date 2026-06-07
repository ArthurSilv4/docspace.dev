import * as vscode from 'vscode';
import { WorkspaceTreeItem, FilterKey } from './treeItem.js';
import { workspaceRoot } from './config.js';

const FOLDER_FILTER: Record<string, FilterKey> = {
	docs: 'docs', diagrams: 'diagrams', canvas: 'canvas',
};

export async function scaffoldFolderStructure(rootFolder: string): Promise<void> {
	const root = workspaceRoot();
	if (!root) { return; }

	const subfolders = ['docs', 'diagrams', 'canvas'];
	for (const sub of subfolders) {
		const uri = vscode.Uri.joinPath(root, rootFolder, sub);
		try {
			await vscode.workspace.fs.stat(uri);
		} catch {
			await vscode.workspace.fs.createDirectory(uri);
		}
	}

	vscode.window.showInformationMessage(`Docspace: estrutura criada em ${rootFolder}/`);
}

export async function folderModeCategories(rootFolder: string): Promise<WorkspaceTreeItem[]> {
	const root = workspaceRoot();
	if (!root) { return []; }

	const baseUri = vscode.Uri.joinPath(root, rootFolder);
	try {
		const entries = await vscode.workspace.fs.readDirectory(baseUri);
		const dirs = entries
			.filter(([, type]) => type === vscode.FileType.Directory)
			.map(([name]) => name)
			.sort();

		if (dirs.length > 0) {
			return dirs.map((name) =>
				new WorkspaceTreeItem('category', name, vscode.Uri.joinPath(baseUri, name), FOLDER_FILTER[name.toLowerCase()] ?? 'all')
			);
		}
		return [new WorkspaceTreeItem('category', 'Docs', baseUri, 'all')];
	} catch {
		return [new WorkspaceTreeItem('category', 'Docs', baseUri, 'all')];
	}
}
