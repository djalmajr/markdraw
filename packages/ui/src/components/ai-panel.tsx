import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onMount, type JSX } from "solid-js";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import IconSparkles from "~icons/lucide/sparkles";
import IconArrowUp from "~icons/lucide/arrow-up";
import IconSquare from "~icons/lucide/square";
import IconX from "~icons/lucide/x";
import IconFileText from "~icons/lucide/file-text";
import IconFolder from "~icons/lucide/folder";
import IconTextSelect from "~icons/lucide/text-select";
import type { AIChatMode } from "@asciimark/core/ai-prefs.ts";
import { expandSlashCommand, type SlashCommandDef } from "@asciimark/ai/slash-commands.ts";
import type { AiChatStore } from "../composables/create-ai-chat-store.ts";
import type { AiContextItem } from "../composables/ai-context.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./ui/select.tsx";
import { ScrollArea } from "./ui/scroll-area.tsx";
import { ModelPicker, type ModelGroup } from "./model-picker.tsx";
import { AiMessage } from "./ai-message.tsx";
import { AiPlan, type AiPlanItemModel } from "./ai-plan.tsx";

/** Compact pill styling for the composer's Select triggers (mode + model),
 *  overriding the SolidUI Select's full-width default. The base ring is dropped
 *  (a click ring inside the composer reads as noise) — only keyboard focus shows
 *  a thin teal ring (the primary, never the UA blue). */
const PILL_SELECT =
  "h-7 w-auto justify-start gap-1.5 rounded-md border-transparent bg-secondary px-2 py-0 text-xs font-medium text-foreground hover:bg-accent focus:ring-0 focus:ring-offset-0 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1";

/** A workspace entry offered by the @-mention autocomplete. `kind: "dir"`
 *  marks a folder (or a workspace root — `path: ""`) whose mention attaches a
 *  subtree listing instead of file content; omitted kind means a file. */
export interface AiMentionEntry {
  kind?: "dir" | "file";
  label: string;
  path: string;
  rootId: string;
}

export interface AiPanelProps {
  store: AiChatStore;
  /** Increment to focus the composer (driven by ⌘L via the host). */
  focusTrigger?: number;
  /** Display label for the active provider/model, or null when none is set.
   *  Used as the footer fallback when no `models` are provided. */
  providerLabel?: string | null;
  /** Available models grouped by provider (OpenCode-style picker). When any
   *  group has models the footer shows the model picker instead of the static
   *  "connected" chip. */
  modelGroups?: ModelGroup[];
  /** Currently selected model ref (`providerId/modelId`). */
  currentModel?: string;
  /** Context window (tokens) of the active model — drives the usage ring. */
  contextLimit?: number;
  /** Transform message text for DISPLAY only (e.g. restore scrubbed secret
   *  placeholders) — the store keeps the original text untouched. */
  displayText?: (text: string) => string;
  /** Persist a model selection. */
  onSelectModel?: (modelRef: string) => void;
  /** "⚙" in the picker — open Settings → AI (manage models / connect providers). */
  onManageModels?: () => void;
  /** Explicit context items (attached files / selections) shown as chips. */
  contextItems?: AiContextItem[];
  /** The active-document chip (read via tool, shown for awareness), or null. */
  activeFileContext?: { label: string } | null;
  onRemoveContext?: (id: string) => void;
  onDismissActiveFile?: () => void;
  /** Handle a file dropped onto the composer (host reads it + adds context). */
  onContextDrop?: (e: DragEvent) => void;
  /** Workspace files + folders (and the roots themselves) for @-mention
   *  autocomplete in the composer. */
  mentionFiles?: AiMentionEntry[];
  /** An entry was @-mentioned — host resolves it (file content / folder
   *  listing) + attaches it as a context chip. */
  onMention?: (file: AiMentionEntry) => void;
  /** File-backed slash commands for the composer's "/" autocomplete. A sent
   *  "/name args" expands the matching template before reaching the store. */
  slashCommands?: SlashCommandDef[];
  /** Opens Settings → AI (empty-state CTA). */
  onOpenSettings?: () => void;
  /** Open an http(s) link from a chat reply in the OS browser. Clicks on chat
   *  links are ALWAYS intercepted — without this the webview itself would
   *  navigate away to the link target (hijacking the whole app). */
  onOpenExternal?: (url: string) => void;
  /** Active chat mode (Plan = no tools, saves a plan; Build = implements).
   *  When provided the composer shows a Build/Plan toggle. */
  mode?: AIChatMode;
  /** Live plan items (app__update_plan) — when non-empty the checklist card
   *  renders above the composer. */
  planItems?: AiPlanItemModel[];
  /** Dismiss the plan card entirely. */
  onClearPlan?: () => void;
  /** Persist a mode change. */
  onModeChange?: (mode: AIChatMode) => void;
  /** User checked/unchecked a plan item. */
  onTogglePlanItem?: (index: number) => void;
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

  // ── Edit-and-resend (a past user turn loaded into the composer) ─────────
  const [editing, setEditing] = createSignal<{ index: number } | null>(null);

  // The panel is a single instance fed the ACTIVE session's store — a pending
  // edit must die on chat switch or its index would truncate the wrong chat.
  createEffect(
    on(
      () => props.store,
      () => cancelEditing(),
      { defer: true },
    ),
  );

  function startEditing(index: number, content: string): void {
    setEditing({ index });
    setInput(content);
    textarea?.focus();
  }

  function cancelEditing(): void {
    setEditing(null);
    setInput("");
    // The autocomplete popovers belong to the abandoned draft — left open they
    // would keep capturing arrows/Enter over the next chat's empty composer.
    setMentionQuery(null);
    setSlashQuery(null);
  }

  function submit(): void {
    const text = input();
    if (!text.trim()) return;
    const edit = editing();
    if (edit) {
      // editAndResend is a no-op while streaming — keep the editing state and
      // the typed text instead of silently discarding the edit.
      if (props.store.streaming()) return;
      // Editing replaces the turn at `edit.index` (later turns drop) instead
      // of appending a new one.
      setEditing(null);
      setInput("");
      void props.store.editAndResend(edit.index, text);
      return;
    }
    // While a turn streams, the store queues the message (steering) — the
    // composer clears either way so the user keeps typing. A send-button click
    // bypasses the textarea's input event, so the autocomplete popovers must
    // close explicitly or they'd float over the streaming reply.
    setInput("");
    setMentionQuery(null);
    setSlashQuery(null);
    void props.store.sendMessage(expandIfSlashCommand(text));
  }

  // ── "/" slash commands ─────────────────────────────────────────────────
  /** A whole-message slash invocation: "/name" optionally followed by args. */
  const SLASH_SUBMIT_RE = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i;

  /** Text actually sent for a (non-editing) submit: "/name args" expands the
   *  matching command's template; an unknown name passes through unchanged
   *  (the model sees the raw "/name args" text). */
  function expandIfSlashCommand(text: string): string {
    const match = SLASH_SUBMIT_RE.exec(text.trim());
    if (!match) return text;
    const name = match[1]!.toLowerCase();
    const command = props.slashCommands?.find((c) => c.name === name);
    if (!command) return text;
    return expandSlashCommand(command.template, match[2] ?? "");
  }

  // ── "/" command autocomplete ───────────────────────────────────────────
  // Triggers ONLY while the text up to the caret is "/<partial-name>" — the
  // slash must be the very first character and no whitespace typed yet, so a
  // "/" mid-sentence stays plain text.
  const SLASH_RE = /^\/([a-z0-9_-]*)$/i;
  const [slashQuery, setSlashQuery] = createSignal<string | null>(null);
  const [slashIndex, setSlashIndex] = createSignal(0);

  const slashMatches = createMemo(() => {
    const q = slashQuery();
    if (q === null || !props.slashCommands?.length) return [];
    const ql = q.toLowerCase();
    return props.slashCommands.filter((c) => c.name.startsWith(ql)).slice(0, 8);
  });

  function syncSlash(ta: HTMLTextAreaElement): void {
    if (!props.slashCommands?.length) {
      setSlashQuery(null);
      return;
    }
    const upToCaret = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
    const match = SLASH_RE.exec(upToCaret);
    if (match) {
      setSlashQuery(match[1]!);
      setSlashIndex(0);
    } else {
      setSlashQuery(null);
    }
  }

  // Selecting a command replaces the typed "/<partial>" prefix with "/name "
  // (the trailing space closes the list) and keeps the caret right after it,
  // focus staying in the composer for the arguments.
  function selectSlashCommand(command: SlashCommandDef): void {
    const ta = textarea;
    if (!ta) return;
    const caret = ta.selectionStart ?? input().length;
    const inserted = `/${command.name} `;
    setInput(inserted + input().slice(caret));
    setSlashQuery(null);
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(inserted.length, inserted.length);
    });
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

  // Selecting a mention REMOVES the "@query" token from the composer (the
  // reference lives as a context chip, not inline text) and hands the entry to
  // the host, which resolves + attaches it.
  function selectMention(file: AiMentionEntry): void {
    const ta = textarea;
    if (!ta) return;
    const caret = ta.selectionStart ?? input().length;
    const before = input().slice(0, caret).replace(MENTION_RE, (_full, pre: string) => pre);
    const next = before + input().slice(caret);
    setInput(next);
    setMentionQuery(null);
    props.onMention?.(file);
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(before.length, before.length);
    });
  }

  function onKeyDown(e: KeyboardEvent): void {
    // While the slash-command list is open, the arrows/Enter/Escape drive it
    // (same contract as the @-mention list below — the two never coexist:
    // mentions need an "@" token, slash needs a leading "/").
    if (slashQuery() !== null && slashMatches().length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, slashMatches().length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const command = slashMatches()[slashIndex()];
        if (command) selectSlashCommand(command);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        return;
      }
    }
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
      // Escape also abandons an in-progress edit (composer back to empty).
      cancelEditing();
    }
  }

  const [dragOver, setDragOver] = createSignal(false);

  const hasConversation = (): boolean =>
    props.store.messages().length > 0 || props.store.streaming();

  /** Display-only transform of a message's text — the store text is never
   *  touched (edit-and-resend keeps loading the original). */
  const displayed = (text: string): string => props.displayText?.(text) ?? text;

  const hasContext = (): boolean =>
    !!props.activeFileContext || (props.contextItems?.length ?? 0) > 0;

  const allModels = (): { value: string; label: string }[] =>
    (props.modelGroups ?? []).flatMap((g) => g.models);
  const hasModels = (): boolean => allModels().length > 0;
  const currentModelLabel = (): string => {
    const cur = allModels().find((mdl) => mdl.value === props.currentModel);
    return cur?.label ?? props.providerLabel ?? (useLocale(), m.ai_provider_none());
  };

  // Chat replies must never navigate the webview: a reply link is untrusted
  // model output, and an uncaught click would replace the whole app with the
  // link target. Delegated on the scroll viewport so it covers completed and
  // streaming messages alike; http(s) goes to the OS browser, anything else
  // (relative paths, odd schemes) is inert.
  function onMessagesClick(e: MouseEvent): void {
    const link = (e.target as Element | null)?.closest?.("a[href]");
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) props.onOpenExternal?.(href);
  }

  return (
    <div class="ai-panel">
      <ScrollArea
        class="ai-messages"
        contentClass="ai-messages-content"
        viewportRef={(el) => {
          scroller = el;
          el.addEventListener("click", onMessagesClick);
        }}
      >
        <Show when={hasConversation()} fallback={<AiEmptyState {...props} />}>
          <For each={props.store.messages()}>
            {(msg, i) => (
              <AiMessage
                content={displayed(msg.content)}
                role={msg.role}
                tools={msg.tools}
                usage={msg.usage}
                // Any user turn can be edited-and-resent: the click loads its
                // content into the composer (the store guards re-runs while a
                // turn streams).
                onEdit={
                  // Gated on idle like onRetry — editAndResend no-ops while a
                  // turn streams, so offering the pencil then would mislead.
                  msg.role === "user" && !props.store.streaming()
                    ? () => startEditing(i(), msg.content)
                    : undefined
                }
                // Retry only makes sense on the LAST assistant reply, and never
                // while a fresh turn is already streaming.
                onRetry={
                  msg.role === "assistant" &&
                  i() === props.store.messages().length - 1 &&
                  !props.store.streaming()
                    ? () => void props.store.retryLast()
                    : undefined
                }
              />
            )}
          </For>
          <Show when={props.store.streaming()}>
            <AiMessage
              role="assistant"
              content={displayed(props.store.streamingText())}
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
      </ScrollArea>

      <Show when={(props.planItems?.length ?? 0) > 0}>
        <AiPlan
          items={props.planItems!}
          onClear={() => props.onClearPlan?.()}
          onToggleItem={(index) => props.onTogglePlanItem?.(index)}
        />
      </Show>

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
        <Show when={editing()}>
          <div class="ai-editing-bar">
            <span class="ai-editing-label">{(useLocale(), m.ai_message_edit())}</span>
            <button
              aria-label={(useLocale(), m.ai_context_remove())}
              class="ai-context-chip-x"
              type="button"
              onClick={cancelEditing}
            >
              <IconX width={11} height={11} />
            </button>
          </div>
        </Show>
        <Show when={props.store.queued()}>
          {(queuedText) => (
            <div class="ai-queued-bar">
              <span class="ai-queued-label">{(useLocale(), m.ai_queued())}</span>
              <span class="ai-queued-text" title={queuedText()}>
                {queuedText()}
              </span>
              <button
                type="button"
                class="ai-context-chip-x"
                aria-label={(useLocale(), m.ai_context_remove())}
                onClick={() => props.store.cancelQueued()}
              >
                <IconX width={11} height={11} />
              </button>
            </div>
          )}
        </Show>
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
                  <Switch fallback={<IconFileText width={12} height={12} />}>
                    <Match when={item.kind === "folder"}>
                      <IconFolder width={12} height={12} />
                    </Match>
                    <Match when={item.kind === "selection"}>
                      <IconTextSelect width={12} height={12} />
                    </Match>
                  </Switch>
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
                  <Show when={file.kind === "dir"} fallback={<IconFileText width={12} height={12} />}>
                    <IconFolder width={12} height={12} />
                  </Show>
                  <span class="ai-mention-name">
                    {file.kind === "dir" && !file.label.endsWith("/") ? `${file.label}/` : file.label}
                  </span>
                  <span class="ai-mention-path">{file.path}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={slashQuery() !== null && slashMatches().length > 0}>
          <div class="ai-mention-list ai-slash-list">
            <For each={slashMatches()}>
              {(command, i) => (
                <button
                  class="ai-mention-item ai-slash-item"
                  classList={{ "ai-mention-item-active": i() === slashIndex() }}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectSlashCommand(command);
                  }}
                  onMouseEnter={() => setSlashIndex(i())}
                >
                  <span class="ai-mention-name ai-slash-name">/{command.name}</span>
                  <Show when={command.description}>
                    <span class="ai-mention-path">{command.description}</span>
                  </Show>
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
            syncSlash(e.currentTarget);
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
            when={hasModels()}
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
            <ModelPicker
              groups={props.modelGroups ?? []}
              current={props.currentModel}
              currentLabel={currentModelLabel()}
              onSelect={(v) => props.onSelectModel?.(v)}
              onManage={props.onManageModels}
            />
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
