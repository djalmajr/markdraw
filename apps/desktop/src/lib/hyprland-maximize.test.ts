import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { cancelPendingDrag, DRAG_THRESHOLD, dragOnceMoved, installHyprlandMaximize, isDragRegion } from "./hyprland-maximize.ts";

class ElementMock {
  constructor(public tagName = "DIV", public attrs: Record<string, string> = {}) {}
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  hasAttribute(name: string) { return name in this.attrs; }
}
const original = globalThis.HTMLElement;
beforeAll(() => { (globalThis as unknown as { HTMLElement: typeof ElementMock }).HTMLElement = ElementMock; });
afterAll(() => { globalThis.HTMLElement = original; });
afterEach(() => cancelPendingDrag());
const el = (attr?: string, tag = "DIV") => new ElementMock(tag, attr === undefined ? {} : { "data-tauri-drag-region": attr }) as unknown as EventTarget;

describe("drag region parity", () => {
  it("handles self, deep, false and clickable elements", () => {
    for (const value of ["", "true"]) {
      const parent = el(value), child = el();
      expect(isDragRegion([parent])).toBe(true);
      expect(isDragRegion([child, parent])).toBe(false);
    }
    expect(isDragRegion([el(), el("deep")])).toBe(true);
    expect(isDragRegion([el("false"), el("deep")])).toBe(false);
    expect(isDragRegion([el(undefined, "BUTTON"), el("deep")])).toBe(false);
    expect(isDragRegion([el("", "BUTTON")])).toBe(true);
  });
});

type Fired = { prevented: boolean; stopped: boolean };
function harness() {
  const target = new EventTarget();
  const mouse = (type: string, fields: Record<string, unknown>): Fired => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, fields);
    let stopped = false;
    event.stopImmediatePropagation = () => { stopped = true; };
    target.dispatchEvent(event);
    return { prevented: event.defaultPrevented, stopped };
  };
  const press = (button: number, detail: number, path: EventTarget[], x = 100, y = 10) =>
    mouse("mousedown", { button, detail, clientX: x, clientY: y, composedPath: () => path });
  const move = (x: number, y: number, buttons = 1) => mouse("mousemove", { clientX: x, clientY: y, buttons });
  const release = () => mouse("mouseup", {});
  return { target: target as unknown as Window, mouse, press, move, release };
}

describe("capture listener", () => {
  it("toggles maximize on a left double click in a drag region and removes itself", () => {
    const h = harness();
    const calls: string[] = [];
    const remove = installHyprlandMaximize(h.target, async (cmd) => { calls.push(cmd); }, () => calls.push("drag"));
    expect(h.press(0, 2, [el("deep")])).toEqual({ prevented: true, stopped: true });
    expect(calls).toEqual(["toggle_maximize_instant"]);
    for (const args of [[1, 2, [el("")]], [0, 2, [el()]], [0, 1, [el()]], [0, 3, [el("")]]] as [number, number, EventTarget[]][]) {
      expect(h.press(...args)).toEqual({ prevented: false, stopped: false });
    }
    remove();
    expect(h.press(0, 2, [el("")]).prevented).toBe(false);
    expect(calls).toEqual(["toggle_maximize_instant"]);
  });

  it("takes a single press in a drag region and moves the window only after the pointer moves", () => {
    const h = harness();
    const calls: string[] = [];
    installHyprlandMaximize(h.target, async (cmd) => { calls.push(cmd); }, () => calls.push("drag"));
    // A click: intercepted (Tauri's own script never starts a move), and nothing happens.
    expect(h.press(0, 1, [el("")])).toEqual({ prevented: true, stopped: true });
    h.release();
    h.move(160, 40);
    expect(calls).toEqual([]);
    // A click then a double click: only the toggle, no move in between.
    h.press(0, 1, [el("")]);
    h.release();
    h.press(0, 2, [el("")]);
    h.release();
    expect(calls).toEqual(["toggle_maximize_instant"]);
    // A press and a drag: one move, once the pointer passes the threshold.
    h.press(0, 1, [el("")]);
    h.move(100 + DRAG_THRESHOLD - 1, 10);
    expect(calls).toEqual(["toggle_maximize_instant"]);
    h.move(100 + DRAG_THRESHOLD, 10);
    h.move(200, 60);
    expect(calls).toEqual(["toggle_maximize_instant", "drag"]);
  });

  it("drops a pending move, from the toolbar or the welcome screen, when removed", () => {
    for (const arm of ["toolbar", "background"]) {
      const h = harness();
      const calls: string[] = [];
      const remove = installHyprlandMaximize(h.target, async () => {}, () => calls.push("drag"));
      if (arm === "toolbar") h.press(0, 1, [el("")]);
      else dragOnceMoved(h.target, { clientX: 100, clientY: 10 } as MouseEvent, () => calls.push("background"));
      remove();
      h.move(200, 60);
      expect(calls).toEqual([]);
    }
  });

  it("keeps one pending move when a press arrives before the last one was released", () => {
    const h = harness();
    const calls: string[] = [];
    installHyprlandMaximize(h.target, async () => {}, () => calls.push("toolbar"));
    h.press(0, 1, [el("")]);
    dragOnceMoved(h.target, { clientX: 100, clientY: 10 } as MouseEvent, () => calls.push("background"));
    dragOnceMoved(h.target, { clientX: 100, clientY: 10 } as MouseEvent, () => calls.push("background"));
    h.press(0, 1, [el("")]);
    h.move(200, 60);
    expect(calls).toEqual(["toolbar"]);
  });
});

describe("dragOnceMoved", () => {
  const pressAt = (x: number, y: number) => ({ clientX: x, clientY: y }) as MouseEvent;

  it("starts once past the threshold and never again", () => {
    const h = harness();
    let starts = 0;
    dragOnceMoved(h.target, pressAt(50, 50), () => { starts++; });
    h.move(51, 52);
    expect(starts).toBe(0);
    h.move(52, 52);
    h.move(90, 90);
    expect(starts).toBe(1);
  });

  it("gives up on release, on blur, when the button is no longer held, or when cancelled", () => {
    const end: Array<(h: ReturnType<typeof harness>) => void> = [
      (h) => h.release(),
      (h) => h.mouse("blur", {}),
      (h) => h.move(51, 50, 0),
      () => cancelPendingDrag(),
    ];
    for (const finish of end) {
      const h = harness();
      let starts = 0;
      dragOnceMoved(h.target, pressAt(50, 50), () => { starts++; });
      finish(h);
      h.move(120, 120);
      expect(starts).toBe(0);
    }
  });
});
