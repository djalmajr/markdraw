import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { switchLocale } from "@markdraw/i18n/solid";
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
    flush();
  }

  it("switches sections via the nav rail", () => {
    const { baseElement } = setup();
    const indexingTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /indexing/i.test(t.textContent ?? ""),
    );
    fireEvent.click(indexingTab!);
    flush();
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
    flush();
    // The per-provider sub-page has a single API-key field + Continue.
    const keyInput = baseElement.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(keyInput, { target: { value: "sk-x" } });
    flush();
    const cont = [...baseElement.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Continue",
    )!;
    fireEvent.click(cont);
    flush();
    expect(onConnectProvider).toHaveBeenCalledWith({ providerId: "anthropic", apiKey: "sk-x" });
  });

  it("catalog → back returns to Manage models", () => {
    const { baseElement } = setup();
    openCatalog(baseElement);
    expect(baseElement.querySelector(".settings-catalog")).not.toBeNull();
    fireEvent.click(baseElement.querySelector(".settings-back") as HTMLElement);
    flush();
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
    flush();
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
    flush();
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
    flush();
    // Navigating via the pencil must not flip the group toggle.
    expect(onToggleModel).not.toHaveBeenCalled();
    // Provider sub-page: connect controls + the separated destructive action.
    expect(baseElement.querySelector('input[type="password"]')).not.toBeNull();
    const removeBtn = [...baseElement.querySelectorAll("button.settings-danger-btn")].find(
      (b) => (b.textContent ?? "").trim() === "Remove provider",
    ) as HTMLElement;
    expect(removeBtn).not.toBeUndefined();
    fireEvent.click(removeBtn);
    flush();
    // The real ConfirmDialog (mounted by setup) opens in the DOM; confirm it.
    const confirmBtn = await waitFor(() => {
      const found = [...baseElement.querySelectorAll("button")].find(
        (b) => (b.textContent ?? "").trim() === "Confirm",
      );
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    fireEvent.click(confirmBtn);
    flush();
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
    flush();
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
    flush();
    const custom = baseElement.querySelector(".settings-custom") as HTMLElement;
    expect(custom).not.toBeNull();
    const inputs = custom.querySelectorAll("input");
    fireEvent.input(inputs[0]!, { target: { value: "myprov" } }); // id
    flush();
    fireEvent.input(inputs[2]!, { target: { value: "https://api.x/v1" } }); // baseURL
    flush();
    fireEvent.input(inputs[4]!, { target: { value: "m1" } }); // model id
    flush();
    fireEvent.input(inputs[5]!, { target: { value: "Model One" } }); // model name
    flush();
    const submit = [...custom.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Add provider",
    )!;
    fireEvent.click(submit);
    flush();
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
    flush();
    const offCard = [...baseElement.querySelectorAll('[role="radio"]')].find((c) =>
      /^Off/.test(c.textContent ?? ""),
    );
    fireEvent.click(offCard!);
    flush();
    expect(onTierChange).toHaveBeenCalledWith("off");
  });

  it("Editor section: renders the editor toggles and fires their change handlers", () => {
    const onWrapTextChange = vi.fn();
    const { baseElement } = setup({ wrapText: true, onWrapTextChange });
    const editorTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /^Editor/.test(t.textContent ?? ""),
    );
    fireEvent.click(editorTab!);
    flush();
    // The placeholder is gone — the section now carries the mirrored toolbar
    // toggles. Find the "Wrap text" row and flip its switch (currently on) →
    // the handler fires with false.
    const wrapRow = [...baseElement.querySelectorAll(".settings-row")].find((r) =>
      /Wrap text/.test(r.textContent ?? ""),
    );
    expect(wrapRow).not.toBeUndefined();
    const wrapSwitch = wrapRow!.querySelector('[role="switch"]') as HTMLElement;
    fireEvent.click(wrapSwitch);
    flush();
    expect(onWrapTextChange).toHaveBeenCalledWith(false);
  });

  function openMcpSection(baseElement: HTMLElement) {
    const mcpTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /MCP/i.test(t.textContent ?? ""),
    );
    fireEvent.click(mcpTab!);
    flush();
  }

  function openSkillsSection(baseElement: HTMLElement) {
    const skillsTab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
      /Skills/i.test(t.textContent ?? ""),
    );
    fireEvent.click(skillsTab!);
    flush();
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
    flush();
    expect(baseElement.textContent).toContain(longDescription);
    expect(baseElement.textContent).toContain("Slash commands");
    expect(baseElement.textContent).toContain("/work-review");
    expect(baseElement.textContent).toContain("/repo/.codex/skills/review/SKILL.md");

    fireEvent.click(baseElement.querySelector(".settings-back") as HTMLElement);
    flush();
    expect(baseElement.textContent).toContain("Agent skills");
  });

  function openAddForm(baseElement: HTMLElement) {
    fireEvent.click(baseElement.querySelector(".settings-mcp-new-row") as HTMLElement);
    flush();
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
    flush();
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
    flush();
    fireEvent.click(baseElement.querySelector(".settings-back") as HTMLElement);
    flush();
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
    flush();
    // open the transport Select and pick "http" (pointerdown drives Kobalte)
    const trigger = baseElement.querySelector('[aria-haspopup="listbox"]') as HTMLElement;
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    flush();
    const httpOption = await waitFor(() => {
      const found = [...baseElement.querySelectorAll('[role="option"]')].find(
        (o) => (o.textContent ?? "").trim() === "http",
      );
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    fireEvent.pointerDown(httpOption, { pointerType: "mouse", button: 0 });
    flush();
    fireEvent.pointerUp(httpOption, { pointerType: "mouse", button: 0 });
    flush();
    fireEvent.click(httpOption);
    flush();
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
    flush();
    const addBtn = [...baseElement.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Add server",
    );
    fireEvent.click(addBtn!);
    flush();
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
    flush();
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
    flush();
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

  describe("Manage models — refresh por provider", () => {
    const allModels = [
      {
        id: "openai",
        name: "OpenAI",
        models: [{ value: "openai/gpt-5", label: "GPT-5" }],
      },
    ];
    const cacheInfo = {
      openai: { fetchedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
    };

    it("mostra o ícone só para grupos conectados com fonte, com rótulo e tooltip", () => {
      const { baseElement } = setup({
        allModels: [
          ...allModels,
          {
            id: "anthropic",
            name: "Anthropic",
            models: [{ value: "anthropic/claude", label: "Claude" }],
          },
        ],
        refreshableProviders: ["openai"],
        modelCacheInfo: cacheInfo,
      });
      const icons = baseElement.querySelectorAll("[data-group-refresh]");
      expect(icons.length).toBe(1);
      const icon = icons[0] as HTMLElement;
      expect(icon.getAttribute("data-group-refresh")).toBe("openai");
      expect(icon.getAttribute("aria-label")).toContain("Refresh models");
      expect(icon.getAttribute("aria-label")).toContain("Updated:");
      expect(icon.getAttribute("title")).toBe(icon.getAttribute("aria-label"));
    });

    it("o clique passa todos os ids do grupo (OpenCode Go)", () => {
      const onRefreshModels = vi.fn(async () => {});
      const { baseElement } = setup({
        allModels: [
          {
            id: "opencode",
            name: "OpenCode Go",
            models: [
              { value: "opencode-go/claude", label: "Claude" },
              { value: "opencode-go-chat/glm", label: "GLM" },
            ],
          },
        ],
        refreshableProviders: ["opencode-go", "opencode-go-chat"],
        onRefreshModels: onRefreshModels as never,
      });
      fireEvent.click(baseElement.querySelector("[data-group-refresh]") as HTMLElement);
      flush();
      expect(onRefreshModels).toHaveBeenCalledTimes(1);
      expect(onRefreshModels).toHaveBeenCalledWith(["opencode-go", "opencode-go-chat"]);
    });

    it("gira enquanto atualiza e mostra erro curto sem detalhe técnico", async () => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const onRefreshModels = vi.fn(() => pending);
      const { baseElement } = setup({
        allModels,
        refreshableProviders: ["openai"],
        onRefreshModels: onRefreshModels as never,
      });
      const icon = baseElement.querySelector("[data-group-refresh]") as HTMLElement;
      fireEvent.click(icon);
      flush();
      expect(icon.querySelector("svg.animate-spin")).not.toBeNull();
      expect(icon.hasAttribute("disabled")).toBe(true);
      finish();
      await waitFor(() => expect(icon.querySelector("svg.animate-spin")).toBeNull());
      expect(baseElement.querySelector(".ai-refresh-error")).toBeNull();

      // Segundo clique: falha com um erro que tenta carregar uma chave.
      onRefreshModels.mockImplementationOnce(() =>
        Promise.reject(new Error("Authorization Bearer SECRET-TOKEN failed")),
      );
      fireEvent.click(icon);
      await waitFor(() => expect(baseElement.querySelector(".ai-refresh-error")).not.toBeNull());
      const error = baseElement.querySelector(".ai-refresh-error") as HTMLElement;
      expect(error.textContent).toContain("Could not update the model list.");
      expect(error.textContent).not.toContain("SECRET-TOKEN");
      expect(icon.querySelector("svg.animate-spin")).toBeNull();
    });

    it("o botão de texto Refresh da sub-página usa o mesmo handler", () => {
      const onRefreshModels = vi.fn(async () => {});
      const { baseElement } = setup({
        allModels,
        refreshableProviders: ["openai"],
        onRefreshModels: onRefreshModels as never,
      });
      const edit = [...baseElement.querySelectorAll(".settings-models-group button")].find((b) =>
        (b.getAttribute("aria-label") ?? "").startsWith("Edit provider"),
      ) as HTMLElement;
      fireEvent.click(edit);
      flush();
      const textButton = [...baseElement.querySelectorAll("button")].find(
        (b) => (b.textContent ?? "").trim() === "Refresh models",
      ) as HTMLElement;
      expect(textButton).not.toBeUndefined();
      fireEvent.click(textButton);
      flush();
      expect(onRefreshModels).toHaveBeenCalledWith(["openai"]);
    });
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
    flush();
    expect(baseElement.querySelectorAll(".settings-mcp-tool-chip").length).toBe(8);
    expect(toggle.textContent).toContain("Show less");
    fireEvent.click(toggle);
    flush();
    expect(baseElement.querySelectorAll(".settings-mcp-tool-chip").length).toBe(6);
  });

  describe("Servidor MCP do Markdraw — máscara de segredos", () => {
    function maskSwitch(baseElement: HTMLElement): HTMLElement {
      const found = [...baseElement.querySelectorAll('[role="switch"]')].find(
        (s) => s.getAttribute("aria-label") === "Mask secrets",
      );
      expect(found, "switch named Mask secrets").toBeTruthy();
      return found as HTMLElement;
    }

    function confirmDialog(baseElement: HTMLElement): HTMLElement | null {
      return (
        [...baseElement.querySelectorAll('[data-slot="alert-dialog-content"]')].find((el) =>
          (el.textContent ?? "").includes("Turn off secret masking?"),
        ) ?? null
      );
    }

    function deferredSetter() {
      let resolve!: () => void;
      const setter = vi.fn(
        (_value: boolean) =>
          new Promise<void>((r) => {
            resolve = r;
          }),
      );
      return { setter, resolve: () => resolve() };
    }

    it("começa mascarado e separa o servidor externo dos servidores do assistente", () => {
      const { baseElement } = setup();
      openMcpSection(baseElement);
      expect(baseElement.textContent).toContain("Markdraw MCP server");
      expect(baseElement.textContent).toContain("MCP servers");
      expect(maskSwitch(baseElement).getAttribute("aria-checked")).toBe("true");
      expect(baseElement.querySelector('[role="status"]')).toBeNull();
    });

    it("mostra o estado salvo falso e o aviso permanente", () => {
      const { baseElement } = setup({
        mcpServerMaskSecrets: false,
        onSetMcpServerMaskSecrets: vi.fn(async () => {}),
      });
      openMcpSection(baseElement);
      expect(maskSwitch(baseElement).getAttribute("aria-checked")).toBe("false");
      expect(baseElement.querySelector('[role="status"]')?.textContent).toBe(
        "Secret masking is off",
      );
    });

    it("desligar chama o handler sem diálogo próprio: a confirmação é a nativa", async () => {
      const setter = vi.fn(async () => {});
      const { baseElement } = setup({
        mcpServerMaskSecrets: true,
        onSetMcpServerMaskSecrets: setter,
      });
      openMcpSection(baseElement);
      fireEvent.click(maskSwitch(baseElement));
      flush();
      expect(confirmDialog(baseElement)).toBeNull();
      await waitFor(() => {
        expect(setter).toHaveBeenCalledWith(false);
      });
    });

    it("desligar só vale quando a promessa resolve, com o controle desabilitado no meio", async () => {
      const { setter, resolve } = deferredSetter();
      const { baseElement } = setup({
        mcpServerMaskSecrets: true,
        onSetMcpServerMaskSecrets: setter,
      });
      openMcpSection(baseElement);
      fireEvent.click(maskSwitch(baseElement));
      flush();
      await waitFor(() => {
        expect(setter).toHaveBeenCalledWith(false);
      });
      expect(maskSwitch(baseElement).getAttribute("aria-checked")).toBe("true");
      const pending = maskSwitch(baseElement);
      expect(
        pending.hasAttribute("disabled") || pending.getAttribute("aria-disabled") === "true",
      ).toBe(true);
      expect(baseElement.querySelector('[role="status"]')).toBeNull();
      resolve();
      await waitFor(() => {
        expect(maskSwitch(baseElement).getAttribute("aria-checked")).toBe("false");
      });
      expect(baseElement.querySelector('[role="status"]')?.textContent).toBe(
        "Secret masking is off",
      );
    });

    it("cancelar o diálogo nativo (resultado declined) mantém a chave ligada, sem erro", async () => {
      for (const reason of ["declined", new Error("declined")]) {
        const setter = vi.fn(async () => {
          throw reason;
        });
        const { baseElement } = setup({
          mcpServerMaskSecrets: true,
          onSetMcpServerMaskSecrets: setter,
        });
        openMcpSection(baseElement);
        fireEvent.click(maskSwitch(baseElement));
        flush();
        await waitFor(() => {
          expect(setter).toHaveBeenCalledWith(false);
        });
        await waitFor(() => {
          const control = maskSwitch(baseElement);
          expect(control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true").toBe(false);
        });
        expect(maskSwitch(baseElement).getAttribute("aria-checked")).toBe("true");
        expect(baseElement.querySelector('[role="alert"]')).toBeNull();
        expect(baseElement.querySelector('[role="status"]')).toBeNull();
        cleanup();
      }
    });

    it("ligar não pede confirmação e espera a promessa", async () => {
      const { setter, resolve } = deferredSetter();
      const { baseElement } = setup({
        mcpServerMaskSecrets: false,
        onSetMcpServerMaskSecrets: setter,
      });
      openMcpSection(baseElement);
      fireEvent.click(maskSwitch(baseElement));
      flush();
      expect(setter).toHaveBeenCalledWith(true);
      expect(confirmDialog(baseElement)).toBeNull();
      expect(maskSwitch(baseElement).getAttribute("aria-checked")).toBe("false");
      resolve();
      await waitFor(() => {
        expect(maskSwitch(baseElement).getAttribute("aria-checked")).toBe("true");
      });
      expect(baseElement.querySelector('[role="status"]')).toBeNull();
    });

    it("uma falha real volta ao estado anterior e mostra erro curto", async () => {
      const setter = vi.fn(async () => {
        throw new Error("ipc failed");
      });
      const { baseElement } = setup({
        mcpServerMaskSecrets: true,
        onSetMcpServerMaskSecrets: setter,
      });
      openMcpSection(baseElement);
      fireEvent.click(maskSwitch(baseElement));
      flush();
      await waitFor(() => {
        expect(baseElement.querySelector('[role="alert"]')?.textContent).toBe(
          "Could not change secret masking.",
        );
      });
      expect(maskSwitch(baseElement).getAttribute("aria-checked")).toBe("true");
      expect(baseElement.querySelector('[role="status"]')).toBeNull();
    });
  });
});

function openAppearance(baseElement: HTMLElement): void {
  const tab = [...baseElement.querySelectorAll('[role="tab"]')].find((t) =>
    /appearance/i.test(t.textContent ?? ""),
  );
  fireEvent.click(tab!);
  flush();
}

function withPlatform<T>(platform: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(navigator, "platform", original);
    else Reflect.deleteProperty(navigator, "platform");
  }
}

describe("SettingsDialog — tray icon toggle", () => {
  const PLATFORMS = [
    {
      name: "macOS",
      platform: "MacIntel",
      label: "Show icon in the menu bar",
      description: "Without the icon, closing the window hides it and Markdraw stays in the Dock.",
    },
    {
      name: "Windows",
      platform: "Win32",
      label: "Show icon in the notification area",
      description: "Without the icon, closing the window minimizes it.",
    },
    {
      name: "Linux",
      platform: "Linux x86_64",
      label: "Show icon in the system tray",
      description: "Without the icon, closing the window minimizes it.",
    },
  ];

  it("is hidden when the host does not pass the props (extension)", () => {
    const { baseElement } = setup();
    openAppearance(baseElement);
    expect(baseElement.textContent).not.toContain("Show icon in");
    expect(baseElement.querySelector('[data-slot="field-label"]')).toBeNull();
  });

  for (const item of PLATFORMS) {
    it(`uses the ${item.name} label and calls the handler`, () => {
      const onShowTrayIconChange = vi.fn();
      withPlatform(item.platform, () => {
        const { baseElement } = setup({
          showTrayIcon: true,
          onShowTrayIconChange,
        });
        openAppearance(baseElement);
        expect(baseElement.textContent).toContain("Window");
        expect(baseElement.textContent).toContain(item.label);
        expect(baseElement.textContent).toContain(item.description);
        const fieldLabel = [...baseElement.querySelectorAll<HTMLLabelElement>('[data-slot="field-label"]')]
          .find((element) => element.textContent?.trim() === item.label);
        expect(fieldLabel).toBeDefined();
        const control = baseElement.querySelector<HTMLElement>(
          `[role="switch"][id="${fieldLabel!.getAttribute("for")}"]`,
        );
        expect(control).not.toBeNull();
        expect(control!.getAttribute("aria-checked")).toBe("true");
        fireEvent.click(control!);
        flush();
        expect(onShowTrayIconChange).toHaveBeenCalledWith(false);
      });
    });
  }

  it("keeps the accessible name and description associated across locale changes", () => {
    withPlatform("MacIntel", () => {
      try {
        switchLocale("en");
        flush();
        const { baseElement } = setup({ showTrayIcon: true, onShowTrayIconChange: vi.fn() });
        openAppearance(baseElement);
        const labelElement = baseElement.querySelector<HTMLLabelElement>('[data-slot="field-label"]')!;
        const description = baseElement.querySelector<HTMLElement>('[data-slot="field-description"]')!;
        const control = baseElement.querySelector<HTMLElement>(
          `[role="switch"][id="${labelElement.getAttribute("for")}"]`,
        )!;
        expect(labelElement.control).toBe(control);
        expect(control.getAttribute("aria-labelledby")).toBe(labelElement.id);
        expect(control.getAttribute("aria-describedby")).toBe(description.id);
        expect(labelElement.textContent).toContain("Show icon in the menu bar");

        for (const [locale, labelText, descriptionText] of [
          ["pt-BR", "Mostrar ícone na barra de menus", "Sem o ícone, fechar a janela a esconde e o Markdraw continua no Dock."],
          ["es", "Mostrar icono en la barra de menús", "Sin el icono, cerrar la ventana la oculta y Markdraw sigue en el Dock."],
        ] as const) {
          switchLocale(locale);
          flush();
          expect(labelElement.textContent).toContain(labelText);
          expect(description.textContent).toContain(descriptionText);
          expect(control.getAttribute("aria-labelledby")).toBe(labelElement.id);
          expect(control.getAttribute("aria-describedby")).toBe(description.id);
          expect(control.getAttribute("aria-label")).toBeNull();
        }
      } finally {
        switchLocale("en");
        flush();
      }
    });
  });
});
