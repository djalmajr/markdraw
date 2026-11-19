import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@solidjs/testing-library";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { ModelPicker, type ModelGroup } from "./model-picker.tsx";

afterEach(cleanup);

const GROUPS: ModelGroup[] = [
  {
    id: "opencode",
    name: "OpenCode Go",
    models: [
      { value: "opencode/minimax-m3", label: "MiniMax M3" },
      { value: "opencode/qwen-max", label: "Qwen3.7 Max" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    models: [{ value: "openai/gpt-5", label: "GPT-5.4" }],
  },
];

function open(baseElement: HTMLElement): void {
  fireEvent.click(baseElement.querySelector(".ai-mp-trigger") as HTMLElement);
  flush();
}

describe("ModelPicker", () => {
  it("shows the current label on the trigger", () => {
    const { baseElement } = render(() => (
      <ModelPicker groups={GROUPS} current="opencode/minimax-m3" currentLabel="MiniMax M3" onSelect={() => {}} />
    ));
    expect((baseElement.querySelector(".ai-mp-trigger") as HTMLElement).textContent).toContain("MiniMax M3");
  });

  it("lists models grouped by provider and checks the current one", () => {
    const { baseElement } = render(() => (
      <ModelPicker groups={GROUPS} current="opencode/minimax-m3" currentLabel="MiniMax M3" onSelect={() => {}} />
    ));
    open(baseElement);
    // Scope to the list — the trigger pill also shows the current model label.
    const list = baseElement.querySelector(".ai-mp-list") as HTMLElement;
    expect(within(list).getByText("OpenCode Go")).not.toBeNull();
    expect(within(list).getByText("OpenAI")).not.toBeNull();
    expect(within(list).getByText("GPT-5.4")).not.toBeNull();
    const active = baseElement.querySelector(".ai-mp-row-active") as HTMLElement;
    expect(active).not.toBeNull();
    expect(active.textContent).toContain("MiniMax M3");
    expect(active.querySelector(".ai-mp-row-check")).not.toBeNull();
  });

  it("filters by the search query (label or provider name)", () => {
    const { baseElement } = render(() => (
      <ModelPicker groups={GROUPS} current="opencode/minimax-m3" currentLabel="MiniMax M3" onSelect={() => {}} />
    ));
    open(baseElement);
    const search = baseElement.querySelector(".ai-mp-search input") as HTMLInputElement;
    fireEvent.input(search, { target: { value: "gpt" } });
    flush();
    const list = baseElement.querySelector(".ai-mp-list") as HTMLElement;
    expect(within(list).getByText("GPT-5.4")).not.toBeNull();
    expect(within(list).queryByText("MiniMax M3")).toBeNull();
    expect(within(list).queryByText("OpenCode Go")).toBeNull(); // empty group hidden
  });

  it("fires onSelect with the model ref when a row is clicked", () => {
    const onSelect = vi.fn();
    const { baseElement } = render(() => (
      <ModelPicker groups={GROUPS} current="opencode/minimax-m3" currentLabel="MiniMax M3" onSelect={onSelect} />
    ));
    open(baseElement);
    fireEvent.click(screen.getByText("GPT-5.4"));
    flush();
    expect(onSelect).toHaveBeenCalledWith("openai/gpt-5");
  });

  it("shows a single manage button (⚙) and fires its callback", () => {
    const onManage = vi.fn();
    const { baseElement } = render(() => (
      <ModelPicker
        groups={GROUPS}
        current="opencode/minimax-m3"
        currentLabel="MiniMax M3"
        onSelect={() => {}}
        onManage={onManage}
      />
    ));
    open(baseElement);
    // The "+" connect button is gone — manage (Settings) is the single entry.
    expect(screen.queryByLabelText("Connect provider")).toBeNull();
    fireEvent.click(screen.getByLabelText("Manage models"));
    flush();
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("shows an empty message when a search matches nothing", () => {
    const { baseElement } = render(() => (
      <ModelPicker groups={GROUPS} current="" currentLabel="Select model" onSelect={() => {}} />
    ));
    open(baseElement);
    const search = baseElement.querySelector(".ai-mp-search input") as HTMLInputElement;
    fireEvent.input(search, { target: { value: "zzzzz" } });
    flush();
    expect(baseElement.querySelector(".ai-mp-empty")).not.toBeNull();
  });
});

describe("ModelPicker — refresh do provider atual", () => {
  const cacheInfo = {
    openai: { fetchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
  };

  function setup(overrides: Record<string, unknown> = {}) {
    const onRefreshModels = vi.fn(async () => {});
    const result = render(() => (
      <ModelPicker
        groups={GROUPS}
        current="openai/gpt-5"
        currentLabel="GPT-5.4"
        onSelect={() => {}}
        onRefreshModels={onRefreshModels as never}
        refreshableProviders={["openai"]}
        modelCacheInfo={cacheInfo}
        {...overrides}
      />
    ));
    open(result.baseElement);
    return { ...result, onRefreshModels };
  }

  it("só mostra o ícone para o provider conectado e com fonte", () => {
    const shown = setup();
    expect(shown.baseElement.querySelector("[data-model-refresh]")).not.toBeNull();
    cleanup();
    const hidden = setup({ refreshableProviders: ["opencode"] });
    expect(hidden.baseElement.querySelector("[data-model-refresh]")).toBeNull();
  });

  it("tem rótulo acessível com a ação e a última atualização", () => {
    const { baseElement } = setup();
    const button = baseElement.querySelector("[data-model-refresh]") as HTMLElement;
    expect(button.getAttribute("aria-label")).toContain("Refresh models");
    expect(button.getAttribute("aria-label")).toContain("Updated:");
    expect(button.getAttribute("title")).toBe(button.getAttribute("aria-label"));
  });

  it("clica e atualiza somente o provider do modelo atual", () => {
    const { baseElement, onRefreshModels } = setup();
    fireEvent.click(baseElement.querySelector("[data-model-refresh]") as HTMLElement);
    flush();
    expect(onRefreshModels).toHaveBeenCalledTimes(1);
    expect(onRefreshModels).toHaveBeenCalledWith(["openai"]);
  });

  it("mostra o estado girando enquanto atualiza e o remove ao terminar", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { baseElement } = setup({ onRefreshModels: () => pending });
    const button = baseElement.querySelector("[data-model-refresh]") as HTMLElement;
    fireEvent.click(button);
    flush();
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();
    expect(button.hasAttribute("disabled")).toBe(true);
    finish();
    await waitFor(() => expect(button.querySelector("svg.animate-spin")).toBeNull());
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("mostra erro curto, sem detalhe técnico nem chave", async () => {
    const { baseElement } = setup({
      onRefreshModels: () => Promise.reject(new Error("Authorization Bearer SECRET-TOKEN failed")),
    });
    fireEvent.click(baseElement.querySelector("[data-model-refresh]") as HTMLElement);
    await waitFor(() => expect(baseElement.querySelector(".ai-refresh-error")).not.toBeNull());
    const error = baseElement.querySelector(".ai-refresh-error") as HTMLElement;
    expect(error.textContent).toContain("Could not update the model list.");
    expect(error.textContent).not.toContain("SECRET-TOKEN");
  });
});
