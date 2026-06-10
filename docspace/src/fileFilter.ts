import * as vscode from 'vscode';
import { FilterKey } from './treeItem.js';
import { getCachedMermaid, setCachedMermaid } from './scanCache.js';

export async function hasMermaidBlock(uri: vscode.Uri): Promise<boolean> {
	const cached = getCachedMermaid(uri);
	if (cached !== undefined) { return cached; }

	let result = false;
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		result = Buffer.from(bytes).toString('utf8').includes('```mermaid');
	} catch { /* unreadable file — treat as no mermaid */ }

	setCachedMermaid(uri, result);
	return result;
}

/** Cheap check based on the filename alone — never touches file contents. */
export function isRelevantByName(name: string, filterKey: FilterKey): boolean {
	switch (filterKey) {
		case 'all': return /\.(md|mmd|excalidraw)$/.test(name);
		case 'docs': return name.endsWith('.md');
		case 'diagrams': return name.endsWith('.mmd');
		case 'canvas': return name.endsWith('.excalidraw');
	}
}

/** True when relevance can only be decided by reading the file contents. */
export function needsContentCheck(name: string, filterKey: FilterKey): boolean {
	return filterKey === 'diagrams' && name.endsWith('.md');
}

export async function isFileRelevant(
	name: string,
	uri: vscode.Uri,
	filterKey: FilterKey
): Promise<boolean> {
	if (isRelevantByName(name, filterKey)) { return true; }
	if (needsContentCheck(name, filterKey)) { return hasMermaidBlock(uri); }
	return false;
}
