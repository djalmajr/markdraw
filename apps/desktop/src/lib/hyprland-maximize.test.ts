import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { installHyprlandMaximize, isDragRegion } from "./hyprland-maximize.ts";

class ElementMock {
  constructor(public tagName = "DIV", public attrs: Record<string, string> = {}) {}
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  hasAttribute(name: string) { return name in this.attrs; }
}
const original = globalThis.HTMLElement;
beforeAll(() => { (globalThis as unknown as { HTMLElement: typeof ElementMock }).HTMLElement = ElementMock; });
afterAll(() => { globalThis.HTMLElement = original; });
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

describe("capture listener", () => {
  it("intercepts only left double clicks in a drag region and removes itself", () => {
    const target = new EventTarget();
    const calls: string[] = [];
    const remove = installHyprlandMaximize(target as Window, async (cmd) => { calls.push(cmd); });
    const fire = (button: number, detail: number, path: EventTarget[]) => {
      const event = new Event("mousedown", { cancelable: true });
      Object.assign(event, { button, detail, composedPath: () => path });
      let stopped = false;
      event.stopImmediatePropagation = () => { stopped = true; };
      target.dispatchEvent(event);
      return { prevented: event.defaultPrevented, stopped };
    };
    expect(fire(0, 2, [el("deep")])).toEqual({ prevented: true, stopped: true });
    expect(calls).toEqual(["toggle_maximize_instant"]);
    for (const args of [[0, 1, [el("")]], [1, 2, [el("")]], [0, 2, [el()]]] as [number, number, EventTarget[]][]) {
      expect(fire(...args)).toEqual({ prevented: false, stopped: false });
    }
    remove();
    expect(fire(0, 2, [el("")]).prevented).toBe(false);
  });
});
