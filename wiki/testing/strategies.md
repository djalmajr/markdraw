---
title: "Testing Strategies"
audience: dev
sources:
  - repo:./packages/core/src/__properties__/
  - repo:./packages/core/src/__metamorphic__/
  - repo:./packages/core/src/__diff__/
  - repo:./packages/core/src/__conformance__/
  - repo:./packages/core/src/__golden__/
  - repo:./packages/core/src/__regressions__/
  - repo:./packages/core/src/__bench__/
  - repo:./packages/core/fuzz/
  - repo:./apps/desktop/src-tauri/src/lib.rs
  - repo:./apps/desktop/e2e/
  - repo:./tools/loom-watcher-tests/
updated: 2026-05-04
tags: [testing, strategies, mutation, fuzzing, property-based, metamorphic]
status: stable
---

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

## Round 4 — lessons from the split-panes incident

A user-found bug ("after moving a tab to the other pane, switching tabs
in the destination shows the same preview") slipped through the test
suite. Post-mortem extracted four concrete lessons about how the
existing strategies were applied — none of them are new techniques,
all of them are existing strategies that were under-applied.

### Lesson 1 — Inline `// Mutation captured` comments aren't proof

The `handleMoveTab` handler had comments documenting which mutations
each test was supposed to catch (skip-closeTab, skip-openTab,
wrong-fromPaneIndex). **No one ever ran those mutations** to verify
the assertions actually fail. The test suite passed cleanly even
with `targetPane.tabs.updateActiveTabContent` removed — because no
test asserted on the *target tab's content*, only on the *count of
tabs in each pane*.

**Rule going forward**: a `// Mutation captured: …` comment is a
TODO, not a guarantee. Either:
1. Add a CI step that mutates known constants and verifies a test
   fails (manual pass via `sed` is the bare minimum), OR
2. Don't write the comment unless you've already run the mutation.

### Lesson 2 — Count-based assertions miss content corruption

The original e2e for "Move to Other Pane" only checked
`p0.tabs.length === 0 && p1.tabs.length === 1`. The actual user-facing
bug was tab content corruption (snapshot/restore wrote the wrong
TabState back into pane signals on tab-switch). Counts never lied.

**Rule going forward**: when a feature renders user-visible content
that survives tab/pane switches, the e2e MUST capture and compare
the rendered text. Not lengths-only either — text comparison locks
in the fact that two distinct files render distinctly.

The new regression test in
`apps/desktop/e2e/specs/palettes.webview.test.ts` ("Move preserves
content + tab-switching in the target pane stays per-tab") opens
two distinct files in the destination pane, switches between them,
and asserts `readmeContent !== guideContent`. With the old buggy
move handler the two strings were identical — the assertion
catches the regression directly.

### Lesson 3 — Stateful PBT was scoped too narrowly

`packages/ui/src/composables/__property__/create-tab-store.stateful.test.ts`
exercises a single TabStore with random sequences of open/close/
activate/reorder. It found unrelated bugs effectively. But "move tab
across panes" requires a *cross-store* invariant — and that suite
operates on one store. The bug surfaced in the interaction between
two `PaneStore`s + the `AppState` proxy, none of which the existing
PBT models.

**Rule going forward**: when a refactor introduces a NEW
multi-store interaction (e.g. moving entities between aggregates),
the stateful PBT scope must follow. A `create-pane-manager.stateful`
suite with commands `Open`, `Close`, `Switch`, `Move` and the
invariant "for each persistent tab, switching away then back yields
the same content" would have caught this in the first 50 cases —
the bug fires deterministically on `[Move(tab), Switch, SwitchBack]`.

Tracked as **DJA-35** in the Linear project
[AsciiMark — Technical debt & polish](https://linear.app/djalmajr/project/asciimark-technical-debt-and-polish-4009b2920302).
Adding the suite now without a current bug to surface would be
busywork; the issue captures the trigger ("the next time we touch
cross-pane state").

### Lesson 4 — Property: snapshot/restore round-trip preservation

The deeper invariant the bug violated:

> ∀ sequence of (open, switch, close, move) operations: for every
> tab `T` that exists at the end, `T.editorContent` equals the
> last `editorContent` the user observed in `T` before they
> last switched away.

This is a direct property test target — fast-check can generate
sequences and a model tracks "what content the user saw last in
each tab". Neither the current vtest nor the existing stateful PBT
encodes this. The `create-tab-store.stateful` covers parts (id
uniqueness, no-loss on close-then-reopen) but not the
content-faithfulness invariant.

**Rule going forward**: identify the *content-faithfulness*
invariant for any cache-like construct (tabs, panes, recents,
favourites). If user-observable state is stored and replayed,
property-test the round-trip explicitly.

### Lesson 5 — Domain rules at the host handler level

`handleMoveTab` lives in `apps/desktop/src/app.tsx`. It's a host
handler (mixes paneManager, tabStore, loader). No bun-level test
exists because extracting it would mean carrying its dependencies.

**Rule going forward**: host handlers that orchestrate cross-store
state changes are exactly the place where regressions land
quietly. They deserve unit tests via dependency injection — pull
the logic into a pure function `moveTabBetweenPanes(deps)`,
domain-test it, and let the host wire `deps`. The cost is a small
indirection; the gain is mutation-survivable coverage.

**Validated 2026-05-05** — applied this lesson to
`apps/desktop/src/lib/file-loader.ts` after a second incident of
the same class (the user-found "intro.adoc shows blank preview"
race). The new `apps/desktop/src/lib/file-loader.test.ts` drives
`loadFileContent` against a real `PaneManager` with mocked fs.ts +
convert; an artificial async gate lets the test flip the active
pane between the `await readFileContent` and the post-convert
write. Mutation survival validated by hand —
`s/targetPane.setHtml/state.setHtml/` reverts the fix and both
test cases fail. Pattern documented in `wiki/log.md`'s 2026-05-05
post-mortem so the next host handler audit knows what shape to
target.

### Lesson 6 — Pin per-doc target before any `await` (split-panes specific)

Discovered while fixing Lesson 5's second instance. Any async
handler in `apps/desktop/src/lib/` that writes per-document fields
(html, editorContent, savedContent, frontmatter, selectedFile, …)
through `state.setX` will misbehave if the user switches the
active pane mid-await: the AppState proxy resolves
`paneManager.activePane()` *at write time*, not at call time, and
the result lands on the wrong pane.

**Rule**: capture the target pane on entry and call its setters
directly:

```ts
async function handler(...) {
  const targetPane = state.paneManager.activePane();
  // ...
  targetPane.setHtml(...); // NOT state.setHtml
}
```

**Audit candidates** (next pass — none confirmed buggy yet, just
shaped like the file-loader was):
- `apps/desktop/src/lib/folder.ts::refreshRoot` (writes via state
  after async read_dir).
- `apps/desktop/src/app.tsx::handleEditorSave` (autosave path).
- Any other `await` followed by `state.setX` for per-doc fields.

The audit is a search-and-read exercise — spot the patterns, fix
+ DI-test each one as Lesson 5 prescribes.

## Round 5 — module-level mutable state × multiple component instances

### Incident

After v0.8.0 shipped, a screenshot for the site showed a real
regression: in split-pane mode, the second pane's preview
occasionally rendered as an empty `<article>` even though the TOC
populated correctly (so the HTML *had* been computed and `setHtml`
*had* been called on the right pane). The bug was reproducible 7/8
times when reloading the app, opening README.md in pane 0,
splitting with `Cmd/Ctrl+\`, and clicking BACKLOG.md in the new
pane.

### Trial-loop reproductor (the technique)

Intermittent rendering bugs need *statistical* evidence — a single
"it worked for me" is meaningless when the symptom shows up
half the time. We drove the live app via the `tauri-plugin-mcp-bridge`
in a loop:

```ts
// scripts/repro-split-panes.ts (illustrative)
import { connectBridge } from "../apps/desktop/e2e/bridge.ts";

const b = await connectBridge();
let bug = 0;
for (let trial = 0; trial < 20; trial++) {
  // 1. Reset state and reload the webview.
  await b.evalJs(`
    for (const k of Object.keys(localStorage)) localStorage.removeItem(k);
    window.location.reload();
  `);
  await new Promise((r) => setTimeout(r, 4000));

  // 2. Reconnect (the WebSocket dropped on reload), open the
  //    fixture workspace, click a file, wait for the preview.
  const c = await connectBridge();
  await c.evalJs(`window.__DEV__.openFolder("/path/to/fixture")`);
  await new Promise((r) => setTimeout(r, 1500));
  // …click README.md, await `.content article` non-empty…

  // 3. Reproduce: split + click another file.
  await c.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", {
    key: "\\\\", metaKey: true, bubbles: true, cancelable: true,
  }))`);
  await new Promise((r) => setTimeout(r, 600));
  // …click BACKLOG.md in the now-active pane 1…
  await new Promise((r) => setTimeout(r, 3000));

  // 4. Score.
  const len = await c.evalJs(
    `document.querySelectorAll(".pane-view")[1]?.querySelector(".content article")?.innerHTML?.length ?? 0`,
  );
  if (len === 0) bug++;
  c.close();
}
console.log(`bug repro: ${bug}/20`);
```

A *trial* in this context is one full setup → reproduce → measure
cycle, with a hard reset between iterations so prior runs can't
mask the failure mode. The script is a manual harness — it lives
in `scripts/` only while a bug is being chased and is deleted
once the fix lands. The signal we care about is the **rate**
(7/8 → 4/8 → 0/20), not any individual run.

### Root cause

```ts
// packages/ui/src/components/preview.tsx, BEFORE
let renderGen = 0;          // ← module-level

async function highlightCodeBlocks(c, gen) {
  if (gen !== renderGen) return;   // closes over module binding
  // …
}

export function Preview(props) {
  // …
  createEffect(() => {
    const gen = ++renderGen;       // mutates module state
    queueMicrotask(async () => {
      await highlightCodeBlocks(buffer, gen);
      if (gen !== renderGen) return;  // ← false abort
      await renderMermaidBlocks(buffer, gen);
      // …
      articleRef!.replaceChildren(...);
    });
  });
}
```

With one `Preview` mounted, `renderGen` is the right cancellation
token: every `setHtml` bumps it, in-flight microtasks bail out, the
*latest* render wins. With **two** `Preview` instances mounted (split
panes), `renderGen` is shared. A `setHtml` in pane 1 increments the
counter that pane 0's still-running microtask is checking — pane 0
aborts mid-swap and ends with whatever was in `articleRef`
beforehand (possibly nothing, if it was a fresh mount).

### Fix

Move the counter into the component body and pass a per-instance
predicate to the post-processors:

```ts
// AFTER
type IsStaleFn = (gen: number) => boolean;

async function highlightCodeBlocks(c, gen, isStale: IsStaleFn) {
  if (isStale(gen)) return;
}

export function Preview(props) {
  // each Preview owns its own counter; cross-instance interference
  // is impossible.
  let renderGen = 0;
  const isStale: IsStaleFn = (gen) => gen !== renderGen;

  createEffect(() => {
    const gen = ++renderGen;
    queueMicrotask(async () => {
      await highlightCodeBlocks(buffer, gen, isStale);
      if (isStale(gen)) return;
      // …
    });
  });
}
```

### The lesson

> Module-level mutable state in a component file is invisible
> coupling between every instance of that component. The first
> instance hides the bug; the second one exposes it.

It's a class of bug the test suite cannot reach by exercising one
component in isolation. Unit tests pass. Property tests pass.
Mutation testing on the predicate (`gen !== renderGen` → `===`)
won't kill the mutant unless the test instantiates **two** Previews
concurrently, drives them in parallel, and asserts both articles
end populated.

#### Concrete tests we should land

1. **Component test (vitest + @solidjs/testing-library)** — render two
   `<Preview>` side by side, drive `props.html` on both with timing
   that exercises the cancellation paths. Assert each article
   contains the right content. This is the determinístic
   regression test for *exactly* the renderGen bug.
2. **E2E flake-quarantine** — keep a small spec that does
   open-A → split → open-B → assert pane-1 non-empty, run it under
   `release-check` with a flake threshold (e.g. 1 fail in 20
   acceptable). The trial-loop reproductor from this round is the
   spec's body; it's already most of the work.

#### Audit pattern to remember

Search for any module-level `let` in shared component files. Each
one is a candidate:

```bash
grep -rn "^let " packages/ui/src/components/
```

For each hit, ask: *what happens when this component renders
twice?* If the answer is "the two instances stomp on each other,"
move it into the component body. The bar is **per-instance state
must live per-instance** — anything else is a future flaky-test
and a real-world incident waiting to happen.

### What threw us off during diagnosis

- **HMR cache.** After committing the renderGen fix, the bug
  appeared to persist (~5/10 reproductions). It didn't — the
  running `dev:app` was still serving the pre-fix bundle. Restart
  `bun run dev:app` end-to-end after touching `Preview` (or any
  double-buffering / cancellation logic) before drawing
  conclusions about whether the fix worked. HMR is fine for
  cosmetic changes; it's a liability for changes to module-level
  state because the module isn't re-evaluated on update.
- **Symptom asymmetry.** The TOC populated even when the article
  was empty. Why: TOC extraction happens in `afterSwap`, which
  runs *after* the abort check. A render that aborted between
  highlight and replaceChildren produces TOC + empty article —
  exactly what we observed. When two pieces of UI on the same
  pane disagree, suspect partial-completion of an async pipeline.

## Forbidden test shapes

Tests in this repo must verify *observable behaviour*. The shapes below
add CI time, lock in implementation details, and give false confidence —
**reject them in review and delete on sight**:

- *"x is defined / not undefined / truthy"* without an assertion on its
  shape or behaviour.
- *"foo was called"* without checking the effect of the call.
- *"the component renders"* without asserting any DOM contract.
- Snapshot tests larger than ~30 lines without an intent comment
  pointing at the specific business rule they protect.
- Tests that mock the function under test.

Every test that survives review must fall into at least one bucket: a
real bug regression (link the symptom), a stated business rule, a
property/invariant, an API contract, an integration with a real
dependency, or a permission/concurrency boundary. See [§ Tier 1](#tier-1--alto-roi-encaixa-imediatamente).

Companion rule: **every non-trivial test names the mutation it would
kill**, in a one-line comment above the `it(…)`. See
[Test conventions § Tests must name the mutation they kill](./conventions.md#tests-must-name-the-mutation-they-kill).

## Round 6 — extract small components so the regression has somewhere to live

### Incident

The TOC right-gutter went through five behaviour changes in one
sitting (split-pane lookup losing the `#toc` node, toolbar toggle
gated on `hasFile`, panel disappearing when the active pane was
empty, panel showing on the dropzone home screen, stale toc tree
sticking around after the active pane lost its file). Each tweak was
a small condition flip in `app-shell.tsx`, but every flip moved the
goalposts on what "correct" meant — and `app-shell.tsx` is too large
to mount in a vtest. The bugs only got caught once one of us drove
the live app through the focus flips manually.

### Lesson

**A component you cannot mount in a unit test does not get covered
by unit tests.** `app-shell.tsx` ships ~700 lines, drag-and-drop
providers, several portals, paraglide locale state, and a
`paneManager` proxy that proxies into per-pane signals. Mounting it
just to assert "the right gutter has class `toc-hidden`" is the kind
of test setup that ages into a maintenance burden — so we wrote
zero. The bugs lived on.

The fix that made the regression bar reachable wasn't another
condition flip; it was extracting the gutter into a dedicated
`TocPanel` component:

- `packages/ui/src/components/toc-panel.tsx` (~110 LOC, pure props)
- `packages/ui/src/components/toc-panel.vtest.tsx` (~10 tests)

The old `app-shell.tsx` just renders `<TocPanel … />`. The new vtest
asserts every behaviour we shipped fixes for during 0.9.x:

| Test | Mutation it kills |
|---|---|
| Hide on home screen | Drop `!props.hasRoot` — gutter pops next to dropzone |
| Hide on toggle off | Flip the toggle predicate — disable button stops working |
| Stay visible without headings | Re-add `!hasToc()` to hide rule — gutter flickers between docs |
| Placeholder OUTSIDE `.toc-panel-tree` | Move `<Show>` inside ref div — Preview's `textContent = ""` wipes it |
| Placeholder reactive on `hasToc` flip | Swap accessor for static read — placeholder freezes on initial value |

### Pattern

When iteration on a piece of UI is producing more bugs than the
existing tests can guard, the right move is usually structural:

1. **Find the smallest prop surface that captures the behaviour.**
   For TocPanel that was 7 props (`tocVisible`, `hasRoot`, `hasToc`,
   `tocLevels`, two setters, a contentRef). Anything more and you're
   pulling in dependencies the test doesn't need.
2. **Extract it into its own file.** Keep it pure (no signals, no
   reaching into `paneManager`). The host component projects state
   into the props.
3. **Cover the props with vtest cases.** Each case names the
   *mutation* it would kill in a comment — that's the bar for "test
   with value" (see [Test conventions](./conventions.md#tests-must-name-the-mutation-they-kill)).
4. **Delete behaviour from the host.** The host shrinks; the new
   component carries the rules; the tests become the spec.

For UI-heavy projects, this is often the cheapest way to get
mutation-quality coverage without standing up a full integration
harness.

### Anti-pattern

`app-shell.tsx` is the canonical example of what *not* to ship more
features into. If a new behaviour needs ≥3 reactive reads of `s.*`
or has `if/else` ladders that span >40 LOC inside the JSX, extract
it. The cost of NOT extracting is invisible: it's the regression
test you don't write because the setup is too painful.

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
