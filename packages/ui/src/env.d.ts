/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/solid" />
/// <reference types="chrome-types" />

// markdown-it 15 ships its own types and dropped the global `MarkdownIt`
// namespace that `@types/markdown-it` used to provide (`PluginSimple`,
// `PluginWithOptions`). These aliases keep the plugin declarations below
// readable without a top-level import, which would turn this file into a
// module and break the ambient `declare module` blocks.
type MarkdownItInstance = import("markdown-it").MarkdownIt;
type MarkdownItPlugin = (md: MarkdownItInstance) => void;
type MarkdownItPluginWithOptions<Options> = (
  md: MarkdownItInstance,
  options?: Options,
) => void;

declare module "markdown-it-task-lists" {
  const plugin: MarkdownItPluginWithOptions<{
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }>;
  export default plugin;
}

declare module "markdown-it-footnote" {
  const plugin: MarkdownItPlugin;
  export default plugin;
}

declare module "markdown-it-emoji" {
  export const full: MarkdownItPlugin;
  export const light: MarkdownItPlugin;
  export const bare: MarkdownItPlugin;
}

declare module "markdown-it-deflist" {
  const plugin: MarkdownItPlugin;
  export default plugin;
}

declare module "markdown-it-abbr" {
  const plugin: MarkdownItPlugin;
  export default plugin;
}

declare module "markdown-it-sub" {
  const plugin: MarkdownItPlugin;
  export default plugin;
}

declare module "markdown-it-sup" {
  const plugin: MarkdownItPlugin;
  export default plugin;
}

declare module "markdown-it-ins" {
  const plugin: MarkdownItPlugin;
  export default plugin;
}

declare module "markdown-it-mark" {
  const plugin: MarkdownItPlugin;
  export default plugin;
}

declare module "markdown-it-multimd-table" {
  const plugin: MarkdownItPluginWithOptions<{
    multiline?: boolean;
    rowspan?: boolean;
    headerless?: boolean;
    multibody?: boolean;
    autolabel?: boolean;
  }>;
  export default plugin;
}

declare module "markdown-it-container" {
  const plugin: MarkdownItPluginWithOptions<{
    validate?: (params: string) => boolean | RegExpMatchArray | null;
    render?: (tokens: any[], idx: number, options: any, env: any, self: any) => string;
    marker?: string;
  }>;
  export default plugin;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<
    [string, FileSystemDirectoryHandle | FileSystemFileHandle]
  >;
  getDirectoryHandle(name: string): Promise<FileSystemDirectoryHandle>;
  getFileHandle(name: string): Promise<FileSystemFileHandle>;
}

interface Window {
  showDirectoryPicker(options?: {
    mode?: "read" | "readwrite";
  }): Promise<FileSystemDirectoryHandle>;
}
