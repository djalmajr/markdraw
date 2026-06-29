// Persistence for the multi-chat AI sidebar: a small SESSIONS INDEX plus one
// MESSAGE BLOB per session, kept in localStorage. Mirrors the tab-session
// persistence pattern (`tabs.ts` + `schemas.ts`): valibot at the storage
// boundary, `safeJsonParse` + `tryParse`, normalize-on-write, lenient-on-read
// (a single bad entry is filtered, never session-fatal).
//
// Core has NO dependency on `@markdraw/ai`/SolidJS (it is the base package the
// others build on), so the chat message/tool shapes are redeclared structurally
// here — the same precedent as `AIEngineId` in `ai-prefs.ts`. The UI's
// `ChatTurn`/`ToolActivity` map onto `PersistedChatMessage`/`PersistedToolActivity`.

import * as v from "valibot";
import { safeJsonParse, tryParse } from "./schemas.ts";

// ── Storage keys ────────────────────────────────────────────────────────────
const SESSIONS_INDEX_KEY = "markdraw-ai-chat-sessions";
const MESSAGES_KEY_PREFIX = "markdraw-ai-chat-msgs-";

function messagesKey(sessionId: string): string {
  return `${MESSAGES_KEY_PREFIX}${sessionId}`;
}

// ── Caps (localStorage is ~5MB; keep the footprint bounded) ─────────────────
const MAX_SESSIONS = 50;
const MAX_MESSAGES_PER_SESSION = 200;
const MAX_MESSAGE_CONTENT_CHARS = 50_000;
const MAX_TOOL_JSON_BYTES = 4_000;
const MAX_TOOLS_PER_MESSAGE = 16;
const TRUNCATION_SENTINEL = "\n\n…[truncated]";

// ── Schemas ─────────────────────────────────────────────────────────────────

// Tool args/result arrive as arbitrary JSON (`unknown`) from tool calls —
// potentially huge (file contents, search dumps) or non-serializable. We persist
// a SIZE-CAPPED JSON STRING (or null when dropped) instead of the live object so
// the blob stays bounded and a bad value degrades one bubble instead of
// corrupting the whole message list.
const PersistedToolActivitySchema = v.object({
  toolCallId: v.string(),
  toolName: v.string(),
  source: v.optional(v.string()),
  status: v.picklist(["running", "done", "error"] as const),
  argsJson: v.nullable(v.string()),
  resultJson: v.nullable(v.string()),
});

// Per-run telemetry attached to an assistant turn (token totals + tool-call
// count). Declared here because valibot's `v.object` STRIPS undeclared keys on
// parse — without this the field would silently vanish at the storage boundary.
const PersistedTurnUsageSchema = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  toolCalls: v.optional(v.number()),
});

const PersistedChatContextItemSchema = v.object({
  id: v.optional(v.string()),
  kind: v.picklist(["file", "folder", "selection"] as const),
  label: v.string(),
  path: v.optional(v.string()),
  rootId: v.optional(v.string()),
  rootPath: v.optional(v.string()),
  absolutePath: v.optional(v.string()),
});

const PersistedChatMessageSchema = v.object({
  role: v.picklist(["user", "assistant"] as const),
  content: v.string(),
  context: v.optional(v.array(PersistedChatContextItemSchema)),
  tools: v.optional(v.array(PersistedToolActivitySchema)),
  usage: v.optional(PersistedTurnUsageSchema),
});

const PersistedChatSessionMetaSchema = v.object({
  id: v.string(),
  title: v.string(),
  createdAt: v.number(),
  lastActiveAt: v.number(),
  /** Removed from the strip but kept in history (Archived group). */
  isArchived: v.boolean(),
  /** Currently mounted as a tab in the strip (has a live store). Closed chats
   *  stay in history with `isOpen: false` until reopened. */
  isOpen: v.boolean(),
  /** Pinned tabs sort to the left and are protected from bulk close
   *  (Close others / to the right / all). Optional (absent ⇒ not pinned) so
   *  sessions persisted before pinning existed still parse; consumers read it
   *  as `isPinned ?? false`. */
  isPinned: v.optional(v.boolean()),
});

// Strict write-boundary schema.
const ChatSessionsIndexSchema = v.object({
  sessions: v.array(PersistedChatSessionMetaSchema),
  activeId: v.nullable(v.string()),
});

// Lenient read-boundary wrappers: arrays are `unknown[]` so one malformed entry
// is filtered, not fatal (mirrors `TabSessionWrapperSchema`).
const ChatSessionsIndexWrapperSchema = v.object({
  sessions: v.array(v.unknown()),
  activeId: v.optional(v.union([v.string(), v.null()])),
});
const ChatMessagesWrapperSchema = v.array(v.unknown());

type PersistedToolActivity = v.InferOutput<typeof PersistedToolActivitySchema>;
type PersistedChatMessage = v.InferOutput<typeof PersistedChatMessageSchema>;
type PersistedChatSessionMeta = v.InferOutput<typeof PersistedChatSessionMetaSchema>;
type ChatSessionsIndex = v.InferOutput<typeof ChatSessionsIndexSchema>;

/** Date buckets for the history dropdown. */
interface GroupedChatSessions {
  today: PersistedChatSessionMeta[];
  yesterday: PersistedChatSessionMeta[];
  previous7Days: PersistedChatSessionMeta[];
  older: PersistedChatSessionMeta[];
  archived: PersistedChatSessionMeta[];
}

// ── Tool/message capping helpers (pure) ─────────────────────────────────────

/** Serialize to a JSON string, or null when it can't be bounded safely
 *  (undefined input, non-serializable value, or over the byte cap). We drop
 *  rather than truncate JSON — a truncated string would be invalid JSON. */
function cappedStringify(value: unknown, maxBytes: number = MAX_TOOL_JSON_BYTES): string | null {
  if (value === undefined) return null;
  let s: string | undefined;
  try {
    s = JSON.stringify(value);
  } catch {
    return null; // non-serializable (BigInt, cycle, …)
  }
  if (s == null) return null; // JSON.stringify(undefined) and friends
  if (s.length > maxBytes) return null; // char length is a conservative byte proxy
  return s;
}

/** Build a persistable tool record from a live `ToolActivity`-shaped value. */
function toPersistedTool(activity: {
  toolCallId: string;
  toolName: string;
  source?: string;
  status: "running" | "done" | "error";
  args?: unknown;
  result?: unknown;
}): PersistedToolActivity {
  return {
    toolCallId: activity.toolCallId,
    toolName: activity.toolName,
    ...(activity.source !== undefined ? { source: activity.source } : {}),
    status: activity.status,
    argsJson: cappedStringify(activity.args),
    resultJson: cappedStringify(activity.result),
  };
}

/** Bound a message list before it hits storage: keep the most-recent turns,
 *  truncate oversized content, cap the tool count per turn. */
function capMessages(messages: PersistedChatMessage[]): PersistedChatMessage[] {
  const tail = messages.length > MAX_MESSAGES_PER_SESSION ? messages.slice(-MAX_MESSAGES_PER_SESSION) : messages;
  return tail.map((msg) => {
    const content =
      msg.content.length > MAX_MESSAGE_CONTENT_CHARS
        ? msg.content.slice(0, MAX_MESSAGE_CONTENT_CHARS) + TRUNCATION_SENTINEL
        : msg.content;
    const usage = msg.usage !== undefined ? { usage: msg.usage } : {};
    const context = msg.context && msg.context.length ? { context: msg.context.slice(0, 16) } : {};
    if (!msg.tools || msg.tools.length === 0) {
      return { role: msg.role, content, ...context, ...usage };
    }
    const tools = msg.tools.length > MAX_TOOLS_PER_MESSAGE ? msg.tools.slice(0, MAX_TOOLS_PER_MESSAGE) : msg.tools;
    return { role: msg.role, content, ...context, tools, ...usage };
  });
}

// ── Quota handling ──────────────────────────────────────────────────────────

function isQuotaError(e: unknown): boolean {
  if (typeof DOMException !== "undefined" && e instanceof DOMException) {
    return e.name === "QuotaExceededError" || e.code === 22 || e.name === "NS_ERROR_DOM_QUOTA_REACHED";
  }
  return e instanceof Error && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

/** Free one session's storage when over quota: the oldest archived session
 *  first, else the oldest non-active session. Never touches the active session.
 *  Deletes the victim's message blob (the big payload) and rewrites the index.
 *  Returns true when something was evicted. */
function evictOneRound(): boolean {
  const index = getChatSessionsIndex();
  if (!index || index.sessions.length === 0) return false;

  const archived = index.sessions.filter((s) => s.isArchived);
  const pool = archived.length > 0 ? archived : index.sessions.filter((s) => s.id !== index.activeId);
  if (pool.length === 0) return false;

  let victim = pool[0]!;
  for (const s of pool) if (s.lastActiveAt < victim.lastActiveAt) victim = s;

  deleteChatMessages(victim.id);
  const trimmed: ChatSessionsIndex = {
    sessions: index.sessions.filter((s) => s.id !== victim.id),
    activeId: index.activeId === victim.id ? null : index.activeId,
  };
  try {
    localStorage.setItem(SESSIONS_INDEX_KEY, JSON.stringify(normalizeIndex(trimmed)));
  } catch {
    // The index write itself failed — the freed message blob still helped.
  }
  return true;
}

/** Write `serialized` to `key`, evicting once and retrying on quota. A
 *  persistent quota error is swallowed (best-effort persistence — never throw
 *  out of a debounced timer). Non-quota errors are real bugs and rethrow. */
function writeWithQuotaGuard(key: string, serialized: string): void {
  try {
    localStorage.setItem(key, serialized);
    return;
  } catch (e) {
    if (!isQuotaError(e)) throw e;
  }
  // One eviction round, then a single retry.
  evictOneRound();
  try {
    localStorage.setItem(key, serialized);
  } catch (e) {
    if (!isQuotaError(e)) throw e;
    // Give up silently — the in-memory store keeps the data.
  }
}

// ── Index read/write ────────────────────────────────────────────────────────

function normalizeIndex(index: ChatSessionsIndex): ChatSessionsIndex {
  return {
    sessions: index.sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      isArchived: s.isArchived,
      isOpen: s.isOpen,
      ...(s.isPinned ? { isPinned: true } : {}),
    })),
    activeId: index.activeId,
  };
}

/**
 * Read the sessions index. Returns `null` only when the key is absent or the
 * JSON is corrupt — an empty-but-valid index returns `{sessions:[], activeId:null}`
 * so callers can tell "user cleared all chats" apart from "fresh install". A
 * dangling `activeId` (pointing at a filtered-out session) is nulled.
 */
function getChatSessionsIndex(): ChatSessionsIndex | null {
  const wrapper = safeJsonParse(localStorage.getItem(SESSIONS_INDEX_KEY), ChatSessionsIndexWrapperSchema);
  if (!wrapper) return null;

  const sessions = wrapper.sessions
    .map((s) => tryParse(PersistedChatSessionMetaSchema, s))
    .filter((s): s is PersistedChatSessionMeta => s !== null);

  const activeId = typeof wrapper.activeId === "string" ? wrapper.activeId : null;
  const activePresent = activeId !== null && sessions.some((s) => s.id === activeId);
  return { sessions, activeId: activePresent ? activeId : null };
}

/** Persist the index (always writes, even when empty — the empty marker lets
 *  boot distinguish "cleared" from "fresh"). Normalizes + validates first. */
function setChatSessionsIndex(index: ChatSessionsIndex): void {
  const validated = tryParse(ChatSessionsIndexSchema, normalizeIndex(index));
  if (!validated) throw new Error("setChatSessionsIndex: invalid ChatSessionsIndex");
  writeWithQuotaGuard(SESSIONS_INDEX_KEY, JSON.stringify(validated));
}

/** Trim the index to `MAX_SESSIONS`, dropping lowest-priority sessions
 *  (archived-oldest first, then non-active oldest; never the active one).
 *  Pure — returns the trimmed index plus the evicted ids so the caller can
 *  delete their message blobs. */
function enforceSessionCap(index: ChatSessionsIndex): { index: ChatSessionsIndex; evictedIds: string[] } {
  if (index.sessions.length <= MAX_SESSIONS) return { index, evictedIds: [] };

  // Rank by eviction priority: archived before open, older before newer; the
  // active session is never a candidate.
  const candidates = index.sessions
    .filter((s) => s.id !== index.activeId)
    .sort((a, b) => {
      if (a.isArchived !== b.isArchived) return a.isArchived ? -1 : 1;
      return a.lastActiveAt - b.lastActiveAt;
    });

  const dropCount = index.sessions.length - MAX_SESSIONS;
  const evictedIds = candidates.slice(0, dropCount).map((s) => s.id);
  const evictedSet = new Set(evictedIds);
  return {
    index: {
      sessions: index.sessions.filter((s) => !evictedSet.has(s.id)),
      activeId: index.activeId,
    },
    evictedIds,
  };
}

// ── Message read/write ──────────────────────────────────────────────────────

function getChatMessages(sessionId: string): PersistedChatMessage[] {
  const list = safeJsonParse(localStorage.getItem(messagesKey(sessionId)), ChatMessagesWrapperSchema);
  if (!list) return [];
  return list
    .map((m) => tryParse(PersistedChatMessageSchema, m))
    .filter((m): m is PersistedChatMessage => m !== null);
}

function setChatMessages(sessionId: string, messages: PersistedChatMessage[]): void {
  if (messages.length === 0) {
    localStorage.removeItem(messagesKey(sessionId));
    return;
  }
  const capped = capMessages(messages);
  const validated = tryParse(v.array(PersistedChatMessageSchema), capped);
  if (!validated) throw new Error("setChatMessages: invalid message list");
  writeWithQuotaGuard(messagesKey(sessionId), JSON.stringify(validated));
}

function deleteChatMessages(sessionId: string): void {
  localStorage.removeItem(messagesKey(sessionId));
}

/** Remove every persisted chat (all message blobs + the index). */
function clearAllChatSessions(): void {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(MESSAGES_KEY_PREFIX)) toRemove.push(k);
  }
  for (const k of toRemove) localStorage.removeItem(k);
  localStorage.removeItem(SESSIONS_INDEX_KEY);
}

// ── History grouping + search (pure) ────────────────────────────────────────

/** Bucket sessions for the history dropdown by `lastActiveAt` relative to local
 *  midnight derived from `now`. Archived sessions go to `archived` regardless of
 *  date. Each bucket is sorted most-recent first. `now` is injected so the
 *  function stays pure/testable. The input array is never mutated. */
function groupChatSessions(sessions: PersistedChatSessionMeta[], now: number): GroupedChatSessions {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday - 86_400_000;
  const startOf7Days = startOfToday - 7 * 86_400_000;

  const out: GroupedChatSessions = { today: [], yesterday: [], previous7Days: [], older: [], archived: [] };
  for (const s of sessions) {
    if (s.isArchived) out.archived.push(s);
    else if (s.lastActiveAt >= startOfToday) out.today.push(s);
    else if (s.lastActiveAt >= startOfYesterday) out.yesterday.push(s);
    else if (s.lastActiveAt >= startOf7Days) out.previous7Days.push(s);
    else out.older.push(s);
  }
  const byRecent = (a: PersistedChatSessionMeta, b: PersistedChatSessionMeta) => b.lastActiveAt - a.lastActiveAt;
  out.today.sort(byRecent);
  out.yesterday.sort(byRecent);
  out.previous7Days.sort(byRecent);
  out.older.sort(byRecent);
  out.archived.sort(byRecent);
  return out;
}

/** Case-insensitive title substring filter. Empty/whitespace query returns all.
 *  Pure — does not mutate the input. */
function searchChatSessions(
  sessions: PersistedChatSessionMeta[],
  query: string,
): PersistedChatSessionMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  return sessions.filter((s) => s.title.toLowerCase().includes(q));
}

export {
  type ChatSessionsIndex,
  type GroupedChatSessions,
  type PersistedChatMessage,
  type PersistedChatSessionMeta,
  type PersistedToolActivity,
  MAX_MESSAGES_PER_SESSION,
  MAX_MESSAGE_CONTENT_CHARS,
  MAX_SESSIONS,
  MAX_TOOLS_PER_MESSAGE,
  MAX_TOOL_JSON_BYTES,
  PersistedChatContextItemSchema,
  PersistedChatMessageSchema,
  PersistedChatSessionMetaSchema,
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
};
