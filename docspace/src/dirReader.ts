import * as vscode from 'vscode';
import { FilterKey, WorkspaceTreeItem } from './treeItem.js';
import { hasMermaidBlock, isFileRelevant, isRelevantByName, needsContentCheck } from './fileFilter.js';
import { getCachedRelevance, setCachedRelevance } from './scanCache.js';

async function safeReadDirectory(dirUri: vscode.Uri): Promise<[string, vscode.FileType][]> {
	try {
		return await vscode.workspace.fs.readDirectory(dirUri);
	} catch { /* directory unreadable or inaccessible */
		return [];
	}
}

async function computeRelevance(
	dirUri: vscode.Uri,
	filterKey: FilterKey,
	exclude: string[]
): Promise<boolean> {
	const entries = await safeReadDirectory(dirUri);
	const files = entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);

	// Cheapest first: filename matches need no file reads.
	if (files.some((name) => isRelevantByName(name, filterKey))) { return true; }

	// Content checks (mermaid blocks in .md) run in parallel and are cached.
	const contentChecks = files.filter((name) => needsContentCheck(name, filterKey));
	if (contentChecks.length > 0) {
		const results = await Promise.all(
			contentChecks.map((name) => hasMermaidBlock(vscode.Uri.joinPath(dirUri, name)))
		);
		if (results.some(Boolean)) { return true; }
	}

	// Recurse into subdirectories last, stopping at the first hit.
	for (const [name, type] of entries) {
		if (type === vscode.FileType.Directory && !exclude.includes(name)) {
			if (await hasRelevantContent(vscode.Uri.joinPath(dirUri, name), filterKey, exclude)) {
				return true;
			}
		}
	}
	return false;
}

export async function hasRelevantContent(
	dirUri: vscode.Uri,
	filterKey: FilterKey,
	exclude: string[]
): Promise<boolean> {
	const cached = getCachedRelevance(filterKey, dirUri);
	if (cached !== undefined) { return cached; }

	const result = await computeRelevance(dirUri, filterKey, exclude);
	setCachedRelevance(filterKey, dirUri, result);
	return result;
}

async function toTreeItem(
	dirUri: vscode.Uri,
	name: string,
	type: vscode.FileType,
	filterKey: FilterKey,
	exclude: string[]
): Promise<WorkspaceTreeItem | undefined> {
	const childUri = vscode.Uri.joinPath(dirUri, name);
	if (type === vscode.FileType.Directory) {
		if (!exclude.includes(name) && await hasRelevantContent(childUri, filterKey, exclude)) {
			return new WorkspaceTreeItem('folder', name, childUri, filterKey);
		}
	} else if (type === vscode.FileType.File) {
		if (await isFileRelevant(name, childUri, filterKey)) {
			return new WorkspaceTreeItem('file', name, childUri);
		}
	}
	return undefined;
}

export async function readDirChildren(
	dirUri: vscode.Uri,
	filterKey: FilterKey,
	exclude: string[]
): Promise<WorkspaceTreeItem[]> {
	const entries = await safeReadDirectory(dirUri);

	const items = await Promise.all(
		entries.map(([name, type]) => toTreeItem(dirUri, name, type, filterKey, exclude))
	);

	const folders = items.filter((i): i is WorkspaceTreeItem => i?.kind === 'folder');
	const files = items.filter((i): i is WorkspaceTreeItem => i?.kind === 'file');

	const byLabel = (a: WorkspaceTreeItem, b: WorkspaceTreeItem) =>
		a.label!.toString().localeCompare(b.label!.toString());

	return [...folders.sort(byLabel), ...files.sort(byLabel)];
}
