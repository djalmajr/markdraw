import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import IconCheck from "~icons/lucide/check";
import IconCopy from "~icons/lucide/copy";
import IconFilePlus from "~icons/lucide/file-plus";
import IconFileSearch from "~icons/lucide/file-search";
import IconFileText from "~icons/lucide/file-text";
import IconFolderPlus from "~icons/lucide/folder-plus";
import IconList from "~icons/lucide/list";
import IconListChecks from "~icons/lucide/list-checks";
import IconPencil from "~icons/lucide/pencil";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import IconSearch from "~icons/lucide/search";
import IconTerminal from "~icons/lucide/terminal";
import type {
  ChatTurnContextItem,
  ToolActivity,
  TurnUsage,
} from "../composables/create-ai-chat-store.ts";
import type { PersistedAdvisorNote } from "@markdraw/core/ai-chat-sessions.ts";
import { renderChatMarkdown } from "../lib/chat-markdown.ts";

const AI_WAITING_STATUS_MAX_DELAY_MS = 15_000;
const AI_WAITING_STATUS_MIN_DELAY_MS = 5_000;
const AI_TYPEWRITER_INTERVAL_MS = 18;

export interface AiMessageProps {
  content: string;
  kind?: "normal" | "compaction";
  /** Display-only transform applied to expanded tool chip text (e.g. restore
   *  scrubbed secret placeholders). The host already transforms `content`. */
  displayText?: (text: string) => string;
  role: "user" | "assistant";
  /** True for the in-flight assistant turn — renders a streaming cursor. */
  streaming?: boolean;
  /** Tool activity to surface as compact chips with this turn. */
  tools?: ToolActivity[];
  /** Advisor/watchdog notes attached to this assistant turn. */
  advisorNotes?: PersistedAdvisorNote[];
  /** Context snapshot used by this user turn. Raw context stays out of
   *  history; these small labels make the effective prompt auditable. */
  context?: ChatTurnContextItem[];
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

function formatArtifactLabel(tool: ToolActivity): string {
  const artifact = tool.resultArtifact;
  if (!artifact) return "";
  return `${m.ai_artifact_saved()} ${artifact.id} (${artifact.byteLength} B)`;
}

function toolActivityKind(tool: ToolActivity): "create-file" | "create-folder" | "edit-file" | "read-file" | "read-doc" | "list-files" | "search" | "plan" | "generic" {
  const name = toolDisplayName(tool.toolName).toLowerCase();
  if (name.includes("create_file")) return "create-file";
  if (name.includes("create_folder")) return "create-folder";
  if (name.includes("edit_file") || name.includes("propose_edit")) return "edit-file";
  if (name.includes("read_active_doc")) return "read-doc";
  if (name.includes("read_file")) return "read-file";
  if (name.includes("list_files")) return "list-files";
  if (name.includes("search")) return "search";
  if (name.includes("update_plan")) return "plan";
  return "generic";
}

function toolActivityIcon(tool: ToolActivity): JSX.Element {
  switch (toolActivityKind(tool)) {
    case "create-file":
      return <IconFilePlus width={13} height={13} />;
    case "create-folder":
      return <IconFolderPlus width={13} height={13} />;
    case "edit-file":
      return <IconPencil width={13} height={13} />;
    case "read-file":
      return <IconFileSearch width={13} height={13} />;
    case "read-doc":
      return <IconFileText width={13} height={13} />;
    case "list-files":
      return <IconList width={13} height={13} />;
    case "search":
      return <IconSearch width={13} height={13} />;
    case "plan":
      return <IconListChecks width={13} height={13} />;
    case "generic":
      return <IconTerminal width={13} height={13} />;
  }
}

function randomWaitingStatusIndex(count: number, current?: number): number {
  if (count <= 1) return 0;
  const next = Math.floor(Math.random() * count);
  return next === current ? (next + 1) % count : next;
}

function localizedText(en: string, pt: string, es: string): string {
  const locale = useLocale();
  if (locale.startsWith("pt")) return pt;
  if (locale.startsWith("es")) return es;
  return en;
}

function toolTargetPath(tool: ToolActivity): string {
  const args = tool.args;
  if (typeof args !== "object" || args === null) return "";
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" ? path.trim() : "";
}

function toolTargetSuffix(tool: ToolActivity): string {
  const path = toolTargetPath(tool);
  return path ? ` ${path}` : "";
}

function toolActivityTargetLabel(tool: ToolActivity): string {
  const target = toolTargetPath(tool);
  if (target) return target;
  const name = toolDisplayName(tool.toolName);
  switch (toolActivityKind(tool)) {
    case "create-file":
    case "edit-file":
    case "read-file":
      return localizedText("File", "Arquivo", "Archivo");
    case "create-folder":
      return localizedText("Folder", "Pasta", "Carpeta");
    case "read-doc":
      return localizedText("Active document", "Documento ativo", "Documento activo");
    case "list-files":
      return localizedText("Files", "Arquivos", "Archivos");
    case "plan":
      return localizedText("Plan", "Plano", "Plan");
    default:
      return name;
  }
}

function toolActivityLabel(tool: ToolActivity): string {
  const name = toolDisplayName(tool.toolName);
  const target = toolTargetSuffix(tool);
  const running = tool.status === "running";
  const failed = tool.status === "error";
  const normalized = name.toLowerCase();
  if (normalized.includes("create_file")) {
    if (failed) {
      return localizedText(
        `Failed to create file${target}`,
        `Falha ao criar arquivo${target}`,
        `Error al crear archivo${target}`,
      );
    }
    return running
      ? localizedText(`Creating file${target}`, `Criando arquivo${target}`, `Creando archivo${target}`)
      : localizedText(`Created file${target}`, `Arquivo criado${target}`, `Archivo creado${target}`);
  }
  if (normalized.includes("create_folder")) {
    if (failed) {
      return localizedText(
        `Failed to create folder${target}`,
        `Falha ao criar pasta${target}`,
        `Error al crear carpeta${target}`,
      );
    }
    return running
      ? localizedText(`Creating folder${target}`, `Criando pasta${target}`, `Creando carpeta${target}`)
      : localizedText(`Created folder${target}`, `Pasta criada${target}`, `Carpeta creada${target}`);
  }
  if (normalized.includes("edit_file") || normalized.includes("propose_edit")) {
    if (failed) {
      return localizedText(
        `Failed to edit file${target}`,
        `Falha ao editar arquivo${target}`,
        `Error al editar archivo${target}`,
      );
    }
    return running
      ? localizedText(`Editing file${target}`, `Editando arquivo${target}`, `Editando archivo${target}`)
      : localizedText(`Edited file${target}`, `Arquivo editado${target}`, `Archivo editado${target}`);
  }
  if (normalized.includes("read_file")) {
    if (failed) {
      return localizedText(
        `Failed to read file${target}`,
        `Falha ao ler arquivo${target}`,
        `Error al leer archivo${target}`,
      );
    }
    return running
      ? localizedText(`Reading file${target}`, `Lendo arquivo${target}`, `Leyendo archivo${target}`)
      : localizedText(`Read file${target}`, `Arquivo lido${target}`, `Archivo leído${target}`);
  }
  if (normalized.includes("read_active_doc")) {
    if (failed) {
      return localizedText(
        "Failed to read active document",
        "Falha ao ler documento ativo",
        "Error al leer documento activo",
      );
    }
    return running
      ? localizedText("Reading active document", "Lendo documento ativo", "Leyendo documento activo")
      : localizedText("Read active document", "Documento ativo lido", "Documento activo leído");
  }
  if (normalized.includes("list_files")) {
    if (failed) {
      return localizedText("Failed to list files", "Falha ao listar arquivos", "Error al listar archivos");
    }
    return running
      ? localizedText("Listing files", "Listando arquivos", "Listando archivos")
      : localizedText("Listed files", "Arquivos listados", "Archivos listados");
  }
  if (normalized.includes("search")) {
    if (failed) {
      return localizedText(
        `Search failed: ${name}`,
        `Busca falhou: ${name}`,
        `Búsqueda fallida: ${name}`,
      );
    }
    return running
      ? localizedText(`Searching with ${name}`, `Buscando com ${name}`, `Buscando con ${name}`)
      : localizedText(`Searched with ${name}`, `Busca feita com ${name}`, `Búsqueda hecha con ${name}`);
  }
  if (normalized.includes("update_plan")) {
    if (failed) {
      return localizedText("Failed to update plan", "Falha ao atualizar plano", "Error al actualizar plan");
    }
    return running
      ? localizedText("Updating plan", "Atualizando plano", "Actualizando plan")
      : localizedText("Updated plan", "Plano atualizado", "Plan actualizado");
  }
  if (failed) return localizedText(`Tool failed: ${name}`, `Ferramenta falhou: ${name}`, `Herramienta falló: ${name}`);
  return running
    ? localizedText(`Running ${name}`, `Executando ${name}`, `Ejecutando ${name}`)
    : localizedText(`Ran ${name}`, `Executou ${name}`, `Ejecutó ${name}`);
}

function contextDisplayLabel(item: ChatTurnContextItem): string {
  if (item.path !== undefined && item.path !== "") return item.path;
  return item.label;
}

function contextTitle(item: ChatTurnContextItem): string {
  return [
    item.absolutePath ? `Absolute path: ${item.absolutePath}` : undefined,
    item.path !== undefined ? `Workspace path: ${item.path}` : undefined,
    item.rootPath ? `Workspace root: ${item.rootPath}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function AiWaitingIndicator(): JSX.Element {
  const statuses = (): string[] => {
    useLocale();
    return [
      m.ai_message_waiting_mapping_context(),
      m.ai_message_waiting_reading_workspace(),
      m.ai_message_waiting_checking_paths(),
      m.ai_message_waiting_weighing_edits(),
      m.ai_message_waiting_drafting_answer(),
      m.ai_message_waiting_verifying(),
    ];
  };
  const [statusIndex, setStatusIndex] = createSignal(randomWaitingStatusIndex(statuses().length));
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  function nextDelay(): number {
    return (
      AI_WAITING_STATUS_MIN_DELAY_MS +
      Math.floor(Math.random() * (AI_WAITING_STATUS_MAX_DELAY_MS - AI_WAITING_STATUS_MIN_DELAY_MS))
    );
  }

  function scheduleNextStatus(): void {
    statusTimer = setTimeout(() => {
      setStatusIndex((index) => randomWaitingStatusIndex(statuses().length, index));
      scheduleNextStatus();
    }, nextDelay());
  }

  scheduleNextStatus();
  onCleanup(() => clearTimeout(statusTimer));

  const status = (): string => {
    const values = statuses();
    return (values[statusIndex() % values.length] ?? "").replace(/[\s.\u2026]+$/u, "");
  };

  return (
    <span class="ai-message-waiting" aria-live="polite" role="status">
      <span class="ai-message-waiting-text">{status()}</span>
      <span class="ai-message-waiting-dots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </span>
  );
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
    const artifact = formatArtifactLabel(tool);
    const raw = result
      ? result
      : args
        ? `${toolDisplayName(tool.toolName)} ${args}`
        : toolDisplayName(tool.toolName);
    const text = artifact ? `${raw}\n\n${artifact}` : raw;
    return props.displayText?.(text) ?? text;
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
            title={toolActivityLabel(tool)}
            onClick={() =>
              setExpandedId((cur) => (cur === tool.toolCallId ? null : tool.toolCallId))
            }
          >
            <span class="ai-tool-chip-icon" aria-hidden="true">
              {toolActivityIcon(tool)}
            </span>
            <span class="ai-tool-chip-name">{toolActivityTargetLabel(tool)}</span>
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

function AdvisorNotes(props: { notes: PersistedAdvisorNote[] }): JSX.Element {
  return (
    <div class="ai-advisor-notes">
      <For each={props.notes}>
        {(note) => (
          <div
            class="ai-advisor-note"
            classList={{
              "ai-advisor-note-blocker": note.severity === "blocker",
              "ai-advisor-note-warning": note.severity === "warning",
            }}
          >
            <span class="ai-advisor-note-title">{note.title || (useLocale(), m.ai_advisor_title())}</span>
            <span class="ai-advisor-note-message">{note.message}</span>
          </div>
        )}
      </For>
    </div>
  );
}

/** A single chat bubble. Kept separate from AiPanel so it's the extension point
 *  for markdown rendering / citation chips in M2. */
export function AiMessage(props: AiMessageProps): JSX.Element {
  // Copy feedback: the button briefly swaps to a check + "Copied" after a
  // successful clipboard write, then reverts.
  const [copied, setCopied] = createSignal(false);
  const [visibleContent, setVisibleContent] = createSignal(props.streaming ? "" : props.content);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let typewriterTimer: ReturnType<typeof setInterval> | undefined;

  function stopTypewriter(): void {
    clearInterval(typewriterTimer);
    typewriterTimer = undefined;
  }

  function startTypewriter(): void {
    if (typewriterTimer) return;
    typewriterTimer = setInterval(() => {
      const target = props.content;
      const current = visibleContent();
      if (!props.streaming || !target.startsWith(current)) {
        setVisibleContent(target);
        stopTypewriter();
        return;
      }
      const lag = target.length - current.length;
      if (lag <= 0) {
        stopTypewriter();
        return;
      }
      const step = Math.min(14, Math.max(1, Math.ceil(lag / 18)));
      const next = target.slice(0, current.length + step);
      setVisibleContent(next);
      if (next.length >= target.length) stopTypewriter();
    }, AI_TYPEWRITER_INTERVAL_MS);
  }

  createEffect(() => {
    const target = props.content;
    if (!props.streaming) {
      stopTypewriter();
      setVisibleContent(target);
      return;
    }
    const current = visibleContent();
    if (!target.startsWith(current)) {
      stopTypewriter();
      setVisibleContent(target);
      return;
    }
    if (target.length > current.length) startTypewriter();
  });

  onCleanup(() => {
    clearTimeout(copiedTimer);
    stopTypewriter();
  });

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
  const hasContent = (): boolean => visibleContent().trim().length > 0;
  const contextItems = (): ChatTurnContextItem[] => props.context ?? [];

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
        "ai-message-compaction": props.kind === "compaction",
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
        <Show
          when={props.role === "assistant"}
          fallback={
            <>
              <div>{props.content}</div>
              <Show when={contextItems().length > 0}>
                <div
                  class="ai-message-context-used"
                  aria-label={localizedText("Used context", "Contexto usado", "Contexto usado")}
                >
                  <span class="ai-message-context-used-label">
                    {localizedText("Context", "Contexto", "Contexto")}
                  </span>
                  <For each={contextItems()}>
                    {(item) => (
                      <span class="ai-message-context-chip" title={contextTitle(item)}>
                        {contextDisplayLabel(item)}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
            </>
          }
        >
          <Show when={hasContent()}>
            {/* `html: false` in renderChatMarkdown escapes raw HTML, so this
                innerHTML never injects model/tool markup. */}
            <div class="ai-markdown" innerHTML={renderChatMarkdown(visibleContent())} />
          </Show>
          <Show when={props.streaming}>
            <AiWaitingIndicator />
          </Show>
        </Show>
      </div>
      <Show when={props.advisorNotes && props.advisorNotes.length > 0}>
        <AdvisorNotes notes={props.advisorNotes!} />
      </Show>
      {/* Hover action bar (revealed by CSS on .ai-message:hover). */}
      <div class="ai-msg-actions">
        <Show when={usageStats()}>
          {(stats) => (
            <span class="ai-msg-usage" title={stats().title}>
              {stats().text}
            </span>
          )}
        </Show>
        <Show when={!props.streaming}>
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
        </Show>
      </div>
    </div>
  );
}
