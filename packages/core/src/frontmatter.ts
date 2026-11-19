// js-yaml 5 has no default export: the public API is a set of flat named
// exports (see docs/migrate_v4_to_v5.md in nodeca/js-yaml).
import { load } from "js-yaml";

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

// Deepest nesting a frontmatter map may have before it is rejected. Consumers
// (the properties panel, JSON.stringify) walk the map recursively, so a
// structure this deep has no use and is treated like invalid YAML.
const MAX_FRONTMATTER_DEPTH = 64;

/**
 * Walk a parsed YAML value looking for a reference cycle or nesting deeper
 * than {@link MAX_FRONTMATTER_DEPTH}.
 *
 * `active` holds only the current path, not every visited object: an anchor
 * reused by two sibling keys (`a: &x {k: 1}` / `b: *x`) is a shared reference,
 * not a cycle, and stays valid. js-yaml resolves aliases by reference, so a
 * recursive anchor (`a: &a {b: *a}`) really does produce a cyclic object.
 *
 * `heights` memoizes, per object, the height of its subtree (the longest chain
 * of nested objects below it). A shared subtree is therefore walked once: the
 * next reference only checks `depth + height` against the limit. Without that
 * memo, a YAML document that reuses anchors at every level (YAML trees, not
 * cycles) makes the walk cost exponential in the number of levels.
 */
function isCyclicOrDeep(root: unknown): boolean {
  const active = new WeakSet<object>();
  const heights = new WeakMap<object, number>();

  /**
   * Height of `value` when it sits at `depth`, or null when it is cyclic or
   * would put a descendant past {@link MAX_FRONTMATTER_DEPTH}.
   */
  function heightOf(value: unknown, depth: number): number | null {
    if (value === null || typeof value !== "object") return 0;
    if (active.has(value)) return null;
    const known = heights.get(value);
    if (known !== undefined) {
      return depth + known > MAX_FRONTMATTER_DEPTH ? null : known;
    }
    active.add(value);
    let height = 0;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      const childHeight = heightOf(child, depth + 1);
      if (childHeight === null) return null;
      if (childHeight + 1 > height) height = childHeight + 1;
    }
    active.delete(value);
    // `depth + height` is the depth of the deepest node in this subtree, which
    // is what the limit constrains: an object only becomes hidden deep iff its
    // ancestors are valid, so the check has to happen on the first visit too.
    if (depth + height > MAX_FRONTMATTER_DEPTH) return null;
    heights.set(value, height);
    return height;
  }

  return heightOf(root, 0) === null;
}

/**
 * Extract YAML frontmatter from the top of a document.
 *
 * If the document starts with `--- ... ---`, parses the YAML between the
 * fences and strips the block from the body. Invalid YAML is treated as
 * "no frontmatter" so renderers degrade gracefully, and so is a map that is
 * cyclic or nested deeper than {@link MAX_FRONTMATTER_DEPTH}.
 */
export function extractFrontmatter(content: string): {
  frontmatter: Frontmatter | null;
  body: string;
} {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: content };

  try {
    const parsed = load(match[1]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { frontmatter: null, body: content };
    }
    if (isCyclicOrDeep(parsed)) {
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
