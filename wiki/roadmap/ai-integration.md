---
title: "Integração com IA — painel lateral multi-provider"
audience: mixed
sources:
  - in-session brainstorm 2026-05-06
updated: 2026-05-06
tags: [roadmap, ai, providers, rag, chat, business-idea, high-priority]
status: draft
---

# Integração com IA — painel lateral multi-provider

**Status**: ideia de negócio altamente desejada. Não está implementada;
esta página captura proposta, escopo, diferenciadores e tradeoffs antes
de qualquer execução.

## Posicionamento (decidido)

**AsciiMark for technical writing / wiki / documentation —
local-first, workspace-aware, AI-native.**

Não competir com Cursor em edit assist genérico de código. Nichar em
**docs / wikis técnicas / knowledge bases** onde:

- O grafo de citações entre arquivos é o ativo principal (já temos:
  backlinks, workspace symbols, file index).
- A identidade local-first é diferencial sustentável (Ollama como
  cidadão de primeira classe).
- Renderização rica (mermaid, kroki, KaTeX) já está no app — geração
  de diagramas via IA encaixa de graça.
- Cursor não cobre esse caso bem; Obsidian Smart Connections faz
  semântico cego sem citar; Notion AI é cloud-only e não local-first.

Esse posicionamento informa todas as decisões abaixo: priorize features
que **só fazem sentido pra docs**, deixe pra trás features que seriam
"mais um cliente de chat de IA".

## Proposta de uma frase

Adicionar um painel lateral à direita (3º segment ao lado de
`Summary | References | AI`) que conecta a múltiplos providers de
LLM e oferece chat workspace-aware, edit assist inline e geração de
diagramas — mantendo a identidade local-first via opção Ollama e
citações cruzadas usando o índice de backlinks/symbols já existente.

## Por que faz sentido pra AsciiMark

| Identidade do app | Como a IA amplifica |
|---|---|
| Local-first, files no disco do usuário | Ollama / modelo local como cidadão de primeira classe; cloud é opt-in |
| Workspace-aware (file index, backlinks, symbols) | RAG com citações usando o **mesmo grafo** que já alimenta o painel References |
| Renderização rica (mermaid, kroki, KaTeX) | Diagram-from-text como demo killer dentro de blocos `[mermaid]` |
| Keyboard-first | Comandos de IA na palette (`Cmd/Ctrl+Shift+P`), edit assist via shortcut |
| Tabs estilo VSCode + split panes | Chat threads se comportam como tabs; possível "Open chat in pane 2" |

## Tier 1 — diferenciadores (alto ROI, fits a identidade)

### 1. Workspace-aware chat com RAG

Pergunta no painel responde citando arquivos com `path:line` clicáveis
(mesmo padrão do Find in Files). Aproveita:
- `flattenWorkspace` (já temos)
- backlink index (já temos)
- workspace symbols index (já temos)
- adicionar: embeddings index incremental, rebuilt junto do backlink
  index quando `rootsList` muda

**Diferencial**: Cursor não cobre docs profundamente; Obsidian Smart
Connections faz semântico cego. RAG citado em wiki técnica é nicho
sub-servido.

### 2. Inline edit assist

Selecionar texto no editor → comando palette (`rewrite`, `explain`,
`translate`, `summarize`, `fix grammar`). Standard pattern; baixa
fricção. CodeMirror já expõe seleção via API.

### 3. Diagram-from-text

Dentro de um bloco `[mermaid]` vazio (ou ` ```mermaid `), `Cmd/Ctrl+I`
abre prompt natural language → mermaid source. Encaixa porque já
renderizamos mermaid; vira o screenshot mais memorável da release.

## Tier 2 — multiplicadores

### 4. Local-first AI (Ollama)

Provider local como default opt-in. UX deixa óbvio qual provider está
ativo + indicador de privacidade (cloud vs local). Argumento de venda
forte vs. competidores cloud-only.

### 5. Semantic backlinks

Além dos backlinks textuais, sugerir "docs relacionados por
significado" via embeddings. Surface num expandable na aba References.
Pra wikis e notas é killer feature.

### 6. Document summarization

TL;DR cacheado por hash do arquivo, mostrado no status bar (ao lado
do `X words · Y min`) ou em tooltip ao hover. Util pra navegar workspace
grande sem abrir cada doc.

### 7. Translation pipeline

Abre aba "Traduzir → `<locale>`" que gera `*.<locale>.adoc` ao lado
do original. Bonus: resolve em parte o tech debt do site não
traduzido — ver
[i18n architecture § Technical debt](../architecture/i18n.md#technical-debt).

## Tier 3 — esticam o escopo

### 8. Threads múltiplas por workspace

Salvas em `notes/` como markdown legível. Não cria lock-in com o app
— se o usuário sair, as conversas continuam consumíveis em qualquer
viewer markdown.

### 9. Memory across sessions

IA lembra dos arquivos editados recentemente como contexto implícito.
Cuidado com quota de contexto e privacidade.

### 10. Context window UI

Mostra quais arquivos estão na janela de contexto atual. Transparência
local-first reforça a identidade do app.

## Arquitetura proposta

### Pacote core

`packages/core/src/ai/`:
- `providers.ts` — abstração: `Provider`, `Model`, `chat(messages)`,
  `embed(text)`, `complete(prompt)`. Implementações: OpenAI,
  Anthropic, Ollama, OpenRouter, custom URL.
- `embeddings.ts` — index incremental, mesmo ciclo de rebuild do
  `buildBacklinkIndex` no `rootsList` effect.
- `rag.ts` — query → retrieve top-K chunks → format prompt com
  citações.
- `prompts.ts` — templates pra inline edit assist (rewrite, explain,
  …).

### UI

`packages/ui/src/components/`:
- `ai-panel.tsx` — chat surface. Drop no `TocPanel` como 3º
  `<TabsTrigger>` (`Summary | References | AI`).
- `ai-message.tsx` — render de mensagem com cited files clicáveis.
- `ai-inline-actions.tsx` — palette de ações sobre seleção.
- `ai-settings.tsx` — providers, modelos, API keys.

Alternativa: painel **inferior** estilo VSCode terminal (toggleável
via `Cmd/Ctrl+J`). Decidir entre right-gutter (compacto, sempre
visível) e bottom-panel (chat conversacional grande, mais espaço pro
output) é decisão de UX do MVP.

### Storage

- API keys: Tauri secure storage (OS keychain). Nunca em
  localStorage.
- Embeddings cache: `~/.cache/asciimark/embeddings/<workspace-hash>.sqlite`.
  Rebuild incremental quando arquivos mudam.
- Chat threads: arquivos markdown em `<workspace>/.asciimark/chats/`
  ou `<workspace>/notes/chats/` — escolher um path discoverable mas
  fora do gitignore default.

### Comandos / atalhos

A regra das três superfícies se aplica
([keyboard-shortcuts](../architecture/keyboard-shortcuts.md)):

| Atalho proposto | Ação |
|---|---|
| `Cmd/Ctrl+J` | Toggle painel AI (similar Cursor) |
| `Cmd/Ctrl+I` | Inline edit assist na seleção |
| `Cmd/Ctrl+Shift+I` | Workspace chat — pergunta sobre o workspace |
| `Cmd/Ctrl+K` | Quick AI command palette (sub-palette) |

Validar contra a tabela de [teclas reservadas pelo SO](../architecture/keyboard-shortcuts.md#teclas-reservadas-pelo-so--sempre-tenha-um-fallback)
antes de bindar.

## Tradeoffs e decisões a tomar

### All-in em "Cursor para technical writing" (decidido)

Posicionamento confirmado — ver seção [Posicionamento](#posicionamento-decidido)
acima. Nichar em wiki / docs / technical writing.

Tradeoff descartado: paridade geral com Cursor. Comoditiza, e Cursor
já é o estado da arte em edit assist code — não há vantagem competir
ali. Nicho preserva identidade clara, RAG citado em workspace de
docs vira USP, e Tier 1 (chat workspace-aware + diagram-from-text)
fica como exclusividade real.

### MVP scope

Implementar tudo é meses. Sugestão de fatia mínima:

1. Provider abstraction com Anthropic + OpenAI + Ollama (config UI
   pra API keys).
2. Painel AI no right gutter como 3º segment.
3. Workspace chat com RAG simples (top-K com BM25 + cosseno; sem
   reranker LLM ainda).
4. Inline edit assist com 4 ações: rewrite, explain, summarize, fix
   grammar.
5. Diagram-from-text dentro de bloco mermaid vazio.

Pular no MVP: semantic backlinks, summarization automática,
translation pipeline, threads múltiplas, memory across sessions,
context window UI. Cada um vira release de minor bump separado.

### Privacidade e custo

- API keys do usuário, nunca compartilhadas. Default = sem provider
  configurado, painel mostra setup.
- Telemetria zero — fits local-first identity.
- Custo: usuário paga ao provider direto. AsciiMark não é
  intermediário.
- Para Ollama users (sem custo cloud), experiência idêntica.

## Métricas de sucesso

Que sinalizam o feature está agregando valor (pra revisitar
trimestralmente):

- DAU usando painel AI ÷ DAU total > 30%
- Cobertura de workspace com embeddings cacheados > 60% das pastas
  abertas
- Inline edit assist invocado > 5×/sessão entre usuários ativos
- Diagram-from-text usado em > 20% das sessões com mermaid

## Riscos

- **API keys vazando**: mitigar com OS keychain via Tauri secure
  storage. Auditar caminhos de log.
- **Quotas e cost surprise**: UX honesta sobre tokens consumidos e
  preview de custo antes de calls grandes.
- **Output qualidade variável entre providers**: documentar em
  `wiki/architecture/ai-providers.md` qual provider para qual caso.
- **Complexity creep**: o painel pode virar "mini IDE de IA". Cap o
  MVP em 5 ações; adicionar mais só com sinal claro do uso.

## Próximos passos sugeridos

1. Validar com 3-5 usuários potenciais (entrevista) o tradeoff
   nicho vs paridade — confirmar que workspace-aware chat + diagrams
   é diferencial percebido.
2. Sketch de UI do painel + flow de configuração de providers.
3. Issue de epic no GitHub agrupando o MVP em N stories
   independentes.
4. Spike técnico: medir custo/latência de embeddings de workspace
   típico (1000-10000 docs).

## Relacionado

- [Preview pipeline](../architecture/preview-pipeline.md) — onde
  diagram-from-text precisaria injetar source antes do swap pra
  articleRef.
- [Keyboard shortcuts — three-source rule](../architecture/keyboard-shortcuts.md)
  — todo atalho novo de IA respeita catalog + handler + palette.
- [i18n architecture § Technical debt](../architecture/i18n.md#technical-debt)
  — translation pipeline (Tier 2 ítem 7) ataca essa pendência.
