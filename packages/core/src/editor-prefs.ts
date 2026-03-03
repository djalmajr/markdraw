const STORAGE_KEY = "asciimark-editor-wrap-text";

function getStoredWrapText(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return true;
  return stored === "true";
}

function setStoredWrapText(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

export { getStoredWrapText, setStoredWrapText };
