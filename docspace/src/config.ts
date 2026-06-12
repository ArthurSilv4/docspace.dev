import * as path from 'path';
import * as vscode from 'vscode';

export type CategoryKey = 'docs' | 'diagrams' | 'canvas';
export type CategoryMode = 'auto' | 'folder';

export interface CategoryConfig {
	mode: CategoryMode;
	folder: string;
}

/** Read-only folder with docs generated from the project graph. */
export const GENERATED_DIR = 'docGerada';

export function getExclude(): string[] {
	return vscode.workspace.getConfiguration('docspace')
		.get<string[]>('exclude', ['node_modules', '.git', 'out', 'dist']);
}

/** Each sidebar category (Docs/Diagrams/Canvas) has its own mode + folder. */
export function getCategoryConfig(key: CategoryKey): CategoryConfig {
	const cfg = vscode.workspace.getConfiguration('docspace');
	const mode = cfg.get<string>(`${key}Mode`, 'auto') === 'folder' ? 'folder' : 'auto';
	return { mode, folder: cfg.get<string>(`${key}Folder`, '').trim() };
}

export function workspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Settings go to the workspace when one is open, to the user profile otherwise. */
export function configTarget(): vscode.ConfigurationTarget {
	return workspaceRoot() ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

/**
 * Base URI a category reads from: its configured folder in `folder` mode
 * (absolute paths point anywhere on disk), the workspace root otherwise.
 */
export function resolveCategoryRoot(key: CategoryKey): vscode.Uri | undefined {
	const { mode, folder } = getCategoryConfig(key);
	if (mode !== 'folder' || !folder) { return workspaceRoot(); }
	if (path.isAbsolute(folder)) { return vscode.Uri.file(folder); }
	const root = workspaceRoot();
	return root ? vscode.Uri.joinPath(root, folder) : undefined;
}

export function generatedDirUri(): vscode.Uri | undefined {
	const root = workspaceRoot();
	return root ? vscode.Uri.joinPath(root, GENERATED_DIR) : undefined;
}
