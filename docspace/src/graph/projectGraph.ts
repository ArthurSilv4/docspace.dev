import * as vscode from 'vscode';
import * as path from 'path';

export type GraphNodeType = 'file' | 'folder' | 'module';
export type GraphEdgeType = 'imports' | 'dependsOn';

/** Architectural layer detected from the file name/path (swimlanes in Flow mode). */
export type NodeRole = 'entry' | 'controller' | 'service' | 'repository' | 'model' | 'util' | 'other' | 'external';

export interface GraphNode {
	data: {
		id: string; label: string; type: GraphNodeType;
		path?: string; parent?: string; role?: NodeRole; isTest?: boolean;
	};
}
export interface GraphEdge {
	data: {
		id: string; source: string; target: string; type: GraphEdgeType;
		weight: number; specs: string[];
	};
}
export interface ProjectGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];

const CODE_LANGUAGES = new Set([
	'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
	'csharp', 'python', 'go', 'rust', 'java', 'cpp', 'c', 'ruby', 'php', 'swift', 'kotlin',
]);

/** Folders excluded from the graph walk in addition to docspace.exclude. */
const EXTRA_EXCLUDE = ['bin', 'obj', '.vs', '__pycache__', '.venv', 'vendor'];

const JS_PATTERNS: RegExp[] = [
	/import\s+[\w*{},\s$]+?from\s*['"]([^'"]+)['"]/g,
	/import\s*['"]([^'"]+)['"]/g,
	/export\s+[\w*{},\s$]+?from\s*['"]([^'"]+)['"]/g,
	/require\(\s*['"]([^'"]+)['"]\s*\)/g,
	/import\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const LANG_PATTERNS: Record<string, RegExp[]> = {
	typescript:      JS_PATTERNS,
	javascript:      JS_PATTERNS,
	typescriptreact: JS_PATTERNS,
	javascriptreact: JS_PATTERNS,
	csharp: [
		/^\s*using\s+([\w.]+)\s*;/gm,
		/ProjectReference\s+Include="([^"]+)"/g,
	],
	python: [
		/^\s*import\s+([\w.]+)/gm,
		/^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import/gm,
	],
	go: [
		/import\s+"([^"]+)"/g,
		/^\t"([a-zA-Z0-9._/\-@]+)"/gm,
	],
};

/** Extract unique import specifiers from source using language-appropriate patterns. */
export function extractImports(source: string, languageId = 'typescript'): string[] {
	const patterns = LANG_PATTERNS[languageId] ?? JS_PATTERNS;
	const specs = new Set<string>();
	for (const pattern of patterns) {
		const flags = 'g' + (pattern.flags.includes('m') ? 'm' : '');
		const re = new RegExp(pattern.source, flags);
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

const ROLE_PATTERNS: Array<[RegExp, NodeRole]> = [
	[/(^|\/)(main|index|app|program|extension|server)\.[^/]+$/i, 'entry'],
	[/controller|handler|route|endpoint/i, 'controller'],
	[/service|usecase|use-case|manager|provider/i, 'service'],
	[/repositor|\brepo\b|dao|store|database|\bdb\b/i, 'repository'],
	[/model|entity|schema|dto|types?\./i, 'model'],
	[/util|helper|\blib\b|common|shared|config|constant/i, 'util'],
];

/** Detect the architectural layer of a file from its workspace-relative path. */
export function detectRole(relPath: string): NodeRole {
	for (const [pattern, role] of ROLE_PATTERNS) {
		if (pattern.test(relPath)) { return role; }
	}
	return 'other';
}

export function isTestFile(relPath: string): boolean {
	return /\.(test|spec)\.[^/.]+$/i.test(relPath) || /(^|\/)(tests?|__tests__|specs?)\//i.test(relPath);
}

// ── Cache layer 1: per-file import cache, validated by mtime ──────────────────
interface ImportCacheEntry { mtime: number; imports: string[]; langId: string }
const fileImportCache = new Map<string, ImportCacheEntry>();

// ── Cache layer 2: full graph cache, keyed by sorted fsPath:mtime fingerprint ─
let graphCache: { key: string; graph: ProjectGraph } | null = null;

/** Drop cache entries for `uri` and invalidate the full graph cache. */
export function invalidateGraphFile(uri: vscode.Uri): void {
	fileImportCache.delete(uri.fsPath);
	graphCache = null;
}

/** Fast extension → languageId map; avoids opening documents for common cases. */
const EXT_LANG: Record<string, string> = {
	'.ts': 'typescript',   '.tsx': 'typescriptreact',
	'.js': 'javascript',   '.jsx': 'javascriptreact',
	'.mjs': 'javascript',  '.cjs': 'javascript',
	'.cs': 'csharp',
	'.py': 'python',
	'.go': 'go',
	'.rs': 'rust',
	'.java': 'java',
	'.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
	'.c': 'c', '.h': 'c',
	'.rb': 'ruby',
	'.php': 'php',
	'.swift': 'swift',
	'.kt': 'kotlin', '.kts': 'kotlin',
};

function langIdFor(uri: vscode.Uri): string {
	const ext = path.extname(uri.fsPath).toLowerCase();
	return EXT_LANG[ext] ?? 'plaintext';
}

interface CollectedFile { wsRel: string; relToRoot: string; langId: string; rootUri: vscode.Uri }

async function collectCodeFiles(
	roots: vscode.Uri[],
	exclude: string[],
): Promise<CollectedFile[]> {
	const multiRoot = roots.length > 1;
	const allExclude = [...new Set([...exclude, ...EXTRA_EXCLUDE])];
	const excludeParts = allExclude.map((e) => `**/${e}/**`).concat(['**/.*/**']);
	const excludeGlob = `{${excludeParts.join(',')}}`;

	const results: CollectedFile[] = [];
	for (const rootUri of roots) {
		const rootName = path.basename(rootUri.fsPath);
		const rootFsPath = rootUri.fsPath;
		const pattern = new vscode.RelativePattern(rootUri, '**/*');
		const uris = await vscode.workspace.findFiles(pattern, excludeGlob);

		for (const uri of uris) {
			const langId = langIdFor(uri);
			if (!CODE_LANGUAGES.has(langId)) { continue; }
			const relToRoot = uri.fsPath.slice(rootFsPath.length + 1).split(path.sep).join('/');
			const wsRel = multiRoot ? `${rootName}/${relToRoot}` : relToRoot;
			results.push({ wsRel, relToRoot, langId, rootUri });
		}
	}
	return results;
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

/**
 * Add or strengthen an edge: repeated imports between a pair raise its weight
 * and record the specifier (shown in the webview's edge-detail panel).
 */
function upsertEdge(
	edges: Map<string, GraphEdge>,
	id: string,
	source: string,
	target: string,
	type: GraphEdgeType,
	spec: string,
): void {
	const existing = edges.get(id);
	if (existing) {
		existing.data.weight += 1;
		if (!existing.data.specs.includes(spec)) { existing.data.specs.push(spec); }
	} else {
		edges.set(id, { data: { id, source, target, type, weight: 1, specs: [spec] } });
	}
}

function addEdgeForSpec(
	file: string,
	spec: string,
	fileSet: Set<string>,
	nodes: Map<string, GraphNode>,
	edges: Map<string, GraphEdge>,
): void {
	const source = `file:${file}`;
	if (spec.startsWith('.')) {
		const target = resolveImport(file, spec, fileSet);
		if (target && target !== file) {
			upsertEdge(edges, `e:${file}->${target}`, source, `file:${target}`, 'imports', spec);
		}
		return;
	}
	// Namespace-style specs (e.g. C# `System.IO`, Python `os.path`) have no `/`
	// and contain an internal `.` — they are not meaningful as module nodes.
	if (!spec.includes('/') && /\./.test(spec)) { return; }
	const pkg = packageName(spec);
	const moduleId = `module:${pkg}`;
	if (!nodes.has(moduleId)) {
		nodes.set(moduleId, { data: { id: moduleId, label: pkg, type: 'module', role: 'external' } });
	}
	upsertEdge(edges, `e:${file}->${pkg}`, source, moduleId, 'dependsOn', spec);
}

interface FileEntry { rel: string; langId: string; uri: vscode.Uri; mtime: number }

/** Layer 1 cache: return cached imports for a file or read + parse + cache. */
async function resolveImportsForFile({ rel, langId, uri, mtime }: FileEntry): Promise<string[]> {
	const cached = mtime >= 0 ? fileImportCache.get(uri.fsPath) : undefined;
	if (cached && cached.mtime === mtime) { return cached.imports; }
	let text: string;
	try {
		text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
	} catch {
		return [];
	}
	const imports = extractImports(text, langId);
	if (mtime >= 0) { fileImportCache.set(uri.fsPath, { mtime, imports, langId }); }
	return imports;
}

/**
 * Build the project graph: code files (and their folder chain as compound
 * parents), plus `imports` edges between project files and `dependsOn`
 * edges to external packages.
 *
 * Two cache layers avoid redundant work on repeated calls:
 *   Layer 1 — per-file import cache validated by mtime (skips re-parsing unchanged files).
 *   Layer 2 — full graph cache keyed by all fsPath:mtime pairs (returns instantly when nothing changed).
 */
export async function buildProjectGraph(rootUris: vscode.Uri | vscode.Uri[], exclude: string[]): Promise<ProjectGraph> {
	const roots = Array.isArray(rootUris) ? rootUris : [rootUris];
	const collected = await collectCodeFiles(roots, exclude);

	// Stat all files once — feeds both cache layers
	const fileEntries = await Promise.all(
		collected.map(async ({ wsRel, relToRoot, langId, rootUri }) => {
			const uri = vscode.Uri.joinPath(rootUri, relToRoot);
			let mtime = -1;
			try { mtime = (await vscode.workspace.fs.stat(uri)).mtime; } catch { /* keep -1 */ }
			return { rel: wsRel, langId, uri, mtime };
		})
	);

	// Layer 2: if every file's mtime matches, return the cached graph immediately
	const cacheKey = fileEntries
		.map(({ uri, mtime }) => `${uri.fsPath}:${mtime}`)
		.sort()
		.join('|');
	if (graphCache?.key === cacheKey) { return graphCache.graph; }

	const files = fileEntries.map((e) => e.rel);
	const fileSet = new Set(files);
	const nodes = new Map<string, GraphNode>();
	const edges = new Map<string, GraphEdge>();

	for (const file of files) {
		const dir = path.posix.dirname(file);
		const parent = dir === '.' ? undefined : ensureFolderChain(dir, nodes);
		nodes.set(`file:${file}`, {
			data: {
				id: `file:${file}`, label: path.posix.basename(file), type: 'file', path: file, parent,
				role: detectRole(file), isTest: isTestFile(file),
			},
		});
	}

	for (const entry of fileEntries) {
		const imports = await resolveImportsForFile(entry);
		for (const spec of imports) {
			addEdgeForSpec(entry.rel, spec, fileSet, nodes, edges);
		}
	}

	const graph: ProjectGraph = { nodes: [...nodes.values()], edges: [...edges.values()] };
	graphCache = { key: cacheKey, graph };
	return graph;
}
