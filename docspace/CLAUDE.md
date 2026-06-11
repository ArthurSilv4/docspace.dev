# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

```
docspace/
├── src/
│   ├── extension.ts          # Entry point — activate() registers commands, providers, watcher
│   ├── config.ts             # getConfig(), workspaceRoot(), resolveRootUri()
│   ├── treeItem.ts           # WorkspaceTreeItem, ItemKind, FilterKey
│   ├── fileFilter.ts         # isRelevantByName(), needsContentCheck(), isFileRelevant(), hasMermaidBlock()
│   ├── dirReader.ts          # readDirChildren(), hasRelevantContent()
│   ├── scanCache.ts          # discovery caches + per-path invalidation (invalidatePath, clearCaches)
│   ├── folderMode.ts         # folderModeChildren(), scaffoldFolderStructure()
│   ├── provider.ts           # DocspaceProvider (TreeDataProvider) — debounced refresh
│   ├── previewPanel.ts       # PreviewPanel — native editor + webview preview
│   ├── canvasEditor.ts       # CanvasEditorProvider — CustomTextEditorProvider for .excalidraw
│   └── test/
│       ├── scanCache.test.ts # Mocha tests — cache invalidation semantics
│       └── fileFilter.test.ts# Mocha tests — filename/filter matching
├── media/
│   ├── preview.js            # Webview JS: renders markdown/mermaid, receives live updates
│   ├── preview.css           # Webview CSS: typography, mermaid-container
│   ├── canvas.js             # Webview JS: initializes Excalidraw, bidirectional sync
│   └── canvas.css            # Webview CSS: full-screen Excalidraw container
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

## Architecture

- **Activation:** `onStartupFinished` — extension activates after VS Code finishes loading.
- **Entry point:** `src/extension.ts` — registers all commands and providers. All resources are pushed to `context.subscriptions`.
- **Commands:**
  - `docspace.openPreview` — opens the file in VS Code's native text editor (left column) and a live preview webview (right column).
  - `docspace.selectMode` — QuickPick to switch between `auto` and `folder` modes (gear icon in panel header); also offers "Escolher pasta…" which delegates to `selectRootFolder`.
  - `docspace.selectRootFolder` — folder dialog that points the tree at any folder on disk (folder-opened icon in panel header). Paths inside the workspace are stored relative in `docspace.rootFolder`; external folders are stored absolute and watched via an extra `RelativePattern` watcher (`ExternalRootWatcher`).
  - `docspace.selectDiagramTheme` — QuickPick to change the Mermaid diagram theme (color icon in panel header).
  - `docspace.newMarkdown` — creates a `.md` file in the target folder (right-click context menu on Docs categories and folders).
  - `docspace.newMermaid` — creates a `.mmd` file in the target folder (right-click on Diagrams categories and folders).
  - `docspace.newExcalidraw` — creates a `.excalidraw` file in the target folder (right-click on Canvas categories and folders).
  - `docspace.deleteFile` / `docspace.renameFile` — file management from the tree (inline trash icon / context menu).
- **Tree View:** panel "Docspace" in the Activity Bar (`docspace-sidebar` / `docspace.explorer`). Two modes:
  - `auto` — discovers `.md`, `.mmd` (and `.md` with Mermaid blocks), `.canvas`, and `.excalidraw` files across the entire workspace, organized under Docs / Diagrams / Canvas categories.
  - `folder` — uses `docspace.rootFolder` (default `.docspace/`, relative or absolute) as the source; subfolders become categories (scaffold names `docs`/`diagrams`/`canvas` always show; other folders only when they contain relevant content) and relevant files at the folder root are listed directly. Switching to folder mode scaffolds `docs/`, `diagrams/`, `canvas/` only when the root folder doesn't exist yet — existing folders are never modified. Category filterKey is inferred from folder name.
- **Hierarchical navigation:** folders are shown as expandable nodes. Only folders with relevant content (recursively) are shown. Folders in `docspace.exclude` are ignored.
- **Tree refresh & caching (`src/scanCache.ts`):** discovery results (directory relevance, mermaid-block checks) are cached. A `FileSystemWatcher` scoped to `**/*.{md,mmd,excalidraw}` invalidates only the affected path (plus its ancestors/descendants) via `provider.invalidate(uri)`; refreshes are debounced (300ms). Never wire broad listeners like `onDidSaveTextDocument` to a full refresh — that rescans the workspace on every save of any file. Config changes to `mode`/`rootFolder`/`exclude` call `provider.refreshAll()` (clears all caches).
- **Context menus:** right-clicking a category or folder shows creation commands filtered by type (`contextValue` on `WorkspaceTreeItem` drives the `when` clause).
- **Preview flow (`src/previewPanel.ts`):**
  1. `PreviewPanel.createOrShow()` calls `showTextDocument(uri, { viewColumn: One })`.
  2. A preview-only webview opens in `ViewColumn.Two`.
  3. `onDidChangeTextDocument` → `postMessage({ type: 'update', content })` → `media/preview.js` re-renders (~80ms).
  4. Saving is handled natively by VS Code.
- **Canvas editor flow (`src/canvasEditor.ts`):**
  1. `CanvasEditorProvider` is registered as `CustomTextEditorProvider` for `*.excalidraw` files.
  2. `resolveCustomTextEditor()` builds a webview with Excalidraw loaded from CDN (`cdn.jsdelivr.net`).
  3. `onDidChangeTextDocument` → `postMessage({ type: 'update' })` → Excalidraw updates scene.
  4. Excalidraw `onChange` (debounced 500ms) → `postMessage({ type: 'change' })` → `WorkspaceEdit.replace` writes JSON back to document.
  5. VS Code handles save, undo/redo, dirty state natively.
- **Webview rendering:**
  - `media/preview.js`: markdown-it (CDN) for `.md`, mermaid@11 (CDN) for `.mmd`/fenced blocks, `@panzoom/panzoom` (CDN) for diagram pan/zoom.
  - `media/canvas.js`: Excalidraw UMD (CDN) via `window.ExcalidrawLib`. No bundling required.
- **Settings** (`package.json → contributes.configuration`):
  - `docspace.mode` — `"auto"` | `"folder"` (default: `"auto"`)
  - `docspace.rootFolder` — path relative to the workspace root, or an absolute path to any folder on disk (default: `".docspace"`)
  - `docspace.exclude` — folders to ignore (default: `["node_modules", ".git", "out", "dist"]`)
  - `docspace.diagramTheme` — Mermaid theme: `"auto"` | `"default"` | `"dark"` | `"forest"` | `"neutral"` | `"base"` (default: `"auto"`)
- **Tests** use Mocha + `@vscode/test-cli`. Test files must match `**/*.test.ts` (compiled to `**/*.test.js` in `out/`) to be discovered.
