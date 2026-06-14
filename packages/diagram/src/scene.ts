// The canonical `.excalidraw` serializer — the single home for the envelope that
// both the desktop frame (host-side persistence) and the headless CLI (static
// docs) produce. Previously the same `{ type, version, source, appState,
// elements, files }` object was hand-built in two places (the desktop frame's
// `sceneToFile` and the Trapio script's tail); this unifies them.

import type { ExcalidrawElement, ExcalidrawScene } from "./types.ts";

export interface SceneInput {
  /** Generated elements. Typed loosely so the desktop host can pass its own
   *  `unknown[]` scene through unchanged. */
  elements?: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export interface SerializeOpts {
  /** `source` field stamped into the file. Defaults to "asciimark" so the
   *  desktop host keeps writing byte-identical files. */
  source?: string;
  /** Pretty-print with 2-space indent (used for committed doc artifacts);
   *  off by default to match the app's compact on-disk writes. */
  pretty?: boolean;
}

export function buildScene(input: SceneInput, opts: SerializeOpts = {}): ExcalidrawScene {
  return {
    type: "excalidraw",
    version: 2,
    source: opts.source ?? "asciimark",
    elements: (input.elements ?? []) as ExcalidrawElement[],
    appState: input.appState ?? {},
    files: input.files ?? {},
  };
}

export function sceneToFile(input: SceneInput, opts: SerializeOpts = {}): string {
  const scene = buildScene(input, opts);
  return opts.pretty ? JSON.stringify(scene, null, 2) : JSON.stringify(scene);
}
