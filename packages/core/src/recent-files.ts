import * as v from "valibot";
import { RecentFileSchema, type RecentFile, safeJsonParse, tryParse } from "./schemas.ts";

const LEGACY_STORAGE_KEY = "markdraw-recent-files";
const STORAGE_KEY = "markdraw-recent-files-v2";
const MAX_RECENT = 10;

const RecentFileListSchema = v.array(RecentFileSchema);

function readRecentFiles(): RecentFile[] {
  localStorage.removeItem(LEGACY_STORAGE_KEY);

  // Validate the whole list shape at the storage boundary. The schema
  // is permissive (`v.array(RecentFileSchema)`) so individual broken
  // entries fail the parse — that's intentional: a list with one
  // garbage entry should not nuke the rest. We fall back to
  // per-element tryParse below to preserve the surviving entries.
  const list = safeJsonParse(localStorage.getItem(STORAGE_KEY), v.array(v.unknown()));
  if (!list) return [];

  const files: RecentFile[] = [];
  for (const item of list) {
    const file = tryParse(RecentFileSchema, item);
    if (file) files.push(file);
  }
  return files.slice(0, MAX_RECENT);
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
