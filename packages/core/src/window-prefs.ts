// Per-key localStorage preferences scoped to the desktop window /
// app-lifecycle behaviour. Mirrors `editor-prefs.ts` — one key per
// preference, whitelist validation, no Valibot for simple enums.

type CloseBehavior = "tray" | "quit";

const CLOSE_BEHAVIOR_KEY = "markdraw-window-close-behavior";

function getStoredCloseBehavior(): CloseBehavior {
  const stored = localStorage.getItem(CLOSE_BEHAVIOR_KEY);
  if (stored === "tray" || stored === "quit") return stored;
  return "tray";
}

function setStoredCloseBehavior(value: CloseBehavior): void {
  localStorage.setItem(CLOSE_BEHAVIOR_KEY, value);
}

export type { CloseBehavior };
export { getStoredCloseBehavior, setStoredCloseBehavior };
