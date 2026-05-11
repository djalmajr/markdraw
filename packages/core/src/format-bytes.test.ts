import { describe, expect, it } from "bun:test";
import { formatBytes } from "./format-bytes.ts";

describe("formatBytes", () => {
  it("renders sub-KB values as bytes with no decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders KB with one decimal", () => {
    // Mutation captured: dividing by 1000 instead of 1024 would render
    // 1024 B as "1.0 KB" only after the threshold check changed too —
    // catching the boundary at 1024 ensures the binary prefix is used.
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("crosses to MB at 1024 KB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(30 * 1024 * 1024)).toBe("30.0 MB");
  });

  it("crosses to GB at 1024 MB and rounds to two decimals", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });

  it("falls back to '0 B' for negative or non-finite inputs", () => {
    // Domain rule: the byte counter for an update download must never
    // surface a negative value or "Infinity" to the user — both are
    // bugs in the upstream emitter and should degrade gracefully.
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(-1024)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});
