import { describe, expect, it } from "bun:test";
import {
  expandSlashCommand,
  mergeSlashCommands,
  parseSlashArgs,
  parseInstructionsFile,
  parseSlashCommandFile,
  type SlashCommandDef,
} from "./slash-commands.ts";

function cmd(name: string, source: SlashCommandDef["source"], template = "t"): SlashCommandDef {
  return { name, source, template };
}

describe("parseSlashCommandFile", () => {
  it("parses a bare template (no frontmatter), trimming the body", () => {
    const parsed = parseSlashCommandFile("review", "\n\nReview this:\n\n$ARGUMENTS\n", "project");
    expect(parsed).toEqual({
      name: "review",
      source: "project",
      template: "Review this:\n\n$ARGUMENTS",
    });
  });

  it("honors the frontmatter description and strips the block from the template", () => {
    const raw = "---\ndescription: Review the diff\n---\nReview:\n$ARGUMENTS";
    const parsed = parseSlashCommandFile("review", raw, "global");
    expect(parsed).toEqual({
      description: "Review the diff",
      name: "review",
      source: "global",
      template: "Review:\n$ARGUMENTS",
    });
  });

  it("ignores frontmatter keys other than description", () => {
    const raw = "---\nmodel: gpt\ndescription: D\nfoo: bar\n---\nBody";
    const parsed = parseSlashCommandFile("x", raw, "builtin");
    expect(parsed).toEqual({ description: "D", name: "x", source: "builtin", template: "Body" });
  });

  it("parses frontmatter keys case-insensitively and trims values", () => {
    const raw = "---\nDescription:   spaced out  \n---\nBody";
    expect(parseSlashCommandFile("x", raw, "global")?.description).toBe("spaced out");
  });

  it("handles CRLF line endings in the frontmatter block", () => {
    const raw = "---\r\ndescription: win\r\n---\r\nBody line";
    const parsed = parseSlashCommandFile("x", raw, "global");
    expect(parsed?.description).toBe("win");
    expect(parsed?.template).toBe("Body line");
  });

  it("treats an unterminated frontmatter fence as plain body content", () => {
    const raw = "---\ndescription: never closed\nstill body";
    const parsed = parseSlashCommandFile("x", raw, "project");
    expect(parsed?.description).toBeUndefined();
    expect(parsed?.template).toBe(raw);
  });

  it("lowercases the name", () => {
    expect(parseSlashCommandFile("Review-PR", "t", "global")?.name).toBe("review-pr");
  });

  it("returns null for invalid names", () => {
    for (const bad of ["", "-lead", "_lead", "has space", "café", "a.b", "/x"]) {
      expect(parseSlashCommandFile(bad, "template", "project")).toBeNull();
    }
  });

  it("accepts digits, hyphens and underscores after the first character", () => {
    expect(parseSlashCommandFile("a1_b-c", "t", "builtin")?.name).toBe("a1_b-c");
    expect(parseSlashCommandFile("9lives", "t", "builtin")?.name).toBe("9lives");
  });

  it("returns null when the template is empty (whitespace or frontmatter-only)", () => {
    expect(parseSlashCommandFile("x", "", "project")).toBeNull();
    expect(parseSlashCommandFile("x", "   \n\t\n", "project")).toBeNull();
    expect(parseSlashCommandFile("x", "---\ndescription: D\n---\n\n", "project")).toBeNull();
  });
});

describe("mergeSlashCommands", () => {
  it("lets later lists override earlier ones by name (builtin < global < project)", () => {
    const merged = mergeSlashCommands(
      [cmd("explain", "builtin", "builtin body"), cmd("summarize", "builtin")],
      [cmd("explain", "global", "global body"), cmd("deploy", "global")],
      [cmd("deploy", "project", "project body")],
    );
    expect(merged.map((c) => `${c.name}:${c.source}`)).toEqual([
      "deploy:project",
      "explain:global",
      "summarize:builtin",
    ]);
    expect(merged.find((c) => c.name === "explain")?.template).toBe("global body");
    expect(merged.find((c) => c.name === "deploy")?.template).toBe("project body");
  });

  it("sorts the result by name", () => {
    const merged = mergeSlashCommands([cmd("zz", "builtin"), cmd("aa", "builtin"), cmd("mm", "builtin")]);
    expect(merged.map((c) => c.name)).toEqual(["aa", "mm", "zz"]);
  });

  it("handles no lists and empty lists", () => {
    expect(mergeSlashCommands()).toEqual([]);
    expect(mergeSlashCommands([], [])).toEqual([]);
  });

  it("a later duplicate inside the SAME list also wins (last write)", () => {
    const merged = mergeSlashCommands([cmd("a", "global", "first"), cmd("a", "global", "second")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.template).toBe("second");
  });
});

describe("expandSlashCommand", () => {
  it("replaces ALL $ARGUMENTS occurrences", () => {
    expect(expandSlashCommand("a $ARGUMENTS b $ARGUMENTS", "X")).toBe("a X b X");
  });

  it("replaces the token with an empty string when args is empty", () => {
    expect(expandSlashCommand("explain $ARGUMENTS now", "")).toBe("explain  now");
  });

  it("appends non-empty args after a blank line when the template has no token", () => {
    expect(expandSlashCommand("Summarize the chat.", "focus on risks")).toBe(
      "Summarize the chat.\n\nfocus on risks",
    );
  });

  it("returns the template untouched when it has no token and args is empty", () => {
    expect(expandSlashCommand("Summarize the chat.", "")).toBe("Summarize the chat.");
  });

  it("keeps multi-line args intact", () => {
    expect(expandSlashCommand("Do:\n$ARGUMENTS", "line1\nline2")).toBe("Do:\nline1\nline2");
  });

  it("expands positional args", () => {
    expect(expandSlashCommand("Review $1 in mode $2.", "docs/api.md strict")).toBe(
      "Review docs/api.md in mode strict.",
    );
  });

  it("parses quoted positional args", () => {
    expect(expandSlashCommand("Create $1 named $2.", "file \"release notes.md\"")).toBe(
      "Create file named release notes.md.",
    );
  });

  it("does not append raw args when positional tokens were used", () => {
    expect(expandSlashCommand("Read $1.", "docs/a.md extra")).toBe("Read docs/a.md.");
  });

  it("does not re-expand a literal $N that arrives via user args", () => {
    expect(expandSlashCommand("Note: $ARGUMENTS", "keep $1 literal")).toBe("Note: keep $1 literal");
  });

  it("keeps user-supplied $ARGUMENTS/$N text verbatim (single-pass expansion)", () => {
    expect(expandSlashCommand("$1 and $ARGUMENTS", "$ARGUMENTS more")).toBe(
      "$ARGUMENTS and $ARGUMENTS more",
    );
  });
});

describe("parseSlashArgs", () => {
  it("splits plain args on whitespace", () => {
    expect(parseSlashArgs("one two  three")).toEqual(["one", "two", "three"]);
  });

  it("keeps quoted args together and unescapes characters", () => {
    expect(parseSlashArgs("'one two' \"three \\\"four\\\"\" five\\ six")).toEqual([
      "one two",
      'three "four"',
      "five six",
    ]);
  });

  it("preserves backslashes inside single quotes (POSIX literal semantics)", () => {
    expect(parseSlashArgs("'C:\\Users\\bob'")).toEqual(["C:\\Users\\bob"]);
  });
});

describe("parseInstructionsFile", () => {
  it("defaults to append mode without frontmatter", () => {
    expect(parseInstructionsFile("Always answer in haiku.")).toEqual({
      mode: "append",
      text: "Always answer in haiku.",
    });
  });

  it("honors mode: replace", () => {
    expect(parseInstructionsFile("---\nmode: replace\n---\nYou are a pirate.")).toEqual({
      mode: "replace",
      text: "You are a pirate.",
    });
  });

  it("honors mode: append explicitly", () => {
    expect(parseInstructionsFile("---\nmode: append\n---\nBe terse.")?.mode).toBe("append");
  });

  it("falls back to append on invalid mode values", () => {
    expect(parseInstructionsFile("---\nmode: overwrite\n---\nBody")?.mode).toBe("append");
    expect(parseInstructionsFile("---\nmode:\n---\nBody")?.mode).toBe("append");
  });

  it("accepts mode values case-insensitively (Replace / REPLACE / Append)", () => {
    expect(parseInstructionsFile("---\nmode: Replace\n---\nBody")?.mode).toBe("replace");
    expect(parseInstructionsFile("---\nmode: REPLACE\n---\nBody")?.mode).toBe("replace");
    expect(parseInstructionsFile("---\nmode: Append\n---\nBody")?.mode).toBe("append");
  });

  it("trims the body", () => {
    expect(parseInstructionsFile("\n\n  hi  \n")?.text).toBe("hi");
  });

  it("returns null when the body is empty", () => {
    expect(parseInstructionsFile("")).toBeNull();
    expect(parseInstructionsFile("   \n")).toBeNull();
    expect(parseInstructionsFile("---\nmode: replace\n---\n  ")).toBeNull();
  });
});
