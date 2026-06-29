import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onMount, type JSX } from "solid-js";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import IconSparkles from "~icons/lucide/sparkles";
import IconArrowUp from "~icons/lucide/arrow-up";
import IconSquare from "~icons/lucide/square";
import IconX from "~icons/lucide/x";
import IconFileText from "~icons/lucide/file-text";
import IconFolder from "~icons/lucide/folder";
import IconTextSelect from "~icons/lucide/text-select";
import type { AIChatMode } from "@markdraw/core/ai-prefs.ts";
import { isSupportedFile } from "@markdraw/core/utils.ts";
import { expandSlashCommand, type SlashCommandDef } from "@markdraw/ai/slash-commands.ts";
import type { AiChatStore } from "../composables/create-ai-chat-store.ts";
import type { AiContextItem, AiInlineReference } from "../composables/ai-context.ts";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { ScrollArea } from "./ui/scroll-area.tsx";
import { ModelPicker, type ModelGroup } from "./model-picker.tsx";
import { AiMessage } from "./ai-message.tsx";
import { AiPlan, type AiPlanItemModel } from "./ai-plan.tsx";
import { PillPicker } from "./pill-picker.tsx";

/** A workspace entry offered by the @-mention autocomplete. `kind: "dir"`
 *  marks a folder (or a workspace root — `path: ""`) whose mention attaches a
 *  subtree listing instead of file content; omitted kind means a file. */
export interface AiMentionEntry {
  kind?: "dir" | "file";
  label: string;
  path: string;
  rootId: string;
  /** Display-only disambiguation hint: the owning root's name, set by the
   *  host when more than one workspace root is open. */
  rootLabel?: string;
}

export interface AiSkillEntry {
  id: string;
  name: string;
  description?: string;
  slashCommands?: string[];
  scope: "global" | "project";
}

/** A tracked composer token: an @-mention (whose context item the host
 *  resolves ASYNC) or a direct context-item reference (selection chips — the
 *  item exists synchronously when the token is born). */
type TrackedRef = { entry: AiMentionEntry; kind: "mention" } | { itemId: string; kind: "item" };
type SlashMatch =
  | { command: SlashCommandDef; description?: string; kind: "command"; name: string }
  | { description?: string; kind: "skill"; name: string; skill: AiSkillEntry };

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
  /** Reasoning effort for the chosen model (an OpenCode-style label, e.g.
   *  "default"|"low"|"high"|"max") + handler. Rendered next to the model picker
   *  — it only applies to the selected model, so it lives by the model, not in
   *  global Settings. */
  reasoningEffort?: string;
  /** The effort levels the active model actually exposes, in display order.
   *  Empty/undefined ⇒ the model has no reasoning control and the picker hides
   *  (e.g. a model that bakes the level into its name). */
  reasoningLevels?: string[];
  onReasoningEffortChange?: (value: string) => void;
  /** Explicit context items (attached files / selections) shown as chips. */
  contextItems?: AiContextItem[];
  /** The active-document chip (read via tool, shown for awareness), or null. */
  activeFileContext?: { label: string } | null;
  /** Host-requested inline reference: insert "@token" for a context item
   *  (selection chips) into the composer. `seq` bumps retrigger insertion
   *  even for an identical reference. */
  inlineReference?: AiInlineReference | null;
  /** Ack for `inlineReference`: the panel consumed it, the host clears the
   *  signal. Keeps a pending reference distinguishable from a stale one, so
   *  a panel that MOUNTS with a reference present (chat tab was closed when
   *  the user hit ⌘I) still inserts the token instead of swallowing it. */
  onInlineReferenceHandled?: () => void;
  onRemoveContext?: (id: string) => void;
  /** The context-item IDS behind the composer's inline tokens, in TEXTUAL
   *  order, emitted right before a send — the host reorders its context array
   *  to match (the preamble injects items in array order, so this is the
   *  order the model receives the references in). */
  onReorderContext?: (ids: string[]) => void;
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
  /** The "/" autocomplete just opened (closed→open transition) — the host can
   *  refresh `slashCommands`; the open list reads the prop reactively, so a
   *  late-arriving fresh list updates it in place. */
  onSlashMenuOpen?: () => void;
  /** Auto-discovered agent skills for the composer's "$" autocomplete. A sent
   *  "$name" token remains in the user's text; the host/orchestrator uses it to
   *  inject the matching skill instructions. */
  skills?: AiSkillEntry[];
  /** The "$" autocomplete just opened — the host can refresh discovered skills. */
  onSkillsMenuOpen?: () => void;
  /** Opens Settings → AI (empty-state CTA). */
  onOpenSettings?: () => void;
  /** Open an http(s) link from a chat reply in the OS browser. Clicks on chat
   *  links are ALWAYS intercepted — without this the webview itself would
   *  navigate away to the link target (hijacking the whole app). */
  onOpenExternal?: (url: string) => void;
  /** Navigate a document link emitted inside a chat reply, using the host's
   *  workspace navigation instead of webview navigation. */
  onNavigateDocument?: (path: string, fragment?: string | null) => void;
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

function isSupportedChatDocumentHref(href: string): boolean {
  const path = stripDocumentLocationSuffix(href.split("#")[0] ?? "");
  if (!path) return false;
  if (isSupportedFile(path)) return true;
  if (path.endsWith(".html")) return true;
  if (path.includes("://")) return false;
  const lastSegment = path.split("/").pop() ?? "";
  return path.includes("/") && !lastSegment.includes(".");
}

function stripDocumentLocationSuffix(path: string): string {
  return path.replace(
    /(\.(?:adoc\.txt|asciidoc|markdown|mdown|adoc|asc|ad|md)):\d+(?::\d+)?$/i,
    "$1",
  );
}

function normalizeChatDocumentHref(href: string): { path: string; fragment: string | null } {
  const hashIdx = href.indexOf("#");
  let path = stripDocumentLocationSuffix(hashIdx >= 0 ? href.slice(0, hashIdx) : href);
  const fragment = hashIdx >= 0 ? decodeURIComponent(href.slice(hashIdx + 1)) : null;
  if (path.endsWith(".html")) path = path.slice(0, -5) + ".adoc";
  return { path, fragment: fragment || null };
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
  let highlightEl: HTMLDivElement | undefined;
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
    // Loading the turn bypasses the textarea's input event (where syncSlash /
    // syncSkill run) — open popovers from the abandoned draft would otherwise
    // capture the edit's Enter.
    setSlashQuery(null);
    setSkillQuery(null);
    // The pending draft's inline tokens die with the draft. The loaded text
    // may contain literal "@..." strings from the original message — those
    // references were consumed at the original send and are NOT re-tracked.
    clearTrackedTokens();
    textarea?.focus();
  }

  function cancelEditing(): void {
    setEditing(null);
    setInput("");
    // The autocomplete popovers belong to the abandoned draft — left open they
    // would keep capturing arrows/Enter over the next chat's empty composer.
    setMentionQuery(null);
    setSlashQuery(null);
    setSkillQuery(null);
    // The draft's inline tokens die with it — their context items too.
    clearTrackedTokens();
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
      // of appending a new one. Deliberately NO slash expansion here: an
      // edited turn was already expanded at its original send. Mentions added
      // DURING the edit ride the same consumption as a normal send — the
      // re-run turn reads the context preamble too.
      setEditing(null);
      setInput("");
      setMentionQuery(null);
      setSlashQuery(null);
      setSkillQuery(null);
      const editTracked = beginTokenConsumption(text);
      settleTokenConsumption(editTracked, props.store.editAndResend(edit.index, text));
      return;
    }
    // While a turn streams, the store queues the message (steering) — the
    // composer clears either way so the user keeps typing. A send-button click
    // bypasses the textarea's input event, so the autocomplete popovers must
    // close explicitly or they'd float over the streaming reply.
    setInput("");
    setMentionQuery(null);
    setSlashQuery(null);
    setSkillQuery(null);
    // The sent text keeps the inline tokens VERBATIM — the reorder + consume
    // pair runs before the send so the preamble matches the tokens' order.
    const tracked = beginTokenConsumption(text);
    settleTokenConsumption(tracked, props.store.sendMessage(expandIfSlashCommand(text)));
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
  const SLASH_SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
  const [slashQuery, setSlashQuery] = createSignal<string | null>(null);
  const [slashIndex, setSlashIndex] = createSignal(0);

  const slashMatches = createMemo(() => {
    const q = slashQuery();
    if (q === null) return [];
    const ql = q.toLowerCase();
    const commands = props.slashCommands ?? [];
    const commandNames = new Set(commands.map((c) => c.name));
    const commandMatches: SlashMatch[] = commands
      .filter((c) => c.name.startsWith(ql))
      .map((command) => ({
        command,
        description: command.description,
        kind: "command",
        name: command.name,
      }));
    const skillMatches: SlashMatch[] = (props.skills ?? [])
      .flatMap((skill) => (skill.slashCommands ?? []).map((name) => ({ name, skill })))
      .filter(({ name }) => SLASH_SAFE_NAME_RE.test(name) && !commandNames.has(name) && name.startsWith(ql))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, skill }) => ({
        kind: "skill",
        name,
        skill,
      }));
    return [...commandMatches, ...skillMatches].slice(0, 8);
  });

  function syncSlash(ta: HTMLTextAreaElement): void {
    // No autocomplete while editing a past turn: the edit submit path never
    // expands commands (the turn was expanded at its original send), so the
    // list would offer an expansion that cannot happen. Mentions stay active —
    // they attach context chips, orthogonal to the send path.
    if (editing() || (!props.slashCommands?.length && !props.skills?.length)) {
      setSlashQuery(null);
      return;
    }
    const upToCaret = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
    const match = SLASH_RE.exec(upToCaret);
    if (match) {
      setSlashQuery(match[1]!);
      setSlashIndex(0);
      setMentionQuery(null);
      setSkillQuery(null);
    } else {
      setSlashQuery(null);
    }
  }

  // Closed→open transition of the slash autocomplete → let the host refresh
  // the command list (freshness without a file watcher). `slashMatches` reads
  // `props.slashCommands` inside its memo, so a late-arriving fresh list
  // updates the already-open popover in place.
  createEffect(
    on(
      () => slashQuery() !== null,
      (open, wasOpen) => {
        if (open && !wasOpen) {
          props.onSlashMenuOpen?.();
          props.onSkillsMenuOpen?.();
        }
      },
    ),
  );

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

  function selectSlashSkill(match: Extract<SlashMatch, { kind: "skill" }>): void {
    const ta = textarea;
    if (!ta) return;
    const caret = ta.selectionStart ?? input().length;
    const inserted = `/${match.name} `;
    setInput(inserted + input().slice(caret));
    setSlashQuery(null);
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(inserted.length, inserted.length);
    });
  }

  function selectSlashMatch(match: SlashMatch): void {
    if (match.kind === "command") selectSlashCommand(match.command);
    else selectSlashSkill(match);
  }

  // ── "$" skill autocomplete ─────────────────────────────────────────────
  const SKILL_RE = /(^|\s)\$([^\s$]*)$/;
  const [skillQuery, setSkillQuery] = createSignal<string | null>(null);
  const [skillIndex, setSkillIndex] = createSignal(0);

  function skillInvocationName(skill: AiSkillEntry): string {
    return skill.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  const skillMatches = createMemo(() => {
    const q = skillQuery();
    if (q === null || !props.skills?.length) return [];
    const ql = q.toLowerCase();
    return props.skills
      .filter((skill) => skillInvocationName(skill).includes(ql))
      .sort((a, b) => {
        const an = skillInvocationName(a);
        const bn = skillInvocationName(b);
        const ap = an.startsWith(ql) ? 0 : 1;
        const bp = bn.startsWith(ql) ? 0 : 1;
        return ap - bp || an.localeCompare(bn);
      })
      .slice(0, 8);
  });

  function syncSkill(ta: HTMLTextAreaElement): void {
    if (!props.skills?.length) {
      setSkillQuery(null);
      return;
    }
    const upToCaret = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
    const match = SKILL_RE.exec(upToCaret);
    if (match) {
      setSkillQuery(match[2]!);
      setSkillIndex(0);
      setMentionQuery(null);
      setSlashQuery(null);
    } else {
      setSkillQuery(null);
    }
  }

  createEffect(
    on(
      () => skillQuery() !== null,
      (open, wasOpen) => {
        if (open && !wasOpen) props.onSkillsMenuOpen?.();
      },
    ),
  );

  function selectSkill(skill: AiSkillEntry): void {
    const ta = textarea;
    if (!ta) return;
    const caret = ta.selectionStart ?? input().length;
    const token = `$${skillInvocationName(skill)}`;
    const before = input()
      .slice(0, caret)
      .replace(SKILL_RE, (_full, pre: string) => `${pre}${token} `);
    const next = before + input().slice(caret);
    setInput(next);
    setSkillQuery(null);
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(before.length, before.length);
    });
  }

  // ── @-mention autocomplete ─────────────────────────────────────────────
  const MENTION_RE = /(^|\s)@([^\s@]*)$/;
  const [mentionQuery, setMentionQuery] = createSignal<string | null>(null);
  const [mentionIndex, setMentionIndex] = createSignal(0);

  // ── Inline reference tokens (Cursor-style) ─────────────────────────────
  // A selected mention — or a host-requested selection reference — stays in
  // the message TEXT as a literal "@label" token; this map (token string →
  // tracked ref) is the panel's record of which substrings are live
  // references. Consumed tokens (sent, awaiting settlement) park in a counted
  // identity map so the chips bar keeps hiding their items until removal
  // actually fires — counted, because the SAME ref can ride two in-flight
  // sends (a steering send while a turn streams).
  const [inlineRefs, setInlineRefs] = createSignal<Map<string, TrackedRef>>(new Map());
  const [consumedRefs, setConsumedRefs] = createSignal<Map<string, number>>(new Map());
  // Mention identities whose context item didn't exist yet at removal time
  // (the host resolves file content ASYNC, so a token can die before its
  // item lands). Item refs never queue here — their item exists synchronously
  // when the token is born.
  const [pendingRemovals, setPendingRemovals] = createSignal<Set<string>>(new Set());

  const mentionItemKind = (entry: AiMentionEntry): "file" | "folder" =>
    entry.kind === "dir" ? "folder" : "file";

  const isSameMentionEntry = (a: AiMentionEntry, b: AiMentionEntry): boolean =>
    a.path === b.path && a.rootId === b.rootId && mentionItemKind(a) === mentionItemKind(b);

  /** Identity of a mention target — kind + rootId + path. Labels collide
   *  across roots (twin "notes.md" files in two workspaces), so removal and
   *  chip-hiding must key on this, never on the label. */
  const mentionIdentity = (entry: AiMentionEntry): string =>
    `${mentionItemKind(entry)}\n${entry.rootId}\n${entry.path}`;

  /** Identity of any tracked ref. Item refs use "item\n<id>" — a format the
   *  mention identity (kind\nrootId\npath) can never produce, since "item" is
   *  not a mention kind. */
  const refIdentity = (ref: TrackedRef): string =>
    ref.kind === "mention" ? mentionIdentity(ref.entry) : `item\n${ref.itemId}`;

  /** The same identity for a host context item, or null when the host
   *  attached it without path/rootId (then only the label can match). */
  const itemIdentity = (item: AiContextItem): string | null =>
    item.kind !== "selection" && item.path !== undefined && item.rootId !== undefined
      ? `${item.kind}\n${item.rootId}\n${item.path}`
      : null;

  /** Remove the resolved context item behind `entry` — matched by identity
   *  (label+kind only for items without path/rootId) — or, when the host
   *  hasn't landed it yet, queue the identity so the contextItems effect
   *  below removes it on arrival. */
  function removeMentionItem(entry: AiMentionEntry): void {
    const identity = mentionIdentity(entry);
    const kind = mentionItemKind(entry);
    const item = props.contextItems?.find((i) =>
      itemIdentity(i) === null
        ? i.kind === kind && i.label === entry.label
        : itemIdentity(i) === identity,
    );
    if (item) props.onRemoveContext?.(item.id);
    else setPendingRemovals((prev) => new Set(prev).add(identity));
  }

  /** Remove the context item behind a tracked ref. Item refs remove by id
   *  directly — their item existed when the token was born, so no
   *  pendingRemovals path applies. */
  function removeTrackedRef(ref: TrackedRef): void {
    if (ref.kind === "mention") removeMentionItem(ref.entry);
    else props.onRemoveContext?.(ref.itemId);
  }

  // Async-orphan sweep: a token died before its item resolved — drop the item
  // the moment the host lands it. Matched by identity, so a twin (same label,
  // other root) landing in the same batch survives. Only the matched
  // identities clear; the rest of the set keeps waiting.
  createEffect(() => {
    const items = props.contextItems ?? [];
    const pending = pendingRemovals();
    if (pending.size === 0) return;
    const matched = items.filter((i) => {
      const identity = itemIdentity(i);
      return identity !== null && pending.has(identity);
    });
    if (matched.length === 0) return;
    for (const item of matched) props.onRemoveContext?.(item.id);
    setPendingRemovals((prev) => {
      const next = new Set(prev);
      for (const item of matched) next.delete(itemIdentity(item)!);
      return next;
    });
  });

  /** Untrack every token whose literal string no longer occurs in `text` and
   *  remove its resolved item. Called ONLY from the textarea's input event —
   *  programmatic setInput paths (submit/cancel/edit/chat-switch) handle
   *  their own cleanup. */
  function reconcileTokens(text: string): void {
    const tracked = inlineRefs();
    if (tracked.size === 0) return;
    let changed = false;
    const next = new Map(tracked);
    for (const [token, ref] of tracked) {
      if (hasTokenWithBoundary(text, token)) continue;
      next.delete(token);
      changed = true;
      removeTrackedRef(ref);
    }
    if (changed) setInlineRefs(next);
  }

  /** True when `token` occurs in `text` followed by whitespace or the end of
   *  the text. A bare `includes` would keep a token alive while it merely
   *  prefixes a longer one ("@wksp/" inside "@wksp/a/notes.md") or after the
   *  user glued characters onto it ("@a.md" edited into "@a.mdx"). */
  function hasTokenWithBoundary(text: string, token: string): boolean {
    let from = 0;
    while (true) {
      const at = text.indexOf(token, from);
      if (at < 0) return false;
      const after = text[at + token.length];
      if (after === undefined || /\s/.test(after)) return true;
      from = at + 1;
    }
  }

  /** Draft death: the tracked (non-consumed) tokens die with the draft —
   *  remove their items (pending-removal set covers unresolved mentions) and
   *  clear the map. Consumed tokens are in-flight sends and settle on their
   *  own promise. */
  function clearTrackedTokens(): void {
    for (const ref of inlineRefs().values()) removeTrackedRef(ref);
    setInlineRefs(new Map());
  }

  /** Per-message consumption, step 1 (BEFORE sendMessage): emit the tokens'
   *  context-item IDS in textual order so the host reorders the context to
   *  match, then park the tokens as consumed (one count per ref identity).
   *  Returns the snapshot for {@link settleTokenConsumption}. */
  /** Tracked tokens in TEXTUAL order, matched like the highlight backdrop
   *  (earliest occurrence wins, longer token first on ties) — a naive
   *  indexOf rank would let a token that prefixes another ("@x:sel" inside
   *  "@x:sel-2") steal the longer one's position. Tokens not found in the
   *  text keep their map order at the end. */
  function tokensInTextualOrder(text: string, tracked: Map<string, TrackedRef>): string[] {
    const byLength = [...tracked.keys()].sort((a, b) => b.length - a.length);
    const seen: string[] = [];
    let pos = 0;
    while (pos < text.length && seen.length < byLength.length) {
      let nextIdx = -1;
      let nextToken = "";
      for (const token of byLength) {
        const idx = text.indexOf(token, pos);
        if (idx !== -1 && (nextIdx === -1 || idx < nextIdx)) {
          nextIdx = idx;
          nextToken = token;
        }
      }
      if (nextIdx === -1) break;
      if (!seen.includes(nextToken)) seen.push(nextToken);
      pos = nextIdx + nextToken.length;
    }
    for (const token of tracked.keys()) if (!seen.includes(token)) seen.push(token);
    return seen;
  }

  function beginTokenConsumption(text: string): Map<string, TrackedRef> {
    const tracked = inlineRefs();
    if (tracked.size === 0) return tracked;
    const byPosition: [string, TrackedRef][] = [];
    for (const token of tokensInTextualOrder(text, tracked)) {
      const ref = tracked.get(token);
      if (ref) byPosition.push([token, ref]);
    }
    const ids: string[] = [];
    for (const [, ref] of byPosition) {
      if (ref.kind === "item") {
        ids.push(ref.itemId);
        continue;
      }
      // A mention whose item hasn't landed yet (the host resolves content
      // ASYNC) has no id to rank by — it is skipped from the reorder list and
      // keeps its arrival position in the context array.
      const identity = mentionIdentity(ref.entry);
      const kind = mentionItemKind(ref.entry);
      const item = props.contextItems?.find((i) =>
        itemIdentity(i) === null
          ? i.kind === kind && i.label === ref.entry.label
          : itemIdentity(i) === identity,
      );
      if (item) ids.push(item.id);
    }
    props.onReorderContext?.(ids);
    setConsumedRefs((prev) => {
      const next = new Map(prev);
      for (const ref of tracked.values()) {
        const identity = refIdentity(ref);
        next.set(identity, (next.get(identity) ?? 0) + 1);
      }
      return next;
    });
    setInlineRefs(new Map());
    return tracked;
  }

  /** Per-message consumption, step 2: act only when the send SETTLES — the
   *  store resolves a steering send when its queued turn actually completes
   *  (or the queued slot dies), and the context preamble is read when the
   *  turn runs, so removing earlier would lose the content. Each ref
   *  releases one consumption count; its item is removed only when no other
   *  in-flight send or live composer token still references the identity. */
  function settleTokenConsumption(tracked: Map<string, TrackedRef>, sent: Promise<void>): void {
    if (tracked.size === 0) {
      void sent;
      return;
    }
    // Settle on BOTH outcomes — a rejected send must still release the
    // consumption counts or the items stay hidden for the panel's lifetime.
    const release = (): void => {
      const released: TrackedRef[] = [];
      const next = new Map(consumedRefs());
      for (const ref of tracked.values()) {
        const identity = refIdentity(ref);
        const count = next.get(identity) ?? 0;
        if (count <= 1) {
          next.delete(identity);
          released.push(ref);
        } else {
          next.set(identity, count - 1);
        }
      }
      setConsumedRefs(next);
      const live = new Set([...inlineRefs().values()].map(refIdentity));
      for (const ref of released) {
        if (!live.has(refIdentity(ref))) removeTrackedRef(ref);
      }
    };
    void sent.then(release, release);
  }

  /** Identities hidden from the chips bar: items represented by a live (or
   *  consumed-but-not-yet-settled) inline token. Items with the same label
   *  but a different identity (a twin in another root) — and any item the
   *  host attached without path/rootId — keep showing. */
  const hiddenChipIdentities = createMemo<Set<string>>(() => {
    const identities = new Set(consumedRefs().keys());
    for (const ref of inlineRefs().values()) identities.add(refIdentity(ref));
    return identities;
  });

  const visibleContextItems = createMemo<AiContextItem[]>(() =>
    (props.contextItems ?? []).filter((item) => {
      const hidden = hiddenChipIdentities();
      // An item ref hides its item by id directly — this is how tokened
      // selection chips disappear. Tokenless selections (rehydrated/legacy)
      // keep showing.
      if (hidden.has(`item\n${item.id}`)) return false;
      if (item.kind === "selection") return true;
      const identity = itemIdentity(item);
      return identity === null || !hidden.has(identity);
    }),
  );

  /** Insert "@token " for a host-requested item reference at the caret (or
   *  appended when the textarea isn't focused — an unfocused textarea's caret
   *  is stale), track it as an item ref, and focus with the caret after the
   *  token. The exact token already tracked for the SAME item just refocuses;
   *  a token-text collision with a DIFFERENT ref dedupes with "-2"/"-3". */
  function insertItemToken(itemId: string, rawToken: string): void {
    const ta = textarea;
    if (!ta) return;
    let token = `@${rawToken}`;
    for (let n = 2; ; n += 1) {
      const tracked = inlineRefs().get(token);
      if (!tracked) break;
      if (tracked.kind === "item" && tracked.itemId === itemId) {
        ta.focus();
        return;
      }
      token = `@${rawToken}-${n}`;
    }
    const text = input();
    const focused = document.activeElement === ta;
    const at = focused ? (ta.selectionStart ?? text.length) : text.length;
    // A separating space when the insertion point follows non-whitespace —
    // covers both a mid-text caret and appending to a non-empty draft.
    const charBefore = at > 0 ? text[at - 1] : undefined;
    const needsLeadingSpace = charBefore !== undefined && !/\s/.test(charBefore);
    const inserted = `${needsLeadingSpace ? " " : ""}${token} `;
    setInput(text.slice(0, at) + inserted + text.slice(at));
    // The rewrite bypasses the textarea's input event — an @-mention or slash
    // popover open over the pre-insertion text would keep capturing Enter
    // (same contract as submit()/startEditing()).
    setMentionQuery(null);
    setSlashQuery(null);
    setSkillQuery(null);
    setInlineRefs((prev) => new Map(prev).set(token, { itemId, kind: "item" }));
    const caret = at + inserted.length;
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(caret, caret);
    });
  }

  // Host-requested inline reference (a selection chip → composer token).
  // Keyed on `seq` so an identical re-request still fires. NOT deferred: the
  // host clears the signal through onInlineReferenceHandled once consumed,
  // so any non-null value — including one present at MOUNT (the chat tab was
  // closed when the user hit ⌘I and focusAiComposer just created it) — is a
  // pending request, never a stale replay.
  createEffect(
    on(
      () => props.inlineReference?.seq,
      (seq) => {
        const ref = props.inlineReference;
        if (!ref || seq === undefined) return;
        // A transient detached AiPanel instance (mounted, DOM removed, but its
        // effects still alive) would otherwise consume this reference first —
        // inserting the token into its orphaned textarea and acking it — so the
        // visible panel never gets it (the chip stays, the token never appears).
        // Only the instance actually in the document should handle it.
        if (!textarea || !textarea.isConnected) return;
        insertItemToken(ref.itemId, ref.token);
        props.onInlineReferenceHandled?.();
      },
    ),
  );

  /** The input split on tracked tokens (longest-first on ties) for the
   *  highlight backdrop — plain text nodes + pill spans, never innerHTML. */
  const highlightSegments = createMemo<{ text: string; token: boolean }[]>(() => {
    const text = input();
    const tokens = [...inlineRefs().keys()].sort((a, b) => b.length - a.length);
    if (tokens.length === 0) return [{ text, token: false }];
    const segments: { text: string; token: boolean }[] = [];
    let pos = 0;
    while (pos < text.length) {
      let nextIdx = -1;
      let nextToken = "";
      for (const token of tokens) {
        const idx = text.indexOf(token, pos);
        if (idx !== -1 && (nextIdx === -1 || idx < nextIdx)) {
          nextIdx = idx;
          nextToken = token;
        }
      }
      if (nextIdx === -1) {
        segments.push({ text: text.slice(pos), token: false });
        break;
      }
      if (nextIdx > pos) segments.push({ text: text.slice(pos, nextIdx), token: false });
      segments.push({ text: nextToken, token: true });
      pos = nextIdx + nextToken.length;
    }
    return segments;
  });

  // Workspace roots (path === "") are pinned: matched separately and NEVER
  // subject to the 8-entry cap, or files would fill the cap and make the
  // roots unreachable in any real workspace. An empty query matches all roots.
  const rootMatches = createMemo(() => {
    const q = mentionQuery();
    if (q === null || !props.mentionFiles?.length) return [];
    const ql = q.toLowerCase();
    return props.mentionFiles.filter((f) => f.path === "" && f.label.toLowerCase().includes(ql));
  });

  const fileMatches = createMemo(() => {
    const q = mentionQuery();
    if (q === null || !props.mentionFiles?.length) return [];
    const ql = q.toLowerCase();
    return props.mentionFiles
      .filter((f) => f.path !== "" && f.label.toLowerCase().includes(ql))
      .slice(0, 8);
  });

  // Roots first (pinned), then files — the keyboard index spans this combined
  // list in visual order.
  const mentionMatches = createMemo(() => [...rootMatches(), ...fileMatches()]);

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
      setSlashQuery(null);
      setSkillQuery(null);
    } else {
      setMentionQuery(null);
    }
  }

  // Selecting a mention replaces the typed "@query" with a literal inline
  // token ("@label ") that STAYS in the message text; the entry is tracked by
  // its exact token string and the host still resolves + attaches the context
  // item. A label collision (same file name elsewhere already tracked) falls
  // back to a path-qualified token so the two references stay distinguishable.
  function selectMention(file: AiMentionEntry): void {
    const ta = textarea;
    if (!ta) return;
    const caret = ta.selectionStart ?? input().length;
    let token = `@${file.label}`;
    const tracked = inlineRefs().get(token);
    if (tracked && !(tracked.kind === "mention" && isSameMentionEntry(tracked.entry, file))) {
      token = `@${file.rootLabel ? `${file.rootLabel}/` : ""}${file.path}`;
    }
    const before = input()
      .slice(0, caret)
      .replace(MENTION_RE, (_full, pre: string) => `${pre}${token} `);
    const next = before + input().slice(caret);
    setInput(next);
    setInlineRefs((prev) => new Map(prev).set(token, { entry: file, kind: "mention" }));
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
      // Shift+Enter keeps meaning "newline" even with the list open — only a
      // plain Enter (or Tab, shift or not) selects the highlighted command.
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        const match = slashMatches()[slashIndex()];
        if (match) selectSlashMatch(match);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        return;
      }
    }
    // While the "$" skill list is open, the arrows/Enter/Escape drive it.
    if (skillQuery() !== null && skillMatches().length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSkillIndex((i) => Math.min(i + 1, skillMatches().length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSkillIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        const skill = skillMatches()[skillIndex()];
        if (skill) selectSkill(skill);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSkillQuery(null);
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
      // Shift+Enter falls through to newline insertion, same as the slash list.
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
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
    !!props.activeFileContext || visibleContextItems().length > 0;

  const allModels = (): { value: string; label: string }[] =>
    (props.modelGroups ?? []).flatMap((g) => g.models);
  const hasModels = (): boolean => allModels().length > 0;
  const currentModelLabel = (): string => {
    const cur = allModels().find((mdl) => mdl.value === props.currentModel);
    // No real model resolved → a neutral "select…" placeholder (never the dev
    // provider name like "Mock (dev)").
    return cur?.label ?? (useLocale(), m.ai_model_select());
  };

  // Chat replies must never navigate the webview: a reply link is untrusted
  // model output, and an uncaught click would replace the whole app with the
  // link target. Delegated on the scroll viewport so it covers completed and
  // streaming messages alike; http(s) goes to the OS browser, document links
  // go through workspace navigation, and odd schemes stay inert.
  function onMessagesClick(e: MouseEvent): void {
    const link = (e.target as Element | null)?.closest?.("a[href]");
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      props.onOpenExternal?.(href);
      return;
    }
    if (/^file:\/\//i.test(href)) {
      const fileHref = href.replace(/^file:\/\/(?:localhost)?/i, "");
      if (!isSupportedChatDocumentHref(fileHref)) return;
      const target = normalizeChatDocumentHref(fileHref);
      if (target.path) props.onNavigateDocument?.(target.path, target.fragment);
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    if (!isSupportedChatDocumentHref(href)) return;

    const target = normalizeChatDocumentHref(href);
    if (!target.path) return;
    props.onNavigateDocument?.(target.path, target.fragment);
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
                displayText={props.displayText}
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
              content={displayed(props.store.streamingText())}
              displayText={props.displayText}
              role="assistant"
              streaming
              tools={props.store.toolActivity()}
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
            <For each={visibleContextItems()}>
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
                  class="ai-mention-item"
                  classList={{
                    "ai-mention-item-active": i() === mentionIndex(),
                    "ai-mention-root": file.path === "",
                  }}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectMention(file);
                  }}
                  onMouseEnter={() => setMentionIndex(i())}
                >
                  <Show when={file.kind === "dir"} fallback={<IconFileText width={12} height={12} />}>
                    <IconFolder width={12} height={12} />
                  </Show>
                  <span class="ai-mention-name">
                    {file.kind === "dir" && !file.label.endsWith("/") ? `${file.label}/` : file.label}
                  </span>
                  <Show
                    when={file.path === ""}
                    fallback={<span class="ai-mention-path">{file.path}</span>}
                  >
                    <span class="ai-mention-root-badge">
                      {(useLocale(), m.ai_mention_workspace())}
                    </span>
                  </Show>
                  <Show when={file.rootLabel}>
                    <span class="ai-mention-root-hint">{file.rootLabel}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={slashQuery() !== null && slashMatches().length > 0}>
          <div class="ai-mention-list ai-slash-list">
            <For each={slashMatches()}>
              {(match, i) => (
                <button
                  class="ai-mention-item ai-slash-item"
                  classList={{
                    "ai-mention-item-active": i() === slashIndex(),
                    "ai-slash-skill-item": match.kind === "skill",
                  }}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectSlashMatch(match);
                  }}
                  onMouseEnter={() => setSlashIndex(i())}
                >
                  <span class="ai-mention-name ai-slash-name">/{match.name}</span>
                  <Show when={match.description}>
                    <span class="ai-mention-path">{match.description}</span>
                  </Show>
                  <Show when={match.kind === "skill"}>
                    <span class="ai-mention-root-badge">skill</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={skillQuery() !== null && skillMatches().length > 0}>
          <div class="ai-mention-list ai-skill-list">
            <For each={skillMatches()}>
              {(skill, i) => (
                <button
                  class="ai-mention-item ai-skill-item"
                  classList={{ "ai-mention-item-active": i() === skillIndex() }}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectSkill(skill);
                  }}
                  onMouseEnter={() => setSkillIndex(i())}
                >
                  <span class="ai-mention-name ai-skill-name">${skillInvocationName(skill)}</span>
                  <Show when={skill.description}>
                    <span class="ai-mention-path">{skill.description}</span>
                  </Show>
                  <span class="ai-mention-root-badge">{skill.scope}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        {/* Highlight backdrop UNDER the textarea: same box + identical text
            metrics, so each tracked token's pill sits exactly behind the
            textarea's own glyphs (the textarea text renders above the pill —
            the backdrop's token text stays hidden behind it). */}
        {/* OpenCode-style: the bordered box holds ONLY the input + send; the
            mode/model/reasoning selects live on a dedicated bar below it. */}
        <div class="ai-composer-box">
          <div class="ai-composer-input-wrap">
            <div aria-hidden="true" class="ai-composer-highlight" ref={(el) => (highlightEl = el)}>
              <For each={highlightSegments()}>
                {(seg) =>
                  seg.token ? <span class="ai-inline-mention">{seg.text}</span> : seg.text
                }
              </For>
            </div>
            <textarea
              ref={(el) => (textarea = el)}
              class="ai-composer-input"
              rows={2}
              placeholder={(useLocale(), m.ai_composer_placeholder())}
              value={input()}
              onInput={(e) => {
                setInput(e.currentTarget.value);
                reconcileTokens(e.currentTarget.value);
                syncMention(e.currentTarget);
                syncSlash(e.currentTarget);
                syncSkill(e.currentTarget);
              }}
              onKeyDown={onKeyDown}
              onScroll={(e) => {
                if (highlightEl) highlightEl.scrollTop = e.currentTarget.scrollTop;
              }}
            />
          </div>
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
        <div class="ai-composer-bar">
          <Show when={props.onModeChange}>
            <PillPicker
              options={[
                { value: "build", label: (useLocale(), m.ai_mode_build()) },
                { value: "plan", label: (useLocale(), m.ai_mode_plan()) },
              ]}
              current={props.mode ?? "build"}
              currentLabel={props.mode === "plan" ? (useLocale(), m.ai_mode_plan()) : (useLocale(), m.ai_mode_build())}
              onSelect={(v) => props.onModeChange?.(v as AIChatMode)}
              ariaLabel={(useLocale(), m.ai_mode_label())}
              title={(useLocale(), props.mode === "plan" ? m.ai_mode_plan_hint() : m.ai_mode_build_hint())}
            />
          </Show>
          {/* Always the model-picker pill (even with no models yet) so the bar
              stays visually consistent — clicking it opens the popover whose ⚙
              leads to Settings → AI to connect a provider. With no model chosen
              it shows a "select…" placeholder (never the dev provider name). */}
          <ModelPicker
            groups={props.modelGroups ?? []}
            current={props.currentModel}
            currentLabel={currentModelLabel()}
            onSelect={(v) => props.onSelectModel?.(v)}
            onManage={props.onManageModels}
          />
          {/* Reasoning effort — per-model: shown only once a specific model is
              selected AND that model actually exposes effort levels. The level
              set comes from the model (e.g. Antigravity bakes the level into the
              name, so it offers none and the picker stays hidden). */}
          <Show
            when={
              props.onReasoningEffortChange &&
              !!props.currentModel &&
              (props.reasoningLevels?.length ?? 0) > 0
            }
          >
            <PillPicker
              options={(props.reasoningLevels ?? []).map((level) => ({ value: level, label: level }))}
              current={props.reasoningEffort ?? "default"}
              currentLabel={props.reasoningEffort ?? "default"}
              onSelect={(v) => props.onReasoningEffortChange?.(v)}
              ariaLabel={(useLocale(), m.settings_ai_reasoning_label())}
              title={(useLocale(), m.settings_ai_reasoning_label())}
              capitalize
            />
          </Show>
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
