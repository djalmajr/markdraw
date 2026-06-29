import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { SettingsDialog } from "./settings-dialog.tsx";
import { ConfirmDialog } from "./confirm-dialog.tsx";

afterEach(cleanup);

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", models: ["claude-sonnet-4-6"] },
  { id: "ollama", name: "Ollama (local)", models: [] },
];

function setup(overrides: Record<string, unknown> = {}) {
  const onTierChange = vi.fn();
  const onListModels = vi.fn(async () => ["m1", "m2"]);
  const onSaveProvider = vi.fn();
  // ConfirmDialog is mounted alongside (as the app shell does) so imperative
  // confirm() calls render a real in-DOM dialog the tests can interact with.
  const result = render(() => (
    <>
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
      <ConfirmDialog />
    </>
  ));
  return { ...result, onTierChange, onListModels, onSaveProvider };
}

describe("SettingsDialog", () => {
  it("renders the vertical nav and opens on the AI section (Manage models)", () => {
    const { baseElement } = setup();
    expect(baseElement.querySelectorAll('[role="tab"]').length).toBe(8);
    // The AI section opens on the OpenCode-style Manage models view.
    expect(baseElement.querySelector(".settings-models-search")).not.toBeNull();
    expect(baseElement.querySelector(".settings-provider-list")).toBeNull();
  });

  function openCatalog(baseElement: HTMLElement): void {
    fireEvent.click(baseElement.querySelector(".settings-models-search .ai-mp-icon-btn") as HTMLElement);
  }

  it("switches sections via the nav rail", () => {
    const { baseElement } = setup();
    const indexingTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /indexing/i.test(t.textContent ?? ""),
    );
    fireEvent.click(indexingTab!);
    expect(baseElement.querySelector(".settings-tiers")).not.toBeNull();
  });

  it("connect flow: catalog → provider → Continue fires onConnectProvider", () => {
    const onConnectProvider = vi.fn();
    const { baseElement } = setup({ onConnectProvider });
    openCatalog(baseElement);
    // The catalog lists the providers + a Custom entry.
    const row = [...baseElement.querySelectorAll(".settings-catalog-row")].find((r) =>
      /Anthropic/.test(r.textContent ?? ""),
    )!;
    fireEvent.click(row);
    // The per-provider sub-page has a single API-key field + Continue.
    const keyInput = baseElement.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(keyInput, { target: { value: "sk-x" } });
    const cont = [...baseElement.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Continue",
    )!;
    fireEvent.click(cont);
    expect(onConnectProvider).toHaveBeenCalledWith({ providerId: "anthropic", apiKey: "sk-x" });
  });

  it("catalog → back returns to Manage models", () => {
    const { baseElement } = setup();
    openCatalog(baseElement);
    expect(baseElement.querySelector(".settings-catalog")).not.toBeNull();
    fireEvent.click(baseElement.querySelector(".settings-back") as HTMLElement);
    expect(baseElement.querySelector(".settings-models-search")).not.toBeNull();
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

  it("Manage models: the edit icon opens the provider sub-page; Remove provider confirms then fires onRemoveProvider", async () => {
    const onRemoveProvider = vi.fn();
    const onToggleModel = vi.fn();
    const { baseElement } = setup({
      allModels: [
        {
          // Merged group: two provider ids behind one base name — remove must
          // receive BOTH (each model ref carries its own "provider/" prefix).
          id: "OpenCode Go",
          name: "OpenCode Go",
          models: [
            { value: "opencode-go/big-model", label: "Big Model" },
            { value: "opencode-go-chat/chat-model", label: "Chat Model" },
          ],
        },
        { id: "openai", name: "OpenAI", models: [{ value: "openai/gpt-4o", label: "GPT-4o" }] },
      ],
      hiddenModels: [],
      onRemoveProvider,
      onToggleModel,
    });
    // The header carries no remove button — just the name label, an edit
    // pencil, and the group toggle.
    expect(
      baseElement.querySelectorAll('.settings-models-group button[aria-label="Remove provider"]')
        .length,
    ).toBe(0);
    // The name is a plain label; the explicit pencil opens the sub-page.
    expect(baseElement.querySelectorAll("button.settings-models-group-name").length).toBe(0);
    const editBtn = [
      ...baseElement.querySelectorAll("button.ai-mp-icon-btn"),
    ].find((b) => /Edit provider: OpenCode Go/i.test(b.getAttribute("aria-label") ?? "")) as HTMLElement;
    fireEvent.click(editBtn);
    // Navigating via the pencil must not flip the group toggle.
    expect(onToggleModel).not.toHaveBeenCalled();
    // Provider sub-page: connect controls + the separated destructive action.
    expect(baseElement.querySelector('input[type="password"]')).not.toBeNull();
    const removeBtn = [...baseElement.querySelectorAll("button.settings-danger-btn")].find(
      (b) => (b.textContent ?? "").trim() === "Remove provider",
    ) as HTMLElement;
    expect(removeBtn).not.toBeUndefined();
    fireEvent.click(removeBtn);
    // The real ConfirmDialog (mounted by setup) opens in the DOM; confirm it.
    const confirmBtn = await waitFor(() => {
      const found = [...baseElement.querySelectorAll("button")].find(
        (b) => (b.textContent ?? "").trim() === "Confirm",
      );
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(onRemoveProvider).toHaveBeenCalledWith(["opencode-go", "opencode-go-chat"]);
    });
    // After removal the view returns to Manage models.
    await waitFor(() => {
      expect(baseElement.querySelector(".settings-models-search")).not.toBeNull();
    });
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

  it("Custom provider: catalog → Custom → fills the form and submits", () => {
    const onSaveCustomProvider = vi.fn();
    const { baseElement } = setup({ onSaveCustomProvider });
    openCatalog(baseElement);
    const customRow = [...baseElement.querySelectorAll(".settings-catalog-row")].find((r) =>
      /custom provider/i.test(r.textContent ?? ""),
    )!;
    fireEvent.click(customRow);
    const custom = baseElement.querySelector(".settings-custom") as HTMLElement;
    expect(custom).not.toBeNull();
    const inputs = custom.querySelectorAll("input");
    fireEvent.input(inputs[0]!, { target: { value: "myprov" } }); // id
    fireEvent.input(inputs[2]!, { target: { value: "https://api.x/v1" } }); // baseURL
    fireEvent.input(inputs[4]!, { target: { value: "m1" } }); // model id
    fireEvent.input(inputs[5]!, { target: { value: "Model One" } }); // model name
    const submit = [...custom.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Add provider",
    )!;
    fireEvent.click(submit);
    expect(onSaveCustomProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "myprov",
        baseURL: "https://api.x/v1",
        models: [{ id: "m1", name: "Model One" }],
      }),
    );
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

  it("Editor section: renders the editor toggles and fires their change handlers", () => {
    const onWrapTextChange = vi.fn();
    const { baseElement } = setup({ wrapText: true, onWrapTextChange });
    const editorTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /^Editor/.test(t.textContent ?? ""),
    );
    fireEvent.click(editorTab!);
    // The placeholder is gone — the section now carries the mirrored toolbar
    // toggles. Find the "Wrap text" row and flip its switch (currently on) →
    // the handler fires with false.
    const wrapRow = [...baseElement.querySelectorAll(".settings-row")].find((r) =>
      /Wrap text/.test(r.textContent ?? ""),
    );
    expect(wrapRow).not.toBeUndefined();
    const wrapSwitch = wrapRow!.querySelector('[role="switch"]') as HTMLElement;
    fireEvent.click(wrapSwitch);
    expect(onWrapTextChange).toHaveBeenCalledWith(false);
  });

  function openMcpSection(baseElement: HTMLElement) {
    const mcpTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /MCP/i.test(t.textContent ?? ""),
    );
    fireEvent.click(mcpTab!);
  }

  function openSkillsSection(baseElement: HTMLElement) {
    const skillsTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /Skills/i.test(t.textContent ?? ""),
    );
    fireEvent.click(skillsTab!);
  }

  it("renders discovered skills and opens a detail sub-page", () => {
    const longDescription =
      "Review changes before shipping with enough detail to require opening the skill detail page.";
    const { baseElement } = setup({
      skills: [
        {
          id: "skill:review",
          name: "review",
          description: longDescription,
          slashCommands: ["work-review"],
          scope: "project",
          sources: [
            {
              tool: "claude",
              scope: "global",
              path: "/home/.claude/skills/review/SKILL.md",
              active: false,
            },
            {
              tool: "codex",
              scope: "project",
              path: "/repo/.codex/skills/review/SKILL.md",
              active: true,
            },
          ],
        },
      ],
    });
    openSkillsSection(baseElement);
    expect(baseElement.textContent).toContain("Agent skills");
    expect(baseElement.textContent).not.toContain("settings_skills_title");
    expect(baseElement.textContent).not.toContain("settings_skills_desc");
    const card = baseElement.querySelector(".settings-mcp-card") as HTMLElement;
    expect(card.textContent).toContain("review");
    expect(card.textContent).toContain(longDescription);
    expect(card.textContent).toContain("Preferred source Codex");
    expect(baseElement.querySelectorAll(".settings-mcp-tool-chip")).toHaveLength(2);
    expect(card.tagName).toBe("BUTTON");

    fireEvent.click(card);
    expect(baseElement.textContent).toContain(longDescription);
    expect(baseElement.textContent).toContain("Slash commands");
    expect(baseElement.textContent).toContain("/work-review");
    expect(baseElement.textContent).toContain("/repo/.codex/skills/review/SKILL.md");

    fireEvent.click(baseElement.querySelector(".settings-back") as HTMLElement);
    expect(baseElement.textContent).toContain("Agent skills");
  });

  function openAddForm(baseElement: HTMLElement) {
    fireEvent.click(baseElement.querySelector(".settings-mcp-new-row") as HTMLElement);
  }

  it("renders the MCP add-server form (id field + transport select)", () => {
    const { baseElement } = setup();
    openMcpSection(baseElement);
    openAddForm(baseElement);
    // id field is the first settings input in the form
    expect(baseElement.querySelector(".settings-input.ai-composer-input")).not.toBeNull();
    // transport select uses the Kobalte listbox trigger
    expect(baseElement.querySelector('[aria-haspopup="listbox"]')).not.toBeNull();
  });

  it("the add form is collapsed until the New MCP Server row is clicked", () => {
    const { baseElement } = setup();
    openMcpSection(baseElement);
    expect(baseElement.querySelector(".settings-input.ai-composer-input")).toBeNull();
    const newRow = baseElement.querySelector(".settings-mcp-new-row") as HTMLElement;
    expect(newRow.textContent).toContain("New MCP Server");
    fireEvent.click(newRow);
    expect(baseElement.querySelector(".settings-input.ai-composer-input")).not.toBeNull();
  });

  it("the add view replaces the list (AI-style sub-page) and back returns discarding the draft", () => {
    const { baseElement } = setup();
    openMcpSection(baseElement);
    openAddForm(baseElement);
    // Sub-page: the list/new-row give way to the form + back header.
    expect(baseElement.querySelector(".settings-mcp-new-row")).toBeNull();
    const idInput = baseElement.querySelector(
      ".settings-input.ai-composer-input",
    ) as HTMLInputElement;
    fireEvent.input(idInput, { target: { value: "draft-id" } });
    fireEvent.click(baseElement.querySelector(".settings-back") as HTMLElement);
    // Back on the list view; reopening shows a clean form (draft discarded).
    expect(baseElement.querySelector(".settings-mcp-new-row")).not.toBeNull();
    openAddForm(baseElement);
    const reopened = baseElement.querySelector(
      ".settings-input.ai-composer-input",
    ) as HTMLInputElement;
    expect(reopened.value).toBe("");
  });

  it("filling id + selecting http transport + Add calls onSaveMcpServer with the right shape", async () => {
    const onSaveMcpServer = vi.fn();
    const { baseElement } = setup({ onSaveMcpServer });
    openMcpSection(baseElement);
    openAddForm(baseElement);
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
    const removeBtn = baseElement.querySelector(
      '.settings-mcp-card button[aria-label="Remove"]',
    ) as HTMLElement;
    fireEvent.click(removeBtn);
    expect(onRemoveMcpServer).toHaveBeenCalledWith("memory");
  });

  it("Authorize on a discovered MCP server calls onAuthorizeMcpServer with its id", () => {
    const onAuthorizeMcpServer = vi.fn();
    const { baseElement } = setup({
      onAuthorizeMcpServer,
      mcpServers: [
        {
          id: "discovered:memory",
          name: "memory-personal",
          transport: "http",
          enabled: true,
          connected: false,
          requiresAuth: true,
          url: "https://memory.example/mcp",
          discovered: { tools: ["claude", "codex"], scope: "global" },
        },
      ],
    });
    openMcpSection(baseElement);
    const authorize = [...baseElement.querySelectorAll("button")].find((button) =>
      /Authorize/.test(button.textContent ?? ""),
    ) as HTMLElement;
    fireEvent.click(authorize);
    expect(onAuthorizeMcpServer).toHaveBeenCalledWith("discovered:memory");
  });

  it("a stdio server card renders the name and the mono command subtitle", () => {
    const { baseElement } = setup({
      mcpServers: [
        {
          id: "memory",
          name: "Memory",
          transport: "stdio",
          enabled: true,
          connected: true,
          toolCount: 2,
          command: "bunx",
          args: ["@modelcontextprotocol/server-memory"],
        },
      ],
    });
    openMcpSection(baseElement);
    const card = baseElement.querySelector(".settings-mcp-card") as HTMLElement;
    expect(card.querySelector(".settings-mcp-card-name")?.textContent).toBe("Memory");
    expect(card.querySelector(".settings-mcp-cmd")?.textContent).toBe(
      "bunx @modelcontextprotocol/server-memory",
    );
    // Avatar shows the first letter of the name, with the status dot inside.
    const avatar = card.querySelector(".settings-mcp-avatar") as HTMLElement;
    expect(avatar.textContent).toContain("M");
    expect(avatar.querySelector(".settings-mcp-status-dot-connected")).not.toBeNull();
  });

  it("tool chips collapse past 6 and expand via Show more / Show less", () => {
    const tools = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
    const { baseElement } = setup({
      mcpServers: [
        {
          id: "search",
          transport: "http",
          enabled: true,
          connected: true,
          toolCount: tools.length,
          tools,
          url: "https://mcp.example.com",
        },
      ],
    });
    openMcpSection(baseElement);
    expect(baseElement.querySelectorAll(".settings-mcp-tool-chip").length).toBe(6);
    const toggle = baseElement.querySelector(".settings-mcp-show-toggle") as HTMLElement;
    expect(toggle.textContent).toContain("Show more (2)");
    fireEvent.click(toggle);
    expect(baseElement.querySelectorAll(".settings-mcp-tool-chip").length).toBe(8);
    expect(toggle.textContent).toContain("Show less");
    fireEvent.click(toggle);
    expect(baseElement.querySelectorAll(".settings-mcp-tool-chip").length).toBe(6);
  });
});
