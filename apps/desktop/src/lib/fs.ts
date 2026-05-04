import { invoke } from "./chaos-invoke.ts";
import type { FSEntry } from "@asciimark/core/types.ts";

export type { FSEntry };

export async function openDirectory(): Promise<string | null> {
  return await invoke<string | null>("open_directory_dialog");
}

export async function readTree(rootPath: string, includeHiddenEntries = false): Promise<FSEntry[]> {
  return await invoke<FSEntry[]>("read_dir", { includeHiddenEntries, path: rootPath });
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
