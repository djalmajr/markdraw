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

export interface InProcessToolDeps {
  /** Full text of the document the user is currently editing. */
  getActiveDoc: () => string;
  /** Active document's path (or null when an untitled/empty tab is focused). */
  getActiveDocPath: () => string | null;
  /** Absolute paths of the open workspace roots. */
  getWorkspaceRoots: () => string[];
  /** Stage an edit proposal for the user to Accept/Reject. Resolves to a short
   *  status string fed back to the model (applied / rejected / not found). */
  proposeEdit: (edit: { find: string; replace: string }) => Promise<string>;
  /** Draw/update a diagram in the active `.excalidraw` from Mermaid text.
   *  Returns a failure result (not a throw) when no diagram is open. */
  applyExcalidrawMermaid: (input: ExcalidrawWriteInput) => Promise<ExcalidrawWriteResult>;
}

const APPLY_MODES: readonly ExcalidrawApplyMode[] = ["replace-selection", "append", "replace-all"];

/** Mirror of the Rust `FileMatch` (find_in_files), camelCased over IPC. */
interface FileMatch {
  path: string;
  lineNumber: number;
  lineText: string;
}

interface DirEntryLite {
  name: string;
  kind: string;
  path: string;
}

const APP = "app";
const SEARCH_RESULT_CAP = 50;

export function buildInProcessTools(deps: InProcessToolDeps): AITool[] {
  const readActiveDoc: AITool = {
    name: "app__read_active_doc",
    source: APP,
    description: "Read the full text of the document the user is currently editing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({
      path: deps.getActiveDocPath(),
      content: deps.getActiveDoc(),
    }),
  };

  const searchWorkspace: AITool = {
    name: "app__search_workspace",
    source: APP,
    description:
      "Search the user's workspace files (markdown/asciidoc/text) for a query string. Returns matching file paths with line numbers.",
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
      const root = deps.getWorkspaceRoots()[0];
      if (!root) return { matches: [], note: "no workspace open" };
      const matches = await invoke<FileMatch[]>("find_in_files", { root, query });
      return {
        matches: matches.slice(0, SEARCH_RESULT_CAP).map((m) => ({
          path: m.path,
          line: m.lineNumber,
          text: m.lineText,
        })),
        truncated: matches.length > SEARCH_RESULT_CAP,
      };
    },
  };

  const listFiles: AITool = {
    name: "app__list_files",
    source: APP,
    description: "List the files and folders in the open workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const root = deps.getWorkspaceRoots()[0];
      if (!root) return { entries: [], note: "no workspace open" };
      const entries = await invoke<DirEntryLite[]>("read_dir", { path: root });
      return {
        root,
        entries: entries.map((e) => ({ name: e.name, kind: e.kind, path: e.path })),
      };
    },
  };

  const proposeEdit: AITool = {
    name: "app__propose_edit",
    source: APP,
    description:
      "Propose an edit to the active document by replacing the first exact occurrence of `find` with `replace`. The change is NOT applied until the user approves it (Accept/Reject).",
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
      const find = String(a?.find ?? "");
      const replace = String(a?.replace ?? "");
      if (!find) return { status: "error", message: "`find` is required." };
      const status = await deps.proposeEdit({ find, replace });
      return { status };
    },
  };

  const writeExcalidraw: AITool = {
    name: "app__excalidraw_write",
    source: APP,
    description:
      "Draw or update a diagram in the Excalidraw canvas the user currently has open, by " +
      "providing the diagram as Mermaid text. Excalidraw renders ONLY these Mermaid diagram " +
      "types as editable shapes: flowchart, sequenceDiagram, classDiagram, and " +
      "erDiagram — prefer them. Other types (pie, gantt, state, mindmap, …) come in as a " +
      "single flat image, so avoid them. `mode` controls placement: " +
      "'replace-selection' swaps the user's current diagram selection for the new one (use " +
      "when they asked to change/fix the selected part; falls back to append if nothing is " +
      "selected); 'append' adds the diagram below existing content (the default — use to add " +
      "to the canvas); 'replace-all' clears the canvas first (only when explicitly asked to " +
      "start over). Only works when a .excalidraw file is the active document.",
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
      },
      required: ["mermaid"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const a = args as { mermaid?: unknown; mode?: unknown };
      const mermaid = String(a?.mermaid ?? "").trim();
      if (!mermaid) return { ok: false, error: "`mermaid` is required." };
      const mode: ExcalidrawApplyMode = APPLY_MODES.includes(a?.mode as ExcalidrawApplyMode)
        ? (a.mode as ExcalidrawApplyMode)
        : "append";
      return deps.applyExcalidrawMermaid({ mermaid, mode });
    },
  };

  return [readActiveDoc, searchWorkspace, listFiles, proposeEdit, writeExcalidraw];
}
