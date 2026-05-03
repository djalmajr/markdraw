import * as v from "valibot";
import { RecentFolderSchema, type RecentFolder, tryParse } from "./schemas.ts";

const STORAGE_KEY = "asciimark-recent-folders-v1";
const MAX_RECENT = 10;

function readRecentFolders(): RecentFolder[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];

    const folders: RecentFolder[] = [];
    for (const item of parsed) {
      const folder = tryParse(RecentFolderSchema, item);
      if (folder) folders.push(folder);
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
  const validated = v.parse(RecentFolderSchema, folder);
  const folders = readRecentFolders().filter((recentFolder) => {
    return recentFolder.path !== validated.path;
  });

  folders.unshift(validated);
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
