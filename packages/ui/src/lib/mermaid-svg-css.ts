const SCOPE_CLASS_PLACEHOLDER = "__mermaid_css_scope__";
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

/** Rewrites only selector text, with the browser's CSS parser, leaving every
 *  declaration (`content`, `url(#…)`, …) untouched. Returns null when the
 *  constructible stylesheet API is missing or rejects the sheet: the caller
 *  then keeps the original inline <style>. */
export function rewriteMermaidCss(css: string, id: string, className: string): string | null {
  try {
    const Sheet = globalThis.CSSStyleSheet;
    if (typeof Sheet !== "function") return null;
    const sheet = new Sheet();
    if (typeof sheet.replaceSync !== "function") return null;
    sheet.replaceSync(css);
    const idPattern = new RegExp(`#${escapeRegExp(id)}(?![\\w-])`, "g");
    const rewriteSelector = (selector: string) =>
      // Never rewrite a fragment-looking string inside an attribute selector.
      selector.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)
        .map((part, index) => index % 2 ? part : part.replace(idPattern, `.${className}`))
        .join("");
    const visit = (rules: CSSRuleList): string[] => Array.from(rules).map((rule) => {
      const selectorText = (rule as CSSStyleRule).selectorText;
      if (typeof selectorText === "string") {
        (rule as CSSStyleRule).selectorText = rewriteSelector(selectorText);
      } else {
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested) visit(nested);
      }
      return rule.cssText;
    });
    return visit(sheet.cssRules).join("\n");
  } catch {
    return null;
  }
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

/** Take the `<style>` out of a rendered Mermaid SVG and make its id scope a
 *  class, so identical CSS from different diagrams can share one stylesheet. */
export function prepareMermaidSvg(svg: string): { html: string; className: string; css: string } | null {
  const { root, serialize } = parseSvgMarkup(svg);
  if (!root) return null;

  const style = Array.from(root.querySelectorAll("*")).find((el) => el.localName === "style");
  const rawCss = style?.textContent ?? "";
  const id = root.getAttribute("id") ?? "";
  if (!style || !id || !rawCss.trim()) return null;

  // Rewrite through the CSSOM first, with a placeholder class so the hash is
  // the same for CSS coming from different diagram ids. If the browser cannot
  // do it, leave the SVG untouched (the inline <style> stays with it).
  const normalized = rewriteMermaidCss(rawCss, id, SCOPE_CLASS_PLACEHOLDER);
  if (normalized === null) return null;
  style.remove();

  const className = `${MERMAID_CSS_CLASS_PREFIX}${hashCss(normalized)}`;
  const css = normalized.split(`.${SCOPE_CLASS_PLACEHOLDER}`).join(`.${className}`);
  root.classList.add(className);

  return { html: serialize(), className, css };
}

/** One `<style>` per distinct CSS, owned by the preview that created it. */
export class MermaidStyleRegistry {
  private readonly nodes = new Map<string, HTMLStyleElement>();
  private readonly cssByClass = new Map<string, string>();

  constructor(private readonly host: HTMLElement) {}

  add(className: string, css: string): void {
    if (this.nodes.has(className)) return;
    const node = document.createElement("style");
    node.setAttribute("data-mermaid-css", className);
    node.textContent = css;
    this.host.appendChild(node);
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
