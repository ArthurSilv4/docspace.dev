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
