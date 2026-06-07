import { For, Show, type JSX } from "solid-js";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import type { ToolActivity } from "../composables/create-ai-chat-store.ts";
import { renderChatMarkdown } from "../lib/chat-markdown.ts";

export interface AiMessageProps {
  role: "user" | "assistant";
  content: string;
  /** Tool activity to surface as compact chips with this turn. */
  tools?: ToolActivity[];
  /** True for the in-flight assistant turn — renders a streaming cursor. */
  streaming?: boolean;
}

/** Compact chips summarizing tool calls made during a turn. Shared by completed
 *  assistant messages and the in-flight streaming reply. */
export function AiToolChips(props: { tools: ToolActivity[] }): JSX.Element {
  return (
    <div class="ai-tool-chips">
      <For each={props.tools}>
        {(tool) => (
          <span
            class="ai-tool-chip"
            classList={{
              "ai-tool-chip-running": tool.status === "running",
              "ai-tool-chip-done": tool.status === "done",
              "ai-tool-chip-error": tool.status === "error",
            }}
            title={
              tool.status === "running"
                ? (useLocale(), m.ai_tool_running())
                : tool.status === "error"
                  ? (useLocale(), m.ai_tool_error())
                  : (useLocale(), m.ai_tool_used())
            }
          >
            <span class="ai-tool-chip-icon" aria-hidden="true">
              ⚙
            </span>
            <span class="ai-tool-chip-name">{tool.toolName}</span>
            <Show when={tool.source}>
              <span class="ai-tool-chip-source">· {tool.source}</span>
            </Show>
          </span>
        )}
      </For>
    </div>
  );
}

/** A single chat bubble. Kept separate from AiPanel so it's the extension point
 *  for markdown rendering / citation chips in M2. */
export function AiMessage(props: AiMessageProps): JSX.Element {
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
    </div>
  );
}
