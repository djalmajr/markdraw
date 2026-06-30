// Explicit AI context items (Cursor-style "@mentions"/attachments) shown as
// removable chips in the chat composer. Hybrid model: the ACTIVE document is
// surfaced as a chip but read by the existing `getActiveDoc` app tool (no
// double tokens); items the user adds explicitly (file-tree "Add to chat",
// drag-and-drop, a selection, an @mention) carry their resolved content here
// and get injected into the next message sent to the model.

export interface AiContextItem {
  /** Stable id (e.g. `file:rootId:path`, `folder:rootId:path` or `selection:...`) for dedupe/removal. */
  id: string;
  kind: "file" | "folder" | "selection";
  /** Chip label — a file name, "dir/" for a folder listing, or "file.md:12-20" for a selection. */
  label: string;
  path?: string;
  rootId?: string;
  rootPath?: string;
  absolutePath?: string;
  /** The resolved text injected into the prompt. */
  content: string;
}

/** A host request for the chat composer to materialize a context item as an
 *  inline "@token" (selection chips ride the same per-message token lifecycle
 *  as @-mentions). */
export interface AiInlineReference {
  /** The `AiContextItem.id` the token references (removal/reorder key). */
  itemId: string;
  /** Monotonic — retrigger even for an identical reference. */
  seq: number;
  /** Token text WITHOUT the "@" prefix. */
  token: string;
}

/** Suffix `label` with "-2"/"-3"… until it collides with no existing item
 *  label — keeps short selection tokens (e.g. "doc.md:sel") distinguishable
 *  when several selections from the same source are attached. Pure. */
export function dedupeTokenLabel(label: string, items: readonly { label: string }[]): string {
  const taken = new Set(items.map((item) => item.label));
  if (!taken.has(label)) return label;
  let n = 2;
  while (taken.has(`${label}-${n}`)) n += 1;
  return `${label}-${n}`;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

/**
 * Build the context preamble injected into the user's message (the displayed
 * turn stays clean — only what's sent to the model carries this). Returns
 * `undefined` when there is no explicit context so the message is unchanged.
 */
export function buildContextPreamble(items: AiContextItem[]): string | undefined {
  if (items.length === 0) return undefined;
  const blocks = items.map((item) => {
    const pathAttr = item.path !== undefined ? ` path="${escapeAttr(item.path)}"` : "";
    const rootAttr = item.rootPath !== undefined ? ` root="${escapeAttr(item.rootPath)}"` : "";
    const absoluteAttr =
      item.absolutePath !== undefined ? ` absolute_path="${escapeAttr(item.absolutePath)}"` : "";
    const locationLines = [
      item.path !== undefined ? `Workspace-relative path: ${item.path}` : undefined,
      item.rootPath !== undefined ? `Workspace root: ${item.rootPath}` : undefined,
      item.absolutePath !== undefined ? `Absolute path: ${item.absolutePath}` : undefined,
    ].filter((line): line is string => line !== undefined);
    const location = locationLines.length ? `${locationLines.join("\n")}\n\n` : "";
    return `<context kind="${item.kind}" source="${escapeAttr(item.label)}"${pathAttr}${rootAttr}${absoluteAttr}>\n${location}${item.content}\n</context>`;
  });
  return `The user attached the following context — use it when relevant:\n\n${blocks.join("\n\n")}`;
}

/** Minimal shape of an Excalidraw scene (from the guest's `getScene` RPC). */
export interface ExcalidrawScene {
  appState?: { selectedElementIds?: Record<string, boolean> };
  elements?: ExcalidrawElement[];
}
interface ExcalidrawElement {
  id: string;
  type: string;
  text?: string;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  boundElements?: Array<{ id: string; type: string }> | null;
  isDeleted?: boolean;
}

/**
 * Build a one-element describer over the FULL element list — text labels and
 * arrow bindings resolve against every element in the scene, not just the
 * subset being rendered (a selected arrow may point at an unselected box).
 * Shared by the selection chip and the whole-scene outline so both speak the
 * same compact language ('Rectangle "Login"', 'Arrow: "A" → "B"').
 */
function createElementDescriber(elements: ExcalidrawElement[]): (el: ExcalidrawElement) => string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const textOf = (el: ExcalidrawElement): string | undefined => {
    if (el.type === "text") return el.text?.trim() || undefined;
    const bound = (el.boundElements ?? []).find((b) => b.type === "text");
    const inner = bound ? byId.get(bound.id)?.text?.trim() : undefined;
    return inner || undefined;
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return (el: ExcalidrawElement): string => {
    if (el.type === "arrow" || el.type === "line") {
      const from = el.startBinding?.elementId ? byId.get(el.startBinding.elementId) : undefined;
      const to = el.endBinding?.elementId ? byId.get(el.endBinding.elementId) : undefined;
      const label = textOf(el);
      if (from || to) {
        const a = from ? (textOf(from) ?? from.type) : "?";
        const b = to ? (textOf(to) ?? to.type) : "?";
        return `Arrow: "${a}" → "${b}"${label ? ` (label: "${label}")` : ""}`;
      }
      return label ? `Arrow "${label}"` : "Arrow";
    }
    const t = textOf(el);
    return t ? `${cap(el.type)} "${t}"` : cap(el.type);
  };
}

/**
 * Turn an Excalidraw selection into an AI context item — a compact, readable
 * text outline (shapes + their text + arrow connections), NOT raw element JSON
 * (verbose + the model reads structure poorly). Returns null when nothing is
 * selected, so ⌘I stays a no-op on an empty canvas (mirrors the editor path).
 */
export function excalidrawSelectionToContext(
  scene: ExcalidrawScene | null | undefined,
  file: { name: string; path: string },
): AiContextItem | null {
  const elements = (scene?.elements ?? []).filter((e) => !e.isDeleted);
  const selectedIds = scene?.appState?.selectedElementIds ?? {};
  const selected = elements.filter((e) => selectedIds[e.id]);
  if (selected.length === 0) return null;

  const describe = createElementDescriber(elements);
  const lines = selected.map((e) => `- ${describe(e)}`);
  const content = `Excalidraw selection — ${selected.length} element${selected.length === 1 ? "" : "s"} from ${file.name}:\n${lines.join("\n")}`;
  return {
    id: `excalidraw-selection:${file.path}:${selected.map((e) => e.id).sort().join(",")}`,
    kind: "selection",
    label: `${file.name} · ${selected.length} el`,
    path: file.path,
    content,
  };
}

/** Bound the prompt cost of huge canvases — beyond this the outline tails off
 *  with "(+N more)" instead of listing every element. */
const SCENE_OUTLINE_CAP = 200;

/**
 * Outline an ENTIRE Excalidraw scene as compact text — the read-side companion
 * to {@link excalidrawSelectionToContext}, in the same describe style. Used by
 * the desktop's `app__read_active_doc` tool so the model gets real content for
 * an open `.excalidraw` (whose editor buffer is empty — the canvas lives in a
 * guest frame). Returns null when the scene has no live elements, so the caller
 * can signal "diagram open but nothing to read" instead of faking empty text.
 */
export function excalidrawSceneToOutline(
  scene: ExcalidrawScene | null | undefined,
  fileLabel: string,
): string | null {
  const elements = (scene?.elements ?? []).filter((e) => !e.isDeleted);
  if (elements.length === 0) return null;

  const describe = createElementDescriber(elements);
  const lines = elements.slice(0, SCENE_OUTLINE_CAP).map((e) => `- ${describe(e)}`);
  if (elements.length > SCENE_OUTLINE_CAP) {
    lines.push(`- (+${elements.length - SCENE_OUTLINE_CAP} more)`);
  }
  const count = `${elements.length} element${elements.length === 1 ? "" : "s"}`;
  return `Excalidraw scene — ${count} in ${fileLabel}:\n${lines.join("\n")}`;
}
