// Explicit AI context items (Cursor-style "@mentions"/attachments) shown as
// removable chips in the chat composer. Hybrid model: the ACTIVE document is
// surfaced as a chip but read by the existing `getActiveDoc` app tool (no
// double tokens); items the user adds explicitly (file-tree "Add to chat",
// drag-and-drop, a selection, an @mention) carry their resolved content here
// and get injected into the next message sent to the model.

export interface AiContextItem {
  /** Stable id (e.g. `file:rootId:path` or `selection:...`) for dedupe/removal. */
  id: string;
  kind: "file" | "selection";
  /** Chip label — a file name, or "file.md:12-20" for a selection. */
  label: string;
  path?: string;
  rootId?: string;
  /** The resolved text injected into the prompt. */
  content: string;
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
  const blocks = items.map(
    (item) => `<context kind="${item.kind}" source="${escapeAttr(item.label)}">\n${item.content}\n</context>`,
  );
  return `The user attached the following context — use it when relevant:\n\n${blocks.join("\n\n")}`;
}
