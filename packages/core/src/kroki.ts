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
type PendingRequest = {
  promise: Promise<string>;
  controller: AbortController;
  consumers: number;
};
const inFlight = new Map<string, PendingRequest>();
const waiting: Array<() => void> = [];
let active = 0;
const MAX_CONCURRENT = 4;
// A request that holds a slot can block every other pane's diagrams (the
// limit is global), so a slow or stalled POST gives its slot back after this.
let requestTimeoutMs = 20_000;
/** Test hook: shorten the per-request timeout. */
function setKrokiRequestTimeoutMs(ms: number): void {
  requestTimeoutMs = ms;
}

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

function hashKey(type: string, source: string): string {
  return `${type}:${source}`;
}

async function renderKroki(type: string, source: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException("Kroki request abandoned", "AbortError");
  const key = hashKey(type, source);
  const cached = cache.get(key);
  if (cached) return cached;

  let pending = inFlight.get(key);
  if (!pending) {
    const controller = new AbortController();
    const entry: PendingRequest = { controller, consumers: 0, promise: undefined! };
    entry.promise = (async () => {
      await acquire();
      const timer = setTimeout(
        () => controller.abort(new DOMException("Kroki request timed out", "TimeoutError")),
        requestTimeoutMs,
      );
      try {
        if (controller.signal.aborted) throw new DOMException("Kroki request abandoned", "AbortError");
        const response = await fetch(`${KROKI_BASE}/${type}/svg`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: source,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Kroki error (${response.status}): ${errText}`);
        }

        const svg = await response.text();
        if (controller.signal.aborted) throw new DOMException("Kroki request abandoned", "AbortError");
        cache.set(key, svg);
        return svg;
      } finally {
        clearTimeout(timer);
        release();
        if (inFlight.get(key) === entry) inFlight.delete(key);
      }
    })();
    inFlight.set(key, entry);
    pending = entry;
  }

  const entry = pending;
  entry.consumers++;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      entry.consumers--;
      return true;
    };
    const onAbort = () => {
      if (!finish()) return;
      if (entry.consumers === 0) {
        if (inFlight.get(key) === entry) inFlight.delete(key);
        entry.controller.abort();
      }
      reject(new DOMException("Kroki request abandoned", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (svg) => { if (finish()) resolve(svg); },
      (error) => { if (finish()) reject(error); },
    );
  });
}

function isSupportedKrokiType(type: string): boolean {
  return SUPPORTED_TYPES.has(type.toLowerCase());
}

export { isSupportedKrokiType, renderKroki, setKrokiRequestTimeoutMs, SUPPORTED_TYPES };
