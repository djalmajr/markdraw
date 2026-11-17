import { describe, expect, it } from "bun:test";
import {
  themeFollower,
  TRAY_ICON_BLACK_BASE64,
  TRAY_ICON_WHITE_BASE64,
  trayIconBase64,
  trayIconDir,
  trayIconFor,
} from "./tray-icon.ts";

function pngSize(base64: string): [number, number] {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  // PNG signature, then the IHDR chunk: width and height at bytes 16 and 20.
  expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
  return [view.getUint32(16), view.getUint32(20)];
}

describe("trayIconFor", () => {
  it("shows the white glyph on a dark Linux bar", () => {
    expect(trayIconFor("Linux x86_64", "dark")).toBe("white");
  });

  it("keeps the black glyph on a light or unknown Linux scheme", () => {
    expect(trayIconFor("Linux x86_64", "light")).toBe("black");
    expect(trayIconFor("Linux x86_64", null)).toBe("black");
  });

  it("keeps the black template on macOS and the black glyph on Windows", () => {
    expect(trayIconFor("MacIntel", "dark")).toBe("black");
    expect(trayIconFor("Win32", "dark")).toBe("black");
  });

  it("maps each choice to its image", () => {
    expect(trayIconBase64("Linux x86_64", "dark")).toBe(TRAY_ICON_WHITE_BASE64);
    expect(trayIconBase64("Linux x86_64", "light")).toBe(TRAY_ICON_BLACK_BASE64);
    expect(trayIconBase64("MacIntel", "dark")).toBe(TRAY_ICON_BLACK_BASE64);
    expect(trayIconBase64("Win32", "dark")).toBe(TRAY_ICON_BLACK_BASE64);
  });

  it("ships both glyphs as 88x88 PNGs", () => {
    expect(pngSize(TRAY_ICON_BLACK_BASE64)).toEqual([88, 88]);
    expect(pngSize(TRAY_ICON_WHITE_BASE64)).toEqual([88, 88]);
    expect(TRAY_ICON_WHITE_BASE64).not.toBe(TRAY_ICON_BLACK_BASE64);
  });

  it("keeps each glyph's PNG in its own directory", () => {
    expect(trayIconDir("/run/user/1000", "white")).toBe("/run/user/1000/tray-icon/markdraw-white");
    expect(trayIconDir("/run/user/1000/", "black")).toBe("/run/user/1000/tray-icon/markdraw-black");
  });
});

describe("themeFollower", () => {
  function setup(initial: "light" | "dark") {
    const applied: string[] = [];
    const follower = themeFollower(initial, async (theme) => {
      applied.push(String(theme));
    });
    return { applied, follower };
  }

  it("applies switches in order and skips the glyph already shown", async () => {
    const { applied, follower } = setup("dark");
    void follower.event("dark");
    void follower.event("light");
    await follower.event("dark");
    expect(applied).toEqual(["light", "dark"]);
  });

  it("catches up a switch made before it was listening", async () => {
    const { applied, follower } = setup("dark");
    await follower.reconcile(async () => "light");
    expect(applied).toEqual(["light"]);
  });

  it("drops a reading that a newer event overtook", async () => {
    const { applied, follower } = setup("dark");
    // The reading saw light, but its answer reaches the page only after the
    // desktop switched to light and back to dark: it must not undo that.
    let answer!: (theme: "light") => void;
    const reading = follower.reconcile(() => new Promise((resolve) => (answer = resolve)));
    await follower.event("light");
    await follower.event("dark");
    answer("light");
    await reading;
    expect(applied).toEqual(["light", "dark"]);
  });

  it("keeps going after a failed update", async () => {
    const applied: string[] = [];
    let fail = true;
    const follower = themeFollower("dark", async (theme) => {
      if (fail) {
        fail = false;
        throw new Error("tray gone");
      }
      applied.push(String(theme));
    });
    await follower.event("light");
    await follower.event("light");
    expect(applied).toEqual(["light"]);
  });
});
