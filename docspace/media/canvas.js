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
  let ignoreNextChange = false;

  // ── Debounce helper ────────────────────────────────────────────────────────
  function debounce(fn, ms) {
    let timeoutId;
    return (...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn(...args), ms); };
  }

  const sendChange = debounce((elements, appState, files) => {
    if (ignoreNextChange) { ignoreNextChange = false; return; }
    vscode.postMessage({
      type: 'change',
      content: JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'docspace',
        elements,
        appState: {
          gridSize: appState.gridSize,
          theme: appState.theme,
        },
        files,
      }, null, 2),
    });
  }, 500);

  // ── Render ─────────────────────────────────────────────────────────────────
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(
    React.createElement(Excalidraw, {
      initialData,
      theme,
      UIOptions: { canvasActions: { toggleTheme: true, saveToActiveFile: false } },
      excalidrawAPI: (api) => { excalidrawAPI = api; },
      onChange: sendChange,
    })
  );

  // ── Ctrl+S: forward save to VS Code instead of Excalidraw's file picker ───
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      vscode.postMessage({ type: 'save' });
    }
  }, true);

  // ── Receive external updates (git pull, co-edit, etc.) ────────────────────
  window.addEventListener('message', ({ data }) => {
    if (!excalidrawAPI) { return; }
    if (data.type === 'theme') {
      excalidrawAPI.updateScene({ appState: { theme: data.theme } });
      return;
    }
    if (data.type !== 'update') { return; }
    try {
      const parsed = JSON.parse(data.content || '{}');
      ignoreNextChange = true;
      excalidrawAPI.updateScene({
        elements: parsed.elements ?? [],
        appState: parsed.appState ?? {},
      });
    } catch { /* invalid JSON from external update — skip silently */ }
  });
}());
