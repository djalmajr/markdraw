import { invoke } from "./chaos-invoke.ts";
import type { FSEntry } from "@markdraw/core/types.ts";

export type { FSEntry };

export async function openDirectory(): Promise<string | null> {
  return await invoke<string | null>("open_directory_dialog");
}

export async function readTree(
  rootPath: string,
  includeHiddenEntries = false,
  respectGitignore = false,
): Promise<FSEntry[]> {
  return await invoke<FSEntry[]>("read_dir", {
    includeHiddenEntries,
    respectGitignore,
    path: rootPath,
  });
}

export async function readFileContent(filePath: string): Promise<string> {
  return await invoke<string>("read_file", { path: filePath });
}

export async function readFileByPath(
  rootPath: string,
  relativePath: string,
): Promise<string | null> {
  try {
    return await invoke<string>("read_file_relative", {
      root: rootPath,
      relativePath,
    });
  } catch {
    return null;
  }
}

export async function readFilesRelative(
  rootPath: string,
  paths: string[],
): Promise<Map<string, string>> {
  const result = await invoke<Record<string, string>>("read_files_relative", {
    root: rootPath,
    paths,
  });
  return new Map(Object.entries(result));
}

export async function writeFile(
  filePath: string,
  content: string,
): Promise<void> {
  await invoke("write_file", { path: filePath, content });
}

export async function renameFile(
  rootPath: string,
  oldRelative: string,
  newRelative: string,
): Promise<void> {
  await invoke("rename_file", {
    root: rootPath,
    oldRelative,
    newRelative,
  });
}

export async function trashPath(
  rootPath: string,
  relative: string,
): Promise<void> {
  await invoke("trash_path", { root: rootPath, relative });
}

export async function createFile(
  rootPath: string,
  relative: string,
): Promise<void> {
  await invoke("create_file", { root: rootPath, relative });
}

export async function createDir(
  rootPath: string,
  relative: string,
): Promise<void> {
  await invoke("create_dir", { root: rootPath, relative });
}

export async function copyPath(
  srcRoot: string,
  fromRelative: string,
  dstRoot: string,
  toRelative: string,
): Promise<void> {
  await invoke("copy_path", { srcRoot, fromRelative, dstRoot, toRelative });
}

export async function movePath(
  srcRoot: string,
  srcRelative: string,
  dstRoot: string,
  dstRelative: string,
): Promise<void> {
  await invoke("move_path", { srcRoot, srcRelative, dstRoot, dstRelative });
}

export interface FileMatch {
  /** Workspace-relative, forward-slash path. */
  path: string;
  /** 0-indexed line in the source file. */
  line_number: number;
  /** Verbatim text of the matched line (no normalization). */
  line_text: string;
  /** Byte offset where the match begins inside `line_text`. */
  column_start: number;
  /** Byte offset where the match ends (exclusive). */
  column_end: number;
}

export interface FindInFilesOptions {
  caseSensitive?: boolean;
  includeHiddenEntries?: boolean;
}

export async function findInFiles(
  rootPath: string,
  query: string,
  options: FindInFilesOptions = {},
): Promise<FileMatch[]> {
  return await invoke<FileMatch[]>("find_in_files", {
    root: rootPath,
    query,
    caseSensitive: options.caseSensitive ?? false,
    includeHiddenEntries: options.includeHiddenEntries ?? false,
  });
}
