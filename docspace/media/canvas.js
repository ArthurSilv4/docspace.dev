(function () {
  const vscode = acquireVsCodeApi();

  // ── Parse initial data ─────────────────────────────────────────────────────
  let initialData = {};
  try { initialData = JSON.parse(window.__DOCSPACE_CANVAS_DATA__ || '{}'); } catch { /* malformed JSON defaults to empty object */ }

  if (!initialData.appState) { initialData.appState = {}; }

  const theme = window.__DOCSPACE_THEME__ ?? 'light';

  // ── Verify Excalidraw UMD loaded ───────────────────────────────────────────
  if (!window.ExcalidrawLib) {
    document.getElementById('root').textContent = 'Failed to load Excalidraw. Check network / CSP.';
    return;
  }

  const Excalidraw = window.ExcalidrawLib.Excalidraw;
  const React = window.React;
  const ReactDOM = window.ReactDOM;

  if (!Excalidraw || !React || !ReactDOM) {
    document.getElementById('root').textContent =
      'ExcalidrawLib loaded but missing expected exports. Check version.';
    return;
  }

  // ── Excalidraw API ref ─────────────────────────────────────────────────────
  let excalidrawAPI = null;

  // ── Change queue: debounced while drawing, flushed synchronously on save ──
  const CHANGE_DEBOUNCE_MS = 500;
  let pendingContent = null;
  let pendingTimer = null;

  function buildContent(elements, appState, files) {
    return JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'docspace',
      elements,
      appState: {
        gridSize: appState.gridSize,
        theme: appState.theme,
      },
      files,
    }, null, 2);
  }

  function queueChange(elements, appState, files) {
    pendingContent = buildContent(elements, appState, files);
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flushChange, CHANGE_DEBOUNCE_MS);
  }

  /** Send the queued change now (no-op when nothing is pending). */
  function flushChange() {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    if (pendingContent === null) { return; }
    vscode.postMessage({ type: 'change', content: pendingContent });
    pendingContent = null;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(
    React.createElement(Excalidraw, {
      initialData,
      theme,
      UIOptions: { canvasActions: { toggleTheme: true, saveToActiveFile: false } },
      excalidrawAPI: (api) => { excalidrawAPI = api; },
      onChange: queueChange,
    })
  );

  // ── Ctrl+S: flush pending edits, then save through VS Code ────────────────
  // stopPropagation keeps Excalidraw's own Ctrl+S handler (file-save dialog)
  // from firing; flushing first guarantees the save sees the latest drawing
  // instead of racing the 500ms debounce.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      flushChange();
      vscode.postMessage({ type: 'save' });
    }
  }, true);

  // ── Receive external updates (git pull, undo from VS Code, etc.) ──────────
  // The extension suppresses echoes of our own edits, so any 'update' here is
  // a genuine external change and must be applied to the scene.
  window.addEventListener('message', ({ data }) => {
    if (!excalidrawAPI) { return; }
    if (data.type === 'theme') {
      excalidrawAPI.updateScene({ appState: { theme: data.theme } });
      return;
    }
    if (data.type !== 'update') { return; }
    try {
      const parsed = JSON.parse(data.content || '{}');
      // Drop any stale local edit — the external content is the new truth.
      pendingContent = null;
      clearTimeout(pendingTimer);
      excalidrawAPI.updateScene({
        elements: parsed.elements ?? [],
        appState: parsed.appState ?? {},
      });
    } catch { /* invalid JSON from external update — skip silently */ }
  });
}());
