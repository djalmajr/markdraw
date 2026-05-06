---
title: "Pipeline de renderização do Preview"
audience: dev
sources:
  - repo:./packages/ui/src/components/preview.tsx
  - repo:./packages/ui/src/components/app-shell.tsx
  - repo:./packages/ui/src/composables/create-app-state.ts
updated: 2026-05-06
tags: [preview, mermaid, kroki, toc, rendering, asciidoc, markdown]
status: stable
---

# Pipeline de renderização do Preview

O `<Preview>` (em `packages/ui/src/components/preview.tsx`) recebe HTML
sanitizado vindo do conversor (`asciidoctor` ou `markdown-it`), aplica
pós-processamentos assíncronos (highlight de código, mermaid, kroki) e
sincroniza o TOC. Esta página descreve as decisões que dão origem ao
pipeline atual e os bugs que cada passo evita.

## Ordem do pipeline (caminho new-document)

```
html cru
  └─ DOMParser sanitize (sanitizeHtmlFragment)
       └─ injeta no buffer DOM detached
            └─ wrapTablesForScroll  ← buffer
            └─ rewriteImageSources  ← buffer
            └─ highlightCodeBlocks  ← buffer  (pure DOM, ok detached)
                 └─ replaceChildren  → articleRef (ATTACHED)
                      └─ afterSwap   (move #toc, opacity, scrollTop)
                           └─ nextPaintFrame  ← layout settle
                                └─ renderMermaidBlocks  ← attached
                                     └─ renderKrokiBlocks  ← attached
```

A regra que rege essa ordem: **mermaid e kroki precisam que o
`<article>` esteja attached ao `document` ANTES de rodarem**. Os dois
criam containers temporários em `document.body`, leem `getBoundingClientRect`
para medir nodes e fontes, e a primeira renderização contra um
elemento detached (ou contra layout não estabilizado) joga o erro
clássico:

```
null is not an object (evaluating 'element.firstChild')
```

Mermaid lazy-carrega módulos por shape. A primeira chamada com uma
shape nova mede um SVG zerado, e o renderer interno tenta acessar
`firstChild` num node que ainda não foi inserido.

## Pré-aquecimento do mermaid (`ensureMermaidWarm`)

Promise singleton no escopo do módulo. Resolve uma vez por sessão e
toda chamada subsequente é no-op. Sequência:

1. `initMermaid()` — chama `mermaid.initialize` se ainda não inicializado.
2. `await document.fonts.ready` — fontes estabilizadas (mermaid mede
   text width pra dimensionar nodes).
3. Render descartável de um diagrama **kitchen-sink** que exercita as
   shapes mais comuns (`box`, `rounded`, `diamond`, `cylinder`,
   `stadium`, edges com label). Um pre-warm trivial (`A-->B`) NÃO é
   suficiente — a primeira render real de um shape novo continua
   tropeçando no race do `firstChild` mesmo após pre-warm trivial.
4. Cleanup dos `dmermaid-*` divs deixados pelo render de pré-aquecimento.

## Estratégia de retry por bloco

Mesmo com pre-warm + DOM attached + paint frame, o primeiro mermaid
de uma nova rota ocasionalmente flaka. O loop de blocos faz **2
tentativas com backoff de paint frame**:

```ts
for (let attempt = 0; attempt < 2; attempt++) {
  if (isStale(gen)) return;
  const id = attempt === 0 ? baseId : `${baseId}-retry`;
  try {
    const result = await mermaid.render(id, source);
    if (result?.svg) { svg = result.svg; break; }
    lastErr = new Error("mermaid render returned empty svg");
  } catch (err) {
    lastErr = err;
  }
  await nextPaintFrame();
}
if (!svg) throw lastErr ?? new Error("…");
```

**Empty SVG conta como falha leve.** Mermaid já foi observado
resolvendo com `{ svg: "" }` em vez de lançar — o retry recupera; sem
o check, o bloco acaba renderizado em branco.

## Falsos passos descartados

- ❌ **`initMermaid(true)` no início de `renderMermaidBlocks`.** Era
  chamado pra "resetar parser/registry state". Resultado: jogava fora
  o pre-warm e reintroduzia o race do `firstChild` no primeiro bloco.
  Hoje só re-inicializa quando o tema dark/light muda (via
  MutationObserver no `onMount` que zera o flag).
- ❌ **Rodar mermaid no buffer detached + retry-only.** Pre-warm não
  ajuda quando o articleRef ainda não está no documento; mermaid mede
  contra um container fora do layout tree.
- ❌ **Retry sem delay.** `setTimeout(0)` ou `Promise.resolve()` não
  esperam paint frame — o layout ainda não convergiu na hora do retry.

## Sincronia TOC ↔ scroll do preview

O TOC à direita é movido para um container compartilhado pelo
`AppShell`. O highlight do item ativo é calculado por
`setupTocScrollTracking` (em `preview.tsx`), que escuta o scroll de
`.content` e ativa o link cujo heading está no topo da viewport.

### Navegação cross-file (Workspace Symbol Search)

Quando o usuário clica num símbolo na palette workspace-wide, o handler
no AppShell faz **dois disparos** em paralelo:

1. `s.setPendingHeadingText(symbol.heading.text)` — lido pelo
   `Preview`'s `afterSwap`, que percorre `h1-h6` do article por
   `textContent.trim() === heading.text` e faz smooth scroll.
2. `pane.setScrollToLine(line)` — atualiza scroll do CodeMirror via
   o setter exposto pelo `PaneView`.

O scroll do preview (1) dispara o listener de
`setupTocScrollTracking`, que **automaticamente** atualiza
`.toc-active` no link correspondente do TOC. **Não há código
explícito atualizando `.toc-active` na navegação** — é o efeito
colateral do scroll programático.

Por que dois disparos: o usuário pode estar em `edit`, `split` ou
`preview`. Editor-only ignora (1); preview-only ignora (2); split usa
ambos. Mantém um único caminho de navegação cobrindo os 3 modos.

### Anti-pattern

Setar **só** `setScrollToLine` no clique de um workspace symbol em
modo preview deixa o TOC active highlight no heading errado — o
scroll do preview não muda, então o tracker continua reportando o
heading no topo do scroll antigo. O `pendingHeadingText` é o que
fecha o loop.

## Relacionado

- [Round 5 — module-level state × multiple component instances](../testing/strategies.md#round-5--module-level-mutable-state--multiple-component-instances)
  — outro bug do mesmo `Preview` (split panes compartilhando
  `renderGen` global), resolvido escopando estado por instância.
- [Atalhos de teclado — regra das três superfícies](./keyboard-shortcuts.md)
  — onde vivem os comandos que disparam navegação cross-file
  (Workspace Symbol Search = `Cmd+Alt+O`).
