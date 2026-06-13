import * as vscode from 'vscode';
import * as path from 'path';

const EMBED_RE = /!\[\[([^[\]]+?\.(?:mmd|excalidraw))\]\]/g;
const EXCALIDRAW_UTILS_VERSION = '0.1.2';

function resolveMermaidTheme(): string {
	const raw = vscode.workspace.getConfiguration('docspace').get<string>('diagramTheme', 'auto');
	if (raw !== 'auto') { return raw; }
	const kind = vscode.window.activeColorTheme.kind;
	const isDark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
	return isDark ? 'dark' : 'default';
}

/**
 * Resolve `![[file.mmd]]` / `![[file.excalidraw]]` references against the
 * document's folder and read their contents for inline rendering.
 */
async function collectEmbeds(source: string, baseDir: vscode.Uri): Promise<Record<string, string>> {
	const embeds: Record<string, string> = {};
	const names = new Set<string>();
	for (const match of source.matchAll(EMBED_RE)) { names.add(match[1]); }
	await Promise.all([...names].map(async (name) => {
		try {
			const uri = vscode.Uri.joinPath(baseDir, ...name.split('/'));
			const bytes = await vscode.workspace.fs.readFile(uri);
			embeds[name] = Buffer.from(bytes).toString('utf8');
		} catch { /* missing reference — webview shows a warning box */ }
	}));
	return embeds;
}

export class PreviewPanel {
	private static panels = new Map<string, PreviewPanel>();

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
		private readonly uri: vscode.Uri,
	) {}

	static async createOrShow(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
		// Open file in VS Code's native editor (left column)
		await vscode.window.showTextDocument(uri, {
			viewColumn: vscode.ViewColumn.One,
			preserveFocus: false,
		});

		// Reveal existing preview panel if already open
		const existing = PreviewPanel.panels.get(uri.fsPath);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.Two, true);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'docspacePreview',
			`Preview: ${path.basename(uri.fsPath)}`,
			{ viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			}
		);

		const instance = new PreviewPanel(panel, context, uri);
		PreviewPanel.panels.set(uri.fsPath, instance);
		await instance.render();

		// Live preview: update on every document change
		const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.fsPath === uri.fsPath) {
				instance.sendUpdate(e.document.getText());
			}
		});

		// Clicking a relative .mmd/.excalidraw link in the preview opens the file
		const messageListener = panel.webview.onDidReceiveMessage((msg: { type: string; href?: string }) => {
			if (msg.type === 'open' && msg.href) { instance.openRelative(msg.href); }
		});

		// Re-render if theme changes
		const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
			const raw = vscode.workspace.getConfiguration('docspace').get<string>('diagramTheme', 'auto');
			if (raw === 'auto') { instance.render(); }
		});
		const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('docspace.diagramTheme')) { instance.render(); }
		});

		panel.onDidDispose(() => {
			PreviewPanel.panels.delete(uri.fsPath);
			changeListener.dispose();
			messageListener.dispose();
			themeListener.dispose();
			configListener.dispose();
		});
	}

	private baseDir(): vscode.Uri {
		return vscode.Uri.file(path.dirname(this.uri.fsPath));
	}

	private async openRelative(href: string): Promise<void> {
		const clean = href.replace(/^\.\//, '').split('#')[0];
		const target = vscode.Uri.joinPath(this.baseDir(), ...clean.split('/'));
		if (/\.excalidraw$/i.test(target.fsPath)) {
			await vscode.commands.executeCommand('vscode.openWith', target, 'docspace.canvasEditor');
		} else {
			await vscode.commands.executeCommand('vscode.open', target);
		}
	}

	async sendUpdate(text: string): Promise<void> {
		const embeds = await collectEmbeds(text, this.baseDir());
		await this.panel.webview.postMessage({ type: 'update', content: text, embeds });
	}

	async render(): Promise<void> {
		// openTextDocument returns the in-memory buffer, so unsaved edits show up
		const document = await vscode.workspace.openTextDocument(this.uri);
		const source = document.getText();
		const isMmd = this.uri.fsPath.endsWith('.mmd');
		const embeds = isMmd ? {} : await collectEmbeds(source, this.baseDir());
		this.panel.webview.html = this.buildHtml(source, isMmd, embeds);
	}

	private buildWindowL(): string {
		return JSON.stringify({
			embedNotFound:   vscode.l10n.t('![[{0}]] — file not found'),
			embedNoRenderer: vscode.l10n.t('![[{0}]] — could not load renderer'),
			embedRenderError: vscode.l10n.t('![[{0}]] — render error: {1}'),
			toc:             vscode.l10n.t('Table of Contents'),
			copy:            vscode.l10n.t('Copy'),
			copyTitle:       vscode.l10n.t('Copy code'),
			copied:          vscode.l10n.t('Copied!'),
			copyFailed:      vscode.l10n.t('Failed'),
		});
	}

	private buildHtml(source: string, isMmd: boolean, embeds: Record<string, string>): string {
		const webview  = this.panel.webview;
		const cssUri   = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.css'));
		const jsUri    = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.js'));
		const theme    = resolveMermaidTheme();
		const filename = path.basename(this.uri.fsPath);

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource} https://cdn.jsdelivr.net; img-src ${webview.cspSource} data: blob:; font-src https://fonts.gstatic.com data:;">
  <link rel="stylesheet" href="${cssUri}">
  <title>Preview</title>
</head>
<body>
  <script>
    window.__DOCSPACE_THEME__    = ${JSON.stringify(theme)};
    window.__DOCSPACE_SOURCE__   = ${JSON.stringify(source)};
    window.__DOCSPACE_IS_MMD__   = ${JSON.stringify(isMmd)};
    window.__DOCSPACE_FILENAME__ = ${JSON.stringify(filename)};
    window.__DOCSPACE_EMBEDS__   = ${JSON.stringify(embeds)};
    window.L = ${this.buildWindowL()};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4/dist/panzoom.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/markdown-it@14/dist/markdown-it.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@excalidraw/utils@${EXCALIDRAW_UTILS_VERSION}/dist/excalidraw-utils.min.js"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
	}
}
