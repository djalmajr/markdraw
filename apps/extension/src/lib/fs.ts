// File System Access API wrapper with <input webkitdirectory> fallback
import { isSupportedFile, IGNORED_DIRS } from "@asciimark/core/utils.ts";

export type { FSEntry } from "@asciimark/core/types.ts";

/** Whether the browser supports the File System Access API (Brave blocks it) */
export const hasNativePicker = typeof window.showDirectoryPicker === "function";

export async function openDirectory(): Promise<FileSystemDirectoryHandle> {
  return await window.showDirectoryPicker({ mode: "read" });
}

/**
 * Fallback: open a directory using <input type="file" webkitdirectory>.
 * Returns the root folder name and the flat list of File objects.
 */
export function openDirectoryFallback(): Promise<{ rootName: string; files: File[] }> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      document.body.removeChild(input);
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        reject(new DOMException("No files selected", "AbortError"));
        return;
      }
      // Extract root folder name from webkitRelativePath (e.g. "myFolder/sub/file.adoc")
      const firstPath = (files[0] as any).webkitRelativePath as string;
      const rootName = firstPath.split("/")[0] ?? "folder";
      resolve({ rootName, files });
    });

    // Handle cancel — use a focusback heuristic
    input.addEventListener("cancel", () => {
      document.body.removeChild(input);
      reject(new DOMException("User cancelled", "AbortError"));
    });

    input.click();
  });
}

/**
 * Build an FSEntry tree from a flat list of File objects (fallback mode).
 * Each File has webkitRelativePath like "rootDir/sub/file.adoc".
 */
export function buildTreeFromFiles(files: File[]): { rootName: string; entries: FSEntry[] } {
  // All paths start with the root folder name
  const rootName = ((files[0] as any).webkitRelativePath as string).split("/")[0] ?? "folder";

  // Build a nested map structure
  interface DirNode {
    entries: Map<string, DirNode | File>;
  }
  const root: DirNode = { entries: new Map() };

  for (const file of files) {
    const relPath = ((file as any).webkitRelativePath as string);
    // Strip the root folder prefix
    const parts = relPath.split("/").slice(1); // remove root dir name
    if (parts.length === 0) continue;

    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i]!;
      if (!current.entries.has(dirName)) {
        current.entries.set(dirName, { entries: new Map() });
      }
      current = current.entries.get(dirName) as DirNode;
    }
    const fileName = parts[parts.length - 1]!;
    current.entries.set(fileName, file);
  }

  function buildEntries(node: DirNode, parentPath: string): FSEntry[] {
    const entries: FSEntry[] = [];

    for (const [name, value] of node.entries) {
      if (name.startsWith(".")) continue;
      const path = parentPath ? `${parentPath}/${name}` : name;

      if ("entries" in value) {
        // Directory node
        if (IGNORED_DIRS.has(name)) continue;
        const children = buildEntries(value, path);
        if (children.length > 0) {
          entries.push({ name, kind: "directory", path, children });
        }
      } else {
        // File node
        if (isSupportedFile(name)) {
          entries.push({ name, kind: "file", path, file: value });
        }
      }
    }

    return entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  return { rootName, entries: buildEntries(root, "") };
}

export async function readTree(
  dirHandle: FileSystemDirectoryHandle,
  parentPath = "",
): Promise<FSEntry[]> {
  const entries: FSEntry[] = [];

  for await (const [name, handle] of dirHandle.entries()) {
    // Skip hidden files/dirs
    if (name.startsWith(".")) continue;

    const path = parentPath ? `${parentPath}/${name}` : name;

    if (handle.kind === "directory") {
      if (IGNORED_DIRS.has(name)) continue;
      const children = await readTree(
        handle as FileSystemDirectoryHandle,
        path,
      );
      // Only include directories that contain adoc files (directly or nested)
      if (children.length > 0) {
        entries.push({ name, kind: "directory", path, handle, children });
      }
    } else if (handle.kind === "file" && isSupportedFile(name)) {
      entries.push({ name, kind: "file", path, handle });
    }
  }

  // Sort: directories first, then files, alphabetically
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Read file content — supports both native handles and fallback File objects.
 */
export async function readFileContent(
  handleOrFile: FileSystemFileHandle | File,
): Promise<string> {
  if (handleOrFile instanceof File) {
    return await handleOrFile.text();
  }
  const file = await handleOrFile.getFile();
  return await file.text();
}

export async function getFileLastModified(
  handle: FileSystemFileHandle,
): Promise<number> {
  const file = await handle.getFile();
  return file.lastModified;
}

/**
 * Resolve a relative path from a base directory handle.
 * Used for include:: directives.
 */
export async function resolveFileByPath(
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemFileHandle | null> {
  const parts = relativePath.split("/").filter(Boolean);
  let current: FileSystemDirectoryHandle = rootHandle;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (part === "..") {
      // Can't go above root, just skip
      continue;
    }
    try {
      current = await current.getDirectoryHandle(part);
    } catch {
      return null;
    }
  }

  const fileName = parts[parts.length - 1];
  if (!fileName) return null;

  try {
    return await current.getFileHandle(fileName);
  } catch {
    return null;
  }
}

/**
 * Read a file by its relative path from a root directory handle.
 */
export async function readFileByPath(
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<string | null> {
  const fileHandle = await resolveFileByPath(rootHandle, relativePath);
  if (!fileHandle) return null;
  return await readFileContent(fileHandle);
}

/**
 * Build a flat map of path -> File from the fallback file list.
 * Used for resolving include:: directives in fallback mode.
 */
export function buildFileMap(files: File[]): Map<string, File> {
  const map = new Map<string, File>();
  for (const file of files) {
    const relPath = ((file as any).webkitRelativePath as string);
    // Strip root folder name
    const parts = relPath.split("/").slice(1);
    if (parts.length > 0) {
      map.set(parts.join("/"), file);
    }
  }
  return map;
}

/**
 * Read a file by path using the fallback file map.
 */
export async function readFileByPathFallback(
  fileMap: Map<string, File>,
  relativePath: string,
): Promise<string | null> {
  const file = fileMap.get(relativePath);
  if (!file) return null;
  return await file.text();
}

/**
 * Read all files in the tree into a flat map of path -> content.
 * Used for pre-loading includes.
 */
export async function readAllFiles(
  dirHandle: FileSystemDirectoryHandle,
  parentPath = "",
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith(".")) continue;
    const path = parentPath ? `${parentPath}/${name}` : name;

    if (handle.kind === "directory") {
      const nested = await readAllFiles(
        handle as FileSystemDirectoryHandle,
        path,
      );
      for (const [k, v] of nested) {
        files.set(k, v);
      }
    } else if (handle.kind === "file") {
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        const content = await file.text();
        files.set(path, content);
      } catch {
        // Skip unreadable files
      }
    }
  }

  return files;
}

// IndexedDB persistence for directory handle
const DB_NAME = "asciimark";
const STORE_NAME = "handles";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(handle, "rootDir");
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get("rootDir");
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
