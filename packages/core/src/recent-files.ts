const LEGACY_STORAGE_KEY = "asciimark-recent-files";
const STORAGE_KEY = "asciimark-recent-files-v2";
const MAX_RECENT = 10;

interface RecentFile {
  name: string;
  path: string;
  rootName: string;
  rootPath: string;
}

function isStringField(value: object, fieldName: string): boolean {
  return typeof Reflect.get(value, fieldName) === "string";
}

function parseRecentFile(value: unknown): RecentFile | null {
  if (typeof value !== "object" || value === null) return null;
  if (!isStringField(value, "name")) return null;
  if (!isStringField(value, "path")) return null;
  if (!isStringField(value, "rootName")) return null;
  if (!isStringField(value, "rootPath")) return null;

  const name = Reflect.get(value, "name");
  const path = Reflect.get(value, "path");
  const rootName = Reflect.get(value, "rootName");
  const rootPath = Reflect.get(value, "rootPath");
  if (typeof name !== "string") return null;
  if (typeof path !== "string") return null;
  if (typeof rootName !== "string") return null;
  if (typeof rootPath !== "string") return null;

  return {
    name,
    path,
    rootName,
    rootPath,
  };
}

function readRecentFiles(): RecentFile[] {
  localStorage.removeItem(LEGACY_STORAGE_KEY);

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];

    const files: RecentFile[] = [];
    for (const item of parsed) {
      const recentFile = parseRecentFile(item);
      if (recentFile) {
        files.push(recentFile);
      }
    }

    return files.slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function getRecentFiles(): RecentFile[] {
  return readRecentFiles();
}

function addRecentFile(file: RecentFile): RecentFile[] {
  const files = readRecentFiles().filter((recentFile) => {
    return !(recentFile.path === file.path && recentFile.rootPath === file.rootPath);
  });

  files.unshift(file);
  const trimmed = files.slice(0, MAX_RECENT);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  return trimmed;
}

function removeRecentFile(path: string, rootPath: string): RecentFile[] {
  const files = readRecentFiles().filter((recentFile) => {
    return !(recentFile.path === path && recentFile.rootPath === rootPath);
  });

  localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
  return files;
}

function clearRecentFiles(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export {
  type RecentFile,
  addRecentFile,
  clearRecentFiles,
  getRecentFiles,
  removeRecentFile,
};
