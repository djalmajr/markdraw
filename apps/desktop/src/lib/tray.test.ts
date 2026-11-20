import { afterEach, describe, expect, it, mock } from "bun:test";
import type { InvokeArgs } from "./chaos-invoke.ts";
import { createTrayPreferenceSync, setupTrayWithRuntime } from "./tray.ts";
import type { TrayTheme } from "./tray-icon.ts";

interface Call {
  command: string;
  args?: InvokeArgs;
}

function pause() {
  let start!: () => void;
  let resume!: () => void;
  let pending = true;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  return {
    started,
    resume,
    async wait() {
      if (!pending) return;
      pending = false;
      start();
      await released;
    },
  };
}

let disposeFixture: (() => Promise<void>) | undefined;

function fixture(platform = "Linux x86_64") {
  const calls: Call[] = [];
  const icons = new Set<number>();
  const menus = new Set<number>();
  const images = new Set<number>();
  const closed = new Set<number>();
  const unlistens: string[] = [];
  const invalidUpdates: number[] = [];
  const listeners = new Set<(theme: TrayTheme) => void>();
  const errors: unknown[] = [];
  let trayRid: number | undefined;
  let nextRid = 1;
  let available = false;
  let visible = true;
  let minimized = false;
  let failNextTray = false;
  let showHideAction: (() => void) | undefined;
  let setupPause: ReturnType<typeof pause> | undefined;
  let hidePause: ReturnType<typeof pause> | undefined;
  let visibilityPause: ReturnType<typeof pause> | undefined;

  const resource = (live: Set<number>) => {
    const rid = nextRid++;
    live.add(rid);
    return {
      rid,
      async close() {
        closed.add(rid);
        live.delete(rid);
      },
    };
  };

  const runtime: Parameters<typeof setupTrayWithRuntime>[1] = {
    platform,
    async invoke<T>(command: string, args?: InvokeArgs) {
      calls.push({ command, args });
      if (command === "system_theme") return "light" as T;
      if (command === "hide_main_window") {
        await hidePause?.wait();
        visible = false;
      }
      if (command === "show_main_window") visible = true;
      return undefined as T;
    },
    getCurrentWindow: () => ({
      async isVisible() {
        calls.push({ command: "plugin:window|is_visible" });
        const result = visible;
        await visibilityPause?.wait();
        return result;
      },
      async isMinimized() { return minimized; },
      async setFocus() {},
      async minimize() {
        calls.push({ command: "plugin:window|minimize" });
        minimized = true;
        visible = false;
      },
    }),
    async removeTray(id) {
      calls.push({ command: "plugin:tray|remove_by_id", args: { id } });
      if (trayRid !== undefined) icons.delete(trayRid);
      trayRid = undefined;
    },
    async createItem(options) {
      if (options.id === "tray-show-hide") {
        showHideAction = () => options.action?.("tray-show-hide");
      }
      return resource(menus);
    },
    async createSeparator() { return resource(menus); },
    async createMenu() { return resource(menus); },
    async createImage() { return resource(images); },
    async createTray() {
      if (failNextTray) {
        failNextTray = false;
        throw new Error("synthetic tray creation failure");
      }
      await setupPause?.wait();
      const icon = resource(icons);
      const { rid } = icon;
      trayRid = rid;
      calls.push({ command: "plugin:tray|new", args: { rid } });

      const update = (command: string) => {
        if (!icons.has(rid)) {
          invalidUpdates.push(rid);
          throw new Error("retired tray resource");
        }
        calls.push({ command, args: { rid } });
      };
      return {
        ...icon,
        async setTempDirPath() { update("plugin:tray|set_temp_dir_path"); },
        async setIcon() { update("plugin:tray|set_icon"); },
      };
    },
    runtimeDir: async () => "/fixture",
    appCacheDir: async () => "/fixture",
    async listenForTheme(listener) {
      listeners.add(listener);
      return () => {
        unlistens.push("system-theme-changed");
        listeners.delete(listener);
      };
    },
    async exit() {},
  };

  const sync = createTrayPreferenceSync({
    isDev: false,
    isTrayAvailable: () => available,
    setup: () => setupTrayWithRuntime({
      onOpenFolder() {},
      hideWindow: () => sync.hideWindow(),
    }, runtime),
    onAvailabilityChange(value) { available = value; },
    onError(error) { errors.push(error); },
  }, runtime);

  disposeFixture = async () => {
    setupPause?.resume();
    hidePause?.resume();
    visibilityPause?.resume();
    await sync.sync(false);
  };

  return {
    sync,
    runtime,
    get available() { return available; },
    get visible() { return visible; },
    get minimized() { return minimized; },
    get commands() { return calls.map((call) => call.command); },
    calls, icons, menus, images, closed, unlistens, invalidUpdates, errors, listeners,
    failNextSetup() { failNextTray = true; },
    waitForSetupStart() { return (setupPause = pause()).started; },
    releaseSetup() { setupPause?.resume(); },
    waitForHideStart() { return (hidePause = pause()).started; },
    releaseHide() { hidePause?.resume(); },
    waitForVisibilityRead() { return (visibilityPause = pause()).started; },
    releaseVisibility() { visibilityPause?.resume(); },
    async triggerShowHide() {
      expect(showHideAction).toBeDefined();
      await showHideAction!();
    },
    async themeChange(theme: TrayTheme = "dark") {
      for (const listener of listeners) listener(theme);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

afterEach(async () => {
  await disposeFixture?.();
  disposeFixture = undefined;
});

describe("ciclo de vida do tray", () => {
  it("descarta o ciclo quando o setup falha no meio", async () => {
    const t = fixture("Linux x86_64");
    t.failNextSetup();

    await t.sync.sync(true);

    expect(t.available).toBe(false);
    expect(t.errors).toHaveLength(1);
    expect(t.icons.size).toBe(0);
    expect(t.menus.size).toBe(0);
    expect(t.images.size).toBe(0);
    expect(t.closed.size).toBeGreaterThanOrEqual(6);
    expect(t.unlistens).toHaveLength(0);
  });

  it("descarga o listener, as imagens pendentes e os recursos ao desligar", async () => {
    const t = fixture("Linux x86_64");
    await t.sync.sync(true);
    await t.themeChange("dark");
    await t.themeChange("light");
    const updatesWhileOn = t.commands.filter((command) => command === "plugin:tray|set_icon").length;
    expect(updatesWhileOn).toBe(2);

    await t.sync.sync(false);
    const commandsAfterOff = t.commands.length;
    await t.themeChange("light");
    await t.themeChange("dark");

    expect(t.unlistens).toEqual(["system-theme-changed"]);
    expect(t.commands.slice(commandsAfterOff)).not.toContain("plugin:tray|set_icon");
    expect(t.invalidUpdates).toEqual([]);
    expect(t.icons.size).toBe(0);
    expect(t.menus.size).toBe(0);
    expect(t.images.size).toBe(0);
    expect(t.closed.size).toBeGreaterThanOrEqual(8);
  });

  it("desfaz um setup pendente quando o desligamento chega antes dele", async () => {
    const t = fixture("Linux x86_64");
    const started = t.waitForSetupStart();
    const enabling = t.sync.sync(true);
    await started;
    expect(t.available).toBe(false);

    const disabling = t.sync.sync(false);
    t.releaseSetup();
    await Promise.all([enabling, disabling]);

    expect(t.available).toBe(false);
    expect(t.icons.size).toBe(0);
    expect(t.menus.size).toBe(0);
    expect(t.images.size).toBe(0);
    expect(t.commands).toContain("plugin:tray|remove_by_id");
  });

  it("descarta o ciclo antigo quando um novo ligamento chega durante o setup", async () => {
    const t = fixture("Linux x86_64");
    const started = t.waitForSetupStart();
    const first = t.sync.sync(true);
    await started;

    const second = t.sync.sync(true);
    t.releaseSetup();
    await Promise.all([first, second]);

    expect(t.available).toBe(true);
    expect(t.icons.size).toBe(1);
    expect(t.menus.size).toBe(6);
    expect(t.images.size).toBe(1);
    expect(t.unlistens).toHaveLength(1);
  });

  it("religa depois de uma rejeição sem deixar disponibilidade falsa", async () => {
    const t = fixture("Linux x86_64");
    t.failNextSetup();
    await t.sync.sync(true);
    expect(t.available).toBe(false);
    expect(t.errors).toHaveLength(1);

    await t.sync.sync(true);

    expect(t.available).toBe(true);
    expect(t.errors).toHaveLength(1);
    expect(t.icons.size).toBe(1);
  });

  it("reaproveita o ciclo ativo ao desligar e religar durante o Show/Hide", async () => {
    const t = fixture();
    await t.sync.sync(true);
    const started = t.waitForHideStart();
    const hiding = t.triggerShowHide();
    await started;

    const disabling = t.sync.sync(false);
    const enabling = t.sync.sync(true);
    t.releaseHide();
    await Promise.all([hiding, disabling, enabling]);

    expect(t.available).toBe(true);
    expect(t.commands.filter((command) => command === "plugin:tray|new")).toHaveLength(1);
    expect(t.icons.size).toBe(1);
    expect(t.menus.size).toBe(6);
    expect(t.images.size).toBe(1);
    expect(t.listeners.size).toBe(1);
    await t.themeChange();
    expect(t.commands.filter((command) => command === "plugin:tray|set_icon")).toHaveLength(1);

    await t.sync.sync(false);
    const afterDisable = t.calls.length;
    await t.themeChange("light");
    expect(t.calls).toHaveLength(afterDisable);
    expect(t.invalidUpdates).toEqual([]);
    expect(t.unlistens).toEqual(["system-theme-changed"]);
    expect(t.listeners.size).toBe(0);
    expect(t.icons.size).toBe(0);
    expect(t.menus.size).toBe(0);
    expect(t.images.size).toBe(0);
  });

  it("não cria nem remove tray em dev", async () => {
    const t = fixture();
    const setup = mock(async () => ({ dispose: mock(async () => {}) }));
    const devSync = createTrayPreferenceSync({
      isDev: true,
      isTrayAvailable: () => false,
      setup,
      onAvailabilityChange: () => {},
    }, t.runtime);

    await devSync.sync(true);

    expect(setup).not.toHaveBeenCalled();
    expect(t.commands).not.toContain("plugin:tray|remove_by_id");
  });
});

describe("Dock no macOS", () => {
  it("não esconde o Dock se o tray for desligado durante o fechamento", async () => {
    const t = fixture("MacIntel");
    await t.sync.sync(true);
    const started = t.waitForHideStart();
    const hiding = t.sync.hideWindow();
    await started;

    const disabling = t.sync.sync(false);
    t.releaseHide();
    await Promise.all([hiding, disabling]);

    const dockCalls = t.calls.filter((call) => call.command === "set_dock_visible");
    expect(dockCalls.map((call) => call.args)).toEqual([{ visible: true }]);
    const hideIndex = t.commands.indexOf("hide_main_window");
    const removeIndex = t.commands.lastIndexOf("plugin:tray|remove_by_id");
    const dockIndex = t.commands.indexOf("set_dock_visible");
    expect(hideIndex).toBeGreaterThanOrEqual(0);
    expect(hideIndex).toBeLessThan(removeIndex);
    expect(removeIndex).toBeLessThan(dockIndex);
    expect(t.available).toBe(false);
  });

  it("restaura o Dock depois de remover o tray desligado", async () => {
    const t = fixture("MacIntel");
    await t.sync.sync(true);
    await t.sync.sync(false);

    const removals = t.commands
      .map((command, index) => command === "plugin:tray|remove_by_id" ? index : -1)
      .filter((index) => index >= 0);
    expect(removals.length).toBeGreaterThanOrEqual(2);
    expect(t.commands.indexOf("plugin:tray|new")).toBeLessThan(removals[removals.length - 1]);
    expect(t.commands.indexOf("set_dock_visible")).toBeGreaterThan(removals[removals.length - 1]);
    const dockCall = t.calls.find((call) => call.command === "set_dock_visible");
    expect(dockCall?.args).toEqual({ visible: true });
  });

  it("oculta pelo Show/Hide com o Dock visível quando a resposta chega sem tray", async () => {
    const t = fixture("MacIntel");
    await t.sync.sync(true);
    const started = t.waitForVisibilityRead();
    const action = t.triggerShowHide();
    await started;
    await t.sync.sync(false);
    t.releaseVisibility();
    await action;

    expect(t.commands).toContain("hide_main_window");
    expect(t.commands).not.toContain("plugin:window|minimize");
    expect(t.calls.filter((call) => call.command === "set_dock_visible").map((call) => call.args))
      .toEqual([{ visible: true }]);
  });
});

describe.each(["Linux x86_64", "Win32"])("Show/Hide em %s", (platform) => {
  it("minimiza se a resposta de visibilidade chega depois da remoção do tray", async () => {
    const t = fixture(platform);
    await t.sync.sync(true);
    const started = t.waitForVisibilityRead();
    const action = t.triggerShowHide();
    await started;

    // The retirement also queries visibility. Let it finish independently
    // of the stale visibility result held by the menu callback.
    await t.sync.sync(false);
    expect(t.icons.size).toBe(0);
    t.releaseVisibility();
    await action;

    expect(t.commands).not.toContain("hide_main_window");
    expect(t.commands.at(-1)).toBe("plugin:window|minimize");
    expect(t.minimized).toBe(true);
  });

  it("restaura e minimiza antes de remover o tray se a ocultação já começou", async () => {
    const t = fixture(platform);
    await t.sync.sync(true);
    const started = t.waitForHideStart();
    const action = t.triggerShowHide();
    await started;

    const disabling = t.sync.sync(false);
    t.releaseHide();
    await Promise.all([action, disabling]);

    const show = t.commands.indexOf("show_main_window");
    const minimize = t.commands.indexOf("plugin:window|minimize");
    expect(show).toBeGreaterThan(t.commands.indexOf("hide_main_window"));
    expect(minimize).toBeGreaterThan(show);
    expect(minimize).toBeLessThan(t.commands.lastIndexOf("plugin:tray|remove_by_id"));
    expect(t.minimized).toBe(true);
    expect(t.icons.size).toBe(0);
  });
});
