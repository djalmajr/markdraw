// File System Access API wrapper

export interface FSEntry {
  name: string;
  kind: "file" | "directory";
  path: string;
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  children?: FSEntry[];
}

const ADOC_EXTENSIONS = [".adoc", ".asciidoc", ".asc", ".ad", ".adoc.txt"];

function isAdocFile(name: string): boolean {
  return ADOC_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export async function openDirectory(): Promise<FileSystemDirectoryHandle> {
  return await window.showDirectoryPicker({ mode: "read" });
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
      const children = await readTree(
        handle as FileSystemDirectoryHandle,
        path,
      );
      // Only include directories that contain adoc files (directly or nested)
      if (children.length > 0) {
        entries.push({ name, kind: "directory", path, handle, children });
      }
    } else if (handle.kind === "file" && isAdocFile(name)) {
      entries.push({ name, kind: "file", path, handle });
    }
  }

  // Sort: directories first, then files, alphabetically
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function readFileContent(
  handle: FileSystemFileHandle,
): Promise<string> {
  const file = await handle.getFile();
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
const DB_NAME = "adoc-viewer";
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
