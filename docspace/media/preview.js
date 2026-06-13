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
        holder.textContent = window.L.embedNotFound.replace('{0}', `![[${name}]]`);
        continue;
      }
      if (!utils) {
        holder.className = 'embed-missing';
        holder.textContent = window.L.embedNoRenderer.replace('{0}', `![[${name}]]`);
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
        holder.textContent = window.L.embedRenderError.replace('{0}', `![[${name}]]`).replace('{1}', err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ── Embed preprocessing: ![[x.mmd]] / ![[x.excalidraw]] → placeholders ─────
  function expandEmbeds(text) {
    return text.replace(/!\[\[([^[\]]+?\.(?:mmd|excalidraw))\]\]/g, (_, name) => {
      if (name.endsWith('.mmd')) {
        const body = embeds[name];
        return body === undefined
          ? `<div class="embed-missing">${escapeHtml(window.L.embedNotFound.replace('{0}', `![[${name}]]`))}</div>`
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

  // ── Table of contents (from ## / ### headings) ─────────────────────────────
  function slugify(text) {
    return text.toLowerCase().trim().replace(/[^\wÀ-ɏ]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function addToc(root) {
    const headings = [...root.querySelectorAll('h2, h3')];
    if (headings.length < 3) { return; }
    const used = new Set();
    const nav = document.createElement('nav');
    nav.className = 'toc';
    const title = document.createElement('div');
    title.className = 'toc-title';
    title.textContent = window.L.toc;
    nav.appendChild(title);
    const ul = document.createElement('ul');
    for (const h of headings) {
      let id = slugify(h.textContent || 'secao') || 'secao';
      const base = id;
      let i = 1;
      while (used.has(id)) { id = `${base}-${i++}`; }
      used.add(id);
      h.id = id;
      const li = document.createElement('li');
      if (h.tagName === 'H3') { li.className = 'toc-sub'; }
      const a = document.createElement('a');
      a.href = `#${id}`;
      a.textContent = h.textContent || '';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      li.appendChild(a);
      ul.appendChild(li);
    }
    nav.appendChild(ul);
    root.insertBefore(nav, root.firstChild);
  }

  // ── Copy button on each code block ─────────────────────────────────────────
  function addCopyButtons(root) {
    for (const pre of [...root.querySelectorAll('pre')]) {
      if (pre.classList.contains('mermaid') || pre.querySelector('.copy-btn')) { continue; }
      const code = pre.querySelector('code');
      if (!code) { continue; }
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = window.L.copy;
      btn.title = window.L.copyTitle;
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(code.textContent || '');
          btn.textContent = window.L.copied;
        } catch {
          btn.textContent = window.L.copyFailed;
        }
        setTimeout(() => { btn.textContent = window.L.copy; }, 1200);
      });
      pre.appendChild(btn);
    }
  }

  let renderTimer;
  async function updatePreview(text) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(async () => {
      content.innerHTML = buildHtml(text);
      if (!isMmd) { addToc(content); }
      await renderMermaidIn(content);
      await renderExcalidrawEmbeds(content);
      addCopyButtons(content);
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
