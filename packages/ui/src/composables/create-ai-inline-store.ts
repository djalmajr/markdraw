// State for the inline AI overlay (DJA-13) — the floating widget anchored to the
// editor selection (VSCode/Zed ⌘I). One-shot: capture selection → pick an action
// → stream the result → Accept (apply edit) / Reject. Separate from the sidebar
// chat store; shares the provider + the pure action prompts.

import { createSignal } from "solid-js";
import * as m from "@asciimark/i18n";
import type { AIProvider } from "@asciimark/ai/types.ts";
import {
  buildInlineActionPrompt,
  getInlineAction,
  type InlineActionId,
} from "@asciimark/ai/actions.ts";
import { extractMermaid } from "@asciimark/ai/extract-mermaid.ts";
import { diagramSystemPrompt } from "@asciimark/ai/prompts/diagram.ts";

export interface InlineSelection {
  from: number;
  to: number;
  text: string;
}
export interface InlineAnchor {
  left: number;
  top: number;
  bottom: number;
}
export type InlineStatus = "menu" | "streaming" | "done" | "error";
/** "actions" = transform a selection; "diagram" = generate mermaid in a block. */
export type InlineMode = "actions" | "diagram";

/** The mermaid block targeted by diagram mode (DJA-14). */
export interface DiagramTarget {
  contentFrom: number;
  contentTo: number;
  isEmpty: boolean;
  existingSource: string;
}

/** Applies the accepted result back to the editor: replace [from,to) with text. */
export type ReplaceFn = (from: number, to: number, insert: string) => void;

export interface AiInlineStore {
  open: () => boolean;
  mode: () => InlineMode;
  anchor: () => InlineAnchor | null;
  selection: () => InlineSelection | null;
  action: () => InlineActionId | null;
  result: () => string;
  status: () => InlineStatus;
  error: () => string | null;
  /** Open the overlay for a captured selection, anchored at `anchor`. */
  openFor(selection: InlineSelection, anchor: InlineAnchor | null, replace: ReplaceFn): void;
  /** Open the overlay in diagram mode for a mermaid block (DJA-14). */
  openForDiagram(target: DiagramTarget, anchor: InlineAnchor | null, replace: ReplaceFn): void;
  /** Run an action against the captured selection, streaming the result. */
  run(actionId: InlineActionId, targetLang?: string): Promise<void>;
  /** Generate a mermaid diagram from a prose description (diagram mode). */
  runDiagram(prose: string): Promise<void>;
  /** Apply the result to the editor (replace/insert/diagram) and close. */
  accept(): void;
  /** Abort the in-flight stream (keeps the overlay open). */
  cancel(): void;
  /** Close and reset. */
  close(): void;
}

export interface AiInlineStoreConfig {
  getProvider: () => AIProvider | null;
}

/** Validate generated Mermaid DSL with `mermaid.parse` before it may be
 *  inserted, so a hallucinated/truncated diagram never lands in the document
 *  as a broken block. The import is lazy (same module the preview bundles) so
 *  the heavy mermaid code never loads until a diagram is actually generated. */
async function isValidMermaid(dsl: string): Promise<boolean> {
  try {
    const { default: mermaid } = await import("mermaid");
    await mermaid.parse(dsl);
    return true;
  } catch {
    return false;
  }
}

export function createAiInlineStore(config: AiInlineStoreConfig): AiInlineStore {
  const [open, setOpen] = createSignal(false);
  const [mode, setMode] = createSignal<InlineMode>("actions");
  const [anchor, setAnchor] = createSignal<InlineAnchor | null>(null);
  const [selection, setSelection] = createSignal<InlineSelection | null>(null);
  const [action, setAction] = createSignal<InlineActionId | null>(null);
  const [result, setResult] = createSignal("");
  const [status, setStatus] = createSignal<InlineStatus>("menu");
  const [error, setError] = createSignal<string | null>(null);
  let replaceFn: ReplaceFn | null = null;
  let diagramTarget: DiagramTarget | null = null;
  let controller: AbortController | null = null;

  function openFor(sel: InlineSelection, a: InlineAnchor | null, replace: ReplaceFn): void {
    replaceFn = replace;
    diagramTarget = null;
    setMode("actions");
    setSelection(sel);
    setAnchor(a);
    setAction(null);
    setResult("");
    setError(null);
    setStatus("menu");
    setOpen(true);
  }

  function openForDiagram(
    target: DiagramTarget,
    a: InlineAnchor | null,
    replace: ReplaceFn,
  ): void {
    replaceFn = replace;
    diagramTarget = target;
    setMode("diagram");
    setSelection(null);
    setAnchor(a);
    setAction(null);
    setResult("");
    setError(null);
    setStatus("menu");
    setOpen(true);
  }

  async function streamInto(
    messages: { role: "user"; content: string }[],
    system: string,
  ): Promise<void> {
    const provider = config.getProvider();
    if (!provider) {
      setError(m.ai_error_no_provider());
      setStatus("error");
      return;
    }
    setResult("");
    setError(null);
    setStatus("streaming");
    controller = new AbortController();
    try {
      for await (const part of provider.chat(messages, {
        system,
        signal: controller.signal,
      })) {
        if (part.type === "text-delta") {
          setResult((r) => r + part.text);
        } else if (part.type === "error") {
          if (part.code !== "aborted") {
            setError(part.message);
            setStatus("error");
          } else {
            setStatus("done");
          }
          return;
        } else if (part.type === "done") {
          break;
        }
      }
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      controller = null;
    }
  }

  async function runDiagram(prose: string): Promise<void> {
    if (!prose.trim() || status() === "streaming") return;
    await streamInto(
      [{ role: "user", content: prose }],
      diagramSystemPrompt(diagramTarget?.existingSource),
    );
    // Gate the finished generation behind mermaid.parse: a response with no
    // extractable diagram, or DSL mermaid rejects, becomes an error state so
    // accept() can never insert a broken block.
    if (status() !== "done") return;
    const dsl = extractMermaid(result());
    if (!dsl || !(await isValidMermaid(dsl))) {
      setError(m.ai_error_generic());
      setStatus("error");
    }
  }

  async function run(actionId: InlineActionId, targetLang?: string): Promise<void> {
    const sel = selection();
    if (!sel || status() === "streaming") return;
    setAction(actionId);
    const { system, user } = buildInlineActionPrompt(actionId, {
      text: sel.text,
      targetLang,
    });
    await streamInto([{ role: "user", content: user }], system);
  }

  function accept(): void {
    if (!replaceFn) {
      close();
      return;
    }
    if (mode() === "diagram") {
      // Only a generation that passed validation in runDiagram (status "done")
      // may be inserted — an "error" status means the DSL failed mermaid.parse.
      const dsl = status() === "done" ? extractMermaid(result()) : "";
      if (dsl && diagramTarget) {
        // Empty block has a zero-width content range — add a trailing newline so
        // the closing delimiter stays on its own line.
        const insert = diagramTarget.isEmpty ? `${dsl}\n` : dsl;
        replaceFn(diagramTarget.contentFrom, diagramTarget.contentTo, insert);
      }
    } else {
      const sel = selection();
      const text = result();
      if (sel && text) {
        const repl = getInlineAction(action() ?? "rewrite")?.replaceMode ?? "replace";
        if (repl === "insert") replaceFn(sel.to, sel.to, `\n\n${text}`);
        else replaceFn(sel.from, sel.to, text);
      }
    }
    close();
  }

  function cancel(): void {
    controller?.abort();
  }

  function close(): void {
    cancel();
    setOpen(false);
    setMode("actions");
    setSelection(null);
    setAnchor(null);
    setAction(null);
    setResult("");
    setError(null);
    setStatus("menu");
    replaceFn = null;
    diagramTarget = null;
  }

  return {
    open,
    mode,
    anchor,
    selection,
    action,
    result,
    status,
    error,
    openFor,
    openForDiagram,
    run,
    runDiagram,
    accept,
    cancel,
    close,
  };
}
