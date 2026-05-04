# Testing Strategies

Análise das estratégias de teste aplicáveis a este projeto, ordenadas por
encaixe real e ROI. O objetivo é robustez e confiabilidade através de
**diversidade de técnicas**: cada uma encontra uma classe diferente de
bugs.

## Por que diversidade

Durante uma investigação de performance no markdown converter, três bugs
não relacionados foram encontrados como efeito colateral:

1. `convertMarkdown` re-parseava o input duas vezes (perf bug, achado
   profilando plugins individualmente).
2. `apps/extension/src/app.tsx` passava prop `onRefreshRoot` que não
   existia em `AppShellProps` (typecheck bug, achado consertando
   typecheck pré-existente).
3. Feature `test` do `tauri` estava em `[dependencies]`, fazendo o
   binário de release carregar `tauri::test::MockRuntime` (build hygiene
   bug, achado revisando Cargo.toml para Windows-readiness).

Nenhum desses três bugs seria pego por mais unit tests. Cada um precisava
de uma **lente diferente**: profiling, typecheck strict, revisão de
build artifacts. A lição é estrutural: ampliar a cobertura de tipos
de teste pega mais bugs do que aumentar a cobertura de unit tests.

---

## Tier 1 — Alto ROI, encaixa imediatamente

### 1. Differential testing (markdown)

**O que é**: rodar o mesmo input por **dois ou mais conversores** e falhar
quando os outputs divergem em algo que importa.

**Encaixe**: o projeto faz markdown e AsciiDoc — formatos com **especs
públicas** e implementações de referência maduras. Para markdown,
comparar `markdown-it` (nosso) vs `marked` vs `remark` vs `pulldown-cmark`
pega bugs que humano nunca escreveria caso de teste para encontrar.

**Encontrado em projetos similares**: bugs de classes/IDs em headings,
fence handling, lazy continuation, link reference normalization.

**Custo**: ~1h. Adiciona 1 dep (`marked`).

### 2. CommonMark / GFM conformance suite

**O que é**: rodar a [`spec.txt`](https://spec.commonmark.org/) oficial
do CommonMark — ~650 testes oficiais numerados.

**Encaixe**: nossos testes artesanais cobrem o que **eu lembrei**. A spec
tem casos que ninguém lembraria (HTML blocks tipo 7, lazy continuation
lines, link reference normalization).

**Como rodar**: download `spec.txt`, parser em ~30 linhas extrai
`(input, expected_html)` pairs, comparar HTML normalizado.

**Custo**: ~2h. Sem dep extra.

### 3. Approval / Golden Master testing

**O que é**: capturar a saída HTML de fixtures reais. Humano aprova uma
vez. Cada commit re-renderiza e diffa contra o aprovado. Mudanças
silenciosas viram falha forçando review humano.

**Encaixe**: nossos `expect(html).toContain("...")` pegam só o que foi
asserted. Whitespace, ordem de atributos, classes geradas pelo anchor
plugin — passam silenciosas. Approval testing pega tudo isso.

**Como**: `__golden__/notes-with-code.md` → `__golden__/notes-with-code.html`,
test runner gera + diffa. CLI `bun run test:approve` reescreve goldens
em batch quando uma mudança é intencional.

**Trade-off**: cada update de plugin gera diff e precisa re-aprovação.
Vale o custo porque flakes silenciosas são **piores** que falsos
positivos.

**Custo**: ~2h.

### 4. Stateful property-based testing

**O que é**: em vez de "open A, close A, expect empty", define-se um
**conjunto de comandos** (`OpenTab`, `CloseTab`, `Reorder`, etc) e o
fast-check **gera sequências aleatórias** verificando invariantes que
devem se manter sempre.

**Encaixe**: o `createTabStore` tem 20 unit tests. Stateful PBT explora
sequências que ninguém escreveu — tipo "abre N, fecha 2, reorder, reopen,
fecha all" e descobre estado inconsistente em algum branch.

**Invariantes obvias**:
- `tabs.length <= MAX`
- ids únicos depois de qualquer sequência
- conjunto de tabs preservado em reorder
- closed-tabs stack respeita LIFO até MAX_CLOSED_TABS

**Custo**: ~1.5h. Já temos `fast-check`.

### 5. Memory soak / leak testing (memlab)

**O que é**: o [memlab](https://www.npmjs.com/package/memlab) da Meta roda
o app por horas, captura heap snapshots em pontos definidos, e detecta
objetos que **deveriam ter sido coletados mas não foram**.

**Encaixe**: Tauri tem [issue conhecido](https://github.com/tauri-apps/tauri/issues/12724)
de leak em emits. Nosso `make_watcher` emite `fs-change` continuamente.
Após 8h de uso real, memória pode crescer linearmente — usuário não nota
até reclamar de "fica lento".

**Cenário**: abre fixture → edita 100x → cada edit dispara fs-change →
captura heap após X iterações → falha se há retention pattern.

**Custo**: ~3h. Roda nightly.

---

## Tier 2 — Vale a pena, mais esforço

### 6. Metamorphic testing

**O que é**: relações que devem se manter sob transformação dos inputs.
Ex: `convertMarkdown(doc + doc).html.length ≈ 2 × convertMarkdown(doc).html.length`
(modulo TOC).

**Pesquisa recente**: [Metamorphic Coverage (2025)](https://arxiv.org/abs/2508.16307)
mostra MC sendo 4× mais sensível que line coverage para detectar bugs.

**Relações para markdown**:
- "frontmatter inválido nunca derruba o body"
- "concatenar dois docs válidos sem heading colliding produz a união
  dos TOCs"
- "reordenar plugins idempotentes não muda output"
- "input + ' '*N produz mesmo HTML que input (modulo whitespace)"

**Custo**: ~3h.

### 7. Loom — concurrency permutation

**O que é**: o [tokio-rs/loom](https://github.com/tokio-rs/loom) testa
código concorrente Rust executando **todas as permutações possíveis de
scheduling** sob o C11 memory model. Não é random — é exaustivo.

**Encaixe**: nosso `WatcherHolder(Mutex<Option<Debouncer>>)` é potencial
race entre `watch_paths` e `stop_watching`. Loom prova que toda ordem
possível é correta, ou encontra a ordem que falha.

**Trade-off**: requer trocar `std::sync` por `loom::sync` em testes
(cfg-gated). Roda lento por design (exaustivo).

**Custo**: ~2-3h.

### 8. Miri — UB detection

**O que é**: o [Miri](https://github.com/rust-lang/miri) interpreta MIR
e flag UB: pointer provenance, dangling refs, data races, type invariants.
[POPL 2026 paper](https://research.ralfj.de/papers/2026-popl-miri.pdf)
mostra Miri encontrando dezenas de bugs em código real.

**Encaixe**: nosso `lib.rs` tem `unsafe { objc2::msg_send![...] }` em
`macos_maximize`. Cocoa nativo é alvo clássico de UB.

**Custo**: ~2h. `cargo +nightly miri test`. Limitar com `#[cfg(not(miri))]`
nos tests que tocam I/O real.

### 9. Bindings tipados (contract testing leve)

**O que é**: gerar bindings TypeScript do Rust com [`specta`](https://docs.rs/specta)
ou [`ts-rs`](https://crates.io/crates/ts-rs). Pre-commit valida que o
arquivo `bindings.ts` está em sync com a definição Rust.

**Encaixe**: hoje frontend faz `invoke('read_dir', { includeHiddenEntries })`.
Renomear param para `include_hidden_entries` no Rust (snake_case vs
camelCase é armadilha conhecida do Tauri) — só E2E pega. Bindings
tipados pegam em compile time.

**Custo**: ~2h. Substitui ~80% dos E2E IPC tests.

---

## Tier 3 — Quality contínua

### 10. Mutation thresholds por arquivo

**O que é**: o `stryker.config.json` ganha threshold de break por
arquivo crítico. Hoje break = 0; subir para 60/70 nos arquivos
core-de-produção.

**Custo**: ~1h.

---

## Estratégias rejeitadas (avaliadas e descartadas)

### Pact / consumer-driven contracts
HTTP-centric. Tauri IPC é estaticamente tipado se gerarmos bindings
(item 9). Pact full-stack seria overkill.

### Selenium / WebdriverIO via tauri-driver
A [doc oficial Tauri](https://v2.tauri.app/develop/tests/) menciona, mas
**não funciona em macOS** (sem WebDriver client nativo). Nossa
abordagem com `tauri-plugin-mcp-bridge` é mais portátil.

### Cypress
Web-only. Tauri webview varia por OS (WKWebView/WebKitGTK/WebView2).

### Symbolic execution / formal verification (Z3, Kani)
Overkill para um editor markdown.

---

## Plano de adoção

### Fase 1 — quick wins (~6h)
1. Differential testing vs `marked`
2. CommonMark conformance suite
3. Approval testing (5-10 fixtures reais)
4. Stateful PBT no `createTabStore`

Esperado: 3-10 bugs novos detectados imediatamente. Os mais prováveis:
incompatibilidades CommonMark spec, regressão silenciosa de classes/IDs
em headings, edge case em sequências de tab operations.

### Fase 2 — robustez (~10h)
5. Loom nos watchers
6. Miri no `macos_maximize`
7. memlab soak no `run-e2e.sh`
8. Bindings tipados (specta)

Esperado: descobre data races latentes, UB no obj-c, vazamento de
memória em fluxos com watcher, drift de schema entre Rust e JS.

### Fase 3 — qualidade contínua (~4h)
9. Metamorphic relations no markdown
10. Mutation testing thresholds por arquivo

---

## TL;DR

A estratégia **mais sub-utilizada** é **differential + CommonMark
conformance**. Você ganha ~600 casos de teste reais escritos por gente
que conhece o spec, sem precisar imaginar nada. Detecta drift quando
alguém atualiza um plugin.

A estratégia **mais subestimada** é **stateful property-based**. Bugs
de tab management costumam ser sequências, não casos isolados.

A mais valiosa para reliability é **memlab soak testing** — apps
desktop ficam abertos 8h, leaks viram churn de usuário.

---

## Fontes

- [Wikipedia: Metamorphic testing](https://en.wikipedia.org/wiki/Metamorphic_testing)
- [Metamorphic Coverage (arxiv 2508.16307)](https://arxiv.org/abs/2508.16307)
- [tokio-rs/loom](https://github.com/tokio-rs/loom)
- [Properly Testing Concurrent Data Structures — matklad](https://matklad.github.io/2024/07/05/properly-testing-concurrent-data-structures.html)
- [Tauri Tests — v2 docs](https://v2.tauri.app/develop/tests/)
- [Why "Approval Testing" instead of "Golden Master"](https://coding-is-like-cooking.info/2021/03/why-we-should-be-saying-approval-testing-instead-of-golden-master/)
- [Approval Tests — UnderstandLegacyCode](https://understandlegacycode.com/approval-tests/)
- [memlab — npm](https://www.npmjs.com/package/memlab)
- [Tauri memory leak issue #12724](https://github.com/tauri-apps/tauri/issues/12724)
- [Pact Docs — Consumer Tests](https://docs.pact.io/consumer)
- [Hypothesis stateful tests](https://hypothesis.readthedocs.io/en/latest/stateful.html)
- [State Machine Properties — Property Testing book](https://propertesting.com/book_state_machine_properties.html)
- [Solid State Management — Solid Docs](https://docs.solidjs.com/guides/state-management)
- [Miri: Practical UB Detection for Rust (POPL 2026)](https://research.ralfj.de/papers/2026-popl-miri.pdf)
- [rust-lang/miri](https://github.com/rust-lang/miri/)
- [specta — typed bindings](https://docs.rs/specta)
