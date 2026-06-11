import * as vscode from 'vscode';
import * as path from 'path';
import { getConfig, resolveRootUri, workspaceRoot } from './config.js';
import { buildProjectGraph } from './projectGraph.js';

const CYTOSCAPE_VERSION = '3.34.0';
// fcose force-directed layout (Obsidian-like) — UMD chain requires the
// layout-base and cose-base globals to be loaded first
const FCOSE_VERSION = '2.2.0';
const COSE_BASE_VERSION = '2.2.0';
const LAYOUT_BASE_VERSION = '2.0.1';
// dagre layered layout (Flow view) — UMD requires the dagre global first
const DAGRE_VERSION = '0.8.5';
const CYTOSCAPE_DAGRE_VERSION = '2.5.0';

interface WebviewMessage { type: string; path?: string }

export class GraphPanel {
	private static current: GraphPanel | undefined;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly context: vscode.ExtensionContext,
	) {}

	static createOrShow(context: vscode.ExtensionContext): void {
		if (GraphPanel.current) {
			GraphPanel.current.panel.reveal();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'docspaceGraph',
			'Project Graph',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			}
		);

		const instance = new GraphPanel(panel, context);
		GraphPanel.current = instance;
		panel.webview.html = instance.buildHtml();

		const messageListener = panel.webview.onDidReceiveMessage((msg: WebviewMessage) => instance.onMessage(msg));
		panel.onDidDispose(() => {
			GraphPanel.current = undefined;
			messageListener.dispose();
		});
	}

	private async onMessage(msg: WebviewMessage): Promise<void> {
		if (msg.type === 'ready' || msg.type === 'refresh') {
			await this.sendGraph();
			return;
		}
		if (msg.type === 'open' && msg.path) {
			const root = workspaceRoot();
			if (root) {
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(root, msg.path));
			}
		}
	}

	private async sendGraph(): Promise<void> {
		const root = resolveRootUri() ?? workspaceRoot();
		if (!root) {
			await this.panel.webview.postMessage({ type: 'error', message: 'No workspace open.' });
			return;
		}
		try {
			const graph = await buildProjectGraph(root, getConfig().exclude);
			await this.panel.webview.postMessage({
				type: 'graph',
				graph,
				rootName: path.basename(root.fsPath),
			});
		} catch (err) {
			await this.panel.webview.postMessage({
				type: 'error',
				message: `Failed to build graph: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	private buildHtml(): string {
		const webview = this.panel.webview;
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph.css'));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph.js'));

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} https://cdn.jsdelivr.net; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${cssUri}">
  <title>Project Graph</title>
</head>
<body>
  <div class="toolbar">
    <div class="segmented" role="group" aria-label="Layout mode">
      <button id="mode-network" class="active" title="Force layout — structure and clusters">Network</button>
      <button id="mode-flow" title="Layered layout — dependency flow, top to bottom">Flow</button>
    </div>
    <input id="search" type="search" placeholder="Search files… (Enter to zoom)" aria-label="Search nodes">
    <select id="folder-filter" aria-label="Filter by folder">
      <option value="">All folders</option>
    </select>
    <select id="type-filter" aria-label="Filter by type">
      <option value="all">Files + modules</option>
      <option value="files">Files only</option>
    </select>
    <span class="spacer"></span>
    <span id="stats" class="stats"></span>
    <button id="fit" title="Fit graph to view">Fit</button>
    <button id="refresh" title="Rebuild the graph">Refresh</button>
  </div>
  <div id="cy" role="application" aria-label="Project dependency graph"></div>
  <div id="overlay" class="overlay"><div class="spinner"></div><span id="overlay-text">Building project graph…</span></div>
  <script src="https://cdn.jsdelivr.net/npm/cytoscape@${CYTOSCAPE_VERSION}/dist/cytoscape.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/layout-base@${LAYOUT_BASE_VERSION}/layout-base.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/cose-base@${COSE_BASE_VERSION}/cose-base.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/cytoscape-fcose@${FCOSE_VERSION}/cytoscape-fcose.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dagre@${DAGRE_VERSION}/dist/dagre.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@${CYTOSCAPE_DAGRE_VERSION}/cytoscape-dagre.js"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
	}
}
