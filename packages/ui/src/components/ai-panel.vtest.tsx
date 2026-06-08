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

  it("shows a model picker (not the static chip) listing the provider's models", () => {
    const store = readyStore();
    const onSelectModel = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        models={[
          { value: "p/m1", label: "Model 1" },
          { value: "p/m2", label: "Model 2" },
        ]}
        currentModel="p/m1"
        onSelectModel={onSelectModel}
      />
    ));
    // The static "connected" chip is replaced by a clickable model picker that
    // shows the current model's label.
    const trigger = baseElement.querySelector(".ai-model-select") as HTMLElement;
    expect(trigger).not.toBeNull();
    expect(baseElement.querySelector(".ai-provider-chip")).toBeNull();
    expect(trigger.textContent).toContain("Model 1");
    // Open the menu (kobalte DropdownMenu opens on the pointer sequence) and
    // confirm both models are listed (onSelect wiring is Kobalte's concern).
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    expect(screen.getByText("Model 2")).not.toBeNull();
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
});
