# Docspace

Organize, preview, and understand your project's documentation, diagrams, and canvases — all inside VS Code. Docspace adds a dedicated sidebar, live previews, an interactive dependency graph, automatic documentation, and optional Notion sync.

## Features

### 📂 Dedicated sidebar

Browse your `.md`, `.mmd`, and `.excalidraw` files organized into three fixed categories — **Docs**, **Diagrams**, and **Canvas** — each with a relevant-file count badge. Every category has its own discovery mode:

- **`auto`** — finds that category's files across the whole workspace (Docs: `.md`; Diagrams: `.mmd` and `.md` with Mermaid blocks; Canvas: `.excalidraw`).
- **`folder`** — scopes the category to a single folder (inside or outside the workspace).

Right-click a category to switch modes, pick a folder, or create a new file. Sort files by name, modified date, or size.

### 👁️ Live preview

Open any Markdown or Mermaid file for a split-view preview that re-renders as you type. Inside Markdown you can embed other files:

- `![[diagram.mmd]]` renders the Mermaid diagram inline.
- `![[canvas.excalidraw]]` renders the canvas inline as SVG.

Long documents get an automatic, clickable table of contents, and every code block has a hover **Copy** button. Mermaid themes follow your selection (auto/default/dark/forest/neutral/base).

### 🎨 Excalidraw canvas editor

Open `.excalidraw` files in a full embedded Excalidraw editor with bidirectional sync — save, undo, and dirty state are handled natively by VS Code.

### 🕸️ Project Graph

Scan your code and explore it interactively (TS/JS, C#, Python, Go, Rust, Java, C/C++, Ruby, PHP, Swift, Kotlin) in three modes:

- **Dependencies** — force-layout import network, colored by folder.
- **Flow** — swimlanes by architectural role (entry/controller/service/repository/model/util).
- **Impact** — click a file to highlight everything that depends on it, with an adjustable depth.

Plus analysis tools: circular-dependency detection, shortest path between two files, edge detail (which imports create a dependency), folder clustering, a minimap, PNG/SVG export, and per-workspace persistence of node positions and colors. Five graph themes (auto/obsidian/blueprint/pastel/high-contrast).

### 📖 Automatic documentation

Generate a `docGerada/` folder describing your project — `index.md` (overview + a structural diff since the last run), `estrutura.md` (files by role), `dependencias.md` (imports per file), `acoplamento.md` (coupling ranking), and `fluxos.md` (paths from entry points). No AI involved — it's a structural analysis of your code.

### 🔄 Notion sync

Connect with a personal Internal Integration Token (stored in your user settings, never in the repo) to import Notion pages as Markdown, then pull/push to keep them in sync. Automatic polling detects remote changes and warns on conflicts. Uses Node's native `https` — no extra dependencies.

### 🌍 Localization

Available in English and Brazilian Portuguese (`pt-BR`), following the VS Code display language.

## Getting Started

After installing, open the **Getting Started with Docspace** walkthrough (Command Palette → *Welcome: Open Walkthrough…*) for a guided tour, or just open the Docspace view in the Activity Bar and create your first file.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `docspace.docsMode` | `"auto"` | Docs category discovery mode (`auto` or `folder`). |
| `docspace.docsFolder` | `""` | Folder used by the Docs category in `folder` mode. |
| `docspace.diagramsMode` | `"auto"` | Diagrams category discovery mode. |
| `docspace.diagramsFolder` | `""` | Folder used by the Diagrams category in `folder` mode. |
| `docspace.canvasMode` | `"auto"` | Canvas category discovery mode. |
| `docspace.canvasFolder` | `""` | Folder used by the Canvas category in `folder` mode. |
| `docspace.sortBy` | `"name"` | Sidebar file order: `name`, `modified`, or `size`. |
| `docspace.diagramTheme` | `"auto"` | Mermaid theme: `auto`, `default`, `dark`, `forest`, `neutral`, `base`. |
| `docspace.graphTheme` | `"auto"` | Project Graph theme: `auto`, `obsidian`, `blueprint`, `pastel`, `high-contrast`. |
| `docspace.notionToken` | `""` | Notion Internal Integration Token (stored at user scope). |
| `docspace.notionPollMinutes` | `5` | Auto-sync interval in minutes for linked Notion pages (`0` disables). |
| `docspace.exclude` | `["node_modules", ".git", "out", "dist"]` | Folders to ignore when scanning. |

## Commands

| Command | Description |
| --- | --- |
| `Docspace: Open Preview` | Open a file with a live preview alongside. |
| `Docspace: Open Project Graph` | Open the interactive dependency graph. |
| `Docspace: Regenerate Docs` | Generate/refresh the `docGerada/` documentation. |
| `Docspace: New Markdown File` / `New Mermaid Diagram` / `New Canvas` | Create a new file in the selected category/folder. |
| `Docspace: Change Diagram Theme` | Switch the Mermaid theme. |
| `Docspace: Sort Files` | Choose the sidebar sort order. |
| `Notion: Connect` / `Import Pages` / `Pull` / `Push` / `Disconnect` | Manage Notion sync. |

## Notion setup

1. Create an Internal Integration at <https://www.notion.so/my-integrations> and copy the token.
2. Run **Notion: Connect** and paste the token (saved to your user settings, not the repository).
3. Share the Notion pages you want with your integration, then run **Notion: Import Pages**.

## Release notes

See the **Changelog** tab on the extension page for the full history.

## License

Proprietary — free to use, all rights reserved. See the bundled `LICENSE.txt`.
