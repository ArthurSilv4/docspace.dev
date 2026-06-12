import * as vscode from 'vscode';
import { FilterKey, WorkspaceTreeItem } from './treeItem.js';
import { getSortBy, SortBy } from './config.js';
import { hasMermaidBlock, isFileRelevant, isRelevantByName, needsContentCheck } from './fileFilter.js';
import { getCachedRelevance, setCachedRelevance } from './scanCache.js';

export async function safeReadDirectory(dirUri: vscode.Uri): Promise<[string, vscode.FileType][]> {
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

const byLabel = (a: WorkspaceTreeItem, b: WorkspaceTreeItem) =>
	a.label!.toString().localeCompare(b.label!.toString());

/** Sort files by the chosen key; modified/size need a stat per file. */
async function sortFiles(files: WorkspaceTreeItem[], sortBy: SortBy): Promise<WorkspaceTreeItem[]> {
	if (sortBy === 'name') { return files.sort(byLabel); }
	const metric = new Map<WorkspaceTreeItem, number>();
	await Promise.all(files.map(async (f) => {
		let value = 0;
		try {
			const st = await vscode.workspace.fs.stat(f.uri!);
			value = sortBy === 'size' ? st.size : st.mtime;
		} catch { /* unreadable — sorts last */ }
		metric.set(f, value);
	}));
	// largest/newest first, name as tiebreak
	return files.sort((a, b) => (metric.get(b)! - metric.get(a)!) || byLabel(a, b));
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

	return [...folders.sort(byLabel), ...await sortFiles(files, getSortBy())];
}

/** Count files passing the category filter across the whole subtree (for badges). */
export async function countRelevantFiles(
	dirUri: vscode.Uri,
	filterKey: FilterKey,
	exclude: string[]
): Promise<number> {
	const entries = await safeReadDirectory(dirUri);

	const fileResults = await Promise.all(
		entries
			.filter(([, type]) => type === vscode.FileType.File)
			.map(([name]) => isFileRelevant(name, vscode.Uri.joinPath(dirUri, name), filterKey))
	);
	let count = fileResults.filter(Boolean).length;

	for (const [name, type] of entries) {
		if (type === vscode.FileType.Directory && !exclude.includes(name)) {
			count += await countRelevantFiles(vscode.Uri.joinPath(dirUri, name), filterKey, exclude);
		}
	}
	return count;
}
