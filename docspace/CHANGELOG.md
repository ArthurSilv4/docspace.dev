# Change Log

All notable changes to the "docspace" extension will be documented in this file.

## [0.0.4]

### Arquivos e edição
- Canvas (`.excalidraw`) com editor Excalidraw embutido; Markdown (`.md`) com preview ao vivo (~80ms); diagramas Mermaid (`.mmd`) com pan/zoom.
- Criação rápida, renomear e deletar pela sidebar.
- Referências dentro do `.md`: `![[arquivo.mmd]]` e `![[arquivo.excalidraw]]` renderizam inline no preview; links relativos para `.md`/`.mmd`/`.excalidraw` abrem no editor.
- Pasta `docGerada/` somente leitura, gerada do grafo (estrutura por camadas, dependências por arquivo, ranking de acoplamento, caminhos de execução, data de geração) via botão "Regenerar Doc".

### Sidebar
- 3 categorias fixas (Docs, Diagrams, Canvas), cada uma com modo próprio (auto / pasta) configurado por clique direito — pastas independentes entre si.
- Navegação hierárquica e atualização automática em criação/renome/deleção.

### Grafo do projeto
- 3 modos: **Dependências** (force layout, cor por pasta, tamanho por grau), **Fluxo** (faixas horizontais por papel — entry, controller, service, repository, model, util, externos — com trilha de execução ao clicar) e **Impacto** (clique propaga quem seria afetado).
- Entry points destacados, peso nos edges, toggle de testes, filtro por pasta, busca com zoom, abrir arquivo pelo nó.
- Linguagens: TypeScript, JavaScript, C#, Python, Go, Rust, Java, C/C++, Ruby, PHP, Swift, Kotlin.

### Customização
- Temas Mermaid: auto, default, dark, forest, neutral, base.
- Temas do grafo: auto, obsidian, blueprint, pastel, high-contrast.

### Removido
- Modo de descoberta global (`docspace.mode`/`docspace.rootFolder`) e scaffold `.docspace` — substituídos pelos modos por categoria.
