// Multi-chat session manager for the AI sidebar. Holds N independent
// `AiChatStore` instances — one per OPEN chat — so a turn streaming in a
// background tab keeps running when you switch away (each store owns its own
// AbortController). Closed/archived chats live on as metadata in the history
// until reopened. Mirrors `create-tab-store.ts` conventions (debounced persist,
// lifecycle methods) and persists through `@markdraw/core/ai-chat-sessions.ts`.
//
// Reactive ownership (load-bearing): the sidebar chat used to be a SINGLE store
// created synchronously inside `createAppState` (so it inherited that owner).
// Sessions here are created LAZILY from event handlers, where `getOwner()` is
// null. We capture the manager's owner at construction and wrap every session
// store in its own `createRoot` run under that owner via `runWithOwner` — giving
// each session an isolated disposal scope nested under the app (no detached-root
// warning; freed exactly when the session closes).

import { createEffect, createRoot, createSignal, getOwner, runWithOwner, untrack, type Owner } from "solid-js";
import type { AIProvider, AITool } from "@markdraw/ai/types.ts";
import {
  type PersistedAdvisorNote,
  type PersistedChatMessage,
  type PersistedChatSessionMeta,
  type PersistedToolActivity,
  deleteChatMessages,
  enforceSessionCap,
  getChatMessages,
  setChatMessages,
  setChatSessionsIndex,
  toPersistedTool,
} from "@markdraw/core/ai-chat-sessions.ts";
import {
  type AiChatStore,
  type ChatContextResult,
  type ChatTurn,
  type TurnValidationResult,
  type ToolActivity,
  createAiChatStore,
} from "./create-ai-chat-store.ts";

/** Public, reactive metadata for a chat session (strip + history). */
export type AiChatSessionMeta = PersistedChatSessionMeta;

export interface AiChatSessions {
  /** Open, non-archived sessions for the tab strip, in creation order. Reactive. */
  sessions: () => AiChatSessionMeta[];
  /** Every session incl. closed + archived — drives the history dropdown. Reactive. */
  allSessions: () => AiChatSessionMeta[];
  activeId: () => string | null;
  /** Store bound to the active session; a quiescent empty store when none. */
  activeStore: () => AiChatStore;
  /** Live store for an OPEN session, else undefined (closed/archived). */
  storeFor: (id: string) => AiChatStore | undefined;
  /** Bumped on any structural/message change — a reactivity hook for callers. */
  version: () => number;

  createSession: (opts?: { activate?: boolean; title?: string }) => string;
  /** Duplicate a session's CURRENT messages into a NEW session (own store —
   *  no shared state with the source), opened and activated. Live sources
   *  fork their in-memory turns (incl. an in-flight partial); closed/archived
   *  ones fork their persisted messages. Returns the new id, or null when the
   *  source id is unknown. */
  forkSession: (id: string) => string | null;
  closeSession: (id: string) => void;
  activateSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** Pin/unpin a session (tab strip sort + bulk-close protection). */
  setPinned: (id: string, pinned: boolean) => void;
  archiveSession: (id: string) => void;
  /** Un-archive (if needed), reopen as a live tab, and activate. Used by the
   *  history dropdown's row-click and "Restore". */
  openFromHistory: (id: string) => void;
  restoreSession: (id: string) => void;
  deleteSession: (id: string) => void;

  /** Rebuild from persisted state on boot (instantiates only OPEN sessions). */
  hydrate: (persisted: { sessions: PersistedChatSessionMeta[]; activeId: string | null }) => void;
  /** Current persistable state (for tests / external writers). */
  snapshot: () => { sessions: PersistedChatSessionMeta[]; activeId: string | null };
}

export interface AiChatSessionsConfig {
  getProvider: () => AIProvider | null;
  system?: () => string | undefined;
  getTools?: () => AITool[] | Promise<AITool[]>;
  maxSteps?: number;
  /** Explicit context preamble injected into the sent message (shared across
   *  sessions — reflects the current composer context chips). */
  getContext?: (request: { history: ChatTurn[]; userMessage: string }) => ChatContextResult;
  /** Snapshot of the host chat mode captured when a turn STARTS, forwarded to
   *  each session store so finalization reflects the turn's OWN mode (not the
   *  panel-global mode, which can change while a background turn streams). */
  getMode?: () => string | undefined;
  /** Called when any session's assistant turn finalizes (Plan-mode save).
   *  Receives the mode the turn ran under. */
  onAssistantTurn?: (content: string, mode?: string) => void;
  /** Optional host guard run after a turn finalizes, before the turn is accepted
   *  as successful. */
  validateAssistantTurn?: (request: {
    assistantText: string;
    history: ChatTurn[];
    mode?: string;
    tools: ToolActivity[];
    userMessage: string;
  }) => string | TurnValidationResult | undefined;
  adviseAssistantTurn?: (request: {
    assistantText: string;
    history: ChatTurn[];
    mode?: string;
    tools: ToolActivity[];
    userMessage: string;
  }) => Promise<PersistedAdvisorNote[]>;
  copyArtifacts?: (sourceSessionId: string, targetSessionId: string) => void | Promise<void>;
  deleteArtifacts?: (sessionId: string) => void | Promise<void>;
  getWorkspaceRoot?: () => string | null | undefined;
  writeArtifact?: (input: {
    content: string;
    kind: NonNullable<PersistedToolActivity["resultArtifact"]>["kind"];
    mime: string;
    sessionId: string;
    title: string;
    toolCallId?: string;
  }) => Promise<NonNullable<PersistedToolActivity["resultArtifact"]>>;
  /** Title generation from the first user message; injected for purity/testing. */
  deriveTitle?: (firstUserMessage: string) => string;
  /** Engine-level Accept/Reject gate, forwarded to every session store. */
  onApprovalRequest?: (req: {
    args: unknown;
    signal?: AbortSignal;
    source?: string;
    toolName: string;
  }) => Promise<boolean>;
}

/** Derive a short tab title from the first user message (≤40 chars, one line). */
export function deriveAiChatTitle(firstUserMessage: string): string {
  const oneLine = firstUserMessage.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > 40 ? oneLine.slice(0, 39).trimEnd() + "…" : oneLine;
}

export function createAiChatSessions(config: AiChatSessionsConfig): AiChatSessions {
  const rootOwner: Owner | null = getOwner();
  const deriveTitle = config.deriveTitle ?? deriveAiChatTitle;

  const [metas, setMetas] = createSignal<PersistedChatSessionMeta[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [version, setVersion] = createSignal(0);
  const records = new Map<string, { store: AiChatStore; dispose: () => void }>();
  let hydrating = false;
  let counter = 0;

  const bump = () => setVersion((v) => v + 1);
  const newId = () => `chat-${Date.now().toString(36)}-${(counter++).toString(36)}`;

  // A throwaway store so AiPanel never receives undefined when there is no
  // active chat (e.g. only the TOC tab is open). Created in the manager root.
  const EMPTY_STORE = createAiChatStore({ getProvider: config.getProvider });

  function patchMeta(id: string, patch: Partial<PersistedChatSessionMeta>): void {
    setMetas((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  // ── Persistence (debounced, mirrors create-tab-store.ts) ──────────────────
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  const msgTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function schedulePersistIndex(): void {
    if (hydrating) return;
    clearTimeout(indexTimer);
    indexTimer = setTimeout(flushIndex, 500);
  }

  function flushIndex(): void {
    const { index, evictedIds } = enforceSessionCap({ sessions: metas(), activeId: activeId() });
    for (const id of evictedIds) {
      records.get(id)?.store.cancel();
      records.get(id)?.dispose();
      records.delete(id);
      deleteChatMessages(id);
      void config.deleteArtifacts?.(id);
    }
    if (evictedIds.length) setMetas((ms) => ms.filter((m) => !evictedIds.includes(m.id)));
    setChatSessionsIndex(index);
  }

  function mapTurns(turns: ChatTurn[]): PersistedChatMessage[] {
    return turns.map((t) => ({
      role: t.role,
      content: t.content,
      ...(t.kind ? { kind: t.kind } : {}),
      ...(t.context && t.context.length ? { context: t.context } : {}),
      ...(t.advisorNotes && t.advisorNotes.length ? { advisorNotes: t.advisorNotes } : {}),
      ...(t.tools && t.tools.length ? { tools: t.tools.map(toPersistedTool) } : {}),
      ...(t.usage ? { usage: t.usage } : {}),
    }));
  }

  function persistMessages(id: string, turns: ChatTurn[]): void {
    if (hydrating) return;
    clearTimeout(msgTimers.get(id));
    msgTimers.set(
      id,
      setTimeout(() => setChatMessages(id, mapTurns(turns)), 500),
    );
  }

  /** Write a session's messages immediately (used before disposing a store so a
   *  partial in-flight reply isn't lost). */
  function flushMessages(id: string, turns: ChatTurn[]): void {
    clearTimeout(msgTimers.get(id));
    setChatMessages(id, mapTurns(turns));
  }

  /** Messages including the in-flight partial reply (so close/archive persist
   *  what was streaming). */
  function durableTurns(store: AiChatStore): ChatTurn[] {
    const base = store.messages();
    if (store.streaming() && (store.streamingText() || store.toolActivity().length > 0)) {
      return [
        ...base,
        {
          role: "assistant",
          content: store.streamingText(),
          ...(store.toolActivity().length ? { tools: store.toolActivity() } : {}),
        },
      ];
    }
    return base;
  }

  // ── Store instantiation (owner-aware) ─────────────────────────────────────
  function instantiate(id: string, initial: ChatTurn[]): { store: AiChatStore; dispose: () => void } {
    const make = () =>
      createRoot((dispose) => {
        const store = createAiChatStore({
          getProvider: config.getProvider,
          ...(config.system ? { system: config.system } : {}),
          ...(config.getTools ? { getTools: config.getTools } : {}),
          ...(config.maxSteps != null ? { maxSteps: config.maxSteps } : {}),
          ...(config.getContext ? { getContext: config.getContext } : {}),
          ...(config.getMode ? { getMode: config.getMode } : {}),
          ...(config.onAssistantTurn ? { onAssistantTurn: config.onAssistantTurn } : {}),
          ...(config.validateAssistantTurn
            ? { validateAssistantTurn: config.validateAssistantTurn }
            : {}),
          ...(config.adviseAssistantTurn ? { adviseAssistantTurn: config.adviseAssistantTurn } : {}),
          ...(config.writeArtifact
            ? {
                writeArtifact: (input) =>
                  config.writeArtifact!({
                    ...input,
                    sessionId: id,
                  }),
              }
            : {}),
          ...(config.onApprovalRequest ? { onApprovalRequest: config.onApprovalRequest } : {}),
          initialMessages: initial,
        });

        // Persist + auto-title when this session's turns change. Tracks ONLY the
        // store signals; the metas read is untracked to avoid a write→read loop
        // (this effect calls patchMeta, which writes metas).
        //
        // The effect's eager FIRST run only reflects the seeded/hydrated state —
        // and it fires AFTER hydrate() clears `hydrating` (effects are queued),
        // so without this skip it would stamp lastActiveAt=now on every open
        // session at boot, destroying persisted ordering (continueLatestChat).
        let initialized = false;
        createEffect(() => {
          const msgs = store.messages();
          store.streaming(); // re-run on turn finalize / cancel
          if (hydrating) return;
          if (!initialized) {
            initialized = true;
            return;
          }
          const patch: Partial<PersistedChatSessionMeta> = { lastActiveAt: Date.now() };
          const cur = untrack(() => metas()).find((m) => m.id === id);
          if (cur && cur.title === "") {
            const firstUser = msgs.find((t) => t.role === "user");
            if (firstUser) {
              const t = deriveTitle(firstUser.content);
              if (t) patch.title = t;
            }
          }
          patchMeta(id, patch);
          persistMessages(id, msgs);
          schedulePersistIndex();
          bump();
        });

        return { store, dispose };
      });
    return rootOwner ? runWithOwner(rootOwner, make)! : make();
  }

  function hydrateTurns(msgs: PersistedChatMessage[]): ChatTurn[] {
    const parse = (json: string): unknown => {
      try {
        return JSON.parse(json);
      } catch {
        return undefined;
      }
    };
    return msgs.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.kind ? { kind: m.kind } : {}),
      ...(m.context && m.context.length ? { context: m.context } : {}),
      ...(m.tools && m.tools.length
        ? {
            tools: m.tools.map((t) => ({
              toolCallId: t.toolCallId,
              toolName: t.toolName,
              ...(t.source !== undefined ? { source: t.source } : {}),
              status: t.status,
              ...(t.argsJson != null ? { args: parse(t.argsJson) } : {}),
              ...(t.resultJson != null ? { result: parse(t.resultJson) } : {}),
              ...(t.resultArtifact !== undefined ? { resultArtifact: t.resultArtifact } : {}),
            })),
          }
        : {}),
      ...(m.advisorNotes && m.advisorNotes.length ? { advisorNotes: m.advisorNotes } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
    }));
  }

  // ── Neighbor selection on close/archive/delete of the active session ──────
  function pickNeighbor(leavingId: string): string | null {
    const openIds = metas()
      .filter((m) => m.isOpen && !m.isArchived)
      .map((m) => m.id);
    const idx = openIds.indexOf(leavingId);
    const remaining = openIds.filter((x) => x !== leavingId);
    if (remaining.length === 0) return null;
    return remaining[Math.min(idx < 0 ? remaining.length - 1 : idx, remaining.length - 1)] ?? null;
  }

  function teardown(id: string, persistPartial: boolean): void {
    const rec = records.get(id);
    if (rec) {
      if (persistPartial) flushMessages(id, durableTurns(rec.store));
      rec.store.cancel();
      rec.dispose();
      records.delete(id);
    }
  }

  // ── Public lifecycle ──────────────────────────────────────────────────────
  function createSession(opts?: { activate?: boolean; title?: string }): string {
    const id = newId();
    const now = Date.now();
    const workspaceRoot = config.getWorkspaceRoot?.() ?? undefined;
    setMetas((ms) => [
      ...ms,
      {
        id,
        title: opts?.title ?? "",
        createdAt: now,
        lastActiveAt: now,
        isArchived: false,
        isOpen: true,
        isPinned: false,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      },
    ]);
    records.set(id, instantiate(id, []));
    if (opts?.activate ?? true) setActiveId(id);
    bump();
    schedulePersistIndex();
    return id;
  }

  /** Duplicate `id`'s current messages into a brand-new session. The copy is
   *  instantiated like createSession/hydrate do (its OWN store seeded via
   *  `initialMessages`), so the fork and the source evolve independently. */
  function forkSession(id: string): string | null {
    const src = metas().find((x) => x.id === id);
    if (!src) return null;
    // Live source → its in-memory turns (incl. an in-flight partial);
    // closed/archived source → its persisted messages.
    const rec = records.get(id);
    const turns: ChatTurn[] = rec
      ? durableTurns(rec.store).map((t) => ({ ...t }))
      : hydrateTurns(getChatMessages(id));
    const firstUser = turns.find((t) => t.role === "user");
    const forkId = newId();
    const now = Date.now();
    setMetas((ms) => [
      ...ms,
      {
        id: forkId,
        title: src.title || (firstUser ? deriveTitle(firstUser.content) : ""),
        createdAt: now,
        lastActiveAt: now,
        isArchived: false,
        isOpen: true,
        isPinned: false,
        ...(src.workspaceRoot ? { workspaceRoot: src.workspaceRoot } : {}),
      },
    ]);
    records.set(forkId, instantiate(forkId, turns));
    // Make the copied turns durable immediately (same write path teardown
    // uses) — the per-store effect only persists on the debounce.
    flushMessages(forkId, turns);
    void config.copyArtifacts?.(id, forkId);
    setActiveId(forkId);
    bump();
    schedulePersistIndex();
    return forkId;
  }

  function activateSession(id: string): void {
    if (activeId() === id) return;
    const m = metas().find((x) => x.id === id);
    if (!m) return;
    if (!m.isOpen || m.isArchived) {
      openFromHistory(id);
      return;
    }
    patchMeta(id, { lastActiveAt: Date.now() });
    setActiveId(id);
    bump();
    schedulePersistIndex();
  }

  function openFromHistory(id: string): void {
    const m = metas().find((x) => x.id === id);
    if (!m) return;
    patchMeta(id, { isOpen: true, isArchived: false, lastActiveAt: Date.now() });
    if (!records.has(id)) records.set(id, instantiate(id, hydrateTurns(getChatMessages(id))));
    setActiveId(id);
    bump();
    schedulePersistIndex();
  }

  function restoreSession(id: string): void {
    openFromHistory(id);
  }

  function closeSession(id: string): void {
    const neighbor = activeId() === id ? pickNeighbor(id) : null;
    teardown(id, true);
    patchMeta(id, { isOpen: false });
    if (activeId() === id) setActiveId(neighbor);
    bump();
    schedulePersistIndex();
  }

  function archiveSession(id: string): void {
    const neighbor = activeId() === id ? pickNeighbor(id) : null;
    teardown(id, true);
    patchMeta(id, { isArchived: true, isOpen: false });
    if (activeId() === id) setActiveId(neighbor);
    bump();
    schedulePersistIndex();
  }

  function deleteSession(id: string): void {
    const neighbor = activeId() === id ? pickNeighbor(id) : null;
    teardown(id, false);
    clearTimeout(msgTimers.get(id));
    msgTimers.delete(id);
    deleteChatMessages(id); // immediate — destructive, must not be lost to a debounce
    void config.deleteArtifacts?.(id);
    setMetas((ms) => ms.filter((m) => m.id !== id));
    if (activeId() === id) setActiveId(neighbor);
    bump();
    schedulePersistIndex();
  }

  function renameSession(id: string, title: string): void {
    patchMeta(id, { title: title.trim() });
    bump();
    schedulePersistIndex();
  }

  function setPinned(id: string, pinned: boolean): void {
    patchMeta(id, { isPinned: pinned });
    bump();
    schedulePersistIndex();
  }

  function activeStore(): AiChatStore {
    const id = activeId();
    return (id !== null && records.get(id)?.store) || EMPTY_STORE;
  }

  function storeFor(id: string): AiChatStore | undefined {
    return records.get(id)?.store;
  }

  function sessions(): AiChatSessionMeta[] {
    return metas().filter((m) => m.isOpen && !m.isArchived);
  }

  function allSessions(): AiChatSessionMeta[] {
    return metas();
  }

  function hydrate(persisted: { sessions: PersistedChatSessionMeta[]; activeId: string | null }): void {
    hydrating = true;
    try {
      setMetas(persisted.sessions.map((m) => ({ ...m })));
      for (const m of persisted.sessions) {
        if (m.isOpen && !m.isArchived) records.set(m.id, instantiate(m.id, hydrateTurns(getChatMessages(m.id))));
      }
      const active = persisted.activeId !== null && records.has(persisted.activeId) ? persisted.activeId : null;
      setActiveId(active);
    } finally {
      hydrating = false;
    }
    bump();
  }

  function snapshot(): { sessions: PersistedChatSessionMeta[]; activeId: string | null } {
    return { sessions: metas(), activeId: activeId() };
  }

  return {
    sessions,
    allSessions,
    activeId,
    activeStore,
    storeFor,
    version,
    createSession,
    forkSession,
    closeSession,
    activateSession,
    renameSession,
    setPinned,
    archiveSession,
    openFromHistory,
    restoreSession,
    deleteSession,
    hydrate,
    snapshot,
  };
}
