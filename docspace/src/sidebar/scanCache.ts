import * as path from 'path';
import * as vscode from 'vscode';
import { FilterKey } from './treeItem.js';
import { invalidateGraphFile } from '../graph/projectGraph.js';

// Discovery results are cached so tree refreshes don't rescan the workspace.
// Entries are invalidated per-path by the file watcher (see extension.ts).

const relevanceCache = new Map<string, boolean>(); // `${filterKey}:${dir.fsPath}`
const mermaidCache = new Map<string, boolean>();   // file fsPath

function relevanceKey(filterKey: FilterKey, dirUri: vscode.Uri): string {
	return `${filterKey}:${dirUri.fsPath}`;
}

export function getCachedRelevance(filterKey: FilterKey, dirUri: vscode.Uri): boolean | undefined {
	return relevanceCache.get(relevanceKey(filterKey, dirUri));
}

export function setCachedRelevance(filterKey: FilterKey, dirUri: vscode.Uri, value: boolean): void {
	relevanceCache.set(relevanceKey(filterKey, dirUri), value);
}

export function getCachedMermaid(uri: vscode.Uri): boolean | undefined {
	return mermaidCache.get(uri.fsPath);
}

export function setCachedMermaid(uri: vscode.Uri, value: boolean): void {
	mermaidCache.set(uri.fsPath, value);
}

/**
 * Drop cached results affected by a change at `uri` (file or folder):
 * the path itself, everything under it, and every ancestor directory
 * whose relevance may have changed.
 */
export function invalidatePath(uri: vscode.Uri): void {
	const changed = uri.fsPath;
	const childPrefix = changed + path.sep;

	for (const key of [...relevanceCache.keys()]) {
		// filterKey never contains ':', so the first ':' splits key and path
		// (Windows drive letters keep their ':' intact in the remainder).
		const dir = key.slice(key.indexOf(':') + 1);
		const isAncestor = changed === dir || changed.startsWith(dir + path.sep);
		const isDescendant = dir.startsWith(childPrefix);
		if (isAncestor || isDescendant) {
			relevanceCache.delete(key);
		}
	}

	for (const file of [...mermaidCache.keys()]) {
		if (file === changed || file.startsWith(childPrefix)) {
			mermaidCache.delete(file);
		}
	}

	invalidateGraphFile(uri);
}

export function clearCaches(): void {
	relevanceCache.clear();
	mermaidCache.clear();
}
