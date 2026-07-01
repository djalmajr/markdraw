// Pure-logic coverage only: the dir/file loaders ride Tauri invoke + the
// app-config path and are exercised in the running app, not here (the
// merge/parse semantics they delegate to are covered in packages/ai).

import { describe, expect, it } from "bun:test";
import { expandSlashCommand, parseSlashCommandFile } from "@markdraw/ai/slash-commands.ts";
import { BUILTIN_COMMANDS, commandNameFromFile, expandContextFile, joinDir } from "./ai-commands.ts";

describe("BUILTIN_COMMANDS", () => {
  it("ships explain and summarize with valid, parseable shapes", () => {
    expect(BUILTIN_COMMANDS.map((c) => c.name)).toEqual(["explain", "summarize"]);
    for (const command of BUILTIN_COMMANDS) {
      expect(command.source).toBe("builtin");
      expect(command.description).toBeTruthy();
      // Each builtin must survive the same validation a file-backed command
      // gets — a drifted name/template would silently vanish from a merge.
      expect(parseSlashCommandFile(command.name, command.template, command.source)).toEqual({
        name: command.name,
        source: command.source,
        template: command.template,
      });
    }
  });

  it("explain expands $ARGUMENTS; summarize appends free args", () => {
    const explain = BUILTIN_COMMANDS.find((c) => c.name === "explain")!;
    expect(expandSlashCommand(explain.template, "panes")).toBe(
      "Explain the following in the context of this workspace:\n\npanes",
    );
    const summarize = BUILTIN_COMMANDS.find((c) => c.name === "summarize")!;
    expect(expandSlashCommand(summarize.template, "")).toBe(summarize.template);
    expect(expandSlashCommand(summarize.template, "focus on risks")).toBe(
      `${summarize.template}\n\nfocus on risks`,
    );
  });
});

describe("commandNameFromFile", () => {
  it("strips the .md extension (case-insensitively)", () => {
    expect(commandNameFromFile("review.md")).toBe("review");
    expect(commandNameFromFile("Review.MD")).toBe("Review");
  });

  it("returns null for non-md files", () => {
    expect(commandNameFromFile("review.txt")).toBeNull();
    expect(commandNameFromFile("review")).toBeNull();
    expect(commandNameFromFile("md")).toBeNull();
  });
});

describe("joinDir", () => {
  it("inserts a separator only when the base has none", () => {
    expect(joinDir("/a/b", "commands")).toBe("/a/b/commands");
    expect(joinDir("/a/b/", "commands")).toBe("/a/b/commands");
    expect(joinDir("C:\\Users\\x\\", "commands")).toBe("C:\\Users\\x\\commands");
  });
});

describe("expandContextFile", () => {
  it("expands @file and @<file> imports recursively", async () => {
    const files = new Map([
      ["/repo/docs/plan.md", "Plan body"],
      ["/repo/docs/nested.md", "Nested @../shared.md"],
      ["/repo/shared.md", "Shared body"],
    ]);
    const readFile = async (path: string): Promise<string> => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    };

    const expanded = await expandContextFile(
      "/repo",
      "/repo/AGENTS.md",
      "Read @docs/plan.md and @<docs/nested.md>",
      readFile,
    );

    expect(expanded).toContain('<context-import path="docs/plan.md">');
    expect(expanded).toContain("Plan body");
    expect(expanded).toContain('<context-import path="docs/nested.md">');
    expect(expanded).toContain('<context-import path="shared.md">');
    expect(expanded).toContain("Shared body");
  });

  it("ignores inline code, fenced code, and outside-root paths", async () => {
    const reads: string[] = [];
    const readFile = async (path: string): Promise<string> => {
      reads.push(path);
      return "body";
    };

    const expanded = await expandContextFile(
      "/repo",
      "/repo/AGENTS.md",
      [
        "Inline `@docs/ignored.md`",
        "@../secret.md",
        "```",
        "@docs/fenced.md",
        "```",
        "@docs/used.md",
      ].join("\n"),
      readFile,
    );

    expect(reads).toEqual(["/repo/docs/used.md"]);
    expect(expanded).toContain('<context-import path="docs/used.md">');
    expect(expanded).not.toContain("ignored.md\">");
    expect(expanded).not.toContain("fenced.md\">");
    expect(expanded).not.toContain("secret.md\">");
  });
});
