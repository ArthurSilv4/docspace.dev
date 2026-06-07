import * as vscode from 'vscode';
import * as path from 'path';

function resolveCanvasTheme(): string {
	const kind = vscode.window.activeColorTheme.kind;
	return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast ? 'dark' : 'light';
}

export class CanvasEditorProvider implements vscode.CustomTextEditorProvider {

	static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			'docspace.canvasEditor',
			new CanvasEditorProvider(context),
			{ webviewOptions: { retainContextWhenHidden: true } }
		);
	}

	constructor(private readonly context: vscode.ExtensionContext) {}

	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webviewPanel.webview.html = this.buildHtml(webviewPanel.webview, document);

		// Extension → Webview: sync external changes (e.g. git pull)
		const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.fsPath !== document.uri.fsPath) { return; }
			webviewPanel.webview.postMessage({ type: 'update', content: e.document.getText() });
		});

		// Sync theme when VS Code color theme changes
		const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
			const theme = resolveCanvasTheme();
			webviewPanel.webview.postMessage({ type: 'theme', theme });
		});

		// Webview → Extension: apply Excalidraw changes to the document
		const messageListener = webviewPanel.webview.onDidReceiveMessage(async (msg: { type: string; content: string }) => {
			if (msg.type === 'save') {
				await document.save();
				return;
			}
			if (msg.type !== 'change') { return; }
			if (msg.content.trim() === document.getText().trim()) { return; }
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				document.uri,
				new vscode.Range(0, 0, document.lineCount, 0),
				msg.content,
			);
			await vscode.workspace.applyEdit(edit);
		});

		webviewPanel.onDidDispose(() => {
			changeListener.dispose();
			themeListener.dispose();
			messageListener.dispose();
		});
	}

	private buildHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'canvas.css'));
		const jsUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'canvas.js'));
		const filename = path.basename(document.uri.fsPath);
		const theme  = resolveCanvasTheme();

		// Provide safe initial data — fall back to empty drawing on bad JSON
		let initialData = '{}';
		try {
			const text = document.getText().trim();
			if (text) { JSON.parse(text); initialData = text; }
		} catch { /* leave as empty */ }

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com;
    script-src 'unsafe-inline' ${webview.cspSource} https://cdn.jsdelivr.net;
    font-src https://fonts.gstatic.com;
    img-src ${webview.cspSource} data: blob:;
    connect-src https://fonts.gstatic.com https://fonts.googleapis.com;
  ">
  <link rel="stylesheet" href="${cssUri}">
  <title>${filename}</title>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__DOCSPACE_THEME__       = ${JSON.stringify(theme)};
    window.__DOCSPACE_CANVAS_DATA__ = ${JSON.stringify(initialData)};
    window.EXCALIDRAW_ASSET_PATH    = 'https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw/dist/';
  </script>
  <script src="https://cdn.jsdelivr.net/npm/react@18.2.0/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18.2.0/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw/dist/excalidraw.production.min.js"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
	}
}
