import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import IconCheck from "~icons/lucide/check";
import IconCopy from "~icons/lucide/copy";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import type { ToolActivity } from "../composables/create-ai-chat-store.ts";
import { renderChatMarkdown } from "../lib/chat-markdown.ts";

export interface AiMessageProps {
  content: string;
  role: "user" | "assistant";
  /** True for the in-flight assistant turn — renders a streaming cursor. */
  streaming?: boolean;
  /** Tool activity to surface as compact chips with this turn. */
  tools?: ToolActivity[];
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

/** Compact chips summarizing tool calls made during a turn. Shared by completed
 *  assistant messages and the in-flight streaming reply. Clicking a chip
 *  expands the raw call (args while running, result when settled) in a
 *  terminal-style block. */
export function AiToolChips(props: { tools: ToolActivity[] }): JSX.Element {
  const [expandedId, setExpandedId] = createSignal<string | null>(null);
  const expandedTool = (): ToolActivity | undefined =>
    props.tools.find((t) => t.toolCallId === expandedId());
  const expandedText = (): string => {
    const tool = expandedTool();
    if (!tool) return "";
    const result = formatToolValue(tool.result);
    if (result) return result;
    const args = formatToolValue(tool.args);
    return args ? `${toolDisplayName(tool.toolName)} ${args}` : toolDisplayName(tool.toolName);
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
        <AiToolChips tools={props.tools!} />
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
