import * as vscode from 'vscode';
import * as path from 'path';
import { DocspaceProvider } from './provider.js';
import { getConfig, resolveRootUri, workspaceRoot } from './config.js';
import { scaffoldFolderStructure } from './folderMode.js';
import { PreviewPanel } from './previewPanel.js';
import { GraphPanel } from './graphPanel.js';
import { CanvasEditorProvider } from './canvasEditor.js';
import { WorkspaceTreeItem } from './treeItem.js';

const RELEVANT_FILE = /\.(md|mmd|excalidraw)$/i;
const RELEVANT_GLOB = '**/*.{md,mmd,excalidraw}';

/** Let the user pick the destination folder when no tree folder gave context. */
async function pickTargetFolder(): Promise<vscode.Uri | undefined> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Salvar aqui',
		title: 'Docspace — onde salvar o arquivo?',
		defaultUri: resolveRootUri() ?? workspaceRoot(),
	});
	return picked?.[0];
}

async function createFile(
	item: WorkspaceTreeItem | undefined,
	ext: string,
	buildContent: (name: string) => string,
	prompt: string,
	onCreated: (uri: vscode.Uri) => void,
): Promise<void> {
	const baseUri = item?.uri ?? await pickTargetFolder();
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
 * Watches the configured root folder when it lives outside the workspace
 * (absolute `docspace.rootFolder`) — the workspace-scoped watcher can't see it.
 * Re-synced whenever mode/rootFolder change.
 */
class ExternalRootWatcher implements vscode.Disposable {
	private current: vscode.Disposable[] = [];

	constructor(private readonly provider: DocspaceProvider) {}

	sync(): void {
		this.dispose();
		const root = resolveRootUri();
		if (!root || getConfig().mode !== 'folder' || vscode.workspace.getWorkspaceFolder(root)) {
			return;
		}
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(root, RELEVANT_GLOB)
		);
		this.current = [
			watcher,
			watcher.onDidCreate((uri) => this.provider.invalidate(uri)),
			watcher.onDidChange((uri) => this.provider.invalidate(uri)),
			watcher.onDidDelete((uri) => this.provider.invalidate(uri)),
		];
	}

	dispose(): void {
		for (const d of this.current) { d.dispose(); }
		this.current = [];
	}
}

function registerTreeEvents(
	context: vscode.ExtensionContext,
	provider: DocspaceProvider,
	externalWatcher: ExternalRootWatcher,
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
			if (
				e.affectsConfiguration('docspace.mode') ||
				e.affectsConfiguration('docspace.rootFolder') ||
				e.affectsConfiguration('docspace.exclude')
			) {
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
		vscode.commands.registerCommand('docspace.selectMode', selectMode),
		vscode.commands.registerCommand('docspace.selectRootFolder', selectRootFolder),
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
			if (!item?.uri) { return; }
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
			if (!item?.uri) { return; }
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
			'diagramTheme', picked.value, vscode.ConfigurationTarget.Workspace
		);
	}
}

function configTarget(): vscode.ConfigurationTarget {
	return workspaceRoot() ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

async function selectMode(): Promise<void> {
	const current = getConfig().mode;
	const picked = await vscode.window.showQuickPick(
		[
			{ label: '$(search) Auto', description: 'Descobre .md, .mmd e Mermaid em todo o workspace', value: 'auto' },
			{ label: '$(folder) Folder', description: 'Usa a pasta .docspace (ou docspace.rootFolder) como fonte', value: 'folder' },
			{ label: '$(folder-opened) Escolher pasta…', description: 'Aponta o Docspace para qualquer pasta do computador', value: 'pick' },
		],
		{ title: 'Docspace — modo de descoberta', placeHolder: `Atual: ${current}` }
	);
	if (!picked) { return; }
	if (picked.value === 'pick') {
		await selectRootFolder();
		return;
	}
	await vscode.workspace.getConfiguration('docspace').update('mode', picked.value, configTarget());
	if (picked.value === 'folder') {
		await scaffoldFolderStructure();
	}
}

/**
 * Point Docspace at any folder on disk. Folders inside the workspace are
 * stored as relative paths (portable); anything else is stored absolute.
 */
async function selectRootFolder(): Promise<void> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Usar esta pasta',
		title: 'Docspace — pasta de documentos',
		defaultUri: resolveRootUri() ?? workspaceRoot(),
	});
	if (!picked?.[0]) { return; }

	const root = workspaceRoot();
	let value = picked[0].fsPath;
	if (root && value.toLowerCase().startsWith(root.fsPath.toLowerCase() + path.sep)) {
		value = path.relative(root.fsPath, value).split(path.sep).join('/');
	}

	const cfg = vscode.workspace.getConfiguration('docspace');
	await cfg.update('rootFolder', value, configTarget());
	await cfg.update('mode', 'folder', configTarget());
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new DocspaceProvider();
	const externalWatcher = new ExternalRootWatcher(provider);
	externalWatcher.sync();

	context.subscriptions.push(
		provider,
		externalWatcher,
		CanvasEditorProvider.register(context),
		vscode.window.registerTreeDataProvider('docspace.explorer', provider),
	);

	registerCommands(context, provider);
	registerTreeEvents(context, provider, externalWatcher);
}

export function deactivate(): void { }
