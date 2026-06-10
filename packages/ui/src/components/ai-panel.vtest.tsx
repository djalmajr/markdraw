import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createMockProvider } from "@asciimark/ai/mock-provider.ts";
import { createAiChatStore } from "../composables/create-ai-chat-store.ts";
import { AiPanel } from "./ai-panel.tsx";
import { AiMessage } from "./ai-message.tsx";

afterEach(cleanup);

function readyStore(reply = "hello there") {
  return createAiChatStore({
    getProvider: () => createMockProvider({ reply: () => reply, chunkDelayMs: 0 }),
  });
}

describe("AiPanel", () => {
  it("shows the empty state with no messages and no provider", () => {
    const store = createAiChatStore({ getProvider: () => null });
    const { baseElement } = render(() => <AiPanel store={store} providerLabel={null} />);
    expect(baseElement.querySelector(".ai-empty")).not.toBeNull();
    expect(baseElement.querySelector(".ai-message")).toBeNull();
    // chip shows the inactive (no-provider) state
    expect(baseElement.querySelector(".ai-provider-chip-active")).toBeNull();
  });

  it("marks the provider chip active when a label is given", () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} providerLabel="Ollama" />);
    expect(baseElement.querySelector(".ai-provider-chip-active")).not.toBeNull();
  });

  it("disables the embedded send button while the composer is empty", () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} providerLabel="Mock" />);
    // The send arrow is `.ai-send-btn` (the context button shares the class but
    // also carries `.ai-context-btn`).
    const btn = baseElement.querySelector(".ai-send-btn:not(.ai-context-btn)") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("shows the model picker (not the static chip) with the current model label", () => {
    const store = readyStore();
    const onSelectModel = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        modelGroups={[
          {
            id: "p",
            name: "Provider P",
            models: [
              { value: "p/m1", label: "Model 1" },
              { value: "p/m2", label: "Model 2" },
            ],
          },
        ]}
        currentModel="p/m1"
        onSelectModel={onSelectModel}
      />
    ));
    // The static "connected" chip is replaced by the OpenCode-style picker whose
    // trigger pill shows the current model's label.
    const trigger = baseElement.querySelector(".ai-mp-trigger") as HTMLElement;
    expect(trigger).not.toBeNull();
    expect(baseElement.querySelector(".ai-provider-chip")).toBeNull();
    expect(trigger.textContent).toContain("Model 1");
    // Open the popover and confirm the provider group + the other model show.
    fireEvent.click(trigger);
    expect(screen.getByText("Provider P")).not.toBeNull();
    fireEvent.click(screen.getByText("Model 2"));
    expect(onSelectModel).toHaveBeenCalledWith("p/m2");
  });

  it("renders context chips (active file + items) and remove fires the callbacks", () => {
    const store = readyStore();
    const onRemoveContext = vi.fn();
    const onDismissActiveFile = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        activeFileContext={{ label: "doc.md" }}
        contextItems={[{ id: "f1", kind: "file", label: "other.md", content: "x" }]}
        onRemoveContext={onRemoveContext}
        onDismissActiveFile={onDismissActiveFile}
      />
    ));
    const chips = baseElement.querySelectorAll(".ai-context-chip");
    expect(chips).toHaveLength(2);
    // Removing the active-file chip dismisses it (it re-appears on file switch).
    fireEvent.click(baseElement.querySelector(".ai-context-chip-active .ai-context-chip-x") as HTMLElement);
    expect(onDismissActiveFile).toHaveBeenCalledTimes(1);
    // Removing an item chip drops it by id.
    const itemChip = [...chips].find((c) => !c.classList.contains("ai-context-chip-active"))!;
    fireEvent.click(itemChip.querySelector(".ai-context-chip-x") as HTMLElement);
    expect(onRemoveContext).toHaveBeenCalledWith("f1");
  });

  it("shows the @-mention list, filters it by query, and fires onMention on click", () => {
    const store = readyStore();
    const onMention = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        mentionFiles={[
          { label: "alpha.md", path: "a/alpha.md", rootId: "r" },
          { label: "beta.md", path: "b/beta.md", rootId: "r" },
        ]}
        onMention={onMention}
      />
    ));
    const ta = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    ta.value = "@al";
    ta.setSelectionRange(3, 3);
    fireEvent.input(ta);
    const items = baseElement.querySelectorAll(".ai-mention-item");
    expect(items).toHaveLength(1); // filtered to "alpha.md"
    expect(items[0]!.textContent).toContain("alpha.md");
    fireEvent.mouseDown(items[0]!);
    expect(onMention).toHaveBeenCalledWith({ label: "alpha.md", path: "a/alpha.md", rootId: "r" });
  });

  it("offers folders (and the workspace root itself) in the @-mention list with a trailing slash", () => {
    const store = readyStore();
    const onMention = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        mentionFiles={[
          { label: "alpha.md", path: "a/alpha.md", rootId: "r" },
          { kind: "dir", label: "notes/", path: "notes", rootId: "r" },
          // The workspace root itself: path "" attaches the whole-root listing.
          { kind: "dir", label: "wksp/", path: "", rootId: "r" },
        ]}
        onMention={onMention}
      />
    ));
    const ta = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    ta.value = "@no";
    ta.setSelectionRange(3, 3);
    fireEvent.input(ta);
    const items = baseElement.querySelectorAll(".ai-mention-item");
    expect(items).toHaveLength(1); // filtered to the "notes/" dir
    expect(items[0]!.querySelector(".ai-mention-name")?.textContent).toBe("notes/");
    // Selecting a dir fires onMention with the full dir entry (kind included),
    // so the host knows to attach a listing instead of file content.
    fireEvent.mouseDown(items[0]!);
    expect(onMention).toHaveBeenCalledWith({ kind: "dir", label: "notes/", path: "notes", rootId: "r" });
    // The root entry is mentionable too.
    ta.value = "@wk";
    ta.setSelectionRange(3, 3);
    fireEvent.input(ta);
    const rootItems = baseElement.querySelectorAll(".ai-mention-item");
    expect(rootItems).toHaveLength(1);
    fireEvent.mouseDown(rootItems[0]!);
    expect(onMention).toHaveBeenCalledWith({ kind: "dir", label: "wksp/", path: "", rootId: "r" });
  });

  it("renders a folder context chip (a mentioned directory's subtree listing)", () => {
    const store = readyStore();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        contextItems={[{ id: "folder:r:src", kind: "folder", label: "src/", content: "- src/a.md" }]}
      />
    ));
    const chip = baseElement.querySelector(".ai-context-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("src/");
  });

  it("opens the context-usage popover with an estimated breakdown", async () => {
    const store = readyStore();
    render(() => <AiPanel store={store} providerLabel="Mock" />);
    const trigger = screen.getByLabelText("Context usage");
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByText("Conversation")).not.toBeNull();
      expect(screen.getByText("Total (estimated)")).not.toBeNull();
    });
  });

  it("streams a reply on Enter, consolidates it, and hides the empty state", async () => {
    const store = readyStore("hello there");
    const { baseElement } = render(() => <AiPanel store={store} providerLabel="Mock" />);
    const textarea = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "hi" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(baseElement.textContent).toContain("hello there");
    });
    expect(baseElement.querySelector(".ai-message-user")).not.toBeNull();
    expect(baseElement.querySelector(".ai-message-assistant")).not.toBeNull();
    expect(baseElement.querySelector(".ai-empty")).toBeNull();
    // composer cleared after send
    expect(textarea.value).toBe("");
  });

  it("renders tool chips (name + source) for a message with tool activity", () => {
    const { baseElement } = render(() => (
      <AiMessage
        role="assistant"
        content="done"
        tools={[
          {
            toolCallId: "t1",
            toolName: "search_docs",
            source: "memory",
            status: "done",
          },
        ]}
      />
    ));
    const chip = baseElement.querySelector(".ai-tool-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("search_docs");
    expect(chip?.textContent).toContain("memory");
    expect(baseElement.querySelector(".ai-tool-chip-done")).not.toBeNull();
  });

  it("de-namespaces the tool name and hides the redundant 'app' source", () => {
    const { baseElement } = render(() => (
      <AiMessage
        role="assistant"
        content="done"
        tools={[{ toolCallId: "t1", toolName: "app__read_active_doc", source: "app", status: "done" }]}
      />
    ));
    const chip = baseElement.querySelector(".ai-tool-chip")!;
    expect(chip.querySelector(".ai-tool-chip-name")?.textContent).toBe("read_active_doc");
    expect(chip.textContent).not.toContain("app__");
    // The "· app" source chip is hidden for in-process app tools.
    expect(chip.querySelector(".ai-tool-chip-source")).toBeNull();
  });

  it("expands a tool chip into a terminal block with the result, and collapses on re-click", () => {
    const { baseElement } = render(() => (
      <AiMessage
        role="assistant"
        content="done"
        tools={[
          {
            toolCallId: "t1",
            toolName: "fs__list_directory",
            source: "fs",
            status: "done",
            result: "[DIR] diagramas\n[FILE] notes.md",
          },
        ]}
      />
    ));
    expect(baseElement.querySelector(".ai-tool-output")).toBeNull();
    const chip = baseElement.querySelector(".ai-tool-chip") as HTMLButtonElement;
    fireEvent.click(chip);
    const out = baseElement.querySelector(".ai-tool-output");
    expect(out?.textContent).toContain("[DIR] diagramas");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(chip);
    expect(baseElement.querySelector(".ai-tool-output")).toBeNull();
  });

  it("expands a still-running tool chip showing its args", () => {
    const { baseElement } = render(() => (
      <AiMessage
        role="assistant"
        content=""
        tools={[
          {
            toolCallId: "t1",
            toolName: "e2e-echo__add",
            source: "e2e-echo",
            status: "running",
            args: { a: 17, b: 25 },
          },
        ]}
      />
    ));
    fireEvent.click(baseElement.querySelector(".ai-tool-chip") as HTMLElement);
    const out = baseElement.querySelector(".ai-tool-output");
    expect(out?.textContent).toContain("add");
    expect(out?.textContent).toContain('"a": 17');
  });

  it("intercepts reply links: opens http(s) externally and never navigates the webview", () => {
    const store = createAiChatStore({
      getProvider: () => null,
      initialMessages: [
        { role: "assistant", content: "see [site](https://example.com) and README.md" },
      ],
    });
    const onOpenExternal = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel store={store} providerLabel="Mock" onOpenExternal={onOpenExternal} />
    ));
    // Fuzzy linkify is off — the bare file name must not have become a link.
    const links = [...baseElement.querySelectorAll(".ai-markdown a")];
    expect(links).toHaveLength(1);
    // The click is cancelled (no webview navigation) and routed to the host.
    const notCancelled = fireEvent.click(links[0]!);
    expect(notCancelled).toBe(false);
    expect(onOpenExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("copies the message content to the clipboard via the hover copy action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom exposes `navigator.clipboard` as a getter-only accessor, so a plain
    // Object.assign throws — redefine the property instead.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { baseElement } = render(() => <AiMessage content="copy me" role="assistant" />);
    const btn = baseElement.querySelector(".ai-msg-action-btn") as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe("Copy");
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith("copy me");
    // After the write resolves the button shows the transient "copied" state.
    await waitFor(() => {
      expect(btn.getAttribute("aria-label")).toBe("Copied");
    });
  });

  it("shows retry only on the last assistant message and regenerates on click", async () => {
    const store = createAiChatStore({
      getProvider: () => createMockProvider({ reply: () => "fresh reply", chunkDelayMs: 0 }),
      initialMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
      ],
    });
    const { baseElement } = render(() => <AiPanel store={store} providerLabel="Mock" />);
    // Every bubble gets a copy action, but only the LAST assistant turn is
    // retryable.
    expect(baseElement.querySelectorAll('[aria-label="Copy"]')).toHaveLength(4);
    const retries = baseElement.querySelectorAll('[aria-label="Regenerate"]');
    expect(retries).toHaveLength(1);
    const bubbles = baseElement.querySelectorAll(".ai-message");
    expect(bubbles[bubbles.length - 1]!.contains(retries[0]!)).toBe(true);
    // Clicking retry drops "a2" and streams a fresh reply in its place.
    fireEvent.click(retries[0]!);
    await waitFor(() => {
      expect(store.messages().at(-1)).toEqual({ role: "assistant", content: "fresh reply" });
    });
    expect(store.messages()).toHaveLength(4);
    expect(store.messages().filter((t) => t.role === "user")).toHaveLength(2);
  });

  it("hides the Build/Plan mode picker when onModeChange is absent", () => {
    const store = readyStore();
    render(() => <AiPanel store={store} providerLabel="Mock" />);
    expect(screen.queryByLabelText("Chat mode")).toBeNull();
  });

  it("renders the mode picker showing the active mode, and fires onModeChange on select", () => {
    const store = readyStore();
    const onModeChange = vi.fn();
    render(() => <AiPanel store={store} providerLabel="Mock" mode="plan" onModeChange={onModeChange} />);
    // The SolidUI Select trigger shows the current mode's label.
    const trigger = screen.getByLabelText("Chat mode");
    expect(trigger.textContent).toContain("Plan");
    // Open the listbox (kobalte opens on the pointer sequence) and pick Build.
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    const build = screen.getByText("Build");
    fireEvent.pointerDown(build, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(build, { button: 0, pointerType: "mouse" });
    fireEvent.click(build);
    expect(onModeChange).toHaveBeenCalledWith("build");
  });
});
