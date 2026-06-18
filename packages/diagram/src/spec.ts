// The declarative diagram spec — Markdraw's own format, deliberately NOT tied to
// Mermaid's node/edge model so it can express lanes, groups, and routing hints
// the layout engine needs. A spec describes WHAT the diagram contains; the layout
// engine decides WHERE everything goes. Editing architecture = editing the spec,
// never coordinates.
//
// Runtime shape validation uses valibot (already a workspace dependency); the
// TypeScript types are inferred from the schemas so there is one source of truth.

import * as v from "valibot";

/** Semantic flavor of an edge — drives default color and dash via the palette. */
export const EdgeKindSchema = v.picklist(["request", "auth", "control", "data", "default"]);

export const NodeStyleSchema = v.object({
  bg: v.optional(v.string()),
  stroke: v.optional(v.string()),
  titleColor: v.optional(v.string()),
  bodyColor: v.optional(v.string()),
});

export const NodeSpecSchema = v.object({
  /** Unique within the spec; referenced by edges and groups. */
  id: v.string(),
  /** Lane this node belongs to (a column). Lanes are laid out left→right. */
  lane: v.string(),
  title: v.string(),
  body: v.optional(v.string()),
  shape: v.optional(v.picklist(["box", "rect"])),
  group: v.optional(v.string()),
  style: v.optional(NodeStyleSchema),
});

export const EdgeSpecSchema = v.object({
  from: v.string(),
  to: v.string(),
  kind: v.optional(EdgeKindSchema),
  label: v.optional(v.string()),
  color: v.optional(v.string()),
  dash: v.optional(v.boolean()),
});

export const LaneSpecSchema = v.object({
  id: v.string(),
  title: v.optional(v.string()),
  width: v.optional(v.number()),
});

export const GroupSpecSchema = v.object({
  id: v.string(),
  title: v.optional(v.string()),
  /** Member node ids; the layout engine draws a dashed boundary around them. */
  nodes: v.optional(v.array(v.string())),
  color: v.optional(v.string()),
});

export const StyleHintsSchema = v.object({
  laneGap: v.optional(v.number()),
  nodeGap: v.optional(v.number()),
  laneWidth: v.optional(v.number()),
  origin: v.optional(v.object({ x: v.number(), y: v.number() })),
});

export const TitleSpecSchema = v.object({
  text: v.string(),
  subtitle: v.optional(v.string()),
});

export const DiagramSpecSchema = v.object({
  title: v.optional(TitleSpecSchema),
  /** Optional explicit lane order/widths. When omitted, lanes are derived from
   *  the distinct `node.lane` values in first-seen order. */
  lanes: v.optional(v.array(LaneSpecSchema)),
  groups: v.optional(v.array(GroupSpecSchema)),
  nodes: v.array(NodeSpecSchema),
  edges: v.array(EdgeSpecSchema),
  styleHints: v.optional(StyleHintsSchema),
});

export type EdgeKind = v.InferOutput<typeof EdgeKindSchema>;
export type NodeStyle = v.InferOutput<typeof NodeStyleSchema>;
export type NodeSpec = v.InferOutput<typeof NodeSpecSchema>;
export type EdgeSpec = v.InferOutput<typeof EdgeSpecSchema>;
export type LaneSpec = v.InferOutput<typeof LaneSpecSchema>;
export type GroupSpec = v.InferOutput<typeof GroupSpecSchema>;
export type StyleHints = v.InferOutput<typeof StyleHintsSchema>;
export type TitleSpec = v.InferOutput<typeof TitleSpecSchema>;
export type DiagramSpec = v.InferOutput<typeof DiagramSpecSchema>;

export interface SpecParseOk {
  ok: true;
  spec: DiagramSpec;
}
export interface SpecParseError {
  ok: false;
  issues: string[];
}

/** Format a valibot issue path like `nodes.0.title` for human-readable errors. */
function issuePath(issue: v.BaseIssue<unknown>): string {
  if (!issue.path) return "(root)";
  return issue.path.map((p) => String((p as { key?: unknown }).key ?? "?")).join(".");
}

/** Validate the STRUCTURAL shape of a spec (types, required fields). Semantic
 *  checks (dangling lane/edge/group references) live in the validator, since
 *  they need the resolved graph. Returns issues as strings rather than throwing
 *  — callers (CLI gate, AI tool) turn them into messages. */
export function parseSpec(input: unknown): SpecParseOk | SpecParseError {
  const result = v.safeParse(DiagramSpecSchema, input);
  if (result.success) return { ok: true, spec: result.output };
  return {
    ok: false,
    issues: result.issues.map((i) => `${issuePath(i)}: ${i.message}`),
  };
}
