import * as vscode from 'vscode';
import * as path from 'path';

export type GraphNodeType = 'file' | 'folder' | 'module';
export type GraphEdgeType = 'imports' | 'dependsOn';

export interface GraphNode {
	data: { id: string; label: string; type: GraphNodeType; path?: string; parent?: string };
}
export interface GraphEdge {
	data: { id: string; source: string; target: string; type: GraphEdgeType };
}
export interface ProjectGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const MAX_FILES = 1500;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];

const IMPORT_PATTERNS = [
	/import\s+[\w*{},\s$]+?from\s*['"]([^'"]+)['"]/g, // import x from '...'
	/import\s*['"]([^'"]+)['"]/g,                     // import '...' (side effect)
	/export\s+[\w*{},\s$]+?from\s*['"]([^'"]+)['"]/g, // export { x } from '...'
	/require\(\s*['"]([^'"]+)['"]\s*\)/g,             // require('...')
	/import\(\s*['"]([^'"]+)['"]\s*\)/g,              // import('...') dynamic
];

/** Extract unique import/require specifiers from JS/TS source. */
export function extractImports(source: string): string[] {
	const specs = new Set<string>();
	for (const pattern of IMPORT_PATTERNS) {
		const re = new RegExp(pattern.source, 'g');
		let match;
		while ((match = re.exec(source)) !== null) { specs.add(match[1]); }
	}
	return [...specs];
}

/**
 * Resolve a relative import specifier against the known project files.
 * Tries the spec as-is, TS↔JS extension swaps (Node16-style `./x.js` →
 * `x.ts` sources), common extensions, and index files.
 */
export function resolveImport(fromFile: string, spec: string, files: Set<string>): string | undefined {
	const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
	const variants = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.jsx$/, '.tsx')];
	for (const variant of variants) {
		for (const suffix of RESOLVE_SUFFIXES) {
			if (files.has(variant + suffix)) { return variant + suffix; }
		}
	}
	return undefined;
}

/** Bare specifier → package name: '@scope/pkg/sub' → '@scope/pkg', 'lodash/fp' → 'lodash'. */
export function packageName(spec: string): string {
	const parts = spec.split('/');
	return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isWalkableDir(name: string, exclude: string[]): boolean {
	return !exclude.includes(name) && !name.startsWith('.');
}

async function walkDir(dirUri: vscode.Uri, rel: string, exclude: string[], files: string[]): Promise<void> {
	if (files.length >= MAX_FILES) { return; }
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dirUri);
	} catch { /* unreadable directory */
		return;
	}
	for (const [name, type] of entries) {
		if (files.length >= MAX_FILES) { return; }
		const childRel = rel ? `${rel}/${name}` : name;
		if (type === vscode.FileType.Directory && isWalkableDir(name, exclude)) {
			await walkDir(vscode.Uri.joinPath(dirUri, name), childRel, exclude, files);
		} else if (type === vscode.FileType.File && CODE_FILE.test(name)) {
			files.push(childRel);
		}
	}
}

async function collectCodeFiles(rootUri: vscode.Uri, exclude: string[]): Promise<string[]> {
	const files: string[] = [];
	await walkDir(rootUri, '', exclude, files);
	return files;
}

function ensureFolderChain(rel: string, nodes: Map<string, GraphNode>): string {
	const id = `folder:${rel}`;
	if (!nodes.has(id)) {
		const parentRel = path.posix.dirname(rel);
		const parent = parentRel === '.' ? undefined : ensureFolderChain(parentRel, nodes);
		nodes.set(id, { data: { id, label: path.posix.basename(rel), type: 'folder', path: rel, parent } });
	}
	return id;
}

function addEdgeForSpec(
	file: string,
	spec: string,
	fileSet: Set<string>,
	nodes: Map<string, GraphNode>,
	edges: GraphEdge[],
	edgeIds: Set<string>,
): void {
	const source = `file:${file}`;
	if (spec.startsWith('.')) {
		const target = resolveImport(file, spec, fileSet);
		if (target && target !== file) {
			const id = `e:${file}->${target}`;
			if (!edgeIds.has(id)) {
				edgeIds.add(id);
				edges.push({ data: { id, source, target: `file:${target}`, type: 'imports' } });
			}
		}
		return;
	}
	const pkg = packageName(spec);
	const moduleId = `module:${pkg}`;
	if (!nodes.has(moduleId)) {
		nodes.set(moduleId, { data: { id: moduleId, label: pkg, type: 'module' } });
	}
	const id = `e:${file}->${pkg}`;
	if (!edgeIds.has(id)) {
		edgeIds.add(id);
		edges.push({ data: { id, source, target: moduleId, type: 'dependsOn' } });
	}
}

/**
 * Build the project graph: code files (and their folder chain as compound
 * parents), plus `imports` edges between project files and `dependsOn`
 * edges to external packages.
 */
export async function buildProjectGraph(rootUri: vscode.Uri, exclude: string[]): Promise<ProjectGraph> {
	const files = await collectCodeFiles(rootUri, exclude);
	const fileSet = new Set(files);
	const nodes = new Map<string, GraphNode>();
	const edges: GraphEdge[] = [];
	const edgeIds = new Set<string>();

	for (const file of files) {
		const dir = path.posix.dirname(file);
		const parent = dir === '.' ? undefined : ensureFolderChain(dir, nodes);
		nodes.set(`file:${file}`, {
			data: { id: `file:${file}`, label: path.posix.basename(file), type: 'file', path: file, parent },
		});
	}

	for (const file of files) {
		let text: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, file));
			text = Buffer.from(bytes).toString('utf8');
		} catch { /* unreadable file */
			continue;
		}
		for (const spec of extractImports(text)) {
			addEdgeForSpec(file, spec, fileSet, nodes, edges, edgeIds);
		}
	}

	return { nodes: [...nodes.values()], edges };
}
