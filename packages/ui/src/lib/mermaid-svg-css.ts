const SCOPE_CLASS_PLACEHOLDER = "__mermaid_css_scope__";
const CSS_FRAGMENT_URL = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?<![\w-])url\(\s*(?:(["'])#([^"'\\\r\n]+)\1|#([^\s()"'\\]+))\s*\)/gi;
const GROUP_RULE_OPENING = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[^{"'\\])*\{/s;
export const MERMAID_CSS_CLASS_PREFIX = "mermaid-css-";

function hashCss(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withCssRules<T>(css: string, visit: (rules: CSSRuleList) => T): T | null {
  try {
    const Sheet = globalThis.CSSStyleSheet;
    if (typeof Sheet !== "function") return null;
    const sheet = new Sheet();
    if (typeof sheet.replaceSync !== "function") return null;
    sheet.replaceSync(css);
    return visit(sheet.cssRules);
  } catch {
    return null;
  }
}

function rewriteRuleSelector(rule: CSSStyleRule, replaceIds: (selector: string) => string): void {
  // Attribute selectors can contain fragment-looking literals.
  rule.selectorText = rule.selectorText.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)
    .map((part, index) => index % 2 ? part : replaceIds(part))
    .join("");
}

function rewriteCssRule(rule: CSSRule, replaceIds: (selector: string) => string): string {
  const styleRule = rule as CSSStyleRule;
  if (typeof styleRule.selectorText === "string") rewriteRuleSelector(styleRule, replaceIds);
  const nested = (rule as CSSGroupingRule).cssRules;
  if (nested) {
    for (const child of Array.from(nested)) rewriteCssRule(child, replaceIds);
  }
  return rule.cssText;
}

function rewriteCssSelectors(css: string, replaceIds: (selector: string) => string): string | null {
  return withCssRules(css, (rules) => Array.from(rules, (rule) =>
    rewriteCssRule(rule, replaceIds),
  ).join("\n"));
}

function hasLocalFragment(css: string, ids: ReadonlySet<string>): boolean {
  for (const [, , quotedId, bareId] of css.matchAll(CSS_FRAGMENT_URL)) {
    if (ids.has(quotedId ?? bareId)) return true;
  }
  return false;
}

function splitCssRules(
  rules: CSSRuleList,
  ids: ReadonlySet<string>,
  sharedScope: (selector: string) => string,
  localScope: (selector: string) => string,
): { shared: string; local: string } {
  const shared: string[] = [];
  const local: string[] = [];
  for (const rule of Array.from(rules)) {
    // Sheets apply in document order. After the first local rule, keep the
    // rest of the cascade in the SVG, even when a later rule has no URL.
    if (local.length > 0) {
      local.push(rewriteCssRule(rule, localScope));
      continue;
    }
    const styleRule = rule as CSSStyleRule;
    const isStyleRule = typeof styleRule.selectorText === "string";
    const nested = (rule as CSSGroupingRule).cssRules;
    // A keyframes definition is atomic. Two definitions would replace each other.
    if (!isStyleRule && nested?.length && rule.type !== CSSRule.KEYFRAMES_RULE) {
      const parts = splitCssRules(nested, ids, sharedScope, localScope);
      if (parts.shared && parts.local) {
        const opening = rule.cssText.match(GROUP_RULE_OPENING)?.[0];
        if (!opening) throw new Error("Cannot split Mermaid CSS group");
        shared.push(`${opening}\n${parts.shared}\n}`);
        local.push(`${opening}\n${parts.local}\n}`);
      } else {
        (parts.local ? local : shared).push(rule.cssText);
      }
      continue;
    }
    if (hasLocalFragment(rule.cssText, ids)) {
      local.push(rewriteCssRule(rule, localScope));
    } else {
      shared.push(rewriteCssRule(rule, sharedScope));
    }
  }
  return { shared: shared.join("\n"), local: local.join("\n") };
}

export function renameMermaidInlineCss(css: string, ids: ReadonlyMap<string, string>): string | null {
  const scoped = rewriteCssSelectors(css, (selector) =>
    selector.replace(/#([\w-]+)/g, (token, id: string) => {
      const renamed = ids.get(id);
      return renamed ? `#${renamed}` : token;
    }),
  );
  return scoped?.replace(CSS_FRAGMENT_URL, (token, _quote, quotedId, bareId) => {
    const id: string | undefined = quotedId ?? bareId;
    if (!id) return token;
    const renamed = ids.get(id);
    return renamed ? token.replace(`#${id}`, `#${renamed}`) : token;
  }) ?? null;
}

/** SVG markup must be parsed as SVG: an HTML `<template>` drops the content
 *  of `<style>` inside `<svg>` in some DOM implementations. */
export function parseSvgMarkup(svg: string): { root: Element | null; serialize: () => string } {
  const xml = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = xml.querySelector("parsererror") ? null : xml.documentElement;
  if (root?.localName === "svg") {
    return { root, serialize: () => root.outerHTML };
  }
  const template = document.createElement("template");
  template.innerHTML = svg;
  return {
    root: template.content.querySelector("svg"),
    serialize: () => template.innerHTML,
  };
}

/** Extract the shareable prefix of the SVG stylesheet. */
export function prepareMermaidSvg(svg: string): {
  html: string;
  className: string;
  css: string;
  hasLocalCss: boolean;
} | null {
  const { root, serialize } = parseSvgMarkup(svg);
  if (!root) return null;

  const style = Array.from(root.querySelectorAll("*")).find((el) => el.localName === "style");
  const rawCss = style?.textContent ?? "";
  const id = root.getAttribute("id") ?? "";
  if (!style || !id || !rawCss.trim()) return null;

  const ids = new Set([id, ...Array.from(root.querySelectorAll("[id]"), (element) => element.id)]);
  const idPattern = new RegExp(`#${escapeRegExp(id)}(?![\\w-])`, "g");
  const scopeClass = `.${SCOPE_CLASS_PLACEHOLDER}`;
  const parts = withCssRules(rawCss, (rules) =>
    splitCssRules(
      rules,
      ids,
      (selector) => selector.replace(idPattern, scopeClass),
      (selector) => selector.replace(idPattern, (scope) => `${scopeClass}:where(${scope})`),
    ),
  );
  if (!parts?.shared) return null;

  const className = `${MERMAID_CSS_CLASS_PREFIX}${hashCss(parts.shared)}`;
  const css = parts.shared.replaceAll(scopeClass, `.${className}`);
  root.classList.add(className);
  if (parts.local) style.textContent = parts.local.replaceAll(scopeClass, `.${className}`);
  else style.remove();

  return { html: serialize(), className, css, hasLocalCss: !!parts.local };
}

/** One `<style>` per distinct CSS, owned by the preview that created it. */
export class MermaidStyleRegistry {
  private readonly nodes = new Map<string, HTMLStyleElement>();
  private readonly cssByClass = new Map<string, string>();

  constructor(
    private readonly host: HTMLElement,
    private readonly before: Element | null = null,
  ) {}

  add(className: string, css: string): void {
    if (this.nodes.has(className)) return;
    const node = document.createElement("style");
    node.setAttribute("data-mermaid-css", className);
    node.textContent = css;
    this.host.insertBefore(node, this.before);
    this.nodes.set(className, node);
    this.cssByClass.set(className, css);
  }

  cssFor(className: string): string | undefined {
    return this.cssByClass.get(className);
  }

  /** Drop stylesheet nodes that no SVG in the current article uses. */
  prune(usedClasses: Set<string>): void {
    for (const [className, node] of this.nodes) {
      if (usedClasses.has(className)) continue;
      node.remove();
      this.nodes.delete(className);
      this.cssByClass.delete(className);
    }
  }

  dispose(): void {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    this.cssByClass.clear();
  }
}

export function mermaidCssClassOf(svg: Element): string | undefined {
  return Array.from(svg.classList).find((name) => name.startsWith(MERMAID_CSS_CLASS_PREFIX));
}

/** The diagram viewer gets a detached copy of the SVG, so it needs the CSS
 *  that the preview keeps in its shared stylesheet. */
export function svgWithMermaidStyles(svg: Element, registry: MermaidStyleRegistry | undefined): string {
  const className = mermaidCssClassOf(svg);
  const css = className ? registry?.cssFor(className) : undefined;
  return css ? `<style>${css}</style>\n${svg.outerHTML}` : svg.outerHTML;
}
