import { beforeEach, describe, expect, it } from "bun:test";
import {
  type ChatSessionsIndex,
  type PersistedChatMessage,
  type PersistedChatSessionMeta,
  MAX_MESSAGES_PER_SESSION,
  MAX_MESSAGE_CONTENT_CHARS,
  MAX_SESSIONS,
  MAX_TOOLS_PER_MESSAGE,
  MAX_TOOL_JSON_BYTES,
  capMessages,
  cappedStringify,
  clearAllChatSessions,
  deleteChatMessages,
  enforceSessionCap,
  getChatMessages,
  getChatSessionsIndex,
  groupChatSessions,
  isQuotaError,
  searchChatSessions,
  setChatMessages,
  setChatSessionsIndex,
  toPersistedTool,
} from "./ai-chat-sessions.ts";
import { installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();

const INDEX_KEY = "markdraw-ai-chat-sessions";
const msgsKey = (id: string) => `markdraw-ai-chat-msgs-${id}`;

function meta(over: Partial<PersistedChatSessionMeta> = {}): PersistedChatSessionMeta {
  return {
    id: "s1",
    title: "Chat 1",
    createdAt: 1000,
    lastActiveAt: 2000,
    isArchived: false,
    isOpen: true,
    ...over,
  };
}

function quotaError(): unknown {
  try {
    return new DOMException("quota exceeded", "QuotaExceededError");
  } catch {
    const e = new Error("quota");
    e.name = "QuotaExceededError";
    return e;
  }
}

/** A localStorage stand-in whose `setItem` can be armed to throw quota errors a
 *  fixed number of times. Lets us drive the eviction path deterministically. */
function installQuotaMock(): { store: Map<string, string>; armQuota: (n: number) => void; armError: () => void } {
  const store = new Map<string, string>();
  let throwTimes = 0;
  let throwPlain = false;
  const mock = {
    clear() {
      store.clear();
    },
    getItem(k: string) {
      return store.get(k) ?? null;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    get length() {
      return store.size;
    },
    removeItem(k: string) {
      store.delete(k);
    },
    setItem(k: string, val: string) {
      if (throwPlain) throw new Error("boom");
      if (throwTimes > 0) {
        throwTimes--;
        throw quotaError();
      }
      store.set(k, val);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: mock });
  return {
    store,
    armQuota: (n: number) => {
      throwTimes = n;
    },
    armError: () => {
      throwPlain = true;
    },
  };
}

beforeEach(() => {
  // Restore the plain mock between tests (quota tests swap the global).
  installLocalStorageMock();
  localStorage.clear();
});

describe("sessions index round-trip", () => {
  it("returns null when nothing is stored", () => {
    expect(getChatSessionsIndex()).toBeNull();
  });

  it("round-trips an index of sessions + activeId", () => {
    const index: ChatSessionsIndex = { sessions: [meta(), meta({ id: "s2", title: "Chat 2" })], activeId: "s2" };
    setChatSessionsIndex(index);
    expect(getChatSessionsIndex()).toEqual(index);
  });

  it("an empty-but-valid index returns {sessions:[], activeId:null} (not null)", () => {
    // Distinguishes "user cleared all chats" from "fresh install".
    setChatSessionsIndex({ sessions: [], activeId: null });
    expect(getChatSessionsIndex()).toEqual({ sessions: [], activeId: null });
  });

  it("normalizes on write — stray runtime fields never reach storage", () => {
    const dirty = { ...meta(), streaming: true, store: {} } as unknown as PersistedChatSessionMeta;
    setChatSessionsIndex({ sessions: [dirty], activeId: "s1" });
    const raw = JSON.parse(localStorage.getItem(INDEX_KEY)!);
    expect(raw.sessions[0]).not.toHaveProperty("streaming");
    expect(raw.sessions[0]).not.toHaveProperty("store");
  });

  it("nulls a dangling activeId that points at a filtered-out session", () => {
    setChatSessionsIndex({ sessions: [meta()], activeId: "s1" });
    // Hand-corrupt: activeId points at a session that isn't present.
    localStorage.setItem(INDEX_KEY, JSON.stringify({ sessions: [meta()], activeId: "ghost" }));
    expect(getChatSessionsIndex()!.activeId).toBeNull();
  });

  it("filters malformed session entries but keeps the valid ones", () => {
    localStorage.setItem(
      INDEX_KEY,
      JSON.stringify({ sessions: [meta(), { broken: true }, { ...meta({ id: "s3" }), isOpen: "yes" }], activeId: "s1" }),
    );
    const index = getChatSessionsIndex()!;
    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0]!.id).toBe("s1");
  });

  it("returns null on malformed JSON (no throw)", () => {
    localStorage.setItem(INDEX_KEY, "{not json");
    expect(getChatSessionsIndex()).toBeNull();
  });

  it("round-trips a pinned session and persists isPinned only when true", () => {
    setChatSessionsIndex({ sessions: [meta({ isPinned: true }), meta({ id: "s2" })], activeId: "s1" });
    const raw = JSON.parse(localStorage.getItem(INDEX_KEY)!);
    expect(raw.sessions[0].isPinned).toBe(true);
    // Unpinned sessions stay lean — the key is omitted on write.
    expect(raw.sessions[1]).not.toHaveProperty("isPinned");
    expect(getChatSessionsIndex()!.sessions[0]!.isPinned).toBe(true);
  });

  it("migrates pre-pinning sessions (no isPinned key) without dropping them", () => {
    // A session persisted before pinning existed has no isPinned field.
    localStorage.setItem(
      INDEX_KEY,
      JSON.stringify({
        sessions: [{ id: "old", title: "Old", createdAt: 1, lastActiveAt: 2, isArchived: false, isOpen: true }],
        activeId: "old",
      }),
    );
    const index = getChatSessionsIndex()!;
    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0]!.isPinned).toBeUndefined();
  });
});

describe("messages round-trip", () => {
  const userTurn: PersistedChatMessage = { role: "user", content: "hi" };
  const asstTurn: PersistedChatMessage = {
    role: "assistant",
    content: "hello",
    tools: [{ toolCallId: "t1", toolName: "search", source: "mcp", status: "done", argsJson: '{"q":"x"}', resultJson: "[]" }],
  };

  it("returns [] when absent", () => {
    expect(getChatMessages("nope")).toEqual([]);
  });

  it("round-trips user + assistant turns with tools", () => {
    setChatMessages("s1", [userTurn, asstTurn]);
    expect(getChatMessages("s1")).toEqual([userTurn, asstTurn]);
  });

  it("round-trips a turn's usage telemetry (the schema must not strip it)", () => {
    const turn: PersistedChatMessage = {
      role: "assistant",
      content: "a",
      usage: { inputTokens: 10, outputTokens: 20, toolCalls: 1 },
    };
    setChatMessages("s1", [turn]);
    expect(getChatMessages("s1")).toEqual([turn]);
  });

  it("round-trips a user turn's context metadata without raw prompt content", () => {
    const turn: PersistedChatMessage = {
      role: "user",
      content: "create here",
      context: [
        {
          kind: "folder",
          label: "playwright/",
          path: "output/playwright",
          rootPath: "/repo",
          absolutePath: "/repo/output/playwright",
        },
      ],
    };
    setChatMessages("s1", [turn]);
    expect(getChatMessages("s1")).toEqual([turn]);
  });

  it("writing an empty list removes the key", () => {
    setChatMessages("s1", [userTurn]);
    setChatMessages("s1", []);
    expect(localStorage.getItem(msgsKey("s1"))).toBeNull();
  });

  it("deleteChatMessages removes the key", () => {
    setChatMessages("s1", [userTurn]);
    deleteChatMessages("s1");
    expect(localStorage.getItem(msgsKey("s1"))).toBeNull();
  });

  it("filters a garbage entry but keeps the valid messages", () => {
    localStorage.setItem(msgsKey("s1"), JSON.stringify([userTurn, { role: "bogus" }, asstTurn]));
    expect(getChatMessages("s1")).toEqual([userTurn, asstTurn]);
  });

  it("returns [] on malformed JSON", () => {
    localStorage.setItem(msgsKey("s1"), "nope");
    expect(getChatMessages("s1")).toEqual([]);
  });
});

describe("clearAllChatSessions", () => {
  it("removes every message blob and the index", () => {
    setChatSessionsIndex({ sessions: [meta(), meta({ id: "s2" })], activeId: "s1" });
    setChatMessages("s1", [{ role: "user", content: "a" }]);
    setChatMessages("s2", [{ role: "user", content: "b" }]);
    clearAllChatSessions();
    expect(localStorage.getItem(INDEX_KEY)).toBeNull();
    expect(localStorage.getItem(msgsKey("s1"))).toBeNull();
    expect(localStorage.getItem(msgsKey("s2"))).toBeNull();
  });
});

describe("tool capping", () => {
  it("cappedStringify returns the JSON for small values", () => {
    expect(cappedStringify({ a: 1 })).toBe('{"a":1}');
  });

  it("cappedStringify returns null for undefined", () => {
    expect(cappedStringify(undefined)).toBeNull();
  });

  it("cappedStringify returns null for an over-cap value (drops, never truncates)", () => {
    const big = { s: "x".repeat(MAX_TOOL_JSON_BYTES + 100) };
    expect(cappedStringify(big)).toBeNull();
  });

  it("cappedStringify returns null for a non-serializable value", () => {
    expect(cappedStringify({ n: 1n } as unknown)).toBeNull(); // BigInt throws in JSON.stringify
  });

  it("toPersistedTool preserves name/source/status and caps args/result", () => {
    const t = toPersistedTool({
      toolCallId: "c1",
      toolName: "grep",
      source: "app",
      status: "done",
      args: { q: "hi" },
      result: { rows: "y".repeat(MAX_TOOL_JSON_BYTES + 1) },
    });
    expect(t).toEqual({ toolCallId: "c1", toolName: "grep", source: "app", status: "done", argsJson: '{"q":"hi"}', resultJson: null });
  });

  it("toPersistedTool omits source when absent", () => {
    const t = toPersistedTool({ toolCallId: "c1", toolName: "x", status: "running" });
    expect(t).not.toHaveProperty("source");
    expect(t.argsJson).toBeNull();
  });
});

describe("capMessages", () => {
  it("truncates content over the cap and appends the sentinel", () => {
    const [msg] = capMessages([{ role: "assistant", content: "z".repeat(MAX_MESSAGE_CONTENT_CHARS + 50) }]);
    expect(msg!.content.length).toBe(MAX_MESSAGE_CONTENT_CHARS + "\n\n…[truncated]".length);
    expect(msg!.content.endsWith("…[truncated]")).toBe(true);
  });

  it("leaves under-cap content untouched", () => {
    const [msg] = capMessages([{ role: "user", content: "short" }]);
    expect(msg!.content).toBe("short");
  });

  it("keeps only the last MAX_MESSAGES_PER_SESSION", () => {
    const many: PersistedChatMessage[] = Array.from({ length: MAX_MESSAGES_PER_SESSION + 10 }, (_, i) => ({
      role: "user",
      content: `m${i}`,
    }));
    const out = capMessages(many);
    expect(out).toHaveLength(MAX_MESSAGES_PER_SESSION);
    expect(out[0]!.content).toBe("m10"); // first 10 dropped
  });

  it("caps the tool array per message", () => {
    const tools = Array.from({ length: MAX_TOOLS_PER_MESSAGE + 5 }, (_, i) => ({
      toolCallId: `t${i}`,
      toolName: "x",
      status: "done" as const,
      argsJson: null,
      resultJson: null,
    }));
    const [msg] = capMessages([{ role: "assistant", content: "c", tools }]);
    expect(msg!.tools).toHaveLength(MAX_TOOLS_PER_MESSAGE);
  });
});

describe("isQuotaError", () => {
  it("is true for a QuotaExceededError DOMException", () => {
    expect(isQuotaError(quotaError())).toBe(true);
  });

  it("is false for a plain Error", () => {
    expect(isQuotaError(new Error("nope"))).toBe(false);
  });
});

describe("enforceSessionCap", () => {
  it("is a no-op under the cap", () => {
    const index: ChatSessionsIndex = { sessions: [meta()], activeId: "s1" };
    expect(enforceSessionCap(index)).toEqual({ index, evictedIds: [] });
  });

  it("trims to MAX_SESSIONS, evicting archived-oldest first and never the active one", () => {
    const sessions: PersistedChatSessionMeta[] = [];
    // 3 over the cap: make some archived + old so they're chosen first.
    for (let i = 0; i < MAX_SESSIONS + 3; i++) {
      sessions.push(meta({ id: `s${i}`, lastActiveAt: i, isArchived: i < 3, isOpen: true }));
    }
    const active = `s${MAX_SESSIONS + 2}`;
    const { index, evictedIds } = enforceSessionCap({ sessions, activeId: active });
    expect(index.sessions).toHaveLength(MAX_SESSIONS);
    expect(evictedIds).toHaveLength(3);
    // The three oldest archived sessions are evicted; the active survives.
    expect(evictedIds).toEqual(["s0", "s1", "s2"]);
    expect(index.sessions.some((s) => s.id === active)).toBe(true);
  });
});

describe("quota guard (eviction)", () => {
  it("evicts an archived session's blob and retries once", () => {
    const q = installQuotaMock();
    // Seed: one archived (old) session with a message blob, plus an active one.
    setChatSessionsIndex({
      sessions: [meta({ id: "old", isArchived: true, lastActiveAt: 1 }), meta({ id: "active", lastActiveAt: 9 })],
      activeId: "active",
    });
    setChatMessages("old", [{ role: "user", content: "old msg" }]);
    expect(q.store.has(msgsKey("old"))).toBe(true);

    // Arm a single quota throw: the next message write fails → evict → retry.
    q.armQuota(1);
    setChatMessages("active", [{ role: "user", content: "new msg" }]);

    expect(q.store.has(msgsKey("old"))).toBe(false); // archived blob evicted
    expect(q.store.has(msgsKey("active"))).toBe(true); // retry succeeded
    expect(getChatSessionsIndex()!.sessions.some((s) => s.id === "old")).toBe(false);
  });

  it("gives up silently under persistent quota (never throws)", () => {
    const q = installQuotaMock();
    q.armQuota(Number.POSITIVE_INFINITY);
    expect(() => setChatMessages("s1", [{ role: "user", content: "x" }])).not.toThrow();
  });

  it("rethrows a non-quota error", () => {
    const q = installQuotaMock();
    q.armError();
    expect(() => setChatMessages("s1", [{ role: "user", content: "x" }])).toThrow();
  });
});

describe("groupChatSessions", () => {
  const now = new Date("2026-06-07T12:00:00").getTime();
  const dayMs = 86_400_000;

  it("buckets by lastActiveAt; archived bypasses date buckets", () => {
    const sessions: PersistedChatSessionMeta[] = [
      meta({ id: "t", lastActiveAt: now - 1000 }),
      meta({ id: "y", lastActiveAt: now - dayMs - 1000 }),
      meta({ id: "w", lastActiveAt: now - 3 * dayMs }),
      meta({ id: "o", lastActiveAt: now - 30 * dayMs }),
      meta({ id: "a", lastActiveAt: now - 1000, isArchived: true }),
    ];
    const g = groupChatSessions(sessions, now);
    expect(g.today.map((s) => s.id)).toEqual(["t"]);
    expect(g.yesterday.map((s) => s.id)).toEqual(["y"]);
    expect(g.previous7Days.map((s) => s.id)).toEqual(["w"]);
    expect(g.older.map((s) => s.id)).toEqual(["o"]);
    expect(g.archived.map((s) => s.id)).toEqual(["a"]);
  });

  it("sorts each bucket most-recent first and does not mutate the input", () => {
    const input: PersistedChatSessionMeta[] = [
      meta({ id: "old", lastActiveAt: now - 1000 }),
      meta({ id: "new", lastActiveAt: now - 10 }),
    ];
    const snapshot = JSON.stringify(input);
    const g = groupChatSessions(input, now);
    expect(g.today.map((s) => s.id)).toEqual(["new", "old"]);
    expect(JSON.stringify(input)).toBe(snapshot); // pure
  });
});

describe("searchChatSessions", () => {
  const sessions = [meta({ id: "1", title: "Project status" }), meta({ id: "2", title: "Review section" })];

  it("matches title case-insensitively", () => {
    expect(searchChatSessions(sessions, "PROJECT").map((s) => s.id)).toEqual(["1"]);
  });

  it("returns all for an empty/whitespace query", () => {
    expect(searchChatSessions(sessions, "  ")).toHaveLength(2);
  });

  it("returns [] when nothing matches and does not mutate the input", () => {
    const snapshot = JSON.stringify(sessions);
    expect(searchChatSessions(sessions, "zzz")).toEqual([]);
    expect(JSON.stringify(sessions)).toBe(snapshot);
  });
});
