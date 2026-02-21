import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Supported AsciiDoc file extensions */
export const ADOC_EXTENSIONS = [".adoc", ".asciidoc", ".asc", ".ad", ".adoc.txt"];

/** Supported Markdown file extensions */
export const MD_EXTENSIONS = [".md", ".markdown", ".mdown"];

/** Check if a filename/path has an AsciiDoc extension */
export function isAdocFile(name: string): boolean {
  return ADOC_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Check if a filename/path has a Markdown extension */
export function isMdFile(name: string): boolean {
  return MD_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Check if a filename/path is a supported document format (AsciiDoc or Markdown) */
export function isSupportedFile(name: string): boolean {
  return isAdocFile(name) || isMdFile(name);
}

/** Escape HTML special characters to prevent XSS */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Directories to skip when building file trees */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target",
  ".next", ".nuxt", ".output", ".cache", ".turbo", ".svelte-kit",
  "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode",
  "coverage", ".nyc_output", "tmp", "temp",
]);
