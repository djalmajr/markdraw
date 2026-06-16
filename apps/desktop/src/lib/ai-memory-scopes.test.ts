import { describe, expect, it } from "bun:test";
import {
  buildMemoryScopesInstruction,
  parseAiMemoryToml,
  type MemoryScope,
} from "./ai-memory-scopes.ts";

describe("parseAiMemoryToml", () => {
  it("reads workspace + project (double-quoted)", () => {
    expect(parseAiMemoryToml('workspace = "djalmajr"\nproject = "ai-memory"\n')).toEqual({
      workspace: "djalmajr",
      project: "ai-memory",
    });
  });

  it("handles single quotes, surrounding comments, and extra keys", () => {
    const toml = `# routing marker\nworkspace = 'default'\nproject = 'asciimark'\n[instance]\nissuer = "https://kc"`;
    expect(parseAiMemoryToml(toml)).toEqual({ workspace: "default", project: "asciimark" });
  });

  it("returns undefined for missing keys", () => {
    expect(parseAiMemoryToml('project = "x"')).toEqual({ workspace: undefined, project: "x" });
    expect(parseAiMemoryToml("nothing here")).toEqual({ workspace: undefined, project: undefined });
  });
});

describe("buildMemoryScopesInstruction", () => {
  it("returns null with no scopes", () => {
    expect(buildMemoryScopesInstruction([])).toBeNull();
  });

  it("embeds a JSON scopes array the model can pass through", () => {
    const scopes: MemoryScope[] = [
      { root: "/a", workspace: "djalmajr", project: "ai-memory" },
      { root: "/b", workspace: "default", project: "asciimark" },
    ];
    const note = buildMemoryScopesInstruction(scopes)!;
    expect(note).toContain("ai-memory");
    expect(note).toContain(
      JSON.stringify([
        { workspace: "djalmajr", project: "ai-memory" },
        { workspace: "default", project: "asciimark" },
      ]),
    );
    // root paths are not leaked into the machine-readable arg
    expect(note).not.toContain('"root"');
  });
});
