# Solid UI Components

**Source:** https://github.com/stefan-karger/solid-ui

Built with Kobalte & corvu. Styled with Tailwind CSS.

## Always Use Solid UI

When a UI primitive is needed (button, tabs, dropdown, toggle, tooltip, switch, etc.), **always use the solid-ui component** if one exists. Never create custom implementations for primitives that solid-ui provides.

Components live in `packages/ui/src/components/ui/`.

## Installing New Components

The CLI requires interactive input, so create the file manually:

1. Find the component source at `https://github.com/stefan-karger/solid-ui/blob/main/apps/docs/public/r/{component}.json`
2. Copy the `content` field from the JSON file
3. Create `packages/ui/src/components/ui/{component}.tsx`
4. Replace `~/lib/utils` import with `@asciimark/core/utils.ts`

## Available Components

Check the registry at: https://github.com/stefan-karger/solid-ui/tree/main/apps/docs/public/r

Common components: accordion, alert, badge, button, card, checkbox, dialog, dropdown-menu, input, label, popover, select, separator, sheet, skeleton, slider, switch, tabs, textarea, toggle, tooltip.
