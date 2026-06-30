// Context compaction (history truncation) that can never split a tool call
// from its result. When a chat history outgrows the engine's budget we drop
// the OLDEST messages — but a naive `slice(n)` can land between an assistant
// message carrying `tool-call` parts and the `role:"tool"` message(s) carrying
// the matching `tool-result` parts. Providers reject such orphaned results
// (every tool result must answer a call in the SAME request), so the cut has
// to be nudged to a safe boundary first.
//
// Message shapes (what the engine actually sends, see engines/ai-sdk.ts):
//   - Hosts feed `AIMessage[]` — plain `{ role, content: string }` turns where
//     role is "system" | "user" | "assistant". These can never split a pair.
//   - The AI SDK's `ModelMessage[]` adds `role:"tool"` messages whose content
//     is `tool-result` / `tool-approval-response` parts answering the
//     `tool-call` / `tool-approval-request` parts of the PRECEDING assistant
//     message. Provider-executed results live inside the same assistant
//     message and cannot be split. So the one unsafe place for a cut is the
//     start of any `role:"tool"` message — the only message kind that
//     continues a chain opened earlier.
//
// Note on the SDK's `pruneMessages`: its API prunes message CONTENT by
// kind (`reasoning`, `toolCalls: 'all' | 'before-last-message' | ...`) — it
// strips reasoning/tool parts out of messages, it does not drop the oldest N
// turns. It therefore does not fit oldest-first history truncation, and the
// slice is implemented directly here with `safeCutIndex` as the guard.

import type { ModelMessage } from "ai";
import type { AIMessage } from "./types.ts";

/** Any message the engine may hold in a history: the host's plain text turns
 *  or the AI SDK's richer model messages. */
export type HistoryMessage = AIMessage | ModelMessage;

/** True when `message` continues a tool chain opened by an earlier message —
 *  i.e. it must never become the first message kept after a cut. Only
 *  `role:"tool"` messages qualify: their `tool-result` /
 *  `tool-approval-response` parts answer the preceding assistant message. */
function continuesToolChain(message: HistoryMessage): boolean {
  return message.role === "tool";
}

/** Is cutting at `index` (keeping `messages.slice(index)`) safe? */
function isSafeCut(messages: ReadonlyArray<HistoryMessage>, index: number): boolean {
  if (index <= 0 || index >= messages.length) return true;
  return !continuesToolChain(messages[index]);
}

/**
 * Move a proposed history cut so it never lands between an assistant message
 * containing tool calls and the following tool-result message(s).
 *
 * `desiredIndex` is the first index that would be KEPT (`messages.slice(cut)`
 * semantics). The index is clamped to `[0, messages.length]`; a safe index is
 * returned unchanged. An unsafe index is moved FORWARD (dropping slightly more
 * — the compaction budget is honored) to the next message that does not
 * continue a tool chain. In the degenerate case where everything after the cut
 * is one unbroken chain (forward would empty the window), the cut moves BACK
 * to the assistant message that opened the chain so the call/result pair is
 * kept whole — integrity wins over budget.
 *
 * Pure: never mutates `messages`.
 */
export function safeCutIndex(
  messages: ReadonlyArray<HistoryMessage>,
  desiredIndex: number,
): number {
  const length = messages.length;
  const desired = Math.min(Math.max(Math.trunc(desiredIndex), 0), length);
  if (isSafeCut(messages, desired)) return desired;
  // Forward: the next non-continuation message starts a fresh turn — cutting
  // there drops the whole call/result chain together.
  for (let i = desired + 1; i < length; i++) {
    if (!continuesToolChain(messages[i])) return i;
  }
  // The entire tail is one chain — back up to the message that opened it.
  for (let i = desired - 1; i > 0; i--) {
    if (!continuesToolChain(messages[i])) return i;
  }
  return 0;
}

/**
 * Cap a history at `maxMessages` by dropping the oldest messages at a
 * {@link safeCutIndex} boundary, always keeping leading `system` messages and
 * the latest turns. Returns the SAME array when no compaction is needed; never
 * mutates the input. The result may exceed `maxMessages` only in the
 * degenerate backward-fallback case where honoring the budget would split (or
 * entirely drop) a trailing tool chain.
 */
export function compactMessages<M extends HistoryMessage>(
  messages: M[],
  maxMessages: number,
): M[] {
  if (messages.length <= maxMessages) return messages;
  // Leading system messages are pinned — they carry the instructions that must
  // survive any truncation.
  let head = 0;
  while (head < messages.length && messages[head].role === "system") head++;
  // Budget left for the tail once the pinned head is kept (at least the most
  // recent message survives even under a pathological budget).
  const tailBudget = Math.max(maxMessages - head, 1);
  const desired = Math.max(messages.length - tailBudget, head);
  // The guard never lands below `head` in well-formed histories: a chain opens
  // with an assistant message, which is itself a safe boundary. The clamp is
  // belt-and-braces for malformed input.
  const cut = Math.max(safeCutIndex(messages, desired), head);
  if (cut <= head) return messages;
  return [...messages.slice(0, head), ...messages.slice(cut)];
}
