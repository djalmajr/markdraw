/**
 * Routes a workspace file (image / PDF) to the right loader.
 *
 * The Tauri asset protocol scope is `**`, and that glob needs a literal
 * leading dot, so a path with a dot component (`.docs/img.png`, or a root such
 * as `~/.notes`) is refused by `convertFileSrc`. Widening the scope would
 * expose `~/.ssh` and the like to the webview, so such files — and only when
 * they sit inside an opened root — are read as bytes through the confined
 * `read_file_bytes_confined` command and shown from a `blob:` URL. Everything
 * else keeps using `convertFileSrc`.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "./chaos-invoke.ts";

export interface MediaAssetDeps {
  convertFileSrc: (path: string) => string;
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
}

const defaultDeps: MediaAssetDeps = {
  convertFileSrc,
  invoke: <T>(command: string, args: Record<string, unknown>) => invoke<T>(command, args),
};

export type MediaAssetRoute =
  | { kind: "asset"; url: string }
  | { kind: "blob"; load: () => Promise<Blob> };

/** True when any component of `path` starts with a dot (`.`/`..` excluded). */
export function hasDotComponent(path: string): boolean {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  pdf: "application/pdf",
};

export function mimeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${relative.replace(/^\/+/, "")}`;
}

/** Bytes of `relativePath` under `rootPath` via the confined command. */
export async function readConfinedBytes(
  rootPath: string,
  relativePath: string,
  deps: MediaAssetDeps = defaultDeps,
): Promise<Uint8Array> {
  const bytes = await deps.invoke<ArrayBuffer | Uint8Array | number[]>("read_file_bytes_confined", {
    root: rootPath,
    relativePath,
  });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * Decide how to load `relativePath` of the root at `rootPath`:
 *  - no dot component anywhere in the absolute path → `asset` URL
 *    (`convertFileSrc`, unchanged behavior);
 *  - a dot component → `blob` loader (confined byte read), which the viewer
 *    turns into an object URL and revokes when it switches file or unmounts.
 */
export function routeMediaAsset(
  rootPath: string,
  relativePath: string,
  deps: MediaAssetDeps = defaultDeps,
): MediaAssetRoute {
  const absolute = joinPath(rootPath, relativePath);
  if (!hasDotComponent(absolute)) {
    return { kind: "asset", url: deps.convertFileSrc(absolute) };
  }
  const mime = mimeForPath(relativePath);
  return {
    kind: "blob",
    load: async () => {
      const bytes = await readConfinedBytes(rootPath, relativePath, deps);
      // Copy into a plain ArrayBuffer-backed view (BlobPart rejects SharedArrayBuffer).
      return new Blob([new Uint8Array(bytes)], { type: mime });
    },
  };
}

/** Longest opened root that contains `absolutePath`, with the relative rest. */
export function splitUnderRoots(
  absolutePath: string,
  roots: readonly string[],
): { root: string; relative: string } | null {
  const target = absolutePath.replace(/\\/g, "/");
  let best: { root: string; relative: string } | null = null;
  for (const root of roots) {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!r || !target.startsWith(`${r}/`)) continue;
    if (!best || r.length > best.root.length) best = { root: r, relative: target.slice(r.length + 1) };
  }
  return best;
}

/**
 * Fetch the bytes of an absolute path (chat PDF mention): through the asset
 * protocol, except for a dot-component path inside an opened root, which goes
 * through the confined command. Outside every root the old behavior stays
 * (`convertFileSrc`, which the scope will refuse for dot paths).
 */
export async function fetchMediaBytes(
  absolutePath: string,
  roots: readonly string[],
  fetchFn: (url: string) => Promise<Response> = fetch,
  deps: MediaAssetDeps = defaultDeps,
): Promise<Uint8Array> {
  const under = hasDotComponent(absolutePath) ? splitUnderRoots(absolutePath, roots) : null;
  if (under) return readConfinedBytes(under.root, under.relative, deps);
  const response = await fetchFn(deps.convertFileSrc(absolutePath));
  if (!response.ok) throw new Error(`asset fetch failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
