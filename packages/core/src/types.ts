export interface FSEntry {
  name: string;
  kind: "file" | "directory";
  path: string;
  /** Handle is available in native folder mode, absent in URL mode and fallback mode */
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
  /** File object available in fallback mode (input webkitdirectory) */
  file?: File;
  children?: FSEntry[];
}
