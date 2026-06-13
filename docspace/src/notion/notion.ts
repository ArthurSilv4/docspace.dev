import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { workspaceRoot } from '../sidebar/config.js';
import { NotionClient, NotionPage } from './notionClient.js';
import { blocksToMarkdown, markdownToBlocks, pageTitle } from './notionConvert.js';

const TOKEN_KEY = 'notionToken';
const LINKS_KEY = 'docspace.notionLinks';
const POLL_DEFAULT_MIN = 5;

/** A local .md file mirrored from a Notion page. */
interface NotionLink {
	notionId: string;
	fsPath: string;
	title: string;
	lastEditedTime: string; // remote — detects upstream changes
	hash: string;           // sha1 of last-synced content — detects local edits
}

function sha1(text: string): string {
	return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function getToken(): string {
	return vscode.workspace.getConfiguration('docspace').get<string>(TOKEN_KEY, '').trim();
}

function sanitizeFilename(title: string): string {
	return (title.replace(/[\\/:*?"<>|]/g, '-').trim() || 'notion-page').slice(0, 80);
}

/**
 * Manual-token Notion integration: connect, import pages as Markdown, pull/push,
 * poll for upstream changes, and badge linked files in the explorer.
 */
export class NotionManager implements vscode.Disposable {
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private readonly decorations = new NotionDecorationProvider();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onChanged: () => void,
	) {
		this.disposables.push(
			vscode.window.registerFileDecorationProvider(this.decorations),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('docspace.notionPollMinutes')) { this.restartPolling(); }
				if (e.affectsConfiguration('docspace.notionToken')) { this.syncConnectedContext(); }
			}),
		);
		this.syncConnectedContext();
		this.refreshDecorations();
		this.restartPolling();
	}

	private syncConnectedContext(): void {
		void vscode.commands.executeCommand('setContext', 'docspace.notionConnected', !!getToken());
	}

	register(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand('docspace.notionConnect', () => this.connect()),
			vscode.commands.registerCommand('docspace.notionImport', () => this.importPages()),
			vscode.commands.registerCommand('docspace.notionPull', () => this.pullCommand()),
			vscode.commands.registerCommand('docspace.notionPush', () => this.pushCommand()),
			vscode.commands.registerCommand('docspace.notionDisconnect', () => this.disconnect()),
		];
	}

	dispose(): void {
		if (this.pollTimer) { clearInterval(this.pollTimer); }
		for (const d of this.disposables) { d.dispose(); }
	}

	// ── Link storage ─────────────────────────────────────────────────────────────
	private links(): NotionLink[] {
		return this.context.workspaceState.get<NotionLink[]>(LINKS_KEY, []);
	}

	private async setLinks(links: NotionLink[]): Promise<void> {
		await this.context.workspaceState.update(LINKS_KEY, links);
		this.refreshDecorations();
		this.onChanged();
	}

	private async upsertLink(link: NotionLink): Promise<void> {
		const links = this.links().filter((l) => l.notionId !== link.notionId);
		links.push(link);
		await this.setLinks(links);
	}

	private refreshDecorations(): void {
		this.decorations.setLinked(new Set(this.links().map((l) => l.fsPath)));
	}

	private client(): NotionClient | undefined {
		const token = getToken();
		if (!token) {
			const connectLabel = vscode.l10n.t('Connect');
			vscode.window.showWarningMessage(
				vscode.l10n.t('Docspace: connect Notion first.'),
				connectLabel
			).then((choice) => { if (choice === connectLabel) { void this.connect(); } });
			return undefined;
		}
		return new NotionClient(token);
	}

	// ── Connect / disconnect ─────────────────────────────────────────────────────
	private async connect(): Promise<void> {
		const token = await vscode.window.showInputBox({
			title: vscode.l10n.t('Docspace — Notion integration token'),
			prompt: vscode.l10n.t('Paste the Internal Integration Token (starts with "ntn_" or "secret_")'),
			password: true,
			ignoreFocusOut: true,
			value: getToken(),
		});
		if (token === undefined) { return; }
		try {
			const name = await new NotionClient(token.trim()).whoAmI();
			await vscode.workspace.getConfiguration('docspace').update(
				TOKEN_KEY, token.trim(), vscode.ConfigurationTarget.Global
			);
			this.syncConnectedContext();
			vscode.window.showInformationMessage(vscode.l10n.t('Docspace: connected to Notion as "{0}".', name));
			this.restartPolling();
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Docspace: invalid token — {0}', errText(err)));
		}
	}

	private async disconnect(): Promise<void> {
		const disconnectLabel = vscode.l10n.t('Disconnect');
		const ok = await vscode.window.showWarningMessage(
			vscode.l10n.t('Disconnect Notion? The token and all file links will be removed.'),
			{ modal: true }, disconnectLabel
		);
		if (ok !== disconnectLabel) { return; }
		await vscode.workspace.getConfiguration('docspace').update(TOKEN_KEY, undefined, vscode.ConfigurationTarget.Global);
		this.syncConnectedContext();
		await this.setLinks([]);
		if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
		vscode.window.showInformationMessage(vscode.l10n.t('Docspace: Notion disconnected.'));
	}

	// ── Import ───────────────────────────────────────────────────────────────────
	private async importPages(): Promise<void> {
		const client = this.client();
		if (!client) { return; }
		const query = await vscode.window.showInputBox({
			title: vscode.l10n.t('Docspace — import from Notion'),
			prompt: vscode.l10n.t('Search by page title (leave empty to list most recent)'),
			ignoreFocusOut: true,
		});
		if (query === undefined) { return; }

		const pages = await withProgress(vscode.l10n.t('Searching pages…'), () => client.searchPages(query));
		if (!pages.length) {
			const howToLabel = vscode.l10n.t('How to connect pages');
			const action = await vscode.window.showWarningMessage(
				vscode.l10n.t('No pages found. In Notion, open each page you want to import, click "…" → "Connections" and add your integration.'),
				howToLabel
			);
			if (action) {
				await vscode.env.openExternal(vscode.Uri.parse('https://www.notion.so/help/add-and-manage-connections-with-the-api#add-connections-to-pages'));
			}
			return;
		}

		const picks = await vscode.window.showQuickPick(
			pages.map((p) => ({ label: pageTitle(p), description: p.id, page: p })),
			{ title: vscode.l10n.t('Select pages to import'), canPickMany: true }
		);
		if (!picks?.length) { return; }

		const folder = await pickFolder();
		if (!folder) { return; }

		await withProgress(vscode.l10n.t('Importing…'), async () => {
			for (const pick of picks) { await this.importOne(client, pick.page, folder); }
		});
		vscode.window.showInformationMessage(vscode.l10n.t('Docspace: {0} page(s) imported.', picks.length));
	}

	private async importOne(client: NotionClient, page: NotionPage, folder: vscode.Uri): Promise<void> {
		const title = pageTitle(page);
		const blocks = await client.blockTree(page.id);
		const md = `# ${title}\n\n${blocksToMarkdown(blocks)}`;
		const target = vscode.Uri.joinPath(folder, `${sanitizeFilename(title)}.md`);
		await vscode.workspace.fs.writeFile(target, Buffer.from(md, 'utf8'));
		await this.upsertLink({
			notionId: page.id, fsPath: target.fsPath, title,
			lastEditedTime: page.last_edited_time, hash: sha1(md),
		});
	}

	// ── Pull / push ──────────────────────────────────────────────────────────────
	private async pickLink(placeHolder: string): Promise<NotionLink | undefined> {
		const links = this.links();
		if (!links.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('No files linked to Notion.'));
			return undefined;
		}
		const pick = await vscode.window.showQuickPick(
			links.map((l) => ({ label: l.title, description: vscode.workspace.asRelativePath(l.fsPath), link: l })),
			{ title: placeHolder }
		);
		return pick?.link;
	}

	private async pullCommand(): Promise<void> {
		const client = this.client();
		if (!client) { return; }
		const link = await this.pickLink(vscode.l10n.t('Pull from Notion'));
		if (link) { await withProgress(vscode.l10n.t('Pulling…'), () => this.pull(client, link, true)); }
	}

	/** Overwrite the local file with the page's current content. Honours conflicts. */
	private async pull(client: NotionClient, link: NotionLink, manual: boolean): Promise<void> {
		const page = await client.retrievePage(link.notionId);
		const blocks = await client.blockTree(link.notionId);
		const md = `# ${pageTitle(page)}\n\n${blocksToMarkdown(blocks)}`;
		const uri = vscode.Uri.file(link.fsPath);

		const localEdited = await this.hasLocalEdits(uri, link.hash);
		if (localEdited && !(await this.confirmOverwrite(uri, md))) { return; }

		await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
		await this.upsertLink({ ...link, title: pageTitle(page), lastEditedTime: page.last_edited_time, hash: sha1(md) });
		if (manual) {
			vscode.window.showInformationMessage(vscode.l10n.t('Docspace: "{0}" updated from Notion.', link.title));
		}
	}

	private async pushCommand(): Promise<void> {
		const client = this.client();
		if (!client) { return; }
		const link = await this.pickLink(vscode.l10n.t('Push to Notion'));
		if (!link) { return; }
		try {
			await withProgress(vscode.l10n.t('Pushing…'), async () => {
				const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(link.fsPath));
				const text = Buffer.from(bytes).toString('utf8');
				// drop the leading "# Title" line — it lives in the page's own title
				const body = text.replace(/^#\s+.*\n+/, '');
				await client.replaceContent(link.notionId, markdownToBlocks(body));
				const page = await client.retrievePage(link.notionId);
				await this.upsertLink({ ...link, lastEditedTime: page.last_edited_time, hash: sha1(text) });
			});
			vscode.window.showInformationMessage(vscode.l10n.t('Docspace: "{0}" pushed to Notion.', link.title));
		} catch (err) {
			vscode.window.showErrorMessage(vscode.l10n.t('Docspace: failed to push — {0}', errText(err)));
		}
	}

	private async hasLocalEdits(uri: vscode.Uri, syncedHash: string): Promise<boolean> {
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return sha1(Buffer.from(bytes).toString('utf8')) !== syncedHash;
		} catch { return false; }
	}

	private async confirmOverwrite(uri: vscode.Uri, incoming: string): Promise<boolean> {
		const viewDiff = vscode.l10n.t('View diff');
		const overwrite = vscode.l10n.t('Overwrite local');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('Conflict in "{0}": there are local edits and the Notion page has changed.', path.basename(uri.fsPath)),
			{ modal: true }, viewDiff, overwrite
		);
		if (choice === overwrite) { return true; }
		if (choice === viewDiff) {
			const tmp = vscode.Uri.joinPath(this.context.globalStorageUri, 'notion-incoming.md');
			await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
			await vscode.workspace.fs.writeFile(tmp, Buffer.from(incoming, 'utf8'));
			await vscode.commands.executeCommand('vscode.diff', uri, tmp, vscode.l10n.t('Local ↔ Notion (incoming)'));
		}
		return false;
	}

	// ── Polling ──────────────────────────────────────────────────────────────────
	private restartPolling(): void {
		if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
		if (!getToken()) { return; }
		const minutes = vscode.workspace.getConfiguration('docspace').get<number>('notionPollMinutes', POLL_DEFAULT_MIN);
		if (minutes <= 0) { return; }
		this.pollTimer = setInterval(() => { void this.poll(); }, minutes * 60 * 1000);
	}

	private async poll(): Promise<void> {
		const token = getToken();
		if (!token) { return; }
		const client = new NotionClient(token);
		for (const link of this.links()) {
			try {
				const page = await client.retrievePage(link.notionId);
				if (page.last_edited_time !== link.lastEditedTime) { await this.pull(client, link, false); }
			} catch { /* skip a page that failed this round */ }
		}
	}
}

class NotionDecorationProvider implements vscode.FileDecorationProvider {
	private linked = new Set<string>();
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
	readonly onDidChangeFileDecorations = this._onDidChange.event;

	setLinked(paths: Set<string>): void {
		const affected = [...new Set([...this.linked, ...paths])].map((p) => vscode.Uri.file(p));
		this.linked = paths;
		this._onDidChange.fire(affected);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		return this.linked.has(uri.fsPath)
			? { badge: 'N', tooltip: vscode.l10n.t('Linked to Notion'), color: new vscode.ThemeColor('charts.purple') }
			: undefined;
	}
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function withProgress<T>(title: string, task: () => Thenable<T>): Thenable<T> {
	return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Docspace: ${title}` }, task);
}

async function pickFolder(): Promise<vscode.Uri | undefined> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
		openLabel: vscode.l10n.t('Import here'),
		title: vscode.l10n.t('Where to save the imported pages?'),
		defaultUri: workspaceRoot(),
	});
	return picked?.[0];
}
