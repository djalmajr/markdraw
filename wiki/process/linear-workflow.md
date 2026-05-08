---
title: "Linear workflow"
audience: dev
sources:
  - in-session decision 2026-05-07
  - sibling reference: tmpay/planning/inbox-mvp/linear-guide.md
  - sibling reference: taskify/planning/linear-local-first/
updated: 2026-05-07
tags: [process, linear, planning, workflow]
status: stable
---

# Linear workflow

How AsciiMark plans, tracks, and executes work using Linear as the
single source of truth, with the wiki holding only durable knowledge
(architecture, decisions, conventions).

## Principle

**Linear is the source of truth for plans, work items, and execution
state.** The repository holds only:

- **Code** (`apps/`, `packages/`)
- **Living wiki** (`wiki/`) — architecture, decisions, processes,
  conventions, performance targets, release flows
- **No `planning/` folder.** No epic/story markdown shadow files. No
  copies of issue bodies in the repo.

When agents or humans need plan context, they query Linear (via MCP,
GraphQL, or the web UI). When they need durable knowledge, they read
the wiki.

## Hierarchy

```
Initiative: AsciiMark — Local-first technical writing
  └─ Project: <Epic name>
       ├─ Milestone: <intermediate checkpoint>
       └─ Issue: <Story>
            └─ Sub-issue: <only when task warrants own status/assignee>
```

| Linear entity | Maps to | Notes |
|---|---|---|
| **Initiative** | Product | One per product surface — currently only AsciiMark |
| **Sub-initiative** | Frente do produto | Not used yet. Promote when ≥2 frentes (Desktop, Extension, Site) have ≥3 active Projects each |
| **Project** | Epic / large feature | Has start/target dates, milestones, summary |
| **Project milestone** | Intermediate checkpoint inside an epic | Not the final delivery — that's the Project status itself |
| **Issue** | Story (1 vertical slice of value) | One issue per story. Body is self-contained |
| **Sub-issue** | Task with own assignee/status | Only when the task is independently planned. Otherwise use checkboxes in description |
| **Linear Document** | Long-form spec, business rule, runbook | Anchored to Project. Persists after epic closes |
| **Cycle** | Sprint / weekly batch | Issues are assigned to a cycle when picked up |
| **Label** | Cross-cutting filter | See [Labels](#labels) below |

## Decomposition

**1 issue = 1 story.** Tasks inside a story are checkboxes in the
description, not sub-issues — unless the task earns its own status
(parallel assignee, separate review cycle, distinct estimate).

Stories are decomposed by **vertical value slice**, not by technical
layer:

- ✅ "Inline edit assist on selection" — observable behavior, ships independently
- ❌ "Backend for inline edit assist" + "Frontend for inline edit assist" — useless half-builds

Each story should:

- Deliver something a user can observe
- Be reviewable in a single PR (or a small chain)
- Have unambiguous acceptance criteria

## Templates

### Project body (epic)

```markdown
## Contexto
2-4 linhas — por que este epic existe e qual ganho ele representa.

## Princípios arquiteturais
3-5 decisões inegociáveis que orientam todas as stories abaixo.
Linka ADRs em wiki/decisions/ quando aplicável.

## Artefatos relacionados
- Roadmap alto-nível: wiki/roadmap/<epic>.md
- Figma: <link>
- ADRs: wiki/decisions/NNN-*.md

## Escopo do MVP
Bullets do que entra. Out of scope explícito quando ambíguo.
```

### Issue body (story)

```markdown
> Source: wiki/<doc-relevante>.md § <seção>
> Figma: <node-id>

## Contexto
2-3 linhas — por que essa story existe, qual problema resolve, qual
posição no fluxo do epic.

## Escopo
Bullets curtos do que entra.
Out of scope explícito quando há ambiguidade.

## Acceptance criteria
- [ ] Critério mensurável 1
- [ ] Critério mensurável 2
- [ ] Sem regressão em <suite específica>

## Notas técnicas
Decisões já fechadas (linka ADRs).
Padrões a seguir.
```

### Milestone body

```markdown
Curto — uma frase do que esta milestone representa.

**Entregas:**
- Bullet 1
- Bullet 2

**Critério de fechamento:** uma frase mensurável.
```

## Labels

Workspace usa labels existentes do Linear (Feature, Improvement, Bug)
e adiciona um conjunto mínimo para filtros reais. Total ~10 labels —
suficiente para o tamanho atual. Não criar labels especulativas.

| Categoria | Labels | Uso |
|---|---|---|
| **Tipo** (Linear-native) | `Feature`, `Improvement`, `Bug` | Já existem |
| **Scope** | `scope:desktop`, `scope:extension`, `scope:site` | Substitui sub-initiatives até justificar volume |
| **Area** | `area:ai`, `area:ui`, `area:editor`, `area:preview`, `area:infra` | Filtro cross-project |
| **External** | `blocked-external` | Dependência fora do time (provider, stakeholder) |

Adicionar nova label só quando há um filtro real que ela viabiliza.
Labels não usadas em ≥3 issues são candidatos a remoção.

## Acceptance criteria

Toda story tem `## Acceptance criteria` com 3-7 checkboxes
**mensuráveis** na descrição (testes passam, comportamento X ocorre,
sem regressão em Y). Linear conta % concluído no peek/board.

Critérios em prosa longa (specs, business rules, runbooks) podem virar
**Linear Document** anexado à issue — caso raro, story body fica
enxuto e linka pro doc.

**Não há gate formal de revisor.** Nesse projeto solo, o fluxo é:
implementação termina → relato no chat o que foi entregue → recebo
ok/nok → fecho a issue (status → Done). Sem checkbox de "DoD
validado por reviewer", sem label de gate. O ato é a confirmação
direta.

## Fluxo end-to-end

| Evento | Ação |
|---|---|
| Nova feature surge | Cria Project no Linear, vincula à Initiative AsciiMark, escreve Project body usando o template |
| Decompor em stories | Cria Issues no Project com `blockedBy` quando aplicável, atribui Milestone, labels, prioridade |
| Decisão arquitetural fechada (não-negociável) | Cria ADR em `wiki/decisions/NNN-titulo.md` + linka da issue. Issue NÃO duplica conteúdo da ADR |
| Story entra no cycle | Issue ganha Cycle ativo + assignee, status → `In Progress` |
| PR aberto | Linear detecta automaticamente quando o título da PR contém o identifier (ex: `DJA-12: ...`) |
| Story fecha | Implementação relatada no chat → owner dá ok/nok → status → `Done` |
| Cycle fecha | Linear cycle review/retro acontecem nativamente |
| Project fecha | Marca state `Completed`. ADRs persistem mesmo após — vivem em `wiki/decisions/` |

## ADRs vs issues

| Conteúdo | Vai para |
|---|---|
| **Decisão técnica não-negociável** que persiste mesmo após o epic fechar | `wiki/decisions/NNN-titulo.md` |
| **Plano de execução** (o que vamos construir, quando, em que ordem) | Project + Issues no Linear |
| **Especificação de arquitetura** (como funciona) | `wiki/architecture/*.md` |
| **Convenção de processo** (como trabalhamos) | `wiki/process/*.md` (este doc é exemplo) |
| **Roadmap alto-nível** (visão de produto, não story-level) | `wiki/roadmap/*.md` |

Issues podem (e devem) **referenciar** ADRs e arquitetura, mas nunca
duplicar conteúdo. ADRs são imutáveis — se a decisão muda, criar nova
ADR que substitui (`Status: Superseded by NNN`).

## Sincronização repo ↔ Linear

**Sem snapshot, sem mapping file.** O repo não mantém uma cópia do
estado do Linear. Razão: snapshots ficam stale em horas, e ninguém
atualiza um arquivo só por disciplina. Quando alguém precisa do estado
de um Project, vai direto no Linear.

Excessão: ADRs e wiki technical docs **podem** linkar para o Linear
via URL (`https://linear.app/djalmajr/project/...`) quando isso ajuda
a contextualizar a decisão. Linear URLs são estáveis (slug + ID).

## Anti-patterns

- ❌ Criar pasta `planning/` no repo — duplica fonte e desatualiza
- ❌ Copiar body inteiro da issue para markdown — desatualiza rápido
- ❌ Issue gigante com checklist interno de 10 stories — perde
  estrutura nativa do Linear
- ❌ Sub-issues para tasks triviais — ruído no peek/board
- ❌ Pular acceptance criteria "porque é óbvio" — futuro-você não
  vai lembrar
- ❌ Decisão arquitetural escrita só em comentário de issue —
  morre quando o issue arquiva. ADR sempre

## Ownership rule

**Toda criação no Linear deve marcar `djalmajr@gmail.com` como
responsável** — `lead` em Projects, `assignee` em Issues. Default sem
exceções. O agente seta `lead: "me"` / `assignee: "me"` (resolvendo
para o usuário autenticado via API key) em todo `save_project` /
`save_issue` que cria.

Isso garante que toda issue em flight aparece em "My Issues" do
proprietário e que ninguém no time precisa adivinhar dono. Quando
houver colaboradores de fato, esta regra muda — até lá, default
absoluto.

## Ferramentas

- **MCP Linear** está disponível na configuração de Claude Code do
  agente — permite criar/atualizar Projects, Issues, Milestones,
  Documents, Labels via conversação. Initiative writes ainda não
  expostos pelo MCP — usar GraphQL via Bash quando necessário.
- **Convenção:** sempre citar a operação e aguardar confirmação
  antes de escrever no Linear (sistema compartilhado, ações são
  visíveis ao time/colaboradores).

## Relacionado

- [Decisions index](../decisions/README.md) — convenção e lista de ADRs
- [Wiki index](../index.md)
- Sibling references (não copiar daqui — referência conceitual):
  - `tmpay/planning/inbox-mvp/linear-guide.md`
  - `taskify/planning/linear-local-first/`
