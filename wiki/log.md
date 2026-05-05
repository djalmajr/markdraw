# Wiki log

Operations on this wiki, newest first.

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
