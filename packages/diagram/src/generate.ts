// The pipeline: spec → layout → routing → validate → scene. This is the single
// entry both consumers call — the desktop host (build elements, write into the
// open project) and the headless CLI (build elements, write a static doc). The
// only difference between them is the I/O edge; the generation is identical.

import { createCtx } from "./factories.ts";
import { layout, type LayoutDefaults, type LayoutResult } from "./layout.ts";
import { route, type RouteOpts, type RouteResult } from "./routing.ts";
import { buildScene, sceneToFile, type SerializeOpts } from "./scene.ts";
import { parseSpec, type DiagramSpec } from "./spec.ts";
import { validate, type ValidateOpts, type ValidationReport } from "./validate.ts";
import type { ExcalidrawElement, ExcalidrawScene } from "./types.ts";

export interface GenerateOpts {
  layout?: Partial<LayoutDefaults>;
  route?: RouteOpts;
  validate?: ValidateOpts;
  serialize?: SerializeOpts;
}

export interface GenerateResult {
  spec: DiagramSpec;
  elements: ExcalidrawElement[];
  scene: ExcalidrawScene;
  layout: LayoutResult;
  routing: RouteResult;
  report: ValidationReport;
}

/** Build a scene from an already-parsed spec. Pure and deterministic. */
export function generateFromSpec(spec: DiagramSpec, opts: GenerateOpts = {}): GenerateResult {
  const ctx = createCtx();
  const lay = layout(ctx, spec, opts.layout);
  const routing = route(ctx, lay, spec.edges, opts.route);
  // Layout first (group frames, title, node cards), arrows + labels on top.
  const elements = [...lay.elements, ...routing.elements];
  const report = validate(spec, lay, routing, opts.validate);
  const scene = buildScene(
    { elements, appState: { gridSize: null, viewBackgroundColor: "#ffffff" } },
    opts.serialize,
  );
  return { spec, elements, scene, layout: lay, routing, report };
}

export interface GenerateOk extends GenerateResult {
  ok: true;
}
export interface GenerateError {
  ok: false;
  /** Schema-parse issues (bad spec shape). */
  issues: string[];
}

/** Parse unknown input (e.g. AI-tool JSON) then build. Returns parse issues for
 *  a malformed spec; geometric/semantic problems surface in `report`, not here. */
export function generate(input: unknown, opts: GenerateOpts = {}): GenerateOk | GenerateError {
  const parsed = parseSpec(input);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  return { ok: true, ...generateFromSpec(parsed.spec, opts) };
}

export interface GenerateFileOk {
  ok: true;
  content: string;
  report: ValidationReport;
  result: GenerateResult;
}
export interface GenerateFileError {
  ok: false;
  /** Combined parse issues and/or validation errors that blocked the build. */
  issues: string[];
  /** Present when the spec parsed but failed the validation gate. */
  report?: ValidationReport;
}

export interface GenerateFileOpts extends GenerateOpts {
  /** When true, validation ERRORs block output (the build gate). The CLI and
   *  the host both turn this on so a broken diagram never reaches disk. */
  gate?: boolean;
}

/** Parse → build → (optionally gate) → serialize. The one call the host's AI
 *  tool and the CLI share to turn a spec into `.excalidraw` file content. */
export function generateToFile(input: unknown, opts: GenerateFileOpts = {}): GenerateFileOk | GenerateFileError {
  const built = generate(input, opts);
  if (!built.ok) return { ok: false, issues: built.issues };
  if (opts.gate && !built.report.ok) {
    return {
      ok: false,
      issues: built.report.errors.map((e) => `[${e.code}] ${e.message}`),
      report: built.report,
    };
  }
  return { ok: true, content: sceneToFile({ elements: built.elements, appState: built.scene.appState }, opts.serialize), report: built.report, result: built };
}
