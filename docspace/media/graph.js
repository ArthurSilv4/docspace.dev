/* global cytoscape, acquireVsCodeApi */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const cyEl = document.getElementById('cy');
	const searchEl = document.getElementById('search');
	const folderSel = document.getElementById('folder-filter');
	const typeSel = document.getElementById('type-filter');
	const statsEl = document.getElementById('stats');
	const overlayEl = document.getElementById('overlay');
	const overlayText = document.getElementById('overlay-text');

	let cy = null;
	let layoutMode = 'network'; // 'network' (force) | 'flow' (layered, top→down)

	// Obsidian-like group palette (soft hues on a dark canvas); modules stay muted
	const GROUP_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#f7768e', '#2ac3de', '#ff9e64', '#73daca'];
	const MODULE_COLOR = '#6b7089';

	function cssVar(name, fallback) {
		// cytoscape rejects quoted font names, so strip quotes from the value
		const value = getComputedStyle(document.body).getPropertyValue(name).trim().replace(/['"]/g, '');
		return value || fallback;
	}

	function topFolder(p) {
		return p && p.includes('/') ? p.slice(0, p.indexOf('/')) : '';
	}

	/**
	 * Obsidian style: no folder boxes — files and external modules become dots,
	 * colored by top-level folder and sized by their number of connections.
	 */
	function toElements(graph) {
		const groupColor = new Map();
		const colorFor = (group) => {
			if (!groupColor.has(group)) {
				groupColor.set(group, GROUP_COLORS[groupColor.size % GROUP_COLORS.length]);
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
					size: 9 + 24 * Math.sqrt(deg / maxDegree),
					color: n.data.type === 'module' ? MODULE_COLOR : colorFor(topFolder(n.data.path)),
				} };
			});

		return { nodes, edges: graph.edges.map((e) => ({ data: e.data })) };
	}

	function buildStyle() {
		const fg = cssVar('--vscode-descriptionForeground', '#9a9fb0');
		const accent = cssVar('--vscode-focusBorder', '#7aa2f7');
		const edge = cssVar('--vscode-editorLineNumber-foreground', '#4a4f63');
		return [
			{ selector: 'node', style: {
				width: 'data(size)', height: 'data(size)',
				'background-color': 'data(color)',
				'background-opacity': 0.92,
				'border-width': 0,
				label: 'data(label)',
				color: fg,
				'font-family': cssVar('--vscode-font-family', 'sans-serif'),
				'font-size': 9,
				'text-valign': 'bottom', 'text-halign': 'center',
				'text-margin-y': 5,
				'text-opacity': 0.8,
				// Obsidian behavior: labels fade out when zoomed away
				'min-zoomed-font-size': 8,
				'transition-property': 'opacity, background-opacity, text-opacity',
				'transition-duration': '120ms',
			} },
			{ selector: 'node[type="module"]', style: {
				'background-opacity': 0.5,
				'text-opacity': 0.55,
			} },
			{ selector: 'edge', style: {
				width: 1,
				'curve-style': 'haystack', 'haystack-radius': 0,
				'line-color': edge,
				opacity: 0.32,
				'transition-property': 'opacity',
				'transition-duration': '120ms',
			} },
			{ selector: 'edge[type="dependsOn"]', style: { 'line-style': 'dashed', opacity: 0.2 } },
			// Flow view: direction matters, so edges get arrows (haystack can't draw them)
			{ selector: 'edge.flow', style: {
				'curve-style': 'bezier',
				'target-arrow-shape': 'triangle',
				'target-arrow-color': cssVar('--vscode-editorLineNumber-foreground', '#4a4f63'),
				'arrow-scale': 0.7,
				opacity: 0.45,
			} },
			{ selector: 'node:selected', style: {
				'border-width': 2.5, 'border-color': accent, 'text-opacity': 1,
			} },
			{ selector: '.search-hit', style: {
				'border-width': 2.5, 'border-color': accent, 'text-opacity': 1,
			} },
			{ selector: 'node.hl', style: { 'background-opacity': 1, 'text-opacity': 1 } },
			{ selector: 'edge.hl', style: { opacity: 0.85 } },
			{ selector: '.dim', style: { opacity: 0.08 } },
			{ selector: '.hidden', style: { display: 'none' } },
		];
	}

	function layoutOptions() {
		if (layoutMode === 'flow') {
			// importer above imported: read the system top→down like a narrative
			return typeof window.cytoscapeDagre !== 'undefined'
				? { name: 'dagre', rankDir: 'TB', nodeSep: 30, rankSep: 90, padding: 50,
					animate: true, animationDuration: 400 }
				: { name: 'breadthfirst', directed: true, padding: 50, spacingFactor: 1.2 };
		}
		const fcose = typeof window.cytoscapeFcose !== 'undefined';
		return fcose
			? { name: 'fcose', quality: 'proof', randomize: true, animate: true, animationDuration: 600,
				nodeRepulsion: 12000, idealEdgeLength: 75, gravity: 0.3, gravityRange: 2.5, padding: 50,
				tile: true, tilingPaddingVertical: 40, tilingPaddingHorizontal: 40 }
			: { name: 'cose', animate: false, padding: 50, nodeRepulsion: 12000, idealEdgeLength: 80 };
	}

	function setLayoutMode(mode) {
		layoutMode = mode;
		document.getElementById('mode-network').classList.toggle('active', mode === 'network');
		document.getElementById('mode-flow').classList.toggle('active', mode === 'flow');
		if (!cy) { return; }
		cy.edges().toggleClass('flow', mode === 'flow');
		cy.layout(layoutOptions()).run();
	}

	// ── hover: spotlight the neighborhood, fade the rest (Obsidian-style) ──
	function focusNeighborhood(node) {
		const hood = node.closedNeighborhood();
		cy.batch(() => {
			cy.elements().not(hood).addClass('dim');
			hood.addClass('hl');
		});
	}

	function clearFocus() {
		cy.batch(() => {
			cy.elements().removeClass('dim hl');
		});
		applySearch();
	}

	function render(graph) {
		if (cy) { cy.destroy(); }
		cy = cytoscape({
			container: cyEl,
			elements: toElements(graph),
			style: buildStyle(),
			layout: layoutOptions(),
			pixelRatio: 'auto',
		});

		if (layoutMode === 'flow') { cy.edges().addClass('flow'); }

		cy.on('tap', 'node', (ev) => {
			const data = ev.target.data();
			if (data.type === 'file' && data.path) {
				vscode.postMessage({ type: 'open', path: data.path });
			}
		});
		cy.on('mouseover', 'node', (ev) => {
			cyEl.style.cursor = 'pointer';
			focusNeighborhood(ev.target);
		});
		cy.on('mouseout', 'node', () => {
			cyEl.style.cursor = 'default';
			clearFocus();
		});

		const files = graph.nodes.filter((n) => n.data.type === 'file').length;
		const modules = graph.nodes.filter((n) => n.data.type === 'module').length;
		statsEl.textContent = `${files} files · ${modules} modules · ${graph.edges.length} links`;
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

	function applyFilters() {
		if (!cy) { return; }
		const folder = folderSel.value;
		const filesOnly = typeSel.value === 'files';
		cy.batch(() => {
			cy.elements().removeClass('hidden');
			cy.nodes().forEach((n) => {
				const d = n.data();
				if (d.type === 'module') {
					if (filesOnly) { n.addClass('hidden'); }
					return;
				}
				if (folder && d.path !== folder && !(d.path || '').startsWith(folder + '/')) {
					n.addClass('hidden');
				}
			});
			// modules survive a folder filter only when linked to a visible file
			if (folder && !filesOnly) {
				cy.nodes('[type="module"]').forEach((m) => {
					const linked = m.connectedEdges().some((e) =>
						!e.source().hasClass('hidden') && !e.target().hasClass('hidden'));
					if (!linked) { m.addClass('hidden'); }
				});
			}
		});
		applySearch();
	}

	function matchingNodes() {
		const query = searchEl.value.trim().toLowerCase();
		if (!query) { return null; }
		return cy.nodes().filter((n) =>
			!n.hasClass('hidden') &&
			(n.data('label') || '').toLowerCase().includes(query));
	}

	function applySearch() {
		if (!cy) { return; }
		cy.elements().removeClass('dim search-hit');
		const matches = matchingNodes();
		if (!matches) { return; }
		matches.addClass('search-hit');
		const keep = matches.union(matches.connectedEdges());
		cy.elements().not(keep).addClass('dim');
	}

	searchEl.addEventListener('input', applySearch);
	searchEl.addEventListener('keydown', (ev) => {
		if (ev.key !== 'Enter' || !cy) { return; }
		const matches = matchingNodes();
		if (matches && matches.length > 0) {
			cy.animate({ fit: { eles: matches, padding: 90 }, duration: 250 });
		}
	});

	folderSel.addEventListener('change', applyFilters);
	typeSel.addEventListener('change', applyFilters);

	document.getElementById('mode-network').addEventListener('click', () => setLayoutMode('network'));
	document.getElementById('mode-flow').addEventListener('click', () => setLayoutMode('flow'));

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
			render(msg.graph);
			populateFolderFilter(msg.graph);
			applyFilters();
			overlayEl.classList.add('hidden');
		} else if (msg.type === 'error') {
			overlayText.textContent = msg.message;
			overlayEl.querySelector('.spinner').style.display = 'none';
			overlayEl.classList.remove('hidden');
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
