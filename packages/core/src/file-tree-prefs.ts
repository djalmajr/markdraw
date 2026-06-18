// Per-key localStorage preferences scoped to the workspace file tree.
// Mirrors the shape of `editor-prefs.ts` — one key per preference,
// no Valibot for simple booleans/enums (Valibot stays reserved for
// multi-field bags like `font-prefs.ts`).
//
// The single difference from `editor-prefs.getStoredBoolean` is that
// invalid stored values fall back to the configured default instead
// of always to `false`. The editor-prefs convention works for prefs
// whose default is `false`; here all four tree-visibility prefs
// default to `true`, so we need the stricter parse to keep
// "corrupt input → default" honest.

const RESPECT_GITIGNORE_KEY = "markdraw-file-tree-respect-gitignore";
const SHOW_ALL_DIRS_KEY = "markdraw-file-tree-show-all-dirs";
const SHOW_ALL_FILES_KEY = "markdraw-file-tree-show-all-files";
const SHOW_HIDDEN_KEY = "markdraw-file-tree-show-hidden";

function getStoredStrictBoolean(key: string, defaultValue: boolean): boolean {
  const stored = localStorage.getItem(key);
  if (stored === "true") return true;
  if (stored === "false") return false;
  return defaultValue;
}

function getStoredRespectGitignore(): boolean {
  return getStoredStrictBoolean(RESPECT_GITIGNORE_KEY, true);
}

function setStoredRespectGitignore(enabled: boolean): void {
  localStorage.setItem(RESPECT_GITIGNORE_KEY, String(enabled));
}

function getStoredShowAllDirs(): boolean {
  return getStoredStrictBoolean(SHOW_ALL_DIRS_KEY, true);
}

function setStoredShowAllDirs(enabled: boolean): void {
  localStorage.setItem(SHOW_ALL_DIRS_KEY, String(enabled));
}

function getStoredShowAllFiles(): boolean {
  return getStoredStrictBoolean(SHOW_ALL_FILES_KEY, true);
}

function setStoredShowAllFiles(enabled: boolean): void {
  localStorage.setItem(SHOW_ALL_FILES_KEY, String(enabled));
}

function getStoredShowHiddenEntries(): boolean {
  return getStoredStrictBoolean(SHOW_HIDDEN_KEY, true);
}

function setStoredShowHiddenEntries(enabled: boolean): void {
  localStorage.setItem(SHOW_HIDDEN_KEY, String(enabled));
}

export {
  getStoredRespectGitignore,
  getStoredShowAllDirs,
  getStoredShowAllFiles,
  getStoredShowHiddenEntries,
  setStoredRespectGitignore,
  setStoredShowAllDirs,
  setStoredShowAllFiles,
  setStoredShowHiddenEntries,
};
