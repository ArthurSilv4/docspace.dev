import * as vscode from 'vscode';
import { CategoryKey } from './config.js';

export type ItemKind = 'category' | 'folder' | 'file' | 'genFolder' | 'genFile';
/** Every tree node filters by its category's file type. */
export type FilterKey = CategoryKey;

function buildCommand(uri: vscode.Uri): vscode.Command {
	const isPreviewable = /\.(md|mmd)$/.test(uri.fsPath);
	const isCanvas = /\.excalidraw$/.test(uri.fsPath);
	if (isPreviewable) {
		return { command: 'docspace.openPreview', title: 'Open Preview', arguments: [uri] };
	}
	if (isCanvas) {
		return { command: 'vscode.openWith', title: 'Open in Canvas', arguments: [uri, 'docspace.canvasEditor'] };
	}
	return { command: 'vscode.open', title: 'Open', arguments: [uri] };
}

const CONTEXT_VALUES: Record<ItemKind, (filterKey?: FilterKey) => string> = {
	file: () => 'dsFile',
	folder: () => 'dsFolder',
	category: (filterKey) => `dsCat_${filterKey ?? 'docs'}`,
	// Generated docs are read-only: distinct contextValues keep the
	// rename/delete/new menus (bound to dsFile/dsFolder/dsCat_*) away.
	genFolder: () => 'dsGenFolder',
	genFile: () => 'dsGenFile',
};

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
			kind === 'file' || kind === 'genFile'
				? vscode.TreeItemCollapsibleState.None
				: vscode.TreeItemCollapsibleState.Collapsed
		);
		if (uri) {
			this.resourceUri = uri;
		}
		if (icon) {
			this.iconPath = new vscode.ThemeIcon(icon);
		}
		this.contextValue = CONTEXT_VALUES[kind](filterKey);
		if ((kind === 'file' || kind === 'genFile') && uri) {
			this.command = buildCommand(uri);
			this.tooltip = kind === 'genFile' ? `${uri.fsPath} (gerado — somente leitura)` : uri.fsPath;
		}
	}
}
