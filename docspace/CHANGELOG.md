# Change Log

All notable changes to the "docspace" extension will be documented in this file.

## [0.0.7] - 2026-06-13

### Adicionado
- Automação de release (`npm run release:patch`/`:minor`/`:major` + `release:finish`): bump de versão, seção de CHANGELOG, empacotamento do `.vsix`, commit e tag git.

### Alterado
- Preparação para o Marketplace: ícone PNG dedicado, categorias (Visualization), palavras-chave, licença proprietária e README reescrito.

## [0.0.6]

### Adicionado — Onboarding e identidade visual
- **Walkthrough** de introdução redesenhado em estilo line-art minimalista, alinhado ao ícone da extensão, com variantes para tema claro e escuro.
- **Internacionalização** (`vscode.l10n`): inglês e português do Brasil (`pt-BR`).

### Alterado
- A pasta `docGerada/` agora pode ser **excluída** pela sidebar (vai para a lixeira, recursivo). Os arquivos gerados individuais continuam somente leitura.

### Adicionado — Integração com Notion (token manual)
- **Conectar**: cola o Internal Integration Token nas configurações (escopo de usuário, fora do repositório); validado via `GET /v1/users/me`.
- **Importar**: busca páginas acessíveis, seleção múltipla, converte blocos → Markdown e salva `.md` na pasta escolhida; vincula o arquivo à página.
- **Pull/Push**: puxar atualiza o `.md` local; enviar converte o Markdown de volta em blocos e substitui o conteúdo da página.
- **Sync automático**: polling configurável (padrão 5 min) detecta mudanças no Notion e puxa; em conflito (edições locais + mudança remota) oferece "Ver diff" / "Sobrescrever".
- **Badge**: arquivos vinculados ganham um selo "N" na sidebar.
- Cliente HTTP sobre `https` nativo — sem dependências externas. Conversão bloco↔markdown coberta por testes.

## [0.0.5]

### Adicionado
- **docGerada/**: `index.md` com links + diff estrutural desde a última geração (arquivos e acoplamentos adicionados/removidos, sem IA).
- **Preview**: sumário automático (TOC) clicável para `.md` longos; botão "Copiar" em cada bloco de código.
- **Sidebar**: badge de contagem por categoria; ordenação por nome/modificação/tamanho.
- **Grafo — análise**: detecção de dependências circulares (botão Ciclos), caminho entre dois arquivos (botão Path), slider de profundidade no modo Impacto, painel de detalhe do edge (quais imports criam a dependência).
- **Grafo — export**: exportar como PNG e SVG.
- **Grafo — persistência**: arrastar nós salva a posição entre sessões; clique direito num nó abre paleta para pintá-lo (ex: "não mexer", "dívida técnica"); botão Reset limpa posições e cores manuais.
- **Grafo — clusters**: botão agrupa pastas com 6+ arquivos num único nó colapsável (clique no cluster para expandir).
- **Grafo — minimap**: minimapa no canto com retângulo de viewport; clique/arraste para reposicionar a vista.

### Pendente
- Integração com Notion (via token manual). É a única seção do spec ainda não implementada — o grafo está completo.

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
