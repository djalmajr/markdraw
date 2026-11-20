export interface MermaidLazyRenderer {
  /** Resolves after the diagrams already in the initial viewport margin are done. */
  whenInitialDone(): Promise<void>;
  /** Draws every remaining diagram (used by PDF export). */
  flushAll(): Promise<void>;
  dispose(): void;
}

export interface MermaidLazyOptions {
  root: HTMLElement | null;
  blocks: HTMLElement[];
  render: (block: HTMLElement) => Promise<void>;
  /** Synchronous fast path, e.g. a cached SVG that needs no render queue. */
  tryImmediate?: (block: HTMLElement) => boolean;
  /** Injectable for tests; defaults to the global IntersectionObserver. */
  observer?: typeof IntersectionObserver | undefined;
}

export function createMermaidLazyRenderer(options: MermaidLazyOptions): MermaidLazyRenderer {
  const order = new Map(options.blocks.map((block, index) => [block, index]));
  const queued = new Set<HTMLElement>();
  const done = new Set<HTMLElement>();
  const initial = new Set<HTMLElement>();
  const queue: HTMLElement[] = [];
  const idleWaiters: Array<() => void> = [];
  const initialWaiters: Array<() => void> = [];
  let processing = false;
  let disposed = false;
  let pendingInitial = 0;
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;

  function release(waiters: Array<() => void>) {
    const waiting = waiters.splice(0);
    for (const resolve of waiting) resolve();
  }

  function complete(block: HTMLElement) {
    done.add(block);
    if (!initial.delete(block)) return;
    pendingInitial--;
    if (pendingInitial === 0) release(initialWaiters);
  }

  async function pump() {
    if (processing || disposed || queue.length === 0) return;
    processing = true;
    try {
      while (!disposed && queue.length > 0) {
        const block = queue.shift()!;
        queued.delete(block);
        if (done.has(block)) continue;
        try {
          await options.render(block);
        } catch {
          // The render callback records its own errors; never stall the queue.
        }
        complete(block);
        if (queue.length > 0 && !disposed) {
          // Macrotask: let input and paint through between diagrams.
          await new Promise<void>((resolve) => {
            pauseTimer = setTimeout(() => {
              pauseTimer = undefined;
              resolve();
            }, 0);
          });
        }
      }
    } finally {
      processing = false;
      if (queue.length === 0 || disposed) release(idleWaiters);
    }
  }

  function enqueue(block: HTMLElement, isInitial: boolean) {
    if (disposed || queued.has(block) || done.has(block) || !order.has(block)) return;
    if (options.tryImmediate?.(block)) {
      // Resolved synchronously: it was never a pending initial render, so it
      // must not take part in the initial counter (or underflow it).
      done.add(block);
      return;
    }
    if (isInitial) {
      initial.add(block);
      pendingInitial++;
    }
    queued.add(block);
    queue.push(block);
    queue.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    void pump();
  }

  const Observer = options.observer ?? globalThis.IntersectionObserver;
  let observer: IntersectionObserver | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let installedMargin: number | undefined;

  function rootHeight(): number {
    const rect = options.root?.getBoundingClientRect();
    return rect?.height || globalThis.innerHeight || 0;
  }

  function teardown(): void {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    resizeObserver?.disconnect();
    observer = undefined;
    resizeObserver = undefined;
    installedMargin = undefined;
    if (pauseTimer !== undefined) {
      clearTimeout(pauseTimer);
      pauseTimer = undefined;
    }
    queue.length = 0;
    queued.clear();
    release(idleWaiters);
    release(initialWaiters);
  }

  function connectObserver(): void {
    const margin = rootHeight();
    // Only the height feeds `rootMargin`: width-only resizes must not spend a
    // reconnect (and must not lose the targets already queued or done).
    if (observer && installedMargin === margin) return;
    observer?.disconnect();
    observer = undefined;
    installedMargin = undefined;
    if (!Observer || disposed) return;
    // `rootMargin` percentages resolve against the ROOT WIDTH; the seed below
    // uses the height. Keep both in pixels and rebuild on height change.
    observer = new Observer((entries) => {
      if (disposed) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer?.unobserve(entry.target);
        enqueue(entry.target as HTMLElement, false);
      }
    }, { root: options.root, rootMargin: `${margin}px 0px` });
    installedMargin = margin;
    for (const block of options.blocks) {
      if (done.has(block) || queued.has(block)) continue;
      observer.observe(block);
    }
  }

  // Seed the initial margin from layout. The observer only reports changes;
  // this synchronous pass is what `whenInitialDone` waits for, so post-
  // processing can settle without waiting for an observer delivery.
  const rootRect = options.root
    ? options.root.getBoundingClientRect()
    : { top: 0, bottom: globalThis.innerHeight ?? 0, height: globalThis.innerHeight ?? 0 };
  const margin = rootRect.height || 0;
  for (const block of options.blocks) {
    const rect = block.getBoundingClientRect();
    if (rect.bottom >= rootRect.top - margin && rect.top <= rootRect.bottom + margin) {
      enqueue(block, true);
    }
  }
  try {
    connectObserver();
    if (options.root && typeof globalThis.ResizeObserver === "function") {
      resizeObserver = new globalThis.ResizeObserver(() => {
        if (!disposed) connectObserver();
      });
      resizeObserver.observe(options.root);
    }
  } catch (error) {
    // A constructor can fail after the initial queue was seeded. Leave no
    // live observer or waiter behind; the caller releases its own readiness.
    teardown();
    throw error;
  }

  return {
    whenInitialDone() {
      if (pendingInitial === 0) return Promise.resolve();
      return new Promise<void>((resolve) => initialWaiters.push(resolve));
    },
    async flushAll() {
      if (disposed) return;
      for (const block of options.blocks) enqueue(block, false);
      if (!processing && queue.length === 0) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    dispose() {
      teardown();
    },
  };
}
