import * as vscode from 'vscode';
import { GENERATED_DIR, getExclude, workspaceRoot } from '../sidebar/config.js';
import { buildProjectGraph, GraphEdge, GraphNode, NodeRole, ProjectGraph } from './projectGraph.js';

const ROLE_LABELS: Record<NodeRole, string> = {
	entry: 'Pontos de entrada',
	controller: 'Controladores',
	service: 'Serviços',
	repository: 'Repositórios',
	model: 'Modelos',
	util: 'Utilitários',
	other: 'Outros',
	external: 'Externos',
};

const ROLE_ORDER: NodeRole[] = ['entry', 'controller', 'service', 'repository', 'model', 'util', 'other'];

const MAX_FLOW_DEPTH = 5;
const MAX_FLOWS = 12;

function header(title: string): string {
	const date = new Date().toLocaleString('pt-BR');
	return `# ${title}\n\n> Gerado automaticamente pelo Docspace em ${date}. Não edite — use o botão "Regenerar Doc".\n\n`;
}

function fileNodes(graph: ProjectGraph): GraphNode[] {
	return graph.nodes.filter((n) => n.data.type === 'file');
}

function importEdges(graph: ProjectGraph): GraphEdge[] {
	return graph.edges.filter((e) => e.data.type === 'imports');
}

function buildEstrutura(graph: ProjectGraph): string {
	let out = header('Estrutura do Projeto');
	const byRole = new Map<NodeRole, string[]>();
	for (const n of fileNodes(graph)) {
		const role = n.data.role ?? 'other';
		if (!byRole.has(role)) { byRole.set(role, []); }
		byRole.get(role)!.push(n.data.path ?? n.data.label);
	}
	for (const role of ROLE_ORDER) {
		const files = byRole.get(role);
		if (!files?.length) { continue; }
		out += `## ${ROLE_LABELS[role]}\n\n`;
		for (const f of files.sort()) { out += `- \`${f}\`\n`; }
		out += '\n';
	}
	return out;
}

function buildDependencias(graph: ProjectGraph): string {
	let out = header('Dependências por Arquivo');
	const bySource = new Map<string, { files: string[]; packages: string[] }>();
	for (const e of graph.edges) {
		const src = e.data.source.replace(/^file:/, '');
		if (!bySource.has(src)) { bySource.set(src, { files: [], packages: [] }); }
		const target = e.data.target;
		if (e.data.type === 'imports') {
			bySource.get(src)!.files.push(target.replace(/^file:/, ''));
		} else {
			bySource.get(src)!.packages.push(target.replace(/^module:/, ''));
		}
	}
	for (const src of [...bySource.keys()].sort()) {
		const { files, packages } = bySource.get(src)!;
		out += `## \`${src}\`\n\n`;
		for (const f of files.sort()) { out += `- \`${f}\`\n`; }
		for (const p of packages.sort()) { out += `- 📦 ${p}\n`; }
		out += '\n';
	}
	return out;
}

function buildAcoplamento(graph: ProjectGraph): string {
	let out = header('Ranking de Acoplamento');
	out += 'Arquivos ordenados por total de conexões (imports feitos + recebidos). Os primeiros são os mais sensíveis a mudanças.\n\n';
	const degree = new Map<string, { in: number; out: number }>();
	for (const e of importEdges(graph)) {
		const src = e.data.source.replace(/^file:/, '');
		const tgt = e.data.target.replace(/^file:/, '');
		degree.set(src, { in: degree.get(src)?.in ?? 0, out: (degree.get(src)?.out ?? 0) + 1 });
		degree.set(tgt, { in: (degree.get(tgt)?.in ?? 0) + 1, out: degree.get(tgt)?.out ?? 0 });
	}
	const ranked = [...degree.entries()]
		.map(([file, d]) => ({ file, ...d, total: d.in + d.out }))
		.sort((a, b) => b.total - a.total);
	out += '| # | Arquivo | Importa | Importado por | Total |\n|---|---|---|---|---|\n';
	ranked.forEach((r, i) => {
		out += `| ${i + 1} | \`${r.file}\` | ${r.out} | ${r.in} | ${r.total} |\n`;
	});
	return out + '\n';
}

function buildFluxos(graph: ProjectGraph): string {
	let out = header('Caminhos de Execução');
	const edges = importEdges(graph);
	const outgoing = new Map<string, string[]>();
	const hasIncoming = new Set<string>();
	for (const e of edges) {
		const src = e.data.source.replace(/^file:/, '');
		const tgt = e.data.target.replace(/^file:/, '');
		if (!outgoing.has(src)) { outgoing.set(src, []); }
		outgoing.get(src)!.push(tgt);
		hasIncoming.add(tgt);
	}
	const entries = fileNodes(graph)
		.map((n) => n.data.path ?? '')
		.filter((p) => p && !hasIncoming.has(p) && (outgoing.get(p)?.length ?? 0) > 0)
		.sort()
		.slice(0, MAX_FLOWS);

	if (entries.length === 0) {
		return out + '_Nenhum entry point com dependências encontrado._\n';
	}

	for (const entry of entries) {
		out += `## \`${entry}\`\n\n`;
		out += renderFlow(entry, outgoing, new Set(), 0);
		out += '\n';
	}
	return out;
}

function renderFlow(file: string, outgoing: Map<string, string[]>, seen: Set<string>, depth: number): string {
	const indent = '  '.repeat(depth);
	if (seen.has(file)) { return `${indent}- \`${file}\` _(ciclo)_\n`; }
	let out = `${indent}- \`${file}\`\n`;
	if (depth >= MAX_FLOW_DEPTH) { return out; }
	seen.add(file);
	for (const next of (outgoing.get(file) ?? []).sort()) {
		out += renderFlow(next, outgoing, seen, depth + 1);
	}
	seen.delete(file);
	return out;
}

// ── Structural snapshot + diff (no AI — pure data comparison) ─────────────────
interface Snapshot { files: string[]; couplings: string[] }
interface StructuralDiff {
	addedFiles: string[]; removedFiles: string[];
	addedCouplings: string[]; removedCouplings: string[];
}

function buildSnapshot(graph: ProjectGraph): Snapshot {
	const files = fileNodes(graph).map((n) => n.data.path ?? n.data.label).sort();
	const couplings = importEdges(graph)
		.map((e) => `${e.data.source.replace(/^file:/, '')} → ${e.data.target.replace(/^file:/, '')}`)
		.sort();
	return { files, couplings };
}

function diffSnapshots(prev: Snapshot | undefined, curr: Snapshot): StructuralDiff | undefined {
	if (!prev) { return undefined; }
	const minus = (a: string[], b: string[]) => { const s = new Set(b); return a.filter((x) => !s.has(x)); };
	return {
		addedFiles: minus(curr.files, prev.files),
		removedFiles: minus(prev.files, curr.files),
		addedCouplings: minus(curr.couplings, prev.couplings),
		removedCouplings: minus(prev.couplings, curr.couplings),
	};
}

const GENERATED_FILES = ['estrutura.md', 'dependencias.md', 'acoplamento.md', 'fluxos.md'];
const GENERATED_TITLES: Record<string, string> = {
	'estrutura.md': 'Estrutura de camadas e arquivos',
	'dependencias.md': 'Dependências por arquivo',
	'acoplamento.md': 'Ranking de acoplamento',
	'fluxos.md': 'Caminhos de execução',
};

function diffSection(diff: StructuralDiff | undefined): string {
	if (!diff) { return '## Diff estrutural\n\n_Primeira geração — sem base de comparação._\n\n'; }
	const unchanged = !diff.addedFiles.length && !diff.removedFiles.length
		&& !diff.addedCouplings.length && !diff.removedCouplings.length;
	if (unchanged) { return '## Diff estrutural\n\n_Nada mudou desde a última geração._\n\n'; }

	let out = '## Diff estrutural desde a última geração\n\n';
	const block = (title: string, items: string[], icon: string) => {
		if (!items.length) { return ''; }
		let s = `### ${title} (${items.length})\n\n`;
		for (const i of items) { s += `- ${icon} \`${i}\`\n`; }
		return s + '\n';
	};
	out += block('Arquivos adicionados', diff.addedFiles, '➕');
	out += block('Arquivos removidos', diff.removedFiles, '➖');
	out += block('Acoplamentos novos', diff.addedCouplings, '🔗');
	out += block('Acoplamentos removidos', diff.removedCouplings, '✂️');
	return out;
}

function buildIndex(graph: ProjectGraph, diff: StructuralDiff | undefined): string {
	let out = header('Documentação Gerada');
	out += `${fileNodes(graph).length} arquivos · ${importEdges(graph).length} dependências internas mapeadas.\n\n`;
	out += '## Documentos\n\n';
	for (const name of GENERATED_FILES) {
		out += `- [${GENERATED_TITLES[name]}](./${name})\n`;
	}
	out += '\n' + diffSection(diff);
	return out;
}

function snapshotKey(root: vscode.Uri): string {
	return `docspace.snapshot:${root.fsPath}`;
}

/**
 * Build the project graph and write the read-only generated docs into
 * `docGerada/` at the workspace root. Compares against the previous run's
 * snapshot (persisted in globalState) to emit a structural diff. Returns the
 * folder URI.
 */
export async function generateProjectDocs(context: vscode.ExtensionContext): Promise<vscode.Uri> {
	const root = workspaceRoot();
	if (!root) { throw new Error('Nenhum workspace aberto.'); }

	const roots = vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [root];
	const graph = await buildProjectGraph(roots, getExclude());
	const dir = vscode.Uri.joinPath(root, GENERATED_DIR);
	await vscode.workspace.fs.createDirectory(dir);

	const prev = context.globalState.get<Snapshot>(snapshotKey(root));
	const curr = buildSnapshot(graph);
	const diff = diffSnapshots(prev, curr);

	const docs: Array<[string, string]> = [
		['index.md', buildIndex(graph, diff)],
		['estrutura.md', buildEstrutura(graph)],
		['dependencias.md', buildDependencias(graph)],
		['acoplamento.md', buildAcoplamento(graph)],
		['fluxos.md', buildFluxos(graph)],
	];
	for (const [name, content] of docs) {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), Buffer.from(content, 'utf8'));
	}

	await context.globalState.update(snapshotKey(root), curr);
	return dir;
}
