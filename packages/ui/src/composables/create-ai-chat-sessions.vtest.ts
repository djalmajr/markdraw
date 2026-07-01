import { beforeEach, describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
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

/** Run a test body inside a disposable reactive root (so the manager's signals +
 *  per-session effects have an owner, matching how createAppState builds it). */
function withRoot<T>(fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    createRoot((dispose) => {
      Promise.resolve(fn()).then(
        (v) => {
          dispose();
          resolve(v);
        },
        (e) => {
          dispose();
          reject(e);
        },
      );
    });
  });
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

describe("createAiChatSessions — lifecycle", () => {
  it("createSession adds an open session and activates it", async () => {
    await withRoot(() => {
      const mgr = createAiChatSessions({ getProvider: () => stubProvider() });
      const id = mgr.createSession();
      expect(mgr.activeId()).toBe(id);
      expect(mgr.sessions().map((s) => s.id)).toEqual([id]);
      expect(mgr.activeStore()).toBe(mgr.storeFor(id));
    });
  });

  it("createSession stores the current workspace root when provided", async () => {
    await withRoot(() => {
      const mgr = createAiChatSessions({
        getProvider: () => stubProvider(),
        getWorkspaceRoot: () => "/repo",
      });
      const id = mgr.createSession();
      expect(mgr.allSessions().find((s) => s.id === id)?.workspaceRoot).toBe("/repo");
    });
  });

  it("closing the active chat activates the nearest neighbor", async () => {
    await withRoot(() => {
      const mgr = createAiChatSessions({ getProvider: () => stubProvider() });
      const a = mgr.createSession();
      const b = mgr.createSession();
      const c = mgr.createSession();
      mgr.activateSession(b);
      mgr.closeSession(b);
      // Neighbor at clamped index → c (the one that took b's slot).
      expect(mgr.activeId()).toBe(c);
      expect(mgr.sessions().map((s) => s.id)).toEqual([a, c]);
      // b survives in history as closed.
      expect(mgr.allSessions().find((s) => s.id === b)?.isOpen).toBe(false);
    });
  });

  it("closing the last chat clears active and yields the empty store", async () => {
    await withRoot(() => {
      const mgr = createAiChatSessions({ getProvider: () => stubProvider() });
      const a = mgr.createSession();
      mgr.closeSession(a);
      expect(mgr.activeId()).toBeNull();
      expect(mgr.sessions()).toEqual([]);
      // activeStore() must not throw and must be a usable store.
      expect(typeof mgr.activeStore().messages).toBe("function");
      expect(mgr.activeStore().messages()).toEqual([]);
    });
  });

  it("archive removes from the strip but keeps the session in history", async () => {
    await withRoot(() => {
      const mgr = createAiChatSessions({ getProvider: () => stubProvider() });
      const a = mgr.createSession();
      mgr.archiveSession(a);
      expect(mgr.sessions()).toEqual([]);
      expect(mgr.allSessions().find((s) => s.id === a)?.isArchived).toBe(true);
      expect(mgr.storeFor(a)).toBeUndefined(); // live store disposed
    });
  });

  it("openFromHistory reopens a closed chat with its persisted messages", async () => {
    await withRoot(async () => {
      const mgr = createAiChatSessions({ getProvider: () => stubProvider() });
      // Seed a closed session's messages directly in storage.
      setChatMessages("old", [{ role: "user", content: "remember me" }]);
      mgr.hydrate({
        sessions: [{ id: "old", title: "Old", createdAt: 1, lastActiveAt: 1, isArchived: false, isOpen: false }],
        activeId: null,
      });
      expect(mgr.sessions()).toEqual([]); // closed → not in strip
      mgr.openFromHistory("old");
      expect(mgr.activeId()).toBe("old");
      expect(mgr.storeFor("old")!.messages()).toEqual([{ role: "user", content: "remember me" }]);
    });
  });

  it("deleteSession aborts, removes the session and its messages", async () => {
    await withRoot(async () => {
      const { provider, release } = gatedProvider();
      const mgr = createAiChatSessions({ getProvider: () => provider });
      const a = mgr.createSession();
      const pending = mgr.storeFor(a)!.sendMessage("hi");
      await tick();
      expect(mgr.storeFor(a)!.streaming()).toBe(true);
      mgr.deleteSession(a);
      release();
      await pending.catch(() => {});
      expect(mgr.allSessions().find((s) => s.id === a)).toBeUndefined();
      expect(localStorage.getItem("markdraw-ai-chat-msgs-" + a)).toBeNull();
    });
  });
});

describe("createAiChatSessions — fork", () => {
  it("forkSession copies the messages into a new active session that evolves separately", async () => {
    await withRoot(async () => {
      const mgr = createAiChatSessions({
        getProvider: () => stubProvider("ok"),
        getWorkspaceRoot: () => "/repo",
      });
      const a = mgr.createSession();
      await mgr.storeFor(a)!.sendMessage("hello");
      const fork = mgr.forkSession(a);
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
      expect(mgr.allSessions().find((s) => s.id === fork)?.workspaceRoot).toBe("/repo");
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
    await withRoot(() => {
      const mgr = createAiChatSessions({ getProvider: () => stubProvider() });
      expect(mgr.forkSession("nope")).toBeNull();
      expect(mgr.allSessions()).toEqual([]);
    });
  });
});

describe("createAiChatSessions — streaming isolation", () => {
  it("a background chat keeps streaming after switching away", async () => {
    await withRoot(async () => {
      const { provider, release } = gatedProvider();
      const mgr = createAiChatSessions({ getProvider: () => provider });
      const a = mgr.createSession();
      const pendingA = mgr.storeFor(a)!.sendMessage("hi");
      await tick();
      expect(mgr.storeFor(a)!.streaming()).toBe(true);

      // Switch to a fresh chat — must NOT abort A.
      const b = mgr.createSession();
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
    await withRoot(async () => {
      const mgr = createAiChatSessions({ getProvider: () => stubProvider() });
      const a = mgr.createSession();
      expect(mgr.allSessions()[0]!.title).toBe(""); // untitled
      await mgr.storeFor(a)!.sendMessage("Plan the release");
      expect(mgr.allSessions()[0]!.title).toBe("Plan the release");
      mgr.renameSession(a, "Release notes");
      await mgr.storeFor(a)!.sendMessage("another message");
      expect(mgr.allSessions()[0]!.title).toBe("Release notes"); // not overwritten
    });
  });
});

describe("createAiChatSessions — hydrate", () => {
  it("rebuilds only open sessions and restores the active id", async () => {
    await withRoot(() => {
      const mgr = createAiChatSessions({ getProvider: () => stubProvider() });
      setChatMessages("open1", [{ role: "user", content: "x" }]);
      mgr.hydrate({
        sessions: [
          { id: "open1", title: "Open", createdAt: 1, lastActiveAt: 5, isArchived: false, isOpen: true },
          { id: "arch1", title: "Arch", createdAt: 1, lastActiveAt: 2, isArchived: true, isOpen: false },
        ],
        activeId: "open1",
      });
      expect(mgr.sessions().map((s) => s.id)).toEqual(["open1"]);
      expect(mgr.allSessions()).toHaveLength(2);
      expect(mgr.activeId()).toBe("open1");
      expect(mgr.storeFor("open1")!.messages()).toEqual([{ role: "user", content: "x" }]);
      expect(mgr.storeFor("arch1")).toBeUndefined();
    });
  });

  it("drops a dangling activeId that is not open", async () => {
    await withRoot(() => {
      const mgr = createAiChatSessions({ getProvider: () => stubProvider() });
      mgr.hydrate({
        sessions: [{ id: "c", title: "Closed", createdAt: 1, lastActiveAt: 1, isArchived: false, isOpen: false }],
        activeId: "c",
      });
      expect(mgr.activeId()).toBeNull();
    });
  });
});
