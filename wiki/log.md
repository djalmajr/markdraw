# Wiki log

Operations on this wiki, newest first.

## [2026-05-06] ingest | preview pipeline + OS-reserved keys

In-session learnings (no `raw/` source) — three diagnostic threads
from the same debugging arc:

- **Mermaid first-render flake** → root cause was running mermaid
  against a detached buffer + a force-init that threw away the
  warm state. Documented the corrected pipeline (sanitize →
  highlight → swap → paint frame → mermaid/kroki), the
  kitchen-sink pre-warm, and the empty-svg-as-soft-failure retry.
- **Workspace Symbol → TOC active update** → cross-file navigation
  needs the preview to scroll, not just the editor — the existing
  `setupTocScrollTracking` in `preview.tsx` updates `.toc-active`
  as a side effect of scroll, so `pendingHeadingText` (text-walk
  through `h1-h6`) closes the loop.
- **F11 on macOS Mission Control** → bindings reserved by the OS
  never reach the webview; `Cmd+.` is the new primary for
  Reader/Zen mode, `F11` accepted as fallback.

Pages created: `wiki/architecture/preview-pipeline.md`.
Pages updated: `wiki/architecture/keyboard-shortcuts.md` (new
"Teclas reservadas pelo SO" section + caso real), `wiki/index.md`,
`CLAUDE.md` (sub-rule pointing back at preview-pipeline page).

## [2026-05-06] doc | keyboard-shortcuts three-source rule

Codified the convention that every keybinding ships in three
parallel surfaces — descriptor catalog (`SHORTCUTS`), keydown
handler, command palette entry — in the same change.
- `wiki/architecture/keyboard-shortcuts.md` — new page with
  rationale, surface table, and the four-step checklist.
- `wiki/index.md` — topic added.
- `CLAUDE.md` § 10 — sub-rule pointing back at the wiki page so
  agents apply it by default.
- Backfill: F11 (Reader Mode) and Cmd+Alt+O (Workspace Symbol
  Search) now have entries in the shortcut catalog and the
  command palette alongside their keydown handlers.

## [2026-05-06] doc | testing — Round 6 + extract-for-testability rule

After five behaviour iterations on the right-gutter TOC panel,
`app-shell.tsx` was too large to mount in a vtest, so every fix
shipped without a regression guard. Resolved by extracting
`packages/ui/src/components/toc-panel.tsx` (~110 LOC, pure props)
plus `toc-panel.vtest.tsx` (~10 cases, each naming the mutation
it kills).
- `wiki/testing/strategies.md` — added Round 6 (incident → lesson
  → pattern → anti-pattern), plus a "Forbidden test shapes" section
  consolidated from CLAUDE.md.
- `wiki/testing/conventions.md` — codified two new rules: tests
  must name the mutation they kill, and the extract-for-testability
  pattern is mandatory when a host component is too heavy to mount.
- `CLAUDE.md` § 10 — added Name the Mutation, Extract for
  Testability, Document New Strategies in the Wiki sub-rules so
  agents apply the policy by default.

## [2026-05-05] doc | desktop updater modal architecture

Replaced the native Tauri `ask()` dialog used for "Update available"
with a custom Kobalte AlertDialog wrapper
(`packages/ui/src/components/update-available-dialog.tsx`). The
native dialog couldn't scroll its body — long changelogs pushed the
"Install and restart" button below the fold.

New layout: flex column with `max-h: 80vh`, sticky header + sticky
footer, body scrolls independently. State surfaced via a module-level
signal in `apps/desktop/src/lib/updater.ts` so the host renders the
modal whenever a pending update arrives. The native `message()`
toast is still used for the small "you're up to date" /
"check failed" cases — saves a second custom component for content
that doesn't need it.

Wrote `architecture/desktop-updater.md` capturing:
- Flow (startup silent vs manual; pending → modal → install →
  relaunch).
- Why we picked custom over native (trade-off table).
- Hard rules (`__asciimark_updating` flag for tray-close
  coordination; never block the startup check on user input).
- Tech debt: standalone Release Notes dialog (currently no way to
  read changelog of installed version), markdown rendering inside
  the modal (today plain-text), download-progress UI.
- Lessons: native dialogs are rigid by design — `ask()` works only
  when the body fits in ~3 lines; long-press paths matter for tray
  apps (the `__asciimark_updating` flag is easy to forget, hangs
  relaunch); updater state is genuinely global, render per-pane —
  contrast with the per-instance `renderGen` from Round 5.

Linked from `index.md`.

## [2026-05-05] doc | i18n tech debt + lessons learned

Expanded `architecture/i18n.md` with two new sections that capture
state we shouldn't lose:

- **Technical debt**: site-not-translated (3 follow-up paths, smallest
  is ~30 min), shortcut-descriptions decoupled from i18n, tab-bar
  context menu English-only, MRU command palette discussion (decided
  out of scope this session), TS declarations opt-in flag pending.
- **Lessons learned** from this push, each tagged with cost/why:
  Paraglide v2 `compile` deletes `--outdir`; built-in `localStorage`
  strategy hardcodes `PARAGLIDE_LOCALE` (custom key needs adapter);
  `setLocale({reload:false})` requires `globalVariable` strategy;
  Tauri dev caches bundle harder than reload (already in Round 5,
  reinforced); `(useLocale(), m.foo())` pattern non-obvious — failure
  is silent without the comma; translating long docs is the wrong
  cost; bundle size matters for the extension Web Store limit.

The lessons are written so the *next* pass doesn't re-discover them.

## [2026-05-05] doc | i18n architecture (en + pt-BR + es)

Added `architecture/i18n.md` covering the Paraglide + Solid adapter
pattern that landed across 12 components in this push. Captures:

- Why the `(useLocale(), m.foo())` comma-operator pattern is required
  (Paraglide messages are not signals; without tracking the locale
  signal, JSX freezes on first render).
- Locale detection cascade (localStorage → navigator.language → en).
- Why we use `globalVariable` strategy + custom localStorage key
  rather than Paraglide's built-in localStorage strategy (key
  collision: PARAGLIDE_LOCALE vs asciimark-locale).
- How to add a locale or a key (with the parity check that gates
  pre-commit and pre-push).
- Out-of-scope decisions: site long-form prose isn't i18n'd, core
  shortcut descriptions stay decoupled from i18n, error logs stay
  English.

Linked from `index.md` and cross-references Round 5 (module-level
state pitfall — same class of bug the per-instance signal avoids).

## [2026-05-05] post-mortem | Module-level renderGen broke split-pane previews

A site screenshot exposed a regression: in split mode, the second
pane's preview occasionally rendered as an empty `<article>` even
though the TOC populated correctly. Reproducible 7/8 times on cold
start with `Cmd/Ctrl+\` to split + click another file in the new
pane.

Root cause: `let renderGen = 0` at module scope in
`packages/ui/src/components/preview.tsx`. With two `<Preview>`
instances mounted (one per pane), they shared the cancellation
token; a `setHtml` in pane 1 incremented the counter that pane 0's
in-flight microtask was watching, aborting it mid-swap. Fix: scoped
`renderGen` to the component body and passed an `isStale` predicate
to the top-level async post-processors. Bug rate dropped to 0/20+
on the same trial-loop reproductor.

False signal during debugging: HMR kept the old bundle cached
after the fix, suggesting the bug was only partially fixed (~5/10
trials). Restarting `dev:app` end-to-end made the rate fall to 0.
Lesson: HMR is unreliable for changes to module-level state since
the module is not re-evaluated.

Documented as Round 5 in `testing/strategies.md` along with the
trial-loop technique for measuring intermittent rendering bugs and
two follow-up tests we should land.

## [2026-05-05] doc | Extension release flow

Created `release/extension.md` and linked it from `index.md`. The
existing `release/flow.md` covers desktop only (Tauri pipeline,
`latest.json`, `.sig` files); the Chrome Web Store path is shaped
differently — manual upload, human review, no auto-update — and was
not documented anywhere. Trigger was the v1.3.0 release of the
extension (Open Folder/Reload/Copy URL/Copy content + token-stripping
+ file-tree polish). Doc captures: bump→build→zip→upload, semver
rules, hardener grep, smoke checklist, hard rules, and a section on
the asciidoctor.js / MathJax CDN-fragment stripping (the v1.2.0
rejection cause we don't want to relive).

## [2026-05-05] post-mortem | Split-panes file-loader pane race + tray duplicates + TOC panel wiring

Three follow-up incidents on the split-panes feature, each surfaced
by user testing. The first one is the most interesting: it was the
*second* instance of a class of bug already discussed in Round 4 of
`wiki/testing/strategies.md` (Lesson 5 — host handlers that proxy
through AppState need DI unit tests). Confirms the lesson is real.

### Incident 1 — file-loader pane race

**Symptom**: opening a file (e.g. `intro.adoc`) sometimes left the
preview blank. Specific to fast pane-switching during load.

**Root cause**: `apps/desktop/src/lib/file-loader.ts::loadFileContent`
wrote results through the AppState proxy (`state.setHtml`,
`state.setEditorContent`, …). The proxy reads
`paneManager.activePane()` *at write time*. Between the
`await readFileContent(...)` and the post-convert
`state.setHtml(result.html)` writes, the user could flip the active
pane and the convert result would land on the wrong pane — leaving
the originally-targeted pane stuck on the empty `""` we wrote at
the start of the load.

**Fix**: capture `state.paneManager.activePane()` once at function
entry; call all per-doc setters on that captured PaneStore directly.
Atomic from the user's perspective regardless of pane switches
during the read or convert.

**Test**: `apps/desktop/src/lib/file-loader.test.ts` — first
host-handler unit test that follows the Lesson 5 pattern from
Round 4. Two cases drive `createFileLoader.loadFileContent` against
a real PaneManager with mocked fs.ts + convert. The convert mock
holds on a manual gate; between the await and the resolve, the
test flips the active pane to pane 1, then resolves, then asserts
that pane 0 (the original target) received the html and pane 1
stayed empty. Mutation survival validated by hand —
`s/targetPane.setHtml/state.setHtml/` reverts the fix and both
test cases fail.

### Incident 2 — Tray icons accumulated across restarts

**Symptom**: macOS menu bar showed up to 4 AsciiMark "A" icons after
a few HMR cycles in dev.

**Root cause**: `setupTray()` called `TrayIcon.new({ id: "asciimark-tray" })`
without checking for an existing one. Tauri (or the OS) didn't
dedupe by id alone — every restart stacked another tray.

**Fix**: `apps/desktop/src/lib/tray.ts` calls
`TrayIcon.removeById(TRAY_ID)` (with a swallowed catch) before the
new(). Idempotent across HMR remounts and cold restarts.

### Incident 3 — TOC panel was empty after split-panes refactor

**Symptom**: the right-side `<aside class="toc-panel">` showed
"TABLE OF CONTENTS" header but no entries even when the document
had headings.

**Root cause**: when PaneView was extracted from AppShell, its
Preview received `tocContainer={undefined}`. The TOC was never
copied into the shared aside element.

**Fix**: thread `tocContainer` through PaneView and pass the
AppShell-owned `tocContainerRef` only to the *active* pane's
PaneView. Non-active panes receive `undefined` so two Previews
don't fight over the same DOM target.

### Strategies revisited

`wiki/testing/strategies.md` Round 4 already captures the lessons
that apply here. The file-loader case validates Lesson 5 in
practice — the unit test that catches the race is exactly the
DI-shape that Lesson 5 advocated. The tray and TOC fixes are
narrower and didn't need new strategies, just reactive cleanup
on lifecycle.

### Pattern for next async handlers in `apps/desktop/src/lib/`

Any async function that writes per-doc fields (html, editorContent,
selectedFile, …) MUST capture the target pane on entry:

```ts
async function handler(...) {
  const targetPane = state.paneManager.activePane();
  // ... use targetPane.setX, NOT state.setX
}
```

Candidates worth auditing next pass:
- `apps/desktop/src/lib/folder.ts` (refreshRoot writes via state)
- `apps/desktop/src/app.tsx::handleEditorSave` (autosave path)
- Any other `await` followed by `state.setX` for per-doc fields

## [2026-05-04] post-mortem | Split-panes move-tab content cache bug

A user-reported bug after the split-panes feature shipped — moving a
tab to the other pane and then switching tabs inside the target
pane showed the same preview content for two different files. Root
cause: `handleMoveTab` created the target tab via `openTab` (empty
content) and never copied the source TabState's `editorContent` /
`html` / `frontmatter` / `editorMode` across, so the active pane
signals stayed pointing at whatever was previously rendered.

### Fix
`handleMoveTab` now snapshots from the source `TabState` directly
(NOT the source pane's live signals — those reflect whichever tab
is currently active in the source pane), activates the target pane
*before* mirroring the snapshot through the AppState proxy, copies
the snapshot onto the new tab via `updateActiveTabContent`, then
closes the source.

### Test gap
The existing e2e checked only the COUNT of tabs after the move
(`p0=0, p1=1`). Content was never asserted, so a mutation that
removed `updateActiveTabContent` would have passed cleanly. New
regression e2e in `palettes.webview.test.ts` ("Move preserves
content + tab-switching") opens two distinct files in the
destination pane, switches between them, and asserts
`readmeContent !== guideContent` — fails on the old buggy handler.

### Process learnings (added to `wiki/testing/strategies.md` Round 4)
- `// Mutation captured: …` comments are TODOs, not proof. Run the
  mutation to verify, or don't write the comment.
- Count-based e2e misses content corruption. When a feature renders
  user-visible content that survives tab/pane switches, the e2e
  MUST capture the rendered text and compare distinct files.
- Stateful PBT was scoped to a single `TabStore`; cross-store
  interactions (moving between panes) need their own stateful PBT
  suite at the `PaneManager` level — deferred follow-up.
- Content-faithfulness property test (sequence of open/switch/
  close/move preserves per-tab content) is the deeper invariant.
  Deferred follow-up.
- Host handlers like `handleMoveTab` deserve dependency-injected
  unit tests. Pull pure orchestration logic out of the host and
  domain-test it. Deferred follow-up.

## [2026-05-04] feature | Split editor (2-pane workspace)

### Pages updated
- `wiki/architecture/overview.md` — added PaneStore/PaneManager
  section under "Code paths that matter".

### Code added (out-of-band)
- `packages/ui/src/composables/create-pane-store.ts` — per-pane
  signals + bundled TabStore. Pane signals are the per-document
  truth; tab content lives on the TabState instances inside the
  pane's TabStore.
- `packages/ui/src/composables/create-pane-manager.ts` — list of
  panes (max 2), active index, splitter ratio with localStorage
  persistence, `splitFromActive` / `collapseRightPane` /
  `setActivePane` actions.
- `packages/ui/src/composables/__property__/create-pane-manager.stateful.test.ts`
  — 6 invariants under random sequences of split / collapse /
  focus / setRatio (200 iterations each).
- `packages/ui/src/components/pane-view.tsx` — wraps the
  editor / preview / inner-toolbar markup that used to live inline
  inside `AppShell`. One PaneView per pane. Per-pane editor
  controls (undo/redo triggers, history flags, sync-scroll,
  scroll-to-line) live inside it.
- `packages/ui/src/components/pane-splitter.tsx` — 8px draggable
  divider, double-click resets to 0.5.
- 2 new e2e cases in `apps/desktop/e2e/specs/palettes.webview.test.ts`
  driving Cmd/Ctrl+\\ split + Cmd/Ctrl+1/2 focus via Tauri MCP.

### Decisions
- AppState `editorMode`, `selectedFile`, `html`, `editorContent`,
  `savedContent`, `frontmatter`, `loading`, `selectedRootId` became
  proxies that route to `paneManager.activePane()`. Existing
  consumers (Editor, Preview, file-loader, navigation, toolbar)
  see the same API and don't know about panes.
- Closed-tabs LIFO is **not** per-pane — reopen always brings the
  most-recently-closed tab to the active pane.
- `selectedRootId` per-pane (each pane can be browsing a different
  root). The file-tree sidebar follows the active pane's root.
- Persistence: each pane writes to its own
  `asciimark-tab-session-pane-N` slot. PaneManager persists
  `{paneCount, activePaneIndex}` to `asciimark-pane-layout` and
  the splitter ratio to `asciimark-pane-split-ratio`. Old
  single-pane installs are migrated automatically on first load
  via `migrateLegacyTabSession`: the legacy
  `asciimark-tab-session` slot is moved into pane-0's slot and
  the old key is removed. Reload restores the full split
  workspace (count, focus, ratio, both panes' tabs).
- Watcher: still singleton, follows active pane. Editing a file
  in pane 1 while pane 0 is active won't auto-refresh pane 1's
  preview until the user focuses pane 1. Acceptable trade-off
  for MVP; a `WatcherCoordinator` is a follow-up.

### Shortcuts added
- `Cmd/Ctrl+\\` — split editor / collapse.
- `Cmd/Ctrl+1` / `Cmd/Ctrl+2` — focus pane.
- 3 entries in the Command Palette ("Split Editor",
  "Focus First Pane", "Focus Second Pane") and 3 entries in the
  Shortcuts Help modal.

### UI affordances added (follow-up)
- Toolbar split toggle button (lucide `columns-2` icon) — clicks
  call the same `splitFromActive` / `collapseRightPane` path as
  the keyboard shortcut. Pressed state mirrors `isSplit`.
- Tab context menu entry "Move to Other Pane" — right-click any
  tab while split is open to send it across. When only one pane
  exists the entry reads "Open in Split Pane" and triggers
  `splitFromActive` first. The host orchestrates open-in-target +
  close-in-source via `handleMoveTab` (exposed on `__DEV__` for
  E2E coverage).

## [2026-05-04] feature | Quick Open (Cmd/Ctrl+P fuzzy file finder)

### Pages updated
- `wiki/architecture/overview.md` — added `file-index.ts`/`fuzzy.ts`/
  `quick-open.tsx` to the "Code paths that matter" section.

### Code added (out-of-band, not a wiki ingest)
- `packages/core/src/file-index.ts` — `flattenWorkspace`.
- `packages/core/src/fuzzy.ts` — `fuzzyFilter` wrapping `fzf-for-js`.
- `packages/core/src/file-index.test.ts` (6 domain rules) and
  `packages/core/src/fuzzy.test.ts` (8 domain rules with explicit
  mutation-survival comments — verified that mutating `NAME_BONUS=0`
  and `RECENT_BONUS=0` each fail one test).
- `packages/core/src/__properties__/{file-index,fuzzy}.property.test.ts`
  — fast-check sweeps (4 + 5 properties).
- `packages/ui/src/components/quick-open.tsx` — Solid overlay using
  `<Portal>`, no new primitive installed (matches the in-document
  `search-overlay.tsx` pattern).
- `packages/ui/src/components/quick-open.vtest.tsx` — 10 vtest cases.

### Tests skipped, with rationale
- Stateful PBT for QuickOpen UI (originally on the plan):
  `quick-open` has 3 internal signals (`open`, `query`, `activeIndex`)
  with no concurrency or persistent mutation paths. The class of bugs
  stateful PBT catches (sequence-dependent corruption) does not exist
  here. The fuzzy ranking invariants — which DO benefit from random
  sequences — are covered by `fuzzy.property.test.ts`. The wiki's
  Tier 1 #4 strategy explicitly targets `createTabStore` for this
  pattern, not Quick Open.

## [2026-05-04] lint | health check

### Automatic fixes
- Frontmatter added to all 8 pages (`title`, `audience`, `sources`, `updated`, `tags`, `status`).
  Each page maps to its real source paths in `repo:./...`. Missing frontmatter was the
  biggest structural gap — every page had only `# Title` as the first line.
- Broken link `docs/testing/STRATEGIES.md` → `strategies.md` (2 occurrences in
  `wiki/testing/operations.md`). The old path lived briefly when STRATEGIES.md was at
  `docs/testing/`; the file was moved into the wiki and the absolute reference
  was orphaned.
- Created this log file (`wiki/log.md`).

### Pending (human decision)
- None — no contradictions, no orphans, no audience-boundary leakage detected.

### Suggestions
- Add cross-refs from `wiki/performance/targets.md` to
  `wiki/testing/operations.md` (where the gates run) and
  `wiki/testing/strategies.md` (rationale).
- Add cross-ref from `wiki/release/flow.md` to `wiki/testing/operations.md`
  near the "Pre-tag checklist" table — readers tagging a release will want
  the runbook one click away.
- Consider whether the 6 perf gates listed in `performance/targets.md`
  should also appear inline in `operations.md`, or only via cross-ref.
  Today they're cross-referenced implicitly (both pages mention
  `bun run test:bench`, etc.) — explicit link is friendlier.

### QMD reindex
- `qmd update` already executed: 5 changed (the 5 pages whose content
  was edited; the other 3 only got frontmatter, which doesn't change
  the body hash).
- `qmd embed` already executed: 18 new chunks across the 5 docs.
- `qmd status` reports asciimark collection at 8 files / 1168 vectors,
  refreshed.

### Health summary
| Check | Status |
|---|---|
| Broken cross-refs | ✓ fixed (2) |
| Orphan pages | ✓ none — all 7 topical pages reachable from `index.md` |
| Frontmatter | ✓ now present and complete on all 8 |
| `raw/` ↔ `wiki/sources/` consistency | n/a — wiki populated manually, not via `/wiki-ingest` |
| Audience boundary | ✓ no business rule leakage (the project has no business audience) |
| Contradictions | ✓ none flagged |
| Outdated status | ✓ all `stable`, all `updated: 2026-05-04` |
| `index.md` statistics | ✓ 7 topics linked, 7 files exist |
| QMD index | ✓ 8 docs / 1168 vectors / collection healthy |
