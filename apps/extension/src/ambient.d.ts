/// <reference types="chrome-types" />

// File System Access API — surfaces showDirectoryPicker on Window and the
// async iterator extras on FileSystemDirectoryHandle. The browsers we
// support (Chromium-based) ship these; TypeScript's lib.dom.d.ts hasn't
// caught up.
interface Window {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<
    [string, FileSystemDirectoryHandle | FileSystemFileHandle]
  >;
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  keys(): AsyncIterableIterator<string>;
}
