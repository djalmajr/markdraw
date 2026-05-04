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

---

## Round 2 — strategies adopted after the first batch shipped

After Tier 1-3 above were merged and a `knip` + `cargo-machete` cleanup
pass ran, a follow-up survey explored what was still missing. These got
adopted; rationales below.

### Adopted

#### `cargo-mutants` — mutation testing for Rust
The Stryker setup we already had only mutated TypeScript. The Rust
backend (`lib.rs`, ~760 LOC, includes the path-traversal validation,
watcher state machine, and helpers for read_dir / rename / trash) was
mutating-blind. `cargo-mutants` mirrors Stryker exactly: generates
mutations on the AST, runs `cargo test` for each.

Configured at `apps/desktop/src-tauri/.cargo/mutants.toml` with explicit
`exclude_re` patterns covering Cocoa FFI and the Tauri command wrappers
(both untestable without a live runtime). Run via `bun run
test:mutation:rust`. Wired into release-check as a candidate for nightly
escalation when scoring drops.

#### `cargo-audit` + `bun audit`
No prior gate against deps with known CVEs. Ran on first invocation and
**immediately surfaced 37 npm advisories (1 critical, 17 high) and 3
RustSec advisories**. Most are transitive from Tauri / markdown-it
plugins, not first-party. Wired as advisory step (9/9) of release-check
— intentionally non-blocking for now because mass-bumping deps is a
separate concern and we don't want to wedge a release on it.

#### i18n / Unicode edge cases
The unit + property tests so far were ASCII-heavy. Real users write
markdown in Arabic, Japanese, with ZWJ emoji families, with combining
diacriticals. Added:
- `__golden__/inputs/08-unicode-i18n.md` — golden fixture covering ZWJ
  sequences, CJK, RTL, NFC/NFD diacritics, surrogate pairs, BiDi
  override marks.
- `__properties__/i18n.property.test.ts` — 6 property tests on
  `extractFrontmatter`, `escapeHtml`, BiDi override safety, ZWJ
  preservation, mixed-script content, NFC↔NFD equivalence (~890
  expects).

#### Bench regression gate
Previously the bench produced numbers but never compared them. Now
`conversion.bench.ts` writes `baseline.json` keyed by
`${platform}-${arch}/bun-${version}` and FAILS on subsequent runs if any
scenario regresses by more than `BENCH_REGRESSION_PCT` (default 25%).
Intentional regressions opt in via `BENCH_UPDATE_BASELINE=1`.
Catches the silent half-of-perf-gone-missing case that coverage and
unit tests are blind to.

#### Chaos / fault injection (`apps/desktop/src/lib/chaos-invoke.ts`)
Wrapper around `@tauri-apps/api/core`'s invoke. Activates only when the
URL has `?chaos=N` (so `tauri://` production builds skip it
unconditionally). Synthetically rejects ~N% of IPC calls. Reveals the
"happy path only" UI bugs: spinners that don't clear, dialogs that
don't reopen, dirty-state that lies. Currently opt-in per call site
(documented in `apps/desktop/src/lib/__chaos__/README.md`). Adopting
site-by-site is intentional — wholesale wrapping would force every test
fixture to handle synthetic errors.

#### Type coverage (`type-coverage`)
Threshold 95% on `packages/core` (current: 96.45%). Surfaces unsafe
JSON.parse / `any`-cast pockets without forcing strict mode. Wired as
`bun run type-coverage` in core. Apps tend to have lower density (event
handlers, Solid signals); for now the gate lives only in the place
where the contracts are tightest (the parsers).

#### Replay testing (`packages/core/src/__regressions__/replay.test.ts`)
fast-check supports `examples: [...]` that get prepended to every run.
The pattern: when a property finds a counterexample, paste the shrunk
case here as a permanent regression — explicit, documented, never
shrunk away. The directory ships with three smoke replays documenting
known-good edge cases; the file's purpose is to grow as real failures
land.

### Considered but rejected

#### Visual regression (pixelmatch / playwright screenshots)
Tier 4 deferred. Owns its own infra (image storage, CI snapshot diff
service) for marginal value over what differential / approval testing
already gives. Revisit if a release ever ships a visual bug that none
of the existing layers caught.

#### License auditing
Overkill for a personal project. The licenses of our direct deps are
all permissive; a full SBOM scan would burn time to discover what we
already know.

#### Cyclic dep detection (`madge`)
Knip already flags cycles indirectly. Adding `madge` would duplicate
that channel.

#### Bundle-size snapshot
Tauri bundle size is dominated by the WebView runtime, not our code. A
+5KB regression in the JS won't show up; a 5MB regression in WebView
would, but that's a Tauri version issue, not ours.

#### Big-O analysis (`cargo-criterion-perf-events`)
We already have explicit perf gates (`#[ignore]` tests in `lib.rs` that
hard-fail at 1s for 5k files). Hardware-counter analysis is the next
ring out and not justified yet.

#### Cross-version migration testing
Already covered by the legacy-key handling in `recent-files.ts` /
`recent-folders.ts`, with explicit unit tests proving each migration.
A separate framework would be ceremony.

---

## Round 3 — operational hardening

### Adopted

#### `proptest` (Rust property-based testing)
Symmetric counterpart to `fast-check` on the JS side. Three properties
in `apps/desktop/src-tauri/src/lib.rs` covering:
- `resolve_within_root` — never returns a path outside the canonicalized
  root for ANY randomized relative input (including `..` traversals).
- `read_dir_recursive` — sort invariant: directories before files,
  case-insensitive ascending within each group, for any randomly
  generated tree.
- `rename_file_impl` — atomicity: success implies source-gone +
  destination-exists; failure implies source-intact.

Each runs 200 randomized cases per invocation.

#### `cargo clippy --all-targets -- -D warnings`
Wired into pre-commit (`clippy` job, glob on
`apps/desktop/src-tauri/**/*.rs`). On adoption, fixed two warnings:
`redundant_closure` in `benches/read_dir.rs` and `type_complexity` in
the test helper for `make_watcher` change-buffer signature.

#### `release:smoke` — fast pre-tag gate
`scripts/release-smoke.sh`, ~30s vs `release:check`'s ~3min. Steps:
typecheck → bun test → cargo test → clippy → vitest → IPC contract.
Skips the heavy gates (Stryker, E2E, audit) — those stay in
`release:check` for the actual tag-time run.

#### `coverage:snapshot` — coverage regression detection
`scripts/coverage-snapshot.sh` captures Bun + Rust coverage into
`packages/core/__coverage__/last-run.json`, diffs against the
committed `baseline.json`, fails if any metric drops by more than
2 percentage points. Accept a new floor with
`COVERAGE_UPDATE_BASELINE=1`.

#### Single-page operations runbook
`wiki/testing/operations.md` (this directory) is the "how do I run X"
lookup. Strategies (this file) is the rationale. They split because
mixing them made each long page worse at its job.

#### `cargo-mutants` — Rust mutation testing
Configured at `.cargo/mutants.toml`. Excludes Cocoa FFI and command
wrappers (untestable without a runtime). Run via
`bun run test:mutation:rust`.

#### `bun audit` + `cargo audit`
Wired as advisory step 9/9 of `release:check`. First run after the
critical-CVE bump (commit `1e2b725`) reports 23 advisories — all
moderate, all transitive in dev tooling. happy-dom RCE, vite file-read,
mermaid DOMPurify chain were resolved.

#### Render coverage on the three highest-stakes UI components
`packages/ui/src/components/{file-tree,editor,preview}.vtest.tsx`
(17 tests). file-tree covers empty / single / multi-root, click→select
dispatch, filter behavior verified against `.tree-item-wrapper`
display-style scan. editor covers CodeMirror mount, search overlay
visibility under `searchOpen`. preview covers HTML rendering,
`<script>` stripping, javascript:-URL neutering, `<iframe>`
sanitization, frontmatter panel surfacing.

#### Wiki + QMD bootstrap
`/wiki-init` configured the **local** `./wiki` topology (NOT the
sibling `../knowledge-base` repo, which holds unrelated other-project
docs). QMD collection `asciimark` indexes only `./wiki/**/*.md`:
8 documents, 19 embedded chunks. `.wiki-guardrails.yml` points at
`./wiki`; the wiki-init's auto-suggested sibling path was overridden.

### Rejected (this round)

#### Specta typed bindings (over the IPC contract)
Replaced with the lighter `scripts/check-ipc-contract.sh` regex-based
drift detector. Specta + tauri-specta has a fragile version matrix
against tauri 2.x; the grep-based approach gets ~80% of the value at
1% of the maintenance cost. Revisit if drift becomes frequent.

#### `bun update --latest` for ALL deps
Running it would resolve more advisories but cascades breaking
changes (Vitest 3, mermaid 11→12, etc). Bumped only the ones with
critical/high CVEs and verified each path stayed green; the
moderate transitives wait for a focused dependency update branch.

#### Validate E2E roundtrip in this environment
The Claude Code Bash sandbox kills child processes (`tauri dev`,
`bun run dev:app`, even `nohup ... & disown`) when the tool returns.
Tested 4× with progressively more aggressive detachment strategies;
none survived. The specs are correct on inspection (the
`bridge.ts` WebSocket protocol matches `tauri-plugin-mcp-bridge`'s
`execute_js` handler) but the validation has to happen in a real
shell. Captured in `BACKLOG.md`.

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
