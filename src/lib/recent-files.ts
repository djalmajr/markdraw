const STORAGE_KEY = "asciimark-recent-files";
const MAX_RECENT = 10;

interface RecentFile {
  name: string;
  path: string;
  rootName: string;
}

function getRecentFiles(): RecentFile[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as RecentFile[];
  } catch {
    return [];
  }
}

function addRecentFile(file: RecentFile): RecentFile[] {
  const files = getRecentFiles().filter((f) => f.path !== file.path);
  files.unshift(file);
  const trimmed = files.slice(0, MAX_RECENT);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  return trimmed;
}

function clearRecentFiles(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export { type RecentFile, addRecentFile, clearRecentFiles, getRecentFiles };
