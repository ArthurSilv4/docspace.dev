import * as vscode from 'vscode';
import * as path from 'path';

function resolveMermaidTheme(): string {
	const raw = vscode.workspace.getConfiguration('docspace').get<string>('diagramTheme', 'auto');
	if (raw !== 'auto') { return raw; }
	const kind = vscode.window.activeColorTheme.kind;
	const isDark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
	return isDark ? 'dark' : 'default';
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
			themeListener.dispose();
			configListener.dispose();
		});
	}

	sendUpdate(text: string): void {
		this.panel.webview.postMessage({ type: 'update', content: text });
	}

	async render(): Promise<void> {
		// openTextDocument returns the in-memory buffer, so unsaved edits show up
		const document = await vscode.workspace.openTextDocument(this.uri);
		const isMmd = this.uri.fsPath.endsWith('.mmd');
		this.panel.webview.html = this.buildHtml(document.getText(), isMmd);
	}

	private buildHtml(source: string, isMmd: boolean): string {
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource} https://cdn.jsdelivr.net; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${cssUri}">
  <title>Preview</title>
</head>
<body>
  <script>
    window.__DOCSPACE_THEME__    = ${JSON.stringify(theme)};
    window.__DOCSPACE_SOURCE__   = ${JSON.stringify(source)};
    window.__DOCSPACE_IS_MMD__   = ${JSON.stringify(isMmd)};
    window.__DOCSPACE_FILENAME__ = ${JSON.stringify(filename)};
  </script>
  <script src="https://cdn.jsdelivr.net/npm/@panzoom/panzoom@4/dist/panzoom.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/markdown-it@14/dist/markdown-it.min.js"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
	}
}
