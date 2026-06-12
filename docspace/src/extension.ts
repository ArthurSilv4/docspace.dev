import * as vscode from 'vscode';
import * as path from 'path';
import { DocspaceProvider } from './sidebar/provider.js';
import { CategoryKey, configTarget, getCategoryConfig, resolveCategoryRoot, workspaceRoot } from './sidebar/config.js';
import { generateProjectDocs } from './graph/docGenerator.js';
import { PreviewPanel } from './editor/previewPanel.js';
import { GraphPanel } from './graph/graphPanel.js';
import { CanvasEditorProvider } from './editor/canvasEditor.js';
import { NotionManager } from './notion/notion.js';
import { WorkspaceTreeItem } from './sidebar/treeItem.js';

const RELEVANT_FILE = /\.(md|mmd|excalidraw)$/i;
const RELEVANT_GLOB = '**/*.{md,mmd,excalidraw}';
const CATEGORY_KEYS: CategoryKey[] = ['docs', 'diagrams', 'canvas'];
const CATEGORY_LABELS: Record<CategoryKey, string> = {
	docs: 'Docs', diagrams: 'Diagrams', canvas: 'Canvas',
};

/** Let the user pick the destination folder when no tree folder gave context. */
async function pickTargetFolder(): Promise<vscode.Uri | undefined> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Salvar aqui',
		title: 'Docspace — onde salvar o arquivo?',
		defaultUri: workspaceRoot(),
	});
	return picked?.[0];
}

/** Category in folder mode creates files in its folder; otherwise ask. */
async function targetFolderFor(item: WorkspaceTreeItem | undefined): Promise<vscode.Uri | undefined> {
	if (item?.uri) { return item.uri; }
	if (item?.kind === 'category' && item.filterKey && getCategoryConfig(item.filterKey).mode === 'folder') {
		return resolveCategoryRoot(item.filterKey);
	}
	return pickTargetFolder();
}

async function createFile(
	item: WorkspaceTreeItem | undefined,
	ext: string,
	buildContent: (name: string) => string,
	prompt: string,
	onCreated: (uri: vscode.Uri) => void,
): Promise<void> {
	const baseUri = await targetFolderFor(item);
	if (!baseUri) { return; }

	const input = await vscode.window.showInputBox({
		prompt,
		value: `untitled.${ext}`,
		validateInput: (v) => v.trim() ? null : 'Name cannot be empty',
	});
	if (!input) { return; }

	const filename = input.endsWith(`.${ext}`) ? input : `${input}.${ext}`;
	const fileUri = vscode.Uri.joinPath(baseUri, filename);
	await vscode.workspace.fs.writeFile(fileUri, Buffer.from(buildContent(filename), 'utf8'));
	onCreated(fileUri);
	if (ext === 'excalidraw') {
		await vscode.commands.executeCommand('vscode.openWith', fileUri, 'docspace.canvasEditor');
	} else {
		await vscode.commands.executeCommand('vscode.open', fileUri);
	}
}

/**
 * Invalidate the tree for workspace file operations (delete/rename) that the
 * scoped watcher may miss — e.g. folders, whose children events are provider
 * dependent. Irrelevant single files (with an extension) are ignored.
 */
function invalidateIfRelevant(provider: DocspaceProvider, uris: readonly vscode.Uri[]): void {
	for (const uri of uris) {
		if (RELEVANT_FILE.test(uri.fsPath) || !path.extname(uri.fsPath)) {
			provider.invalidate(uri);
		}
	}
}

/**
 * Watches category folders that live outside the workspace (absolute
 * `docspace.<key>Folder`) — the workspace-scoped watcher can't see them.
 * Re-synced whenever category configs change.
 */
class ExternalRootsWatcher implements vscode.Disposable {
	private current: vscode.Disposable[] = [];

	constructor(private readonly provider: DocspaceProvider) {}

	sync(): void {
		this.dispose();
		const seen = new Set<string>();
		for (const key of CATEGORY_KEYS) {
			if (getCategoryConfig(key).mode !== 'folder') { continue; }
			const root = resolveCategoryRoot(key);
			if (!root || vscode.workspace.getWorkspaceFolder(root) || seen.has(root.fsPath)) { continue; }
			seen.add(root.fsPath);
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(root, RELEVANT_GLOB)
			);
			this.current.push(
				watcher,
				watcher.onDidCreate((uri) => this.provider.invalidate(uri)),
				watcher.onDidChange((uri) => this.provider.invalidate(uri)),
				watcher.onDidDelete((uri) => this.provider.invalidate(uri)),
			);
		}
	}

	dispose(): void {
		for (const d of this.current) { d.dispose(); }
		this.current = [];
	}
}

function affectsCategoryConfig(e: vscode.ConfigurationChangeEvent): boolean {
	return CATEGORY_KEYS.some((key) =>
		e.affectsConfiguration(`docspace.${key}Mode`) || e.affectsConfiguration(`docspace.${key}Folder`)
	) || e.affectsConfiguration('docspace.exclude') || e.affectsConfiguration('docspace.sortBy');
}

function registerTreeEvents(
	context: vscode.ExtensionContext,
	provider: DocspaceProvider,
	externalWatcher: ExternalRootsWatcher,
): void {
	const watcher = vscode.workspace.createFileSystemWatcher(RELEVANT_GLOB);
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate((uri) => provider.invalidate(uri)),
		watcher.onDidChange((uri) => provider.invalidate(uri)),
		watcher.onDidDelete((uri) => provider.invalidate(uri)),
		vscode.workspace.onDidDeleteFiles((e) => invalidateIfRelevant(provider, e.files)),
		vscode.workspace.onDidRenameFiles((e) => {
			invalidateIfRelevant(provider, e.files.map((f) => f.oldUri));
			invalidateIfRelevant(provider, e.files.map((f) => f.newUri));
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (affectsCategoryConfig(e)) {
				externalWatcher.sync();
				provider.refreshAll();
			}
		}),
	);
}

function registerCommands(context: vscode.ExtensionContext, provider: DocspaceProvider): void {
	const onCreated = (uri: vscode.Uri) => provider.invalidate(uri);

	context.subscriptions.push(
		vscode.commands.registerCommand('docspace.openPreview', (uri: vscode.Uri) => {
			PreviewPanel.createOrShow(context, uri);
		}),
		vscode.commands.registerCommand('docspace.openProjectGraph', () => {
			GraphPanel.createOrShow(context);
		}),
		vscode.commands.registerCommand('docspace.selectDiagramTheme', selectDiagramTheme),
		vscode.commands.registerCommand('docspace.selectSort', selectSort),
		vscode.commands.registerCommand('docspace.configureCategory', (item?: WorkspaceTreeItem) =>
			configureCategory(item)
		),
		vscode.commands.registerCommand('docspace.regenerateDoc', () => regenerateDoc(context, provider)),
		vscode.commands.registerCommand('docspace.newMarkdown', (item?: WorkspaceTreeItem) =>
			createFile(item, 'md', (n) => `# ${n.replace(/\.md$/, '')}\n`, 'Markdown filename', onCreated)
		),
		vscode.commands.registerCommand('docspace.newMermaid', (item?: WorkspaceTreeItem) =>
			createFile(item, 'mmd', () => 'graph TD\n    A --> B\n', 'Mermaid filename', onCreated)
		),
		vscode.commands.registerCommand('docspace.newExcalidraw', (item?: WorkspaceTreeItem) =>
			createFile(item, 'excalidraw', () => JSON.stringify({
				type: 'excalidraw', version: 2, source: 'docspace', elements: [],
				appState: { gridSize: 20 }, files: {},
			}, null, 2), 'Canvas filename', onCreated)
		),
		vscode.commands.registerCommand('docspace.deleteFile', async (item?: WorkspaceTreeItem) => {
			if (!item?.uri || item.kind === 'genFile' || item.kind === 'genFolder') { return; }
			const name = path.basename(item.uri.fsPath);
			const confirm = await vscode.window.showWarningMessage(
				`Delete ${name}?`, { modal: true }, 'Delete'
			);
			if (confirm === 'Delete') {
				await vscode.workspace.fs.delete(item.uri, { recursive: true, useTrash: true });
				provider.invalidate(item.uri);
			}
		}),
		vscode.commands.registerCommand('docspace.renameFile', async (item?: WorkspaceTreeItem) => {
			if (!item?.uri || item.kind === 'genFile' || item.kind === 'genFolder') { return; }
			const oldUri = item.uri;
			const oldName = path.basename(oldUri.fsPath);
			const ext = path.extname(oldName);
			const input = await vscode.window.showInputBox({
				prompt: 'New name',
				value: oldName,
				validateInput: (v) => v.trim() ? null : 'Name cannot be empty',
			});
			if (!input || input === oldName) { return; }
			const newName = input.endsWith(ext) ? input : `${input}${ext}`;
			const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(oldUri.fsPath)), newName);
			const edit = new vscode.WorkspaceEdit();
			edit.renameFile(oldUri, newUri, { overwrite: false });
			const ok = await vscode.workspace.applyEdit(edit);
			if (!ok) {
				vscode.window.showErrorMessage('Falha ao renomear o arquivo.');
			}
		}),
	);
}

async function selectDiagramTheme(): Promise<void> {
	const current = vscode.workspace.getConfiguration('docspace').get<string>('diagramTheme', 'auto');
	const picked = await vscode.window.showQuickPick(
		[
			{ label: '$(color-mode) Auto',    description: 'Segue o tema do VS Code (claro → default, escuro → dark)', value: 'auto' },
			{ label: '$(symbol-color) Default', description: 'Tema padrão do Mermaid',          value: 'default' },
			{ label: '$(moon) Dark',           description: 'Tema escuro',                       value: 'dark' },
			{ label: '$(tree) Forest',         description: 'Tema floresta (tons de verde)',      value: 'forest' },
			{ label: '$(circle-outline) Neutral', description: 'Tema neutro (tons de cinza)',    value: 'neutral' },
			{ label: '$(paintcan) Base',       description: 'Tema base personalizável',          value: 'base' },
		],
		{ title: 'Docspace — tema dos diagramas', placeHolder: `Atual: ${current}` }
	);
	if (picked) {
		await vscode.workspace.getConfiguration('docspace').update(
			'diagramTheme', picked.value, configTarget()
		);
	}
}

async function selectSort(): Promise<void> {
	const current = vscode.workspace.getConfiguration('docspace').get<string>('sortBy', 'name');
	const picked = await vscode.window.showQuickPick(
		[
			{ label: '$(case-sensitive) Nome', description: 'Ordem alfabética', value: 'name' },
			{ label: '$(history) Modificação', description: 'Modificados mais recentemente primeiro', value: 'modified' },
			{ label: '$(symbol-ruler) Tamanho', description: 'Maiores primeiro', value: 'size' },
		],
		{ title: 'Docspace — ordenar arquivos', placeHolder: `Atual: ${current}` }
	);
	if (picked) {
		await vscode.workspace.getConfiguration('docspace').update('sortBy', picked.value, configTarget());
	}
}

/** Right-click on a category: pick its discovery mode (auto / specific folder). */
async function configureCategory(item?: WorkspaceTreeItem): Promise<void> {
	const key = item?.filterKey;
	if (!key) { return; }

	const { mode, folder } = getCategoryConfig(key);
	const currentLabel = mode === 'auto' ? 'Automático' : `Pasta (${folder || '—'})`;
	const picked = await vscode.window.showQuickPick(
		[
			{ label: '$(search) Automático', description: `Detecta os arquivos de ${CATEGORY_LABELS[key]} no projeto inteiro`, value: 'auto' },
			{ label: '$(folder-opened) Escolher pasta…', description: 'Mostra apenas os arquivos de uma pasta específica', value: 'folder' },
		],
		{ title: `Docspace — categoria ${CATEGORY_LABELS[key]}`, placeHolder: `Atual: ${currentLabel}` }
	);
	if (!picked) { return; }

	const cfg = vscode.workspace.getConfiguration('docspace');
	if (picked.value === 'auto') {
		await cfg.update(`${key}Mode`, 'auto', configTarget());
		return;
	}

	const value = await pickCategoryFolder(key);
	if (value === undefined) { return; }
	await cfg.update(`${key}Folder`, value, configTarget());
	await cfg.update(`${key}Mode`, 'folder', configTarget());
}

/** Folder dialog for a category; workspace-internal picks become relative paths. */
async function pickCategoryFolder(key: CategoryKey): Promise<string | undefined> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Usar esta pasta',
		title: `Docspace — pasta da categoria ${CATEGORY_LABELS[key]}`,
		defaultUri: resolveCategoryRoot(key) ?? workspaceRoot(),
	});
	if (!picked?.[0]) { return undefined; }

	const root = workspaceRoot();
	const value = picked[0].fsPath;
	if (root && value.toLowerCase().startsWith(root.fsPath.toLowerCase() + path.sep)) {
		return path.relative(root.fsPath, value).split(path.sep).join('/');
	}
	return value;
}

async function regenerateDoc(
	context: vscode.ExtensionContext,
	provider: DocspaceProvider,
): Promise<void> {
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Docspace: gerando documentação…' },
			() => generateProjectDocs(context)
		);
		provider.refreshAll();
		vscode.window.showInformationMessage('Docspace: documentação gerada em docGerada/.');
	} catch (err) {
		vscode.window.showErrorMessage(
			`Docspace: falha ao gerar documentação — ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new DocspaceProvider();
	const externalWatcher = new ExternalRootsWatcher(provider);
	externalWatcher.sync();

	const notion = new NotionManager(context, () => provider.refreshAll());

	context.subscriptions.push(
		provider,
		externalWatcher,
		notion,
		...notion.register(),
		CanvasEditorProvider.register(context),
		vscode.window.registerTreeDataProvider('docspace.explorer', provider),
	);

	registerCommands(context, provider);
	registerTreeEvents(context, provider, externalWatcher);
}

export function deactivate(): void { }
