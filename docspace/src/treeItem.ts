import * as vscode from 'vscode';

export type ItemKind = 'category' | 'folder' | 'file';
export type FilterKey = 'docs' | 'diagrams' | 'canvas' | 'all';

function buildCommand(uri: vscode.Uri): vscode.Command {
	const isPreviewable = /\.(md|mmd)$/.test(uri.fsPath);
	const isCanvas = /\.excalidraw$/.test(uri.fsPath);
	if (isPreviewable) {
		return { command: 'docspace.openPreview', title: 'Visualizar', arguments: [uri] };
	}
	if (isCanvas) {
		return { command: 'vscode.openWith', title: 'Abrir no Canvas', arguments: [uri, 'docspace.canvasEditor'] };
	}
	return { command: 'vscode.open', title: 'Abrir', arguments: [uri] };
}

export class WorkspaceTreeItem extends vscode.TreeItem {
	constructor(
		readonly kind: ItemKind,
		label: string,
		readonly uri?: vscode.Uri,
		readonly filterKey?: FilterKey,
		icon?: string,
	) {
		super(
			label,
			kind === 'file'
				? vscode.TreeItemCollapsibleState.None
				: vscode.TreeItemCollapsibleState.Collapsed
		);
		if (uri) {
			this.resourceUri = uri;
		}
		if (icon) {
			this.iconPath = new vscode.ThemeIcon(icon);
		}
		if (kind === 'file') {
			this.contextValue = 'dsFile';
		} else if (kind === 'folder') {
			this.contextValue = 'dsFolder';
		} else if (kind === 'category') {
			this.contextValue = `dsCat_${filterKey ?? 'all'}`;
		}
		if (kind === 'file' && uri) {
			this.command = buildCommand(uri);
			this.tooltip = uri.fsPath;
		}
	}
}
