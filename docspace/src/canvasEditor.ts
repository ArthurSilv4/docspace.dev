import * as vscode from 'vscode';
import * as path from 'path';

// Last Excalidraw release with a UMD build — 0.18+ is ESM-only and the
// unpinned dist/excalidraw.production.min.js URL 404s there.
const EXCALIDRAW_VERSION = '0.17.6';
const REACT_VERSION = '18.2.0';

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

		// Edits we apply on the webview's behalf fire onDidChangeTextDocument
		// too; counting them keeps the webview from receiving an echo of its
		// own drawing (updateScene mid-stroke clobbers the active tool).
		let expectedEchoes = 0;

		// Extension → Webview: sync genuinely external changes (git pull, undo in VS Code)
		const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.fsPath !== document.uri.fsPath) { return; }
			if (expectedEchoes > 0) { expectedEchoes--; return; }
			webviewPanel.webview.postMessage({ type: 'update', content: e.document.getText() });
		});

		// Sync theme when VS Code color theme changes
		const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
			const theme = resolveCanvasTheme();
			webviewPanel.webview.postMessage({ type: 'theme', theme });
		});

		// Webview → Extension: apply Excalidraw changes to the document.
		// Messages are chained so a 'save' never runs before the 'change'
		// preceding it has been applied (flush-then-save on Ctrl+S).
		const handleMessage = async (msg: { type: string; content?: string }): Promise<void> => {
			if (msg.type === 'save') {
				await document.save();
				return;
			}
			if (msg.type !== 'change' || msg.content === undefined) { return; }
			if (msg.content.trim() === document.getText().trim()) { return; }
			const edit = new vscode.WorkspaceEdit();
			edit.replace(
				document.uri,
				new vscode.Range(0, 0, document.lineCount, 0),
				msg.content,
			);
			expectedEchoes++;
			const applied = await vscode.workspace.applyEdit(edit);
			if (!applied) { expectedEchoes--; }
		};
		let messageChain: Promise<void> = Promise.resolve();
		const messageListener = webviewPanel.webview.onDidReceiveMessage((msg: { type: string; content?: string }) => {
			messageChain = messageChain.then(() => handleMessage(msg));
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
    window.EXCALIDRAW_ASSET_PATH    = 'https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}/dist/';
  </script>
  <script src="https://cdn.jsdelivr.net/npm/react@${REACT_VERSION}/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@${REACT_VERSION}/umd/react-dom.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}/dist/excalidraw.production.min.js"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
	}
}
