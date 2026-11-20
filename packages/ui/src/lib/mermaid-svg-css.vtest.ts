import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidStyleRegistry, prepareMermaidSvg, svgWithMermaidStyles } from "./mermaid-svg-css.ts";

// happy-dom exposes a constructible CSSStyleSheet, but its
// CSSStyleRule.selectorText has no setter, so the real CSSOM path throws.
// This injects the smallest mutable CSSOM needed to exercise the browser path.
class MutableRule {
  selectorText: string | undefined;
  readonly cssRules: MutableRule[];
  constructor(
    readonly prelude: string,
    readonly body: string,
    nested: MutableRule[],
  ) {
    this.selectorText = prelude.startsWith("@") ? undefined : prelude;
    this.cssRules = nested;
  }
  get cssText(): string {
    return this.selectorText !== undefined
      ? `${this.selectorText} { ${this.body} }`
      : `${this.prelude} {\n${this.cssRules.map((rule) => `  ${rule.cssText}`).join("\n")}\n}`;
  }
}

function parseRules(css: string): MutableRule[] {
  const rules: MutableRule[] = [];
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace < 0) break;
    const prelude = css.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    const body = css.slice(brace + 1, j - 1);
    rules.push(prelude.startsWith("@")
      ? new MutableRule(prelude, "", parseRules(body))
      : new MutableRule(prelude, body.trim(), []));
    i = j;
  }
  return rules;
}

class InjectableCSSStyleSheet {
  cssRules: MutableRule[] = [];
  replaceSync(css: string): void { this.cssRules = parseRules(css); }
}

beforeEach(() => { vi.stubGlobal("CSSStyleSheet", InjectableCSSStyleSheet); });
afterEach(() => { vi.unstubAllGlobals(); });

// Trecho verbatim da folha gerada por mermaid 12.3.0 (`getStyles` em
// `dist/chunks/mermaid.core/chunk-BG4553SI.mjs`, o mesmo caminho usado por
// `createUserStyles` dentro de `mermaid.render`), com o escopo `#mermaid-1`.
// O `mermaid.render` em happy-dom devolve um SVG vazio, então a fixture é da
// folha real do tema, capturada com `styles_default` + as variáveis do tema.
const REAL_CSS = `#mermaid-1 {
    font-family: inherit;
    font-size: 16px;
    fill: #333
  }
  @keyframes edge-animation-frame {
    from {
      stroke-dashoffset: 0;
    }
  }
  #mermaid-1 .edge-animation-slow {
    stroke-dasharray: 9,5 !important;
    stroke-dashoffset: 900;
    animation: dash 50s linear infinite;
    stroke-linecap: round;
  }
  #mermaid-1 .marker {
    fill: #333333;
    stroke: #333333;
  }
  #mermaid-1 svg {
    font-family: inherit;
    font-size: 16px;
  }
   #mermaid-1 p {
    margin: 0
   }
  .edge-pattern-dotted {
    stroke-dasharray: 2;
  }
  :root { --mermaid-font-family: inherit }`;

function svgWithCss(id: string, css: string): string {
  return `<svg id="${id}" viewBox="0 0 10 20"><style>${css.replaceAll("#mermaid-1", `#${id}`)}</style><text>diagram</text></svg>`;
}

describe("prepareMermaidSvg", () => {
  it("reescreve cada regra com escopo de id para a classe e remove o <style> do SVG", () => {
    const original = svgWithCss("mermaid-1", REAL_CSS);
    const prepared = prepareMermaidSvg(original);
    expect(prepared).not.toBeNull();
    const { html, css, className } = prepared!;

    expect(html).not.toContain("<style");
    expect(html).toContain(`class="${className}"`);
    expect(html).toContain("<text>diagram</text>");

    const scoped = REAL_CSS.match(/#mermaid-1[^{]*\{/g) ?? [];
    expect(scoped.length).toBeGreaterThan(4);
    for (const rule of scoped) {
      const selector = rule.slice(0, -1).trim();
      expect(css).toContain(`.${className}${selector.slice("#mermaid-1".length)} {`);
    }
    expect(css).toContain(".edge-pattern-dotted");
    expect(css).toContain("stroke-dasharray: 2;");
    expect(css).toContain("@keyframes edge-animation-frame");
    expect(css).toContain(":root { --mermaid-font-family: inherit }");
    expect(css).not.toContain("#mermaid-1");
  });

  it("gera uma classe por CSS distinto e reusa a mesma para CSS idêntico", () => {
    const a = prepareMermaidSvg(svgWithCss("mermaid-1", REAL_CSS))!;
    const b = prepareMermaidSvg(svgWithCss("mermaid-2", REAL_CSS))!;
    const other = prepareMermaidSvg(svgWithCss("mermaid-3", REAL_CSS.replace("fill: #333", "fill: #444")))!;
    expect(a.className).toBe(b.className);
    expect(a.css).toBe(b.css);
    expect(other.className).not.toBe(a.className);

    const host = document.createElement("div");
    const registry = new MermaidStyleRegistry(host);
    registry.add(a.className, a.css);
    registry.add(b.className, b.css);
    registry.add(other.className, other.css);
    expect(host.querySelectorAll("style[data-mermaid-css]")).toHaveLength(2);
    expect(registry.cssFor(a.className)).toBe(a.css);
    registry.prune(new Set([a.className]));
    expect(host.querySelectorAll("style[data-mermaid-css]")).toHaveLength(1);
    registry.prune(new Set());
    expect(host.querySelectorAll("style[data-mermaid-css]")).toHaveLength(0);
    registry.add(a.className, a.css);
    registry.add(other.className, other.css);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", a.className);
    expect(svgWithMermaidStyles(svg, registry)).toContain(`<style>${a.css}</style>`);
    registry.dispose();
    expect(host.querySelectorAll("style")).toHaveLength(0);
  });

  it("F5: reescreve só seletores recursivamente e preserva declarações com #id", () => {
    const css = `#mermaid-1 { fill: #333 }
@media print {
  #mermaid-1 p::before { content: "#mermaid-1" }
  @supports (display: grid) {
    #mermaid-1 a[href="#mermaid-1"] { fill: url(#mermaid-1) }
  }
}
@keyframes pulse { from { opacity: 0 } to { opacity: 1 } }`;
    const prepared = prepareMermaidSvg(
      `<svg id="mermaid-1" viewBox="0 0 10 20"><style>${css}</style><text>x</text></svg>`,
    )!;
    expect(prepared).not.toBeNull();
    expect(prepared.html).not.toContain("<style");
    expect(prepared.html).toContain(`class="${prepared.className}"`);
    expect(prepared.css).toContain(`.${prepared.className} { fill: #333 }`);
    expect(prepared.css).toContain("@media print");
    expect(prepared.css).toContain(`@supports (display: grid)`);
    expect(prepared.css).toContain(`.${prepared.className} p::before { content: "#mermaid-1" }`);
    expect(prepared.css).toContain(`[href="#mermaid-1"] { fill: url(#mermaid-1) }`);
    expect(prepared.css).toContain("@keyframes pulse");
    expect(prepared.css).not.toContain("#mermaid-1 {");
    expect(prepared.css).not.toContain("#mermaid-1 p");
  });

  it("F5: sem CSSOM construível mantém o <style> dentro do SVG", () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    const original = svgWithCss("mermaid-1", REAL_CSS);
    expect(prepareMermaidSvg(original)).toBeNull();
    vi.stubGlobal("CSSStyleSheet", class {
      constructor() { throw new Error("no CSSOM"); }
    });
    expect(prepareMermaidSvg(original)).toBeNull();
  });
});
