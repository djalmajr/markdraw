import { onMount, type JSX } from "solid-js";
import * as m from "@asciimark/i18n";

interface CreateRowProps {
  kind: "file" | "folder";
  /** Left padding (px) so the row aligns with the surrounding tree depth. */
  indent: number;
  /** Leading icon (file/folder), supplied by the caller. */
  icon: JSX.Element;
  /** Called with the trimmed name on commit (Enter, or blur with text). */
  onCommit: (name: string) => void;
  /** Called on Escape, or blur while empty. */
  onCancel: () => void;
}

/**
 * Transient inline row for naming a new file/folder in the tree. Mirrors the
 * rename UX: Enter commits, Escape cancels, blur commits (cancels if empty).
 * `done` guards against the commit/cancel firing twice (Enter then the blur
 * that the resulting unmount triggers).
 */
export function CreateRow(props: CreateRowProps) {
  let inputRef: HTMLInputElement | undefined;
  let done = false;
  // The row is usually opened from a Kobalte menu item. When that menu closes
  // it restores focus to its trigger, which blurs (and would otherwise cancel)
  // the freshly-focused input. Until the user actually interacts, treat any
  // blur as that spurious focus-restoration and reclaim focus instead of
  // committing/cancelling. No timers — keeps the behaviour deterministic.
  let interacted = false;

  onMount(() => {
    queueMicrotask(() => inputRef?.focus());
  });

  function commit() {
    if (done) return;
    const name = (inputRef?.value ?? "").trim();
    if (!name) {
      done = true;
      props.onCancel();
      return;
    }
    done = true;
    props.onCommit(name);
  }

  function onBlur() {
    // Before the user has touched the input, a blur is the menu's close-time
    // focus restoration — reclaim focus rather than commit/cancel.
    if (!interacted) {
      queueMicrotask(() => inputRef?.focus());
      return;
    }
    commit();
  }

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    interacted = true;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      done = true;
      props.onCancel();
    }
  }

  return (
    <div class="tree-item create-row" style={{ "padding-left": `${props.indent}px` }}>
      <span class="tree-icon" />
      <span class="tree-icon">{props.icon}</span>
      <input
        ref={inputRef}
        class="tree-create-input"
        type="text"
        spellcheck={false}
        autocomplete="off"
        placeholder={props.kind === "file" ? m.tree_create_file_placeholder() : m.tree_create_folder_placeholder()}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}
