import yaml from "js-yaml";

/**
 * YAML frontmatter parsed from the top of a markdown/asciidoc document.
 *
 * The known keys (`title`, `tags`, etc.) are typed for convenience but the
 * map is open: any extra keys are kept as `unknown` and rendered generically.
 */
export interface Frontmatter {
  title?: string;
  type?: string;
  tags?: string[];
  created?: string;
  updated?: string;
  sources?: string[];
  related?: string[];
  status?: string;
  [key: string]: unknown;
}

// Frontmatter must start at position 0 to avoid colliding with markdown HRs.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Extract YAML frontmatter from the top of a document.
 *
 * If the document starts with `--- ... ---`, parses the YAML between the
 * fences and strips the block from the body. Invalid YAML is treated as
 * "no frontmatter" so renderers degrade gracefully.
 */
export function extractFrontmatter(content: string): {
  frontmatter: Frontmatter | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: content };

  try {
    const parsed = yaml.load(match[1]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { frontmatter: null, body: content };
    }
    return {
      frontmatter: parsed as Frontmatter,
      body: content.slice(match[0].length),
    };
  } catch {
    return { frontmatter: null, body: content };
  }
}

const WIKI_LINK_RE = /^\[\[([^\]]+)\]\]$/;

/**
 * Detect Obsidian-style `[[name]]` wiki-links and return the inner name,
 * or null if the value is not a wiki-link.
 */
export function parseWikiLink(value: string): string | null {
  const match = value.trim().match(WIKI_LINK_RE);
  return match ? match[1]!.trim() : null;
}
