import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import IconX from "~icons/lucide/x";
import IconSearch from "~icons/lucide/search";
import IconTrash from "~icons/lucide/trash-2";
import IconArrowLeft from "~icons/lucide/arrow-left";
import IconChevronRight from "~icons/lucide/chevron-right";
import IconPlus from "~icons/lucide/plus";
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
  detectPlatform,
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
import { ModelPicker } from "./model-picker.tsx";
import { confirm } from "./confirm-dialog.tsx";

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
  args?: string[];
  command?: string;
  connected: boolean;
  enabled: boolean;
  error?: string;
  id: string;
  name?: string;
  toolCount: number;
  tools?: string[];
  transport: McpTransport;
  url?: string;
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

export type SettingsAiConnectMode = "api-key" | "cli-subscription";

export interface SettingsAiProvider {
  id: string;
  name: string;
  /** Known model ids for the provider (may be empty until loaded). */
  models: string[];
  kind?: string;
  /** CLI subscription providers probe the local binary instead of an API key. */
  connectMode?: SettingsAiConnectMode;
  /** Connect-catalog grouping: providers sharing this render as one card (e.g.
   *  the Anthropic API + Claude subscription, both "Claude"). */
  connectGroup?: string;
  /** The live model list can be re-fetched (openai-compatible + baseURL). */
  fetchable?: boolean;
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
  /** AI provider catalog (built-ins + user config). */
  aiProviders: SettingsAiProvider[];
  /** Currently selected model id "provider/model", or null. */
  selectedModel: string | null;
  /** All configured models grouped by provider — drives "Manage models". */
  allModels?: Array<{ id: string; name: string; models: Array<{ value: string; label: string }> }>;
  /** Model refs currently hidden from the chat picker. */
  hiddenModels?: string[];
  /** Toggle a model's visibility in the chat picker. */
  onToggleModel?: (ref: string) => void;
  indexingTier: IndexingTier;
  onTierChange: (tier: IndexingTier) => void;
  /** Embedding-capable providers/models for the Complete-tier picker. */
  embeddingModelGroups?: Array<{ id: string; name: string; models: Array<{ value: string; label: string }> }>;
  embeddingSelectedModel?: string | null;
  onSelectEmbeddingModel?: (ref: string) => void;
  /** Whether the Complete tier can be enabled (≥1 embedding provider connected). */
  embeddingCapable?: boolean;
  /** Fetch the live model list for a provider using the given key. */
  onListModels: (providerId: string, apiKey: string) => Promise<string[]>;
  /** Persist key (keychain) + selected model (ai-prefs/ai.json). */
  onSaveProvider: (opts: {
    providerId: string;
    apiKey: string;
    modelId: string;
  }) => Promise<void> | void;
  /** Add a custom OpenAI-compatible provider (id/name/baseURL/key/models). */
  onSaveCustomProvider?: (input: {
    id: string;
    name: string;
    baseURL: string;
    apiKey: string;
    models: Array<{ id: string; name: string }>;
  }) => Promise<void> | void;
  /** Connect a built-in provider (store key + register its models). */
  onConnectProvider?: (input: { providerId: string; apiKey: string }) => Promise<void> | void;
  /** Disconnect a provider group — receives EVERY provider id behind the merged
   *  base name (e.g. "OpenCode Go" → ["opencode-go", "opencode-go-chat"]). */
  onRemoveProvider?: (ids: string[]) => void | Promise<void>;
  /** Re-fetch a provider's live model list. */
  onRefreshModels?: (providerId: string) => void | Promise<void>;
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
  /** Reasoning effort forwarded to the engine ("off" | "low" | "medium" | "high"). */
  aiReasoning?: string;
  onAiReasoningChange?: (value: string) => void;
  /** Streaming-responses beta toggle (real incremental deltas). */
  aiStreaming?: boolean;
  onAiStreamingChange?: (enabled: boolean) => void;
  /** Current theme ("system" | "light" | "dark") + change handler — drives the
   *  Appearance section's theme picker (moved here from the toolbar menu). */
  themeMode?: string;
  onThemeChange?: (mode: string) => void;
  /** Open the release-notes dialog from Settings → About. */
  onShowReleaseNotes?: () => void;
}

const THEME_MODES = ["system", "light", "dark"] as const;

/** Rendered raw (same style as the MCP transport Select) — not translated. */
const REASONING_EFFORTS = ["off", "low", "medium", "high"] as const;

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
                {/* Same detected-platform fallback as ShortcutsHelp/CommandPalette —
                    a hardcoded "mac" default rendered ⌘ glyphs on Windows. */}
                <KeybindingsSection
                  platform={
                    props.platform ??
                    detectPlatform(typeof navigator === "undefined" ? "" : navigator.platform)
                  }
                />
              </Match>
              <Match when={section() === "privacy"}>
                <p class="settings-prose">{(useLocale(), label("settings_privacy_body"))}</p>
              </Match>
              <Match when={section() === "about"}>
                <div class="settings-prose">
                  <p class="font-semibold">AsciiMark{props.appVersion ? ` v${props.appVersion}` : ""}</p>
                  <p>{(useLocale(), label("about_tagline"))}</p>
                  <Show when={props.onShowReleaseNotes}>
                    <Button
                      variant="outline"
                      size="sm"
                      style={{ "margin-top": "12px" }}
                      onClick={() => props.onShowReleaseNotes?.()}
                    >
                      {(useLocale(), label("menu_release_notes"))}
                    </Button>
                  </Show>
                </div>
              </Match>
              <Match when={section() === "editor"}>
                <p class="settings-prose">{(useLocale(), label("settings_placeholder"))}</p>
              </Match>
              <Match when={section() === "appearance"}>
                <h3 class="settings-h3">{(useLocale(), label("settings_nav_appearance"))}</h3>
                <div class="settings-row" style={{ "align-items": "center", "justify-content": "space-between", gap: "10px" }}>
                  <label class="settings-label" style={{ margin: "0" }}>
                    {(useLocale(), label("menu_theme"))}
                  </label>
                  <Select<string>
                    value={props.themeMode ?? "system"}
                    onChange={(value) => value && props.onThemeChange?.(value)}
                    options={[...THEME_MODES]}
                    itemComponent={(itemProps) => (
                      <SelectItem item={itemProps.item}>
                        {(useLocale(), label(`menu_theme_${itemProps.item.rawValue}`))}
                      </SelectItem>
                    )}
                  >
                    <SelectTrigger class="w-40">
                      <SelectValue<string>>
                        {(state) => (useLocale(), label(`menu_theme_${state.selectedOption()}`))}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
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
  // Which async action is in flight, so its spinner shows on ONLY the clicked
  // button (the API "Continue" and CLI "Use subscription" share this sub-page).
  const [loadingAction, setLoadingAction] = createSignal<"api" | "cli" | "models" | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [modelQuery, setModelQuery] = createSignal("");

  // ── Manage models (OpenCode pattern: search + provider header w/ a group
  //    toggle + per-model toggles) ────────────────────────────────────────────
  const hiddenSet = createMemo(() => new Set(props.hiddenModels ?? []));
  const filteredGroups = createMemo(() => {
    const q = modelQuery().trim().toLowerCase();
    const groups = q
      ? (props.allModels ?? []).map((g) => ({
          ...g,
          models: g.models.filter(
            (mdl) => mdl.label.toLowerCase().includes(q) || g.name.toLowerCase().includes(q),
          ),
        }))
      : (props.allModels ?? []);
    return groups.filter((g) => g.models.length > 0);
  });
  /** Whether every model of a provider is currently visible (drives the group toggle). */
  const providerAllVisible = (group: { models: { value: string }[] }): boolean =>
    group.models.every((mdl) => !hiddenSet().has(mdl.value));
  /** Provider ids behind a merged group. Groups arrive keyed by base name (the
   *  app merges e.g. "OpenCode Go" + "OpenCode Go (chat)") so the id set is
   *  recovered from each model ref's "provider/model" prefix — the provider
   *  sub-page's remove action must disconnect every backing id, mirroring how
   *  connect set them. */
  const groupProviderIds = (group: { models: { value: string }[] }): string[] => [
    ...new Set(group.models.map((mdl) => mdl.value.slice(0, mdl.value.indexOf("/")))),
  ];
  /** Flip a whole provider: if all visible → hide all, else → show all. */
  function toggleProvider(group: { models: { value: string }[] }): void {
    const hidden = hiddenSet();
    const allVisible = group.models.every((mdl) => !hidden.has(mdl.value));
    for (const mdl of group.models) {
      const isHidden = hidden.has(mdl.value);
      if (allVisible ? !isHidden : isHidden) props.onToggleModel?.(mdl.value);
    }
  }

  // ── Custom provider form (OpenAI-compatible) ────────────────────────────────
  const [cpId, setCpId] = createSignal("");
  const [cpName, setCpName] = createSignal("");
  const [cpBaseURL, setCpBaseURL] = createSignal("");
  const [cpKey, setCpKey] = createSignal("");
  const [cpModels, setCpModels] = createSignal<{ id: string; name: string }[]>([{ id: "", name: "" }]);
  const [cpError, setCpError] = createSignal<string | null>(null);

  function setCpModel(i: number, field: "id" | "name", value: string): void {
    setCpModels((ms) => ms.map((mdl, idx) => (idx === i ? { ...mdl, [field]: value } : mdl)));
  }
  function resetCustom(): void {
    setCpId("");
    setCpName("");
    setCpBaseURL("");
    setCpKey("");
    setCpModels([{ id: "", name: "" }]);
    setCpError(null);
  }
  async function submitCustom(): Promise<void> {
    setCpError(null);
    if (!cpId().trim() || !cpBaseURL().trim()) {
      setCpError(label("settings_ai_custom_required"));
      return;
    }
    try {
      await props.onSaveCustomProvider?.({
        id: cpId().trim(),
        name: cpName(),
        baseURL: cpBaseURL(),
        apiKey: cpKey(),
        models: cpModels().filter((mdl) => mdl.id.trim()),
      });
      resetCustom();
      setView({ kind: "manage" });
    } catch (e) {
      setCpError(e instanceof Error ? e.message : String(e));
    }
  }

  // ── View router: the main "manage" list, the provider "catalog", a
  //    per-provider connect sub-page, or the custom-provider form. ─────────────
  type AiView =
    | { kind: "manage" }
    | { kind: "catalog" }
    | { kind: "custom" }
    | { kind: "provider"; from: "catalog" | "manage"; ids: string[]; name: string };
  const [view, setView] = createSignal<AiView>({ kind: "manage" });
  const providerViewData = (): { from: "catalog" | "manage"; ids: string[]; name: string } | null => {
    const v = view();
    return v.kind === "provider" ? v : null;
  };

  /** Provider ids with at least one model in the (connected-only) Manage list —
   *  the dialog's notion of "connected", gating the destructive remove action. */
  const connectedProviderIds = createMemo<Set<string>>(() => {
    const ids = new Set<string>();
    for (const group of props.allModels ?? []) {
      for (const mdl of group.models) ids.add(mdl.value.slice(0, mdl.value.indexOf("/")));
    }
    return ids;
  });

  /** Providers for the Connect catalog, MERGED by base name (e.g. "OpenCode Go"
   *  + "OpenCode Go (chat)" → one row connecting both ids) and sorted
   *  alphabetically. Custom is rendered first, separately. */
  const catalogProviders = createMemo<{ name: string; ids: string[] }[]>(() => {
    const byBase = new Map<string, { name: string; ids: string[] }>();
    for (const p of props.aiProviders) {
      // Explicit connectGroup wins (e.g. "Claude" = Anthropic API + Claude
      // subscription); otherwise fall back to the name minus a "(chat)"-style
      // parenthetical so e.g. OpenCode Go's two entries still merge.
      const base = p.connectGroup ?? (p.name.replace(/\s*\([^)]*\)\s*$/, "").trim() || p.name);
      const existing = byBase.get(base);
      if (existing) existing.ids.push(p.id);
      else byBase.set(base, { name: base, ids: [p.id] });
    }
    return [...byBase.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  function enterProvider(
    group: { name: string; ids: string[] },
    from: "catalog" | "manage" = "catalog",
  ): void {
    setApiKey("");
    setError(null);
    setView({ kind: "provider", from, ids: group.ids, name: group.name });
  }
  async function connectIds(ids: string[], kind: "api" | "cli"): Promise<void> {
    if (ids.length === 0) return;
    setError(null);
    setLoadingAction(kind);
    try {
      // A mode may span several entries (e.g. OpenCode Go's two kinds); connect each.
      for (const id of ids) await props.onConnectProvider?.({ providerId: id, apiKey: apiKey() });
      setApiKey("");
      setView({ kind: "manage" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAction(null);
    }
  }
  /** Split the current connect group's ids by mode, so a group with both (the
   *  "Claude" card = Anthropic API + Claude subscription) shows both options. */
  const groupApiIds = (): string[] =>
    (providerViewData()?.ids ?? []).filter(
      (id) => (props.aiProviders.find((p) => p.id === id)?.connectMode ?? "api-key") !== "cli-subscription",
    );
  const groupCliIds = (): string[] =>
    (providerViewData()?.ids ?? []).filter(
      (id) => props.aiProviders.find((p) => p.id === id)?.connectMode === "cli-subscription",
    );
  /** Fetchable + connected ids in the group → eligible for "Refresh models". */
  const groupRefreshableIds = (): string[] =>
    groupApiIds().filter(
      (id) =>
        props.aiProviders.find((p) => p.id === id)?.fetchable && connectedProviderIds().has(id),
    );
  const [refreshing, setRefreshing] = createSignal(false);
  async function refreshGroupModels(): Promise<void> {
    const ids = groupRefreshableIds();
    if (ids.length === 0) return;
    setError(null);
    setRefreshing(true);
    try {
      for (const id of ids) await props.onRefreshModels?.(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }
  /** Subscription description keyed to THIS card's CLI (so the Codex card never
   *  mentions Claude Code, and vice versa). */
  const groupCliDescKey = (): string => {
    const kind = groupCliIds()
      .map((id) => props.aiProviders.find((p) => p.id === id)?.kind)
      .find(Boolean);
    if (kind === "codex-cli") return "settings_ai_connect_cli_desc_codex";
    if (kind === "grok-cli") return "settings_ai_connect_cli_desc_grok";
    return "settings_ai_connect_cli_desc_claude";
  };
  /** Destructive action on the provider sub-page: confirm, then disconnect
   *  every backing id and return to Manage models. Errors render in the same
   *  inline slot the connect flow uses. */
  async function removeCurrentProvider(): Promise<void> {
    const v = view();
    if (v.kind !== "provider") return;
    const ok = await confirm({
      title: label("settings_ai_disconnect"),
      description: label("settings_ai_disconnect_confirm"),
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await props.onRemoveProvider?.(v.ids);
      setView({ kind: "manage" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function selectProvider(id: string): void {
    setProviderId(id);
    setModels(props.aiProviders.find((p) => p.id === id)?.models ?? []);
    setModelId("");
    setSaved(false);
  }

  async function loadModels(): Promise<void> {
    setLoadingAction("models");
    setError(null);
    try {
      const list = await props.onListModels(providerId(), apiKey());
      setModels(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAction(null);
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
      <Switch>
        {/* ── Connect provider: catalog of providers + Custom ── */}
        <Match when={view().kind === "catalog"}>
          <div class="settings-subpage-header">
            <button
              type="button"
              class="settings-back"
              aria-label={(useLocale(), label("settings_ai_back"))}
              onClick={() => setView({ kind: "manage" })}
            >
              <IconArrowLeft width={16} height={16} />
            </button>
            <h3 class="settings-h3" style={{ margin: "0" }}>{(useLocale(), label("ai_connect_provider"))}</h3>
          </div>
          <div class="settings-catalog">
            <Show when={props.onSaveCustomProvider}>
              <button type="button" class="settings-catalog-row" onClick={() => setView({ kind: "custom" })}>
                <span class="settings-catalog-name">{(useLocale(), label("settings_ai_custom_provider"))}</span>
                <IconChevronRight width={16} height={16} class="settings-catalog-chevron" />
              </button>
            </Show>
            <For each={catalogProviders()}>
              {(group) => (
                <button type="button" class="settings-catalog-row" onClick={() => enterProvider(group)}>
                  <span class="settings-catalog-name">{group.name}</span>
                  <IconChevronRight width={16} height={16} class="settings-catalog-chevron" />
                </button>
              )}
            </For>
          </div>
        </Match>

        {/* ── Per-provider connect: API key or CLI subscription ── */}
        <Match when={view().kind === "provider"}>
          <div class="settings-subpage-header">
            <button
              type="button"
              class="settings-back"
              aria-label={(useLocale(), label("settings_ai_back"))}
              onClick={() => setView({ kind: providerViewData()?.from ?? "catalog" })}
            >
              <IconArrowLeft width={16} height={16} />
            </button>
            <h3 class="settings-h3" style={{ margin: "0" }}>
              {(useLocale(), label("settings_ai_connect"))} {providerViewData()?.name}
            </h3>
          </div>
          {/* API key — for any api-key provider in this group (e.g. Anthropic). */}
          <Show when={groupApiIds().length > 0}>
            <p class="settings-prose">{(useLocale(), label("settings_ai_connect_desc"))}</p>
            <label class="settings-label">{(useLocale(), label("settings_ai_api_key"))}</label>
            <input
              type="password"
              autocomplete="off"
              class="settings-input ai-composer-input"
              placeholder="sk-…"
              value={apiKey()}
              onInput={(e) => setApiKey(e.currentTarget.value)}
            />
            <div class="settings-row settings-row-end">
              <Button
                size="sm"
                onClick={() => void connectIds(groupApiIds(), "api")}
                loading={loadingAction() === "api"}
                disabled={!apiKey().trim() || loadingAction() !== null}
              >
                {(useLocale(), label("settings_ai_connect_continue"))}
              </Button>
            </div>
            <Show when={groupRefreshableIds().length > 0}>
              <div class="settings-row settings-row-end">
                <Button size="sm" onClick={() => void refreshGroupModels()} loading={refreshing()}>
                  {(useLocale(), label("settings_ai_refresh_models"))}
                </Button>
              </div>
            </Show>
          </Show>
          {/* Subscription — for any cli-subscription provider, below the API
              option so both can coexist (the "Claude" card offers each). */}
          <Show when={groupCliIds().length > 0}>
            <div
              style={
                groupApiIds().length > 0
                  ? { "border-top": "1px solid hsl(var(--border))", "margin-top": "16px", "padding-top": "12px" }
                  : {}
              }
            >
              <p class="settings-prose">{(useLocale(), label(groupCliDescKey()))}</p>
              <div class="settings-row settings-row-end">
                <Button
                  size="sm"
                  onClick={() => void connectIds(groupCliIds(), "cli")}
                  loading={loadingAction() === "cli"}
                  disabled={loadingAction() !== null}
                >
                  {(useLocale(), label("settings_ai_use_subscription"))}
                </Button>
              </div>
            </div>
          </Show>
          <Show when={error()}>
            <div class="ai-error">{error()}</div>
          </Show>
          <Show
            when={
              props.onRemoveProvider &&
              providerViewData()?.ids.some((id) => connectedProviderIds().has(id))
            }
          >
            {/* Destructive zone, clearly separated from the connect controls —
                only for CONNECTED providers (there's no key to delete before
                connecting, and the confirm copy promises a keychain removal). */}
            <div
              class="settings-row"
              style={{ "border-top": "1px solid hsl(var(--border))", "margin-top": "16px", "padding-top": "12px" }}
            >
              <button
                class="settings-danger-btn"
                type="button"
                onClick={() => void removeCurrentProvider()}
              >
                {(useLocale(), label("settings_ai_disconnect"))}
              </button>
            </div>
          </Show>
        </Match>

        {/* ── Custom provider form ── */}
        <Match when={view().kind === "custom"}>
          <div class="settings-subpage-header">
            <button
              type="button"
              class="settings-back"
              aria-label={(useLocale(), label("settings_ai_back"))}
              onClick={() => setView({ kind: "catalog" })}
            >
              <IconArrowLeft width={16} height={16} />
            </button>
            <h3 class="settings-h3" style={{ margin: "0" }}>{(useLocale(), label("settings_ai_custom_provider"))}</h3>
          </div>
          <p class="settings-prose">{(useLocale(), label("settings_ai_custom_desc"))}</p>
          <div class="settings-custom">
            <label class="settings-label">{(useLocale(), label("settings_ai_custom_id"))}</label>
            <input class="settings-input ai-composer-input" placeholder="myprovider" value={cpId()} onInput={(e) => setCpId(e.currentTarget.value)} />
            <label class="settings-label">{(useLocale(), label("settings_ai_custom_name"))}</label>
            <input class="settings-input ai-composer-input" placeholder="My AI Provider" value={cpName()} onInput={(e) => setCpName(e.currentTarget.value)} />
            <label class="settings-label">{(useLocale(), label("settings_ai_custom_baseurl"))}</label>
            <input class="settings-input ai-composer-input" placeholder="https://api.myprovider.com/v1" value={cpBaseURL()} onInput={(e) => setCpBaseURL(e.currentTarget.value)} />
            <label class="settings-label">{(useLocale(), label("settings_ai_api_key"))}</label>
            <input type="password" autocomplete="off" class="settings-input ai-composer-input" placeholder="API key" value={cpKey()} onInput={(e) => setCpKey(e.currentTarget.value)} />
            <label class="settings-label">{(useLocale(), label("settings_ai_custom_models"))}</label>
            <Index each={cpModels()}>
              {(mdl, i) => (
                <div class="settings-custom-model">
                  <input class="settings-input ai-composer-input" placeholder="model-id" value={mdl().id} onInput={(e) => setCpModel(i, "id", e.currentTarget.value)} />
                  <input class="settings-input ai-composer-input" placeholder="Display Name" value={mdl().name} onInput={(e) => setCpModel(i, "name", e.currentTarget.value)} />
                  <button
                    type="button"
                    class="settings-custom-remove"
                    aria-label={(useLocale(), label("settings_ai_custom_remove_model"))}
                    onClick={() => setCpModels((ms) => (ms.length > 1 ? ms.filter((_, idx) => idx !== i) : ms))}
                  >
                    <IconTrash width={14} height={14} />
                  </button>
                </div>
              )}
            </Index>
            <div class="settings-row">
              <Button size="sm" variant="outline" onClick={() => setCpModels((ms) => [...ms, { id: "", name: "" }])}>
                {(useLocale(), label("settings_ai_custom_add_model"))}
              </Button>
            </div>
            <Show when={cpError()}>
              <div class="ai-error">{cpError()}</div>
            </Show>
            <div class="settings-row settings-row-end">
              <Button size="sm" onClick={() => void submitCustom()} disabled={!cpId().trim() || !cpBaseURL().trim()}>
                {(useLocale(), label("settings_ai_custom_submit"))}
              </Button>
            </div>
          </div>
        </Match>

        {/* ── Manage models (main view) ── */}
        <Match when={view().kind === "manage"}>
          <h3 class="settings-h3">{(useLocale(), label("settings_nav_ai"))}</h3>
          <p class="settings-prose" style={{ margin: "0 0 10px" }}>
            {(useLocale(), label("settings_ai_manage_models_desc"))}
          </p>
          <div class="settings-models-search">
            <IconSearch width={14} height={14} />
            <input
              type="text"
              placeholder={(useLocale(), label("ai_model_search"))}
              value={modelQuery()}
              onInput={(e) => setModelQuery(e.currentTarget.value)}
            />
            <button
              type="button"
              class="ai-mp-icon-btn"
              title={(useLocale(), label("ai_connect_provider"))}
              aria-label={(useLocale(), label("ai_connect_provider"))}
              onClick={() => setView({ kind: "catalog" })}
            >
              <IconPlus width={15} height={15} />
            </button>
          </div>
          <Show
            when={(props.allModels?.length ?? 0) > 0}
            fallback={<p class="settings-models-empty">{(useLocale(), label("ai_model_none"))}</p>}
          >
            <div class="settings-models">
          <For each={filteredGroups()}>
            {(group) => (
              <>
                <div class="settings-models-group">
                  {/* The name navigates to the provider sub-page (connect /
                      remove); the toggle stays a separate control, so clicking
                      the name never flips visibility. */}
                  <button
                    class="settings-models-group-name"
                    type="button"
                    onClick={() =>
                      enterProvider({ name: group.name, ids: groupProviderIds(group) }, "manage")
                    }
                  >
                    {group.name}
                  </button>
                  <ToggleSwitch
                    checked={providerAllVisible(group)}
                    onChange={() => toggleProvider(group)}
                    aria-label={group.name}
                  >
                    <SwitchControl size="sm">
                      <SwitchThumb size="sm" />
                    </SwitchControl>
                  </ToggleSwitch>
                </div>
                <For each={group.models}>
                  {(mdl) => (
                    <div class="settings-models-row">
                      <span class="settings-models-name">{mdl.label}</span>
                      <ToggleSwitch
                        checked={!hiddenSet().has(mdl.value)}
                        onChange={() => props.onToggleModel?.(mdl.value)}
                        aria-label={mdl.label}
                      >
                        <SwitchControl size="sm">
                          <SwitchThumb size="sm" />
                        </SwitchControl>
                      </ToggleSwitch>
                    </div>
                  )}
                </For>
              </>
            )}
          </For>
          <Show when={filteredGroups().length === 0}>
            <p class="settings-models-empty">{(useLocale(), label("ai_model_none"))}</p>
          </Show>
        </div>
      </Show>

          <div class="settings-row" style={{ "align-items": "center", gap: "10px", "margin-top": "16px" }}>
        <ToggleSwitch
          checked={props.aiStreaming ?? false}
          onChange={(checked) => props.onAiStreamingChange?.(checked)}
          aria-label={(useLocale(), label("settings_ai_streaming_label"))}
        >
          <SwitchControl size="sm">
            <SwitchThumb size="sm" />
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

          <div class="settings-row" style={{ "align-items": "center", gap: "10px", "justify-content": "space-between", "margin-top": "12px" }}>
            <label class="settings-label" style={{ margin: "0" }}>
              {(useLocale(), label("settings_ai_reasoning_label"))}
            </label>
            <Select<string>
              itemComponent={(itemProps) => (
                <SelectItem item={itemProps.item}>{itemProps.item.rawValue}</SelectItem>
              )}
              options={[...REASONING_EFFORTS]}
              value={props.aiReasoning ?? "off"}
              onChange={(value) => value && props.onAiReasoningChange?.(value)}
            >
              <SelectTrigger aria-label={label("settings_ai_reasoning_label")} class="w-40">
                <SelectValue<string>>{(state) => state.selectedOption()}</SelectValue>
              </SelectTrigger>
              <SelectContent />
            </Select>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

// Tool chips above this count collapse behind a "Show more (N)" toggle, so a
// large server (dozens of tools) doesn't dominate the settings list.
const MCP_TOOLS_VISIBLE = 6;

function McpServerCard(props: {
  server: SettingsMcpServer;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);

  const tools = createMemo(() => props.server.tools ?? []);
  const visibleTools = createMemo(() =>
    expanded() ? tools() : tools().slice(0, MCP_TOOLS_VISIBLE),
  );
  /** stdio → the spawn line; http → the endpoint. Both read best in mono. */
  const subtitle = (): string =>
    props.server.transport === "stdio"
      ? [props.server.command ?? "", ...(props.server.args ?? [])]
          .filter(Boolean)
          .join(" ")
      : props.server.url ?? "";
  const dotClass = (): string =>
    props.server.error
      ? "settings-mcp-status-dot settings-mcp-status-dot-error"
      : props.server.connected
        ? "settings-mcp-status-dot settings-mcp-status-dot-connected"
        : "settings-mcp-status-dot";

  return (
    <div class="settings-mcp-card">
      <div class="settings-mcp-card-header">
        <span class="settings-mcp-avatar" aria-hidden="true">
          {(props.server.name || props.server.id).charAt(0).toUpperCase()}
          <span class={dotClass()} />
        </span>
        <div class="settings-mcp-card-info">
          <span class="settings-mcp-card-name">{props.server.name || props.server.id}</span>
          <span class="settings-mcp-cmd" title={subtitle()}>{subtitle()}</span>
        </div>
        <div class="settings-mcp-card-actions">
          <ToggleSwitch
            aria-label={(useLocale(), label("settings_mcp_connected"))}
            checked={props.server.enabled}
            onChange={(checked) => props.onToggle(checked)}
          >
            <SwitchControl size="sm">
              <SwitchThumb size="sm" />
            </SwitchControl>
          </ToggleSwitch>
          <button
            type="button"
            aria-label={(useLocale(), label("settings_mcp_remove"))}
            class="settings-mcp-remove"
            onClick={() => props.onRemove()}
          >
            <IconTrash width={14} height={14} />
          </button>
        </div>
      </div>
      <Show when={tools().length > 0}>
        <div class="settings-mcp-tool-chips">
          <For each={visibleTools()}>
            {(tool) => <span class="settings-mcp-tool-chip">{tool}</span>}
          </For>
        </div>
        <Show when={tools().length > MCP_TOOLS_VISIBLE}>
          <button
            type="button"
            class="settings-mcp-show-toggle"
            onClick={() => setExpanded((open) => !open)}
          >
            <Show
              when={expanded()}
              fallback={(useLocale(),
              m.settings_mcp_show_more({ count: tools().length - MCP_TOOLS_VISIBLE }))}
            >
              {(useLocale(), label("settings_mcp_show_less"))}
            </Show>
          </button>
        </Show>
      </Show>
      <Show when={props.server.error}>
        <span class="ai-error">{props.server.error}</span>
      </Show>
    </div>
  );
}

function McpSection(props: SettingsDialogProps): JSX.Element {
  // Same sub-page pattern as the AI section: the add form is a dedicated view
  // entered from the "New MCP Server" row, with a back arrow to the list.
  const [view, setView] = createSignal<"add" | "list">("list");
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
    setView("list");
  }

  return (
    <div class="settings-section">
      <Switch>
        <Match when={view() === "list"}>
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
                  <McpServerCard
                    server={server}
                    onRemove={() => void props.onRemoveMcpServer?.(server.id)}
                    onToggle={(checked) => void props.onToggleMcpServer?.(server.id, checked)}
                  />
                )}
              </For>
            </div>
          </Show>

          <button
            type="button"
            class="settings-mcp-new-row"
            onClick={() => setView("add")}
          >
            <span class="settings-mcp-avatar" aria-hidden="true">
              <IconPlus width={15} height={15} />
            </span>
            <span class="settings-mcp-new-text">
              <span class="settings-mcp-card-name">{(useLocale(), label("settings_mcp_new_server"))}</span>
              <span class="settings-mcp-new-hint">{(useLocale(), label("settings_mcp_new_server_hint"))}</span>
            </span>
          </button>
        </Match>

        <Match when={view() === "add"}>
          {/* Back arrow mirrors the AI section's sub-pages (shared aria label). */}
          <div class="settings-subpage-header">
            <button
              type="button"
              class="settings-back"
              aria-label={(useLocale(), label("settings_ai_back"))}
              onClick={() => {
                resetForm();
                setView("list");
              }}
            >
              <IconArrowLeft width={16} height={16} />
            </button>
            <h3 class="settings-h3" style={{ margin: "0" }}>
              {(useLocale(), label("settings_mcp_new_server"))}
            </h3>
          </div>
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
        {/* Per-transport gate matches the schema's cross-field rule — a
            stdio server without a command (or http without a url) would be
            silently dropped by the lenient config parse on next load. */}
        <Button
          size="sm"
          disabled={
            !id().trim() ||
            (transport() === "stdio" ? !command().trim() : !url().trim())
          }
          onClick={save}
        >
          {(useLocale(), label("settings_mcp_add"))}
        </Button>
      </div>
        </Match>
      </Switch>
    </div>
  );
}

function IndexingSection(props: SettingsDialogProps): JSX.Element {
  const embeddingGroups = (): Array<{ id: string; name: string; models: Array<{ value: string; label: string }> }> =>
    props.embeddingModelGroups ?? [];
  const embeddingCurrentLabel = (): string => {
    const ref = props.embeddingSelectedModel;
    if (!ref) return "—";
    for (const g of embeddingGroups()) {
      const m = g.models.find((x) => x.value === ref);
      if (m) return m.label;
    }
    return ref;
  };
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
          disabled={props.embeddingCapable === false}
          note={
            props.embeddingCapable === false
              ? (useLocale(), label("settings_indexing_full_requires_embed"))
              : undefined
          }
          onSelect={() => props.onTierChange("full")}
        />
      </div>
      <Show when={props.onSelectEmbeddingModel}>
        <div class="settings-field">
          <label class="settings-label">
            {(useLocale(), label("settings_indexing_embedding_label"))}
          </label>
          <ModelPicker
            groups={embeddingGroups()}
            current={props.embeddingSelectedModel ?? undefined}
            currentLabel={embeddingCurrentLabel()}
            onSelect={(v) => props.onSelectEmbeddingModel?.(v)}
          />
        </div>
      </Show>
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
