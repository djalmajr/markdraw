import { beforeEach, describe, expect, it } from "vitest";
import { createRoot, flush, getOwner, runWithOwner, type Owner } from "solid-js";
import type { AIProvider } from "@markdraw/ai/types.ts";
import { getChatMessages, setChatMessages } from "@markdraw/core/ai-chat-sessions.ts";
import { createAiChatSessions, deriveAiChatTitle } from "./create-ai-chat-sessions.ts";

/** Replays a fixed stream. */
function stubProvider(text = "ok"): AIProvider {
  return {
    async *chat() {
      yield { type: "text-delta", text };
      yield { type: "done" };
    },
    async complete() {
      return "";
    },
    async embed() {
      return [];
    },
  };
}

/** Streams "A", pauses on a manual gate, then "B" + done — unless aborted. */
function gatedProvider(): { provider: AIProvider; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    release: () => release(),
    provider: {
      async *chat(_messages, opts) {
        yield { type: "text-delta", text: "A" };
        await gate;
        if (opts?.signal?.aborted) {
          yield { type: "error", code: "aborted", message: "aborted" };
          return;
        }
        yield { type: "text-delta", text: "B" };
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
      async embed() {
        return [];
      },
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Keep a disposable owner for the manager's signals and per-session effects,
 *  but run the test body (where the lifecycle methods write state) outside that
 *  owned scope — Solid 2 forbids writes from a component/computation body.
 *  `create` is the only callback that runs under the owner. */
function withRoot<T>(fn: (create: <R>(init: () => R) => R) => Promise<T> | T): Promise<T> {
  let owner!: Owner;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    owner = getOwner()!;
  });
  const create = <R>(init: () => R): R => runWithOwner(owner, init);
  return Promise.resolve()
    .then(() => fn(create))
    .then(
      (v) => {
        dispose();
        return v;
      },
      (e) => {
        dispose();
        throw e;
      },
    );
}

beforeEach(() => {
  localStorage.clear();
});

describe("deriveAiChatTitle", () => {
  it("collapses whitespace and truncates over 40 chars", () => {
    expect(deriveAiChatTitle("  hello   world  ")).toBe("hello world");
    expect(deriveAiChatTitle("x".repeat(60))).toHaveLength(40); // 39 + ellipsis
    expect(deriveAiChatTitle("   ")).toBe("");
  });
});

describe("createAiChatSessions — debounced saves", () => {
  it("drops a pending save when the manager is disposed", async () => {
    await withRoot((create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      mgr.createSession();
      flush();
    });
    // The index save was scheduled 500 ms after createSession; the owner is
    // gone now, so it must never run (in a torn-down test environment it would
    // throw "localStorage is not defined").
    await new Promise((r) => setTimeout(r, 650));
    expect(localStorage.getItem("markdraw-ai-chat-sessions")).toBeNull();
  });
});

describe("createAiChatSessions — lifecycle", () => {
  it("createSession adds an open session and activates it", async () => {
    await withRoot((create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      const id = mgr.createSession();
      flush();
      expect(mgr.activeId()).toBe(id);
      expect(mgr.sessions().map((s) => s.id)).toEqual([id]);
      expect(mgr.activeStore()).toBe(mgr.storeFor(id));
    });
  });

  it("closing the active chat activates the nearest neighbor", async () => {
    await withRoot((create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      const a = mgr.createSession();
      const b = mgr.createSession();
      const c = mgr.createSession();
      flush();
      mgr.activateSession(b);
      flush();
      mgr.closeSession(b);
      flush();
      // Neighbor at clamped index → c (the one that took b's slot).
      expect(mgr.activeId()).toBe(c);
      expect(mgr.sessions().map((s) => s.id)).toEqual([a, c]);
      // b survives in history as closed.
      expect(mgr.allSessions().find((s) => s.id === b)?.isOpen).toBe(false);
    });
  });

  it("closing the last chat clears active and yields the empty store", async () => {
    await withRoot((create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      const a = mgr.createSession();
      flush();
      mgr.closeSession(a);
      flush();
      expect(mgr.activeId()).toBeNull();
      expect(mgr.sessions()).toEqual([]);
      // activeStore() must not throw and must be a usable store.
      expect(typeof mgr.activeStore().messages).toBe("function");
      expect(mgr.activeStore().messages()).toEqual([]);
    });
  });

  it("archive removes from the strip but keeps the session in history", async () => {
    await withRoot((create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      const a = mgr.createSession();
      flush();
      mgr.archiveSession(a);
      flush();
      expect(mgr.sessions()).toEqual([]);
      expect(mgr.allSessions().find((s) => s.id === a)?.isArchived).toBe(true);
      expect(mgr.storeFor(a)).toBeUndefined(); // live store disposed
    });
  });

  it("openFromHistory reopens a closed chat with its persisted messages", async () => {
    await withRoot(async (create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      // Seed a closed session's messages directly in storage.
      setChatMessages("old", [{ role: "user", content: "remember me" }]);
      mgr.hydrate({
        sessions: [{ id: "old", title: "Old", createdAt: 1, lastActiveAt: 1, isArchived: false, isOpen: false }],
        activeId: null,
      });
      flush();
      expect(mgr.sessions()).toEqual([]); // closed → not in strip
      mgr.openFromHistory("old");
      flush();
      expect(mgr.activeId()).toBe("old");
      expect(mgr.storeFor("old")!.messages()).toEqual([{ role: "user", content: "remember me" }]);
    });
  });

  it("deleteSession aborts, removes the session and its messages", async () => {
    await withRoot(async (create) => {
      const { provider, release } = gatedProvider();
      const mgr = create(() => createAiChatSessions({ getProvider: () => provider }));
      const a = mgr.createSession();
      flush();
      const pending = mgr.storeFor(a)!.sendMessage("hi");
      await tick();
      expect(mgr.storeFor(a)!.streaming()).toBe(true);
      mgr.deleteSession(a);
      flush();
      release();
      await pending.catch(() => {});
      expect(mgr.allSessions().find((s) => s.id === a)).toBeUndefined();
      expect(localStorage.getItem("markdraw-ai-chat-msgs-" + a)).toBeNull();
    });
  });
});

describe("createAiChatSessions — fork", () => {
  it("forkSession copies the messages into a new active session that evolves separately", async () => {
    await withRoot(async (create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider("ok") }));
      const a = mgr.createSession();
      flush();
      await mgr.storeFor(a)!.sendMessage("hello");
      flush();
      const fork = mgr.forkSession(a);
      flush();
      expect(fork).not.toBeNull();
      expect(fork).not.toBe(a);
      // The fork opens active with the source's turns copied over…
      expect(mgr.activeId()).toBe(fork);
      expect(mgr.storeFor(fork!)!.messages()).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
      ]);
      // …in its OWN store (no shared state with the source).
      expect(mgr.storeFor(fork!)).not.toBe(mgr.storeFor(a));
      // Title carries over from the source.
      expect(mgr.allSessions().find((s) => s.id === fork)?.title).toBe("hello");
      // Separate evolution: a send on the fork must not touch the source.
      const sourceBefore = mgr.storeFor(a)!.messages();
      await mgr.storeFor(fork!)!.sendMessage("only in fork");
      expect(mgr.storeFor(a)!.messages()).toEqual(sourceBefore);
      expect(mgr.storeFor(fork!)!.messages()).toHaveLength(4);
      // Persistence: the index gains the new session and the copied turns are
      // durable immediately (no debounce window).
      expect(mgr.snapshot().sessions.map((s) => s.id)).toContain(fork);
      expect(getChatMessages(fork!).map((msg) => msg.content)).toEqual(
        expect.arrayContaining(["hello", "ok"]),
      );
    });
  });

  it("forkSession returns null for an unknown id", async () => {
    await withRoot((create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      expect(mgr.forkSession("nope")).toBeNull();
      expect(mgr.allSessions()).toEqual([]);
    });
  });
});

describe("createAiChatSessions — streaming isolation", () => {
  it("a background chat keeps streaming after switching away", async () => {
    await withRoot(async (create) => {
      const { provider, release } = gatedProvider();
      const mgr = create(() => createAiChatSessions({ getProvider: () => provider }));
      const a = mgr.createSession();
      flush();
      const pendingA = mgr.storeFor(a)!.sendMessage("hi");
      await tick();
      expect(mgr.storeFor(a)!.streaming()).toBe(true);

      // Switch to a fresh chat — must NOT abort A.
      const b = mgr.createSession();
      flush();
      expect(mgr.activeId()).toBe(b);
      expect(mgr.storeFor(a)!.streaming()).toBe(true);

      release();
      await pendingA;
      expect(mgr.storeFor(a)!.messages().at(-1)).toEqual({ role: "assistant", content: "AB" });
      expect(mgr.storeFor(b)!.messages()).toEqual([]); // B untouched
    });
  });
});

describe("createAiChatSessions — titles", () => {
  it("derives the title from the first user message, once; rename wins", async () => {
    await withRoot(async (create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      const a = mgr.createSession();
      flush();
      expect(mgr.allSessions()[0]!.title).toBe(""); // untitled
      await mgr.storeFor(a)!.sendMessage("Plan the release");
      flush();
      expect(mgr.allSessions()[0]!.title).toBe("Plan the release");
      mgr.renameSession(a, "Release notes");
      flush();
      await mgr.storeFor(a)!.sendMessage("another message");
      flush();
      expect(mgr.allSessions()[0]!.title).toBe("Release notes"); // not overwritten
    });
  });
});

describe("createAiChatSessions — hydrate", () => {
  it("rebuilds only open sessions and restores the active id", async () => {
    await withRoot((create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      setChatMessages("open1", [{ role: "user", content: "x" }]);
      const restored = mgr.hydrate({
        sessions: [
          { id: "open1", title: "Open", createdAt: 1, lastActiveAt: 5, isArchived: false, isOpen: true },
          { id: "arch1", title: "Arch", createdAt: 1, lastActiveAt: 2, isArchived: true, isOpen: false },
        ],
        activeId: "open1",
      });
      flush();
      expect(restored.sessions.map((s) => s.id)).toEqual(["open1"]);
      expect(restored.activeId).toBe("open1");
      expect(mgr.sessions().map((s) => s.id)).toEqual(["open1"]);
      expect(mgr.allSessions()).toHaveLength(2);
      expect(mgr.activeId()).toBe("open1");
      expect(mgr.storeFor("open1")!.messages()).toEqual([{ role: "user", content: "x" }]);
      expect(mgr.storeFor("arch1")).toBeUndefined();
    });
  });

  it("drops a dangling activeId that is not open", async () => {
    await withRoot((create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      mgr.hydrate({
        sessions: [{ id: "c", title: "Closed", createdAt: 1, lastActiveAt: 1, isArchived: false, isOpen: false }],
        activeId: "c",
      });
      flush();
      expect(mgr.activeId()).toBeNull();
    });
  });

  it("returns exactly the rebuilt open sessions and nulls a non-live active id", async () => {
    await withRoot((create) => {
      const mgr = create(() => createAiChatSessions({ getProvider: () => stubProvider() }));
      const restored = mgr.hydrate({
        sessions: [
          { id: "open2", title: "Open 2", createdAt: 1, lastActiveAt: 6, isArchived: false, isOpen: true },
          { id: "closed", title: "Closed", createdAt: 1, lastActiveAt: 5, isArchived: false, isOpen: false },
          { id: "archived", title: "Archived", createdAt: 1, lastActiveAt: 4, isArchived: true, isOpen: true },
          { id: "open1", title: "Open 1", createdAt: 1, lastActiveAt: 3, isArchived: false, isOpen: true },
        ],
        activeId: "closed", // persisted, but no record was built for it
      });
      flush();
      expect(restored.sessions.map((s) => s.id)).toEqual(["open2", "open1"]);
      expect(restored.activeId).toBeNull();
      expect(restored.sessions).toEqual(mgr.sessions());
      expect(restored.activeId).toBe(mgr.activeId());
      expect(restored.sessions.every((s) => mgr.storeFor(s.id) !== undefined)).toBe(true);
      expect(mgr.storeFor("closed")).toBeUndefined();
      expect(mgr.storeFor("archived")).toBeUndefined();
    });
  });
});

describe("createAiChatSessions — Go session id", () => {
  it("hands each session its own opaque sessionId, stable across turns, including forks", async () => {
    await withRoot(async (create) => {
      const seen: Array<string | undefined> = [];
      const provider: AIProvider = {
        async *chat(_messages, opts) {
          seen.push(opts?.sessionId);
          yield { type: "text-delta", text: "ok" };
          yield { type: "done" };
        },
        async complete() {
          return "";
        },
        async embed() {
          return [];
        },
      };
      const mgr = create(() => createAiChatSessions({ getProvider: () => provider }));
      const first = mgr.createSession();
      const second = mgr.createSession();
      await mgr.storeFor(first)!.sendMessage("a");
      await mgr.storeFor(first)!.sendMessage("a2");
      await mgr.storeFor(second)!.sendMessage("b");
      const fork = mgr.forkSession(first)!;
      await mgr.storeFor(fork)!.sendMessage("c");
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(seen).toHaveLength(4);
      for (const id of seen) expect(id).toMatch(uuid);
      // Stable across one conversation's turns, distinct across conversations
      // and the fork, and never the local id (it encodes the creation time).
      expect(seen[0]).toBe(seen[1]);
      expect(new Set([seen[0], seen[2], seen[3]]).size).toBe(3);
      for (const local of [first, second, fork]) expect(seen).not.toContain(local);

      // Closing the chat and reopening it from history keeps its id.
      mgr.closeSession(first);
      flush();
      mgr.openFromHistory(first);
      flush();
      await mgr.storeFor(first)!.sendMessage("a3");
      expect(seen[4]).toBe(seen[0]);
    });
  });

  it("forgets the id of a conversation the history cap evicts", async () => {
    await withRoot(async (create) => {
      const seen: Array<string | undefined> = [];
      const provider: AIProvider = {
        async *chat(_messages, opts) {
          seen.push(opts?.sessionId);
          yield { type: "text-delta", text: "ok" };
          yield { type: "done" };
        },
        async complete() {
          return "";
        },
        async embed() {
          return [];
        },
      };
      const mgr = create(() => createAiChatSessions({ getProvider: () => provider }));
      const meta = (id: string, lastActiveAt: number, isOpen: boolean) => ({
        id,
        title: id,
        createdAt: lastActiveAt,
        lastActiveAt,
        isArchived: false,
        isOpen,
      });
      // 50 sessions: the cap. Sending touches "victim", so the others are
      // dated later to keep it the oldest; the next session evicts it.
      const later = Date.now() + 1_000_000;
      const sessions = [meta("victim", 0, true), ...Array.from({ length: 49 }, (_, i) => meta(`s${i}`, later + i, false))];
      mgr.hydrate({ sessions, activeId: "victim" });
      flush();
      await mgr.storeFor("victim")!.sendMessage("first");
      mgr.activateSession(mgr.createSession()); // 51 sessions; the index save evicts "victim"
      flush();
      await new Promise((r) => setTimeout(r, 650));
      expect(mgr.allSessions().some((m) => m.id === "victim")).toBe(false);

      // The same local id coming back is another conversation: a new wire id.
      mgr.hydrate({ sessions: [meta("victim", 100, true)], activeId: "victim" });
      flush();
      await mgr.storeFor("victim")!.sendMessage("again");
      expect(seen).toHaveLength(2);
      expect(seen[1]).not.toBe(seen[0]);
    });
  });
});
