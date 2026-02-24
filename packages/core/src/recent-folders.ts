const STORAGE_KEY = "asciimark-recent-folders-v1";
const MAX_RECENT = 10;

interface RecentFolder {
  name: string;
  path: string;
}

function isStringField(value: object, fieldName: string): boolean {
  return typeof Reflect.get(value, fieldName) === "string";
}

function parseRecentFolder(value: unknown): RecentFolder | null {
  if (typeof value !== "object" || value === null) return null;
  if (!isStringField(value, "name")) return null;
  if (!isStringField(value, "path")) return null;

  const name = Reflect.get(value, "name");
  const path = Reflect.get(value, "path");
  if (typeof name !== "string") return null;
  if (typeof path !== "string") return null;

  return {
    name,
    path,
  };
}

function readRecentFolders(): RecentFolder[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];

    const folders: RecentFolder[] = [];
    for (const item of parsed) {
      const recentFolder = parseRecentFolder(item);
      if (recentFolder) {
        folders.push(recentFolder);
      }
    }

    return folders.slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function getRecentFolders(): RecentFolder[] {
  return readRecentFolders();
}

function addRecentFolder(folder: RecentFolder): RecentFolder[] {
  const folders = readRecentFolders().filter((recentFolder) => {
    return recentFolder.path !== folder.path;
  });

  folders.unshift(folder);
  const trimmed = folders.slice(0, MAX_RECENT);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  return trimmed;
}

function removeRecentFolder(path: string): RecentFolder[] {
  const folders = readRecentFolders().filter((recentFolder) => {
    return recentFolder.path !== path;
  });

  localStorage.setItem(STORAGE_KEY, JSON.stringify(folders));
  return folders;
}

function clearRecentFolders(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export {
  type RecentFolder,
  addRecentFolder,
  clearRecentFolders,
  getRecentFolders,
  removeRecentFolder,
};
