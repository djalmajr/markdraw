import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { SettingsDialog } from "./settings-dialog.tsx";

afterEach(cleanup);

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", models: ["claude-sonnet-4-6"] },
  { id: "ollama", name: "Ollama (local)", models: [] },
];

function setup(overrides: Record<string, unknown> = {}) {
  const onTierChange = vi.fn();
  const onListModels = vi.fn(async () => ["m1", "m2"]);
  const onSaveProvider = vi.fn();
  const result = render(() => (
    <SettingsDialog
      open
      onClose={() => {}}
      aiProviders={PROVIDERS}
      selectedModel={null}
      indexingTier="lite"
      onTierChange={onTierChange}
      onListModels={onListModels as never}
      onSaveProvider={onSaveProvider as never}
      {...overrides}
    />
  ));
  return { ...result, onTierChange, onListModels, onSaveProvider };
}

describe("SettingsDialog", () => {
  it("renders the vertical nav and opens on the AI section", () => {
    const { baseElement } = setup();
    expect(baseElement.querySelectorAll('[role="tab"]').length).toBe(8);
    expect(baseElement.querySelector(".settings-provider-list")).not.toBeNull();
  });

  it("switches sections via the nav rail", () => {
    const { baseElement } = setup();
    const indexingTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /indexing/i.test(t.textContent ?? ""),
    );
    fireEvent.click(indexingTab!);
    expect(baseElement.querySelector(".settings-tiers")).not.toBeNull();
  });

  it("loads models for the selected provider", async () => {
    const { baseElement, onListModels } = setup();
    const loadBtn = [...baseElement.querySelectorAll("button")].find((b) =>
      /load/i.test(b.textContent ?? ""),
    );
    fireEvent.click(loadBtn!);
    await waitFor(() => expect(onListModels).toHaveBeenCalled());
    // Kobalte renders options into a portaled listbox only once opened.
    // The trigger opens on pointerdown (mouse, left button), not click.
    const trigger = baseElement.querySelector('[aria-haspopup="listbox"]') as HTMLElement;
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    await waitFor(() => {
      const opts = [...baseElement.querySelectorAll('[role="option"]')].map(
        (o) => o.textContent ?? "",
      );
      expect(opts).toContain("m1");
    });
  });

  it("saves the provider with key + selected model, then clears the key input", async () => {
    const { baseElement, onSaveProvider } = setup();
    const keyInput = baseElement.querySelector(
      ".settings-input.ai-composer-input",
    ) as HTMLInputElement;
    fireEvent.input(keyInput, { target: { value: "sk-test" } });
    // pick a model via the Kobalte Select (anthropic default has one):
    // open the trigger, then select the desired option in the portaled listbox.
    // Both opening and selecting are driven by pointerdown (mouse, left button).
    const trigger = baseElement.querySelector('[aria-haspopup="listbox"]') as HTMLElement;
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    const option = await waitFor(() => {
      const found = [...baseElement.querySelectorAll('[role="option"]')].find(
        (o) => (o.textContent ?? "").trim() === "claude-sonnet-4-6",
      );
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
    fireEvent.click(option);
    const saveBtn = [...baseElement.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Save",
    );
    fireEvent.click(saveBtn!);
    await waitFor(() => {
      expect(onSaveProvider).toHaveBeenCalledWith({
        providerId: "anthropic",
        apiKey: "sk-test",
        modelId: "claude-sonnet-4-6",
      });
    });
    expect(keyInput.value).toBe("");
  });

  it("Manage models: renders per-model toggles and fires onToggleModel", () => {
    const onToggleModel = vi.fn();
    const { baseElement } = setup({
      allModels: [
        { id: "openai", name: "OpenAI", models: [{ value: "openai/gpt-4o", label: "GPT-4o" }] },
      ],
      hiddenModels: [],
      onToggleModel,
    });
    const row = [...baseElement.querySelectorAll(".settings-models-row")].find((r) =>
      /GPT-4o/.test(r.textContent ?? ""),
    );
    expect(row).not.toBeUndefined();
    const sw = row!.querySelector('[role="switch"]') as HTMLElement;
    fireEvent.click(sw);
    expect(onToggleModel).toHaveBeenCalledWith("openai/gpt-4o");
  });

  it("Manage models: a provider header toggle flips all its models", () => {
    const onToggleModel = vi.fn();
    const { baseElement } = setup({
      allModels: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            { value: "openai/a", label: "A" },
            { value: "openai/b", label: "B" },
          ],
        },
      ],
      hiddenModels: [],
      onToggleModel,
    });
    const group = [...baseElement.querySelectorAll(".settings-models-group")].find((g) =>
      /OpenAI/i.test(g.textContent ?? ""),
    )!;
    fireEvent.click(group.querySelector('[role="switch"]') as HTMLElement);
    // All visible → the group toggle hides every model.
    expect(onToggleModel).toHaveBeenCalledWith("openai/a");
    expect(onToggleModel).toHaveBeenCalledWith("openai/b");
  });

  it("Manage models: the search box filters the list", () => {
    const { baseElement } = setup({
      allModels: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            { value: "openai/gpt", label: "GPT-4o" },
            { value: "openai/o1", label: "o1" },
          ],
        },
      ],
      hiddenModels: [],
      onToggleModel: vi.fn(),
    });
    const search = baseElement.querySelector(".settings-models-search input") as HTMLInputElement;
    fireEvent.input(search, { target: { value: "gpt" } });
    const rows = [...baseElement.querySelectorAll(".settings-models-row")].map((r) => r.textContent ?? "");
    expect(rows.some((t) => /GPT-4o/.test(t))).toBe(true);
    expect(rows.some((t) => /o1/.test(t))).toBe(false);
  });

  it("selecting a tier calls onTierChange", () => {
    const { baseElement, onTierChange } = setup();
    const indexingTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /indexing/i.test(t.textContent ?? ""),
    );
    fireEvent.click(indexingTab!);
    const offCard = [...baseElement.querySelectorAll('[role="radio"]')].find((c) =>
      /^Off/.test(c.textContent ?? ""),
    );
    fireEvent.click(offCard!);
    expect(onTierChange).toHaveBeenCalledWith("off");
  });

  function openMcpSection(baseElement: HTMLElement) {
    const mcpTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /MCP/i.test(t.textContent ?? ""),
    );
    fireEvent.click(mcpTab!);
  }

  it("renders the MCP add-server form (id field + transport select)", () => {
    const { baseElement } = setup();
    openMcpSection(baseElement);
    // id field is the first settings input in the form
    expect(baseElement.querySelector(".settings-input.ai-composer-input")).not.toBeNull();
    // transport select uses the Kobalte listbox trigger
    expect(baseElement.querySelector('[aria-haspopup="listbox"]')).not.toBeNull();
  });

  it("filling id + selecting http transport + Add calls onSaveMcpServer with the right shape", async () => {
    const onSaveMcpServer = vi.fn();
    const { baseElement } = setup({ onSaveMcpServer });
    openMcpSection(baseElement);
    const idInput = baseElement.querySelector(
      ".settings-input.ai-composer-input",
    ) as HTMLInputElement;
    fireEvent.input(idInput, { target: { value: "search" } });
    // open the transport Select and pick "http" (pointerdown drives Kobalte)
    const trigger = baseElement.querySelector('[aria-haspopup="listbox"]') as HTMLElement;
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    const httpOption = await waitFor(() => {
      const found = [...baseElement.querySelectorAll('[role="option"]')].find(
        (o) => (o.textContent ?? "").trim() === "http",
      );
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    fireEvent.pointerDown(httpOption, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(httpOption, { pointerType: "mouse", button: 0 });
    fireEvent.click(httpOption);
    // url field appears for http transport
    const urlInput = await waitFor(() => {
      const inputs = [
        ...baseElement.querySelectorAll(".settings-input.ai-composer-input"),
      ] as HTMLInputElement[];
      const found = inputs.find((i) => i.placeholder === "https://…");
      expect(found).toBeTruthy();
      return found as HTMLInputElement;
    });
    fireEvent.input(urlInput, { target: { value: "https://mcp.example.com" } });
    const addBtn = [...baseElement.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Add server",
    );
    fireEvent.click(addBtn!);
    await waitFor(() => {
      expect(onSaveMcpServer).toHaveBeenCalledWith({
        id: "search",
        enabled: true,
        transport: "http",
        url: "https://mcp.example.com",
      });
    });
  });

  it("Remove on a listed server calls onRemoveMcpServer with its id", () => {
    const onRemoveMcpServer = vi.fn();
    const { baseElement } = setup({
      onRemoveMcpServer,
      mcpServers: [
        {
          id: "memory",
          name: "Memory",
          transport: "stdio",
          enabled: true,
          connected: true,
          toolCount: 3,
        },
      ],
    });
    openMcpSection(baseElement);
    const removeBtn = [...baseElement.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Remove",
    );
    fireEvent.click(removeBtn!);
    expect(onRemoveMcpServer).toHaveBeenCalledWith("memory");
  });
});
