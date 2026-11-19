export class MermaidCache {
  private entries = new Map<string, string>();

  constructor(private limit = 200) {}

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, svg: string): void {
    if (!this.entries.has(key) && this.entries.size >= this.limit) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, svg);
  }

  clear(): void {
    this.entries.clear();
  }
}

export const mermaidCache = new MermaidCache();
