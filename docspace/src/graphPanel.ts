import * as vscode from 'vscode';
import * as path from 'path';
import { configTarget, getExclude, workspaceRoot } from './config.js';
import { buildProjectGraph } from './projectGraph.js';

const CYTOSCAPE_VERSION = '3.34.0';
// fcose force-directed layout (Obsidian-like) — UMD chain requires the
// layout-base and cose-base globals to be loaded first
const FCOSE_VERSION = '2.2.0';
const COSE_BASE_VERSION = '2.2.0';
const LAYOUT_BASE_VERSION = '2.0.1';

interface WebviewMessage { type: string; path?: string; theme?: string }

function graphTheme(): string {
	return vscode.workspace.getConfiguration('docspace').get<string>('graphTheme', 'auto');
}

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
		const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('docspace.graphTheme')) {
				panel.webview.postMessage({ type: 'theme', theme: graphTheme() });
			}
		});
		panel.onDidDispose(() => {
			GraphPanel.current = undefined;
			messageListener.dispose();
			configListener.dispose();
		});
	}

	private async onMessage(msg: WebviewMessage): Promise<void> {
		if (msg.type === 'ready' || msg.type === 'refresh') {
			await this.sendGraph();
			return;
		}
		if (msg.type === 'setTheme' && msg.theme) {
			await vscode.workspace.getConfiguration('docspace').update('graphTheme', msg.theme, configTarget());
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
		const root = workspaceRoot();
		if (!root) {
			await this.panel.webview.postMessage({ type: 'error', message: 'No workspace open.' });
			return;
		}
		try {
			const graph = await buildProjectGraph(root, getExclude());
			await this.panel.webview.postMessage({
				type: 'graph',
				graph,
				theme: graphTheme(),
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
    <div class="segmented" role="group" aria-label="Graph mode">
      <button id="mode-deps" class="active" title="Rede de imports entre arquivos">Dependências</button>
      <button id="mode-flow" title="Camadas top→down por papel detectado">Fluxo</button>
      <button id="mode-impact" title="Clique num arquivo e veja quem seria afetado">Impacto</button>
    </div>
    <input id="search" type="search" placeholder="Buscar arquivo… (Enter aproxima)" aria-label="Search nodes">
    <select id="folder-filter" aria-label="Filter by folder">
      <option value="">Todas as pastas</option>
    </select>
    <select id="type-filter" aria-label="Filter by type">
      <option value="all">Arquivos + módulos</option>
      <option value="files">Só arquivos</option>
    </select>
    <label class="check" title="Oculta arquivos .test. / .spec.">
      <input id="hide-tests" type="checkbox"> sem testes
    </label>
    <select id="theme-select" aria-label="Tema do grafo" title="Tema do grafo">
      <option value="auto">Tema: auto</option>
      <option value="obsidian">Tema: obsidian</option>
      <option value="blueprint">Tema: blueprint</option>
      <option value="pastel">Tema: pastel</option>
      <option value="high-contrast">Tema: high-contrast</option>
    </select>
    <span class="spacer"></span>
    <span id="stats" class="stats"></span>
    <button id="fit" title="Ajustar à tela">Fit</button>
    <button id="refresh" title="Reconstruir o grafo">Refresh</button>
  </div>
  <div id="graph-wrap">
    <div id="cy" role="application" aria-label="Project dependency graph"></div>
    <div id="lanes" aria-hidden="true"></div>
  </div>
  <div id="overlay" class="overlay"><div class="spinner"></div><span id="overlay-text">Building project graph…</span></div>
  <script src="https://cdn.jsdelivr.net/npm/cytoscape@${CYTOSCAPE_VERSION}/dist/cytoscape.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/layout-base@${LAYOUT_BASE_VERSION}/layout-base.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/cose-base@${COSE_BASE_VERSION}/cose-base.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/cytoscape-fcose@${FCOSE_VERSION}/cytoscape-fcose.js"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
	}
}
