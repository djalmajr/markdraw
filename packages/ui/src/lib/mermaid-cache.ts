export const MERMAID_CONFIG = { look: "classic", layout: "dagre", securityLevel: "strict", fontFamily: "inherit" } as const;

export function mermaidCacheKey(source: string, theme: "dark" | "default"): string {
  return JSON.stringify([source, theme, MERMAID_CONFIG]);
}

type CacheEntry = { svg: string; className?: string };

export class MermaidCache {
  private entries = new Map<string, CacheEntry>();

  constructor(private limit = 200) {}

  get(key: string): string | undefined {
    return this.entries.get(key)?.svg;
  }

  /** Classe da folha compartilhada já associada ao SVG em cache. */
  classNameFor(key: string): string | undefined {
    return this.entries.get(key)?.className;
  }

  set(key: string, svg: string, className?: string): void {
    if (!this.entries.has(key) && this.entries.size >= this.limit) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { svg, className });
  }

  clear(): void {
    this.entries.clear();
  }
}

export const mermaidCache = new MermaidCache();
