# Docspace

A VS Code extension that organizes your documentation, diagrams, and canvas files in a dedicated sidebar panel with live preview.

## Features

- **Sidebar panel** — browse `.md`, `.mmd`, and `.excalidraw` files organized under Docs, Diagrams, and Canvas categories.
- **Live preview** — open any Markdown or Mermaid file to see a rendered preview that updates as you type (~80ms).
- **Excalidraw canvas editor** — open `.excalidraw` files in a full embedded Excalidraw editor with bidirectional sync.
- **Two modes:**
  - `auto` — discovers documentation files across the entire workspace.
  - `folder` — scopes to a single root folder (default `.docspace/`) with `docs/`, `diagrams/`, and `canvas/` subfolders created automatically.
- **Diagram themes** — switch Mermaid diagram themes (auto, default, dark, forest, neutral, base) from the panel header.
- **Quick file creation** — right-click any category or folder to create a new `.md`, `.mmd`, or `.excalidraw` file.
- **Pan & zoom** — Mermaid diagrams support pan and zoom via `@panzoom/panzoom`.

## Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `docspace.mode` | `"auto"` | `"auto"` to scan the whole workspace, `"folder"` to use a single root folder. |
| `docspace.rootFolder` | `".docspace"` | Relative path to the root folder used in `folder` mode. |
| `docspace.exclude` | `["node_modules", ".git", "out", "dist"]` | Folders to ignore when scanning for files. |
| `docspace.diagramTheme` | `"auto"` | Mermaid diagram color theme. |

## Commands

| Command | Description |
| --- | --- |
| `Docspace: Open Preview` | Open the file in the editor with a live preview alongside. |
| `Docspace: Select Mode` | Switch between `auto` and `folder` modes. |
| `Docspace: Select Diagram Theme` | Change the Mermaid diagram theme. |
| `Docspace: New Markdown File` | Create a new `.md` file in the selected folder. |
| `Docspace: New Mermaid File` | Create a new `.mmd` file in the selected folder. |
| `Docspace: New Excalidraw File` | Create a new `.excalidraw` file in the selected folder. |

## Release Notes

### 0.0.1

Initial release — sidebar panel, live Markdown/Mermaid preview, Excalidraw canvas editor, auto and folder modes.
