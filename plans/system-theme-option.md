# System/Auto Theme Option

## Objective

Replace the binary dark mode Switch in the toolbar with a 3-state Theme selector (System/Light/Dark) inside the Settings dropdown menu.

## Files to Modify

### 1. `src/components/App.tsx`

**BEFORE (lines 1, 35, 99-107, 597-620):**

```tsx
import { createSignal, createEffect, onCleanup, Show } from "solid-js";
// ...
import { getStoredTheme, applyTheme } from "../newtab.tsx";
// ...
const [darkMode, setDarkMode] = createSignal(
  document.documentElement.classList.contains("dark")
);

function toggleDarkMode() {
  const next = !darkMode();
  setDarkMode(next);
  applyTheme(next ? "dark" : "light");
}
// ...
<Toolbar
  // ...
  darkMode={darkMode()}
  // ...
  onToggleDarkMode={toggleDarkMode}
  // ...
/>
```

**AFTER:**

```tsx
import { createSignal, createEffect, onCleanup, onMount, Show } from "solid-js";
// ...
import { getStoredTheme, applyTheme, type ThemeMode } from "../newtab.tsx";
// ...
const [themeMode, setThemeMode] = createSignal<ThemeMode>(getStoredTheme());
const [darkMode, setDarkMode] = createSignal(
  document.documentElement.classList.contains("dark")
);

function updateDarkMode() {
  setDarkMode(document.documentElement.classList.contains("dark"));
}

function handleThemeChange(mode: ThemeMode) {
  setThemeMode(mode);
  applyTheme(mode);
  updateDarkMode();
}

// Listen for system color scheme changes to update darkMode when in system mode
onMount(() => {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getStoredTheme() === "system") {
      updateDarkMode();
    }
  };
  mql.addEventListener("change", handler);
  onCleanup(() => mql.removeEventListener("change", handler));
});
// ...
<Toolbar
  // ...
  darkMode={darkMode()}
  themeMode={themeMode()}
  // ...
  onThemeChange={handleThemeChange}
  // (remove onToggleDarkMode)
/>
```

### 2. `src/components/Toolbar.tsx`

**BEFORE:**

- Dark mode Switch in toolbar-right
- `onToggleDarkMode` in ToolbarProps
- `Switch, SwitchControl, SwitchThumb` imports

**AFTER:**

- Remove dark mode Switch from toolbar-right
- Remove `Switch, SwitchControl, SwitchThumb` imports
- Remove `onToggleDarkMode` from ToolbarProps
- Add `themeMode: string` and `onThemeChange: (mode: string) => void` to ToolbarProps
- Add `IconMonitor` import
- Add Theme sub-menu in Settings dropdown (after Auto-refresh, before Code Theme) with RadioGroup: System/Light/Dark

## Inputs/Outputs

- Input: User selects theme mode from the dropdown
- Output: Theme applied immediately, stored in localStorage, darkMode derived signal updated

## Expected Results

- Settings dropdown shows a "Theme" sub-menu with System/Light/Dark radio options
- System mode follows OS preference and reacts to OS changes
- Code theme auto-switching still works via the existing `darkMode` signal
- No dark mode switch in the toolbar-right area anymore

## Risks

- If Switch imports are used elsewhere, removing them could break things (verified: they're only used in Toolbar.tsx for dark mode)
- The newtab.tsx already has a matchMedia listener that calls `applyTheme("system")` which toggles the class; the App listener just needs to read the class after that happens

## Rollback

Revert the changes to App.tsx and Toolbar.tsx.

## Verification

- `npx tsc --noEmit` passes with zero errors
- Visual: Settings dropdown shows Theme sub-menu with 3 options
- System mode follows OS dark/light preference
- Light/Dark explicitly set the theme

## Implementation Checklist

- [ ] Update App.tsx: replace darkMode toggle with themeMode signal + derived darkMode
- [ ] Update App.tsx: add matchMedia listener for system mode
- [ ] Update App.tsx: pass themeMode/onThemeChange to Toolbar, remove onToggleDarkMode
- [ ] Update Toolbar.tsx: remove Switch, add Theme sub-menu in dropdown
- [ ] Update Toolbar.tsx: update ToolbarProps interface
- [ ] Run `npx tsc --noEmit` to verify zero errors
