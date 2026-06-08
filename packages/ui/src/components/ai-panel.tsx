import { For, Show, createEffect, createMemo, createSignal, onMount, type JSX } from "solid-js";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import IconSparkles from "~icons/lucide/sparkles";
import IconArrowUp from "~icons/lucide/arrow-up";
import IconSquare from "~icons/lucide/square";
import IconX from "~icons/lucide/x";
import IconFileText from "~icons/lucide/file-text";
import IconTextSelect from "~icons/lucide/text-select";
import type { AIChatMode } from "@asciimark/core/ai-prefs.ts";
import type { AiChatStore } from "../composables/create-ai-chat-store.ts";
import type { AiContextItem } from "../composables/ai-context.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./ui/select.tsx";
import { AiMessage } from "./ai-message.tsx";

/** Compact pill styling for the composer's Select triggers (mode + model),
 *  overriding the SolidUI Select's full-width default. The base ring is dropped
 *  (a click ring inside the composer reads as noise) — only keyboard focus shows
 *  a thin teal ring (the primary, never the UA blue). */
const PILL_SELECT =
  "h-7 w-auto justify-start gap-1.5 rounded-md border-transparent bg-secondary px-2 py-0 text-xs font-medium text-foreground hover:bg-accent focus:ring-0 focus:ring-offset-0 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1";

export interface AiPanelProps {
  store: AiChatStore;
  /** Increment to focus the composer (driven by ⌘L via the host). */
  focusTrigger?: number;
  /** Display label for the active provider/model, or null when none is set.
   *  Used as the footer fallback when no `models` are provided. */
  providerLabel?: string | null;
  /** Model options for the active provider (a `providerId/modelId` value +
   *  label). When provided the footer shows a model picker instead of the
   *  static "connected" chip. */
  models?: Array<{ value: string; label: string }>;
  /** Currently selected model ref (`providerId/modelId`). */
  currentModel?: string;
  /** Context window (tokens) of the active model — drives the usage ring. */
  contextLimit?: number;
  /** Persist a model selection. */
  onSelectModel?: (modelRef: string) => void;
  /** Explicit context items (attached files / selections) shown as chips. */
  contextItems?: AiContextItem[];
  /** The active-document chip (read via tool, shown for awareness), or null. */
  activeFileContext?: { label: string } | null;
  onRemoveContext?: (id: string) => void;
  onDismissActiveFile?: () => void;
  /** Handle a file dropped onto the composer (host reads it + adds context). */
  onContextDrop?: (e: DragEvent) => void;
  /** Workspace files for @-mention autocomplete in the composer. */
  mentionFiles?: Array<{ label: string; path: string; rootId: string }>;
  /** A file was @-mentioned — host reads it + tracks it as an inline reference. */
  onMention?: (file: { label: string; path: string; rootId: string }) => void;
  /** Host request to insert text into the composer (file-tree "Add to chat"):
   *  inserts at the cursor, or appends when the textarea isn't focused. */
  insertRequest?: { text: string; nonce: number } | null;
  /** Reports which "@label" references are currently present in the composer so
   *  the host injects only those files' content. */
  onMentionLabelsChange?: (labels: string[]) => void;
  /** Opens Settings → AI (empty-state CTA). */
  onOpenSettings?: () => void;
  /** Active chat mode (Plan = no tools, saves a plan; Build = implements).
   *  When provided the composer shows a Build/Plan toggle. */
  mode?: AIChatMode;
  /** Persist a mode change. */
  onModeChange?: (mode: AIChatMode) => void;
}

/**
 * The AI sidebar chat. Header-less (the tab already says it's the assistant):
 * a scrollable message list over a composer "box" — the textarea with the
 * provider/model chip and an embedded send arrow in its footer (modern-editor
 * style). Reads everything from `props.store` (the active chat session's store).
 */
export function AiPanel(props: AiPanelProps): JSX.Element {
  const [input, setInput] = createSignal("");
  let textarea: HTMLTextAreaElement | undefined;
  let scroller: HTMLDivElement | undefined;

  createEffect(() => {
    props.focusTrigger;
    textarea?.focus();
  });

  createEffect(() => {
    props.store.messages();
    props.store.streamingText();
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  // Which "@label" file references are present in the composer (so the host
  // injects only those files' content; deleting the text drops the reference).
  function activeMentionLabels(text: string): string[] {
    const labels = props.mentionFiles?.map((f) => f.label) ?? [];
    const found = new Set<string>();
    for (const match of text.matchAll(/@([^\s@]+)/g)) {
      if (labels.includes(match[1]!)) found.add(match[1]!);
    }
    return [...found];
  }
  function syncMentionLabels(text: string): void {
    props.onMentionLabelsChange?.(activeMentionLabels(text));
  }

  // Host-driven insert (file-tree "Add to chat"): at the cursor when the
  // composer is focused, else appended.
  let lastInsertNonce = 0;
  createEffect(() => {
    const req = props.insertRequest;
    if (!req || req.nonce === lastInsertNonce) return;
    lastInsertNonce = req.nonce;
    const ta = textarea;
    const cur = input();
    const focused = !!ta && document.activeElement === ta && ta.selectionStart != null;
    const at = focused ? ta!.selectionStart! : cur.length;
    const sep = !focused && cur && !cur.endsWith(" ") ? " " : "";
    const next = cur.slice(0, at) + sep + req.text + cur.slice(at);
    setInput(next);
    syncMentionLabels(next);
    const caret = at + sep.length + req.text.length;
    queueMicrotask(() => {
      ta?.focus();
      ta?.setSelectionRange(caret, caret);
    });
  });

  function submit(): void {
    const text = input();
    if (!text.trim() || props.store.streaming()) return;
    setInput("");
    void props.store.sendMessage(text);
  }

  // ── @-mention autocomplete ─────────────────────────────────────────────
  const MENTION_RE = /(^|\s)@([^\s@]*)$/;
  const [mentionQuery, setMentionQuery] = createSignal<string | null>(null);
  const [mentionIndex, setMentionIndex] = createSignal(0);

  const mentionMatches = createMemo(() => {
    const q = mentionQuery();
    if (q === null || !props.mentionFiles?.length) return [];
    const ql = q.toLowerCase();
    return props.mentionFiles.filter((f) => f.label.toLowerCase().includes(ql)).slice(0, 8);
  });

  function syncMention(ta: HTMLTextAreaElement): void {
    if (!props.mentionFiles?.length) {
      setMentionQuery(null);
      return;
    }
    const upToCaret = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
    const match = MENTION_RE.exec(upToCaret);
    if (match) {
      setMentionQuery(match[2]!);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }

  function selectMention(file: { label: string; path: string; rootId: string }): void {
    const ta = textarea;
    if (!ta) return;
    const caret = ta.selectionStart ?? input().length;
    const before = input().slice(0, caret).replace(MENTION_RE, (_full, pre: string) => `${pre}@${file.label} `);
    const next = before + input().slice(caret);
    setInput(next);
    setMentionQuery(null);
    props.onMention?.(file);
    syncMentionLabels(next);
    queueMicrotask(() => ta.focus());
  }

  function onKeyDown(e: KeyboardEvent): void {
    // While the @-mention list is open, the arrows/Enter/Escape drive it.
    if (mentionQuery() !== null && mentionMatches().length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionMatches().length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const m = mentionMatches()[mentionIndex()];
        if (m) selectMention(m);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      setInput("");
    }
  }

  const [dragOver, setDragOver] = createSignal(false);

  const hasConversation = (): boolean =>
    props.store.messages().length > 0 || props.store.streaming();

  const hasContext = (): boolean =>
    !!props.activeFileContext || (props.contextItems?.length ?? 0) > 0;

  const currentModelLabel = (): string => {
    const cur = props.models?.find((mdl) => mdl.value === props.currentModel);
    return cur?.label ?? props.providerLabel ?? (useLocale(), m.ai_provider_none());
  };

  return (
    <div class="ai-panel">
      <div class="ai-messages" ref={(el) => (scroller = el)}>
        <Show when={hasConversation()} fallback={<AiEmptyState {...props} />}>
          <For each={props.store.messages()}>
            {(msg) => <AiMessage role={msg.role} content={msg.content} tools={msg.tools} />}
          </For>
          <Show when={props.store.streaming()}>
            <AiMessage
              role="assistant"
              content={props.store.streamingText()}
              tools={props.store.toolActivity()}
              streaming
            />
          </Show>
        </Show>
        <Show when={props.store.error()}>
          {(err) => (
            <div class="ai-error" role="alert">
              {err().message || (useLocale(), m.ai_error_generic())}
            </div>
          )}
        </Show>
      </div>

      <div
        class="ai-composer"
        classList={{ "ai-composer-dragover": dragOver() }}
        onDragOver={(e) => {
          if (!props.onContextDrop) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          props.onContextDrop?.(e);
        }}
      >
        <Show when={hasContext()}>
          <div class="ai-context-bar">
            <Show when={props.activeFileContext}>
              {(ctx) => (
                <span class="ai-context-chip ai-context-chip-active" title={ctx().label}>
                  <IconFileText width={12} height={12} />
                  <span class="ai-context-chip-label">{ctx().label}</span>
                  <button
                    type="button"
                    class="ai-context-chip-x"
                    aria-label={(useLocale(), m.ai_context_remove())}
                    onClick={() => props.onDismissActiveFile?.()}
                  >
                    <IconX width={11} height={11} />
                  </button>
                </span>
              )}
            </Show>
            <For each={props.contextItems}>
              {(item) => (
                <span class="ai-context-chip" title={item.label}>
                  <Show when={item.kind === "selection"} fallback={<IconFileText width={12} height={12} />}>
                    <IconTextSelect width={12} height={12} />
                  </Show>
                  <span class="ai-context-chip-label">{item.label}</span>
                  <button
                    type="button"
                    class="ai-context-chip-x"
                    aria-label={(useLocale(), m.ai_context_remove())}
                    onClick={() => props.onRemoveContext?.(item.id)}
                  >
                    <IconX width={11} height={11} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={mentionQuery() !== null && mentionMatches().length > 0}>
          <div class="ai-mention-list">
            <For each={mentionMatches()}>
              {(file, i) => (
                <button
                  type="button"
                  class="ai-mention-item"
                  classList={{ "ai-mention-item-active": i() === mentionIndex() }}
                  onMouseEnter={() => setMentionIndex(i())}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectMention(file);
                  }}
                >
                  <IconFileText width={12} height={12} />
                  <span class="ai-mention-name">{file.label}</span>
                  <span class="ai-mention-path">{file.path}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <textarea
          ref={(el) => (textarea = el)}
          class="ai-composer-input"
          rows={2}
          placeholder={(useLocale(), m.ai_composer_placeholder())}
          value={input()}
          onInput={(e) => {
            setInput(e.currentTarget.value);
            syncMention(e.currentTarget);
            syncMentionLabels(e.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div class="ai-composer-footer">
          <Show when={props.onModeChange}>
            <Select
              value={props.mode ?? "build"}
              onChange={(v) => {
                if (v) props.onModeChange?.(v as AIChatMode);
              }}
              options={["build", "plan"]}
              gutter={4}
              sameWidth={false}
              itemComponent={(ip) => (
                <SelectItem item={ip.item}>
                  {ip.item.rawValue === "plan" ? (useLocale(), m.ai_mode_plan()) : (useLocale(), m.ai_mode_build())}
                </SelectItem>
              )}
            >
              <SelectTrigger
                class={PILL_SELECT}
                aria-label={(useLocale(), m.ai_mode_label())}
                title={(useLocale(), props.mode === "plan" ? m.ai_mode_plan_hint() : m.ai_mode_build_hint())}
              >
                <span class="truncate">
                  {props.mode === "plan" ? (useLocale(), m.ai_mode_plan()) : (useLocale(), m.ai_mode_build())}
                </span>
              </SelectTrigger>
              <SelectContent class="min-w-[7rem]" />
            </Select>
          </Show>
          <Show
            when={props.models && props.models.length > 0}
            fallback={
              <span
                class="ai-provider-chip"
                classList={{ "ai-provider-chip-active": !!props.providerLabel }}
              >
                <span class="ai-provider-dot" aria-hidden="true" />
                {props.providerLabel ?? (useLocale(), m.ai_provider_none())}
              </span>
            }
          >
            <Select
              value={props.currentModel}
              onChange={(v) => {
                if (v) props.onSelectModel?.(v);
              }}
              options={(props.models ?? []).map((mdl) => mdl.value)}
              gutter={4}
              sameWidth={false}
              itemComponent={(ip) => (
                <SelectItem item={ip.item}>
                  {props.models?.find((mdl) => mdl.value === ip.item.rawValue)?.label ?? ip.item.rawValue}
                </SelectItem>
              )}
            >
              <SelectTrigger class={PILL_SELECT} title={currentModelLabel()} aria-label={currentModelLabel()}>
                <span class="truncate max-w-[120px]">{currentModelLabel()}</span>
              </SelectTrigger>
              <SelectContent class="min-w-[10rem]" />
            </Select>
          </Show>
          <div class="ai-composer-tools">
            <ContextUsage store={props.store} contextLimit={props.contextLimit} />
            <Show
              when={props.store.streaming()}
              fallback={
                <button
                  type="button"
                  class="ai-send-btn"
                  onClick={submit}
                  disabled={!input().trim()}
                  aria-label={(useLocale(), m.ai_composer_send())}
                  title={(useLocale(), m.ai_composer_send())}
                >
                  <IconArrowUp width={16} height={16} />
                </button>
              }
            >
              <button
                type="button"
                class="ai-send-btn ai-stop-btn"
                onClick={() => props.store.cancel()}
                aria-label={(useLocale(), m.ai_composer_stop())}
                title={(useLocale(), m.ai_composer_stop())}
              >
                <IconSquare width={12} height={12} />
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Context usage (estimated) ─────────────────────────────────────────────
/** Length of a JSON-serializable value's serialization, robust to cycles/BigInt. */
function safeLen(value: unknown): number {
  if (value == null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
const estTokens = (chars: number): number => Math.ceil(chars / 4);
/** Fallback context window when the model config declares no `limit`. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** A small circular progress ring — the context-usage indicator (fills as the
 *  conversation approaches the model's context window). */
function ProgressRing(props: { pct: number; size?: number }): JSX.Element {
  const size = props.size ?? 16;
  const sw = 2.5;
  const r = (size - sw) / 2;
  const circ = 2 * Math.PI * r;
  const center = String(size / 2);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} class="ai-ctx-ring" aria-hidden="true">
      <circle class="ai-ctx-ring-track" cx={center} cy={center} r={String(r)} fill="none" stroke-width={String(sw)} />
      <circle
        class="ai-ctx-ring-fill"
        cx={center}
        cy={center}
        r={String(r)}
        fill="none"
        stroke-width={String(sw)}
        stroke-linecap="round"
        stroke-dasharray={String(circ)}
        stroke-dashoffset={String(circ * (1 - Math.max(0, Math.min(1, props.pct))))}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </svg>
  );
}

function ContextUsage(props: { store: AiChatStore; contextLimit?: number }): JSX.Element {
  // System prompt + tool definitions are loaded async (and refreshed when the
  // popover opens, since MCP servers can connect mid-session); the conversation
  // estimate is reactive so the ring fills live as messages stream in.
  const [base, setBase] = createSignal({ system: 0, tools: 0, toolCount: 0 });

  async function loadBase(): Promise<void> {
    const sys = props.store.systemPrompt() ?? "";
    const tools = await props.store.listTools();
    setBase({
      system: estTokens(sys.length),
      tools: estTokens(tools.reduce((n, t) => n + safeLen(t), 0)),
      toolCount: tools.length,
    });
  }
  onMount(() => void loadBase());

  const conversation = createMemo(() => {
    const chars = props.store.messages().reduce((n, msg) => {
      const toolBytes = msg.tools?.reduce((x, t) => x + safeLen(t.args) + safeLen(t.result), 0) ?? 0;
      return n + msg.content.length + toolBytes;
    }, 0);
    return estTokens(chars + props.store.streamingText().length);
  });

  const total = (): number => base().system + base().tools + conversation();
  const windowSize = (): number =>
    props.contextLimit && props.contextLimit > 0 ? props.contextLimit : DEFAULT_CONTEXT_WINDOW;
  const pct = (): number => Math.max(0, Math.min(1, total() / windowSize()));
  const pctLabel = (): string => `${Math.round(pct() * 100)}%`;

  return (
    <Popover
      placement="top-end"
      onOpenChange={(open) => {
        if (open) void loadBase();
      }}
    >
      <PopoverTrigger
        as="button"
        class="ai-send-btn ai-context-btn"
        title={(useLocale(), m.ai_context_usage())}
        aria-label={(useLocale(), m.ai_context_usage())}
      >
        <ProgressRing pct={pct()} />
      </PopoverTrigger>
      <PopoverContent class="ai-context-pop">
        <div class="ai-context-title">{(useLocale(), m.ai_context_usage())}</div>
        <div class="ai-context-row">
          <span>{(useLocale(), m.ai_context_system())}</span>
          <b>{base().system}</b>
        </div>
        <div class="ai-context-row">
          <span>
            {(useLocale(), m.ai_context_tools())} ({base().toolCount})
          </span>
          <b>{base().tools}</b>
        </div>
        <div class="ai-context-row">
          <span>{(useLocale(), m.ai_context_conversation())}</span>
          <b>{conversation()}</b>
        </div>
        <div class="ai-context-row ai-context-total">
          <span>{(useLocale(), m.ai_context_total())}</span>
          <b>
            {total()} · {pctLabel()}
          </b>
        </div>
        <div class="ai-context-note">{(useLocale(), m.ai_context_note())}</div>
      </PopoverContent>
    </Popover>
  );
}

function AiEmptyState(props: AiPanelProps): JSX.Element {
  return (
    <div class="ai-empty">
      <IconSparkles width={28} height={28} class="ai-empty-icon" />
      <Show
        when={props.store.providerReady()}
        fallback={
          <>
            <p class="ai-empty-title">{(useLocale(), m.ai_empty_no_provider_title())}</p>
            <p class="ai-empty-body">{(useLocale(), m.ai_empty_no_provider_body())}</p>
            <Show when={props.onOpenSettings}>
              <Button size="sm" variant="outline" onClick={() => props.onOpenSettings?.()}>
                {(useLocale(), m.ai_empty_no_provider_cta())}
              </Button>
            </Show>
          </>
        }
      >
        <p class="ai-empty-title">{(useLocale(), m.ai_empty_title())}</p>
        <p class="ai-empty-body">{(useLocale(), m.ai_empty_body())}</p>
      </Show>
    </div>
  );
}
