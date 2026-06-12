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
const CYTOSCAPE_SVG_VERSION = '0.4.0';

/** Manual layout (dragged positions) + node colors persisted per workspace. */
interface GraphState {
	positions: Record<string, { x: number; y: number }>;
	colors: Record<string, string>;
}

interface WebviewMessage {
	type: string; path?: string; theme?: string; data?: string; state?: GraphState;
}

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
		const handler = this.handlers()[msg.type];
		if (handler) { await handler(msg); }
	}

	/** Message-type → handler dispatch (keeps onMessage flat). */
	private handlers(): Record<string, (msg: WebviewMessage) => Promise<void>> {
		return {
			ready: () => this.sendGraph(),
			refresh: () => this.sendGraph(),
			setTheme: async (m) => {
				if (m.theme) {
					await vscode.workspace.getConfiguration('docspace').update('graphTheme', m.theme, configTarget());
				}
			},
			exportImage: async (m) => { if (m.data) { await this.saveImage(m.data); } },
			exportSvg: async (m) => { if (m.data) { await this.saveSvg(m.data); } },
			persistState: async (m) => {
				if (m.state) { await this.context.workspaceState.update(this.stateKey(), m.state); }
			},
			resetState: () => Promise.resolve(this.context.workspaceState.update(this.stateKey(), undefined)),
			open: async (m) => {
				const root = workspaceRoot();
				if (m.path && root) {
					await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(root, m.path));
				}
			},
		};
	}

	private stateKey(): string {
		const root = workspaceRoot();
		return `docspace.graphState:${root?.fsPath ?? 'none'}`;
	}

	private savedState(): GraphState {
		return this.context.workspaceState.get<GraphState>(this.stateKey())
			?? { positions: {}, colors: {} };
	}

	/** Decode the webview's PNG data URL and write it via a save dialog. */
	private async saveImage(dataUrl: string): Promise<void> {
		const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
		await this.saveExport('png', Buffer.from(base64, 'base64'));
	}

	private async saveSvg(svg: string): Promise<void> {
		await this.saveExport('svg', Buffer.from(svg, 'utf8'));
	}

	private async saveExport(ext: 'png' | 'svg', bytes: Uint8Array): Promise<void> {
		const root = workspaceRoot();
		const target = await vscode.window.showSaveDialog({
			title: 'Exportar grafo',
			defaultUri: root ? vscode.Uri.joinPath(root, `project-graph.${ext}`) : undefined,
			filters: ext === 'png' ? { 'Imagem PNG': ['png'] } : { 'Imagem SVG': ['svg'] },
		});
		if (!target) { return; }
		await vscode.workspace.fs.writeFile(target, bytes);
		vscode.window.showInformationMessage(`Docspace: grafo exportado para ${path.basename(target.fsPath)}.`);
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
				saved: this.savedState(),
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
    <button id="cycles" title="Detecta e destaca dependências circulares">Ciclos</button>
    <button id="path" title="Clique em dois arquivos para ver o caminho entre eles">Path</button>
    <label id="depth-wrap" class="depth hidden" title="Profundidade da propagação de impacto">
      Nível <input id="depth" type="range" min="0" max="5" step="1" value="0"> <span id="depth-val">todos</span>
    </label>
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
    <button id="clusters" title="Colapsa pastas com muitos arquivos num único nó">Clusters</button>
    <span class="spacer"></span>
    <span id="stats" class="stats"></span>
    <button id="minimap-toggle" class="active" title="Mostrar/ocultar o minimapa">Mapa</button>
    <button id="reset-layout" title="Limpar posições e cores manuais salvas">Reset</button>
    <button id="export-png" title="Exportar o grafo como PNG">PNG</button>
    <button id="export-svg" title="Exportar o grafo como SVG">SVG</button>
    <button id="fit" title="Ajustar à tela">Fit</button>
    <button id="refresh" title="Reconstruir o grafo">Refresh</button>
  </div>
  <div id="graph-wrap">
    <div id="cy" role="application" aria-label="Project dependency graph"></div>
    <div id="lanes" aria-hidden="true"></div>
    <div id="detail" class="detail hidden" aria-label="Detalhe da dependência"></div>
    <canvas id="minimap" class="minimap" width="200" height="140" aria-label="Minimapa do grafo"></canvas>
  </div>
  <div id="overlay" class="overlay"><div class="spinner"></div><span id="overlay-text">Building project graph…</span></div>
  <script src="https://cdn.jsdelivr.net/npm/cytoscape@${CYTOSCAPE_VERSION}/dist/cytoscape.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/layout-base@${LAYOUT_BASE_VERSION}/layout-base.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/cose-base@${COSE_BASE_VERSION}/cose-base.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/cytoscape-fcose@${FCOSE_VERSION}/cytoscape-fcose.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/cytoscape-svg@${CYTOSCAPE_SVG_VERSION}/cytoscape-svg.js"></script>
  <script src="${jsUri}"></script>
</body>
</html>`;
	}
}
