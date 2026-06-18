import { onCleanup, onMount, type JSX } from "solid-js";
import * as m from "@markdraw/i18n";

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
  // committing/cancelling. The short burst of focus attempts covers dropdown
  // implementations that restore focus after the row has already mounted.
  let interacted = false;
  let frameId: number | undefined;
  let timerIds: ReturnType<typeof setTimeout>[] = [];

  function focusInput() {
    if (done || interacted || !inputRef) return;
    inputRef.focus();
  }

  function clearScheduledFocus() {
    if (frameId !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
      frameId = undefined;
    }
    for (const timerId of timerIds) {
      clearTimeout(timerId);
    }
    timerIds = [];
  }

  function scheduleFocus() {
    clearScheduledFocus();
    queueMicrotask(focusInput);
    if (typeof requestAnimationFrame === "function") {
      frameId = requestAnimationFrame(() => {
        frameId = undefined;
        focusInput();
      });
    }
    for (const delay of [0, 50, 150, 300]) {
      const id = setTimeout(() => {
        timerIds = timerIds.filter((timerId) => timerId !== id);
        focusInput();
      }, delay);
      timerIds.push(id);
    }
  }

  onMount(() => {
    scheduleFocus();
  });

  onCleanup(() => {
    clearScheduledFocus();
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
      scheduleFocus();
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
