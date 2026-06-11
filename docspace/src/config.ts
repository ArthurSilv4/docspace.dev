import * as path from 'path';
import * as vscode from 'vscode';

export interface DocspaceConfig {
	mode: string;
	rootFolder: string;
	exclude: string[];
}

export function getConfig(): DocspaceConfig {
	const cfg = vscode.workspace.getConfiguration('docspace');
	return {
		mode: cfg.get<string>('mode', 'auto'),
		rootFolder: cfg.get<string>('rootFolder', '.docspace').trim(),
		exclude: cfg.get<string[]>('exclude', ['node_modules', '.git', 'out', 'dist']),
	};
}

export function workspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * Resolve `docspace.rootFolder` to a URI. Absolute paths point anywhere on
 * disk (no workspace needed); relative paths resolve against the workspace.
 */
export function resolveRootUri(): vscode.Uri | undefined {
	const { rootFolder } = getConfig();
	if (path.isAbsolute(rootFolder)) {
		return vscode.Uri.file(rootFolder);
	}
	const root = workspaceRoot();
	return root ? vscode.Uri.joinPath(root, rootFolder) : undefined;
}
