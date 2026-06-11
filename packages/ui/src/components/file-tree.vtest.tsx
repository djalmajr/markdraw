import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";

afterEach(cleanup);
import type { WorkspaceRoot, FSEntry } from "@asciimark/core/types.ts";
import { AppProvider } from "../context/app-context.tsx";
import type { AppState } from "../composables/create-app-state.ts";
import { FileTree } from "./file-tree.tsx";

// Minimal AppState stub — only the fields FileTreeItem actually reads.
function makeAppStub(): AppState {
  const [editingPath, setEditingPath] = createSignal<string | null>(null);
  const [creatingAt, setCreatingAt] = createSignal<null>(null);
  const [moveClipboard, setMoveClipboard] = createSignal<null>(null);
  const [selectedFile, setSelectedFile] = createSignal<FSEntry | null>(null);
  return {
    editingPath,
    setEditingPath,
    creatingAt,
    setCreatingAt,
    moveClipboard,
    setMoveClipboard,
    selectedFile,
    setSelectedFile,
    isDirty: () => false,
  } as unknown as AppState;
}

function file(name: string, path = name): FSEntry {
  return { name, path, kind: "file" };
}
function dir(name: string, children: FSEntry[], path = name): FSEntry {
  return { name, path, kind: "directory", children };
}
function makeRoot(id: string, name: string, entries: FSEntry[]): WorkspaceRoot {
  return { id, name, entries, collapsed: false };
}

const SINGLE_ROOT: WorkspaceRoot[] = [
  makeRoot("r1", "vault", [
    dir("notes", [file("a.md", "notes/a.md"), file("b.md", "notes/b.md")], "notes"),
    file("README.md"),
  ]),
];

describe("FileTree", () => {
  it("renders the workspace root header and visible entries", () => {
    const { getByText } = render(() => (
      <AppProvider state={makeAppStub()}>
        <FileTree
          roots={SINGLE_ROOT}
          selectedPath={null}
          selectedRootId={null}
          onSelect={() => {}}
        />
      </AppProvider>
    ));
    expect(getByText("README.md")).not.toBeNull();
    expect(getByText("notes")).not.toBeNull();
  });

  it("clicking a file dispatches onSelect with the entry and rootId", () => {
    const onSelect = vi.fn();
    const { getByText } = render(() => (
      <AppProvider state={makeAppStub()}>
        <FileTree
          roots={SINGLE_ROOT}
          selectedPath={null}
          selectedRootId={null}
          onSelect={onSelect}
        />
      </AppProvider>
    ));
    fireEvent.click(getByText("README.md"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [entry, rootId] = onSelect.mock.calls[0]!;
    expect(entry.name).toBe("README.md");
    expect(rootId).toBe("r1");
  });

  it("filter input narrows visible entries by substring match", () => {
    const { container, getByPlaceholderText } = render(() => (
      <AppProvider state={makeAppStub()}>
        <FileTree
          roots={SINGLE_ROOT}
          selectedPath={null}
          selectedRootId={null}
          onSelect={() => {}}
        />
      </AppProvider>
    ));
    const input = getByPlaceholderText(/Filter files/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "READ" } });

    // tree-item-wrapper sets display:none when invisible, so we filter
    // by visibility on the wrapper before reading the name.
    const visibleNames = Array.from(
      container.querySelectorAll<HTMLElement>(".tree-item-wrapper"),
    )
      .filter((el) => el.style.display !== "none")
      .map((el) => el.querySelector(".tree-name")?.textContent?.trim());
    expect(visibleNames).toContain("README.md");
    expect(visibleNames).not.toContain("a.md");
    expect(visibleNames).not.toContain("b.md");
  });

  it("renders the empty state when no roots have visible entries", () => {
    const empty: WorkspaceRoot[] = [makeRoot("r1", "empty", [])];
    const { getByText } = render(() => (
      <AppProvider state={makeAppStub()}>
        <FileTree
          roots={empty}
          selectedPath={null}
          selectedRootId={null}
          onSelect={() => {}}
        />
      </AppProvider>
    ));
    expect(getByText(/No supported files found/i)).not.toBeNull();
  });

  it("ArrowDown does not crash on a populated tree (smoke)", () => {
    const { container } = render(() => (
      <AppProvider state={makeAppStub()}>
        <FileTree
          roots={SINGLE_ROOT}
          selectedPath={null}
          selectedRootId={null}
          onSelect={() => {}}
        />
      </AppProvider>
    ));
    const nav = container.querySelector(".file-tree") as HTMLElement;
    nav.focus();
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(container.querySelector(".file-tree")).not.toBeNull();
  });

  it("folder row click does not expand; only the chevron toggles", () => {
    const { container } = render(() => (
      <AppProvider state={makeAppStub()}>
        <FileTree roots={SINGLE_ROOT} selectedPath={null} selectedRootId={null} onSelect={() => {}} />
      </AppProvider>
    ));
    const item = container.querySelector<HTMLElement>('.tree-item.directory[data-path="notes"]')!;
    expect(item.dataset.expanded).toBe("false");
    // Clicking the row must NOT expand (it selects/focuses the folder).
    fireEvent.click(item);
    expect(item.dataset.expanded).toBe("false");
    // Clicking the chevron expands.
    fireEvent.click(item.querySelector<HTMLElement>(".tree-chevron")!);
    expect(item.dataset.expanded).toBe("true");
  });

  describe("showItemMenu prop", () => {
    // The bug this guards against: `FileTreeItem` renders its children
    // recursively through itself, and the prop list passed to that inner
    // `<FileTreeItem>` was missing `showItemMenu`. Result: setting
    // showItemMenu={false} hid the dropdown trigger on root-level rows
    // but left it on every nested row. The browser extension shipped
    // that regression — we never want it back.
    //
    // Mutation-survival contract:
    //   - Removing `showItemMenu={props.showItemMenu}` from the
    //     recursive `<FileTreeItem>` call must fail the
    //     "hides menu on nested rows" test below.
    //   - Replacing it with `showItemMenu={true}` must fail it too.
    //   - Removing the `<Show when={!isEditing() && menuEnabled()}>`
    //     gate must fail the root-level test.

    function expandDir(container: HTMLElement, name: string) {
      const wrapper = Array.from(
        container.querySelectorAll<HTMLElement>(".tree-item-wrapper"),
      ).find((el) => el.querySelector(".tree-name")?.textContent?.trim() === name);
      const item = wrapper?.querySelector<HTMLElement>(".tree-item.directory");
      if (!item) throw new Error(`directory '${name}' not found`);
      // The folder row no longer toggles on click — expansion is the chevron's
      // job, so click the chevron to expand.
      const chevron = item.querySelector<HTMLElement>(".tree-chevron");
      if (!chevron) throw new Error(`chevron for '${name}' not found`);
      fireEvent.click(chevron);
    }

    it("renders the three-dot trigger on every row by default", () => {
      const { container } = render(() => (
        <AppProvider state={makeAppStub()}>
          <FileTree
            roots={SINGLE_ROOT}
            selectedPath={null}
            selectedRootId={null}
            onSelect={() => {}}
          />
        </AppProvider>
      ));
      expandDir(container, "notes");
      // `notes/` (directory) + a.md + b.md + README.md — 4 rows, all
      // with the dropdown trigger.
      const triggers = container.querySelectorAll(".tree-item-more");
      expect(triggers.length).toBe(4);
    });

    function openFileMenu(container: HTMLElement, name: string) {
      const row = Array.from(container.querySelectorAll<HTMLElement>(".tree-item-wrapper")).find(
        (el) => el.querySelector(".tree-name")?.textContent?.trim() === name,
      );
      const item = row!.querySelector<HTMLElement>(".tree-item") ?? row!;
      // The row's Kobalte ContextMenu opens on a right-click (contextmenu event).
      fireEvent.contextMenu(item);
    }

    it("offers 'Add to chat' in a file's menu when onAddToChat is provided", () => {
      const { container } = render(() => (
        <AppProvider state={makeAppStub()}>
          <FileTree
            roots={SINGLE_ROOT}
            selectedPath={null}
            selectedRootId={null}
            onSelect={() => {}}
            onAddToChat={() => {}}
          />
        </AppProvider>
      ));
      openFileMenu(container, "README.md");
      // The menu portals to document.body — use the global `screen` query.
      expect(screen.getByText(/add to chat|adicionar ao chat|añadir al chat/i)).not.toBeNull();
    });

    it("omits 'Add to chat' when onAddToChat is not provided", () => {
      const { container } = render(() => (
        <AppProvider state={makeAppStub()}>
          <FileTree roots={SINGLE_ROOT} selectedPath={null} selectedRootId={null} onSelect={() => {}} />
        </AppProvider>
      ));
      openFileMenu(container, "README.md");
      expect(screen.queryByText(/add to chat|adicionar ao chat|añadir al chat/i)).toBeNull();
    });

    it("offers 'Add to chat' in a DIRECTORY's menu (folder mention)", () => {
      const onAddToChat = vi.fn();
      const { container } = render(() => (
        <AppProvider state={makeAppStub()}>
          <FileTree
            roots={SINGLE_ROOT}
            selectedPath={null}
            selectedRootId={null}
            onSelect={() => {}}
            onAddToChat={onAddToChat}
          />
        </AppProvider>
      ));
      openFileMenu(container, "notes");
      const item = screen.getByText(/add to chat|adicionar ao chat|añadir al chat/i);
      fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
      fireEvent.click(item);
      expect(onAddToChat).toHaveBeenCalledTimes(1);
      expect(onAddToChat.mock.calls[0]![0].kind).toBe("directory");
    });

    it("offers 'Add to chat' in the workspace-root menu with a path:'' pseudo-entry", () => {
      const onAddToChat = vi.fn();
      const { container } = render(() => (
        <AppProvider state={makeAppStub()}>
          <FileTree
            roots={SINGLE_ROOT}
            selectedPath={null}
            selectedRootId={null}
            onSelect={() => {}}
            onAddToChat={onAddToChat}
          />
        </AppProvider>
      ));
      const trigger = container.querySelector<HTMLElement>(".workspace-root-btn");
      expect(trigger).not.toBeNull();
      fireEvent.pointerDown(trigger!, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(trigger!, { button: 0, pointerType: "mouse" });
      fireEvent.click(trigger!);
      const item = screen.getByText(/add to chat|adicionar ao chat|añadir al chat/i);
      fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
      fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
      fireEvent.click(item);
      expect(onAddToChat).toHaveBeenCalledTimes(1);
      const [entry, rootId] = onAddToChat.mock.calls[0]!;
      expect(entry).toMatchObject({ kind: "directory", path: "" });
      expect(rootId).toBe(SINGLE_ROOT[0]!.id);
    });

    it("hides the menu on root-level rows when showItemMenu={false}", () => {
      const { container } = render(() => (
        <AppProvider state={makeAppStub()}>
          <FileTree
            roots={SINGLE_ROOT}
            selectedPath={null}
            selectedRootId={null}
            onSelect={() => {}}
            showItemMenu={false}
          />
        </AppProvider>
      ));
      const triggers = container.querySelectorAll(".tree-item-more");
      expect(triggers.length).toBe(0);
    });

    it("hides the menu on NESTED rows too when showItemMenu={false}", () => {
      // The regression: nested rows kept their menu because the prop
      // was not forwarded to the recursive child. Expanding a directory
      // surfaces the children — none of them should have the trigger.
      const { container } = render(() => (
        <AppProvider state={makeAppStub()}>
          <FileTree
            roots={SINGLE_ROOT}
            selectedPath={null}
            selectedRootId={null}
            onSelect={() => {}}
            showItemMenu={false}
          />
        </AppProvider>
      ));
      expandDir(container, "notes");
      // After expanding, the DOM contains rows for notes, a.md, b.md,
      // README.md. None of them must render `.tree-item-more`.
      const triggers = container.querySelectorAll(".tree-item-more");
      expect(triggers.length).toBe(0);

      // Sanity — the rows themselves did render (otherwise the
      // assertion above would pass trivially with an empty tree).
      const visibleNames = Array.from(
        container.querySelectorAll<HTMLElement>(".tree-item-wrapper"),
      )
        .filter((el) => el.style.display !== "none")
        .map((el) => el.querySelector(".tree-name")?.textContent?.trim());
      expect(visibleNames).toContain("a.md");
      expect(visibleNames).toContain("b.md");
    });
  });

  it("marks the cut entry with .cut-pending when it is on the move clipboard", () => {
    const [editingPath] = createSignal<string | null>(null);
    const [creatingAt] = createSignal<null>(null);
    const [selectedFile] = createSignal<FSEntry | null>(null);
    const [moveClipboard] = createSignal({ entry: file("README.md"), rootId: "r1", mode: "cut" as const });
    const stub = {
      editingPath,
      setEditingPath: () => {},
      creatingAt,
      setCreatingAt: () => {},
      moveClipboard,
      setMoveClipboard: () => {},
      selectedFile,
      setSelectedFile: () => {},
      isDirty: () => false,
    } as unknown as AppState;
    const { container } = render(() => (
      <AppProvider state={stub}>
        <FileTree roots={SINGLE_ROOT} selectedPath={null} selectedRootId={null} onSelect={() => {}} onMove={() => {}} />
      </AppProvider>
    ));
    const cut = container.querySelector<HTMLElement>('.tree-item[data-path="README.md"]');
    expect(cut?.classList.contains("cut-pending")).toBe(true);
    // a sibling that is NOT on the clipboard must not be marked.
    const other = container.querySelector<HTMLElement>('.tree-item[data-path="notes"]');
    expect(other?.classList.contains("cut-pending")).toBe(false);
  });

  it("Escape clears a pending Cut (move clipboard)", () => {
    const [editingPath] = createSignal<string | null>(null);
    const [creatingAt] = createSignal<null>(null);
    const [selectedFile] = createSignal<FSEntry | null>(null);
    const [moveClipboard, setMoveClipboard] = createSignal<
      { entry: FSEntry; rootId: string; mode: "cut" | "copy" } | null
    >({
      entry: file("README.md"),
      rootId: "r1",
      mode: "cut",
    });
    const stub = {
      editingPath,
      setEditingPath: () => {},
      creatingAt,
      setCreatingAt: () => {},
      moveClipboard,
      setMoveClipboard,
      selectedFile,
      setSelectedFile: () => {},
      isDirty: () => false,
    } as unknown as AppState;
    const { container } = render(() => (
      <AppProvider state={stub}>
        <FileTree roots={SINGLE_ROOT} selectedPath={null} selectedRootId={null} onSelect={() => {}} onMove={() => {}} />
      </AppProvider>
    ));
    expect(moveClipboard()).not.toBeNull();
    const nav = container.querySelector(".file-tree") as HTMLElement;
    fireEvent.keyDown(nav, { key: "Escape" });
    expect(moveClipboard()).toBeNull();
  });

  describe("move (onMove) — drag affordance", () => {
    // Drag & drop is powered by @dnd-kit (same provider as workspace-root
    // reordering); the move dispatch + numbering live in folder.handleMove /
    // handleCopy, covered by the desktop bun suite. Here we only smoke-test
    // that the tree still renders with onMove wired (the dnd hooks mount).
    it("renders with onMove wired without crashing", () => {
      const { getByText } = render(() => (
        <AppProvider state={makeAppStub()}>
          <FileTree
            roots={SINGLE_ROOT}
            selectedPath={null}
            selectedRootId={null}
            onSelect={() => {}}
            onMove={() => {}}
            onCopy={() => {}}
          />
        </AppProvider>
      ));
      expect(getByText("README.md")).not.toBeNull();
    });
  });

  it("multiple roots render side by side and selection scopes by rootId", () => {
    const TWO: WorkspaceRoot[] = [
      ...SINGLE_ROOT,
      makeRoot("r2", "second-root", [file("other.md")]),
    ];
    const { getByText } = render(() => (
      <AppProvider state={makeAppStub()}>
        <FileTree
          roots={TWO}
          selectedPath="other.md"
          selectedRootId="r2"
          onSelect={() => {}}
        />
      </AppProvider>
    ));
    expect(getByText("README.md")).not.toBeNull();
    expect(getByText("other.md")).not.toBeNull();
  });
});
