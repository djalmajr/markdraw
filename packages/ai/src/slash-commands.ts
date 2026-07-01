// File-backed slash commands + custom instructions (omp#1, built native).
// A command is a plain Markdown file: an optional leading frontmatter block
// delimited by '---' lines containing simple 'key: value' lines (parsed
// line-based — deliberately NO yaml dependency), followed by the prompt
// template. Hosts collect commands from three sources whose precedence is
// builtin < global < project; the precedence is encoded purely by merge
// order in mergeSlashCommands (later lists override earlier ones by name).

/** One slash command the composer can expand ("/name args" → template). */
export interface SlashCommandDef {
  description?: string;
  name: string;
  source: "builtin" | "global" | "project";
  template: string;
}

/** Workspace-level custom instructions merged into the chat system prompt. */
export interface CustomInstructions {
  mode: "append" | "replace";
  text: string;
}

/** Valid command names: lowercase alphanumeric start, then [a-z0-9_-]. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Expansion tokens matched against the template in a single pass: `$ARGUMENTS`
 *  (the whole raw arg string) or a `$1`..`$9` positional. Single-pass means the
 *  text inserted for one token is never re-scanned for another, so a literal
 *  `$3` (or even `$ARGUMENTS`) arriving via the user's args stays verbatim. The
 *  lone capture group is the positional digit; it is `undefined` for an
 *  `$ARGUMENTS` match. */
const EXPANSION_TOKEN_RE = /\$ARGUMENTS|\$([1-9])/g;

interface FrontmatterSplit {
  body: string;
  fields: Map<string, string>;
}

/** Split an optional leading '---' frontmatter block off `raw`. Only simple
 *  'key: value' lines are honored (keys lowercased, values trimmed); an
 *  unterminated block is NOT frontmatter — the whole text stays body. */
function splitFrontmatter(raw: string): FrontmatterSplit {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: raw, fields: new Map() };
  const fields = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") {
      return { body: lines.slice(i + 1).join("\n"), fields };
    }
    const sep = line.indexOf(":");
    if (sep > 0) {
      fields.set(line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim());
    }
  }
  return { body: raw, fields: new Map() };
}

/**
 * Parse one command file into a {@link SlashCommandDef}. `name` (typically
 * the file name sans extension) is lowercased before validation. Returns null
 * when the normalized name is invalid or the template (trimmed body) is empty
 * — a bad file must never produce a half-formed command.
 */
export function parseSlashCommandFile(
  name: string,
  raw: string,
  source: SlashCommandDef["source"],
): SlashCommandDef | null {
  const normalized = name.toLowerCase();
  if (!NAME_RE.test(normalized)) return null;
  const { body, fields } = splitFrontmatter(raw);
  const template = body.trim();
  if (!template) return null;
  const description = fields.get("description");
  return {
    ...(description ? { description } : {}),
    name: normalized,
    source,
    template,
  };
}

/**
 * Merge command lists where LATER lists override earlier ones by name — call
 * as mergeSlashCommands(builtin, global, project) to encode the precedence
 * builtin < global < project. Result is sorted by name.
 */
export function mergeSlashCommands(...lists: SlashCommandDef[][]): SlashCommandDef[] {
  const byName = new Map<string, SlashCommandDef>();
  for (const list of lists) {
    for (const command of list) byName.set(command.name, command);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Split slash-command args into shell-like words. Handles single/double quotes
 *  and backslash escaping without trying to be a full shell parser. */
export function parseSlashArgs(args: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const char of args) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      // Inside single quotes everything is literal — even a backslash — until
      // the closing quote, matching POSIX single-quote semantics.
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) out.push(current);
  return out;
}

/**
 * Expand a command template with the user's arguments: every literal
 * `$ARGUMENTS` occurrence is replaced by `args` (which may be ""). Positional
 * `$1`..`$9` tokens receive quote-aware arguments. A template without any token
 * still receives non-empty args, appended after a blank line, so "/cmd extra
 * context" never silently drops the extra text.
 */
export function expandSlashCommand(template: string, args: string): string {
  const words = parseSlashArgs(args);
  let hasArguments = false;
  let hasPositionals = false;
  const expanded = template.replace(EXPANSION_TOKEN_RE, (_match, positional) => {
    if (positional === undefined) {
      hasArguments = true;
      return args;
    }
    hasPositionals = true;
    return words[Number(positional) - 1] ?? "";
  });
  if (hasArguments || hasPositionals) return expanded;
  return args ? `${template}\n\n${args}` : template;
}

/**
 * Parse a custom-instructions file (same frontmatter style). The only honored
 * key is `mode`: "replace" or "append" (case-insensitive — "Replace" /
 * "REPLACE" count) — anything else (or no frontmatter) falls back to
 * "append". Returns null when the body is empty.
 */
export function parseInstructionsFile(raw: string): CustomInstructions | null {
  const { body, fields } = splitFrontmatter(raw);
  const text = body.trim();
  if (!text) return null;
  return { mode: fields.get("mode")?.toLowerCase() === "replace" ? "replace" : "append", text };
}
