import * as vscode from 'vscode';
import { WorkspaceTreeItem, FilterKey } from './treeItem.js';
import { resolveRootUri } from './config.js';
import { hasRelevantContent, safeReadDirectory } from './dirReader.js';
import { isFileRelevant } from './fileFilter.js';

const FOLDER_FILTER: Record<string, FilterKey> = {
	docs: 'docs', diagrams: 'diagrams', canvas: 'canvas',
};

const CATEGORY_ICONS: Record<FilterKey, string> = {
	docs: 'book', diagrams: 'graph', canvas: 'layout', all: 'folder',
};

/** Scaffold names are always shown so the user can create files into them. */
const SCAFFOLD_FOLDERS = ['docs', 'diagrams', 'canvas'];

/**
 * Create the docs/diagrams/canvas scaffold — but only when the root folder
 * doesn't exist yet. An existing folder (e.g. one the user picked from disk)
 * is never modified.
 */
export async function scaffoldFolderStructure(): Promise<void> {
	const base = resolveRootUri();
	if (!base) { return; }

	try {
		await vscode.workspace.fs.stat(base);
		return; // folder already exists — leave the user's content untouched
	} catch { /* missing — create the scaffold below */ }

	for (const sub of SCAFFOLD_FOLDERS) {
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(base, sub));
	}
	vscode.window.showInformationMessage(`Docspace: estrutura criada em ${base.fsPath}`);
}

async function categoryFor(
	baseUri: vscode.Uri,
	name: string,
	exclude: string[]
): Promise<WorkspaceTreeItem | undefined> {
	const filterKey = FOLDER_FILTER[name.toLowerCase()] ?? 'all';
	const uri = vscode.Uri.joinPath(baseUri, name);
	const alwaysVisible = SCAFFOLD_FOLDERS.includes(name.toLowerCase());
	if (alwaysVisible || await hasRelevantContent(uri, filterKey, exclude)) {
		return new WorkspaceTreeItem('category', name, uri, filterKey, CATEGORY_ICONS[filterKey]);
	}
	return undefined;
}

async function fileFor(baseUri: vscode.Uri, name: string): Promise<WorkspaceTreeItem | undefined> {
	const uri = vscode.Uri.joinPath(baseUri, name);
	return await isFileRelevant(name, uri, 'all')
		? new WorkspaceTreeItem('file', name, uri)
		: undefined;
}

/**
 * Root of the tree in folder mode: subfolders become categories (scaffold
 * folders always, others only when they have relevant content), and relevant
 * files sitting directly in the root folder are listed after them.
 */
export async function folderModeChildren(exclude: string[]): Promise<WorkspaceTreeItem[]> {
	const baseUri = resolveRootUri();
	if (!baseUri) { return []; }

	const entries = await safeReadDirectory(baseUri);

	const dirNames = entries
		.filter(([name, type]) => type === vscode.FileType.Directory && !exclude.includes(name))
		.map(([name]) => name)
		.sort();
	const fileNames = entries
		.filter(([, type]) => type === vscode.FileType.File)
		.map(([name]) => name)
		.sort();

	const categories = await Promise.all(dirNames.map((name) => categoryFor(baseUri, name, exclude)));
	const files = await Promise.all(fileNames.map((name) => fileFor(baseUri, name)));

	return [...categories, ...files].filter((i): i is WorkspaceTreeItem => i !== undefined);
}
