// The validator — the other thing the Trapio prototype never had (there,
// "no boxes overlap / no arrows cross" was asserted only by a Portuguese
// comment). This runs over the laid-out + routed result and reports geometric
// and semantic problems with severities. The CLI gate fails the build on any
// ERROR; WARNING/INFO are advisory.

import type { LayoutResult, PlacedNode } from "./layout.ts";
import type { RouteResult } from "./routing.ts";
import type { DiagramSpec } from "./spec.ts";
import type { ArrowPoint, BoundingBox } from "./types.ts";

export type Severity = "error" | "warning" | "info";

export interface ValidationIssue {
  severity: Severity;
  code: string;
  message: string;
  ids?: string[];
}

export interface ValidationReport {
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
  ok: boolean;
}

export interface ValidateOpts {
  /** Inset (px) for "is this point inside a box" tests, so an arrow that merely
   *  grazes a box edge doesn't count as passing through it. */
  hitInset?: number;
  /** Samples per arrow segment for the line-through-box check. */
  samplesPerSegment?: number;
  /** Allowed overlap (px²) between two node boxes before it's an error — guards
   *  against floating-point touching. */
  overlapTolerance?: number;
  /** Px a left-aligned label may extend past its box's right edge before it's
   *  flagged as overflowing (guards against sub-pixel touching). */
  textOverflowTolerance?: number;
}

const DEFAULTS: Required<ValidateOpts> = {
  hitInset: 1.5,
  samplesPerSegment: 24,
  overlapTolerance: 1,
  textOverflowTolerance: 2,
};

function overlapArea(a: BoundingBox, b: BoundingBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function pointInBox(px: number, py: number, b: BoundingBox, inset: number): boolean {
  return px > b.x + inset && px < b.x + b.width - inset && py > b.y + inset && py < b.y + b.height - inset;
}

function segmentHitsBox(p0: ArrowPoint, p1: ArrowPoint, b: BoundingBox, inset: number, samples: number): boolean {
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const x = p0[0] + (p1[0] - p0[0]) * t;
    const y = p0[1] + (p1[1] - p0[1]) * t;
    if (pointInBox(x, y, b, inset)) return true;
  }
  return false;
}

function isAxisAligned(p0: ArrowPoint, p1: ArrowPoint): boolean {
  return p0[0] === p1[0] || p0[1] === p1[1];
}

/** Validate a laid-out + routed diagram. Pure; takes the spec for semantic
 *  checks and the geometry results for the spatial ones. */
export function validate(
  spec: DiagramSpec,
  layoutResult: LayoutResult,
  routeResult: RouteResult,
  opts: ValidateOpts = {},
): ValidationReport {
  const o = { ...DEFAULTS, ...opts };
  const issues: ValidationIssue[] = [];
  const add = (severity: Severity, code: string, message: string, ids?: string[]) =>
    issues.push({ severity, code, message, ...(ids ? { ids } : {}) });

  // ── Semantic ──────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  for (const node of spec.nodes) {
    if (seen.has(node.id)) add("error", "duplicate-node-id", `Duplicate node id '${node.id}'.`, [node.id]);
    seen.add(node.id);
  }

  if (spec.lanes && spec.lanes.length > 0) {
    const declared = new Set(spec.lanes.map((l) => l.id));
    for (const node of spec.nodes) {
      if (!declared.has(node.lane)) {
        add("warning", "undeclared-lane", `Node '${node.id}' references lane '${node.lane}' not in spec.lanes (it was appended).`, [node.id]);
      }
    }
  }

  for (const g of spec.groups ?? []) {
    for (const id of g.nodes ?? []) {
      if (!seen.has(id)) add("warning", "group-member-missing", `Group '${g.id}' lists node '${id}' that does not exist.`, [g.id, id]);
    }
  }

  for (const s of routeResult.skipped) {
    if (s.reason.includes("dangling")) {
      add("error", "dangling-edge", `Edge ${s.edge.from}→${s.edge.to}: ${s.reason}.`, [s.edge.from, s.edge.to]);
    } else {
      add("info", "skipped-edge", `Edge ${s.edge.from}→${s.edge.to} skipped: ${s.reason}.`, [s.edge.from, s.edge.to]);
    }
  }

  // ── Geometric: node overlap ────────────────────────────────────────────────
  const placed: PlacedNode[] = [...layoutResult.nodes.values()];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const area = overlapArea(placed[i].bounds, placed[j].bounds);
      if (area > o.overlapTolerance) {
        add("error", "node-overlap", `Nodes '${placed[i].id}' and '${placed[j].id}' overlap (${Math.round(area)}px²).`, [placed[i].id, placed[j].id]);
      }
    }
  }

  // ── Geometric: text overflow ───────────────────────────────────────────────
  // Labels are left-aligned and container-unbound (containerId: null), so a title
  // or body wider than its card spills past the right edge into the gutter rather
  // than wrapping. Widths come from the DOM-free 0.58 char-width heuristic
  // (factories.ts) so this is advisory (warning). Mirrors the skill's lint-scene
  // overflow check (over = text.right - box.right).
  for (const node of placed) {
    const rightEdge = node.bounds.x + node.bounds.width;
    for (const kind of ["title", "body"] as const) {
      const el = node[kind];
      if (!el) continue;
      const over = el.x + el.width - rightEdge;
      if (over > o.textOverflowTolerance) {
        add("warning", "text-overflow", `Node '${node.id}' ${kind} overflows its box by ${Math.round(over)}px.`, [node.id]);
      }
    }
  }

  // ── Geometric: arrows ──────────────────────────────────────────────────────
  for (const r of routeResult.routed) {
    const fromId = r.edge.from;
    const toId = r.edge.to;
    // binding guard: every routed arrow must be reciprocally bound to BOTH cards,
    // else it won't follow when a node moves (the whole point of the diagram). The
    // router always binds (routing.ts bindArrow), so this catches a regression — or
    // a hand-assembled scene — that left an arrow one-way or unbound.
    const a = r.arrow;
    if (!a.startBinding || !a.endBinding) {
      add("error", "arrow-unbound", `Edge ${fromId}→${toId} isn't bound at both ends — it won't follow a moved node.`, [fromId, toId]);
    } else {
      for (const b of [a.startBinding, a.endBinding]) {
        const owner = placed.find((n) => n.rect.id === b.elementId);
        if (owner && !owner.rect.boundElements.some((be) => be.id === a.id)) {
          add("error", "arrow-binding-not-reciprocal", `Edge ${fromId}→${toId} is bound one-way to '${owner.id}' — the node won't carry the arrow on move.`, [fromId, toId, owner.id]);
        }
      }
    }
    // line-through-box: any segment passing through a node that is NOT an endpoint
    for (let s = 1; s < r.points.length; s++) {
      const p0 = r.points[s - 1];
      const p1 = r.points[s];
      if (!isAxisAligned(p0, p1)) {
        add("info", "non-orthogonal-segment", `Edge ${fromId}→${toId} has a diagonal segment.`, [fromId, toId]);
      }
      for (const node of placed) {
        if (node.id === fromId || node.id === toId) continue;
        if (segmentHitsBox(p0, p1, node.bounds, o.hitInset, o.samplesPerSegment)) {
          add("error", "line-through-box", `Edge ${fromId}→${toId} passes through node '${node.id}'.`, [fromId, toId, node.id]);
          break;
        }
      }
    }
    // could-be-straight: a multi-bend route whose endpoints are actually aligned
    if (r.points.length > 2) {
      const a = r.points[0];
      const b = r.points[r.points.length - 1];
      if (a[0] === b[0] || a[1] === b[1]) {
        add("info", "could-be-straight", `Edge ${fromId}→${toId} bends but its endpoints are aligned.`, [fromId, toId]);
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const infos = issues.filter((i) => i.severity === "info");
  return { issues, errors, warnings, infos, ok: errors.length === 0 };
}

/** Human-readable one-line-per-issue summary, for the CLI gate / logs. */
export function formatReport(report: ValidationReport): string {
  if (report.issues.length === 0) return "✓ 0 issues";
  const icon: Record<Severity, string> = { error: "✗", warning: "⚠", info: "ℹ" };
  return report.issues.map((i) => `${icon[i.severity]} [${i.code}] ${i.message}`).join("\n");
}
