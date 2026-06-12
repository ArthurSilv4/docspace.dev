# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

```
docspace/
├── src/
│   ├── extension.ts          # Entry point — activate() registers commands, providers, watchers
│   ├── config.ts             # Per-category config (getCategoryConfig, resolveCategoryRoot), GENERATED_DIR
│   ├── treeItem.ts           # WorkspaceTreeItem, ItemKind (incl. genFolder/genFile), FilterKey
│   ├── fileFilter.ts         # isRelevantByName(), needsContentCheck(), isFileRelevant(), hasMermaidBlock()
│   ├── dirReader.ts          # readDirChildren(), hasRelevantContent(), safeReadDirectory()
│   ├── scanCache.ts          # discovery caches + per-path invalidation (also invalidates graph cache)
│   ├── provider.ts           # DocspaceProvider (TreeDataProvider) — 3 fixed categories, debounced refresh
│   ├── previewPanel.ts       # PreviewPanel — native editor + webview preview + ![[embeds]] resolution
│   ├── graphPanel.ts         # GraphPanel — project graph webview (Cytoscape.js), themes
│   ├── projectGraph.ts       # buildProjectGraph(), extractImports(), detectRole(), 2-layer cache
│   ├── docGenerator.ts       # generateProjectDocs() — writes read-only docGerada/ from the graph
│   ├── canvasEditor.ts       # CanvasEditorProvider — CustomTextEditorProvider for .excalidraw
│   └── test/
│       ├── scanCache.test.ts # Mocha tests — cache invalidation semantics
│       ├── fileFilter.test.ts# Mocha tests — filename/filter matching
│       └── projectGraph.test.ts # Mocha tests — import extraction/resolution, roles, test detection
├── media/
│   ├── preview.js            # Webview JS: markdown/mermaid + ![[x.mmd]]/![[x.excalidraw]] embeds + file links
│   ├── preview.css           # Webview CSS: typography, mermaid-container, embed boxes
│   ├── canvas.js             # Webview JS: initializes Excalidraw (UMD 0.17.6), bidirectional sync
│   ├── canvas.css            # Webview CSS: full-screen Excalidraw container
│   ├── graph.js              # Webview JS: 3 graph modes, themes, swimlanes, impact, search/filter
│   └── graph.css             # Webview CSS: toolbar, lane overlay, canvas
├── resources/
│   └── icon.svg              # Activity Bar icon
├── out/                      # Compiled JS output (gitignored)
├── package.json              # Extension manifest, scripts, and contributes
├── tsconfig.json             # TypeScript config (ES2022, Node16, strict)
└── eslint.config.mjs         # ESLint rules (includes complexity: max 10)
```

## Commands

Run from `docspace/`:

```bash
npm run compile    # Compile TypeScript → out/
npm run watch      # Compile on file changes (keep running during development)
npm run lint       # Run ESLint on src/ (warns on cyclomatic complexity > 10)
npm run test       # Compile + lint + run tests via vscode-test
```

**Debug/run in VS Code:** Press `F5` from the `docspace/` folder — launches an Extension Development Host window with the extension loaded.

**Run tests in VS Code:** Open the Testing view (Ctrl+; A) — requires the watch task to be running so test files are compiled.

**Known snag:** `npm run test` fails with "Code is currently being updated" when a hung `CodeSetup-stable` process holds the InnoSetup mutex — kill those processes and rerun.

## Architecture

- **Activation:** `onStartupFinished`. Entry point `src/extension.ts`; all resources pushed to `context.subscriptions`.

### Sidebar (3 fixed categories, per-category modes)

The tree (`docspace.explorer`) always shows **Docs / Diagrams / Canvas**. Each category has its own discovery mode, stored in flat settings (`docspace.docsMode`/`docspace.docsFolder`, `diagramsMode/diagramsFolder`, `canvasMode/canvasFolder`):
- `auto` — discovers that category's file types across the whole workspace (docs: `.md`; diagrams: `.mmd` + `.md` with mermaid blocks; canvas: `.excalidraw`).
- `folder` — shows only files inside the category's configured folder (relative to workspace or absolute). Right-click a category → `docspace.configureCategory` opens the mode QuickPick; picking "Escolher pasta…" opens a folder dialog. Workspace-internal picks are stored relative; external folders are watched via `ExternalRootsWatcher` (one watcher per distinct external root).

Creating files: right-click menus per category (`dsCat_docs` → newMarkdown etc., `dsFolder` → all three). A category in folder mode creates straight into its folder; otherwise a folder dialog asks.

### Generated docs (`docGerada/`)

`docspace.regenerateDoc` (book icon in the panel header) runs `generateProjectDocs()` (`src/docGenerator.ts`): builds the project graph and writes `estrutura.md` (files grouped by detected role), `dependencias.md` (per-file imports + packages), `acoplamento.md` (coupling ranking table), `fluxos.md` (execution paths from entry points) into `docGerada/` at the workspace root, each headed with the generation date. The folder shows pinned at the top of the Docs category with a `sparkle` icon; its files use kind `genFile` (contextValues `dsGenFolder`/`dsGenFile` keep rename/delete/new menus away, and the commands also guard against those kinds). The normal scan excludes `docGerada` (see `DocspaceProvider.scanExclude`).

### Tree refresh & caching (`src/scanCache.ts`)

Discovery results (directory relevance, mermaid-block checks) are cached. A `FileSystemWatcher` scoped to `**/*.{md,mmd,excalidraw}` invalidates only the affected path (plus ancestors/descendants) via `provider.invalidate(uri)`; refreshes are debounced (300ms). `invalidatePath` also calls `invalidateGraphFile` so file changes invalidate the graph caches. Never wire broad listeners like `onDidSaveTextDocument` to a full refresh. Config changes to category modes/folders/exclude call `provider.refreshAll()`.

### Project graph (`src/projectGraph.ts` + `src/graphPanel.ts` + `media/graph.js`)

1. `buildProjectGraph()` collects code files via `findFiles` + `RelativePattern` (honours `docspace.exclude` + built-in extras like `bin`/`obj`/`__pycache__`/`vendor`, skips dot-folders, caps at 1500 files). Language detected by extension map (`EXT_LANG`); supported: TS/JS(+react), C#, Python, Go, Rust, Java, C/C++, Ruby, PHP, Swift, Kotlin. `extractImports(source, languageId)` has per-language patterns (JS/TS family, C# `using`/ProjectReference, Python, Go); other languages get file nodes without edges. Namespace-style bare specs (`System.IO`, `os.path`) don't become module nodes.
2. Node data includes `role` (detectRole: entry/controller/service/repository/model/util/other by filename heuristics; modules are `external`) and `isTest` (`.test.`/`.spec.`/test folders). Edges carry `weight` (repeat imports between a pair).
3. **Two cache layers**: per-file import cache validated by mtime, plus a full-graph cache keyed by all `fsPath:mtime` pairs — repeated opens with no changes return instantly. `invalidateGraphFile(uri)` (called from `scanCache.invalidatePath`) drops both.
4. The webview has **3 modes**: **Dependências** (fcose force layout, Obsidian-style dots colored per top folder, size by degree, hover spotlights the neighborhood), **Fluxo** (preset swimlane layout — fixed horizontal lanes per role, top→down; pill nodes, bezier arrow edges; tapping a node traces its downstream trail; lane labels are an HTML overlay synced to pan/zoom), **Impacto** (tap a file → its recursive importers highlight, rest dims). Common: entry points (no incoming imports) get an accent ring, edge width scales with weight, hide-tests checkbox, folder filter, search (Enter zooms; relayout debounced 400ms), single-tap opens files in Dependências / double-tap everywhere.
5. **Themes** (`docspace.graphTheme`): auto (follows VS Code), obsidian, blueprint, pastel, high-contrast. Selectable from the webview toolbar (persists via `setTheme` message → config) and reacts to config changes.
6. UMD chain: fcose needs `layout-base`/`cose-base` globals loaded first (pinned versions on jsdelivr). Flow mode uses a preset layout, so dagre is no longer needed.

### Preview flow (`src/previewPanel.ts` + `media/preview.js`)

1. `PreviewPanel.createOrShow()` opens the file natively (column One) + a live webview (column Two); `onDidChangeTextDocument` → `postMessage({ type:'update', content, embeds })` re-renders (~80ms debounce).
2. **References inside .md**: `![[file.mmd]]` renders the Mermaid diagram inline; `![[file.excalidraw]]` renders the canvas inline as SVG via `@excalidraw/utils` (pinned UMD, global `ExcalidrawUtils.exportToSvg`); missing refs show a warning box. The extension resolves refs relative to the document folder (`collectEmbeds`) and ships contents to the webview.
3. Relative links to `.md`/`.mmd`/`.excalidraw` are intercepted in the webview and posted back (`{type:'open', href}`) — the extension opens them (canvas files via `docspace.canvasEditor`).
4. Rendering: markdown-it (CDN) for `.md`, mermaid@11 (CDN), `@panzoom/panzoom` for diagram pan/zoom. Mermaid theme via `docspace.diagramTheme` (auto follows VS Code).

### Canvas editor flow (`src/canvasEditor.ts`)

`CanvasEditorProvider` is a `CustomTextEditorProvider` for `*.excalidraw`. Excalidraw is loaded as UMD **pinned to 0.17.6** (the last version with a UMD build — 0.18+ is ESM-only and 404s on the old URL); React 18.2.0 pinned likewise. Webview → document sync via debounced (500ms) `WorkspaceEdit.replace`; document → webview via `updateScene`. VS Code handles save/undo/dirty natively.

### Settings (`package.json → contributes.configuration`)

- `docspace.docsMode` / `docspace.docsFolder` — Docs category discovery (default `auto` / `""`)
- `docspace.diagramsMode` / `docspace.diagramsFolder` — Diagrams category
- `docspace.canvasMode` / `docspace.canvasFolder` — Canvas category
- `docspace.diagramTheme` — Mermaid theme: `auto` | `default` | `dark` | `forest` | `neutral` | `base`
- `docspace.graphTheme` — graph theme: `auto` | `obsidian` | `blueprint` | `pastel` | `high-contrast`
- `docspace.exclude` — folders to ignore (default `["node_modules", ".git", "out", "dist"]`)

### Tests

Mocha + `@vscode/test-cli`. Test files must match `**/*.test.ts` (compiled to `out/**/*.test.js`) to be discovered.
