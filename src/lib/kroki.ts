const KROKI_BASE = "https://kroki.io";

const SUPPORTED_TYPES = new Set([
  "blockdiag",
  "c4plantuml",
  "ditaa",
  "erd",
  "excalidraw",
  "graphviz",
  "mermaid",
  "nomnoml",
  "nwdiag",
  "packetdiag",
  "plantuml",
  "rackdiag",
  "seqdiag",
  "svgbob",
  "vega",
  "vegalite",
  "wavedrom",
]);

// Simple in-memory cache keyed by type+source hash
const cache = new Map<string, string>();

function hashKey(type: string, source: string): string {
  return `${type}:${source}`;
}

async function renderKroki(type: string, source: string): Promise<string> {
  const key = hashKey(type, source);
  const cached = cache.get(key);
  if (cached) return cached;

  const response = await fetch(`${KROKI_BASE}/${type}/svg`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: source,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kroki error (${response.status}): ${errText}`);
  }

  const svg = await response.text();
  cache.set(key, svg);
  return svg;
}

function isSupportedKrokiType(type: string): boolean {
  return SUPPORTED_TYPES.has(type.toLowerCase());
}

export { isSupportedKrokiType, renderKroki, SUPPORTED_TYPES };
