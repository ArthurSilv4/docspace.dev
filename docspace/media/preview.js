(function () {
  const vscode   = acquireVsCodeApi();
  const isMmd    = window.__DOCSPACE_IS_MMD__   === true;
  const filename = window.__DOCSPACE_FILENAME__ ?? '';
  const source   = window.__DOCSPACE_SOURCE__   ?? '';
  let embeds     = window.__DOCSPACE_EMBEDS__   ?? {};

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
  }

  // ── Build shell ────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.innerHTML = `<span class="file-icon">${isMmd ? '⬡' : '📄'}</span><span class="file-name">${escapeHtml(filename)}</span>`;

  const content = document.createElement('div');
  content.className = 'preview-content';

  document.body.appendChild(toolbar);
  document.body.appendChild(content);

  // ── Mermaid ────────────────────────────────────────────────────────────────
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, theme: window.__DOCSPACE_THEME__ ?? 'default' });
  }

  let mermaidCounter = 0;
  async function renderMermaidIn(root) {
    if (!window.mermaid) { return; }
    for (const block of [...root.querySelectorAll('pre.mermaid')]) {
      const src = block.textContent ?? '';
      const id  = `ds-${Date.now()}-${mermaidCounter++}`;
      try {
        const { svg } = await mermaid.render(id, src);
        const div = document.createElement('div');
        div.className = 'mermaid-container';
        div.innerHTML = svg;
        block.replaceWith(div);

        const svgEl = div.querySelector('svg');
        if (svgEl && window.Panzoom) {
          svgEl.style.display = 'block';
          const pz = Panzoom(svgEl, { maxScale: 5, minScale: 0.2, contain: 'outside' });
          div.addEventListener('wheel', pz.zoomWithWheel);
          const resetBtn = document.createElement('button');
          resetBtn.className = 'diagram-reset';
          resetBtn.title = 'Reset view';
          resetBtn.textContent = '⌂';
          resetBtn.addEventListener('click', () => pz.reset());
          div.appendChild(resetBtn);
        }
      } catch (err) {
        const msg = document.createElement('div');
        msg.className = 'mermaid-error';
        msg.textContent = `Mermaid error: ${err instanceof Error ? err.message : String(err)}`;
        block.replaceWith(msg);
      }
    }
  }

  // ── Excalidraw embeds (![[file.excalidraw]]) ───────────────────────────────
  async function renderExcalidrawEmbeds(root) {
    const utils = window.ExcalidrawUtils;
    for (const holder of [...root.querySelectorAll('.excalidraw-embed')]) {
      const name = holder.dataset.name;
      const raw = embeds[name];
      if (raw === undefined) {
        holder.className = 'embed-missing';
        holder.textContent = `![[${name}]] — arquivo não encontrado`;
        continue;
      }
      if (!utils) {
        holder.className = 'embed-missing';
        holder.textContent = `![[${name}]] — não foi possível carregar o renderizador`;
        continue;
      }
      try {
        const scene = JSON.parse(raw);
        const svg = await utils.exportToSvg({
          elements: scene.elements ?? [],
          appState: { ...(scene.appState ?? {}), exportBackground: false, viewBackgroundColor: 'transparent' },
          files: scene.files ?? {},
        });
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        holder.innerHTML = '';
        holder.appendChild(svg);
      } catch (err) {
        holder.className = 'embed-missing';
        holder.textContent = `![[${name}]] — erro ao renderizar: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // ── Embed preprocessing: ![[x.mmd]] / ![[x.excalidraw]] → placeholders ─────
  function expandEmbeds(text) {
    return text.replace(/!\[\[([^[\]]+?\.(?:mmd|excalidraw))\]\]/g, (_, name) => {
      if (name.endsWith('.mmd')) {
        const body = embeds[name];
        return body === undefined
          ? `<div class="embed-missing">![[${escapeHtml(name)}]] — arquivo não encontrado</div>`
          : `<pre class="mermaid">${escapeHtml(body)}</pre>`;
      }
      return `<div class="excalidraw-embed" data-name="${escapeAttr(name)}"></div>`;
    });
  }

  // ── Markdown ───────────────────────────────────────────────────────────────
  const mdIt = window.markdownit
    ? window.markdownit({ html: true, linkify: true, typographer: true })
    : null;

  if (mdIt) {
    const origFence = mdIt.renderer.rules.fence?.bind(mdIt.renderer.rules);
    mdIt.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      if (token.info.trim() === 'mermaid') {
        const esc = escapeHtml(token.content);
        return `<pre class="mermaid">${esc}</pre>\n`;
      }
      return origFence ? origFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    };
  }

  function buildHtml(text) {
    if (isMmd) {
      const esc = escapeHtml(text);
      return `<pre class="mermaid">${esc}</pre>`;
    }
    const expanded = expandEmbeds(text);
    return mdIt ? mdIt.render(expanded) : `<pre>${escapeHtml(text)}</pre>`;
  }

  let renderTimer;
  async function updatePreview(text) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(async () => {
      content.innerHTML = buildHtml(text);
      await renderMermaidIn(content);
      await renderExcalidrawEmbeds(content);
    }, 80);
  }

  // ── Clickable links to project files ───────────────────────────────────────
  content.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) { return; }
    const href = a.getAttribute('href') ?? '';
    if (/^[a-z]+:\/\//i.test(href)) { return; } // external URLs: default behavior
    if (/\.(mmd|excalidraw|md)(#.*)?$/i.test(href)) {
      e.preventDefault();
      vscode.postMessage({ type: 'open', href });
    }
  });

  // Initial render
  updatePreview(source);

  // ── Live updates from native editor ───────────────────────────────────────
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'update') {
      if (data.embeds) { embeds = data.embeds; }
      updatePreview(data.content);
    }
  });
}());
