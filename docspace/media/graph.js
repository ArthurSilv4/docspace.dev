/* global cytoscape, acquireVsCodeApi */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	// cytoscape-svg self-registers a cy.svg() method when used
	if (window.cytoscapeSvg) { cytoscape.use(window.cytoscapeSvg); }

	const cyEl = document.getElementById('cy');
	const lanesEl = document.getElementById('lanes');
	const searchEl = document.getElementById('search');
	const folderSel = document.getElementById('folder-filter');
	const typeSel = document.getElementById('type-filter');
	const hideTestsEl = document.getElementById('hide-tests');
	const themeSel = document.getElementById('theme-select');
	const statsEl = document.getElementById('stats');
	const overlayEl = document.getElementById('overlay');
	const overlayText = document.getElementById('overlay-text');

	let cy = null;
	let mode = 'deps'; // 'deps' (force) | 'flow' (swimlanes top→down) | 'impact' (click → affected)
	let themeName = 'auto';
	let currentGraph = null;
	let laneMeta = []; // [{ name, y }] for the Flow overlay
	let baseStats = '';
	let cyclesOn = false;     // cycle highlight toggle
	let pathPick = null;      // first node picked for path-between-two, or null
	let impactDepth = 0;      // 0 = todos os níveis; else cap predecessor depth
	// Manual layout + colors persisted per workspace (round-tripped to the extension)
	let savedState = { positions: {}, colors: {} };
	let persistTimer = null;
	let collapsedFolders = new Set(); // top folders aggregated into cluster nodes
	let minimapOn = true;

	const CLUSTER_MIN = 6; // a top folder needs this many files to be collapsible
	const minimapEl = document.getElementById('minimap');

	const detailEl = document.getElementById('detail');
	const depthWrap = document.getElementById('depth-wrap');
	const depthEl = document.getElementById('depth');
	const depthVal = document.getElementById('depth-val');

	// ── Themes ──────────────────────────────────────────────────────────────────
	const THEMES = {
		obsidian: {
			bg: '#1e1e2e', fg: '#9a9fb0', edge: '#4a4f63', module: '#6b7089', accent: '#7aa2f7',
			palette: ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#2ac3de', '#ff9e64', '#73daca'],
		},
		blueprint: {
			bg: '#0b1d33', fg: '#bcd6f2', edge: '#3f6c9e', module: '#5a82ab', accent: '#ffffff',
			palette: ['#9fc6ff', '#7fb3f5', '#bfe0ff', '#dcecff', '#6fa8e8', '#8ec9f2', '#a8d8ff', '#cfe6ff'],
		},
		pastel: {
			bg: '#faf7f2', fg: '#6a655e', edge: '#c9c2b8', module: '#a8a299', accent: '#e07a5f',
			palette: ['#7eb5a6', '#e8a0a0', '#a0b8e8', '#d8b86e', '#b89fd8', '#88c5d8', '#e8b58e', '#9fcf9f'],
		},
		'high-contrast': {
			bg: '#000000', fg: '#ffffff', edge: '#666666', module: '#999999', accent: '#ffffff',
			palette: ['#00e5ff', '#ffe600', '#ff3d71', '#00ff9c', '#ff8a00', '#c77dff', '#00b3ff', '#aaff00'],
		},
	};

	function cssVar(name, fallback) {
		// cytoscape rejects quoted font names, so strip quotes from the value
		const value = getComputedStyle(document.body).getPropertyValue(name).trim().replace(/['"]/g, '');
		return value || fallback;
	}

	/** 'auto' follows the VS Code theme: editor colors + a matching palette. */
	function resolveTheme(name) {
		if (THEMES[name]) { return THEMES[name]; }
		const light = document.body.classList.contains('vscode-light');
		const base = light ? THEMES.pastel : THEMES.obsidian;
		return {
			...base,
			bg: cssVar('--vscode-editor-background', base.bg),
			fg: cssVar('--vscode-descriptionForeground', base.fg),
			edge: cssVar('--vscode-editorLineNumber-foreground', base.edge),
			accent: cssVar('--vscode-focusBorder', base.accent),
		};
	}

	function theme() { return resolveTheme(themeName); }

	// ── Elements ────────────────────────────────────────────────────────────────
	function topFolder(p) {
		return p && p.includes('/') ? p.slice(0, p.indexOf('/')) : '';
	}

	function toElements(graph) {
		const t = theme();
		const groupColor = new Map();
		const colorFor = (group) => {
			if (!groupColor.has(group)) {
				groupColor.set(group, t.palette[groupColor.size % t.palette.length]);
			}
			return groupColor.get(group);
		};

		const degree = new Map();
		for (const e of graph.edges) {
			degree.set(e.data.source, (degree.get(e.data.source) || 0) + 1);
			degree.set(e.data.target, (degree.get(e.data.target) || 0) + 1);
		}
		const maxDegree = Math.max(1, ...degree.values());

		const nodes = graph.nodes
			.filter((n) => n.data.type !== 'folder')
			.map((n) => {
				const deg = degree.get(n.data.id) || 0;
				const baseColor = n.data.type === 'module' ? t.module : colorFor(topFolder(n.data.path));
				return { data: {
					id: n.data.id,
					label: n.data.label,
					type: n.data.type,
					path: n.data.path,
					role: n.data.role || (n.data.type === 'module' ? 'external' : 'other'),
					isTest: n.data.isTest ? 1 : 0,
					size: 9 + 24 * Math.sqrt(deg / maxDegree),
					// manual paint (savedState) overrides the computed folder color
					color: savedState.colors[n.data.id] || baseColor,
					baseColor,
				} };
			});

		return { nodes, edges: graph.edges.map((e) => ({ data: e.data })) };
	}

	/**
	 * Collapse each folder in `collapsedFolders`: its file nodes become one
	 * `cluster` node and edges are rerouted to it (self-edges dropped, parallels
	 * merged). Returns the raw graph untouched when nothing is collapsed.
	 */
	function clusterGraph(graph) {
		if (!collapsedFolders.size) { return graph; }
		const idMap = new Map();
		const clusters = new Map();
		for (const n of graph.nodes) {
			if (n.data.type !== 'file') { continue; }
			const tf = topFolder(n.data.path);
			if (!collapsedFolders.has(tf)) { continue; }
			const cid = `cluster:${tf}`;
			idMap.set(n.data.id, cid);
			if (!clusters.has(cid)) {
				clusters.set(cid, { data: { id: cid, label: tf, type: 'cluster', path: `${tf}/`, role: 'other', count: 0 } });
			}
			clusters.get(cid).data.count++;
		}

		const nodes = graph.nodes.filter((n) => !idMap.has(n.data.id));
		for (const c of clusters.values()) {
			c.data.label = `${c.data.path} (${c.data.count})`;
			nodes.push(c);
		}

		const edgeMap = new Map();
		for (const e of graph.edges) {
			const s = idMap.get(e.data.source) || e.data.source;
			const t = idMap.get(e.data.target) || e.data.target;
			if (s === t) { continue; }
			const id = `e:${s}->${t}`;
			const ex = edgeMap.get(id);
			if (ex) {
				ex.data.weight += e.data.weight;
				ex.data.specs = ex.data.specs.concat(e.data.specs || []);
			} else {
				edgeMap.set(id, { data: { id, source: s, target: t, type: e.data.type, weight: e.data.weight, specs: [...(e.data.specs || [])] } });
			}
		}
		return { nodes, edges: [...edgeMap.values()] };
	}

	/** Top folders with enough files to be worth collapsing. */
	function collapsibleFolders(graph) {
		const counts = new Map();
		for (const n of graph.nodes) {
			if (n.data.type !== 'file') { continue; }
			const tf = topFolder(n.data.path);
			if (tf) { counts.set(tf, (counts.get(tf) || 0) + 1); }
		}
		return [...counts.entries()].filter(([, c]) => c >= CLUSTER_MIN).map(([f]) => f);
	}

	// ── Style ───────────────────────────────────────────────────────────────────
	function edgeWidth(ele) {
		const w = ele.data('weight') || 1;
		return Math.min(1 + (w - 1) * 0.8, 4);
	}

	function buildStyle() {
		const t = theme();
		return [
			{ selector: 'node', style: {
				width: 'data(size)', height: 'data(size)',
				'background-color': 'data(color)',
				'background-opacity': 0.92,
				'border-width': 0,
				label: 'data(label)',
				color: t.fg,
				'font-family': cssVar('--vscode-font-family', 'sans-serif'),
				'font-size': 9,
				'text-valign': 'bottom', 'text-halign': 'center',
				'text-margin-y': 5,
				'text-opacity': 0.8,
				'min-zoomed-font-size': 8,
				'transition-property': 'opacity, background-opacity, text-opacity',
				'transition-duration': '120ms',
			} },
			{ selector: 'node[type="module"]', style: {
				'background-opacity': 0.5,
				'text-opacity': 0.55,
			} },
			// Collapsed folder cluster — a chunky rounded square you tap to expand
			{ selector: 'node[type="cluster"]', style: {
				shape: 'round-rectangle',
				width: 'data(size)', height: 'data(size)',
				'background-opacity': 0.85,
				'border-width': 2,
				'border-color': t.fg,
				'border-opacity': 0.4,
				'text-opacity': 1,
				'font-weight': 'bold',
			} },
			// Entry points: no one imports them — emphasized ring in every mode
			{ selector: 'node.entry', style: {
				'border-width': 2.5,
				'border-color': t.accent,
				'border-opacity': 0.9,
			} },
			// Flow mode: pill-shaped nodes with the label inside
			{ selector: 'node.flow-node', style: {
				shape: 'round-rectangle',
				width: 'label',
				height: 28,
				padding: '0 12px',
				'background-color': 'data(color)',
				'background-opacity': 0.18,
				'border-width': 1.5,
				'border-color': 'data(color)',
				'border-opacity': 0.85,
				label: 'data(label)',
				color: t.fg,
				'font-size': 11,
				'text-valign': 'center',
				'text-halign': 'center',
				'text-opacity': 1,
				// long filenames get ellipsized; keep in sync with MAX_PILL_W
				'text-wrap': 'ellipsis',
				'text-max-width': 168,
				'min-zoomed-font-size': 7,
			} },
			{ selector: 'node.flow-node[type="module"]', style: {
				'background-opacity': 0.08,
				'border-style': 'dashed',
				'font-size': 10,
			} },
			{ selector: 'edge', style: {
				width: edgeWidth,
				'curve-style': 'haystack', 'haystack-radius': 0,
				'line-color': t.edge,
				opacity: 0.32,
				'transition-property': 'opacity',
				'transition-duration': '120ms',
			} },
			{ selector: 'edge[type="dependsOn"]', style: { 'line-style': 'dashed', opacity: 0.2 } },
			// Flow view: direction matters, so edges get arrows (haystack can't draw them)
			{ selector: 'edge.flow', style: {
				'curve-style': 'bezier',
				'control-point-step-size': 28,
				'target-arrow-shape': 'triangle',
				'target-arrow-color': t.edge,
				'line-color': t.edge,
				'arrow-scale': 0.8,
				width: edgeWidth,
				// quieter than the focused trail so the structure reads first
				opacity: 0.3,
			} },
			{ selector: 'edge.flow[type="dependsOn"]', style: { opacity: 0.14 } },
			// Execution trail from a clicked entry point (Flow mode)
			{ selector: 'edge.trail', style: {
				'line-color': t.accent, 'target-arrow-color': t.accent, opacity: 0.95, 'z-index': 9,
			} },
			{ selector: 'node.trail', style: {
				'background-opacity': 1, 'text-opacity': 1,
				'border-width': 2, 'border-color': t.accent,
			} },
			// Impact mode: source + everything that would be affected
			{ selector: 'node.impact-src', style: {
				'background-opacity': 1, 'text-opacity': 1,
				'border-width': 3, 'border-color': t.accent,
			} },
			{ selector: 'node.impact-hit', style: {
				'background-opacity': 1, 'text-opacity': 1,
				'border-width': 1.5, 'border-color': t.accent, 'border-opacity': 0.6,
			} },
			{ selector: 'edge.impact-hit', style: {
				'line-color': t.accent, opacity: 0.8,
			} },
			// Circular dependencies (Detectar ciclos)
			{ selector: 'node.cycle', style: {
				'background-opacity': 1, 'text-opacity': 1,
				'border-width': 2.5, 'border-color': '#f7768e',
			} },
			{ selector: 'edge.cycle', style: {
				'line-color': '#f7768e', 'target-arrow-color': '#f7768e',
				width: 2.5, opacity: 0.95, 'z-index': 10,
			} },
			// Shortest path between two picked files
			{ selector: '.path-hit', style: {
				'background-opacity': 1, 'text-opacity': 1,
				'line-color': '#e0af68', 'target-arrow-color': '#e0af68',
				'border-width': 2.5, 'border-color': '#e0af68',
				width: 3, opacity: 1, 'z-index': 11,
			} },
			{ selector: 'node.path-end', style: {
				'border-width': 3.5, 'border-color': '#e0af68',
			} },
			// Edge selected for the detail panel
			{ selector: 'edge.edge-sel', style: {
				'line-color': t.accent, 'target-arrow-color': t.accent,
				width: 3, opacity: 1, 'z-index': 12,
			} },
			{ selector: 'node:selected', style: {
				'border-width': 2.5, 'border-color': t.accent, 'text-opacity': 1,
			} },
			{ selector: '.search-hit', style: {
				'border-width': 2.5, 'border-color': t.accent, 'text-opacity': 1,
			} },
			{ selector: 'node.hl', style: { 'background-opacity': 1, 'text-opacity': 1 } },
			{ selector: 'edge.hl', style: { opacity: 0.85 } },
			{ selector: '.dim', style: { opacity: 0.08 } },
			{ selector: '.hidden', style: { display: 'none' } },
		];
	}

	function applyTheme(name) {
		themeName = name;
		themeSel.value = name;
		const t = theme();
		cyEl.style.background = t.bg;
		lanesEl.style.color = t.fg;
		if (currentGraph) { render(currentGraph); }
	}

	// ── Layout ──────────────────────────────────────────────────────────────────
	const LANES = ['entry', 'controller', 'service', 'repository', 'model', 'util', 'other', 'external'];
	const LANE_LABELS = {
		entry: 'Entry points', controller: 'Controllers', service: 'Services',
		repository: 'Repositories', model: 'Models', util: 'Utils', other: 'Outros', external: 'Externos',
	};
	const ROW_H = 58;        // vertical distance between sub-rows inside a lane
	const LANE_PAD = 34;     // band padding above/below the rows
	const LANE_GAP = 26;     // gap between consecutive bands
	const NODE_GAP = 26;     // horizontal gap between pills
	const MAX_ROW_W = 1050;  // wrap a lane into sub-rows beyond this width
	const MAX_PILL_W = 168;  // must mirror text-max-width in the flow-node style

	function laneOf(node) {
		if (node.data('type') === 'module') { return 'external'; }
		if (node.hasClass('entry')) { return 'entry'; }
		return node.data('role') || 'other';
	}

	/** Approximate rendered pill width so rows can be packed without overlap. */
	function pillWidth(node) {
		return Math.min(28 + node.data('label').length * 6.4, MAX_PILL_W + 28);
	}

	/**
	 * Order a lane by the average x of already-placed neighbors (barycenter):
	 * nodes land underneath whoever imports them, minimizing edge crossings.
	 */
	function orderLane(nodes, placedX) {
		const score = (n) => {
			const xs = [];
			n.connectedEdges().forEach((e) => {
				const other = e.source().id() === n.id() ? e.target() : e.source();
				if (placedX.has(other.id())) { xs.push(placedX.get(other.id())); }
			});
			return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
		};
		return nodes
			.map((n) => ({ n, s: score(n) }))
			.sort((a, b) => {
				if (a.s !== null && b.s !== null && a.s !== b.s) { return a.s - b.s; }
				if (a.s !== null && b.s === null) { return -1; }
				if (a.s === null && b.s !== null) { return 1; }
				return a.n.data('label').localeCompare(b.n.data('label'));
			})
			.map((x) => x.n);
	}

	/** Pack ordered nodes into centered sub-rows no wider than MAX_ROW_W. */
	function packRows(nodes) {
		const rows = [];
		let row = [];
		let width = 0;
		for (const n of nodes) {
			const w = pillWidth(n) + NODE_GAP;
			if (row.length > 0 && width + w > MAX_ROW_W) {
				rows.push(row);
				row = [];
				width = 0;
			}
			row.push(n);
			width += w;
		}
		if (row.length) { rows.push(row); }
		return rows;
	}

	/**
	 * Fixed horizontal swimlanes: one band per detected role. Lanes are laid
	 * out top→down; within a lane, nodes sit near their importers (barycenter)
	 * and wrap into sub-rows so wide projects stay readable.
	 */
	function flowLayoutData() {
		const visible = cy.nodes().not('.hidden');
		const byLane = new Map();
		visible.forEach((n) => {
			const lane = laneOf(n);
			if (!byLane.has(lane)) { byLane.set(lane, []); }
			byLane.get(lane).push(n);
		});

		const positions = {};
		const placedX = new Map();
		laneMeta = [];
		let laneTop = 0;

		for (const lane of LANES.filter((l) => byLane.has(l))) {
			const ordered = orderLane(byLane.get(lane), placedX);
			const rows = packRows(ordered);

			rows.forEach((row, r) => {
				const rowWidth = row.reduce((sum, n) => sum + pillWidth(n) + NODE_GAP, -NODE_GAP);
				let x = -rowWidth / 2;
				for (const n of row) {
					const w = pillWidth(n);
					positions[n.id()] = { x: x + w / 2, y: laneTop + r * ROW_H };
					placedX.set(n.id(), x + w / 2);
					x += w + NODE_GAP;
				}
			});

			const bandTop = laneTop - LANE_PAD;
			const bandHeight = (rows.length - 1) * ROW_H + 2 * LANE_PAD;
			laneMeta.push({ name: lane, top: bandTop, height: bandHeight });
			laneTop = bandTop + bandHeight + LANE_GAP + LANE_PAD;
		}
		return positions;
	}

	function layoutOptions() {
		if (mode === 'flow') {
			const positions = flowLayoutData();
			return {
				name: 'preset',
				positions: (n) => positions[n.id()] || { x: 0, y: 0 },
				animate: true, animationDuration: 450, padding: 60, fit: true,
			};
		}
		const fcose = typeof window.cytoscapeFcose !== 'undefined';
		return fcose
			? { name: 'fcose', quality: 'proof', randomize: true, animate: true, animationDuration: 600,
				nodeRepulsion: 12000, idealEdgeLength: 75, gravity: 0.3, gravityRange: 2.5, padding: 50,
				tile: true, tilingPaddingVertical: 40, tilingPaddingHorizontal: 40 }
			: { name: 'cose', animate: false, padding: 50, nodeRepulsion: 12000, idealEdgeLength: 80 };
	}

	// ── Flow lane overlay ───────────────────────────────────────────────────────
	function updateLaneOverlay() {
		if (mode !== 'flow' || !cy) {
			lanesEl.innerHTML = '';
			return;
		}
		const zoom = cy.zoom();
		const pan = cy.pan();
		lanesEl.innerHTML = '';
		laneMeta.forEach(({ name, top, height }, i) => {
			const screenTop = top * zoom + pan.y;
			const screenHeight = height * zoom;
			if (screenTop + screenHeight < 0 || screenTop > cyEl.clientHeight) { return; }
			const band = document.createElement('div');
			band.className = 'lane-band' + (i % 2 ? ' alt' : '');
			band.style.top = `${screenTop}px`;
			band.style.height = `${screenHeight}px`;
			const label = document.createElement('span');
			label.className = 'lane-label';
			label.textContent = LANE_LABELS[name] || name;
			band.appendChild(label);
			lanesEl.appendChild(band);
		});
	}

	// ── Mode handling ───────────────────────────────────────────────────────────
	function clearModeClasses() {
		cy.elements().removeClass('flow-node flow trail impact-src impact-hit dim hl');
		statsEl.textContent = baseStats;
	}

	function applyModeStyle() {
		if (!cy) { return; }
		clearModeClasses();
		if (mode === 'flow') {
			cy.nodes().not('.hidden').addClass('flow-node');
			cy.edges().addClass('flow');
		}
		updateLaneOverlay();
	}

	function setMode(next) {
		mode = next;
		for (const m of ['deps', 'flow', 'impact']) {
			document.getElementById(`mode-${m}`).classList.toggle('active', m === next);
		}
		depthWrap.classList.toggle('hidden', next !== 'impact');
		// leaving a mode cancels any pending analysis overlays
		if (cyclesOn) { toggleCycles(); }
		if (pathModeActive()) { togglePathMode(); }
		hideDetail();
		if (!cy) { return; }
		clearModeClasses();
		cy.layout(layoutOptions()).run();
		applyModeStyle();
	}

	// ── Interactions per mode ───────────────────────────────────────────────────
	function traceTrail(node) {
		const trail = node.successors().union(node);
		cy.batch(() => {
			cy.elements().removeClass('trail dim');
			cy.elements().not(trail).addClass('dim');
			trail.addClass('trail');
		});
		statsEl.textContent = `Trilha de ${node.data('label')}: ${trail.nodes().length} arquivos`;
	}

	/** Recursive importers, optionally capped at `impactDepth` levels. */
	function affectedBy(node) {
		if (!impactDepth) { return node.predecessors(); }
		let frontier = node;
		let collected = cy.collection();
		for (let d = 0; d < impactDepth; d++) {
			const inc = frontier.incomers();
			collected = collected.union(inc);
			frontier = inc.nodes();
			if (frontier.empty()) { break; }
		}
		return collected;
	}

	function showImpact(node) {
		const affected = affectedBy(node);
		const keep = affected.union(node);
		cy.batch(() => {
			cy.elements().removeClass('impact-src impact-hit dim');
			cy.elements().not(keep).addClass('dim');
			node.addClass('impact-src');
			affected.addClass('impact-hit');
		});
		const count = affected.nodes().length;
		const scope = impactDepth ? ` (até ${impactDepth} nível${impactDepth === 1 ? '' : 's'})` : '';
		statsEl.textContent = `${count} arquivo${count === 1 ? '' : 's'} afetado${count === 1 ? '' : 's'} por mudança em ${node.data('label')}${scope}`;
	}

	function clearInteraction() {
		cy.batch(() => {
			cy.elements().removeClass('trail impact-src impact-hit dim hl');
		});
		statsEl.textContent = baseStats;
		applySearch();
	}

	function focusNeighborhood(node) {
		const hood = node.closedNeighborhood();
		cy.batch(() => {
			cy.elements().not(hood).addClass('dim');
			hood.addClass('hl');
		});
	}

	function openNode(node) {
		const data = node.data();
		if (data.type === 'file' && data.path) {
			vscode.postMessage({ type: 'open', path: data.path });
		}
	}

	// ── Render ──────────────────────────────────────────────────────────────────
	function markEntryPoints() {
		cy.nodes('[type="file"]')
			.filter((n) => n.incomers('edge[type="imports"]').length === 0)
			.addClass('entry');
	}

	function render(graph) {
		currentGraph = graph;
		if (cy) { cy.destroy(); }
		cy = cytoscape({
			container: cyEl,
			elements: toElements(clusterGraph(graph)),
			style: buildStyle(),
			layout: { name: 'null' },
			pixelRatio: 'auto',
		});

		markEntryPoints();

		cy.on('tap', 'node', (ev) => {
			const node = ev.target;
			if (node.data('type') === 'cluster') { expandCluster(node); return; }
			if (pathModeActive()) { handlePathPick(node); return; }
			if (mode === 'flow') { traceTrail(node); return; }
			if (mode === 'impact') { showImpact(node); return; }
			openNode(node);
		});
		cy.on('tap', 'edge', (ev) => showEdgeDetail(ev.target));
		cy.on('dbltap', 'node', (ev) => openNode(ev.target));
		cy.on('tap', (ev) => {
			if (ev.target !== cy) { return; }
			hideDetail();
			if (mode !== 'deps' && !pathModeActive()) { clearInteraction(); }
		});
		cy.on('mouseover', 'node', (ev) => {
			cyEl.style.cursor = 'pointer';
			if (mode === 'deps') { focusNeighborhood(ev.target); }
		});
		cy.on('mouseout', 'node', () => {
			cyEl.style.cursor = 'default';
			if (mode === 'deps') { clearInteraction(); }
		});
		cy.on('viewport', () => { updateLaneOverlay(); scheduleMinimap(); });
		// Manual layout: remember where the user drops a node (deps mode only)
		cy.on('dragfree', 'node', (ev) => {
			if (mode !== 'deps') { return; }
			const n = ev.target;
			savedState.positions[n.id()] = { x: n.position('x'), y: n.position('y') };
			schedulePersist();
		});
		cy.on('position', 'node', scheduleMinimap);
		// Right-click a node to paint it (persisted)
		cy.on('cxttap', 'node', (ev) => { ev.originalEvent.preventDefault(); showColorMenu(ev.target, ev.renderedPosition); });

		applyFilters({ relayout: false });
		const lay = cy.layout(layoutOptions());
		lay.one('layoutstop', () => { applySavedPositions(); scheduleMinimap(); });
		lay.run();
		applyModeStyle();
		scheduleMinimap();

		const files = graph.nodes.filter((n) => n.data.type === 'file').length;
		const modules = graph.nodes.filter((n) => n.data.type === 'module').length;
		baseStats = `${files} arquivos · ${modules} módulos · ${graph.edges.length} conexões`;
		statsEl.textContent = baseStats;
	}

	function populateFolderFilter(graph) {
		const current = folderSel.value;
		while (folderSel.options.length > 1) { folderSel.remove(1); }
		const topFolders = graph.nodes
			.filter((n) => n.data.type === 'folder' && !n.data.parent)
			.map((n) => n.data.path)
			.sort();
		for (const folder of topFolders) {
			const opt = document.createElement('option');
			opt.value = folder;
			opt.textContent = folder + '/';
			folderSel.appendChild(opt);
		}
		folderSel.value = [...folderSel.options].some((o) => o.value === current) ? current : '';
	}

	// ── Filters ─────────────────────────────────────────────────────────────────
	function applyFilters(opts) {
		if (!cy) { return; }
		const relayout = !opts || opts.relayout !== false;
		const folder = folderSel.value;
		const filesOnly = typeSel.value === 'files';
		const hideTests = hideTestsEl.checked;
		cy.batch(() => {
			cy.elements().removeClass('hidden');
			cy.nodes().forEach((n) => {
				const d = n.data();
				if (d.type === 'module') {
					if (filesOnly) { n.addClass('hidden'); }
					return;
				}
				if (hideTests && d.isTest) { n.addClass('hidden'); return; }
				if (folder && d.path !== folder && !(d.path || '').startsWith(folder + '/')) {
					n.addClass('hidden');
				}
			});
			// modules survive a folder filter only when linked to a visible file
			if ((folder || hideTests) && !filesOnly) {
				cy.nodes('[type="module"]').forEach((m) => {
					const linked = m.connectedEdges().some((e) =>
						!e.source().hasClass('hidden') && !e.target().hasClass('hidden'));
					if (!linked) { m.addClass('hidden'); }
				});
			}
		});

		// Relayout only when a filter is active — render() lays out the full
		// graph itself, and a second run here would cancel its animation.
		if (relayout && (folder || filesOnly || hideTests)) {
			const visible = cy.elements().not('.hidden');
			const filterLayout = visible.layout({ ...layoutOptions(), animate: true, animationDuration: 300 });
			filterLayout.on('layoutstop', () => {
				cy.animate({ fit: { eles: visible, padding: 50 }, duration: 200 });
				applyModeStyle();
			});
			filterLayout.run();
		} else if (relayout) {
			cy.layout(layoutOptions()).run();
			applyModeStyle();
		}

		applySearch();
	}

	// ── Search ──────────────────────────────────────────────────────────────────
	function matchingNodes() {
		const query = searchEl.value.trim().toLowerCase();
		if (!query) { return null; }
		return cy.nodes().filter((n) =>
			!n.hasClass('hidden') &&
			(n.data('label') || '').toLowerCase().includes(query));
	}

	let searchLayoutTimer = null;
	let lastLayoutQuery = '';

	function relayoutSearchResults() {
		const active = cy.elements().not('.dim').not('.hidden');
		const searchLayout = active.layout({ ...layoutOptions(), animate: true, animationDuration: 300 });
		searchLayout.on('layoutstop', () => {
			cy.animate({ fit: { eles: active, padding: 50 }, duration: 200 });
		});
		searchLayout.run();
	}

	function applySearch() {
		if (!cy) { return; }
		cy.elements().removeClass('dim search-hit');
		const matches = matchingNodes();
		const query = searchEl.value.trim().toLowerCase();
		if (!matches) { lastLayoutQuery = ''; clearTimeout(searchLayoutTimer); return; }
		matches.addClass('search-hit');
		const keep = matches.union(matches.connectedEdges());
		cy.elements().not(keep).addClass('dim');

		// Highlight is instant; the relayout waits for a typing pause and only
		// fires when the query actually changed (clearInteraction also calls us).
		if (matches.length > 0 && query !== lastLayoutQuery) {
			lastLayoutQuery = query;
			clearTimeout(searchLayoutTimer);
			searchLayoutTimer = setTimeout(relayoutSearchResults, 400);
		}
	}

	// ── Edge detail panel ────────────────────────────────────────────────────────
	function showEdgeDetail(edge) {
		cy.edges().removeClass('edge-sel');
		edge.addClass('edge-sel');
		const src = edge.source().data('label');
		const tgt = edge.target().data('label');
		const specs = edge.data('specs') || [];
		const rows = specs.length
			? specs.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('')
			: '<li><em>sem detalhe de import</em></li>';
		detailEl.innerHTML =
			`<div class="detail-head"><strong>${escapeHtml(src)}</strong> → <strong>${escapeHtml(tgt)}</strong>` +
			`<button id="detail-close" title="Fechar">✕</button></div>` +
			`<div class="detail-sub">${specs.length} import${specs.length === 1 ? '' : 's'}:</div>` +
			`<ul class="detail-list">${rows}</ul>`;
		detailEl.classList.remove('hidden');
		document.getElementById('detail-close').addEventListener('click', hideDetail);
	}

	function hideDetail() {
		detailEl.classList.add('hidden');
		if (cy) { cy.edges().removeClass('edge-sel'); }
	}

	function escapeHtml(t) {
		return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	// ── Cycle detection (Tarjan SCC over import edges) ────────────────────────────
	function findCycleElements() {
		const index = new Map();
		const low = new Map();
		const onStack = new Set();
		const stack = [];
		const sccs = [];
		let idx = 0;
		const nodes = cy.nodes('[type="file"]');

		function strongconnect(v) {
			const id = v.id();
			index.set(id, idx);
			low.set(id, idx);
			idx++;
			stack.push(v);
			onStack.add(id);
			v.outgoers('edge[type="imports"]').targets().forEach((w) => {
				if (w.data('type') !== 'file') { return; }
				const wid = w.id();
				if (!index.has(wid)) {
					strongconnect(w);
					low.set(id, Math.min(low.get(id), low.get(wid)));
				} else if (onStack.has(wid)) {
					low.set(id, Math.min(low.get(id), index.get(wid)));
				}
			});
			if (low.get(id) === index.get(id)) {
				const comp = [];
				let w;
				do { w = stack.pop(); onStack.delete(w.id()); comp.push(w); } while (w.id() !== id);
				if (comp.length > 1) { sccs.push(comp); }
			}
		}

		nodes.forEach((v) => { if (!index.has(v.id())) { strongconnect(v); } });

		let result = cy.collection();
		for (const comp of sccs) {
			const ids = new Set(comp.map((n) => n.id()));
			const compNodes = cy.collection(comp);
			result = result.union(compNodes);
			compNodes.forEach((n) => n.outgoers('edge[type="imports"]').forEach((e) => {
				if (ids.has(e.target().id())) { result = result.union(e); }
			}));
		}
		return result;
	}

	function toggleCycles() {
		if (!cy) { return; }
		cyclesOn = !cyclesOn;
		document.getElementById('cycles').classList.toggle('active', cyclesOn);
		cy.elements().removeClass('cycle dim');
		if (!cyclesOn) { statsEl.textContent = baseStats; return; }
		const cycleEls = findCycleElements();
		if (cycleEls.empty()) {
			statsEl.textContent = 'Nenhuma dependência circular encontrada ✓';
			cyclesOn = false;
			document.getElementById('cycles').classList.remove('active');
			return;
		}
		cy.batch(() => {
			cy.elements().not(cycleEls).addClass('dim');
			cycleEls.addClass('cycle');
		});
		const n = cycleEls.nodes().length;
		statsEl.textContent = `${n} arquivos em dependências circulares`;
	}

	// ── Shortest path between two files ──────────────────────────────────────────
	function togglePathMode() {
		const btn = document.getElementById('path');
		const active = !btn.classList.contains('active');
		btn.classList.toggle('active', active);
		pathPick = null;
		cy.elements().removeClass('path-hit path-end dim');
		statsEl.textContent = active ? 'Clique no arquivo de origem…' : baseStats;
	}

	function pathModeActive() {
		return document.getElementById('path').classList.contains('active');
	}

	function handlePathPick(node) {
		if (!pathPick) {
			pathPick = node;
			cy.elements().removeClass('path-hit path-end dim');
			node.addClass('path-end');
			statsEl.textContent = `Origem: ${node.data('label')} — clique no destino…`;
			return;
		}
		const dijkstra = cy.elements().dijkstra({ root: pathPick, directed: true });
		const path = dijkstra.pathTo(node);
		cy.elements().removeClass('path-hit path-end dim');
		if (!path || path.length <= 1) {
			statsEl.textContent = `Sem caminho de ${pathPick.data('label')} → ${node.data('label')}`;
		} else {
			cy.batch(() => {
				cy.elements().not(path).addClass('dim');
				path.addClass('path-hit');
				pathPick.addClass('path-end');
				node.addClass('path-end');
			});
			statsEl.textContent = `${pathPick.data('label')} → ${node.data('label')}: ${path.nodes().length} passos`;
		}
		pathPick = null;
	}

	// ── Manual layout + colors persistence ───────────────────────────────────────
	function schedulePersist() {
		clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			vscode.postMessage({ type: 'persistState', state: savedState });
		}, 600);
	}

	function applySavedPositions() {
		if (mode !== 'deps') { return; }
		cy.batch(() => {
			cy.nodes().forEach((n) => {
				const p = savedState.positions[n.id()];
				if (p) { n.position(p); }
			});
		});
	}

	const PAINT_COLORS = ['#f7768e', '#e0af68', '#9ece6a', '#7aa2f7', '#bb9af7', '#6b7089'];
	const PAINT_LABELS = {
		'#f7768e': 'não mexer', '#e0af68': 'dívida técnica', '#9ece6a': 'ok',
		'#7aa2f7': 'revisar', '#bb9af7': 'refatorar', '#6b7089': 'neutro',
	};
	let colorMenuEl = null;

	function closeColorMenu() {
		if (colorMenuEl) { colorMenuEl.remove(); colorMenuEl = null; }
	}

	function paintNode(node, color) {
		if (color) {
			node.data('color', color);
			savedState.colors[node.id()] = color;
		} else {
			node.data('color', node.data('baseColor'));
			delete savedState.colors[node.id()];
		}
		schedulePersist();
		closeColorMenu();
	}

	function showColorMenu(node, pos) {
		closeColorMenu();
		const menu = document.createElement('div');
		menu.className = 'color-menu';
		menu.style.left = `${pos.x}px`;
		menu.style.top = `${pos.y}px`;
		for (const c of PAINT_COLORS) {
			const sw = document.createElement('button');
			sw.className = 'swatch';
			sw.style.background = c;
			sw.title = PAINT_LABELS[c] || c;
			sw.addEventListener('click', () => paintNode(node, c));
			menu.appendChild(sw);
		}
		const clear = document.createElement('button');
		clear.className = 'swatch-clear';
		clear.textContent = 'remover';
		clear.addEventListener('click', () => paintNode(node, null));
		menu.appendChild(clear);
		document.getElementById('graph-wrap').appendChild(menu);
		colorMenuEl = menu;
	}

	function resetManualState() {
		savedState = { positions: {}, colors: {} };
		vscode.postMessage({ type: 'resetState' });
		closeColorMenu();
		if (currentGraph) { render(currentGraph); }
	}

	// ── Collapsible folder clusters ──────────────────────────────────────────────
	function syncClusterButton() {
		document.getElementById('clusters').classList.toggle('active', collapsedFolders.size > 0);
	}

	function toggleClusters() {
		if (!cy || !currentGraph) { return; }
		const turningOn = collapsedFolders.size === 0;
		collapsedFolders = new Set(turningOn ? collapsibleFolders(currentGraph) : []);
		if (turningOn && collapsedFolders.size === 0) {
			statsEl.textContent = `Nenhuma pasta com ${CLUSTER_MIN}+ arquivos para agrupar`;
			return;
		}
		syncClusterButton();
		render(currentGraph);
	}

	function expandCluster(node) {
		collapsedFolders.delete(node.data('path').replace(/\/$/, ''));
		syncClusterButton();
		render(currentGraph);
	}

	// ── Minimap ──────────────────────────────────────────────────────────────────
	let minimapTransform = null; // { scale, offX, offY } model→canvas
	let minimapRaf = 0;

	function scheduleMinimap() {
		if (minimapRaf) { return; }
		minimapRaf = requestAnimationFrame(() => { minimapRaf = 0; drawMinimap(); });
	}

	function drawMinimap() {
		const ctx = minimapEl.getContext('2d');
		const W = minimapEl.width;
		const H = minimapEl.height;
		ctx.clearRect(0, 0, W, H);
		if (!minimapOn || !cy || cy.nodes().empty()) { minimapTransform = null; return; }

		const bb = cy.elements().not('.hidden').boundingBox();
		if (!bb.w || !bb.h) { return; }
		const pad = 8;
		const scale = Math.min((W - 2 * pad) / bb.w, (H - 2 * pad) / bb.h);
		const offX = pad + (W - 2 * pad - bb.w * scale) / 2 - bb.x1 * scale;
		const offY = pad + (H - 2 * pad - bb.h * scale) / 2 - bb.y1 * scale;
		minimapTransform = { scale, offX, offY };
		const mx = (x) => x * scale + offX;
		const my = (y) => y * scale + offY;

		const t = theme();
		ctx.strokeStyle = t.edge;
		ctx.globalAlpha = 0.25;
		ctx.lineWidth = 0.5;
		cy.edges().not('.hidden').forEach((e) => {
			const s = e.source().position();
			const d = e.target().position();
			ctx.beginPath();
			ctx.moveTo(mx(s.x), my(s.y));
			ctx.lineTo(mx(d.x), my(d.y));
			ctx.stroke();
		});

		ctx.globalAlpha = 0.9;
		cy.nodes().not('.hidden').forEach((n) => {
			const p = n.position();
			ctx.fillStyle = n.data('color') || t.fg;
			ctx.beginPath();
			ctx.arc(mx(p.x), my(p.y), n.data('type') === 'cluster' ? 3 : 1.6, 0, 2 * Math.PI);
			ctx.fill();
		});

		// viewport rectangle
		const ext = cy.extent();
		ctx.globalAlpha = 1;
		ctx.strokeStyle = t.accent;
		ctx.lineWidth = 1;
		ctx.strokeRect(mx(ext.x1), my(ext.y1), (ext.x2 - ext.x1) * scale, (ext.y2 - ext.y1) * scale);
	}

	function panFromMinimap(ev) {
		if (!minimapTransform || !cy) { return; }
		const rect = minimapEl.getBoundingClientRect();
		const cx = ev.clientX - rect.left;
		const cy2 = ev.clientY - rect.top;
		const modelX = (cx - minimapTransform.offX) / minimapTransform.scale;
		const modelY = (cy2 - minimapTransform.offY) / minimapTransform.scale;
		const z = cy.zoom();
		cy.pan({ x: cyEl.clientWidth / 2 - modelX * z, y: cyEl.clientHeight / 2 - modelY * z });
	}

	function toggleMinimap() {
		minimapOn = !minimapOn;
		minimapEl.classList.toggle('hidden', !minimapOn);
		document.getElementById('minimap-toggle').classList.toggle('active', minimapOn);
		if (minimapOn) { scheduleMinimap(); }
	}

	// ── Export PNG / SVG ─────────────────────────────────────────────────────────
	function exportPng() {
		if (!cy) { return; }
		const data = cy.png({ full: true, scale: 2, bg: theme().bg });
		vscode.postMessage({ type: 'exportImage', data });
	}

	function exportSvg() {
		if (!cy || typeof cy.svg !== 'function') { return; }
		const data = cy.svg({ full: true, scale: 1, bg: theme().bg });
		vscode.postMessage({ type: 'exportSvg', data });
	}

	// ── Wire up ─────────────────────────────────────────────────────────────────
	searchEl.addEventListener('input', applySearch);
	searchEl.addEventListener('keydown', (ev) => {
		if (ev.key !== 'Enter' || !cy) { return; }
		const matches = matchingNodes();
		if (matches && matches.length > 0) {
			cy.animate({ fit: { eles: matches, padding: 90 }, duration: 250 });
		}
	});

	folderSel.addEventListener('change', () => applyFilters());
	typeSel.addEventListener('change', () => applyFilters());
	hideTestsEl.addEventListener('change', () => applyFilters());

	themeSel.addEventListener('change', () => {
		applyTheme(themeSel.value);
		vscode.postMessage({ type: 'setTheme', theme: themeSel.value });
	});

	document.getElementById('mode-deps').addEventListener('click', () => setMode('deps'));
	document.getElementById('mode-flow').addEventListener('click', () => setMode('flow'));
	document.getElementById('mode-impact').addEventListener('click', () => setMode('impact'));

	document.getElementById('cycles').addEventListener('click', toggleCycles);
	document.getElementById('path').addEventListener('click', () => { if (cy) { togglePathMode(); } });
	document.getElementById('export-png').addEventListener('click', exportPng);
	document.getElementById('export-svg').addEventListener('click', exportSvg);
	document.getElementById('reset-layout').addEventListener('click', resetManualState);
	document.getElementById('clusters').addEventListener('click', toggleClusters);
	document.getElementById('minimap-toggle').addEventListener('click', toggleMinimap);
	// dismiss the color menu on any outside interaction
	cyEl.addEventListener('mousedown', closeColorMenu);

	// Minimap: click or drag to recenter the main view
	let minimapDragging = false;
	minimapEl.addEventListener('mousedown', (e) => { minimapDragging = true; panFromMinimap(e); });
	window.addEventListener('mousemove', (e) => { if (minimapDragging) { panFromMinimap(e); } });
	window.addEventListener('mouseup', () => { minimapDragging = false; });

	depthEl.addEventListener('input', () => {
		impactDepth = Number(depthEl.value);
		depthVal.textContent = impactDepth === 0 ? 'todos' : String(impactDepth);
	});

	document.getElementById('fit').addEventListener('click', () => {
		if (cy) { cy.animate({ fit: { padding: 50 }, duration: 250 }); }
	});

	document.getElementById('refresh').addEventListener('click', () => {
		overlayText.textContent = 'Rebuilding project graph…';
		overlayEl.classList.remove('hidden');
		vscode.postMessage({ type: 'refresh' });
	});

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'graph') {
			themeName = msg.theme || themeName;
			themeSel.value = themeName;
			savedState = msg.saved || { positions: {}, colors: {} };
			cyEl.style.background = theme().bg;
			lanesEl.style.color = theme().fg;
			render(msg.graph);
			populateFolderFilter(msg.graph);
			overlayEl.classList.add('hidden');
		} else if (msg.type === 'theme') {
			applyTheme(msg.theme);
		} else if (msg.type === 'error') {
			overlayText.textContent = msg.message;
			overlayEl.querySelector('.spinner').style.display = 'none';
			overlayEl.classList.remove('hidden');
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
