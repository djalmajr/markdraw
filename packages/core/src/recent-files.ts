import * as v from "valibot";
import { RecentFileSchema, type RecentFile, tryParse } from "./schemas.ts";

const LEGACY_STORAGE_KEY = "asciimark-recent-files";
const STORAGE_KEY = "asciimark-recent-files-v2";
const MAX_RECENT = 10;

const RecentFileListSchema = v.array(RecentFileSchema);

function readRecentFiles(): RecentFile[] {
  localStorage.removeItem(LEGACY_STORAGE_KEY);

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];

    const files: RecentFile[] = [];
    for (const item of parsed) {
      const file = tryParse(RecentFileSchema, item);
      if (file) files.push(file);
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
  // Validate input at the API boundary too — callers may pass user-shaped data.
  const validated = v.parse(RecentFileSchema, file);
  const files = readRecentFiles().filter((recentFile) => {
    return !(recentFile.path === validated.path && recentFile.rootPath === validated.rootPath);
  });

  files.unshift(validated);
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
  RecentFileListSchema,
  addRecentFile,
  clearRecentFiles,
  getRecentFiles,
  removeRecentFile,
};
