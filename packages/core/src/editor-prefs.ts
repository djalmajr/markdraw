type IndentMode = "tabs" | "spaces";

const WRAP_TEXT_KEY = "markdraw-editor-wrap-text";
const SHOW_LINE_NUMBERS_KEY = "markdraw-editor-show-line-numbers";
const SHOW_INVISIBLES_KEY = "markdraw-editor-show-invisibles";
const SYNC_SCROLL_KEY = "markdraw-editor-sync-scroll";
const INDENT_MODE_KEY = "markdraw-editor-indent-mode";
const INDENT_SIZE_KEY = "markdraw-editor-indent-size";
const TABLE_WRAP_KEY = "markdraw-preview-table-wrap";

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

/** Preview tables wrap to fit width (true, the default) vs scroll
 *  horizontally (false). Wrapping is on by default so wide tables stay
 *  readable without a horizontal scrollbar. */
function getStoredTableWrap(): boolean {
  return getStoredBoolean(TABLE_WRAP_KEY, true);
}

function setStoredTableWrap(enabled: boolean): void {
  localStorage.setItem(TABLE_WRAP_KEY, String(enabled));
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
  getStoredTableWrap,
  getStoredWrapText,
  setStoredIndentMode,
  setStoredIndentSize,
  setStoredLineNumbers,
  setStoredShowInvisibles,
  setStoredSyncScroll,
  setStoredTableWrap,
  setStoredWrapText,
};
