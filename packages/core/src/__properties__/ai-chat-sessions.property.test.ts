import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  type ChatSessionsIndex,
  type PersistedChatSessionMeta,
  MAX_SESSIONS,
  enforceSessionCap,
  groupChatSessions,
} from "../ai-chat-sessions.ts";

const metaArb: fc.Arbitrary<PersistedChatSessionMeta> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  title: fc.string({ maxLength: 30 }),
  createdAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  lastActiveAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  isArchived: fc.boolean(),
  isOpen: fc.boolean(),
});

// Unique ids so set-based assertions hold.
const sessionsArb: fc.Arbitrary<PersistedChatSessionMeta[]> = fc
  .array(metaArb, { minLength: 0, maxLength: MAX_SESSIONS + 30 })
  .map((arr) => {
    const seen = new Set<string>();
    return arr.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  });

describe("ai-chat-sessions invariants (property)", () => {
  it("enforceSessionCap always yields at most MAX_SESSIONS", () => {
    fc.assert(
      fc.property(sessionsArb, (sessions) => {
        const activeId = sessions.length ? sessions[0]!.id : null;
        const index: ChatSessionsIndex = { sessions, activeId };
        const { index: capped } = enforceSessionCap(index);
        expect(capped.sessions.length).toBeLessThanOrEqual(MAX_SESSIONS);
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("enforceSessionCap never evicts the active session", () => {
    fc.assert(
      fc.property(sessionsArb, (sessions) => {
        if (sessions.length === 0) return true;
        const activeId = sessions[0]!.id;
        const { index: capped, evictedIds } = enforceSessionCap({ sessions, activeId });
        expect(evictedIds).not.toContain(activeId);
        expect(capped.sessions.some((s) => s.id === activeId)).toBe(true);
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("groupChatSessions partitions exactly — every session lands in one bucket", () => {
    fc.assert(
      fc.property(sessionsArb, fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }), (sessions, now) => {
        const g = groupChatSessions(sessions, now);
        const total = g.today.length + g.yesterday.length + g.previous7Days.length + g.older.length + g.archived.length;
        expect(total).toBe(sessions.length);
        // Each id appears exactly once across all buckets.
        const ids = [...g.today, ...g.yesterday, ...g.previous7Days, ...g.older, ...g.archived].map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(ids)).toEqual(new Set(sessions.map((s) => s.id)));
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it("archived sessions always go to the archived bucket regardless of date", () => {
    fc.assert(
      fc.property(sessionsArb, fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }), (sessions, now) => {
        const g = groupChatSessions(sessions, now);
        const archivedIds = new Set(sessions.filter((s) => s.isArchived).map((s) => s.id));
        expect(new Set(g.archived.map((s) => s.id))).toEqual(archivedIds);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
