(function () {
  const isMmd    = window.__DOCSPACE_IS_MMD__   === true;
  const filename = window.__DOCSPACE_FILENAME__ ?? '';
  const source   = window.__DOCSPACE_SOURCE__   ?? '';

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Build shell ────────────────────────────────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  toolbar.innerHTML = `<span class="file-icon">${isMmd ? '⬡' : '📄'}</span><span class="file-name">${filename}</span>`;

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
    return mdIt ? mdIt.render(text) : `<pre>${escapeHtml(text)}</pre>`;
  }

  let renderTimer;
  async function updatePreview(text) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(async () => {
      content.innerHTML = buildHtml(text);
      await renderMermaidIn(content);
    }, 80);
  }

  // Initial render
  updatePreview(source);

  // ── Live updates from native editor ───────────────────────────────────────
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'update') { updatePreview(data.content); }
  });
}());
