/** Where a selection shortcut (Ctrl/⌘+I, Ctrl/⌘+L) came from. Both shortcuts
 *  share this decision so a remembered CodeMirror range is only used when the
 *  keystroke actually came from the editor. */
export interface SelectionShortcutOrigin {
  /** Keystroke came from the chat panel: only refocus the composer. */
  chatOnly: boolean;
  /** The editor's (possibly stale) selection may be attached. */
  editor: boolean;
}

interface ClosestCapableTarget extends EventTarget {
  closest(selector: string): unknown;
}

// `window` (where Excalidraw clones its keydown) is an EventTarget without
// `closest`. Duck-typing also keeps this decision testable without a DOM.
function asElement(target: EventTarget | null): ClosestCapableTarget | null {
  if (!target || typeof (target as ClosestCapableTarget).closest !== "function") return null;
  return target as ClosestCapableTarget;
}

export function selectionShortcutOrigin(target: EventTarget | null): SelectionShortcutOrigin {
  const element = asElement(target);
  // Chat first, matching the existing Ctrl+L guard: a composer nested in any
  // other container still means "focus only, don't re-attach a stale chip".
  if (element?.closest(".ai-panel")) return { chatOnly: true, editor: false };
  return { chatOnly: false, editor: !!element?.closest(".cm-editor") };
}

/** A shortcut the menu runs has no keystroke of its own — the command palette
 *  is opened by a keydown and then runs a command, so it cannot tell which
 *  surface the selection belongs to. Remember the surface that had the focus
 *  when the menu opened, and run the command with its selection: the editor's
 *  remembered range only when the editor held the focus, else the preview's
 *  live DOM selection. */
export interface PaletteSelectionOrigin {
  /** Capture the focused surface — call BEFORE the menu takes the focus. */
  remember(focused: EventTarget | null): void;
  /** The origin to run the menu's selection command with. Nothing captured
   *  reads as "not the editor", so a stale CodeMirror range is never used. */
  origin(): SelectionShortcutOrigin;
}

export function createPaletteSelectionOrigin(): PaletteSelectionOrigin {
  let recorded: SelectionShortcutOrigin = { chatOnly: false, editor: false };
  return {
    remember(focused) {
      recorded = selectionShortcutOrigin(focused);
    },
    origin() {
      return recorded;
    },
  };
}

/** The three ways to obtain a selection, in priority order. */
export interface SelectionSources {
  /** Excalidraw scene selection; independent of the keystroke origin. */
  diagram: () => boolean | Promise<boolean>;
  /** CodeMirror text selection; kept after blur, hence origin-gated. */
  editor: () => boolean | Promise<boolean>;
  /** Live DOM selection anchored inside `.doc-body`. */
  preview: () => boolean | Promise<boolean>;
}

/** Shared attach chain for Ctrl/⌘+I, Ctrl/⌘+L and the command palette.
 *  Returns true as soon as one source attached a chip. `editor: false` skips
 *  the remembered editor range so the preview can win. */
export async function attachFromSelectionSources(
  sources: SelectionSources,
  { editor = true }: { editor?: boolean } = {},
): Promise<boolean> {
  if (await sources.diagram()) return true;
  if (editor && (await sources.editor())) return true;
  return await sources.preview();
}
