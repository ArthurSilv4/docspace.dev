import * as vscode from 'vscode';
import { FilterKey } from './treeItem.js';

export async function hasMermaidBlock(uri: vscode.Uri): Promise<boolean> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(bytes).toString('utf8').includes('```mermaid');
	} catch {
		return false;
	}
}

export async function isFileRelevant(
	name: string,
	uri: vscode.Uri,
	filterKey: FilterKey
): Promise<boolean> {
	if (filterKey === 'all') {
		return /\.(md|mmd|excalidraw)$/.test(name);
	}
	if (filterKey === 'docs') {
		return name.endsWith('.md');
	}
	if (filterKey === 'diagrams') {
		if (name.endsWith('.mmd')) { return true; }
		if (name.endsWith('.md')) { return hasMermaidBlock(uri); }
	}
	if (filterKey === 'canvas') {
		return name.endsWith('.excalidraw');
	}
	return false;
}
