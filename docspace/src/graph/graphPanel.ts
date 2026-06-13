import * as vscode from 'vscode';
import * as path from 'path';
import { configTarget, getExclude, workspaceRoot } from '../sidebar/config.js';
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
			vscode.l10n.t('Project Graph'),
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
				if (!m.path) { return; }
				const wsFolders = vscode.workspace.workspaceFolders ?? [];
				if (!wsFolders.length) { return; }
				if (wsFolders.length === 1) {
					await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(wsFolders[0].uri, m.path));
				} else {
					const folder = wsFolders.find(f => m.path!.startsWith(path.basename(f.uri.fsPath) + '/'));
					if (folder) {
						const rel = m.path.slice(path.basename(folder.uri.fsPath).length + 1);
						await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(folder.uri, rel));
					} else {
						await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(wsFolders[0].uri, m.path));
					}
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
			title: vscode.l10n.t('Export graph'),
			defaultUri: root ? vscode.Uri.joinPath(root, `project-graph.${ext}`) : undefined,
			filters: ext === 'png'
				? { [vscode.l10n.t('PNG image')]: ['png'] }
				: { [vscode.l10n.t('SVG image')]: ['svg'] },
		});
		if (!target) { return; }
		await vscode.workspace.fs.writeFile(target, bytes);
		vscode.window.showInformationMessage(vscode.l10n.t('Docspace: graph exported to {0}.', path.basename(target.fsPath)));
	}

	private async sendGraph(): Promise<void> {
		const wsFolders = vscode.workspace.workspaceFolders ?? [];
		if (!wsFolders.length) {
			await this.panel.webview.postMessage({ type: 'error', message: vscode.l10n.t('No workspace open.') });
			return;
		}
		try {
			const roots = wsFolders.map(f => f.uri);
			const graph = await buildProjectGraph(roots, getExclude());
			const rootName = wsFolders.length === 1
				? path.basename(wsFolders[0].uri.fsPath)
				: (vscode.workspace.name ?? 'workspace');
			await this.panel.webview.postMessage({
				type: 'graph',
				graph,
				theme: graphTheme(),
				saved: this.savedState(),
				rootName,
			});
		} catch (err) {
			await this.panel.webview.postMessage({
				type: 'error',
				message: vscode.l10n.t('Failed to build graph: {0}', err instanceof Error ? err.message : String(err)),
			});
		}
	}

	/** Build the localized strings object injected as window.L for graph.js. */
	private buildWindowL(): string {
		return JSON.stringify({
			laneEntry:      vscode.l10n.t('Entry points'),
			laneController: vscode.l10n.t('Controllers'),
			laneService:    vscode.l10n.t('Services'),
			laneRepository: vscode.l10n.t('Repositories'),
			laneModel:      vscode.l10n.t('Models'),
			laneUtil:       vscode.l10n.t('Utils'),
			laneOther:      vscode.l10n.t('Other'),
			laneExternal:   vscode.l10n.t('External'),
			statsFormat:    vscode.l10n.t('{0} files · {1} modules · {2} connections'),
			trailStat:      vscode.l10n.t('Trail of {0}: {1} files'),
			impactStat:     vscode.l10n.t('{0} file(s) affected by changes in {1}'),
			noClusters:     vscode.l10n.t('No folder with {0}+ files to cluster'),
			rebuilding:     vscode.l10n.t('Rebuilding project graph…'),
			renderError:    vscode.l10n.t('Error rendering graph: {0}'),
			noImportDetail: vscode.l10n.t('no import detail'),
			detailClose:    vscode.l10n.t('Close'),
			colorRemove:    vscode.l10n.t('remove'),
			paintLabels: {
				'#f7768e': vscode.l10n.t('do not touch'),
				'#e0af68': vscode.l10n.t('tech debt'),
				'#9ece6a': vscode.l10n.t('ok'),
				'#7aa2f7': vscode.l10n.t('review'),
				'#bb9af7': vscode.l10n.t('refactor'),
				'#6b7089': vscode.l10n.t('neutral'),
			},
		});
	}

	private buildHtml(): string {
		const webview = this.panel.webview;
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph.css'));
		const jsUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'graph.js'));

		const t = (s: string) => vscode.l10n.t(s);
		const tp = (s: string, p: string) => vscode.l10n.t(s, p);

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource} https://cdn.jsdelivr.net; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${cssUri}">
  <title>${t('Project Graph')}</title>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-row">
      <div class="segmented" role="group" aria-label="${t('Graph mode')}">
        <button id="mode-deps" class="active" title="${t('Network of imports between files')}">${t('Dependencies')}</button>
        <button id="mode-flow" title="${t('Top-down layers by detected role')}">${t('Flow')}</button>
        <button id="mode-impact" title="${t('Click a file to see what would be affected')}">${t('Impact')}</button>
      </div>
      <input id="search" type="search" placeholder="${t('Search file… (Enter zooms)')}" aria-label="${t('Search nodes')}">
      <span id="stats" class="stats"></span>
      <button id="fit" title="${t('Fit to screen')}">Fit</button>
      <button id="refresh" title="${t('Rebuild the graph')}">Refresh</button>
    </div>
    <div class="toolbar-row toolbar-filters">
      <select id="folder-filter" aria-label="${t('Filter by folder')}">
        <option value="">${t('All folders')}</option>
      </select>
      <select id="type-filter" aria-label="${t('Filter by type')}">
        <option value="all">${t('Files + modules')}</option>
        <option value="files">${t('Files only')}</option>
      </select>
      <label class="check" title="${t('Hide .test. / .spec. files')}">
        <input id="hide-tests" type="checkbox"> ${t('no tests')}
      </label>
      <select id="theme-select" aria-label="${t('Graph theme')}" title="${t('Graph theme')}">
        <option value="auto">${tp('Theme: {0}', 'auto')}</option>
        <option value="obsidian">${tp('Theme: {0}', 'obsidian')}</option>
        <option value="blueprint">${tp('Theme: {0}', 'blueprint')}</option>
        <option value="pastel">${tp('Theme: {0}', 'pastel')}</option>
        <option value="high-contrast">${tp('Theme: {0}', 'high-contrast')}</option>
      </select>
      <button id="clusters" title="${t('Collapse folders into cluster nodes')}">Clusters</button>
      <span class="spacer"></span>
      <button id="minimap-toggle" class="active" title="${t('Show/hide minimap')}">${t('Map')}</button>
      <button id="reset-layout" title="${t('Clear saved positions and colors')}">Reset</button>
      <button id="export-png" title="${t('Export graph as PNG')}">PNG</button>
      <button id="export-svg" title="${t('Export graph as SVG')}">SVG</button>
    </div>
  </div>
  <div id="graph-wrap">
    <div id="cy" role="application" aria-label="${t('Project dependency graph')}"></div>
    <div id="lanes" aria-hidden="true"></div>
    <div id="detail" class="detail hidden" aria-label="${t('Dependency detail')}"></div>
    <canvas id="minimap" class="minimap" width="200" height="140" aria-label="${t('Graph minimap')}"></canvas>
  </div>
  <div id="overlay" class="overlay"><div class="spinner"></div><span id="overlay-text">${t('Building project graph…')}</span></div>
  <script>window.L = ${this.buildWindowL()};</script>
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
