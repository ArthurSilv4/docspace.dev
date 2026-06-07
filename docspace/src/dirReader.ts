import * as vscode from 'vscode';
import { FilterKey, WorkspaceTreeItem } from './treeItem.js';
import { isFileRelevant } from './fileFilter.js';

export async function hasRelevantContent(
	dirUri: vscode.Uri,
	filterKey: FilterKey,
	exclude: string[]
): Promise<boolean> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dirUri);
	} catch { /* directory unreadable or inaccessible */
		return false;
	}
	for (const [name, type] of entries) {
		const childUri = vscode.Uri.joinPath(dirUri, name);
		if (type === vscode.FileType.File && await isFileRelevant(name, childUri, filterKey)) {
			return true;
		}
		if (type === vscode.FileType.Directory && !exclude.includes(name)) {
			if (await hasRelevantContent(childUri, filterKey, exclude)) { return true; }
		}
	}
	return false;
}

export async function readDirChildren(
	dirUri: vscode.Uri,
	filterKey: FilterKey,
	exclude: string[]
): Promise<WorkspaceTreeItem[]> {
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dirUri);
	} catch { /* directory unreadable or inaccessible */
		return [];
	}

	const folders: WorkspaceTreeItem[] = [];
	const files: WorkspaceTreeItem[] = [];

	for (const [name, type] of entries) {
		const childUri = vscode.Uri.joinPath(dirUri, name);
		if (type === vscode.FileType.Directory) {
			if (!exclude.includes(name) && await hasRelevantContent(childUri, filterKey, exclude)) {
				folders.push(new WorkspaceTreeItem('folder', name, childUri, filterKey));
			}
		} else if (type === vscode.FileType.File) {
			if (await isFileRelevant(name, childUri, filterKey)) {
				files.push(new WorkspaceTreeItem('file', name, childUri));
			}
		}
	}

	const byLabel = (a: WorkspaceTreeItem, b: WorkspaceTreeItem) =>
		a.label!.toString().localeCompare(b.label!.toString());

	return [...folders.sort(byLabel), ...files.sort(byLabel)];
}
