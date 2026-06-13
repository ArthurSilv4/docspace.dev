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
		openLabel: vscode.l10n.t('Save here'),
		title: vscode.l10n.t('Docspace — where to save the file?'),
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
		validateInput: (v) => v.trim() ? null : vscode.l10n.t('Name cannot be empty'),
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
			createFile(item, 'md', (n) => `# ${n.replace(/\.md$/, '')}\n`,
				vscode.l10n.t('Markdown filename'), onCreated)
		),
		vscode.commands.registerCommand('docspace.newMermaid', (item?: WorkspaceTreeItem) =>
			createFile(item, 'mmd', () => 'graph TD\n    A --> B\n',
				vscode.l10n.t('Mermaid filename'), onCreated)
		),
		vscode.commands.registerCommand('docspace.newExcalidraw', (item?: WorkspaceTreeItem) =>
			createFile(item, 'excalidraw', () => JSON.stringify({
				type: 'excalidraw', version: 2, source: 'docspace', elements: [],
				appState: { gridSize: 20 }, files: {},
			}, null, 2), vscode.l10n.t('Canvas filename'), onCreated)
		),
		vscode.commands.registerCommand('docspace.deleteFile', async (item?: WorkspaceTreeItem) => {
			if (!item?.uri || item.kind === 'genFile') { return; }
			const name = path.basename(item.uri.fsPath);
			const label = vscode.l10n.t('Delete');
			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t('Delete {0}?', name), { modal: true }, label
			);
			if (confirm === label) {
				await vscode.workspace.fs.delete(item.uri, { recursive: true, useTrash: true });
				if (item.kind === 'genFolder') { provider.refreshAll(); }
				else { provider.invalidate(item.uri); }
			}
		}),
		vscode.commands.registerCommand('docspace.renameFile', async (item?: WorkspaceTreeItem) => {
			if (!item?.uri || item.kind === 'genFile' || item.kind === 'genFolder') { return; }
			const oldUri = item.uri;
			const oldName = path.basename(oldUri.fsPath);
			const ext = path.extname(oldName);
			const input = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('New name'),
				value: oldName,
				validateInput: (v) => v.trim() ? null : vscode.l10n.t('Name cannot be empty'),
			});
			if (!input || input === oldName) { return; }
			const newName = input.endsWith(ext) ? input : `${input}${ext}`;
			const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(oldUri.fsPath)), newName);
			const edit = new vscode.WorkspaceEdit();
			edit.renameFile(oldUri, newUri, { overwrite: false });
			const ok = await vscode.workspace.applyEdit(edit);
			if (!ok) {
				vscode.window.showErrorMessage(vscode.l10n.t('Failed to rename file.'));
			}
		}),
	);
}

async function selectDiagramTheme(): Promise<void> {
	const current = vscode.workspace.getConfiguration('docspace').get<string>('diagramTheme', 'auto');
	const picked = await vscode.window.showQuickPick(
		[
			{ label: '$(color-mode) Auto',           description: vscode.l10n.t('Follows the VS Code theme (light → default, dark → dark)'), value: 'auto' },
			{ label: '$(symbol-color) Default',      description: vscode.l10n.t('Mermaid default theme'),        value: 'default' },
			{ label: '$(moon) Dark',                 description: vscode.l10n.t('Dark theme'),                   value: 'dark' },
			{ label: '$(tree) Forest',               description: vscode.l10n.t('Forest theme (green tones)'),   value: 'forest' },
			{ label: '$(circle-outline) Neutral',    description: vscode.l10n.t('Neutral theme (grey tones)'),   value: 'neutral' },
			{ label: '$(paintcan) Base',             description: vscode.l10n.t('Customizable base theme'),      value: 'base' },
		],
		{
			title: vscode.l10n.t('Docspace — diagram theme'),
			placeHolder: vscode.l10n.t('Current: {0}', current),
		}
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
			{ label: vscode.l10n.t('$(case-sensitive) Name'),     description: vscode.l10n.t('Alphabetical order'),           value: 'name' },
			{ label: vscode.l10n.t('$(history) Modified'),        description: vscode.l10n.t('Most recently modified first'), value: 'modified' },
			{ label: vscode.l10n.t('$(symbol-ruler) Size'),       description: vscode.l10n.t('Largest first'),                value: 'size' },
		],
		{
			title: vscode.l10n.t('Docspace — sort files'),
			placeHolder: vscode.l10n.t('Current: {0}', current),
		}
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
	const currentLabel = mode === 'auto'
		? vscode.l10n.t('Automatic')
		: vscode.l10n.t('Folder ({0})', folder || '—');
	const picked = await vscode.window.showQuickPick(
		[
			{
				label: vscode.l10n.t('$(search) Automatic'),
				description: vscode.l10n.t('Discovers {0} files across the entire project', CATEGORY_LABELS[key]),
				value: 'auto',
			},
			{
				label: vscode.l10n.t('$(folder-opened) Choose folder…'),
				description: vscode.l10n.t('Shows only files inside a specific folder'),
				value: 'folder',
			},
		],
		{
			title: vscode.l10n.t('Docspace — {0} category', CATEGORY_LABELS[key]),
			placeHolder: vscode.l10n.t('Current: {0}', currentLabel),
		}
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
		openLabel: vscode.l10n.t('Use this folder'),
		title: vscode.l10n.t('Docspace — {0} category folder', CATEGORY_LABELS[key]),
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
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Docspace: generating documentation…') },
			() => generateProjectDocs(context)
		);
		provider.refreshAll();
		vscode.window.showInformationMessage(vscode.l10n.t('Docspace: documentation generated in docGerada/.'));
	} catch (err) {
		vscode.window.showErrorMessage(
			vscode.l10n.t('Docspace: failed to generate documentation — {0}', err instanceof Error ? err.message : String(err))
		);
	}
}

async function openSettingsMenu(): Promise<void> {
	const isConnected = !!vscode.workspace.getConfiguration('docspace').get<string>('notionToken', '').trim();

	type MenuItem = vscode.QuickPickItem & { run: () => void };
	const items: MenuItem[] = [
		{
			label: `$(type-hierarchy) ${vscode.l10n.t('Open Project Graph')}`,
			run: () => { void vscode.commands.executeCommand('docspace.openProjectGraph'); },
		},
		{
			label: `$(book) ${vscode.l10n.t('Regenerate Docs')}`,
			run: () => { void vscode.commands.executeCommand('docspace.regenerateDoc'); },
		},
		{ label: '', kind: vscode.QuickPickItemKind.Separator, run: () => {} },
		{
			label: `$(sort-precedence) ${vscode.l10n.t('Sort Files')}`,
			run: () => { void vscode.commands.executeCommand('docspace.selectSort'); },
		},
		{
			label: `$(symbol-color) ${vscode.l10n.t('Change Diagram Theme')}`,
			run: () => { void vscode.commands.executeCommand('docspace.selectDiagramTheme'); },
		},
		{ label: '', kind: vscode.QuickPickItemKind.Separator, run: () => {} },
		isConnected
			? { label: `$(cloud-download) ${vscode.l10n.t('Notion: Import Pages')}`, run: () => { void vscode.commands.executeCommand('docspace.notionImport'); } }
			: { label: `$(plug) ${vscode.l10n.t('Notion: Connect')}`, run: () => { void vscode.commands.executeCommand('docspace.notionConnect'); } },
		...(isConnected ? [{
			label: `$(debug-disconnect) ${vscode.l10n.t('Notion: Disconnect')}`,
			run: () => { void vscode.commands.executeCommand('docspace.notionDisconnect'); },
		}] : []),
	];

	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t('Docspace'),
		placeHolder: vscode.l10n.t('Choose an action…'),
	});
	picked?.run();
}

const WALKTHROUGH_ID = 'ArthurSilv4.docspace-workspace#docspace.onboarding';

function openWalkthrough(): void {
	void vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID);
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
		vscode.commands.registerCommand('docspace.showWelcome', openWalkthrough),
		vscode.commands.registerCommand('docspace.openSettings', () => openSettingsMenu()),
	);

	registerCommands(context, provider);
	registerTreeEvents(context, provider, externalWatcher);

	// First-run: open the walkthrough automatically on new install
	const welcomed = context.globalState.get<boolean>('docspace.welcomed');
	if (!welcomed) {
		void context.globalState.update('docspace.welcomed', true);
		setTimeout(openWalkthrough, 1500);
	}
}

export function deactivate(): void { }
