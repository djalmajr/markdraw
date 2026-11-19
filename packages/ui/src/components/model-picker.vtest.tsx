import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
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
