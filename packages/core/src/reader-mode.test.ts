import { describe, expect, it, beforeEach } from "bun:test";
import { installLocalStorageMock } from "./test-utils.ts";
import { getReaderMode, setReaderMode, READER_MODE_STORAGE_KEY } from "./reader-mode.ts";

installLocalStorageMock();

describe("reader-mode persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to false when no preference is stored", () => {
    // Mutation: defaulting to true would lock first-run users into
    // a chrome-less app with no obvious way out.
    expect(getReaderMode()).toBe(false);
  });

  it("round-trips a true setting through localStorage", () => {
    // Mutation: writing the wrong key (or a non-boolean) breaks
    // restore on next launch — the toggle would feel ephemeral.
    setReaderMode(true);
    expect(localStorage.getItem(READER_MODE_STORAGE_KEY)).toBe("true");
    expect(getReaderMode()).toBe(true);
  });

  it("round-trips a false setting (writing 'false', not removing the key)", () => {
    setReaderMode(true);
    setReaderMode(false);
    expect(localStorage.getItem(READER_MODE_STORAGE_KEY)).toBe("false");
    expect(getReaderMode()).toBe(false);
  });

  it("treats malformed stored values as the default (false)", () => {
    // Mutation: trusting the stored string verbatim would let any
    // truthy non-empty value flip the mode unexpectedly.
    localStorage.setItem(READER_MODE_STORAGE_KEY, "yes-please");
    expect(getReaderMode()).toBe(false);
  });
});
