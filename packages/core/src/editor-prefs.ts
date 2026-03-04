type IndentMode = "tabs" | "spaces";

const WRAP_TEXT_KEY = "asciimark-editor-wrap-text";
const SHOW_LINE_NUMBERS_KEY = "asciimark-editor-show-line-numbers";
const SHOW_INVISIBLES_KEY = "asciimark-editor-show-invisibles";
const SYNC_SCROLL_KEY = "asciimark-editor-sync-scroll";
const INDENT_MODE_KEY = "asciimark-editor-indent-mode";
const INDENT_SIZE_KEY = "asciimark-editor-indent-size";

function getStoredBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === null) return defaultValue;
  return stored === "true";
}

function getStoredWrapText(): boolean {
  return getStoredBoolean(WRAP_TEXT_KEY, true);
}

function setStoredWrapText(enabled: boolean): void {
  localStorage.setItem(WRAP_TEXT_KEY, String(enabled));
}

function getStoredLineNumbers(): boolean {
  return getStoredBoolean(SHOW_LINE_NUMBERS_KEY, true);
}

function setStoredLineNumbers(enabled: boolean): void {
  localStorage.setItem(SHOW_LINE_NUMBERS_KEY, String(enabled));
}

function getStoredShowInvisibles(): boolean {
  return getStoredBoolean(SHOW_INVISIBLES_KEY, false);
}

function setStoredShowInvisibles(enabled: boolean): void {
  localStorage.setItem(SHOW_INVISIBLES_KEY, String(enabled));
}

function getStoredSyncScroll(): boolean {
  return getStoredBoolean(SYNC_SCROLL_KEY, true);
}

function setStoredSyncScroll(enabled: boolean): void {
  localStorage.setItem(SYNC_SCROLL_KEY, String(enabled));
}

function getStoredIndentMode(): IndentMode {
  const stored = localStorage.getItem(INDENT_MODE_KEY);
  if (stored === "tabs" || stored === "spaces") return stored;
  return "spaces";
}

function setStoredIndentMode(mode: IndentMode): void {
  localStorage.setItem(INDENT_MODE_KEY, mode);
}

function getStoredIndentSize(): number {
  const stored = localStorage.getItem(INDENT_SIZE_KEY);
  const parsed = Number(stored);
  if (parsed === 2 || parsed === 4) return parsed;
  return 2;
}

function setStoredIndentSize(size: number): void {
  localStorage.setItem(INDENT_SIZE_KEY, String(size));
}

export type { IndentMode };
export {
  getStoredIndentMode,
  getStoredIndentSize,
  getStoredLineNumbers,
  getStoredShowInvisibles,
  getStoredSyncScroll,
  getStoredWrapText,
  setStoredIndentMode,
  setStoredIndentSize,
  setStoredLineNumbers,
  setStoredShowInvisibles,
  setStoredSyncScroll,
  setStoredWrapText,
};
