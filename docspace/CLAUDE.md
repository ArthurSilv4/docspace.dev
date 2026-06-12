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
│   ├── notionConvert.ts      # Pure block↔markdown conversion (blocksToMarkdown, markdownToBlocks)
│   ├── notionClient.ts       # NotionClient — REST over Node https (search, blockTree, replaceContent)
│   ├── notion.ts             # NotionManager — connect/import/pull/push, polling, file-decoration badge
│   └── test/
│       ├── scanCache.test.ts # Mocha tests — cache invalidation semantics
│       ├── fileFilter.test.ts# Mocha tests — filename/filter matching
│       ├── projectGraph.test.ts # Mocha tests — import extraction/resolution, roles, test detection
│       └── notionConvert.test.ts # Mocha tests — block↔markdown conversion
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

`docspace.regenerateDoc` (book icon in the panel header) runs `generateProjectDocs(context)` (`src/docGenerator.ts`): builds the project graph and writes `index.md` (links to all generated docs + a structural diff vs. the previous run), `estrutura.md` (files grouped by detected role), `dependencias.md` (per-file imports + packages), `acoplamento.md` (coupling ranking table), `fluxos.md` (execution paths from entry points) into `docGerada/` at the workspace root, each headed with the generation date. The previous run's structural snapshot (`{files, couplings}`) is persisted in `context.globalState` keyed by workspace path; `diffSnapshots` produces added/removed files and couplings (pure data comparison, no AI). The folder shows pinned at the top of the Docs category with a `sparkle` icon; `index.md` is pinned first among generated files; its files use kind `genFile` (contextValues `dsGenFolder`/`dsGenFile` keep rename/delete/new menus away, and the commands also guard against those kinds). The normal scan excludes `docGerada` (see `DocspaceProvider.scanExclude`).

Category items carry a **badge** (`item.description` = relevant file count via `countRelevantFiles`). Files are sorted by `docspace.sortBy` (`name`/`modified`/`size`; modified & size stat each file); the `docspace.selectSort` command (sort icon in header) picks it.

### Tree refresh & caching (`src/scanCache.ts`)

Discovery results (directory relevance, mermaid-block checks) are cached. A `FileSystemWatcher` scoped to `**/*.{md,mmd,excalidraw}` invalidates only the affected path (plus ancestors/descendants) via `provider.invalidate(uri)`; refreshes are debounced (300ms). `invalidatePath` also calls `invalidateGraphFile` so file changes invalidate the graph caches. Never wire broad listeners like `onDidSaveTextDocument` to a full refresh. Config changes to category modes/folders/exclude call `provider.refreshAll()`.

### Project graph (`src/projectGraph.ts` + `src/graphPanel.ts` + `media/graph.js`)

1. `buildProjectGraph()` collects code files via `findFiles` + `RelativePattern` (honours `docspace.exclude` + built-in extras like `bin`/`obj`/`__pycache__`/`vendor`, skips dot-folders, caps at 1500 files). Language detected by extension map (`EXT_LANG`); supported: TS/JS(+react), C#, Python, Go, Rust, Java, C/C++, Ruby, PHP, Swift, Kotlin. `extractImports(source, languageId)` has per-language patterns (JS/TS family, C# `using`/ProjectReference, Python, Go); other languages get file nodes without edges. Namespace-style bare specs (`System.IO`, `os.path`) don't become module nodes.
2. Node data includes `role` (detectRole: entry/controller/service/repository/model/util/other by filename heuristics; modules are `external`) and `isTest` (`.test.`/`.spec.`/test folders). Edges carry `weight` (repeat imports between a pair).
3. **Two cache layers**: per-file import cache validated by mtime, plus a full-graph cache keyed by all `fsPath:mtime` pairs — repeated opens with no changes return instantly. `invalidateGraphFile(uri)` (called from `scanCache.invalidatePath`) drops both.
4. The webview has **3 modes**: **Dependências** (fcose force layout, Obsidian-style dots colored per top folder, size by degree, hover spotlights the neighborhood), **Fluxo** (preset swimlane layout — fixed horizontal lanes per role with alternating bands as an HTML overlay synced to pan/zoom; nodes ordered by barycenter and wrapped into sub-rows; pill nodes, bezier arrow edges; tapping a node traces its downstream trail), **Impacto** (tap a file → its recursive importers highlight, rest dims; a depth slider caps propagation at 1–5 levels or all). Common: entry points (no incoming imports) get an accent ring, edge width scales with `weight`, hide-tests checkbox, folder filter, search (Enter zooms; relayout debounced 400ms), single-tap opens files in Dependências / double-tap everywhere.
   - **Análise**: tap an edge → detail panel listing the actual import specifiers (`edge.data.specs`); **Ciclos** button highlights circular dependencies (Tarjan SCC over import edges, red); **Path** button picks two files → shortest path via `dijkstra` (directed).
   - **Persistência** (per workspace, `context.workspaceState` keyed by root): dragging a node in Dependências saves its position (`dragfree`); right-click a node → color menu paints it (`savedState.colors`, overrides `baseColor`). Both round-trip via `persistState` messages (debounced 600ms); **Reset** clears them. The webview receives `saved` in the graph message and reapplies positions on `layoutstop` + colors via `data(color)`.
   - **Export**: **PNG** (`cy.png()`) / **SVG** (`cy.svg()` from the `cytoscape-svg` UMD plugin) → data posted to the extension, which writes it via a save dialog.
   - **Clusters**: toggle collapses each top folder with ≥6 files into one `cluster` node (`clusterGraph()` reroutes/merges edges client-side, no plugin); tap a cluster to expand just it. **Minimap**: a custom `<canvas>` overview (no plugin) drawing scaled node dots + edges + a viewport rectangle, redrawn via rAF on pan/zoom/position; click or drag it to recenter. Toggle with the Mapa button.
5. **Themes** (`docspace.graphTheme`): auto (follows VS Code), obsidian, blueprint, pastel, high-contrast. Selectable from the webview toolbar (persists via `setTheme` message → config) and reacts to config changes.
6. UMD chain: fcose needs `layout-base`/`cose-base` globals loaded first (pinned versions on jsdelivr). Flow mode uses a preset layout, so dagre is no longer needed.

### Preview flow (`src/previewPanel.ts` + `media/preview.js`)

1. `PreviewPanel.createOrShow()` opens the file natively (column One) + a live webview (column Two); `onDidChangeTextDocument` → `postMessage({ type:'update', content, embeds })` re-renders (~80ms debounce).
2. **References inside .md**: `![[file.mmd]]` renders the Mermaid diagram inline; `![[file.excalidraw]]` renders the canvas inline as SVG via `@excalidraw/utils` (pinned UMD, global `ExcalidrawUtils.exportToSvg`); missing refs show a warning box. The extension resolves refs relative to the document folder (`collectEmbeds`) and ships contents to the webview.
3. Relative links to `.md`/`.mmd`/`.excalidraw` are intercepted in the webview and posted back (`{type:'open', href}`) — the extension opens them (canvas files via `docspace.canvasEditor`).
4. Rendering: markdown-it (CDN) for `.md`, mermaid@11 (CDN), `@panzoom/panzoom` for diagram pan/zoom. Mermaid theme via `docspace.diagramTheme` (auto follows VS Code).
5. **TOC**: `.md` with ≥3 `##`/`###` headings gets a clickable table of contents inserted at the top (smooth-scroll). **Copy button**: every non-mermaid `<pre>` gets a hover "Copiar" button (`navigator.clipboard`).

### Canvas editor flow (`src/canvasEditor.ts`)

`CanvasEditorProvider` is a `CustomTextEditorProvider` for `*.excalidraw`. Excalidraw is loaded as UMD **pinned to 0.17.6** (the last version with a UMD build — 0.18+ is ESM-only and 404s on the old URL); React 18.2.0 pinned likewise. Webview → document sync via debounced (500ms) `WorkspaceEdit.replace`; document → webview via `updateScene`. VS Code handles save/undo/dirty natively.

### Notion integration (`src/notion.ts` + `notionClient.ts` + `notionConvert.ts`)

Manual-token approach (no OAuth, no embedded secret): the user pastes an Internal Integration Token into `docspace.notionToken` (stored at `application` scope — user profile, never the repo). `NotionManager` (instantiated in `activate`, refreshes the tree on change) registers commands `notionConnect`/`notionImport`/`notionPull`/`notionPush`/`notionDisconnect`.

- **Import**: `searchPages` → multi-pick → `blockTree` (recursive, capped at depth 3) → `blocksToMarkdown` → write `.md` into a chosen folder → record a `NotionLink` `{notionId, fsPath, title, lastEditedTime, hash}` in `workspaceState`.
- **Pull/push**: pull overwrites local from the page (`markdownToBlocks` is the inverse for push, which `replaceContent` does by deleting existing children then appending). Both update the link's `lastEditedTime` + content `hash`.
- **Conflict**: before overwriting on pull, `hasLocalEdits` compares the file's current sha1 with the stored `hash`; on a clash the user gets Ver diff / Sobrescrever (diff via `vscode.diff` against a temp file in `globalStorageUri`).
- **Polling**: every `docspace.notionPollMinutes` (default 5; 0 disables), each linked page's `last_edited_time` is checked and pulled if it changed.
- **Badge**: a `FileDecorationProvider` puts an `N` badge on linked files. `NotionClient` uses Node `https` only — no external dependency; `Notion-Version: 2022-06-28`.

### Settings (`package.json → contributes.configuration`)

- `docspace.docsMode` / `docspace.docsFolder` — Docs category discovery (default `auto` / `""`)
- `docspace.diagramsMode` / `docspace.diagramsFolder` — Diagrams category
- `docspace.canvasMode` / `docspace.canvasFolder` — Canvas category
- `docspace.sortBy` — sidebar file order: `name` | `modified` | `size`
- `docspace.diagramTheme` — Mermaid theme: `auto` | `default` | `dark` | `forest` | `neutral` | `base`
- `docspace.graphTheme` — graph theme: `auto` | `obsidian` | `blueprint` | `pastel` | `high-contrast`
- `docspace.notionToken` — Notion Internal Integration Token (application scope)
- `docspace.notionPollMinutes` — Notion auto-sync interval in minutes (0 disables)
- `docspace.exclude` — folders to ignore (default `["node_modules", ".git", "out", "dist"]`)

The entire expanded spec is now implemented.

### Tests

Mocha + `@vscode/test-cli`. Test files must match `**/*.test.ts` (compiled to `out/**/*.test.js`) to be discovered.
