import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import IconCheck from "~icons/lucide/check";
import IconCopy from "~icons/lucide/copy";
import IconPencil from "~icons/lucide/pencil";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import type { ToolActivity, TurnUsage } from "../composables/create-ai-chat-store.ts";
import { renderChatMarkdown } from "../lib/chat-markdown.ts";

export interface AiMessageProps {
  content: string;
  /** Display-only transform applied to expanded tool chip text (e.g. restore
   *  scrubbed secret placeholders). The host already transforms `content`. */
  displayText?: (text: string) => string;
  role: "user" | "assistant";
  /** True for the in-flight assistant turn — renders a streaming cursor. */
  streaming?: boolean;
  /** Tool activity to surface as compact chips with this turn. */
  tools?: ToolActivity[];
  /** Per-run token stats — rendered as a subtle span in the hover action bar
   *  (assistant turns, when the provider reported usage). */
  usage?: TurnUsage;
  /** Edit-and-resend this USER turn: the host loads its content into the
   *  composer for editing. The action renders only when this is provided. */
  onEdit?: () => void;
  /** Regenerate this reply. Only the host knows which turn is retryable (the
   *  last assistant one), so the action renders only when this is provided. */
  onRetry?: () => void;
}

/** Drop the `<source>__` namespace prefix so a chip reads "read_active_doc"
 *  rather than the raw "app__read_active_doc". */
function toolDisplayName(name: string): string {
  const idx = name.indexOf("__");
  return idx >= 0 ? name.slice(idx + 2) : name;
}

/** Compact count for the usage stats span: 1234 → "1.2k", 980 → "980". */
function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

/** Terminal-friendly text for an expanded tool call: strings verbatim,
 *  everything else pretty-printed JSON. */
function formatToolValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface AiToolChipsProps {
  /** Display-only transform for the expanded terminal block (e.g. restore
   *  scrubbed secret placeholders). Chip names stay raw — they never carry
   *  placeholder text. */
  displayText?: (text: string) => string;
  tools: ToolActivity[];
}

/** Compact chips summarizing tool calls made during a turn. Shared by completed
 *  assistant messages and the in-flight streaming reply. Clicking a chip
 *  expands the raw call (args while running, result when settled) in a
 *  terminal-style block. */
export function AiToolChips(props: AiToolChipsProps): JSX.Element {
  const [expandedId, setExpandedId] = createSignal<string | null>(null);
  const expandedTool = (): ToolActivity | undefined =>
    props.tools.find((t) => t.toolCallId === expandedId());
  const expandedText = (): string => {
    const tool = expandedTool();
    if (!tool) return "";
    const result = formatToolValue(tool.result);
    const args = formatToolValue(tool.args);
    const raw = result
      ? result
      : args
        ? `${toolDisplayName(tool.toolName)} ${args}`
        : toolDisplayName(tool.toolName);
    return props.displayText?.(raw) ?? raw;
  };
  return (
    <div class="ai-tool-chips">
      <For each={props.tools}>
        {(tool) => (
          <button
            type="button"
            class="ai-tool-chip"
            classList={{
              "ai-tool-chip-running": tool.status === "running",
              "ai-tool-chip-done": tool.status === "done",
              "ai-tool-chip-error": tool.status === "error",
              "ai-tool-chip-open": expandedId() === tool.toolCallId,
            }}
            aria-expanded={expandedId() === tool.toolCallId}
            title={
              tool.status === "running"
                ? (useLocale(), m.ai_tool_running())
                : tool.status === "error"
                  ? (useLocale(), m.ai_tool_error())
                  : (useLocale(), m.ai_tool_used())
            }
            onClick={() =>
              setExpandedId((cur) => (cur === tool.toolCallId ? null : tool.toolCallId))
            }
          >
            <span class="ai-tool-chip-icon" aria-hidden="true">
              ⚙
            </span>
            <span class="ai-tool-chip-name">{toolDisplayName(tool.toolName)}</span>
            {/* Source is only informative for MCP servers — in-process "app"
                tools already read clearly from the (de-namespaced) name. */}
            <Show when={tool.source && tool.source !== "app"}>
              <span class="ai-tool-chip-source">· {tool.source}</span>
            </Show>
          </button>
        )}
      </For>
      <Show when={expandedTool()}>
        <pre class="ai-tool-output">{expandedText()}</pre>
      </Show>
    </div>
  );
}

/** A single chat bubble. Kept separate from AiPanel so it's the extension point
 *  for markdown rendering / citation chips in M2. */
export function AiMessage(props: AiMessageProps): JSX.Element {
  // Copy feedback: the button briefly swaps to a check + "Copied" after a
  // successful clipboard write, then reverts.
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  function copyMessage(): void {
    // clipboard is undefined in non-secure contexts (and write can be denied);
    // same defensive idiom as the file tree's copy-path action.
    void navigator.clipboard
      ?.writeText(props.content)
      .then(() => {
        setCopied(true);
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  const copyLabel = (): string =>
    copied() ? (useLocale(), m.ai_message_copied()) : (useLocale(), m.ai_message_copy());

  // Per-run stats for the hover bar — arrows + compact numbers only (no i18n),
  // with the raw token counts in the title. Hidden unless a token count exists.
  const usageStats = (): { text: string; title: string } | undefined => {
    const usage = props.usage;
    if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) {
      return undefined;
    }
    const compact: string[] = [];
    const raw: string[] = [];
    if (usage.inputTokens !== undefined) {
      compact.push(`↑${formatTokenCount(usage.inputTokens)}`);
      raw.push(`↑ ${usage.inputTokens}`);
    }
    if (usage.outputTokens !== undefined) {
      compact.push(`↓${formatTokenCount(usage.outputTokens)}`);
      raw.push(`↓ ${usage.outputTokens}`);
    }
    return { text: compact.join(" "), title: raw.join(" · ") };
  };

  return (
    <div
      class="ai-message"
      classList={{
        "ai-message-user": props.role === "user",
        "ai-message-assistant": props.role === "assistant",
      }}
    >
      <div class="ai-message-role">
        {props.role === "user"
          ? (useLocale(), m.ai_message_role_you())
          : (useLocale(), m.ai_message_role_assistant())}
      </div>
      <Show when={props.tools && props.tools.length > 0}>
        <AiToolChips displayText={props.displayText} tools={props.tools!} />
      </Show>
      <div class="ai-message-text">
        <Show when={props.role === "assistant"} fallback={props.content}>
          {/* `html: false` in renderChatMarkdown escapes raw HTML, so this
              innerHTML never injects model/tool markup. */}
          <div class="ai-markdown" innerHTML={renderChatMarkdown(props.content)} />
        </Show>
        <Show when={props.streaming}>
          <span class="ai-message-cursor" aria-hidden="true" />
        </Show>
      </div>
      {/* Hover action bar (revealed by CSS on .ai-message:hover). */}
      <div class="ai-msg-actions">
        <Show when={usageStats()}>
          {(stats) => (
            <span class="ai-msg-usage" title={stats().title}>
              {stats().text}
            </span>
          )}
        </Show>
        <button
          aria-label={copyLabel()}
          class="ai-msg-action-btn"
          title={copyLabel()}
          type="button"
          onClick={copyMessage}
        >
          <Show when={copied()} fallback={<IconCopy width={13} height={13} />}>
            <IconCheck width={13} height={13} />
          </Show>
        </button>
        <Show when={props.onEdit}>
          <button
            aria-label={(useLocale(), m.ai_message_edit())}
            class="ai-msg-action-btn"
            title={(useLocale(), m.ai_message_edit())}
            type="button"
            onClick={() => props.onEdit?.()}
          >
            <IconPencil width={13} height={13} />
          </button>
        </Show>
        <Show when={props.onRetry}>
          <button
            aria-label={(useLocale(), m.ai_message_regenerate())}
            class="ai-msg-action-btn"
            title={(useLocale(), m.ai_message_regenerate())}
            type="button"
            onClick={() => props.onRetry?.()}
          >
            <IconRefreshCw width={13} height={13} />
          </button>
        </Show>
      </div>
    </div>
  );
}
