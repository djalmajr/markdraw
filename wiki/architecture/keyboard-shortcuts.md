---
title: "Keyboard shortcuts — three-source rule"
audience: dev
sources:
  - repo:./packages/core/src/keyboard-shortcuts.ts
  - repo:./apps/desktop/src/app.tsx
  - repo:./packages/ui/src/components/shortcuts-help.tsx
  - repo:./packages/ui/src/components/command-palette.tsx
updated: 2026-05-06
tags: [shortcuts, ux, conventions, command-palette]
status: stable
---

# Keyboard shortcuts — three-source rule

Every binding the app responds to MUST be discoverable through three
parallel surfaces. Adding only the keydown handler is a regression
trap — the new shortcut works for the developer who wrote it and is
invisible to everyone else.

## The three surfaces

| Surface | Source of truth | Why |
|---|---|---|
| **Keydown handler** | `apps/desktop/src/app.tsx` (or wherever the global keyboard listener lives) | The behavior itself — without this the shortcut does nothing. |
| **Shortcuts help modal** | `packages/core/src/keyboard-shortcuts.ts` `SHORTCUTS` array, rendered by `packages/ui/src/components/shortcuts-help.tsx` | Discoverable via Cmd/Ctrl+/. Users open it to learn what's available; missing entries silently hide features. |
| **Command palette** | The `commandCatalog` array in `apps/desktop/src/app.tsx`, rendered by `command-palette.tsx`. Each command's `shortcut: { mac, other }` is the binding hint shown on the right. | Cmd/Ctrl+Shift+P search. Power users navigate by name first; missing entries make the feature unfindable by keyword. |

## Why all three

Shortcuts modal is the **literal catalog** — without it, a feature
that has a binding but no UI button is invisible to anyone who didn't
read the changelog. Command palette is the **search-first** path —
its shortcut hint and `run` callback also work as a fallback when the
keybinding clashes with an OS-level shortcut on the user's setup.
Both reference the same `mac` / `other` arrays so the platform split
stays consistent.

## Checklist for a new shortcut

When you add a binding, do all four of these in the same change:

1. **Catalog**: append a `ShortcutDescriptor` to `SHORTCUTS` in
   `keyboard-shortcuts.ts`. Pick the right `group` so it lands in
   the correct section of the modal.
2. **Handler**: add the keydown branch in `apps/desktop/src/app.tsx`
   (or the closest global handler for your context). Use the same
   key shape as the descriptor.
3. **Command palette entry**: add a `Command` to `commandCatalog` with
   the same `shortcut` field. The `run` callback must do the same
   thing as the keydown branch — they're alternative entry points
   to the same behavior.
4. **i18n**: every catalog title goes through `m.command_*` and the
   shortcut description goes through the modal's i18n strings. Run
   `bun scripts/i18n-check.ts` before committing.

## Anti-patterns

- **Keydown only**: feature ships, but only the author can find it.
- **Palette only, no keybind**: fine for rarely-used commands; do it
  intentionally, not by accident.
- **Different binding in handler vs palette hint**: the palette
  becomes a lie. Source the binding from the descriptor (or a
  shared constant) so the two can't drift.
- **Skipping the modal**: power users learn a tool by hitting
  Cmd/Ctrl+/. If the binding isn't there, they assume it doesn't
  exist.

## Teclas reservadas pelo SO — sempre tenha um fallback

Algumas teclas são interceptadas pelo sistema operacional ou pelo
window manager antes do webview vê-las. Bindar **só** essas teclas
faz a feature ser invisível no SO afetado.

| Tecla | Quem captura | Plataformas afetadas | Mitigação |
|---|---|---|---|
| `F11` | Mission Control / "Show Desktop" | macOS (default) | Use `Cmd+.` como primário; aceite `F11` como fallback. |
| `F12` | DevTools (em alguns webviews) | Linux/Windows | Não bindar. |
| `Cmd+H` | Hide window | macOS | Não bindar como primário. |
| `Cmd+M` | Minimize window | macOS | Não bindar como primário. |
| `Cmd+Q` | Quit app | macOS | Não bindar; deixar para o sistema. |
| `Cmd+W` | Close window/tab | macOS / web | OK bindar dentro do app (já é o atalho de close-tab). |
| `Cmd+Space` | Spotlight | macOS | Não bindar. |
| `F3 / Shift+F3` | Mission Control variants | macOS | Não bindar. |

Regra prática: quando um atalho desejado for `Fn` puro ou `Cmd+Fn` no
macOS, valide que ele de fato chega ao webview rodando em produção
(o Tauri não engole tudo). Se não chegar, escolha um chord
`Cmd+<letra>` ou `Cmd+<pontuação>` como primário e mantenha o
candidato original como fallback no handler de keydown — a redundância
custa uma linha e cobre teclados onde o usuário desabilitou o
comportamento padrão do SO.

**Caso real**: Reader Mode foi bindado em `F11` por reflexo
"fullscreen-style". No macOS o atalho nunca chegava ao app porque o
Mission Control engole o evento antes do webview. Resolveu trocando
o primário para `Cmd+.` e mantendo `F11` aceito no handler.

## Related

- [Architecture overview](./overview.md) — where the keyboard
  handler sits in the desktop app's top-level layout.
- [Test conventions](../testing/conventions.md) — when adding a
  shortcut, the regression test must name the mutation that would
  break the catalog↔handler↔palette link.
