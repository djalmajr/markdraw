import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createMockProvider } from "@markdraw/ai/mock-provider.ts";
import type { SlashCommandDef } from "@markdraw/ai/slash-commands.ts";
import type { AIMessage, AIProvider } from "@markdraw/ai/types.ts";
import { createAiChatStore, type AiChatStore } from "../composables/create-ai-chat-store.ts";
import {
  buildContextPreamble,
  type AiContextItem,
  type AiInlineReference,
} from "../composables/ai-context.ts";
import { AiPanel, type AiMentionEntry } from "./ai-panel.tsx";
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
    // The reference stays INLINE: the typed "@al" is replaced by the literal
    // "@alpha.md " token in the composer text, and the list closes.
    expect(ta.value).toBe("@alpha.md ");
    expect(baseElement.querySelectorAll(".ai-mention-item")).toHaveLength(0);
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
    // so the host knows to attach a listing instead of file content. The
    // typed "@no" becomes the inline "@notes/ " token (folder labels already
    // carry the trailing slash).
    fireEvent.mouseDown(items[0]!);
    expect(onMention).toHaveBeenCalledWith({ kind: "dir", label: "notes/", path: "notes", rootId: "r" });
    expect(ta.value).toBe("@notes/ ");
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

  it("clicking a user turn's edit action loads it into the composer and shows the editing bar", () => {
    const store = createAiChatStore({
      getProvider: () => createMockProvider({ reply: () => "x", chunkDelayMs: 0 }),
      initialMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
      ],
    });
    const { baseElement } = render(() => <AiPanel store={store} providerLabel="Mock" />);
    // Every USER bubble (and only those) offers the edit action.
    const edits = baseElement.querySelectorAll('[aria-label="Edit and resend"]');
    expect(edits).toHaveLength(2);
    fireEvent.click(edits[0]!);
    const textarea = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    expect(textarea.value).toBe("q1");
    expect(baseElement.querySelector(".ai-editing-bar")).not.toBeNull();
  });

  it("submitting while editing calls editAndResend: the history truncates at the edited turn", async () => {
    const store = createAiChatStore({
      getProvider: () => createMockProvider({ reply: () => "edited reply", chunkDelayMs: 0 }),
      initialMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
      ],
    });
    const { baseElement } = render(() => <AiPanel store={store} providerLabel="Mock" />);
    fireEvent.click(baseElement.querySelectorAll('[aria-label="Edit and resend"]')[0]!);
    const textarea = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "q1 edited" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(store.messages().at(-1)).toEqual({ role: "assistant", content: "edited reply" });
    });
    // Later turns dropped; the edited turn replaced the original.
    expect(store.messages()).toEqual([
      { role: "user", content: "q1 edited" },
      { role: "assistant", content: "edited reply" },
    ]);
    // The editing state cleared along with the composer.
    expect(baseElement.querySelector(".ai-editing-bar")).toBeNull();
    expect(textarea.value).toBe("");
  });

  it("the editing bar's X and Escape both cancel editing and empty the composer", () => {
    const store = createAiChatStore({
      getProvider: () => createMockProvider({ reply: () => "x", chunkDelayMs: 0 }),
      initialMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ],
    });
    const { baseElement } = render(() => <AiPanel store={store} providerLabel="Mock" />);
    const edit = baseElement.querySelector('[aria-label="Edit and resend"]') as HTMLElement;
    const textarea = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    // X dismisses.
    fireEvent.click(edit);
    expect(textarea.value).toBe("q1");
    fireEvent.click(baseElement.querySelector(".ai-editing-bar .ai-context-chip-x") as HTMLElement);
    expect(baseElement.querySelector(".ai-editing-bar")).toBeNull();
    expect(textarea.value).toBe("");
    // Escape dismisses too.
    fireEvent.click(edit);
    expect(baseElement.querySelector(".ai-editing-bar")).not.toBeNull();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(baseElement.querySelector(".ai-editing-bar")).toBeNull();
    expect(textarea.value).toBe("");
    // History untouched by cancelled edits.
    expect(store.messages()).toHaveLength(2);
  });

  it("renders the usage stats span when an assistant message carries usage", () => {
    const { baseElement } = render(() => (
      <AiMessage content="done" role="assistant" usage={{ inputTokens: 1234, outputTokens: 800 }} />
    ));
    const span = baseElement.querySelector(".ai-msg-usage");
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe("↑1.2k ↓800");
    // The title carries the raw counts.
    expect(span?.getAttribute("title")).toContain("1234");
    expect(span?.getAttribute("title")).toContain("800");
  });

  it("renders no usage span when the message has no usage", () => {
    const { baseElement } = render(() => <AiMessage content="done" role="assistant" />);
    expect(baseElement.querySelector(".ai-msg-usage")).toBeNull();
  });

  it("passes a turn's usage through to the message bubble", () => {
    const store = createAiChatStore({
      getProvider: () => null,
      initialMessages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a", usage: { inputTokens: 10, outputTokens: 20 } },
      ],
    });
    const { baseElement } = render(() => <AiPanel store={store} providerLabel="Mock" />);
    expect(baseElement.querySelector(".ai-msg-usage")?.textContent).toBe("↑10 ↓20");
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

  it("displayText transforms the rendered content but the store text stays untouched", async () => {
    // Display-only restore (omp#5): the chat shows real values while the
    // stored transcript keeps the scrubbed placeholders the provider saw.
    const store = createAiChatStore({
      getProvider: () =>
        createMockProvider({ reply: () => "token is [secret-1]", chunkDelayMs: 0 }),
      initialMessages: [
        { role: "user", content: "use [secret-1]" },
        { role: "assistant", content: "noted [secret-1]" },
      ],
    });
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        displayText={(text) => text.split("[secret-1]").join("sk-realvalue")}
        providerLabel="Mock"
      />
    ));
    // History messages render the restored value...
    expect(baseElement.textContent).toContain("noted sk-realvalue");
    expect(baseElement.textContent).not.toContain("secret-1");
    // ...while the store keeps the original placeholder text.
    expect(store.messages()[1]?.content).toBe("noted [secret-1]");
    // A streamed turn is transformed for display too, and consolidates into
    // the store with the original text.
    const ta = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "go" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => {
      expect(store.messages().at(-1)).toEqual({ role: "assistant", content: "token is [secret-1]" });
    });
    expect(baseElement.textContent).toContain("token is sk-realvalue");
    expect(baseElement.textContent).not.toContain("secret-1");
  });

  it("expanded tool chip output applies displayText (chip names stay raw)", () => {
    // Tool args/results carry the placeholders the provider saw — the
    // expanded terminal block must show the restored values too.
    const store = createAiChatStore({
      getProvider: () => null,
      initialMessages: [
        {
          content: "done",
          role: "assistant",
          tools: [
            {
              result: "key: [secret-1]",
              status: "done",
              toolCallId: "t1",
              toolName: "app__read_file",
            },
          ],
        },
      ],
    });
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        displayText={(text) => text.split("[secret-1]").join("sk-realvalue")}
        providerLabel="Mock"
      />
    ));
    const chip = baseElement.querySelector(".ai-tool-chip") as HTMLButtonElement;
    expect(chip.textContent).toContain("read_file");
    fireEvent.click(chip);
    const output = baseElement.querySelector(".ai-tool-output");
    expect(output?.textContent).toBe("key: sk-realvalue");
  });
});

describe("AiPanel — @-mention workspace roots", () => {
  const ROOT: AiMentionEntry = { kind: "dir", label: "wksp/", path: "", rootId: "r1" };

  /** N files plus the root — appended LAST, mirroring app-shell's memo, so
   *  these tests prove the popover reorders roots to the top. */
  function mentionEntries(fileCount: number): AiMentionEntry[] {
    const files: AiMentionEntry[] = Array.from({ length: fileCount }, (_, n) => ({
      kind: "file",
      label: `file-${n}.md`,
      path: `docs/file-${n}.md`,
      rootId: "r1",
    }));
    return [...files, ROOT];
  }

  function typeMention(baseElement: HTMLElement, value: string): HTMLTextAreaElement {
    const ta = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    ta.value = value;
    ta.setSelectionRange(value.length, value.length);
    fireEvent.input(ta);
    return ta;
  }

  it("pins the root above the files on '@' even when files fill the 8-entry cap", () => {
    const store = readyStore();
    const { baseElement } = render(() => (
      <AiPanel store={store} mentionFiles={mentionEntries(12)} />
    ));
    typeMention(baseElement, "@");
    const items = baseElement.querySelectorAll(".ai-mention-item");
    // 1 pinned root + the 8-file cap — the root is NOT subject to the cap.
    expect(items).toHaveLength(9);
    expect(items[0]!.classList.contains("ai-mention-root")).toBe(true);
    expect(items[0]!.querySelector(".ai-mention-name")?.textContent).toBe("wksp/");
    // Only the root row carries the workspace badge.
    expect(items[0]!.querySelector(".ai-mention-root-badge")?.textContent).toBe("workspace");
    expect(baseElement.querySelectorAll(".ai-mention-root-badge")).toHaveLength(1);
  });

  it("hides roots that don't match a file-only query", () => {
    const store = readyStore();
    const { baseElement } = render(() => (
      <AiPanel store={store} mentionFiles={mentionEntries(3)} />
    ));
    typeMention(baseElement, "@file-1");
    const items = baseElement.querySelectorAll(".ai-mention-item");
    expect(items).toHaveLength(1);
    expect(items[0]!.classList.contains("ai-mention-root")).toBe(false);
    expect(baseElement.querySelectorAll(".ai-mention-root")).toHaveLength(0);
  });

  it("renders the dim rootLabel hint on entries that carry one", () => {
    const store = readyStore();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        mentionFiles={[
          { kind: "file", label: "alpha.md", path: "a/alpha.md", rootId: "r1", rootLabel: "wksp" },
          ROOT,
        ]}
      />
    ));
    typeMention(baseElement, "@al");
    const items = baseElement.querySelectorAll(".ai-mention-item");
    expect(items).toHaveLength(1);
    expect(items[0]!.querySelector(".ai-mention-root-hint")?.textContent).toBe("wksp");
    // The root entry itself carries no rootLabel — no hint on its row.
    typeMention(baseElement, "@");
    expect(baseElement.querySelector(".ai-mention-root .ai-mention-root-hint")).toBeNull();
  });

  it("Enter on index 0 inserts the pinned root mention", () => {
    const store = readyStore();
    const onMention = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel store={store} mentionFiles={mentionEntries(12)} onMention={onMention} />
    ));
    const ta = typeMention(baseElement, "@");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onMention).toHaveBeenCalledWith(ROOT);
    // The "@" becomes the inline root token, the list closes, nothing was sent.
    expect(ta.value).toBe("@wksp/ ");
    expect(baseElement.querySelectorAll(".ai-mention-item")).toHaveLength(0);
    expect(store.messages()).toHaveLength(0);
  });
});

describe("AiPanel — inline @-mention tokens (Cursor-style)", () => {
  const FILES: AiMentionEntry[] = [
    { label: "alpha.md", path: "a/alpha.md", rootId: "r" },
    { label: "beta.md", path: "b/beta.md", rootId: "r" },
  ];
  // Items carry path/rootId like the real host's addFileMention — the panel
  // matches and hides mention items by that identity, not by label.
  const ALPHA_ITEM: AiContextItem = {
    content: "ALPHA",
    id: "mention:r:a/alpha.md",
    kind: "file",
    label: "alpha.md",
    path: "a/alpha.md",
    rootId: "r",
  };
  const BETA_ITEM: AiContextItem = {
    content: "BETA",
    id: "mention:r:b/beta.md",
    kind: "file",
    label: "beta.md",
    path: "b/beta.md",
    rootId: "r",
  };
  // The SAME file name in two roots — the label-collision scenario the
  // identity matching exists for.
  const TWIN_FILES: AiMentionEntry[] = [
    { label: "notes.md", path: "a/notes.md", rootId: "r1", rootLabel: "wksp" },
    { label: "notes.md", path: "b/notes.md", rootId: "r2", rootLabel: "docs" },
  ];
  const TWIN_R1_ITEM: AiContextItem = {
    content: "R1",
    id: "mention:r1:a/notes.md",
    kind: "file",
    label: "notes.md",
    path: "a/notes.md",
    rootId: "r1",
  };
  const TWIN_R2_ITEM: AiContextItem = {
    content: "R2",
    id: "mention:r2:b/notes.md",
    kind: "file",
    label: "notes.md",
    path: "b/notes.md",
    rootId: "r2",
  };

  function typeText(baseElement: HTMLElement, value: string, caret?: number): HTMLTextAreaElement {
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    ta.value = value;
    const at = caret ?? value.length;
    ta.setSelectionRange(at, at);
    fireEvent.input(ta);
    return ta;
  }

  function pickMention(baseElement: HTMLElement, index = 0): void {
    fireEvent.mouseDown(baseElement.querySelectorAll(".ai-mention-item")[index]!);
  }

  /** Minimal AiChatStore stub so a test can control the sendMessage promise. */
  function stubStore(over: Partial<AiChatStore> = {}): AiChatStore {
    return {
      cancel: () => {},
      cancelQueued: () => {},
      clear: () => {},
      editAndResend: async () => {},
      error: () => null,
      listTools: async () => [],
      messages: () => [],
      providerReady: () => true,
      queued: () => null,
      retryLast: async () => {},
      sendMessage: async () => {},
      streaming: () => false,
      streamingText: () => "",
      systemPrompt: () => undefined,
      toolActivity: () => [],
      ...over,
    };
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("selecting a mention inserts '@label ' inline, highlights it, and fires onMention", () => {
    const store = readyStore();
    const onMention = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel store={store} mentionFiles={FILES} onMention={onMention} />
    ));
    const ta = typeText(baseElement, "@al");
    pickMention(baseElement);
    expect(onMention).toHaveBeenCalledWith(FILES[0]);
    expect(ta.value).toBe("@alpha.md ");
    // The backdrop renders the tracked token as a pill span.
    expect(baseElement.querySelector(".ai-inline-mention")?.textContent).toBe("@alpha.md");
  });

  it("deleting the token text removes the resolved context item", () => {
    const store = readyStore();
    const onRemoveContext = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        contextItems={[ALPHA_ITEM]}
        mentionFiles={FILES}
        onRemoveContext={onRemoveContext}
      />
    ));
    typeText(baseElement, "@al");
    pickMention(baseElement);
    // Breaking the token's literal string (one char deleted) untracks it.
    typeText(baseElement, "@alpha.m ");
    expect(onRemoveContext).toHaveBeenCalledWith("mention:r:a/alpha.md");
    expect(baseElement.querySelector(".ai-inline-mention")).toBeNull();
  });

  it("async orphan: a token deleted before its item lands removes the item on arrival", async () => {
    const store = readyStore();
    const onRemoveContext = vi.fn();
    const [items, setItems] = createSignal<AiContextItem[]>([]);
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        contextItems={items()}
        mentionFiles={FILES}
        onRemoveContext={onRemoveContext}
      />
    ));
    typeText(baseElement, "@al");
    pickMention(baseElement);
    // The host is still reading the file — no item yet when the token dies.
    typeText(baseElement, "x");
    expect(onRemoveContext).not.toHaveBeenCalled();
    // The item lands late → the pending-removal sweep drops it immediately.
    setItems([ALPHA_ITEM]);
    await waitFor(() => {
      expect(onRemoveContext).toHaveBeenCalledWith("mention:r:a/alpha.md");
    });
  });

  it("the chips bar hides a tokened item but keeps a tree-added one showing", () => {
    const store = readyStore();
    const { baseElement } = render(() => (
      <AiPanel store={store} contextItems={[ALPHA_ITEM, BETA_ITEM]} mentionFiles={FILES} />
    ));
    // Both arrived without tokens (file-tree "Add to chat") — both show.
    expect(baseElement.querySelectorAll(".ai-context-chip")).toHaveLength(2);
    typeText(baseElement, "@al");
    pickMention(baseElement);
    // alpha.md is now represented by its inline token; beta.md keeps its chip.
    const chips = [...baseElement.querySelectorAll(".ai-context-chip")];
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain("beta.md");
  });

  it("submit keeps tokens verbatim, reorders to textual order, and removes items only after the send resolves", async () => {
    const send = deferred();
    const sendMessage = vi.fn(() => send.promise);
    const store = stubStore({ sendMessage });
    const onRemoveContext = vi.fn();
    const onReorderContext = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        contextItems={[ALPHA_ITEM, BETA_ITEM]}
        mentionFiles={FILES}
        onRemoveContext={onRemoveContext}
        onReorderContext={onReorderContext}
      />
    ));
    // alpha mentioned first, but its token ends up AFTER beta's in the text:
    typeText(baseElement, "@al");
    pickMention(baseElement);
    const ta = typeText(baseElement, "@be @alpha.md ", 3);
    pickMention(baseElement);
    expect(ta.value).toBe("@beta.md  @alpha.md ");
    fireEvent.keyDown(ta, { key: "Enter" });
    // Sent text carries the tokens verbatim; the reorder (item IDS in
    // textual order) happened BEFORE the send so the preamble matches.
    expect(sendMessage).toHaveBeenCalledWith("@beta.md  @alpha.md ");
    expect(onReorderContext).toHaveBeenCalledWith(["mention:r:b/beta.md", "mention:r:a/alpha.md"]);
    expect(onReorderContext.mock.invocationCallOrder[0]!).toBeLessThan(
      sendMessage.mock.invocationCallOrder[0]!,
    );
    // Consumed-but-not-removed: the chips stay hidden, items stay attached
    // (a queued steering send reads the preamble when the turn actually runs).
    expect(onRemoveContext).not.toHaveBeenCalled();
    expect(baseElement.querySelectorAll(".ai-context-chip")).toHaveLength(0);
    send.resolve();
    await waitFor(() => {
      expect(onRemoveContext).toHaveBeenCalledWith("mention:r:b/beta.md");
      expect(onRemoveContext).toHaveBeenCalledWith("mention:r:a/alpha.md");
    });
  });

  it("a chat switch with a live token removes its item and empties the composer", async () => {
    const [store, setStore] = createSignal(readyStore());
    const onRemoveContext = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store()}
        contextItems={[ALPHA_ITEM]}
        mentionFiles={FILES}
        onRemoveContext={onRemoveContext}
      />
    ));
    typeText(baseElement, "@al");
    pickMention(baseElement);
    setStore(readyStore());
    await waitFor(() => {
      expect(onRemoveContext).toHaveBeenCalledWith("mention:r:a/alpha.md");
    });
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    expect(ta.value).toBe("");
  });

  it("a label collision falls back to a path-qualified token for the second entry", () => {
    const store = readyStore();
    const twins: AiMentionEntry[] = [
      { label: "notes.md", path: "a/notes.md", rootId: "r1", rootLabel: "wksp" },
      { label: "notes.md", path: "b/notes.md", rootId: "r2", rootLabel: "docs" },
    ];
    const { baseElement } = render(() => <AiPanel store={store} mentionFiles={twins} />);
    typeText(baseElement, "@notes");
    pickMention(baseElement, 0);
    typeText(baseElement, "@notes.md @notes");
    pickMention(baseElement, 1);
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    expect(ta.value).toBe("@notes.md @docs/b/notes.md ");
  });

  it("a steering send keeps its mention items attached until the queued turn actually runs (real store)", async () => {
    // One gated turn per chat() call, capturing the outgoing messages — the
    // test must prove the QUEUED turn still saw the mention content in its
    // preamble (getContext is read when the turn runs, not at queue time).
    const gates: Array<() => void> = [];
    const outgoing: AIMessage[][] = [];
    const provider: AIProvider = {
      async *chat(messages) {
        outgoing.push([...messages]);
        await new Promise<void>((resolve) => gates.push(resolve));
        yield { type: "text-delta", text: "ok" };
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    };
    const [items, setItems] = createSignal<AiContextItem[]>([]);
    const store = createAiChatStore({
      getProvider: () => provider,
      getContext: () => buildContextPreamble(items()),
    });
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        contextItems={items()}
        mentionFiles={FILES}
        onMention={() => setItems([BETA_ITEM])}
        onRemoveContext={(id) => setItems((prev) => prev.filter((i) => i.id !== id))}
      />
    ));
    // Turn 1 streams (its gate stays closed)...
    const ta = typeText(baseElement, "hi");
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(gates).toHaveLength(1));
    // ...and a steering send with an @-mention queues while it does.
    typeText(baseElement, "@be");
    pickMention(baseElement);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(store.queued()).toBe("@beta.md");
    // The mention's item must STAY attached while the message sits queued.
    await Promise.resolve();
    await Promise.resolve();
    expect(items()).toEqual([BETA_ITEM]);
    // Finish turn 1 → the queued turn runs WITH the mention content attached.
    gates[0]!();
    await waitFor(() => expect(gates).toHaveLength(2));
    expect(outgoing[1]!.at(-1)?.content).toContain("BETA");
    expect(items()).toEqual([BETA_ITEM]);
    // Only after the queued turn completes does the consumed item release.
    gates[1]!();
    await waitFor(() => expect(items()).toEqual([]));
  });

  it("twin labels: deleting one twin's token removes ITS item, not the other twin's", () => {
    const store = readyStore();
    const [items, setItems] = createSignal<AiContextItem[]>([TWIN_R1_ITEM, TWIN_R2_ITEM]);
    const onRemoveContext = vi.fn((id: string) =>
      setItems((prev) => prev.filter((i) => i.id !== id)),
    );
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        contextItems={items()}
        mentionFiles={TWIN_FILES}
        onRemoveContext={onRemoveContext}
      />
    ));
    // Mention both: the second twin gets the path-qualified collision token.
    typeText(baseElement, "@notes");
    pickMention(baseElement, 0);
    typeText(baseElement, "@notes.md @notes");
    pickMention(baseElement, 1);
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    expect(ta.value).toBe("@notes.md @docs/b/notes.md ");
    // Both twins tokened — both chips hidden.
    expect(baseElement.querySelectorAll(".ai-context-chip")).toHaveLength(0);
    // Deleting the SECOND twin's token must remove r2's item, never r1's.
    typeText(baseElement, "@notes.md ");
    expect(onRemoveContext).toHaveBeenCalledTimes(1);
    expect(onRemoveContext).toHaveBeenCalledWith("mention:r2:b/notes.md");
    expect(items()).toEqual([TWIN_R1_ITEM]);
    // r1's token is still live, so its chip stays hidden (not stranded gone).
    expect(baseElement.querySelectorAll(".ai-context-chip")).toHaveLength(0);
  });

  it("twin labels: a tokened twin hides only ITS chip — the untokened twin stays visible and removable", () => {
    const store = readyStore();
    const onRemoveContext = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        contextItems={[TWIN_R1_ITEM, TWIN_R2_ITEM]}
        mentionFiles={TWIN_FILES}
        onRemoveContext={onRemoveContext}
      />
    ));
    // Token only the r2 twin; r1 arrived without a token (tree "Add to chat").
    typeText(baseElement, "@notes");
    pickMention(baseElement, 1);
    const chips = baseElement.querySelectorAll(".ai-context-chip");
    expect(chips).toHaveLength(1);
    // The visible chip is r1's — its × removes r1, proving it never stranded.
    fireEvent.click(chips[0]!.querySelector(".ai-context-chip-x")!);
    expect(onRemoveContext).toHaveBeenCalledWith("mention:r1:a/notes.md");
  });

  it("twin labels: an async-orphan removal only kills the dead token's twin when items land", async () => {
    const store = readyStore();
    const [items, setItems] = createSignal<AiContextItem[]>([]);
    const onRemoveContext = vi.fn((id: string) =>
      setItems((prev) => prev.filter((i) => i.id !== id)),
    );
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        contextItems={items()}
        mentionFiles={TWIN_FILES}
        onRemoveContext={onRemoveContext}
      />
    ));
    // Mention the r2 twin and kill its token before the host lands any item.
    typeText(baseElement, "@notes");
    pickMention(baseElement, 1);
    typeText(baseElement, "x");
    expect(onRemoveContext).not.toHaveBeenCalled();
    // BOTH twins land in the same batch — the sweep may only take r2's.
    setItems([TWIN_R1_ITEM, TWIN_R2_ITEM]);
    await waitFor(() => {
      expect(onRemoveContext).toHaveBeenCalledWith("mention:r2:b/notes.md");
    });
    expect(onRemoveContext).toHaveBeenCalledTimes(1);
    expect(items()).toEqual([TWIN_R1_ITEM]);
    expect(baseElement.querySelectorAll(".ai-context-chip")).toHaveLength(1);
  });
});

describe("AiPanel — inline selection tokens (host-requested item refs)", () => {
  const SEL_ITEM: AiContextItem = {
    content: "selected text",
    id: "selection:doc.md:10-20",
    kind: "selection",
    label: "doc.md:3-7",
    path: "doc.md",
  };
  const OTHER_SEL_ITEM: AiContextItem = {
    content: "other text",
    id: "selection:other.md:0-5",
    kind: "selection",
    label: "other.md:1-2",
    path: "other.md",
  };
  const ALPHA_FILE: AiMentionEntry = { label: "alpha.md", path: "a/alpha.md", rootId: "r" };
  const ALPHA_ITEM: AiContextItem = {
    content: "ALPHA",
    id: "mention:r:a/alpha.md",
    kind: "file",
    label: "alpha.md",
    path: "a/alpha.md",
    rootId: "r",
  };

  function typeText(baseElement: HTMLElement, value: string, caret?: number): HTMLTextAreaElement {
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    ta.value = value;
    const at = caret ?? value.length;
    ta.setSelectionRange(at, at);
    fireEvent.input(ta);
    return ta;
  }

  /** Minimal AiChatStore stub so a test can control the sendMessage promise. */
  function stubStore(over: Partial<AiChatStore> = {}): AiChatStore {
    return {
      cancel: () => {},
      cancelQueued: () => {},
      clear: () => {},
      editAndResend: async () => {},
      error: () => null,
      listTools: async () => [],
      messages: () => [],
      providerReady: () => true,
      queued: () => null,
      retryLast: async () => {},
      sendMessage: async () => {},
      streaming: () => false,
      streamingText: () => "",
      systemPrompt: () => undefined,
      toolActivity: () => [],
      ...over,
    };
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("the trigger effect inserts '@token ' inline, shows the pill, and focuses the composer", async () => {
    const store = readyStore();
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel contextItems={[SEL_ITEM]} inlineReference={ref()} store={store} />
    ));
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    expect(ta.value).toBe("@doc.md:3-7 ");
    expect(baseElement.querySelector(".ai-inline-mention")?.textContent).toBe("@doc.md:3-7");
    await waitFor(() => {
      expect(document.activeElement).toBe(ta);
    });
    expect(ta.selectionStart).toBe("@doc.md:3-7 ".length);
  });

  it("inserts a separating space after non-whitespace (focused caret and unfocused append)", () => {
    const store = readyStore();
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel
        contextItems={[SEL_ITEM, OTHER_SEL_ITEM]}
        inlineReference={ref()}
        store={store}
      />
    ));
    // The mount effect focuses the composer — the caret (end of the typed
    // text) follows non-whitespace, so the token gets a separating space.
    const ta = typeText(baseElement, "explain this");
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    expect(ta.value).toBe("explain this @doc.md:3-7 ");
    // Unfocused: the stale caret is ignored — the next reference APPENDS
    // (already after whitespace here, so no doubled space).
    ta.blur();
    ta.setSelectionRange(0, 0);
    setRef({ itemId: OTHER_SEL_ITEM.id, seq: 2, token: OTHER_SEL_ITEM.label });
    expect(ta.value).toBe("explain this @doc.md:3-7 @other.md:1-2 ");
  });

  it("the same seq never re-inserts, and a new seq for the same item only refocuses", () => {
    const store = readyStore();
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel contextItems={[SEL_ITEM]} inlineReference={ref()} store={store} />
    ));
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    // The same reference re-set with the SAME seq is a no-op...
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    expect(ta.value).toBe("@doc.md:3-7 ");
    // ...and a NEW seq for the same item+token refocuses without duplicating.
    setRef({ itemId: SEL_ITEM.id, seq: 2, token: SEL_ITEM.label });
    expect(ta.value).toBe("@doc.md:3-7 ");
    expect(baseElement.querySelectorAll(".ai-inline-mention")).toHaveLength(1);
  });

  it("a panel that MOUNTS with a pending reference inserts it and acks the host", () => {
    // ⌘I with the chat tab closed: the host requests the reference, then
    // focusAiComposer creates the panel — the pending value must not be
    // swallowed as stale. The ack is what makes that distinction safe.
    const store = readyStore();
    const onInlineReferenceHandled = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        contextItems={[SEL_ITEM]}
        inlineReference={{ itemId: SEL_ITEM.id, seq: 7, token: SEL_ITEM.label }}
        store={store}
        onInlineReferenceHandled={onInlineReferenceHandled}
      />
    ));
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    expect(ta.value).toBe("@doc.md:3-7 ");
    expect(onInlineReferenceHandled).toHaveBeenCalledTimes(1);
  });

  it("deleting the token text removes the selection item by its ID", () => {
    const store = readyStore();
    const onRemoveContext = vi.fn();
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel
        contextItems={[SEL_ITEM]}
        inlineReference={ref()}
        store={store}
        onRemoveContext={onRemoveContext}
      />
    ));
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    // Gluing a character onto the token breaks its boundary → untracked.
    typeText(baseElement, "@doc.md:3-7x");
    expect(onRemoveContext).toHaveBeenCalledWith("selection:doc.md:10-20");
    expect(baseElement.querySelector(".ai-inline-mention")).toBeNull();
  });

  it("the chips bar hides a tokened selection but keeps an untokened one showing", () => {
    const store = readyStore();
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel contextItems={[SEL_ITEM, OTHER_SEL_ITEM]} inlineReference={ref()} store={store} />
    ));
    expect(baseElement.querySelectorAll(".ai-context-chip")).toHaveLength(2);
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    const chips = [...baseElement.querySelectorAll(".ai-context-chip")];
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain("other.md:1-2");
  });

  it("submit keeps the token verbatim, reorders cross-kind item IDS in textual order, and removes only after the send settles", async () => {
    const send = deferred();
    const sendMessage = vi.fn(() => send.promise);
    const store = stubStore({ sendMessage });
    const onRemoveContext = vi.fn();
    const onReorderContext = vi.fn();
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel
        contextItems={[ALPHA_ITEM, SEL_ITEM]}
        inlineReference={ref()}
        mentionFiles={[ALPHA_FILE]}
        store={store}
        onRemoveContext={onRemoveContext}
        onReorderContext={onReorderContext}
      />
    ));
    // A mention token first, then the selection token appended after it —
    // locks the cross-kind textual ordering.
    typeText(baseElement, "@al");
    fireEvent.mouseDown(baseElement.querySelector(".ai-mention-item")!);
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    expect(ta.value).toBe("@alpha.md @doc.md:3-7 ");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(sendMessage).toHaveBeenCalledWith("@alpha.md @doc.md:3-7 ");
    expect(onReorderContext).toHaveBeenCalledWith([
      "mention:r:a/alpha.md",
      "selection:doc.md:10-20",
    ]);
    // Consumed-but-not-settled: nothing removed, chips stay hidden.
    expect(onRemoveContext).not.toHaveBeenCalled();
    expect(baseElement.querySelectorAll(".ai-context-chip")).toHaveLength(0);
    send.resolve();
    await waitFor(() => {
      expect(onRemoveContext).toHaveBeenCalledWith("mention:r:a/alpha.md");
      expect(onRemoveContext).toHaveBeenCalledWith("selection:doc.md:10-20");
    });
  });

  it("a chat switch with a live selection token removes its item and empties the composer", async () => {
    const [store, setStore] = createSignal(readyStore());
    const onRemoveContext = vi.fn();
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel
        contextItems={[SEL_ITEM]}
        inlineReference={ref()}
        store={store()}
        onRemoveContext={onRemoveContext}
      />
    ));
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    setStore(readyStore());
    await waitFor(() => {
      expect(onRemoveContext).toHaveBeenCalledWith("selection:doc.md:10-20");
    });
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    expect(ta.value).toBe("");
  });

  it("closes an open @-mention list when the trigger fires, so Enter submits instead of selecting", () => {
    const sendMessage = vi.fn(async () => {});
    const store = stubStore({ sendMessage });
    const onMention = vi.fn();
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel
        contextItems={[SEL_ITEM]}
        inlineReference={ref()}
        mentionFiles={[ALPHA_FILE]}
        store={store}
        onMention={onMention}
      />
    ));
    const ta = typeText(baseElement, "@al");
    expect(baseElement.querySelectorAll(".ai-mention-item")).toHaveLength(1);
    // The insertion bypasses the textarea's input event — the popover belongs
    // to the pre-insertion "@al" text and must close, or its Enter handler
    // would run selectMention (a hidden, token-less mention) instead of send.
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    expect(baseElement.querySelectorAll(".ai-mention-item")).toHaveLength(0);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onMention).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("@al @doc.md:3-7 ");
  });

  it("closes an open slash list when the trigger fires, so Enter submits instead of selecting", () => {
    const sendMessage = vi.fn(async () => {});
    const store = stubStore({ sendMessage });
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel
        contextItems={[SEL_ITEM]}
        inlineReference={ref()}
        slashCommands={[
          {
            description: "Summarize the conversation",
            name: "summarize",
            source: "project",
            template: "Summarize the conversation.",
          },
        ]}
        store={store}
      />
    ));
    const ta = typeText(baseElement, "/su");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(1);
    // Left open, the stale list's Enter would run selectSlashCommand and wipe
    // the just-inserted token text while its ref stayed tracked.
    setRef({ itemId: SEL_ITEM.id, seq: 1, token: SEL_ITEM.label });
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
    fireEvent.keyDown(ta, { key: "Enter" });
    // "/su" matches no command, so the text passes through with the token intact.
    expect(sendMessage).toHaveBeenCalledWith("/su @doc.md:3-7 ");
  });

  it("the same token text for two DIFFERENT items dedupes the second with '-2'", () => {
    const store = readyStore();
    const onRemoveContext = vi.fn();
    const firstItem: AiContextItem = {
      content: "A",
      id: "excalidraw-selection:flow.excalidraw:e1",
      kind: "selection",
      label: "flow.excalidraw · 1 el",
    };
    const secondItem: AiContextItem = {
      content: "B",
      id: "excalidraw-selection:flow.excalidraw:e2",
      kind: "selection",
      label: "flow.excalidraw · 1 el-2",
    };
    const [ref, setRef] = createSignal<AiInlineReference | null>(null);
    const { baseElement } = render(() => (
      <AiPanel
        contextItems={[firstItem, secondItem]}
        inlineReference={ref()}
        store={store}
        onRemoveContext={onRemoveContext}
      />
    ));
    setRef({ itemId: firstItem.id, seq: 1, token: "flow.excalidraw:sel" });
    setRef({ itemId: secondItem.id, seq: 2, token: "flow.excalidraw:sel" });
    const ta = baseElement.querySelector<HTMLTextAreaElement>(".ai-composer-input")!;
    expect(ta.value).toBe("@flow.excalidraw:sel @flow.excalidraw:sel-2 ");
    // Each token still maps to ITS item: deleting the deduped one removes
    // only the second item.
    typeText(baseElement, "@flow.excalidraw:sel ");
    expect(onRemoveContext).toHaveBeenCalledTimes(1);
    expect(onRemoveContext).toHaveBeenCalledWith("excalidraw-selection:flow.excalidraw:e2");
  });
});

describe("AiPanel — slash commands (omp#1)", () => {
  const SLASH_COMMANDS: SlashCommandDef[] = [
    {
      description: "Explain a topic",
      name: "explain",
      source: "builtin",
      template: "Explain this:\n\n$ARGUMENTS",
    },
    {
      description: "Summarize the conversation",
      name: "summarize",
      source: "project",
      template: "Summarize the conversation.",
    },
  ];

  function typeIntoComposer(baseElement: HTMLElement, value: string): HTMLTextAreaElement {
    const ta = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    ta.value = value;
    ta.setSelectionRange(value.length, value.length);
    fireEvent.input(ta);
    return ta;
  }

  it("shows the list for a leading '/', filters by prefix, and inserts '/name ' on click", () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    typeIntoComposer(baseElement, "/");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(2);
    const ta = typeIntoComposer(baseElement, "/ex");
    const items = baseElement.querySelectorAll(".ai-slash-item");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("/explain");
    expect(items[0]!.textContent).toContain("Explain a topic");
    fireEvent.mouseDown(items[0]!);
    // The typed "/ex" prefix is replaced by the full command + a trailing
    // space, and the list closes (focus stays in the composer).
    expect(ta.value).toBe("/explain ");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
  });

  it("only triggers when the slash is the very first character with no whitespace yet", () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    typeIntoComposer(baseElement, "hi /ex");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
    typeIntoComposer(baseElement, "/explain now");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
  });

  it("arrow keys move the highlight and Enter inserts the highlighted command", () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    const ta = typeIntoComposer(baseElement, "/");
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(baseElement.querySelector(".ai-mention-item-active")?.textContent).toContain(
      "/summarize",
    );
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(ta.value).toBe("/summarize ");
    // Enter consumed by the list — nothing was sent.
    expect(store.messages()).toHaveLength(0);
  });

  it("Escape closes the list without touching the composer text", () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    const ta = typeIntoComposer(baseElement, "/su");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(1);
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
    expect(ta.value).toBe("/su");
  });

  it("submit expands $ARGUMENTS with the typed arguments", async () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    const ta = typeIntoComposer(baseElement, "/explain how panes work");
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => {
      expect(store.messages()[0]?.content).toBe("Explain this:\n\nhow panes work");
    });
    expect(ta.value).toBe("");
  });

  it("a template without $ARGUMENTS gets free arguments appended after a blank line", async () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    const ta = typeIntoComposer(baseElement, "/summarize focus on risks");
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => {
      expect(store.messages()[0]?.content).toBe(
        "Summarize the conversation.\n\nfocus on risks",
      );
    });
  });

  it("an unknown command passes through as raw text", async () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    const ta = typeIntoComposer(baseElement, "/nope do it");
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => {
      expect(store.messages()[0]?.content).toBe("/nope do it");
    });
  });

  it("closes the open list when the store prop swaps (chat switch resets the draft)", async () => {
    const [store, setStore] = createSignal(readyStore());
    const { baseElement } = render(() => <AiPanel store={store()} slashCommands={SLASH_COMMANDS} />);
    typeIntoComposer(baseElement, "/");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(2);
    // The panel is one instance fed the ACTIVE session's store — switching
    // chats must drop the previous draft's popover too, or it would keep
    // capturing Enter over the new chat's empty composer.
    setStore(readyStore());
    await waitFor(() => {
      expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
    });
    const ta = baseElement.querySelector(".ai-composer-input") as HTMLTextAreaElement;
    expect(ta.value).toBe("");
  });

  it("closes the open list when the send button is clicked with a partial '/name' typed", async () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    typeIntoComposer(baseElement, "/su");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(1);
    // The send button bypasses the textarea's input event — the popover must
    // not linger over the streaming reply.
    fireEvent.click(baseElement.querySelector(".ai-send-btn:not(.ai-context-btn)") as HTMLElement);
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
    // "/su" matches no command, so it went through as raw text.
    await waitFor(() => {
      expect(store.messages()[0]?.content).toBe("/su");
    });
  });

  it("suppresses the '/' autocomplete while editing a turn (mentions stay active)", () => {
    const store = createAiChatStore({
      getProvider: () => createMockProvider({ reply: () => "x", chunkDelayMs: 0 }),
      initialMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ],
    });
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        mentionFiles={[{ label: "alpha.md", path: "a/alpha.md", rootId: "r" }]}
        slashCommands={SLASH_COMMANDS}
      />
    ));
    fireEvent.click(baseElement.querySelector('[aria-label="Edit and resend"]')!);
    expect(baseElement.querySelector(".ai-editing-bar")).not.toBeNull();
    // The edit submit path never expands commands, so "/" must not offer them.
    typeIntoComposer(baseElement, "/");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
    // Mentions are context chips — orthogonal to the send path — and stay on.
    typeIntoComposer(baseElement, "@al");
    expect(baseElement.querySelectorAll(".ai-mention-item")).toHaveLength(1);
  });

  it("clicking edit with the slash list open closes it, and Enter submits the edit", async () => {
    const store = createAiChatStore({
      getProvider: () => createMockProvider({ reply: () => "edited reply", chunkDelayMs: 0 }),
      initialMessages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ],
    });
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    const ta = typeIntoComposer(baseElement, "/su");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(1);
    // startEditing bypasses the textarea's input event — the popover belongs
    // to the abandoned "/su" draft and must close, or its Enter handler would
    // replace the loaded "q1" draft with "/summarize " instead of submitting.
    fireEvent.click(baseElement.querySelector('[aria-label="Edit and resend"]')!);
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
    expect(ta.value).toBe("q1");
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => {
      expect(store.messages()).toEqual([
        { role: "user", content: "q1" },
        { role: "assistant", content: "edited reply" },
      ]);
    });
    expect(ta.value).toBe("");
  });

  it("Shift+Enter with the slash list open falls through to newline (no selection)", () => {
    const store = readyStore();
    const { baseElement } = render(() => <AiPanel store={store} slashCommands={SLASH_COMMANDS} />);
    const ta = typeIntoComposer(baseElement, "/su");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(1);
    // Not cancelled: the popover branch lets Shift+Enter reach the browser's
    // default newline insertion instead of selecting the highlighted command.
    const reachedDefault = fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(reachedDefault).toBe(true);
    // No "/summarize " insertion happened, and nothing was sent.
    expect(ta.value).toBe("/su");
    expect(store.messages()).toHaveLength(0);
  });

  it("'@' mentions still work alongside slash commands (the lists never coexist)", () => {
    const store = readyStore();
    const onMention = vi.fn();
    const { baseElement } = render(() => (
      <AiPanel
        store={store}
        mentionFiles={[{ label: "alpha.md", path: "a/alpha.md", rootId: "r" }]}
        slashCommands={SLASH_COMMANDS}
        onMention={onMention}
      />
    ));
    typeIntoComposer(baseElement, "@al");
    expect(baseElement.querySelectorAll(".ai-mention-item:not(.ai-slash-item)")).toHaveLength(1);
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(0);
    typeIntoComposer(baseElement, "/su");
    expect(baseElement.querySelectorAll(".ai-slash-item")).toHaveLength(1);
    expect(baseElement.querySelectorAll(".ai-mention-item:not(.ai-slash-item)")).toHaveLength(0);
    // The mention path still resolves end-to-end.
    typeIntoComposer(baseElement, "@al");
    fireEvent.mouseDown(baseElement.querySelector(".ai-mention-item")!);
    expect(onMention).toHaveBeenCalledWith({ label: "alpha.md", path: "a/alpha.md", rootId: "r" });
  });
});
