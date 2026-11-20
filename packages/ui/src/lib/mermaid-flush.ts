type FlushFn = () => Promise<void>;

type Registration = { flush: FlushFn; isActive?: () => boolean };

const active = new Set<Registration>();

/** A Preview registers while it owns diagrams and unregisters on teardown.
 *  `isActive` lets split panes drain only the one that owns the shared TOC. */
export function registerMermaidFlush(flush: FlushFn, isActive?: () => boolean): () => void {
  const registration = { flush, isActive };
  active.add(registration);
  return () => { active.delete(registration); };
}

/** Resolves immediately when no preview is mounted. */
export async function flushPendingMermaid(): Promise<void> {
  await Promise.all(Array.from(active, (entry) =>
    entry.isActive?.() === false ? Promise.resolve() : entry.flush(),
  ));
}
