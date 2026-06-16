// In-process AI tools: give the assistant direct, permissioned access to the
// ACTIVE document and the current workspace — context an external MCP server
// can't reach (the open buffer / selection). Each is an engine-neutral AITool
// whose execute reads app state or calls an existing Tauri command. Read/search
// tools run immediately; the edit tool stages a proposal for user Accept/Reject
// (it never mutates the document without approval).

import { invoke } from "./chaos-invoke.ts";
import type {
  ExcalidrawApplyMode,
  ExcalidrawWriteInput,
  ExcalidrawWriteResult,
} from "../components/excalidraw-frame.tsx";
import type { AITool } from "@asciimark/ai/types.ts";

/** Filesystem bridge for the creation/read tools. Paths are workspace-relative
 *  and validated by the Rust side (rejects `..`/absolute paths, creates parent
 *  dirs, refuses overwrite on create). Optional: hosts without a real fs (the
 *  extension) simply don't register those tools. */
export interface ToolFsBridge {
  createDir: (root: string, relative: string) => Promise<void>;
  createFile: (root: string, relative: string) => Promise<void>;
  readFileRelative: (root: string, relative: string) => Promise<string | null>;
  /** Write content to an ABSOLUTE path (host joins root + relative). */
  writeFileAbs: (absPath: string, content: string) => Promise<void>;
}

/** One checklist entry of the live plan the model maintains via
 *  app__update_plan. Structurally matches the UI's AiPlanItem so the host can
 *  pass AppState.setAiPlanItems through without conversion. */
export interface PlanToolItem {
  done: boolean;
  text: string;
}

/** Resolved file a path-targeted app__excalidraw_write should land in. Built
 *  HERE (where the workspace-path resolver lives) so the host consumes the
 *  pieces directly: `absPath` keys its Excalidraw frame registry, `root`+`rel`
 *  feed the fs primitives and the file tree. */
export interface ExcalidrawWriteTarget {
  /** `root` + "/" + `rel` — the key the host's frame registry uses. */
  absPath: string;
  /** Root-relative path (forward slashes). */
  rel: string;
  /** Absolute path of the workspace root containing the file. */
  root: string;
}

/** Input of the applyExcalidrawMermaid dep: the guest write plus an optional
 *  resolved target file. Absent target → the currently open diagram. */
export interface ExcalidrawMermaidRequest extends ExcalidrawWriteInput {
  target?: ExcalidrawWriteTarget;
}

/** What the host did to a path target before drawing in it. */
export interface ExcalidrawTargetFileOutcome {
  created: boolean;
  opened: boolean;
  /** Absolute path of the targeted `.excalidraw` file. */
  path: string;
}

/** Result of the applyExcalidrawMermaid dep: the guest's write result, plus —
 *  for path-targeted writes only — what the host did to reach the target. */
export interface ExcalidrawMermaidOutcome extends ExcalidrawWriteResult {
  file?: ExcalidrawTargetFileOutcome;
}

/** Where a spec-generated diagram lands relative to existing file content. */
export type ExcalidrawGenerateMode = "replace-all" | "append";

/** Input of the generateExcalidrawDiagram dep: a declarative DiagramSpec (the
 *  @asciimark/diagram format, validated host-side), a placement mode, and the
 *  resolved target file the diagram is written into. */
export interface ExcalidrawGenerateRequest {
  /** A DiagramSpec object — shape-validated and laid out by @asciimark/diagram. */
  spec: unknown;
  mode: ExcalidrawGenerateMode;
  target: ExcalidrawWriteTarget;
}

/** Result of the generateExcalidrawDiagram dep. Never thrown — problems come
 *  back as `error` (host/IO) or `issues` (the validation gate). */
export interface ExcalidrawGenerateOutcome {
  ok: boolean;
  error?: string;
  /** Validation-gate or spec-parse issues that blocked the write. */
  issues?: string[];
  /** Elements written to the file (on success). */
  elements?: number;
  file?: ExcalidrawTargetFileOutcome;
}

export interface InProcessToolDeps {
  /** Filesystem bridge enabling app__read_file / app__create_file /
   *  app__create_folder. Omitted -> those tools are not offered. */
  fs?: ToolFsBridge;
  /** Full text of the document the user is currently editing. */
  getActiveDoc: () => string;
  /** Active document's path (or null when an untitled/empty tab is focused). */
  getActiveDocPath: () => string | null;
  /** Compact text outline of the active `.excalidraw` scene (the canvas lives
   *  in a guest frame, so the editor buffer is empty). Resolves to null when
   *  the active view isn't an Excalidraw, the frame isn't ready, or the scene
   *  is empty. Optional so non-Excalidraw hosts can omit it. */
  getActiveExcalidrawOutline?: () => Promise<string | null>;
  /** Absolute paths of the open workspace roots. */
  getWorkspaceRoots: () => string[];
  /** Stage an edit proposal for the user to Accept/Reject. Resolves to a short
   *  status string fed back to the model (applied / rejected / not found). */
  proposeEdit: (edit: { find: string; replace: string }) => Promise<string>;
  /** Restore scrubbed `[secret-N]` placeholders in strings the model sends
   *  that must match or land in REAL files (file content is scrubbed on the
   *  way out, so the model only ever echoes placeholders). Omitted -> strings
   *  pass through unchanged. */
  restoreSecretsIn?: (s: string) => string;
  /** Scrub secrets out of outbound text the fs bridge does NOT cover (search
   *  result lines, the Excalidraw scene outline) before it reaches the model.
   *  Omitted -> text passes through unchanged. */
  scrubSecretsIn?: (s: string) => string;
  /** Replace the live plan shown in the chat UI (null clears it). Optional:
   *  app__update_plan is offered only when the host provides this. Pure UI
   *  state — the tool runs without approval. */
  updatePlan?: (items: PlanToolItem[] | null) => void;
  /** Draw/update a diagram from Mermaid text. No `input.target` → draws in
   *  the active `.excalidraw` (current behavior); with a resolved target the
   *  host opens that file (creating it first when missing) and renders there.
   *  Returns a failure result (not a throw) when the canvas isn't available. */
  applyExcalidrawMermaid: (input: ExcalidrawMermaidRequest) => Promise<ExcalidrawMermaidOutcome>;
  /** Generate a diagram from a declarative DiagramSpec (richer than Mermaid:
   *  lanes, groups, auto-routed + bound arrows, a validation gate) and write it
   *  into the target `.excalidraw` file, creating/opening it. Omitted → the tool
   *  isn't offered (hosts without a real filesystem). */
  generateExcalidrawDiagram?: (input: ExcalidrawGenerateRequest) => Promise<ExcalidrawGenerateOutcome>;
  /** Active workspace-indexing tier. Off → app__search_workspace greps (today's
   *  behavior); lite/full → it queries the prepared index (with grep fallback
   *  when the index is empty). Omitted → treated as "off". */
  getIndexingTier?: () => "off" | "lite" | "full";
  /** Query the per-root index. Returns file-relative hits ({path, line, text});
   *  the host maps the Rust IndexHit. Omitted → no index path (grep only). */
  indexSearch?: (
    root: string,
    query: string,
    tier: "lite" | "full",
    queryVector?: number[],
  ) => Promise<{ path: string; line: number; text: string }[]>;
  /** Embed a query string for Full semantic search. Resolves null when no
   *  embedding provider is available (caller degrades to keyword search). */
  embedQuery?: (query: string) => Promise<number[] | null>;
}

const APPLY_MODES: readonly ExcalidrawApplyMode[] = ["replace-selection", "append", "replace-all"];
const GENERATE_MODES: readonly ExcalidrawGenerateMode[] = ["replace-all", "append"];

/** Mirror of the Rust `FileMatch` (find_in_files). The struct has no serde
 *  rename_all, so fields arrive snake_case — same shape lib/fs.ts documents. */
interface FileMatch {
  line_number: number;
  line_text: string;
  path: string;
}

interface DirEntryLite {
  name: string;
  kind: string;
  path: string;
}

const APP = "app";
const SEARCH_RESULT_CAP = 50;

// Shared sentence for every path-taking tool so the model learns the
// multi-root namespace once instead of per tool.
const MULTI_ROOT_PATHS_NOTE =
  " When several workspace folders are open, every path is namespaced by its workspace " +
  "name (the folder's basename, e.g. 'my-notes/docs/guide.md') — app__list_files reports " +
  "the names.";

// Steers the model away from app__propose_edit (a text-replace that can't touch
// the canvas) and toward the Excalidraw write tool when reading a diagram.
const EXCALIDRAW_READ_NOTE =
  "This is an Excalidraw diagram (scene outline, not editable text). Use " +
  "app__excalidraw_write to draw or update it; app__propose_edit does not apply.";

export function buildInProcessTools(deps: InProcessToolDeps): AITool[] {
  // Inbound restore: the model's find/replace/content strings carry the
  // `[secret-N]` placeholders it saw on read — map them back to the real
  // values before they touch (or must match) actual file content.
  const restore = (s: string): string => deps.restoreSecretsIn?.(s) ?? s;
  // Outbound scrub for the paths that bypass the (already scrubbing) fs
  // bridge: search hit lines and the Excalidraw outline.
  const scrub = (s: string): string => deps.scrubSecretsIn?.(s) ?? s;

  const readActiveDoc: AITool = {
    name: "app__read_active_doc",
    source: APP,
    description: "Read the full text of the document the user is currently editing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      // An open `.excalidraw` has an empty editor buffer (the canvas lives in a
      // guest frame) — serve a scene outline instead of pretending it's blank.
      const outline = await deps.getActiveExcalidrawOutline?.();
      const path = deps.getActiveDocPath();
      if (typeof outline === "string") {
        return { content: scrub(outline), kind: "excalidraw", note: EXCALIDRAW_READ_NOTE, path };
      }
      if (path?.toLowerCase().endsWith(".excalidraw")) {
        // Diagram active but no outline (frame not ready, or empty scene): the
        // note still tells the model what it's looking at — silently returning
        // "" would read as a blank text document.
        return { content: "", kind: "excalidraw", note: EXCALIDRAW_READ_NOTE, path };
      }
      return { path, content: deps.getActiveDoc() };
    },
  };

  const searchWorkspace: AITool = {
    name: "app__search_workspace",
    source: APP,
    description:
      "Search the user's workspace files (markdown/asciidoc/text) for a query string. Returns matching file paths with line numbers." +
      MULTI_ROOT_PATHS_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const query = String((args as { query?: unknown })?.query ?? "").trim();
      if (!query) return { matches: [], note: "empty query" };
      const roots = rootNamesFor(deps.getWorkspaceRoots());
      if (roots.length === 0) return { matches: [], note: "no workspace open" };

      // Prepared-index path (Fast/Complete tiers). For Complete we embed the
      // query first; if that yields no vector we fall back to keyword search.
      const tier = deps.getIndexingTier?.() ?? "off";
      const indexSearch = deps.indexSearch;
      if (tier !== "off" && indexSearch) {
        const queryVector =
          tier === "full" && deps.embedQuery ? await deps.embedQuery(query).catch(() => null) : null;
        const indexTier: "lite" | "full" = tier === "full" && queryVector ? "full" : "lite";
        const perRoot = await Promise.all(
          roots.map(async (root) => {
            const hits = await indexSearch(root.path, query, indexTier, queryVector ?? undefined).catch(
              () => [],
            );
            return hits.map((h) => ({
              path: roots.length > 1 ? `${root.name}/${h.path}` : h.path,
              line: h.line,
              text: scrub(h.text),
            }));
          }),
        );
        const merged = perRoot.flat();
        // A non-empty index answers; an empty result (index not built yet) falls
        // through to grep so search keeps working before the first index pass.
        if (merged.length > 0) {
          return {
            matches: merged.slice(0, SEARCH_RESULT_CAP),
            truncated: merged.length > SEARCH_RESULT_CAP,
            mode: indexTier,
          };
        }
      }

      // Off, or the index produced nothing: literal grep across roots,
      // concurrently; the result cap applies to the MERGED list.
      const perRoot = await Promise.all(
        roots.map(async (root) => {
          const matches = await invoke<FileMatch[]>("find_in_files", { root: root.path, query });
          return matches.map((m) => ({
            path: roots.length > 1 ? `${root.name}/${m.path}` : m.path,
            line: m.line_number,
            text: scrub(m.line_text),
          }));
        }),
      );
      const merged = perRoot.flat();
      return {
        matches: merged.slice(0, SEARCH_RESULT_CAP),
        truncated: merged.length > SEARCH_RESULT_CAP,
      };
    },
  };

  const listFiles: AITool = {
    name: "app__list_files",
    source: APP,
    description: "List the files and folders in the open workspace." + MULTI_ROOT_PATHS_NOTE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const roots = rootNamesFor(deps.getWorkspaceRoots());
      if (roots.length === 0) return { entries: [], note: "no workspace open" };
      const perRoot = await Promise.all(
        roots.map(async (root) => {
          const entries = await invoke<DirEntryLite[]>("read_dir", { path: root.path });
          return entries.map((e) => ({
            name: e.name,
            kind: e.kind,
            path: roots.length > 1 ? `${root.name}/${e.path}` : e.path,
          }));
        }),
      );
      // Single root keeps today's shape; multi-root swaps `root` for `roots`,
      // the names that namespace every entry path above.
      if (roots.length === 1) return { root: roots[0].path, entries: perRoot[0] };
      return { entries: perRoot.flat(), roots: roots.map((r) => r.name) };
    },
  };

  const proposeEdit: AITool = {
    name: "app__propose_edit",
    source: APP,
    description:
      "Propose an edit to the ACTIVE document by replacing the first exact occurrence of `find` with `replace`. The change is NOT applied until the user approves it (Accept/Reject). Only works on the document open in the editor — for any other workspace file use app__edit_file.",
    inputSchema: {
      type: "object",
      properties: {
        find: { type: "string", description: "Exact text to locate in the document." },
        replace: { type: "string", description: "Replacement text." },
      },
      required: ["find", "replace"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const a = args as { find?: unknown; replace?: unknown };
      const find = restore(String(a?.find ?? ""));
      const replace = restore(String(a?.replace ?? ""));
      if (!find) return { status: "error", message: "`find` is required." };
      const status = await deps.proposeEdit({ find, replace });
      return { status };
    },
  };

  const writeExcalidraw: AITool = {
    name: "app__excalidraw_write",
    source: APP,
    description:
      "Draw or update a diagram in an Excalidraw canvas by providing the diagram as Mermaid " +
      "text. Two modes: without `path`, draws on the .excalidraw file the user currently has " +
      "open (fails when none is open); with `path` (workspace-relative, ending in " +
      "'.excalidraw'), the app opens that file — creating it first when it doesn't exist — " +
      "and renders there, with no user action required. Excalidraw renders ONLY these " +
      "Mermaid diagram types as editable shapes: flowchart, sequenceDiagram, classDiagram, " +
      "and erDiagram — prefer them. Other types (pie, gantt, state, mindmap, …) come in as " +
      "a single flat image, so avoid them. `mode` controls placement: " +
      "'replace-selection' swaps the user's current diagram selection for the new one AND " +
      "re-wires the arrows that connected to the replaced part onto the new diagram, so it " +
      "stays stitched into the surrounding flow (use this when they ask to expand, change, or " +
      "fix the SELECTED block — generate just the replacement for that block, not the whole " +
      "diagram; falls back to append if nothing is selected); 'append' adds the diagram below " +
      "existing content (the default — use to add to the canvas); 'replace-all' clears the " +
      "canvas first (only when explicitly asked to start over)." +
      MULTI_ROOT_PATHS_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        mermaid: {
          type: "string",
          description: "The diagram as Mermaid syntax (flowchart/sequenceDiagram/classDiagram/erDiagram).",
        },
        mode: {
          type: "string",
          enum: ["replace-selection", "append", "replace-all"],
          description: "Where to place the diagram. Defaults to 'append'.",
        },
        path: {
          type: "string",
          description:
            "Workspace-relative path of the .excalidraw file to draw in (created and opened " +
            "automatically when missing). Omit to draw on the currently open diagram.",
        },
      },
      required: ["mermaid"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const a = args as { mermaid?: unknown; mode?: unknown; path?: unknown };
      const mermaid = restore(String(a?.mermaid ?? "")).trim();
      if (!mermaid) return { ok: false, error: "`mermaid` is required." };
      const mode: ExcalidrawApplyMode = APPLY_MODES.includes(a?.mode as ExcalidrawApplyMode)
        ? (a.mode as ExcalidrawApplyMode)
        : "append";
      const path = typeof a?.path === "string" ? a.path.trim() : "";
      if (!path) return deps.applyExcalidrawMermaid({ mermaid, mode });
      if (!path.toLowerCase().endsWith(".excalidraw")) {
        return {
          ok: false,
          error:
            `\`path\` must point at a .excalidraw file (got '${path}'). ` +
            "Omit it to draw on the currently open diagram.",
        };
      }
      const resolved = resolveWorkspacePath(deps.getWorkspaceRoots(), path);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const target: ExcalidrawWriteTarget = {
        absPath: `${resolved.root.path}/${resolved.rel}`,
        rel: resolved.rel,
        root: resolved.root.path,
      };
      const result = await deps.applyExcalidrawMermaid({ mermaid, mode, target });
      // Echo the path as the model sent it so it can correlate the result.
      return { ...result, path };
    },
  };

  const tools = [readActiveDoc, searchWorkspace, listFiles, proposeEdit, writeExcalidraw];

  // ── Spec-based diagram generation (gated on the dep) ─────────────────────
  // Richer than the Mermaid path: a declarative DiagramSpec with lanes, groups,
  // and edges that the engine auto-sizes, auto-routes, and BINDS (arrows follow
  // nodes), behind a geometric validation gate. Always writes into a file.
  const generateDiagram = deps.generateExcalidrawDiagram;
  if (generateDiagram) {
    const generateExcalidraw: AITool = {
      name: "app__excalidraw_generate",
      source: APP,
      description:
        "Generate a diagram into a workspace .excalidraw file from a declarative `spec` " +
        "(AsciiMark's own format — more powerful than Mermaid for architecture diagrams). " +
        "The engine assigns positions, auto-sizes boxes from their text, routes arrows " +
        "through the gutters, and BINDS arrows to their nodes (so they follow when moved); " +
        "a validation gate rejects overlaps and arrows crossing unrelated boxes. The spec: " +
        "`nodes` are cards each in a `lane` (lanes are columns laid out left→right, in the " +
        "order they first appear or as listed in `lanes`); within a lane, nodes stack top→" +
        "down in array order. `edges` connect node ids ({from,to}); `kind` " +
        "(request/auth/control/data) colors them. `groups` draw a dashed frame around member " +
        "node ids. Keep edges between adjacent lanes or vertically adjacent nodes so the " +
        "gate stays clean. `path` (workspace-relative, ending '.excalidraw') is created and " +
        "opened automatically. `mode`: 'replace-all' (default) writes the whole file; " +
        "'append' adds the new diagram below existing content." +
        MULTI_ROOT_PATHS_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          spec: {
            type: "object",
            description: "The DiagramSpec.",
            properties: {
              title: {
                type: "object",
                properties: { text: { type: "string" }, subtitle: { type: "string" } },
                required: ["text"],
              },
              lanes: {
                type: "array",
                description: "Optional explicit column order/widths. Omit to derive lanes from nodes.",
                items: {
                  type: "object",
                  properties: { id: { type: "string" }, title: { type: "string" }, width: { type: "number" } },
                  required: ["id"],
                },
              },
              groups: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    nodes: { type: "array", items: { type: "string" } },
                    color: { type: "string" },
                  },
                  required: ["id"],
                },
              },
              nodes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    lane: { type: "string" },
                    title: { type: "string" },
                    body: { type: "string" },
                    shape: { type: "string", enum: ["box", "rect"] },
                    group: { type: "string" },
                  },
                  required: ["id", "lane", "title"],
                },
              },
              edges: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    from: { type: "string" },
                    to: { type: "string" },
                    kind: { type: "string", enum: ["request", "auth", "control", "data", "default"] },
                    label: { type: "string" },
                    color: { type: "string" },
                    dash: { type: "boolean" },
                  },
                  required: ["from", "to"],
                },
              },
            },
            required: ["nodes", "edges"],
          },
          path: {
            type: "string",
            description: "Workspace-relative path of the .excalidraw file (created and opened automatically).",
          },
          mode: {
            type: "string",
            enum: ["replace-all", "append"],
            description: "Where to place the diagram. Defaults to 'replace-all'.",
          },
        },
        required: ["spec", "path"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = isRecord(args) ? args : {};
        if (!isRecord(a.spec)) return { ok: false, error: "`spec` (a DiagramSpec object) is required." };
        const path = typeof a.path === "string" ? a.path.trim() : "";
        if (!path) return { ok: false, error: "`path` is required." };
        if (!path.toLowerCase().endsWith(".excalidraw")) {
          return { ok: false, error: `\`path\` must point at a .excalidraw file (got '${path}').` };
        }
        const mode: ExcalidrawGenerateMode = GENERATE_MODES.includes(a.mode as ExcalidrawGenerateMode)
          ? (a.mode as ExcalidrawGenerateMode)
          : "replace-all";
        const resolved = resolveWorkspacePath(deps.getWorkspaceRoots(), path);
        if ("error" in resolved) return { ok: false, error: resolved.error };
        const target: ExcalidrawWriteTarget = {
          absPath: `${resolved.root.path}/${resolved.rel}`,
          rel: resolved.rel,
          root: resolved.root.path,
        };
        const result = await generateDiagram({ spec: a.spec, mode, target });
        return { ...result, path };
      },
    };
    tools.push(generateExcalidraw);
  }

  // ── Live plan tool (gated on the updatePlan dep) ─────────────────────────
  // Runs WITHOUT approval (source "app" defaults to the auto tier): it only
  // mutates UI state — no file, no document, nothing the user must gate.
  const updatePlan = deps.updatePlan;
  if (updatePlan) {
    const updatePlanTool: AITool = {
      name: "app__update_plan",
      source: APP,
      description:
        "Maintain a live task checklist the user sees (and can check off) while you work. " +
        "Each call REPLACES the whole plan — always send the FULL current plan, never a " +
        "partial diff. Mark finished steps done: true and keep upcoming ones done: false; " +
        "re-send the plan after each meaningful step so the checklist stays current. " +
        "Send an empty items array to clear the plan when the work is finished or abandoned.",
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description:
              "The COMPLETE plan, in order (max 30 items). Replaces the previous plan entirely; [] clears it.",
            items: {
              type: "object",
              properties: {
                done: { type: "boolean", description: "Whether this step is already complete." },
                text: { type: "string", description: "Short imperative description of the step." },
              },
              required: ["done", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = isRecord(args) ? args : {};
        const parsed = parsePlanItems(a.items);
        if ("error" in parsed) return { status: "error", message: parsed.error };
        // An empty plan means "no plan" — clear the card instead of showing
        // an empty husk.
        updatePlan(parsed.items.length === 0 ? null : parsed.items);
        return { status: "ok", itemCount: parsed.items.length };
      },
    };
    tools.push(updatePlanTool);
  }

  // ── Filesystem tools (desktop only — gated on the fs bridge) ─────────────
  // Reads run automatically; create_file/create_folder declare
  // `approval: "prompt"` so the host's Accept/Reject bar gates every write
  // (read/write tiers as policy — same model the omp agent uses).
  const fs = deps.fs;
  if (fs) {
    // With several roots open the FIRST path segment names the root; the
    // remainder stays workspace-relative for the (Rust-validated) bridge.
    const resolvePath = (path: string): ResolvedWorkspacePath | { error: string } =>
      resolveWorkspacePath(deps.getWorkspaceRoots(), path);

    // Back-compat READ fallback: with ONE root paths resolve literally, but a
    // model that learned the multi-root namespace (before the other roots
    // were closed) may still prefix the root name. The literal path always
    // wins — only when it is MISSING is the redundant prefix retried
    // stripped. Creates/writes/excalidraw targets never get this: they must
    // land exactly where the (user-approved) path says.
    const readResolved = async (
      resolved: ResolvedWorkspacePath,
    ): Promise<{ content: string; rel: string } | null> => {
      const content = await fs.readFileRelative(resolved.root.path, resolved.rel);
      if (content !== null) return { content, rel: resolved.rel };
      if (deps.getWorkspaceRoots().length !== 1) return null;
      const prefix = `${resolved.root.name}/`;
      if (!resolved.rel.startsWith(prefix)) return null;
      const rel = resolved.rel.slice(prefix.length);
      if (!rel) return null;
      const fallback = await fs.readFileRelative(resolved.root.path, rel);
      return fallback === null ? null : { content: fallback, rel };
    };

    const readFile: AITool = {
      name: "app__read_file",
      source: APP,
      description:
        "Read a file from the open workspace by its workspace-relative path (as returned by " +
        "app__list_files / app__search_workspace). Large files: page through them with " +
        "startLine/endLine (1-based, inclusive) — the response then includes totalLines, so " +
        "read e.g. lines 1-400, then 401-800, … until totalLines is covered (the line range " +
        "is sliced before the size cap, so every slice of a huge file is reachable). Pass " +
        "numbered: true to prefix each line with its line number as 'N→'; use those numbers " +
        "to build line-anchored `edits` for app__edit_file. The 'N→' prefix is metadata, NOT " +
        "file content — strip everything through the first '→' when quoting the file's text." +
        MULTI_ROOT_PATHS_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          endLine: {
            type: "integer",
            description: "Last line to read (1-based, inclusive). Defaults to the end of the file.",
          },
          numbered: {
            type: "boolean",
            description: "Prefix each line with 'N→' (its 1-based line number). The prefix is not part of the file.",
          },
          path: { type: "string", description: "Workspace-relative path, e.g. 'docs/notes.md'." },
          startLine: { type: "integer", description: "First line to read (1-based). Defaults to 1." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = isRecord(args) ? args : {};
        const path = typeof a.path === "string" ? a.path.trim() : "";
        if (!path) return { status: "error", message: "`path` is required." };
        const resolved = resolvePath(path);
        if ("error" in resolved) return { status: "error", message: resolved.error };
        const read = await readResolved(resolved);
        if (read === null) {
          return {
            status: "error",
            message: `File not found: ${path}. Use app__list_files or app__search_workspace to discover valid paths.`,
          };
        }
        const content = read.content;
        const startLine = readLineParam(a.startLine);
        const endLine = readLineParam(a.endLine);
        const numbered = a.numbered === true;
        if (startLine === undefined && endLine === undefined && !numbered) {
          // Legacy whole-file read: raw content, original line endings.
          if (content.length > READ_FILE_CAP) {
            return { content: content.slice(0, READ_FILE_CAP), path, truncated: true };
          }
          return { content, path };
        }
        // Ranged/numbered read. The range slices LINES first, the char cap
        // applies after — so paging can reach any slice of a huge file.
        const lines = splitLines(content);
        const totalLines = lines.length;
        const requestedStart = startLine ?? 1;
        const requestedEnd = endLine ?? totalLines;
        const start = clampLine(requestedStart, totalLines);
        const end = Math.max(start, clampLine(requestedEnd, totalLines));
        // Out-of-range requests clamp instead of erroring, but the note keeps
        // the model honest about what it actually received.
        const note =
          start !== requestedStart || end !== requestedEnd
            ? `Requested lines ${requestedStart}-${requestedEnd}, but the file has ${totalLines} lines — serving ${start}-${end}.`
            : undefined;
        const slice = lines.slice(start - 1, end);
        const body = numbered
          ? slice.map((line, i) => `${start + i}→${line}`).join("\n")
          : slice.join("\n");
        const truncated = body.length > READ_FILE_CAP;
        return {
          content: truncated ? body.slice(0, READ_FILE_CAP) : body,
          endLine: end,
          ...(note ? { note } : {}),
          path,
          startLine: start,
          totalLines,
          ...(truncated ? { truncated: true } : {}),
        };
      },
    };

    const createFolder: AITool = {
      name: "app__create_folder",
      source: APP,
      approval: "prompt",
      description:
        "Create a folder (and any missing parents) at a workspace-relative path. The user approves each call." +
        MULTI_ROOT_PATHS_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative folder path, e.g. 'notes/drafts'." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const path = String((args as { path?: unknown })?.path ?? "").trim();
        if (!path) return { status: "error", message: "`path` is required." };
        const resolved = resolvePath(path);
        if ("error" in resolved) return { status: "error", message: resolved.error };
        try {
          await fs.createDir(resolved.root.path, resolved.rel);
          return { status: "created", path };
        } catch (err) {
          return { status: "error", message: creationErrorMessage(err, path) };
        }
      },
    };

    const createFile: AITool = {
      name: "app__create_file",
      source: APP,
      approval: "prompt",
      description:
        "Create a NEW file at a workspace-relative path, optionally with initial content. Refuses to overwrite an existing file — to change one, use app__propose_edit on the active document instead. The user approves each call." +
        MULTI_ROOT_PATHS_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Initial file content. Defaults to empty." },
          path: { type: "string", description: "Workspace-relative file path, e.g. 'notes/ideas.md'." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = args as { content?: unknown; path?: unknown };
        const path = String(a?.path ?? "").trim();
        if (!path) return { status: "error", message: "`path` is required." };
        const resolved = resolvePath(path);
        if ("error" in resolved) return { status: "error", message: resolved.error };
        try {
          await fs.createFile(resolved.root.path, resolved.rel);
        } catch (err) {
          return { status: "error", message: creationErrorMessage(err, path) };
        }
        const content = typeof a?.content === "string" ? restore(a.content) : "";
        if (content) {
          // create_file validated the path against the root; writing through
          // the joined absolute path reuses that vetted location.
          await fs.writeFileAbs(`${resolved.root.path}/${resolved.rel}`, content);
        }
        return { status: "created", path, bytes: content.length };
      },
    };

    const editFile: AITool = {
      name: "app__edit_file",
      source: APP,
      approval: "prompt",
      description:
        "Edit ANY workspace file. Two modes. (1) find/replace: replace an exact occurrence of " +
        "`find` with `replace` — read the file first (app__read_file) and copy `find` exactly, " +
        "whitespace included; use `all: true` to replace every occurrence. (2) line-anchored: " +
        "pass `edits`, an array of { startLine, endLine, expectedText, replace } hunks. Line " +
        "numbers come from app__read_file with numbered: true; expectedText is the RAW current " +
        "text of lines startLine..endLine joined with \\n (strip the 'N→' prefixes — they are " +
        "not file content). Hunks must not overlap; they are applied bottom-up, so the line " +
        "numbers you read stay valid for every hunk. When `edits` is present, find/replace/all " +
        "are ignored. The user approves each call." +
        MULTI_ROOT_PATHS_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          all: {
            type: "boolean",
            description: "find/replace mode: replace every occurrence (default: only the first, which must be unique).",
          },
          edits: {
            type: "array",
            description:
              "Line-anchored mode: non-overlapping hunks, applied bottom-up. When present, find/replace/all are ignored.",
            items: {
              type: "object",
              properties: {
                endLine: { type: "integer", description: "Last line of the hunk (1-based, inclusive)." },
                expectedText: {
                  type: "string",
                  description: "Exact current text of lines startLine..endLine, joined with \\n — no 'N→' prefixes.",
                },
                replace: { type: "string", description: "New text for the range. An empty string deletes the lines." },
                startLine: { type: "integer", description: "First line of the hunk (1-based)." },
              },
              required: ["endLine", "expectedText", "replace", "startLine"],
              additionalProperties: false,
            },
          },
          find: {
            type: "string",
            description: "find/replace mode: exact text to locate in the file. Required unless `edits` is given.",
          },
          path: { type: "string", description: "Workspace-relative file path." },
          replace: { type: "string", description: "find/replace mode: replacement text." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const a = isRecord(args) ? args : {};
        const path = typeof a.path === "string" ? a.path.trim() : "";
        if (!path) return { status: "error", message: "`path` is required." };
        const resolved = resolvePath(path);
        if ("error" in resolved) return { status: "error", message: resolved.error };
        // Edits write back through `read.rel` — the path the read actually
        // resolved — so a fallback-located file is edited in place, never a
        // phantom sibling at the literal (missing) path.
        const read = await readResolved(resolved);
        if (read === null) {
          return {
            status: "error",
            message: `File not found: ${path}. Use app__list_files to discover valid paths, or app__create_file for a new file.`,
          };
        }
        const raw = read.content;
        if (a.edits !== undefined) {
          const parsed = parseLineEdits(a.edits);
          if ("error" in parsed) return { status: "error", message: parsed.error };
          // Line-anchored hunks stay in the ONE coordinate system the model
          // saw: numbered reads serve SCRUBBED text, and scrubbing can
          // collapse a multiline secret (e.g. a PEM block) into a single
          // `[secret-N]` line — restored line numbers would skew at/below it.
          // Verify and splice against the scrubbed text with the hunks AS
          // SENT, then restore once on write: restore(scrub(x)) === x keeps
          // untouched regions byte-identical and maps placeholder lines back.
          const applied = applyLineEdits(raw, parsed.hunks, path);
          if ("error" in applied) return { status: "error", message: applied.error };
          await fs.writeFileAbs(`${resolved.root.path}/${read.rel}`, restore(applied.next));
          return { path, replacements: parsed.hunks.length, status: "edited" };
        }
        // find/replace mode is coordinate-free: the bridge scrubs reads for
        // the model's benefit, so restore its strings and match against the
        // REAL text (no-op when no scrubbing dep is wired).
        const content = restore(raw);
        const find = typeof a.find === "string" ? restore(a.find) : "";
        if (!find) {
          return { status: "error", message: "`find` is required (or pass `edits` for line-anchored mode)." };
        }
        // `replace` must be explicit in find mode — a silently-defaulted ""
        // would DELETE the matched text on an accidental omission.
        if (typeof a.replace !== "string") {
          return { status: "error", message: "`replace` is required in find/replace mode (use \"\" to delete the match explicitly)." };
        }
        const replace = restore(a.replace);
        const occurrences = content.split(find).length - 1;
        if (occurrences === 0) {
          // Instructional no-match (omp-style): point at a near miss when one
          // exists so the model fixes its `find` instead of flailing.
          const fuzzyAt = content.toLowerCase().indexOf(find.toLowerCase());
          const hint =
            fuzzyAt >= 0
              ? ` A similar passage exists at line ${content.slice(0, fuzzyAt).split("\n").length} but differs in casing or whitespace — re-read the file with app__read_file and copy it exactly.`
              : " Re-read the file with app__read_file and copy the text exactly.";
          return { status: "error", message: `No occurrence of \`find\` in ${path}.${hint}` };
        }
        if (occurrences > 1 && a.all !== true) {
          return {
            status: "error",
            message: `\`find\` matches ${occurrences} places in ${path}. Add more surrounding lines to make it unique, or pass all: true to replace every occurrence.`,
          };
        }
        const next =
          a.all === true
            ? content.split(find).join(replace)
            : content.replace(find, replace);
        await fs.writeFileAbs(`${resolved.root.path}/${read.rel}`, next);
        return { path, replacements: a.all === true ? occurrences : 1, status: "edited" };
      },
    };

    tools.push(readFile, createFolder, createFile, editFile);
  }

  return tools;
}

/** Cap for app__read_file so a huge file can't blow the model's context. */
const READ_FILE_CAP = 50_000;

/** Cap for app__update_plan so a runaway model can't flood the plan card. */
const PLAN_ITEM_CAP = 30;

/** Structurally validate app__update_plan's `items` into a clean list.
 *  Returns an instructional error string for the model instead of throwing —
 *  tool errors are conversation content, not exceptions. */
function parsePlanItems(raw: unknown): { items: PlanToolItem[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return {
      error:
        "`items` must be an array of { done: boolean, text: string } — send the FULL current plan (or [] to clear it).",
    };
  }
  if (raw.length > PLAN_ITEM_CAP) {
    return {
      error: `Plan too long: ${raw.length} items (max ${PLAN_ITEM_CAP}). Merge steps into broader items and resend the full plan.`,
    };
  }
  const items: PlanToolItem[] = [];
  for (const entry of raw) {
    const e = isRecord(entry) ? entry : {};
    const text = typeof e.text === "string" ? e.text.trim() : "";
    if (!text || typeof e.done !== "boolean") {
      return {
        error:
          "Each plan item needs a non-empty string `text` and a boolean `done` — resend the FULL plan with every item shaped as { done, text }.",
      };
    }
    items.push({ done: e.done, text });
  }
  return { items };
}

/** Narrowing guard for tool args (the engine hands them over as `unknown`). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** A finite numeric line parameter, or undefined when absent/garbage. */
function readLineParam(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function clampLine(n: number, totalLines: number): number {
  return Math.min(Math.max(1, Math.trunc(n)), totalLines);
}

/** Line splitting shared by app__read_file's ranged/numbered reads and
 *  app__edit_file's line-anchored hunks: both sides MUST agree on what
 *  "line N" means, so trailing `\r` is normalized away — CRLF and LF files
 *  number identically, and an expectedText written with plain `\n` matches
 *  either. (applyLineEdits re-joins with the file's dominant line ending.) */
function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

/** One hunk of app__edit_file's line-anchored `edits` mode. */
interface LineEditHunk {
  endLine: number;
  expectedText: string;
  replace: string;
  startLine: number;
}

/** Structurally validate `edits` and order the hunks bottom-up (descending
 *  startLine). Returns an instructional error string for the model instead
 *  of throwing — tool errors are conversation content, not exceptions. */
function parseLineEdits(raw: unknown): { hunks: LineEditHunk[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "`edits` must be a non-empty array of { startLine, endLine, expectedText, replace } hunks." };
  }
  const hunks: LineEditHunk[] = [];
  for (const entry of raw) {
    const e = isRecord(entry) ? entry : {};
    const startLine = readLineParam(e.startLine);
    const endLine = readLineParam(e.endLine);
    if (
      startLine === undefined ||
      endLine === undefined ||
      typeof e.expectedText !== "string" ||
      typeof e.replace !== "string"
    ) {
      return { error: "Each edit needs integer startLine/endLine and string expectedText/replace." };
    }
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      return { error: `Invalid hunk range ${startLine}-${endLine}: need 1 <= startLine <= endLine.` };
    }
    hunks.push({ endLine, expectedText: e.expectedText, replace: e.replace, startLine });
  }
  hunks.sort((x, y) => y.startLine - x.startLine);
  for (let i = 0; i + 1 < hunks.length; i++) {
    const below = hunks[i]; // higher startLine (applied first)
    const above = hunks[i + 1];
    if (above.endLine >= below.startLine) {
      return {
        error:
          `Hunks ${above.startLine}-${above.endLine} and ${below.startLine}-${below.endLine} overlap — ` +
          "merge them into a single hunk or adjust the ranges so each line is edited at most once.",
      };
    }
  }
  return { hunks };
}

/** Verify every hunk against the CURRENT file content, then apply them
 *  bottom-up (hunks arrive sorted by descending startLine, so each splice
 *  leaves the line numbers of the hunks still to apply untouched). All
 *  verification happens before any mutation — a stale anchor rejects the
 *  whole call. */
function applyLineEdits(
  content: string,
  hunks: LineEditHunk[],
  path: string,
): { next: string } | { error: string } {
  const lines = splitLines(content);
  const totalLines = lines.length;
  for (const hunk of hunks) {
    if (hunk.endLine > totalLines) {
      return {
        error:
          `Hunk ${hunk.startLine}-${hunk.endLine} is out of range — ${path} has ${totalLines} lines. ` +
          "Re-read the file with app__read_file (numbered: true) and rebuild the hunk from current line numbers.",
      };
    }
    const expected = splitLines(hunk.expectedText);
    const spanned = hunk.endLine - hunk.startLine + 1;
    if (expected.length !== spanned) {
      return {
        error:
          `Hunk ${hunk.startLine}-${hunk.endLine} spans ${spanned} lines but expectedText has ` +
          `${expected.length} — expectedText must be exactly the current text of those lines. ` +
          "Re-read the file with app__read_file (numbered: true).",
      };
    }
    for (let i = 0; i < expected.length; i++) {
      const lineNo = hunk.startLine + i;
      const actual = lines[lineNo - 1] ?? "";
      if (actual !== expected[i]) {
        return {
          error:
            `Stale anchor: line ${lineNo} of ${path} is ${JSON.stringify(actual)} but expectedText says ` +
            `${JSON.stringify(expected[i])}. The file changed since it was read — re-read it with ` +
            "app__read_file (numbered: true) and rebuild the hunk from current line numbers.",
        };
      }
    }
  }
  for (const hunk of hunks) {
    // Empty replace deletes the range; otherwise the replacement may grow or
    // shrink the hunk's line count freely.
    const replacement = hunk.replace === "" ? [] : splitLines(hunk.replace);
    lines.splice(hunk.startLine - 1, hunk.endLine - hunk.startLine + 1, ...replacement);
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return { next: lines.join(eol) };
}

/** A workspace root paired with the model-facing name that namespaces its
 *  paths when several roots are open. */
export interface NamedWorkspaceRoot {
  name: string;
  path: string;
}

/** Outcome of resolving a (possibly root-qualified) tool path: the root it
 *  belongs to plus the remainder, which stays root-relative for the bridge
 *  (the Rust side keeps rejecting `..`/absolute remainders). */
export interface ResolvedWorkspacePath {
  rel: string;
  root: NamedWorkspaceRoot;
}

/** Basename of a root path, tolerant of Windows separators and a trailing
 *  slash — the model-facing workspace name. */
function rootBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  return base || "workspace";
}

/** Name each open root after its folder basename, in open order. Basename
 *  collisions get "-2"/"-3"… suffixes so every name stays unique. */
export function rootNamesFor(roots: string[]): NamedWorkspaceRoot[] {
  const used = new Set<string>();
  return roots.map((path) => {
    const base = rootBasename(path);
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = `${base}-${n}`;
    used.add(name);
    return { name, path };
  });
}

/** Map a tool path onto an open workspace root. With ONE root the path passes
 *  through unchanged — the literal path always wins, because single-root tool
 *  outputs are unprefixed and the root may genuinely contain a top-level
 *  folder named after itself (stripping would silently redirect reads AND
 *  writes one level up). With several roots, the FIRST segment must name a
 *  root. Errors are instructional strings for the model, not throws. */
export function resolveWorkspacePath(
  roots: string[],
  path: string,
): ResolvedWorkspacePath | { error: string } {
  const named = rootNamesFor(roots);
  if (named.length === 0) return { error: "No workspace is open." };
  if (named.length === 1) return { rel: path, root: named[0] };
  const cut = path.indexOf("/");
  const head = cut === -1 ? path : path.slice(0, cut);
  const rest = cut === -1 ? "" : path.slice(cut + 1);
  const match = named.find((r) => r.name === head);
  if (!match) {
    const names = named.map((r) => `${r.name}/`).join(", ");
    return {
      error:
        `Multiple workspaces are open: ${names}. Prefix the path with the workspace name, ` +
        `e.g. '${named[0].name}/notes.md' (app__list_files shows each workspace's files).`,
    };
  }
  if (!rest) {
    return {
      error: `'${path}' names a workspace root, not a file. Append the path inside it, e.g. '${match.name}/notes.md'.`,
    };
  }
  return { rel: rest, root: match };
}

/** Instructional error text (the model reads this — tell it what to do next). */
function creationErrorMessage(err: unknown, path: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/exists/i.test(raw)) {
    return `${path} already exists — pick a different name, or read it first if you meant to build on it.`;
  }
  if (/invalid path/i.test(raw)) {
    return `Invalid path: ${path}. Use a relative path inside the workspace (no '..' or absolute paths).`;
  }
  return raw;
}
