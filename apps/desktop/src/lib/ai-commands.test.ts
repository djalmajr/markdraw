// Pure-logic coverage only: the dir/file loaders ride Tauri invoke + the
// app-config path and are exercised in the running app, not here (the
// merge/parse semantics they delegate to are covered in packages/ai).

import { describe, expect, it } from "bun:test";
import { expandSlashCommand, parseSlashCommandFile } from "@markdraw/ai/slash-commands.ts";
import { BUILTIN_COMMANDS, commandNameFromFile, joinDir } from "./ai-commands.ts";

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
