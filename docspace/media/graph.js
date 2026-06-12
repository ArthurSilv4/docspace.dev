/* global cytoscape, acquireVsCodeApi */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
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
				return { data: {
					id: n.data.id,
					label: n.data.label,
					type: n.data.type,
					path: n.data.path,
					role: n.data.role || (n.data.type === 'module' ? 'external' : 'other'),
					isTest: n.data.isTest ? 1 : 0,
					size: 9 + 24 * Math.sqrt(deg / maxDegree),
					color: n.data.type === 'module' ? t.module : colorFor(topFolder(n.data.path)),
				} };
			});

		return { nodes, edges: graph.edges.map((e) => ({ data: e.data })) };
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

	function showImpact(node) {
		const affected = node.predecessors(); // who imports it, recursively
		const keep = affected.union(node);
		cy.batch(() => {
			cy.elements().removeClass('impact-src impact-hit dim');
			cy.elements().not(keep).addClass('dim');
			node.addClass('impact-src');
			affected.addClass('impact-hit');
		});
		const count = affected.nodes().length;
		statsEl.textContent = `${count} arquivo${count === 1 ? '' : 's'} afetado${count === 1 ? '' : 's'} por mudança em ${node.data('label')}`;
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
			elements: toElements(graph),
			style: buildStyle(),
			layout: { name: 'null' },
			pixelRatio: 'auto',
		});

		markEntryPoints();

		cy.on('tap', 'node', (ev) => {
			const node = ev.target;
			if (mode === 'flow') { traceTrail(node); return; }
			if (mode === 'impact') { showImpact(node); return; }
			openNode(node);
		});
		cy.on('dbltap', 'node', (ev) => openNode(ev.target));
		cy.on('tap', (ev) => {
			if (ev.target === cy && mode !== 'deps') { clearInteraction(); }
		});
		cy.on('mouseover', 'node', (ev) => {
			cyEl.style.cursor = 'pointer';
			if (mode === 'deps') { focusNeighborhood(ev.target); }
		});
		cy.on('mouseout', 'node', () => {
			cyEl.style.cursor = 'default';
			if (mode === 'deps') { clearInteraction(); }
		});
		cy.on('viewport', updateLaneOverlay);

		applyFilters({ relayout: false });
		cy.layout(layoutOptions()).run();
		applyModeStyle();

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
