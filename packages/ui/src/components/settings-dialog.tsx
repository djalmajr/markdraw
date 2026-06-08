import {
  For,
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import IconX from "~icons/lucide/x";
import IconSparkles from "~icons/lucide/sparkles";
import IconPlug from "~icons/lucide/plug";
import IconLayers from "~icons/lucide/layers";
import IconPencil from "~icons/lucide/pencil";
import IconPalette from "~icons/lucide/palette";
import IconKeyboard from "~icons/lucide/keyboard";
import IconRotate from "~icons/lucide/rotate-ccw";
import IconShield from "~icons/lucide/shield";
import IconInfo from "~icons/lucide/info";
import * as m from "@asciimark/i18n";
import { useLocale } from "@asciimark/i18n/solid";
import {
  SHORTCUTS,
  groupShortcuts,
  type Platform,
} from "@asciimark/core/keyboard-shortcuts.ts";
import {
  effectiveKeys,
  formatBinding,
  getStoredKeybindings,
  resetStoredKeybinding,
  setStoredKeybinding,
} from "@asciimark/core/keybindings.ts";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import {
  Switch as ToggleSwitch,
  SwitchControl,
  SwitchThumb,
} from "./ui/switch.tsx";
import { TierCard } from "./settings/tier-card.tsx";

const messages = m as unknown as Record<string, () => string>;
const label = (key: string): string => messages[key]?.() ?? key;

export type SettingsSection =
  | "ai"
  | "mcp"
  | "indexing"
  | "editor"
  | "appearance"
  | "keybindings"
  | "privacy"
  | "about";

export type McpTransport = "stdio" | "http";

export interface SettingsMcpServer {
  id: string;
  name?: string;
  transport: McpTransport;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  command?: string;
  url?: string;
  error?: string;
}

export interface SaveMcpServerInput {
  id: string;
  name?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** HTTP transport only: custom headers (e.g. an Authorization token). */
  headers?: Record<string, string>;
  enabled: boolean;
}

export type IndexingTier = "off" | "lite" | "full";

export interface SettingsAiProvider {
  id: string;
  name: string;
  /** Known model ids for the provider (may be empty until loaded). */
  models: string[];
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
  /** AI provider catalog (built-ins + user config). */
  aiProviders: SettingsAiProvider[];
  /** Currently selected model id "provider/model", or null. */
  selectedModel: string | null;
  indexingTier: IndexingTier;
  onTierChange: (tier: IndexingTier) => void;
  /** Fetch the live model list for a provider using the given key. */
  onListModels: (providerId: string, apiKey: string) => Promise<string[]>;
  /** Persist key (keychain) + selected model (ai-prefs/ai.json). */
  onSaveProvider: (opts: {
    providerId: string;
    apiKey: string;
    modelId: string;
  }) => Promise<void> | void;
  appVersion?: string;
  platform?: Platform;
  /** Configured MCP servers with live connection/tool status. */
  mcpServers?: SettingsMcpServer[];
  /** Persist (add or update) an MCP server. */
  onSaveMcpServer?: (server: SaveMcpServerInput) => void | Promise<void>;
  /** Remove an MCP server by id. */
  onRemoveMcpServer?: (id: string) => void | Promise<void>;
  /** Enable/disable an MCP server. */
  onToggleMcpServer?: (id: string, enabled: boolean) => void | Promise<void>;
  /** Streaming-responses beta toggle (real incremental deltas). */
  aiStreaming?: boolean;
  onAiStreamingChange?: (enabled: boolean) => void;
}

const NAV: ReadonlyArray<{ id: SettingsSection; key: string; icon: () => JSX.Element }> = [
  { id: "ai", key: "settings_nav_ai", icon: () => <IconSparkles width={15} height={15} /> },
  { id: "mcp", key: "settings_nav_mcp", icon: () => <IconPlug width={15} height={15} /> },
  { id: "indexing", key: "settings_nav_indexing", icon: () => <IconLayers width={15} height={15} /> },
  { id: "editor", key: "settings_nav_editor", icon: () => <IconPencil width={15} height={15} /> },
  { id: "appearance", key: "settings_nav_appearance", icon: () => <IconPalette width={15} height={15} /> },
  { id: "keybindings", key: "settings_nav_keybindings", icon: () => <IconKeyboard width={15} height={15} /> },
  { id: "privacy", key: "settings_nav_privacy", icon: () => <IconShield width={15} height={15} /> },
  { id: "about", key: "settings_nav_about", icon: () => <IconInfo width={15} height={15} /> },
];

export function SettingsDialog(props: SettingsDialogProps): JSX.Element {
  const [section, setSection] = createSignal<SettingsSection>(
    props.initialSection ?? "ai",
  );

  return (
    <AlertDialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <AlertDialogContent class="flex h-[80vh] max-h-[640px] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <button
          type="button"
          aria-label={(useLocale(), label("ai_inline_reject"))}
          class="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={props.onClose}
        >
          <IconX width={16} height={16} />
        </button>
        <div class="border-b px-5 py-3">
          <AlertDialogTitle class="text-base font-semibold">
            {(useLocale(), label("settings_title"))}
          </AlertDialogTitle>
          <AlertDialogDescription class="sr-only">
            {(useLocale(), label("settings_title"))}
          </AlertDialogDescription>
        </div>
        <div class="flex min-h-0 flex-1">
          <nav class="settings-nav" role="tablist">
            <For each={NAV}>
              {(item) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={section() === item.id}
                  class="settings-nav-item"
                  classList={{ "settings-nav-item-active": section() === item.id }}
                  onClick={() => setSection(item.id)}
                >
                  {item.icon()}
                  <span>{(useLocale(), label(item.key))}</span>
                </button>
              )}
            </For>
          </nav>
          <div class="settings-content">
            <Switch>
              <Match when={section() === "ai"}>
                <AiSection {...props} />
              </Match>
              <Match when={section() === "mcp"}>
                <McpSection {...props} />
              </Match>
              <Match when={section() === "indexing"}>
                <IndexingSection {...props} />
              </Match>
              <Match when={section() === "keybindings"}>
                <KeybindingsSection platform={props.platform ?? "mac"} />
              </Match>
              <Match when={section() === "privacy"}>
                <p class="settings-prose">{(useLocale(), label("settings_privacy_body"))}</p>
              </Match>
              <Match when={section() === "about"}>
                <div class="settings-prose">
                  <p class="font-semibold">AsciiMark{props.appVersion ? ` v${props.appVersion}` : ""}</p>
                  <p>{(useLocale(), label("about_tagline"))}</p>
                </div>
              </Match>
              <Match when={section() === "editor"}>
                <p class="settings-prose">{(useLocale(), label("settings_placeholder"))}</p>
              </Match>
              <Match when={section() === "appearance"}>
                <p class="settings-prose">{(useLocale(), label("settings_placeholder"))}</p>
              </Match>
            </Switch>
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AiSection(props: SettingsDialogProps): JSX.Element {
  const initialProvider = props.selectedModel?.split("/")[0] ?? props.aiProviders[0]?.id ?? "";
  const initialModel = props.selectedModel?.split("/").slice(1).join("/") ?? "";
  const [providerId, setProviderId] = createSignal(initialProvider);
  const [apiKey, setApiKey] = createSignal("");
  const [models, setModels] = createSignal<string[]>(
    props.aiProviders.find((p) => p.id === initialProvider)?.models ?? [],
  );
  const [modelId, setModelId] = createSignal(initialModel);
  const [loading, setLoading] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  function selectProvider(id: string): void {
    setProviderId(id);
    setModels(props.aiProviders.find((p) => p.id === id)?.models ?? []);
    setModelId("");
    setSaved(false);
  }

  async function loadModels(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const list = await props.onListModels(providerId(), apiKey());
      setModels(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function save(): Promise<void> {
    setError(null);
    try {
      await props.onSaveProvider({
        providerId: providerId(),
        apiKey: apiKey(),
        modelId: modelId(),
      });
      setSaved(true);
      setApiKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div class="settings-section">
      <h3 class="settings-h3">{(useLocale(), label("settings_nav_ai"))}</h3>

      <label class="settings-label">{(useLocale(), label("settings_ai_provider"))}</label>
      <div class="settings-provider-list" role="radiogroup">
        <For each={props.aiProviders}>
          {(p) => (
            <button
              type="button"
              role="radio"
              aria-checked={providerId() === p.id}
              class="settings-provider"
              classList={{ "settings-provider-active": providerId() === p.id }}
              onClick={() => selectProvider(p.id)}
            >
              {p.name}
            </button>
          )}
        </For>
      </div>

      <label class="settings-label">{(useLocale(), label("settings_ai_api_key"))}</label>
      <div class="settings-row">
        <input
          type="password"
          class="ai-composer-input settings-input"
          autocomplete="off"
          placeholder="sk-…"
          value={apiKey()}
          onInput={(e) => setApiKey(e.currentTarget.value)}
        />
        <Button size="sm" variant="outline" onClick={() => void loadModels()} disabled={loading()}>
          {(useLocale(), label("settings_ai_load_models"))}
        </Button>
      </div>

      <label class="settings-label">{(useLocale(), label("settings_ai_model"))}</label>
      <Select<string>
        value={modelId() || null}
        onChange={(value) => setModelId(value ?? "")}
        options={models()}
        disabled={models().length === 0}
        placeholder={(useLocale(), label("settings_ai_no_models"))}
        itemComponent={(itemProps) => (
          <SelectItem item={itemProps.item}>{itemProps.item.rawValue}</SelectItem>
        )}
      >
        <SelectTrigger class="settings-input settings-select" aria-label={label("settings_ai_model")}>
          <SelectValue<string>>{(state) => state.selectedOption()}</SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>

      <Show when={error()}>
        <div class="ai-error">{error()}</div>
      </Show>

      <div class="settings-row settings-row-end">
        <Show when={saved()}>
          <span class="settings-saved">{(useLocale(), label("settings_ai_saved"))}</span>
        </Show>
        <Button size="sm" onClick={() => void save()} disabled={!providerId() || !modelId()}>
          {(useLocale(), label("settings_ai_save"))}
        </Button>
      </div>

      <div class="settings-row" style={{ "align-items": "center", gap: "10px", "margin-top": "12px" }}>
        <ToggleSwitch
          checked={props.aiStreaming ?? false}
          onChange={(checked) => props.onAiStreamingChange?.(checked)}
          aria-label={(useLocale(), label("settings_ai_streaming_label"))}
        >
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </ToggleSwitch>
        <div>
          <label class="settings-label" style={{ margin: "0" }}>
            {(useLocale(), label("settings_ai_streaming_label"))}
          </label>
          <p class="settings-prose" style={{ margin: "2px 0 0" }}>
            {(useLocale(), label("settings_ai_streaming_desc"))}
          </p>
        </div>
      </div>
    </div>
  );
}

function McpSection(props: SettingsDialogProps): JSX.Element {
  const [id, setId] = createSignal("");
  const [name, setName] = createSignal("");
  const [transport, setTransport] = createSignal<McpTransport>("stdio");
  const [command, setCommand] = createSignal("");
  const [args, setArgs] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [headers, setHeaders] = createSignal("");

  function resetForm(): void {
    setId("");
    setName("");
    setTransport("stdio");
    setCommand("");
    setArgs("");
    setUrl("");
    setHeaders("");
  }

  /** Parse the "Key: Value" (one per line) headers textarea into a record. */
  function parseHeaders(raw: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (key && value) out[key] = value;
    }
    return out;
  }

  function save(): void {
    const trimmedId = id().trim();
    if (!trimmedId) return;
    const trimmedName = name().trim();
    const t = transport();
    const argList = args()
      .split(/\s+/)
      .map((a) => a.trim())
      .filter(Boolean);
    const headerMap = t === "http" ? parseHeaders(headers()) : {};
    const server: SaveMcpServerInput = {
      id: trimmedId,
      enabled: true,
      transport: t,
      ...(trimmedName ? { name: trimmedName } : {}),
      ...(t === "stdio"
        ? {
            command: command().trim(),
            ...(argList.length ? { args: argList } : {}),
          }
        : {
            url: url().trim(),
            ...(Object.keys(headerMap).length ? { headers: headerMap } : {}),
          }),
    };
    void props.onSaveMcpServer?.(server);
    resetForm();
  }

  return (
    <div class="settings-section">
      <h3 class="settings-h3">{(useLocale(), label("settings_mcp_title"))}</h3>

      <Show
        when={(props.mcpServers ?? []).length > 0}
        fallback={
          <p class="settings-prose">{(useLocale(), label("settings_mcp_empty"))}</p>
        }
      >
        <div class="settings-mcp-list">
          <For each={props.mcpServers}>
            {(server) => (
              <div class="settings-mcp-row">
                <div class="settings-mcp-row-main">
                  <span class="settings-mcp-name">{server.name || server.id}</span>
                  <Badge variant="outline">{server.transport}</Badge>
                  <Show
                    when={!server.error}
                    fallback={<span class="ai-error">{server.error}</span>}
                  >
                    <Show when={server.connected}>
                      <span class="settings-mcp-status">
                        <span class="settings-mcp-dot" aria-hidden="true" />
                        {server.toolCount} {(useLocale(), label("settings_mcp_tools_count"))}
                      </span>
                    </Show>
                  </Show>
                </div>
                <div class="settings-mcp-row-actions">
                  <ToggleSwitch
                    checked={server.enabled}
                    onChange={(checked) =>
                      void props.onToggleMcpServer?.(server.id, checked)
                    }
                    aria-label={(useLocale(), label("settings_mcp_connected"))}
                  >
                    <SwitchControl>
                      <SwitchThumb />
                    </SwitchControl>
                  </ToggleSwitch>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void props.onRemoveMcpServer?.(server.id)}
                  >
                    {(useLocale(), label("settings_mcp_remove"))}
                  </Button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <h3 class="settings-h3">{(useLocale(), label("settings_mcp_add"))}</h3>

      <label class="settings-label">{(useLocale(), label("settings_mcp_id"))}</label>
      <input
        class="ai-composer-input settings-input"
        autocomplete="off"
        value={id()}
        onInput={(e) => setId(e.currentTarget.value)}
      />

      <label class="settings-label">{(useLocale(), label("settings_mcp_name"))}</label>
      <input
        class="ai-composer-input settings-input"
        autocomplete="off"
        value={name()}
        onInput={(e) => setName(e.currentTarget.value)}
      />

      <label class="settings-label">{(useLocale(), label("settings_mcp_transport"))}</label>
      <Select<McpTransport>
        value={transport()}
        onChange={(value) => value && setTransport(value)}
        options={["stdio", "http"]}
        itemComponent={(itemProps) => (
          <SelectItem item={itemProps.item}>{itemProps.item.rawValue}</SelectItem>
        )}
      >
        <SelectTrigger
          class="settings-input settings-select"
          aria-label={label("settings_mcp_transport")}
        >
          <SelectValue<McpTransport>>{(state) => state.selectedOption()}</SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>

      <Show when={transport() === "stdio"}>
        <label class="settings-label">{(useLocale(), label("settings_mcp_command"))}</label>
        <input
          class="ai-composer-input settings-input"
          autocomplete="off"
          value={command()}
          onInput={(e) => setCommand(e.currentTarget.value)}
        />
        <label class="settings-label">{(useLocale(), label("settings_mcp_args"))}</label>
        <input
          class="ai-composer-input settings-input"
          autocomplete="off"
          value={args()}
          onInput={(e) => setArgs(e.currentTarget.value)}
        />
      </Show>

      <Show when={transport() === "http"}>
        <label class="settings-label">{(useLocale(), label("settings_mcp_url"))}</label>
        <input
          class="ai-composer-input settings-input"
          autocomplete="off"
          placeholder="https://…"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
        <label class="settings-label">{(useLocale(), label("settings_mcp_headers"))}</label>
        <textarea
          class="ai-composer-input settings-input"
          rows={2}
          autocomplete="off"
          placeholder="Authorization: Bearer …"
          value={headers()}
          onInput={(e) => setHeaders(e.currentTarget.value)}
        />
      </Show>

      <div class="settings-row settings-row-end">
        <Button size="sm" onClick={save} disabled={!id().trim()}>
          {(useLocale(), label("settings_mcp_add"))}
        </Button>
      </div>
    </div>
  );
}

function IndexingSection(props: SettingsDialogProps): JSX.Element {
  return (
    <div class="settings-section">
      <h3 class="settings-h3">{(useLocale(), label("settings_indexing_title"))}</h3>
      <div class="settings-tiers" role="radiogroup">
        <TierCard
          title={(useLocale(), label("settings_indexing_off_title"))}
          description={(useLocale(), label("settings_indexing_off_desc"))}
          selected={props.indexingTier === "off"}
          onSelect={() => props.onTierChange("off")}
        />
        <TierCard
          title={(useLocale(), label("settings_indexing_lite_title"))}
          description={(useLocale(), label("settings_indexing_lite_desc"))}
          badge={(useLocale(), label("settings_indexing_default_badge"))}
          selected={props.indexingTier === "lite"}
          onSelect={() => props.onTierChange("lite")}
        />
        <TierCard
          title={(useLocale(), label("settings_indexing_full_title"))}
          description={(useLocale(), label("settings_indexing_full_desc"))}
          selected={props.indexingTier === "full"}
          onSelect={() => props.onTierChange("full")}
        />
      </div>
    </div>
  );
}

// Shortcuts handled outside the webview keydown dispatcher (OS menu accelerator
// / editor keymap) — shown read-only would mislead, so we omit them here.
const NON_REMAPPABLE = new Set(["file.openFolder", "file.save"]);

/** Build display key-tokens for both platforms from a recorded keydown. */
function eventToKeys(e: KeyboardEvent): { mac: string[]; other: string[] } | null {
  const mac: string[] = [];
  const other: string[] = [];
  if (e.metaKey) {
    mac.push("⌘");
    other.push("Ctrl");
  }
  if (e.ctrlKey && !e.metaKey) {
    mac.push("⌃");
    other.push("Ctrl");
  }
  if (e.altKey) {
    mac.push("⌥");
    other.push("Alt");
  }
  if (e.shiftKey) {
    mac.push("⇧");
    other.push("Shift");
  }
  const key = keyToken(e);
  if (!key) return null;
  mac.push(key);
  other.push(key);
  return { mac, other };
}

function keyToken(e: KeyboardEvent): string {
  const code = e.code;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const punct: Record<string, string> = {
    Slash: "/",
    Backslash: "\\",
    Comma: ",",
    Period: ".",
    Semicolon: ";",
    Minus: "-",
    Equal: "=",
    Tab: "Tab",
    Enter: "Enter",
    Space: "Space",
  };
  if (punct[code]) return punct[code];
  if (e.key === "Meta" || e.key === "Control" || e.key === "Shift" || e.key === "Alt") return "";
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

function KeybindingsSection(props: { platform: Platform }): JSX.Element {
  const [version, setVersion] = createSignal(0);
  const [recordingId, setRecordingId] = createSignal<string | null>(null);
  const grouped = groupShortcuts(SHORTCUTS.filter((s) => !NON_REMAPPABLE.has(s.id)));

  function startRecording(id: string): void {
    setRecordingId(id);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        stop();
        return;
      }
      if (e.key === "Meta" || e.key === "Control" || e.key === "Shift" || e.key === "Alt") return;
      const keys = eventToKeys(e);
      if (keys) {
        setStoredKeybinding(id, keys);
        setVersion((v) => v + 1);
      }
      stop();
    };
    function stop(): void {
      window.removeEventListener("keydown", onKey, true);
      setRecordingId(null);
    }
    // Capture phase + stopImmediatePropagation so the global shortcut dispatcher
    // doesn't also fire while the user is recording a chord.
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  }

  const isOverridden = (id: string): boolean => (version(), !!getStoredKeybindings()[id]);

  return (
    <div class="settings-section">
      <h3 class="settings-h3">{(useLocale(), label("settings_nav_keybindings"))}</h3>
      <p class="settings-hint">{(useLocale(), m.settings_kb_hint())}</p>
      <For each={[...grouped.entries()]}>
        {([group, items]) => (
          <div class="settings-kb-group">
            <div class="settings-kb-group-title">{group}</div>
            <For each={items}>
              {(s) => (
                <div class="settings-kb-row">
                  <span class="settings-kb-desc">{label(s.descriptionKey)}</span>
                  <Show when={isOverridden(s.id)}>
                    <button
                      type="button"
                      class="settings-kb-reset"
                      onClick={() => {
                        resetStoredKeybinding(s.id);
                        setVersion((v) => v + 1);
                      }}
                      title={(useLocale(), m.settings_kb_reset())}
                      aria-label={(useLocale(), m.settings_kb_reset())}
                    >
                      <IconRotate width={13} height={13} />
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="settings-kb-keys"
                    classList={{ "settings-kb-recording": recordingId() === s.id }}
                    onClick={() => startRecording(s.id)}
                    title={(useLocale(), m.settings_kb_change())}
                  >
                    <Show
                      when={recordingId() === s.id}
                      fallback={(version(), formatBinding(effectiveKeys(s.id, props.platform), props.platform)) || "—"}
                    >
                      {(useLocale(), m.settings_kb_recording())}
                    </Show>
                  </button>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
