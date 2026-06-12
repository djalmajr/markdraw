import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createConverter } from "@asciimark/core/converter.ts";
import ConvertWorker from "@asciimark/core/convert-worker.ts?worker";
import type { IndexedFile } from "@asciimark/core/file-index.ts";
import type { Command } from "@asciimark/core/command-palette.ts";
import { getRecentFiles, type RecentFile } from "@asciimark/core/recent-files.ts";
import { makeTabId } from "@asciimark/core/tabs.ts";
import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "./lib/chaos-invoke.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { createAppState } from "@asciimark/ui/composables/create-app-state.ts";
import { exportChatArtifact, savePlanArtifact } from "./lib/ai-artifacts.ts";
import { createMockProvider } from "@asciimark/ai/mock-provider.ts";
import type { AIConfig, MCPServerConfig } from "@asciimark/ai/config-schema.ts";
import type { AIProvider, AITool } from "@asciimark/ai/types.ts";
import { createApprovalGate } from "@asciimark/ai/approval-policy.ts";
import { resolveModel } from "@asciimark/ai/resolve-model.ts";
import { resolveCredential } from "@asciimark/ai/resolve-credential.ts";
import { createProvider as createAiProvider } from "@asciimark/ai/adapter.ts";
import {
  replaceUnrestoredPlaceholders,
  restoreSecrets,
  scrubSecrets,
} from "@asciimark/ai/secret-scrub.ts";
import { withBuiltins } from "@asciimark/ai/builtin-providers.ts";
import {
  getStoredAiEngine,
  getStoredAiModel,
  setStoredAiModel,
  getStoredAiReasoning,
  setStoredAiReasoning,
  getStoredAiStreaming,
  setStoredAiStreaming,
  type AIReasoningEffort,
  getStoredHiddenModels,
  setStoredHiddenModels,
  getStoredIndexingTier,
  setStoredIndexingTier,
  type IndexingTier,
} from "@asciimark/core/ai-prefs.ts";
import { fetchModels } from "@asciimark/ai/model-catalog.ts";
import { loadAIConfig, loadUserAIConfig, saveAIConfig } from "./lib/ai-config.ts";
import { buildMcpTools } from "@asciimark/ai/mcp-tools.ts";
import {
  createMcpBridge,
  connectEnabledServers,
  connectMcpServer,
  disconnectMcpServer,
  listMcpServers,
  type McpServerStatus,
} from "./lib/ai-mcp.ts";
import {
  buildInProcessTools,
  type ExcalidrawMermaidOutcome,
  type ExcalidrawMermaidRequest,
  type ExcalidrawTargetFileOutcome,
} from "./lib/ai-tools.ts";
import { loadCustomInstructions, loadSlashCommands } from "./lib/ai-commands.ts";
import { createGenerationGuard } from "./lib/generation-guard.ts";
import type { CustomInstructions, SlashCommandDef } from "@asciimark/ai/slash-commands.ts";
import { deleteApiKey, getApiKey, hasApiKey, setApiKey } from "./lib/ai-credentials.ts";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { streamingFetch } from "./lib/ai-sse-fetch.ts";
import type { TabStore } from "@asciimark/ui/composables/create-tab-store.ts";
import { AppShell } from "@asciimark/ui/components/app-shell.tsx";
import type { EditorApi } from "@asciimark/ui/components/editor.tsx";
import { SHORTCUTS } from "@asciimark/core/keyboard-shortcuts.ts";
import { effectiveKeys, getStoredKeybindings, matchBinding } from "@asciimark/core/keybindings.ts";
import * as m from "@asciimark/i18n";
import { switchLocale, useLocale, locales as i18nLocales } from "@asciimark/i18n/solid";
import { getStoredTheme, applyTheme } from "./main.tsx";
import { FileWatcher } from "./lib/watcher.ts";
import { createFileLoader } from "./lib/file-loader.ts";
import { createNavigation } from "./lib/navigation.ts";
import { createFolder } from "./lib/folder.ts";
import {
  ExcalidrawFrame,
  type ExcalidrawFrameApi,
  type ExcalidrawWriteInput,
} from "./components/excalidraw-frame.tsx";
import { fileKind, isSupportedFile } from "@asciimark/core/utils.ts";
import { dedupeTokenLabel, excalidrawSceneToOutline, excalidrawSelectionToContext } from "@asciimark/ui/composables/ai-context.ts";
import { buildBacklinkIndex } from "@asciimark/core/backlinks.ts";
import { flattenWorkspace } from "@asciimark/core/file-index.ts";
import { createDir, createFile, readFileByPath, readFileContent, writeFile } from "./lib/fs.ts";
import { extractPdfText } from "./lib/pdf-text.ts";
import {
  buildWorkspaceSymbols,
  type WorkspaceSymbol,
} from "@asciimark/core/workspace-symbols.ts";
import { confirm } from "@asciimark/ui/components/confirm-dialog.tsx";
import { setupTauriDnd } from "./lib/dnd.ts";
import { setupAppMenu } from "./lib/menu.ts";
import { setupTray } from "./lib/tray.ts";
import { decideCloseAction } from "./lib/window-close.ts";
import { exit } from "@tauri-apps/plugin-process";
import {
  _devSetDownloadProgress,
  _devSetPendingUpdate,
  checkForAppUpdates,
  dismissUpdate,
  useDownloadProgress,
  useUpdate,
} from "./lib/updater.ts";
import { fetchReleaseHistory, type ReleaseHistoryEntry } from "./lib/release-notes.ts";

const RELEASES_INDEX_URL =
  "https://github.com/djalmajr/asciimark/releases";
import { UpdateAvailableDialog } from "@asciimark/ui/components/update-available-dialog.tsx";
import { ReleaseNotesDialog } from "@asciimark/ui/components/release-notes-dialog.tsx";
import { findInFiles } from "./lib/fs.ts";
import { WindowControls } from "./components/window-controls.tsx";
// Capture-to-Figma button is hidden for now (per request). Re-enable by
// restoring this import and its render site below.
// import { FigmaCaptureButton } from "./components/figma-capture-button.tsx";
import { openUrl } from "@tauri-apps/plugin-opener";

const { convertAdoc, convertMarkdown } = createConverter(new ConvertWorker());

// Providers that talk to a localhost server and need no API key — they count
// as "connected" without a keychain or config credential.
const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio"]);

// Skeleton written when app__excalidraw_write targets a file that doesn't
// exist yet. The frame's loader would boot an empty scene from "" too (its
// JSON.parse catch), but a 0-byte file isn't a valid .excalidraw — the
// skeleton keeps the file well-formed even if the guest never saves.
const EMPTY_EXCALIDRAW_SCENE =
  '{"type":"excalidraw","version":2,"source":"asciimark","elements":[]}';

export function App() {
  // AI provider catalog (ai.json merged over builtins). Starts with builtins so
  // a provider is resolvable before the async load completes; refreshed onMount.
  const [aiConfig, setAiConfig] = createSignal<AIConfig>(withBuiltins({}));

  // MCP (Model Context Protocol) client. The Rust manager (src-tauri/ai_mcp.rs)
  // owns connections for both transports; this bridge drives tool discovery and
  // `mcpStatuses` mirrors live connection state for the settings UI.
  const mcpBridge = createMcpBridge();
  const [mcpStatuses, setMcpStatuses] = createSignal<McpServerStatus[]>([]);
  // Tool names grouped by server id — feeds the settings card tool chips.
  const [mcpTools, setMcpTools] = createSignal<Record<string, string[]>>({});

  // Deterministic secret scrubbing (omp#5), session-scoped: one map per app
  // run keeps `[secret-<nonce>-N]` placeholders stable across every outbound
  // scrub (file reads, active doc, context chips) so inbound tool args and the
  // chat display can restore the real values.
  const aiSecretMap = new Map<string, string>();
  const scrubAi = (text: string): string => scrubSecrets(text, aiSecretMap).text;
  const restoreAi = (text: string): string => restoreSecrets(text, aiSecretMap);
  /** Chat DISPLAY transform: restore, then label any placeholder the
   *  session-scoped map can no longer resolve (rehydrated chats from a
   *  previous run) as an expired secret instead of rendering it raw. Tool-args
   *  restore stays `restoreAi` — there a stale placeholder must keep failing
   *  its find-match (fail-safe), not silently morph into a label. */
  const displayAi = (text: string): string =>
    replaceUnrestoredPlaceholders(restoreAi(text), m.ai_secret_expired());

  // A prompt-tier tool call (MCP / unknown) awaiting Accept/Reject before it
  // runs. Human-in-the-loop gating on top of the current non-streaming loop.
  const [pendingApproval, setPendingApproval] = createSignal<{
    toolName: string;
    source?: string;
    argsPreview: string;
    approve: () => void;
    deny: () => void;
  } | null>(null);

  /** Engine options read fresh per provider build: streaming picks the Rust
   *  SSE transport (tauri-plugin-http buffers whole bodies); reasoning "off"
   *  omits the option entirely (engines map low/medium/high only). */
  function buildEngineOptions(): Parameters<typeof createAiProvider>[3] {
    const reasoning: AIReasoningEffort = getStoredAiReasoning();
    return {
      fetch: getStoredAiStreaming() ? streamingFetch : tauriFetch,
      streaming: getStoredAiStreaming(),
      ...(reasoning !== "off" ? { reasoningEffort: reasoning } : {}),
    };
  }

  // Build the active provider from ai-prefs + config + keychain. With no model
  // configured, DEV falls back to the mock (AI surfaces stay testable without
  // keys); release returns null so the panel shows the honest no-provider
  // state instead of a "Mock (dev)" model answering with fake text.
  function buildAIProvider(): AIProvider | null {
    const modelId = getStoredAiModel();
    const resolved = modelId ? resolveModel(aiConfig(), modelId) : null;
    if (!resolved) return import.meta.env.DEV ? createMockProvider() : null;
    // If the user put the key in ai.json (config), use it directly and skip the
    // keychain — avoids touching the OS keychain when it isn't the source.
    const hasConfigKey = !!resolved.provider.options?.apiKey;
    return createAiProvider(
      getStoredAiEngine(),
      resolved,
      () =>
        resolveCredential(
          resolved.providerId,
          resolved.provider,
          hasConfigKey
            ? {}
            : { keychain: (id) => getApiKey(id).then((k) => k ?? undefined) },
        ),
      // Route provider HTTP through Rust to avoid the webview CORS wall.
      // Streaming ON swaps in the Rust SSE transport (ai_http.rs → Channel →
      // streaming Response), which actually delivers deltas — tauri-plugin-http
      // buffers whole bodies, so it stays the buffered default only.
      buildEngineOptions(),
    );
  }

  /** Provider chip label: real "Provider · model" when configured; the mock
   *  only ever shows in DEV — release renders the localized "no provider". */
  const aiProviderLabel = (): string | null => {
    const modelId = getStoredAiModel();
    const resolved = modelId ? resolveModel(aiConfig(), modelId) : null;
    if (resolved) return `${resolved.provider.name} · ${resolved.modelId}`;
    return import.meta.env.DEV ? "Mock (dev)" : null;
  };

  const state = createAppState({
    applyTheme,
    convertAdoc,
    convertMarkdown,
    getStoredTheme,
    printPage: () => invoke("print_webview"),
    // Real engine driven by ai-prefs + keychain, with a mock fallback (DJA-11F).
    createAIProvider: () => buildAIProvider(),
    // Tools for the chat tool-calling loop: in-process app tools + MCP servers.
    getAITools,
    // Workspace custom instructions (.asciimark/instructions.md) merged into
    // the system prompt (arrow defers the read — the signal is declared below).
    getCustomInstructions: () => aiInstructions() ?? undefined,
    // Engine-enforced Accept/Reject for prompt-tier tools (arrow defers the
    // read — the gate is defined further down in this component).
    onToolApprovalRequest: (req) => requestToolApproval(req),
    // Plan mode persists each produced plan under the workspace's .asciimark/plans.
    onPlanComplete: handlePlanComplete,
    // Chat tab "Export" → native Save As, defaulting to .asciimark/chats.
    onExportChat: handleExportChat,
  });

  // Load the AI config (ai.json merged with builtins) once at startup, then
  // connect any enabled MCP servers so their tools are ready for the first turn.
  onMount(async () => {
    try {
      const cfg = await loadAIConfig();
      setAiConfig(cfg);
      await connectEnabledServers(cfg.mcp);
      await refreshMcpStatuses();
    } catch {
      // keep the builtins-only config
    }
    // Independent of config-load success — the builtins-only fallback still
    // needs its keychain probe so connected providers surface in the pickers.
    await refreshConnectedProviders();
  });

  // ── Settings modal (DJA-15) ────────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [indexingTier, setIndexingTier] = createSignal<IndexingTier>(
    getStoredIndexingTier(),
  );
  // Streaming-responses beta toggle. Read fresh by buildAIProvider each turn, so
  // flipping it takes effect on the next message (no provider rebuild needed).
  const [aiStreaming, setAiStreaming] = createSignal(getStoredAiStreaming());
  // Reasoning effort — same read-fresh pattern (buildEngineOptions).
  const [aiReasoning, setAiReasoning] = createSignal<AIReasoningEffort>(getStoredAiReasoning());

  const aiProviders = createMemo(() =>
    Object.entries(aiConfig().provider).map(([id, p]) => ({
      id,
      name: p.name,
      models: Object.keys(p.models),
    })),
  );

  // Which provider ids are CONNECTED — local (no key needed), key in ai.json,
  // or key in the OS keychain. The keychain check is async, so this is a signal
  // refreshed on mount and after every connect/disconnect rather than a memo.
  // It gates the model groups (chat picker + Manage models): a builtin with
  // hardcoded models but no credential must not surface as pickable.
  const [connectedProviders, setConnectedProviders] = createSignal<Record<string, boolean>>({});
  async function refreshConnectedProviders(): Promise<void> {
    const next: Record<string, boolean> = {};
    for (const [id, p] of Object.entries(aiConfig().provider)) {
      next[id] =
        LOCAL_PROVIDER_IDS.has(id) || !!p.options?.apiKey || (await hasApiKey(id));
    }
    setConnectedProviders(next);
  }

  // Model picker shown in the chat composer footer. Reads `aiConfig()` so it
  // re-derives when the selection changes (selectAiModel bumps the config).
  const aiCurrentModel = createMemo<string>(() => {
    aiConfig();
    return getStoredAiModel() ?? "";
  });
  // Every CONNECTED provider's models grouped by provider (drives Settings →
  // Manage models and the chat picker). Providers whose display name shares a base — e.g.
  // "OpenCode Go" (kind: anthropic) and "OpenCode Go (chat)" (kind:
  // openai-compatible), two entries for the same backend — are MERGED into one
  // group; each model's `value` keeps its own provider id so routing/`kind`
  // stays correct.
  const aiModelGroupsAll = createMemo<{ id: string; name: string; models: { value: string; label: string }[] }[]>(
    () => {
      const groups = new Map<string, { id: string; name: string; models: { value: string; label: string }[] }>();
      const connected = connectedProviders();
      for (const [pid, p] of Object.entries(aiConfig().provider)) {
        // Connected providers only — `aiModelGroups` (chat picker) derives from
        // this memo, so the filter covers both it and Manage models.
        if (!connected[pid]) continue;
        const models = Object.entries(p.models).map(([mid, mdl]) => ({
          value: `${pid}/${mid}`,
          label: mdl.name ?? mid,
        }));
        if (models.length === 0) continue;
        // Drop a trailing parenthetical variant suffix ("(chat)") to find the base.
        const base = p.name.replace(/\s*\([^)]*\)\s*$/, "").trim() || p.name;
        const existing = groups.get(base);
        if (existing) existing.models.push(...models);
        else groups.set(base, { id: base, name: base, models });
      }
      return [...groups.values()];
    },
  );
  // Models the user hid via "Manage models" — filtered out of the chat picker.
  const [hiddenModels, setHiddenModels] = createSignal<string[]>(getStoredHiddenModels());
  function toggleHiddenModel(ref: string): void {
    setHiddenModels((cur) => {
      const next = cur.includes(ref) ? cur.filter((r) => r !== ref) : [...cur, ref];
      setStoredHiddenModels(next);
      return next;
    });
  }
  // What the chat picker shows: all groups minus the hidden models.
  const aiModelGroups = createMemo(() => {
    const hidden = new Set(hiddenModels());
    return aiModelGroupsAll()
      .map((g) => ({ ...g, models: g.models.filter((mdl) => !hidden.has(mdl.value)) }))
      .filter((g) => g.models.length > 0);
  });
  /** Context window (tokens) of the active model — drives the composer's
   *  context-usage ring. Undefined when the model config has no `limit`. */
  const aiContextLimit = createMemo<number | undefined>(() => {
    const ref = aiCurrentModel();
    if (!ref.includes("/")) return undefined;
    const providerId = ref.slice(0, ref.indexOf("/"));
    const modelId = ref.slice(ref.indexOf("/") + 1);
    return aiConfig().provider[providerId]?.models[modelId]?.limit?.context;
  });
  /** Quick model switch from the composer footer (same provider). Persists the
   *  selection and bumps the config so the picker/label refresh. */
  function selectAiModel(modelRef: string): void {
    setStoredAiModel(modelRef);
    setAiConfig((c) => ({ ...c }));
  }

  async function listAiModels(providerId: string, apiKey: string): Promise<string[]> {
    const provider = aiConfig().provider[providerId];
    const baseURL = provider?.options?.baseURL;
    if (!baseURL) return Object.keys(provider?.models ?? {});
    const list = await fetchModels(
      baseURL,
      apiKey || undefined,
      provider?.options?.headers,
      tauriFetch as unknown as typeof globalThis.fetch,
    );
    return list.map((mdl) => mdl.id);
  }

  async function saveAiProvider(opts: {
    providerId: string;
    apiKey: string;
    modelId: string;
  }): Promise<void> {
    const { providerId, apiKey, modelId } = opts;
    if (apiKey) await setApiKey(providerId, apiKey); // key → OS keychain only
    const modelRef = `${providerId}/${modelId}`;
    // Read-modify-write so sibling sections (mcp servers, other providers)
    // survive instead of being clobbered. Keys never touch ai.json.
    const user = await loadUserAIConfig();
    await saveAIConfig(
      JSON.stringify({
        ...user,
        model: modelRef,
        provider: {
          ...(user.provider ?? {}),
          [providerId]: { models: { [modelId]: { name: modelId } } },
        },
      }),
    );
    setStoredAiModel(modelRef);
    setAiConfig(await loadAIConfig());
    await refreshConnectedProviders();
  }

  /** Add a custom OpenAI-compatible provider to ai.json (+ key → keychain).
   *  Keys never touch ai.json; sibling config (other providers, MCP) survives. */
  async function saveCustomProvider(input: {
    id: string;
    name: string;
    baseURL: string;
    apiKey: string;
    models: { id: string; name: string }[];
  }): Promise<void> {
    const id = input.id.trim();
    if (!id) throw new Error("Provider ID is required.");
    if (input.apiKey) await setApiKey(id, input.apiKey); // key → OS keychain only
    const models: Record<string, { name: string }> = {};
    for (const mdl of input.models) {
      const mid = mdl.id.trim();
      if (mid) models[mid] = { name: mdl.name.trim() || mid };
    }
    const user = await loadUserAIConfig();
    await saveAIConfig(
      JSON.stringify({
        ...user,
        provider: {
          ...(user.provider ?? {}),
          [id]: {
            kind: "openai-compatible",
            name: input.name.trim() || id,
            options: { baseURL: input.baseURL.trim() },
            models,
          },
        },
      }),
    );
    setAiConfig(await loadAIConfig());
    await refreshConnectedProviders();
  }

  /** Connect a built-in provider: store its key (keychain) and, when it lists no
   *  models yet but has a baseURL, fetch + register them so they show up in
   *  Manage models. Used by the per-provider connect sub-page. */
  async function connectProvider(input: { providerId: string; apiKey: string }): Promise<void> {
    const { providerId, apiKey } = input;
    if (apiKey) await setApiKey(providerId, apiKey);
    const provider = aiConfig().provider[providerId];
    if (provider && Object.keys(provider.models).length === 0 && provider.options?.baseURL) {
      let ids: string[] = [];
      try {
        ids = await listAiModels(providerId, apiKey);
      } catch {
        ids = [];
      }
      if (ids.length) {
        const user = await loadUserAIConfig();
        const existing = (user.provider ?? {})[providerId] ?? {};
        await saveAIConfig(
          JSON.stringify({
            ...user,
            provider: {
              ...(user.provider ?? {}),
              [providerId]: { ...existing, models: Object.fromEntries(ids.map((id) => [id, { name: id }])) },
            },
          }),
        );
      }
    }
    setAiConfig(await loadAIConfig());
    await refreshConnectedProviders();
  }

  /** Disconnect a provider group ("Remove provider" in Manage models). Receives
   *  EVERY id behind a merged base name (connect set the key on each, so each
   *  is cleared). Custom providers — present in the raw user config with
   *  kind+name — are also dropped from ai.json; built-ins keep their catalog
   *  entry and merely lose the credential (the connected filter hides them). */
  async function removeProvider(ids: string[]): Promise<void> {
    for (const id of ids) await deleteApiKey(id);
    const user = await loadUserAIConfig();
    const provider = { ...(user.provider ?? {}) };
    let changed = false;
    for (const id of ids) {
      const up = provider[id];
      if (up?.kind && up.name) {
        delete provider[id];
        changed = true;
      }
    }
    // Read-modify-write so sibling sections (mcp, other providers) survive.
    if (changed) await saveAIConfig(JSON.stringify({ ...user, provider }));
    // A selection pointing at the removed provider would resolve to a dead
    // model — clear it so the chat shows the honest no-provider state.
    const selected = getStoredAiModel();
    const selectedProvider = selected?.includes("/")
      ? selected.slice(0, selected.indexOf("/"))
      : null;
    if (selectedProvider && ids.includes(selectedProvider)) setStoredAiModel(null);
    setAiConfig(await loadAIConfig());
    await refreshConnectedProviders();
  }

  // ── MCP servers + in-process tools (chat tool-calling) ─────────────────
  /** Tools the chat may call: in-process app tools (active doc / workspace,
   *  edits via Accept/Reject) plus every connected MCP server's tools. */
  async function getAITools(): Promise<AITool[]> {
    const inProcess = buildInProcessTools({
      // Reuses the file-tree's root-validated Rust commands (reject ../ and
      // absolute paths, refuse overwrite); the tree refreshes via the watcher.
      // Reads are scrubbed so file content reaches the model with `[secret-N]`
      // placeholders; restoreSecretsIn below maps them back before writes.
      fs: {
        createDir,
        createFile,
        readFileRelative: async (root, relative) => {
          const content = await readFileByPath(root, relative);
          return content === null ? null : scrubAi(content);
        },
        writeFileAbs: writeFile,
      },
      getActiveDoc: () => scrubAi(state.editorContent()),
      getActiveDocPath: () => state.selectedFile()?.path ?? null,
      // Same frame-handle path ⌘I uses (activeExcalidrawFrame) — null when the
      // active view isn't a mounted `.excalidraw`, so the read tool falls back.
      getActiveExcalidrawOutline: async () => {
        const api = activeExcalidrawFrame();
        const file = state.paneManager.activePane().selectedFile();
        if (!api || !file) return null;
        return excalidrawSceneToOutline(await api.getScene(), file.name);
      },
      getWorkspaceRoots: () => Array.from(rootPaths().values()),
      proposeEdit: proposeAiEdit,
      restoreSecretsIn: restoreAi,
      scrubSecretsIn: scrubAi,
      // Live plan (app__update_plan): full-list replace into app state, null
      // clears the card. UI-state only — the tool runs without approval.
      updatePlan: (items) => (items === null ? state.clearAiPlan() : state.setAiPlanItems(items)),
      applyExcalidrawMermaid,
    });
    let mcp: AITool[] = [];
    try {
      mcp = await buildMcpTools(mcpBridge);
    } catch {
      mcp = [];
    }
    // Tools go UNWRAPPED: the engine enforces the Accept/Reject gate now
    // (ChatOptions.onApprovalRequest, threaded via createAppState below).
    // Wrapping here too would double-gate every prompt-tier call.
    return [...inProcess, ...mcp];
  }

  /** Persist a Plan-mode result to `<root>/.asciimark/plans/plan-<stamp>.md`.
   *  Plan turns quote scrubbed `[secret-N]` placeholders, so the artifact
   *  writer restores them before disk. No-op (logged) when no folder is open. */
  async function handlePlanComplete(content: string): Promise<void> {
    const root = Array.from(rootPaths().values())[0];
    if (!root) {
      console.warn("[plan] no workspace open — plan not saved");
      return;
    }
    try {
      const path = await savePlanArtifact(
        { restoreSecrets: restoreAi, writeFile },
        root,
        content,
      );
      console.info(`[plan] saved ${path}`);
    } catch (e) {
      console.error("[plan] failed to save:", e);
    }
  }

  /** Export a chat transcript via a native Save As dialog, defaulting to
   *  `<root>/.asciimark/chats/<slug>-<stamp>.md` (the dir is created on demand).
   *  Store turns keep `[secret-N]` placeholders by design — the artifact
   *  writer restores them so the file matches the displayed transcript. */
  async function handleExportChat(payload: { title: string; markdown: string }): Promise<void> {
    const root = Array.from(rootPaths().values())[0] ?? null;
    try {
      const path = await exportChatArtifact(
        {
          restoreSecrets: restoreAi,
          saveFileDialog: (defaultDir, defaultName) =>
            invoke<string | null>("save_file_dialog", { defaultDir, defaultName }),
          writeFile,
        },
        root,
        payload,
      );
      if (path) console.info(`[export] chat saved ${path}`);
    } catch (e) {
      console.error("[export] failed to save chat:", e);
    }
  }

  /** Serialized, abort-aware approval gate for prompt-tier tool calls: shows one
   *  bar at a time (FIFO so concurrent calls in a step don't clobber it) and
   *  auto-denies + hides on Stop/clear (the run's abort signal settles it). */
  const requestToolApproval = createApprovalGate((req, decide) => {
    let argsPreview: string;
    try {
      argsPreview = JSON.stringify(req.args, null, 2);
    } catch {
      argsPreview = String(req.args);
    }
    // The user must approve the REAL values, not session placeholders. Display
    // only — the tool still receives the args as sent (restoreSecretsIn maps
    // them back where they must match real content).
    argsPreview = restoreAi(argsPreview);
    setPendingApproval({
      toolName: req.toolName,
      source: req.source,
      argsPreview,
      approve: () => decide(true),
      deny: () => decide(false),
    });
    return () => setPendingApproval(null);
  });

  /** The imperative editor handle of the active pane, or undefined when the
   *  active pane isn't a text editor (preview/diagram). */
  function activeEditorApi(): EditorApi | undefined {
    const pane = state.paneManager.activePane() as { editorApi?: EditorApi } | null;
    return pane?.editorApi;
  }

  /** Apply an AI-proposed find→replace edit optimistically and overlay a
   *  Cursor-style inline diff the user can Keep/Undo. Resolves immediately to a
   *  short status the model sees (the review happens after, in the editor). */
  function proposeAiEdit(edit: { find: string; replace: string }): Promise<string> {
    const api = activeEditorApi();
    if (!api) {
      return Promise.resolve("No active editor is available to apply the edit.");
    }
    return Promise.resolve(api.proposeDiff(edit.find, edit.replace).message);
  }

  async function refreshMcpStatuses(): Promise<void> {
    try {
      setMcpStatuses(await listMcpServers());
      const grouped: Record<string, string[]> = {};
      for (const tool of await mcpBridge.listTools()) {
        (grouped[tool.server] ??= []).push(tool.name);
      }
      setMcpTools(grouped);
    } catch {
      // best-effort UI state
    }
  }

  /** Persist the MCP server list into ai.json, preserving sibling sections. */
  async function persistMcpServers(servers: MCPServerConfig[]): Promise<void> {
    const user = await loadUserAIConfig();
    await saveAIConfig(JSON.stringify({ ...user, mcp: servers }));
    setAiConfig(await loadAIConfig());
  }

  async function saveMcpServer(input: {
    id: string;
    name?: string;
    transport: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    enabled: boolean;
  }): Promise<void> {
    // Preserve headers already set (e.g. via ai.json) when an edit doesn't
    // re-supply them, so a UI tweak never silently drops an auth token.
    const existing = (aiConfig().mcp ?? []).find((s) => s.id === input.id);
    const headers = input.headers ?? existing?.headers;
    const next: MCPServerConfig = {
      id: input.id,
      transport: input.transport,
      enabled: input.enabled,
      ...(input.name ? { name: input.name } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.args && input.args.length ? { args: input.args } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(headers && Object.keys(headers).length ? { headers } : {}),
    };
    const servers = [...(aiConfig().mcp ?? [])];
    const idx = servers.findIndex((s) => s.id === input.id);
    if (idx >= 0) servers[idx] = next;
    else servers.push(next);
    await persistMcpServers(servers);
    try {
      if (next.enabled !== false) await connectMcpServer(next);
      else await disconnectMcpServer(next.id);
    } catch (e) {
      console.warn(`[mcp] connect failed for "${next.id}":`, e);
    }
    await refreshMcpStatuses();
  }

  async function removeMcpServer(id: string): Promise<void> {
    const servers = (aiConfig().mcp ?? []).filter((s) => s.id !== id);
    try {
      await disconnectMcpServer(id);
    } catch {
      // not connected
    }
    await persistMcpServers(servers);
    await refreshMcpStatuses();
  }

  async function toggleMcpServer(id: string, enabled: boolean): Promise<void> {
    const servers = (aiConfig().mcp ?? []).map((s) =>
      s.id === id ? { ...s, enabled } : s,
    );
    await persistMcpServers(servers);
    const server = servers.find((s) => s.id === id);
    if (server) {
      try {
        if (enabled) await connectMcpServer(server);
        else await disconnectMcpServer(id);
      } catch (e) {
        console.warn(`[mcp] toggle failed for "${id}":`, e);
      }
    }
    await refreshMcpStatuses();
  }

  /** View model for the settings MCP list: persisted config + live status. */
  const mcpServersView = createMemo(() => {
    const statuses = new Map(mcpStatuses().map((s) => [s.id, s]));
    return (aiConfig().mcp ?? []).map((s) => {
      const st = statuses.get(s.id);
      return {
        id: s.id,
        name: s.name,
        transport: s.transport,
        enabled: s.enabled !== false,
        connected: st?.connected ?? false,
        toolCount: st?.toolCount ?? 0,
        tools: mcpTools()[s.id],
        command: s.command,
        args: s.args,
        url: s.url,
      };
    });
  });

  // TabStore lives inside each PaneStore (see `createPaneStore`). The
  // host treats whichever pane is currently active as the "default"
  // tab store — read/write operations route there. As panes change
  // focus or split open, this accessor naturally flips with them.
  // Wrapped as a function (not a captured const) so the activePane
  // dependency stays reactive inside Solid effects.
  const tabStore = (): TabStore => state.paneManager.activePane().tabs;

  const [rootPaths, setRootPaths] = createSignal<Map<string, string>>(new Map());

  // File-backed slash commands + custom instructions (omp#1). Reloaded
  // whenever the primary workspace root changes — the project-level files
  // live under <root>/.asciimark; builtin + global commands survive with no
  // root open. Both loaders are best-effort and never throw. The guard makes
  // resolutions latest-wins: rapid root switches (or popover-open refreshes)
  // may settle out of order, and a stale load must not clobber a fresh one.
  const [aiSlashCommands, setAiSlashCommands] = createSignal<SlashCommandDef[]>([]);
  const [aiInstructions, setAiInstructions] = createSignal<CustomInstructions | null>(null);
  const aiCommandsGuard = createGenerationGuard();
  function reloadAiCommands(): void {
    const root = Array.from(rootPaths().values())[0] ?? null;
    const isLatest = aiCommandsGuard.begin();
    void loadSlashCommands(root).then((commands) => {
      if (isLatest()) setAiSlashCommands(commands);
    });
    void loadCustomInstructions(root).then((instructions) => {
      if (isLatest()) setAiInstructions(instructions);
    });
  }
  // reloadAiCommands reads rootPaths() synchronously, so the effect tracks it.
  createEffect(() => reloadAiCommands());

  // Quick Open (Cmd/Ctrl+P) overlay visibility — owned here so the keyboard
  // handler can toggle it without round-tripping through AppShell.
  const [quickOpenVisible, setQuickOpenVisible] = createSignal(false);
  const [recentFilesVersion, setRecentFilesVersion] = createSignal(0);
  // Shortcuts help (Cmd/Ctrl+/ + toolbar menu item) — same pattern.
  const [shortcutsHelpVisible, setShortcutsHelpVisible] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const [appVersion, setAppVersion] = createSignal<string>("");
  // Release notes dialog state — driven by the "Release notes" menu
  // item / Command Palette command. `entries` is null while loading
  // or on error; `error` flips to a localized message on failure.
  // `currentVersion` is the locally installed app version so the
  // dialog can mark the matching row.
  const [releaseNotesState, setReleaseNotesState] = createSignal<{
    open: boolean;
    currentVersion: string;
    entries: ReleaseHistoryEntry[] | null;
    loading: boolean;
    error: string | null;
  }>({ open: false, currentVersion: "", entries: null, loading: false, error: null });
  // Command palette (Cmd/Ctrl+Shift+P).
  const [commandPaletteVisible, setCommandPaletteVisible] = createSignal(false);
  // Symbol palette (Cmd/Ctrl+Shift+O).
  const [symbolPaletteVisible, setSymbolPaletteVisible] = createSignal(false);
  // Workspace-wide symbol palette (Cmd/Ctrl+T). Shares the
  // open-only mutual-exclusion with the other overlays — the local
  // symbol palette is a sibling, not a sub-mode.
  const [workspaceSymbolPaletteVisible, setWorkspaceSymbolPaletteVisible] = createSignal(false);
  // Find in Files (Cmd/Ctrl+Shift+F).
  const [findInFilesVisible, setFindInFilesVisible] = createSignal(false);

  // Flag to suppress auto-save during tab switches
  let isTabSwitching = false;

  // File watcher (watches current file + includes for content changes)
  const watcher = new FileWatcher(async () => {
    const file = state.selectedFile();
    if (!file) return;

    try {
      await loader.loadFileContent(file, false, true);
      tabStore().updateActiveTabContent({
        editorContent: state.editorContent(),
        savedContent: state.savedContent(),
        html: state.html(),
        frontmatter: state.frontmatter(),
      });
    } catch {
      // File likely deleted — the dir watcher will refresh the tree
      // and the tab will show an error until clicked away
    }
  });

  // Create modules: loader -> navigation -> folder -> dnd
  const loader = createFileLoader({ rootPaths, state, watcher });

  const navigation = createNavigation({
    loadFileContent: loader.loadFileContent,
    rootPaths,
    state,
    tabStore,
    onActivateTab: (tabId) => handleActivateTab(tabId),
  });

  const folder = createFolder({
    rootPaths,
    setRootPaths,
    state,
    watcher,
  });

  setupTauriDnd({
    addRoot: folder.openFolderPath,
    loadFileContent: loader.loadFileContent,
    state,
  });

  // Dev-only: expose APIs so the MCP bridge can drive workspaces and toggles
  // from outside (avoids the native open-dialog when AI agents test the app).
  if (import.meta.env.DEV) {
    (window as unknown as { __DEV__?: Record<string, unknown> }).__DEV__ = {
      openFolder: folder.openFolderPath,
      startCreate: (parentPath: string, rootId: string, kind: "file" | "folder") =>
        state.setCreatingAt({ parentPath, rootId, kind }),
      toggleShowAllFiles: () => state.setShowAllFiles((v) => !v),
      toggleShowAllDirs: () => state.setShowAllDirs((v) => !v),
      toggleShowHidden: () => {
        state.setShowHiddenEntries((v) => !v);
        return folder.refreshAllRoots();
      },
      getState: () => ({
        showAllFiles: state.showAllFiles(),
        showAllDirs: state.showAllDirs(),
        showHidden: state.showHiddenEntries(),
        roots: state.rootsList().map((r) => ({ id: r.id, entries: r.entries.length })),
      }),
      // Drive the move-tab handler directly. Useful for E2E that
      // can't reliably synthesize a Kobalte ContextMenu click.
      moveTab: (tabId: string, fromPaneIndex: number) => handleMoveTab(tabId, fromPaneIndex),
      simulatePendingUpdate: (version: string, currentVersion: string, notes: string) =>
        _devSetPendingUpdate({
          version,
          currentVersion,
          notes,
          install: async () => { console.log("[__DEV__] would install"); },
        }),
      simulateDownloadProgress: (
        phase: "downloading" | "installing",
        downloaded: number,
        total: number | null,
        speed: number,
      ) => _devSetDownloadProgress({ phase, downloaded, total, speed }),
      clearDownloadProgress: () => _devSetDownloadProgress(null),
    };

    // memlab soak hooks (DJA-38). The scenario dispatches synthetic
    // events that drive the edit + fs-change path the way the user's
    // keystrokes would, so memlab can compare baseline vs end-of-run
    // heap and detect retention regressions. We register the
    // listeners ONCE per process (no add/remove on each iteration —
    // that would muddy the very leak signal we're trying to measure).
    window.addEventListener("e2e:simulate-edit", (event) => {
      const detail = (event as CustomEvent<{ iter: number; content: string }>).detail;
      const pane = state.paneManager.activePane();
      // Push content through the same code path the editor uses, so
      // the convert pipeline runs, signal subscribers fire, and the
      // fs-change watcher's listeners are exercised.
      pane.setEditorContent(detail.content);
      pane.tabs.updateActiveTabContent({ editorContent: detail.content });
    });
    window.addEventListener("e2e:reset", () => {
      const pane = state.paneManager.activePane();
      pane.setEditorContent("");
      pane.tabs.updateActiveTabContent({ editorContent: "" });
    });
  }

  // Toggle auto-refresh (only when roots are open)
  createEffect(() => {
    if (rootPaths().size === 0) return;
    if (state.autoRefresh()) {
      watcher.start();
    } else {
      watcher.stop();
    }
  });

  // Watch workspace directories for file tree changes (rename/delete/create)
  createEffect(() => {
    const paths = rootPaths();
    if (paths.size === 0) {
      void invoke("stop_watching_dirs");
      return;
    }
    void invoke("watch_dirs", { paths: Array.from(paths.values()) });
  });

  onMount(() => {
    const pendingRoots = new Set<string>();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = listen<{ paths: string[] }>("fs-tree-change", (event) => {
      // Identify which roots were affected
      const paths = rootPaths();
      for (const changed of event.payload.paths) {
        for (const [rootId, rootPath] of paths) {
          if (changed.startsWith(rootPath)) {
            pendingRoots.add(rootId);
            break;
          }
        }
      }
      // Debounce — batch rapid events into a single refresh per root
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        for (const rootId of pendingRoots) {
          void folder.refreshRoot(rootId);
        }
        pendingRoots.clear();
      }, 300);
    });
    onCleanup(() => {
      clearTimeout(refreshTimer);
      void unlisten.then((fn) => fn());
    });
  });

  // Auto-save: debounce 1s after editor content changes
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const content = state.editorContent();
    if (isTabSwitching) return;
    if (state.editorMode() === "preview") return;
    if (!state.selectedFile()) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      folder.handleEditorSave();
    }, 1000);
  });

  onCleanup(() => {
    clearTimeout(autoSaveTimer);
    watcher.destroy();
  });

  // Native app menu (macOS menu bar, Windows/Linux window menu) and tray icon.
  // Both are fire-and-forget; errors are logged but don't break the app.
  onMount(() => {
    // macOS traffic lights sit in the top-left corner of the overlay title
    // bar. Reserve space so toolbar controls don't overlap them.
    // On Windows the custom WindowControls (min/max/close) are drawn in the
    // top-right — reserve space for them.
    if (navigator.platform.startsWith("Mac")) {
      document.documentElement.style.setProperty("--toolbar-frame-inset-left", "78px");
    } else if (navigator.platform.startsWith("Win")) {
      // Custom caption buttons — 46×32 each × 3 = 138px (matches Win11 native).
      document.documentElement.style.setProperty("--toolbar-frame-inset-right", "138px");
    }

    void setupAppMenu({
      onOpenFolder: folder.handleOpenFolder,
      onExportPdf: () => invoke("print_webview"),
      onCheckForUpdates: () => checkForAppUpdates(false),
      onCloseTab: () => {
        const activeTab = tabStore().activeTabId();
        if (activeTab) handleCloseTab(activeTab);
      },
      onEditorMode: (m) => state.setEditorMode(m),
      onToggleSidebar: () => state.setSidebarVisible((v) => !v),
      onToggleToc: () => state.setTocVisible((v) => !v),
      onThemeChange: (mode) => state.handleThemeChange(mode),
      onFind: () => state.triggerPreviewFind(),
    }).catch((e) => console.error("Failed to set up app menu:", e));

    // No system tray in dev — keeps the dev instance from cluttering the menu
    // bar / colliding with a running prod build (which owns the real tray).
    if (!import.meta.env.DEV) {
      void setupTray({
        onOpenFolder: folder.handleOpenFolder,
      }).catch((e) => console.error("Failed to set up tray:", e));
    }

    // Close-to-tray: clicking the window X hides instead of quitting
    // by default. The user can flip the `closeBehavior` preference to
    // `"quit"` via the toolbar to make X / Cmd+W actually terminate.
    // Cmd+Q always quits regardless (delivered by macOS as a
    // process-exit, never reaches `onCloseRequested`).
    //
    // `decideCloseAction` is the pure form of this decision so the
    // rule can be unit-tested without a Tauri runtime.
    const win = getCurrentWindow();
    void win.onCloseRequested(async (event) => {
      // Dev has no tray to restore a hidden window, so X always quits cleanly
      // instead of hiding-to-tray (which would trap the dev window).
      const action = import.meta.env.DEV
        ? "exit"
        : decideCloseAction({
            closeBehavior: state.closeBehavior(),
            isUpdating:
              (window as unknown as { __asciimark_updating?: boolean }).__asciimark_updating ??
              false,
          });
      if (action === "let-close") {
        // Updater bypass: relaunch() handles the actual exit of
        // the old process; we just let the close proceed.
        return;
      }
      if (action === "exit") {
        // User picked "Quit app". Tauri's default close-window
        // flow on macOS only destroys the WINDOW — the process
        // keeps running with no UI. Call exit explicitly so the
        // gesture matches the user's intent on every platform.
        await exit(0);
        return;
      }
      // action === "hide": pre-DJA-50 default.
      event.preventDefault();
      await win.hide();
      await invoke("set_dock_visible", { visible: false });
    });
  });

  // ── File open via OS file associations ──────────────────────────────────
  // Handles both cold start (argv) and already-running (single-instance event).
  async function openFileByAbsolutePath(absolutePath: string): Promise<void> {
    // Extract the directory (root) and filename from the absolute path
    const normalized = absolutePath.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash < 0) return;
    const dirPath = normalized.slice(0, lastSlash);
    const fileName = normalized.slice(lastSlash + 1);

    if (!isSupportedFile(fileName)) return;

    // Open the parent directory as a workspace root
    const opened = await folder.openFolderPath(dirPath);
    if (!opened) return;

    // Find the file in the tree and load it (via tab system)
    const entry = state.findEntryByPath(fileName, dirPath);
    if (entry) {
      await handleLoadFileWithTab(entry, dirPath);
    }
  }

  // Cold start: check if the app was launched with a file argument
  onMount(() => {
    void invoke<string[]>("get_startup_args").then((args) => {
      const filePath = args.find((a) => !a.startsWith("-") && isSupportedFile(a));
      if (filePath) void openFileByAbsolutePath(filePath);
    }).catch(() => {
      // No args or command not available
    });
  });

  // Already running: single-instance plugin forwards file path via event
  onMount(() => {
    const unlisten = listen<string>("open-file", (event) => {
      if (event.payload) void openFileByAbsolutePath(event.payload);
    });
    onCleanup(() => { void unlisten.then((fn) => fn()); });
  });

  // Hydrate the About dialog's version string. Pulled from
  // @tauri-apps/api/app at runtime instead of bundling at build time so
  // we don't have to rebuild the frontend just to update the displayed
  // version on a hot-reloaded dev session.
  onMount(() => {
    void getVersion().then(setAppVersion).catch(() => {});
  });

  // Opens the Release Notes dialog with the recent release history,
  // fetching the list from GitHub the first time (cache hit afterwards).
  // The error fallback inside the dialog surfaces the message and the
  // "Open on GitHub" button remains available either way.
  async function openReleaseNotes(): Promise<void> {
    const currentVersion = appVersion() || (await getVersion().catch(() => ""));
    setReleaseNotesState({
      open: true,
      currentVersion,
      entries: null,
      loading: true,
      error: null,
    });
    try {
      const entries = await fetchReleaseHistory();
      setReleaseNotesState({
        open: true,
        currentVersion,
        entries,
        loading: false,
        error: null,
      });
    } catch (e) {
      setReleaseNotesState({
        open: true,
        currentVersion,
        entries: null,
        loading: false,
        error: (e as Error)?.message ?? String(e),
      });
    }
  }

  // In production, block the native WebView context menu (Reload / Inspect
  // Element). Kobalte's ContextMenu triggers call preventDefault() before this
  // listener fires, so custom menus (file tree, etc.) keep working.
  onMount(() => {
    if (!import.meta.env.PROD) return;
    const handler = (e: Event) => { if (!e.defaultPrevented) e.preventDefault(); };
    document.addEventListener("contextmenu", handler);
    onCleanup(() => document.removeEventListener("contextmenu", handler));
  });

  // Check for app updates a few seconds after boot — silent so any network
  // hiccup or "you're up to date" doesn't interrupt the user. The manual
  // menu item still surfaces feedback.
  onMount(() => {
    const updateTimer = window.setTimeout(() => {
      void checkForAppUpdates(true);
    }, 3000);
    onCleanup(() => window.clearTimeout(updateTimer));
  });

  async function handleWindowDragStart() {
    await getCurrentWindow().startDragging();
  }

  async function handleWindowTitleDoubleClick() {
    await invoke("toggle_maximize_instant");
  }

  async function handleOpenRecentFolder(path: string) {
    const opened = await folder.openFolderPath(path);
    if (!opened) {
      state.handleRemoveRecentFolder(path);
    }
  }

  /**
   * Resolve a relative `<img>` src from the current document into a Tauri
   * asset URL the webview can load. Returns `null` for already-absolute URLs
   * (http(s)://, data:, file:) so they pass through untouched.
   */
  function resolveImageSrc(src: string): string | null {
    // Already-absolute URL: leave it alone
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;

    const file = state.selectedFile();
    const rootId = state.selectedRootId();
    if (!file || !rootId) return null;
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) return null;

    // Resolve `src` against the current file's directory.
    // Workspace-rooted absolute (`/foo/bar.png`) is treated as relative to
    // the workspace root.
    const fileDir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";

    let relativeFromRoot: string;
    if (src.startsWith("/")) {
      relativeFromRoot = src.slice(1);
    } else {
      const parts = fileDir ? fileDir.split("/") : [];
      for (const part of src.split("/")) {
        if (part === "..") parts.pop();
        else if (part !== "" && part !== ".") parts.push(part);
      }
      relativeFromRoot = parts.join("/");
    }

    const absolutePath = `${rootPath}/${relativeFromRoot}`;
    return convertFileSrc(absolutePath);
  }

  /**
   * Resolve a workspace-relative file path into a Tauri asset URL for the
   * builtin media viewer (images/PDF). Unlike `resolveImageSrc`, the path is
   * already workspace-relative (it's the selected file's own path), so no
   * directory walking is needed — just join it onto the root.
   */
  function resolveFileSrc(rootId: string, relativePath: string): string | null {
    const rootPath = rootPaths().get(rootId);
    if (!rootPath) return null;
    return convertFileSrc(`${rootPath}/${relativePath}`);
  }

  // Folder-rooted HTML preview host: registers the previewed file's directory
  // with the Rust `asciimark-preview://` scheme (isolated origin → real SPA
  // rendering) and pushes the live editor buffer as an overlay. See
  // src-tauri/src/html_preview.rs for the isolation model.
  const htmlPreviewHost = {
    // WebView2 can't navigate bare custom schemes — on Windows Tauri serves
    // them as http://<scheme>.localhost, a FIXED host that can't carry the
    // token (it rides the `am-token` query instead). On macOS/Linux the
    // token IS the host. Either way the doc loads at path `/` so SPA path
    // routers match their root route.
    docOrigin: (token: string) =>
      navigator.platform.startsWith("Win")
        ? "http://asciimark-preview.localhost"
        : `asciimark-preview://${token}`,
    async register(rootId: string, fileRelPath: string) {
      const rootPath = rootPaths().get(rootId);
      if (!rootPath) return null;
      const full = `${rootPath}/${fileRelPath}`;
      const slash = full.lastIndexOf("/");
      const dir = slash >= 0 ? full.slice(0, slash) : full;
      const entryRel = slash >= 0 ? full.slice(slash + 1) : full;
      try {
        const token = await invoke<string>("html_preview_register", { dir });
        return { token, entryRel };
      } catch {
        return null;
      }
    },
    setOverlay: (token: string, relPath: string, content: string) =>
      invoke("html_preview_set_overlay", { token, relPath, content }) as Promise<void>,
    clearOverlay: (token: string) =>
      invoke("html_preview_clear_overlay", { token }) as Promise<void>,
  };

  // Live host handles for mounted Excalidraw frames, keyed by absolute file path
  // (so ⌘I / the AI write tool act on the ACTIVE pane's diagram even with split
  // panes). Registered/cleared by each <ExcalidrawFrame> via onFrameApi.
  const excalidrawFrames = new Map<string, ExcalidrawFrameApi>();
  function registerExcalidrawFrame(filePath: string, api: ExcalidrawFrameApi | null): void {
    if (api) excalidrawFrames.set(filePath, api);
    else excalidrawFrames.delete(filePath);
  }

  /** Absolute path of the `.excalidraw` shown in the ACTIVE pane, or null when
   *  the active view isn't a `.excalidraw`. */
  function activeExcalidrawAbsPath(): string | null {
    const pane = state.paneManager.activePane();
    const file = pane.selectedFile();
    const rootId = pane.selectedRootId();
    if (!file || fileKind(file.name) !== "excalidraw" || !rootId) return null;
    return `${rootPaths().get(rootId) ?? ""}/${file.path}`;
  }

  /** The host handle for the Excalidraw shown in the ACTIVE pane, or null when
   *  the active view isn't a `.excalidraw` (used by ⌘I and the AI write tool). */
  function activeExcalidrawFrame(): ExcalidrawFrameApi | null {
    const abs = activeExcalidrawAbsPath();
    return abs ? (excalidrawFrames.get(abs) ?? null) : null;
  }

  /** Poll the frame registry until the guest editor for `absPath` is mounted
   *  AND answering (registration happens on mount, BEFORE the iframe handshake
   *  — `getScene()` returning a scene is the actual "canvas ready" signal), or
   *  `timeoutMs` elapses. Resolves null on timeout. */
  async function waitForExcalidrawFrame(
    absPath: string,
    timeoutMs = 8000,
  ): Promise<ExcalidrawFrameApi | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const api = excalidrawFrames.get(absPath);
      if (api && (await api.getScene()) !== null) return api;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
  }

  // ⌘I over an open `.excalidraw`: attach the current diagram selection to the
  // chat as a context chip. Returns false (→ caller falls back to the editor
  // text selection) when the active view isn't an Excalidraw with a selection.
  async function addExcalidrawSelectionToChat(): Promise<boolean> {
    const api = activeExcalidrawFrame();
    if (!api) return false;
    const file = state.paneManager.activePane().selectedFile();
    if (!file) return false;
    const item = excalidrawSelectionToContext(await api.getScene(), file);
    if (!item) return false;
    // Diagram text elements can carry pasted keys — scrub like any other chip.
    state.addAiContext({ ...item, content: scrubAi(item.content) });
    // Inline composer token: the chip label ("name · N el") reads poorly as a
    // token, so the reference uses the short "<file>:sel" form instead.
    state.requestAiInlineReference(
      item.id,
      dedupeTokenLabel(`${file.name}:sel`, state.aiContextItems()),
    );
    return true;
  }

  /** Render a Mermaid diagram into an Excalidraw file (the AI write tool).
   *  No target (or the target IS the active diagram) → draw on the active
   *  frame, as before. Any other target is created on disk when missing,
   *  opened through the file tree's own load path (handleLoadFileWithTab, so
   *  panes/tabs behave normally), and drawn on once its guest frame is ready.
   *  Always returns a structured result the model can read — never throws. */
  async function applyExcalidrawMermaid(
    input: ExcalidrawMermaidRequest,
  ): Promise<ExcalidrawMermaidOutcome> {
    const write: ExcalidrawWriteInput = { mermaid: input.mermaid, mode: input.mode };
    const fail = (
      error: string,
      file?: ExcalidrawTargetFileOutcome,
    ): ExcalidrawMermaidOutcome => ({
      ok: false,
      mode: input.mode,
      added: 0,
      removed: 0,
      error,
      ...(file ? { file } : {}),
    });
    const target = input.target;
    if (!target) {
      const api = activeExcalidrawFrame();
      if (!api) {
        return fail(
          "No Excalidraw diagram is open. Pass `path` to target a workspace file directly, " +
            "or ask the user to open a .excalidraw file first.",
        );
      }
      return api.applyMermaid(write);
    }
    // rootPaths keys equal the absolute root paths (openFolderPath sets the
    // map up that way), so the resolved root doubles as the rootId the
    // tree/loader APIs expect.
    const rootId = target.root;
    let created = false;
    let opened = false;
    if (activeExcalidrawAbsPath() !== target.absPath) {
      if ((await readFileByPath(target.root, target.rel)) === null) {
        try {
          // Host-authored skeleton through the normal fs primitives:
          // create_file validates the path and makes parent dirs; the content
          // carries no model text, so no scrub/restore round-trip applies.
          await createFile(target.root, target.rel);
          await writeFile(target.absPath, EMPTY_EXCALIDRAW_SCENE);
        } catch (e) {
          return fail(
            `Could not create ${target.rel}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        created = true;
      }
      let entry = state.findEntryByPath(target.rel, rootId);
      if (!entry) {
        // A just-created (or externally created) file may not be in the tree
        // yet — refresh the root before giving up.
        await folder.refreshRoot(rootId);
        entry = state.findEntryByPath(target.rel, rootId);
      }
      if (!entry || entry.kind !== "file") {
        return fail(
          `Could not open ${target.rel}: the file is not visible in the workspace tree.`,
          { created, opened, path: target.absPath },
        );
      }
      await handleLoadFileWithTab(entry, rootId);
      opened = true;
    }
    const api = await waitForExcalidrawFrame(target.absPath);
    if (!api) {
      const did = created ? "was created and opened" : opened ? "was opened" : "is already open";
      return fail(
        `The file ${did}, but its Excalidraw canvas did not become ready in time. ` +
          "The user can retry the same call.",
        { created, opened, path: target.absPath },
      );
    }
    const result = await api.applyMermaid(write);
    // Target was already the active diagram and nothing was created/opened:
    // exactly today's payload.
    if (!created && !opened) return result;
    return { ...result, file: { created, opened, path: target.absPath } };
  }

  async function handleOpenRecentFile(recentFile: RecentFile) {
    const opened = await folder.openFolderPath(recentFile.rootPath);
    if (!opened) {
      state.handleRemoveRecentFile(recentFile.path, recentFile.rootPath);
      state.handleRemoveRecentFolder(recentFile.rootPath);
      return;
    }

    const entry = state.findEntryByPath(recentFile.path, recentFile.rootPath);
    if (!entry || entry.kind !== "file") {
      state.handleRemoveRecentFile(recentFile.path, recentFile.rootPath);
      return;
    }

    state.pushRecentFile({
      entry,
      rootName: state.rootName(),
      rootPath: recentFile.rootPath,
    });
    await handleLoadFileWithTab(entry, recentFile.rootPath);
  }

  // ── Workspace indices (backlinks + symbols) ───────────────────────
  // Rebuild together whenever the roots tree changes (folder open,
  // refresh, watcher tick that re-reads dirs). Reads each indexed
  // `.md`/`.adoc` from disk once and feeds the same content into
  // both index builders — re-reading per index would double the
  // I/O for every workspace event.
  const [workspaceSymbols, setWorkspaceSymbols] = createSignal<readonly WorkspaceSymbol[]>([]);
  let workspaceBuildToken = 0;
  createEffect(() => {
    const roots = state.rootsList();
    const paths = rootPaths();
    if (roots.length === 0 || paths.size === 0) {
      state.setBacklinkIndex(new Map());
      setWorkspaceSymbols([]);
      return;
    }
    const token = ++workspaceBuildToken;
    void (async () => {
      const indexed = flattenWorkspace(roots).filter((f) => isSupportedFile(f.path));
      const filesForBacklinks: { path: string; content: string }[] = [];
      const filesForSymbols: {
        rootId: string;
        rootName: string;
        path: string;
        content: string;
      }[] = [];
      for (const file of indexed) {
        const root = paths.get(file.rootId);
        if (!root) continue;
        try {
          const content = await readFileContent(`${root}/${file.path}`);
          filesForBacklinks.push({ path: file.path, content });
          filesForSymbols.push({
            rootId: file.rootId,
            rootName: file.rootName,
            path: file.path,
            content,
          });
        } catch {
          // Permission / deleted between scan and read — skip silently.
        }
      }
      if (token !== workspaceBuildToken) return; // newer build started
      state.setBacklinkIndex(buildBacklinkIndex(filesForBacklinks));
      setWorkspaceSymbols(buildWorkspaceSymbols(filesForSymbols));
    })();
  });

  // ── Tab session restore ──────────────────────────────────────────────────
  // Restore tabs when roots become available after startup.
  let sessionRestored = false;

  createEffect(() => {
    // React to rootPaths changing (roots being opened)
    const paths = rootPaths();
    if (paths.size === 0 || sessionRestored) return;

    const session = tabStore().getPersistedSession();
    if (!session || session.tabs.length === 0) {
      sessionRestored = true;
      return;
    }

    // Try to restore tabs whose roots are now available
    const restorable = session.tabs.filter((t) => paths.has(t.rootId));
    if (restorable.length === 0) return;

    sessionRestored = true;

    // Restore all tabs synchronously (no file loading), mark as needsLoad.
    // Only the active tab gets its content loaded immediately.
    let activeEntry: import("@asciimark/core/types.ts").FSEntry | null = null;
    let activeRootId: string | null = null;

    for (const persisted of restorable) {
      const entry = state.findEntryByPath(persisted.filePath, persisted.rootId);
      if (!entry || entry.kind !== "file") continue;

      const isActive = persisted.id === session.activeTabId;
      tabStore().openTab(entry, persisted.rootId, { background: true });

      // Mark all restored tabs as needing content load
      const tabId = tabStore().tabs().find((t) => t.filePath === persisted.filePath && t.rootId === persisted.rootId)?.id;
      if (tabId) tabStore().markTabNeedsLoad(tabId);

      if (isActive) {
        activeEntry = entry;
        activeRootId = persisted.rootId;
      }
    }

    // Load only the active tab
    if (activeEntry && activeRootId) {
      void (async () => {
        await loader.loadFileContent(activeEntry!, false, false, activeRootId!);
        tabStore().updateActiveTabContent({
          editorContent: state.editorContent(),
          savedContent: state.savedContent(),
          html: state.html(),
          frontmatter: state.frontmatter(),
        });
        // Activate after content is loaded
        const tabId = tabStore().tabs().find((t) => t.filePath === activeEntry!.path && t.rootId === activeRootId)?.id;
        if (tabId) handleActivateTab(tabId);
      })();
    } else if (tabStore().tabs().length > 0) {
      // No active tab from session — activate the first
      void handleActivateTab(tabStore().tabs()[0]!.id);
    }
  });

  // Snapshot active tab before app hides (close-to-tray)
  onMount(() => {
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged((focused) => {
      if (!focused.payload) {
        tabStore().snapshotActiveTab();
        tabStore().persistSession();
      }
    });
    onCleanup(() => { void unlisten.then((fn) => fn()); });
  });

  // ── Tab handlers ────────────────────────────────────────────────────────

  /** Single click: load file in the active tab (replacing its content). */
  async function handleLoadFileWithTab(entry: import("@asciimark/core/types.ts").FSEntry, rootId: string) {
    tabStore().loadInActiveTab(entry, rootId);
    await loader.loadFileContent(entry, true, false, rootId);
    tabStore().updateActiveTabContent({
      editorContent: state.editorContent(),
      savedContent: state.savedContent(),
      html: state.html(),
      frontmatter: state.frontmatter(),
    });
  }

  /** Inline create commit from the file tree. Creates the file/folder on disk
   *  (the folder handlers refresh the root), then opens a freshly created file. */
  async function handleCreate(
    parentRel: string,
    name: string,
    kind: "file" | "folder",
    rootId: string,
  ) {
    try {
      if (kind === "file") {
        const relative = await folder.handleCreateFile(parentRel, name, rootId);
        const entry = state.findEntryByPath(relative, rootId);
        if (entry && entry.kind === "file") {
          await handleLoadFileWithTab(entry, rootId);
        }
      } else {
        await folder.handleCreateFolder(parentRel, name, rootId);
      }
    } catch (e) {
      console.error("Create failed:", e);
    }
  }

  /** Start an inline create: resolve the target dir from the current
   *  selection (folder → inside it; file → its sibling dir; nothing → the
   *  active root) and open the inline input via `creatingAt`. */
  function startInlineCreate(kind: "file" | "folder") {
    const rootId = state.selectedRootId();
    if (!rootId) return;
    const sel = state.selectedFile();
    let parentPath = "";
    if (sel) {
      parentPath = sel.kind === "directory"
        ? sel.path
        : sel.path.includes("/")
          ? sel.path.slice(0, sel.path.lastIndexOf("/"))
          : "";
    }
    state.setCreatingAt({ parentPath, rootId, kind });
  }

  /** Open in New Tab / middle-click / file-tree double-click. The
   *  resulting tab is **pinned** — these are the explicit "I want
   *  this around" gestures. If the file is already open in this
   *  pane, activate + pin in place rather than duplicating (VSCode
   *  semantics). */
  async function handleOpenInNewTab(entry: import("@asciimark/core/types.ts").FSEntry, rootId: string) {
    const store = tabStore();
    const existing = store.findTabByFile(entry.path, rootId);
    if (existing) {
      store.activateTab(existing.id);
      store.pinTab(existing.id);
      await loader.loadFileContent(entry, true, false, rootId);
      return;
    }
    store.openTab(entry, rootId);
    await loader.loadFileContent(entry, true, false, rootId);
    store.updateActiveTabContent({
      editorContent: state.editorContent(),
      savedContent: state.savedContent(),
      html: state.html(),
      frontmatter: state.frontmatter(),
    });
  }

  /** Build a folder @-mention's content from the in-memory workspace tree:
   *  every descendant file as a workspace-relative forward-slash path (capped
   *  so a huge folder can't blow the prompt budget), plus a hint pointing the
   *  model at `app__read_file`. `path: ""` lists the whole root. Returns null
   *  when the root/subtree is gone (stale entry). */
  function buildFolderListing(rootId: string, path: string, label: string): string | null {
    const FOLDER_MENTION_CAP = 200;
    type Entry = import("@asciimark/core/types.ts").FSEntry;
    const collect = (entries: Entry[], out: string[]): void => {
      for (const entry of entries) {
        if (entry.kind === "file") out.push(entry.path);
        else if (entry.children) collect(entry.children, out);
      }
    };
    const findSubtree = (entries: Entry[], target: string): Entry[] | null => {
      for (const entry of entries) {
        if (entry.kind !== "directory") continue;
        if (entry.path === target) return entry.children ?? [];
        // The trailing "/" guards sibling prefix collisions ("src" vs "src-old").
        if (target.startsWith(`${entry.path}/`)) {
          return entry.children ? findSubtree(entry.children, target) : null;
        }
      }
      return null;
    };
    const root = state.rootsList().find((r) => r.id === rootId);
    if (!root) return null;
    const subtree = path === "" ? root.entries : findSubtree(root.entries, path);
    if (!subtree) return null;
    const paths: string[] = [];
    collect(subtree, paths);
    const lines = paths.slice(0, FOLDER_MENTION_CAP).map((p) => `- ${p}`);
    if (paths.length > FOLDER_MENTION_CAP) lines.push(`- (+${paths.length - FOLDER_MENTION_CAP} more)`);
    if (lines.length === 0) lines.push("- (no files)");
    return `Folder listing of ${label}:\n${lines.join("\n")}\n\nUse app__read_file with one of these paths to read a specific file.`;
  }

  /** Read a mentioned PDF for the chat context. PDFs aren't UTF-8 text, so
   *  instead of `readFileContent` the bytes come through the Tauri asset
   *  protocol (`convertFileSrc` + fetch — the assetProtocol scope covers the
   *  workspace) and run through `extractPdfText` (page-capped, `[page N]`
   *  markers). Failures — encrypted, malformed, scanned-image-only documents
   *  — yield an explanatory note so the chip is never silently empty. */
  async function buildPdfMentionContent(absolutePath: string, label: string): Promise<string> {
    try {
      const response = await fetch(convertFileSrc(absolutePath));
      if (!response.ok) throw new Error(`asset fetch failed (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = await extractPdfText(bytes);
      // Ignore the structural `[page N]` / `[truncated: …]` markers; if no
      // real text remains, the PDF is scanned images or empty — say so
      // instead of attaching a blob of bare markers.
      const hasText = text.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed !== "" && !/^\[(?:page \d+|truncated: .*)\]$/.test(trimmed);
      });
      if (!hasText) {
        return `PDF text of ${label}:\n(no extractable text — the PDF may be scanned images or empty)`;
      }
      return `PDF text of ${label}:\n${text}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `PDF text of ${label}:\n(could not extract text: ${reason} — the PDF may be encrypted or corrupted)`;
    }
  }

  /** Resolve a file or folder as a chat context chip (file-tree "Add to
   *  chat" / @-mention). Files carry their text (PDFs via pdf.js text
   *  extraction); `kind: "dir"` entries carry a subtree listing so the model
   *  can pick files to read. Either way the reference registers through the
   *  same `state.addFileMention` chip path (deduped by id; the chip's ×
   *  removes it). */
  async function addFileMention(
    file: { kind?: "dir" | "file"; label: string; path: string; rootId: string },
  ) {
    if (file.kind === "dir") {
      const content = buildFolderListing(file.rootId, file.path, file.label);
      if (content === null) return;
      state.addFileMention({ content, kind: "folder", label: file.label, path: file.path, rootId: file.rootId });
      return;
    }
    const rootPath = rootPaths().get(file.rootId);
    if (!rootPath) return;
    // PDFs aren't readable as UTF-8 — route them through pdf.js extraction.
    // Chip content goes straight into the prompt, so scrub it here (folder
    // listings above are names only and stay unscrubbed).
    if (file.path.toLowerCase().endsWith(".pdf")) {
      const content = scrubAi(await buildPdfMentionContent(`${rootPath}/${file.path}`, file.label));
      state.addFileMention({ content, label: file.label, path: file.path, rootId: file.rootId });
      return;
    }
    try {
      const content = scrubAi(await readFileContent(`${rootPath}/${file.path}`));
      state.addFileMention({ content, label: file.label, path: file.path, rootId: file.rootId });
    } catch {
      // Unreadable (binary / deleted) — silently skip.
    }
  }

  /** Attach the current editor selection to the chat as a context chip. Returns
   *  true when a non-empty selection was added (so ⌘L can decide whether to
   *  also front the chat). The chip-building lives in AppState so the selection
   *  popover reuses it. */
  function addSelectionToChat(): boolean {
    const pane = state.paneManager.activePane() as { editorApi?: EditorApi };
    const sel = pane.editorApi?.getSelection();
    if (!sel || !sel.text.trim()) return false;
    state.addSelectionToContext({ ...sel, text: scrubAi(sel.text) });
    return true;
  }

  /** ⌘I fallback for the rendered preview: attach a non-collapsed DOM
   *  selection anchored inside `.doc-body` to the chat as a snippet-labelled
   *  chip. Returns false when no such selection exists (sandboxed `.html`
   *  previews live in an iframe, so their selections never match here). */
  function addPreviewSelectionToChat(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const anchor = sel.anchorNode;
    const anchorEl = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
    if (!anchorEl?.closest(".doc-body")) return false;
    const text = sel.toString();
    if (!text.trim()) return false;
    state.addPreviewSelectionToContext(scrubAi(text));
    return true;
  }

  // Quick Open (Cmd/Ctrl+P) — recents set keyed by `${rootId}::${path}` so
  // the fuzzy ranker can boost recently-opened files. In desktop the rootId
  // equals the absolute root path (set by `folder.openFolderPath`), so the
  // keys map 1:1 with `RecentFile.{rootPath, path}`.
  const quickOpenRecents = createMemo<ReadonlySet<string>>(() => {
    recentFilesVersion(); // bump key forces re-read after a Quick Open pick
    return new Set(getRecentFiles().map((f) => `${f.rootPath}::${f.path}`));
  });

  /**
   * Move a tab from `fromPaneIndex` to the other pane. Opens the file
   * in the destination pane (creates the pane via `splitFromActive`
   * when there's only one) and closes the original. Same `editorMode`
   * is preserved so a split-side preview stays a preview.
   *
   * Mutation-survival contracts (locked in by the host-level domain
   * test in app.test.ts):
   *   - skipping `closeTab` on the origin → tab is duplicated.
   *   - skipping the `openTab` on the target → tab vanishes.
   *   - reading `fromPaneIndex` from the wrong end → tab moved from
   *     wrong pane.
   */
  function handleMoveTab(tabId: string, fromPaneIndex: number) {
    const panes = state.paneManager.panes();
    const sourcePane = panes[fromPaneIndex];
    if (!sourcePane) return;
    const tab = sourcePane.tabs.getTab(tabId);
    if (!tab) return;

    if (panes.length < 2) {
      state.paneManager.splitFromActive();
    }
    const updatedPanes = state.paneManager.panes();
    const targetIndex = fromPaneIndex === 0 ? 1 : 0;
    const targetPane = updatedPanes[targetIndex];
    if (!targetPane) return;

    const entry = state.findEntryByPath(tab.filePath, tab.rootId);
    if (!entry || entry.kind !== "file") return;

    // The TabState carries everything the editor/preview need to
    // render the moved file without reloading from disk. Snapshot
    // off the source tab itself (NOT the source pane's live signals
    // — those reflect whichever tab is currently active in the
    // source pane, which may not be the one being moved).
    const snapshot = {
      editorContent: tab.editorContent,
      savedContent: tab.savedContent,
      html: tab.html,
      frontmatter: tab.frontmatter,
      editorMode: tab.editorMode,
    };

    // Activate the target pane BEFORE writing through the AppState
    // proxy, so `state.setHtml` etc. land in the target pane's
    // signals. Without this, the proxy still points at the source
    // pane and the moved file would render in the wrong column.
    state.paneManager.setActivePane(targetIndex);

    // Open the file in the target pane's tab list. `openTab` (non-
    // background) sets the new tab active inside the target pane.
    targetPane.tabs.openTab(entry, tab.rootId);

    // Push the source's content into the new tab's TabState so
    // future tab-switches inside the target pane snapshot/restore
    // the correct content (otherwise the new tab is empty until the
    // user reloads from disk and tab-switches show stale content).
    targetPane.tabs.updateActiveTabContent({
      editorContent: snapshot.editorContent,
      savedContent: snapshot.savedContent,
      html: snapshot.html,
      frontmatter: snapshot.frontmatter,
    });

    // Mirror the snapshot through the AppState proxy so the editor
    // and preview update immediately for the user — restoreActiveTab
    // already runs inside `openTab` but reads from the freshly-empty
    // TabState (we hadn't written the content yet at that point).
    state.setEditorContent(snapshot.editorContent);
    state.setSavedContent(snapshot.savedContent);
    state.setHtml(snapshot.html);
    state.setFrontmatter(snapshot.frontmatter);
    state.setEditorMode(snapshot.editorMode);
    state.setSelectedFile(entry);
    state.setSelectedRootId(tab.rootId);

    // Finally remove the tab from the source pane. closeTab handles
    // the case where this was the last tab (clears source signals)
    // or activates a sibling (restores its content into source).
    sourcePane.tabs.closeTab(tabId);
  }

  async function handleQuickOpenSelect(file: IndexedFile) {
    setQuickOpenVisible(false);
    const entry = state.findEntryByPath(file.path, file.rootId);
    if (!entry || entry.kind !== "file") return;

    state.pushRecentFile({
      entry,
      rootName: file.rootName,
      rootPath: file.rootId,
    });
    setRecentFilesVersion((v) => v + 1);
    await handleOpenInNewTab(entry, file.rootId);
  }

  // Command palette catalog. Built reactively so `when()` predicates can
  // see live signals (hasFile, hasRoot, …). Each command's `run` calls
  // straight into the host's existing handlers — no new logic, just
  // surfacing what's already wired into the toolbar dropdown.
  const commandCatalog = createMemo<Command[]>(() => {
    // Track the locale signal so the memo recomputes — and the palette
    // re-renders — whenever the user switches language.
    useLocale();
    const hasRoot = rootPaths().size > 0;
    const hasFile = !!state.selectedFile();
    return [
      {
        id: "file.openFolder",
        group: "File",
        title: m.command_open_folder(),
        shortcut: { mac: ["⌘", "O"], other: ["Ctrl", "O"] },
        run: () => folder.handleOpenFolder(),
      },
      {
        id: "file.newFile",
        group: "File",
        title: m.command_new_file(),
        shortcut: { mac: ["⌘", "N"], other: ["Ctrl", "N"] },
        when: () => hasRoot,
        run: () => startInlineCreate("file"),
      },
      {
        id: "file.newFolder",
        group: "File",
        title: m.command_new_folder(),
        shortcut: { mac: ["⌘", "⇧", "N"], other: ["Ctrl", "Shift", "N"] },
        when: () => hasRoot,
        run: () => startInlineCreate("folder"),
      },
      {
        id: "file.exportPdf",
        group: "File",
        title: m.command_export_pdf(),
        when: () => hasFile,
        run: () => state.handleExportPdf(),
      },
      {
        id: "view.toggleSidebar",
        group: "View",
        title: m.command_toggle_sidebar(),
        when: () => hasRoot,
        run: () => {
          state.setSidebarVisible((v) => !v);
        },
      },
      {
        id: "view.toggleHidden",
        group: "View",
        title: m.command_toggle_hidden_files(),
        when: () => hasRoot,
        run: () => {
          state.setShowHiddenEntries((v) => !v);
          void folder.refreshAllRoots();
        },
      },
      {
        id: "view.editorMode.edit",
        group: "View",
        title: m.command_editor_mode_edit(),
        when: () => hasFile && state.canEdit(),
        run: () => {
          state.setEditorMode("edit");
        },
      },
      {
        id: "view.editorMode.split",
        group: "View",
        title: m.command_editor_mode_split(),
        when: () => hasFile && state.canEdit() && state.canPreview(),
        run: () => {
          state.setEditorMode("split");
        },
      },
      {
        id: "view.editorMode.preview",
        group: "View",
        title: m.command_editor_mode_preview(),
        when: () => hasFile && state.canPreview(),
        run: () => {
          state.setEditorMode("preview");
        },
      },
      {
        id: "theme.system",
        group: "Theme",
        title: m.command_theme_system(),
        run: () => {
          state.setThemeMode("system");
        },
      },
      {
        id: "theme.light",
        group: "Theme",
        title: m.command_theme_light(),
        run: () => {
          state.setThemeMode("light");
        },
      },
      {
        id: "theme.dark",
        group: "Theme",
        title: m.command_theme_dark(),
        run: () => {
          state.setThemeMode("dark");
        },
      },
      {
        id: "workspace.refresh",
        group: "Workspace",
        title: "Refresh Workspace",
        when: () => hasRoot,
        run: () => {
          void folder.refreshAllRoots();
        },
      },
      {
        id: "nav.goToSymbol",
        group: "Workspace",
        title: "Go to Symbol in File…",
        shortcut: { mac: ["⌘", "⇧", "O"], other: ["Ctrl", "Shift", "O"] },
        when: () => hasFile,
        run: () => {
          setSymbolPaletteVisible(true);
        },
      },
      {
        id: "nav.findInFiles",
        group: "Workspace",
        title: "Find in Files…",
        shortcut: { mac: ["⌘", "⇧", "F"], other: ["Ctrl", "Shift", "F"] },
        when: () => hasRoot,
        run: () => {
          setFindInFilesVisible(true);
        },
      },
      {
        id: "view.splitEditor",
        group: "View",
        title: m.command_split_editor(),
        shortcut: { mac: ["⌘", "\\"], other: ["Ctrl", "\\"] },
        when: () => hasRoot && state.paneManager.panes().length < 2,
        run: () => {
          state.paneManager.splitFromActive();
        },
      },
      {
        id: "view.focusFirstPane",
        group: "View",
        title: m.command_focus_first_pane(),
        shortcut: { mac: ["⌘", "1"], other: ["Ctrl", "1"] },
        when: () => state.paneManager.panes().length > 1,
        run: () => {
          state.paneManager.setActivePane(0);
        },
      },
      {
        id: "view.focusSecondPane",
        group: "View",
        title: m.command_focus_second_pane(),
        shortcut: { mac: ["⌘", "2"], other: ["Ctrl", "2"] },
        when: () => state.paneManager.panes().length > 1,
        run: () => {
          state.paneManager.setActivePane(1);
        },
      },
      {
        id: "help.shortcuts",
        group: "Help",
        title: m.command_show_keyboard_shortcuts(),
        shortcut: { mac: ["⌘", "/"], other: ["Ctrl", "/"] },
        run: () => {
          setShortcutsHelpVisible(true);
        },
      },
      {
        id: "help.checkForUpdates",
        group: "Help",
        title: m.command_check_for_updates(),
        run: () => checkForAppUpdates(false),
      },
      {
        id: "help.releaseNotes",
        group: "Help",
        title: m.command_release_notes(),
        run: () => { void openReleaseNotes(); },
      },
      {
        id: "help.about",
        group: "Help",
        title: m.command_about(),
        run: () => { setAboutOpen(true); },
      },
      {
        id: "help.settings",
        group: "Help",
        title: m.command_settings(),
        shortcut: { mac: ["⌘", ","], other: ["Ctrl", ","] },
        run: () => { setSettingsOpen(true); },
      },
      {
        id: "view.toggleReaderMode",
        group: "View",
        title: m.command_toggle_reader_mode(),
        shortcut: { mac: ["⌘", "."], other: ["Ctrl", "."] },
        run: () => state.setReaderMode((v) => !v),
      },
      {
        id: "navigate.workspaceSymbols",
        group: "Workspace",
        title: m.command_workspace_symbols(),
        shortcut: { mac: ["⌘", "⌥", "O"], other: ["Ctrl", "Alt", "O"] },
        run: () => {
          if (rootPaths().size === 0) return;
          setWorkspaceSymbolPaletteVisible(true);
        },
      },
      // Language switcher — reads from the i18n package's locale list so
      // adding a new locale to `packages/i18n` automatically surfaces it
      // here. Each entry sets the locale via the Solid adapter, which
      // persists to localStorage and forces re-render of all JSX that
      // tracks the locale signal.
      ...i18nLocales.map<Command>((loc) => ({
        id: `language.${loc}`,
        group: "Language",
        title:
          loc === "en"
            ? m.command_language_en()
            : loc === "pt-BR"
              ? m.command_language_pt_br()
              : m.command_language_es(),
        run: () => switchLocale(loc),
      })),
    ];
  });

  /** "+" button: create an empty tab (shows empty state). */
  function handleNewTab() {
    // Snapshot current tab, then clear state for the empty tab
    tabStore().snapshotActiveTab();

    // Create a minimal empty tab
    const emptyEntry: import("@asciimark/core/types.ts").FSEntry = {
      name: "New Tab",
      kind: "file",
      path: "",
    };
    const rootId = state.selectedRootId() ?? "";
    tabStore().openTab(emptyEntry, rootId);

    state.setSelectedFile(null);
    state.setHtml("");
    state.setFrontmatter(null);
    state.setEditorContent("");
    state.setSavedContent("");
    state.setEditorMode("preview");
  }

  async function handleActivateTab(tabId: string) {
    const tab = tabStore().getTab(tabId);
    if (!tab) return;

    isTabSwitching = true;
    clearTimeout(autoSaveTimer);

    tabStore().activateTab(tabId);

    // Set the selected file/root from the tab
    const entry = state.findEntryByPath(tab.filePath, tab.rootId);
    if (entry) {
      state.setSelectedFile(entry);
      state.setSelectedRootId(tab.rootId);
    }

    // If the tab needs content loaded (restored from session or reopened)
    if (tab.needsLoad && entry) {
      await loader.loadFileContent(entry, false, false, tab.rootId);
      tabStore().updateActiveTabContent({
        editorContent: state.editorContent(),
        savedContent: state.savedContent(),
        html: state.html(),
        frontmatter: state.frontmatter(),
      });
    }

    // Re-arm file watcher for the new active tab
    const rootPath = rootPaths().get(tab.rootId);
    if (rootPath && tab.filePath) {
      watcher.setTarget({
        filePath: `${rootPath}/${tab.filePath}`,
        includePaths: tab.includePaths,
        rootPath,
      });
      if (state.autoRefresh()) watcher.start();
    }

    queueMicrotask(() => {
      isTabSwitching = false;
    });
  }

  async function handleCloseTab(tabId: string) {
    const tab = tabStore().getTab(tabId);
    if (!tab) return;

    // For the active tab, check live dirty state; for others, check cached
    const isDirty = tabId === tabStore().activeTabId()
      ? state.isDirty()
      : tab.editorContent !== tab.savedContent;

    if (isDirty) {
      const discard = await confirm({
        title: "Close Tab",
        description: `"${tab.fileName}" has unsaved changes. Discard them?`,
        confirmLabel: "Discard",
      });
      if (!discard) return;
    }

    tabStore().closeTab(tabId);

    // After close, activate the new active tab
    const newActive = tabStore().getActiveTab();
    if (newActive) {
      const entry = state.findEntryByPath(newActive.filePath, newActive.rootId);
      if (entry) {
        state.setSelectedFile(entry);
        state.setSelectedRootId(newActive.rootId);
      }
      const rootPath = rootPaths().get(newActive.rootId);
      if (rootPath) {
        watcher.setTarget({
          filePath: `${rootPath}/${newActive.filePath}`,
          includePaths: newActive.includePaths,
          rootPath,
        });
        if (state.autoRefresh()) watcher.start();
      }
    }
  }

  // Close tabs when a root is closed
  const originalCloseRoot = folder.handleCloseRoot;
  folder.handleCloseRoot = (rootId: string) => {
    tabStore().closeTabsByRoot(rootId);
    originalCloseRoot(rootId);
  };

  // Update tab when a file is renamed
  const originalRename = folder.handleRename;
  folder.handleRename = async (entry, rootId, newName) => {
    const oldPath = entry.path;
    const slash = oldPath.lastIndexOf("/");
    const parentRel = slash >= 0 ? oldPath.slice(0, slash + 1) : "";
    const newPath = parentRel + newName;

    await originalRename(entry, rootId, newName);

    // Update any tabs pointing to the renamed file
    for (const tab of tabStore().tabs()) {
      if (tab.rootId === rootId && tab.filePath === oldPath) {
        tabStore().updateTabFile(tab.id, newPath, newName);
      }
    }
  };

  // Keyboard shortcuts for tabs
  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMac = navigator.platform.startsWith("Mac");
      const platform: "mac" | "other" = isMac ? "mac" : "other";

      // Inline AI-diff review keys are CONTEXTUAL: they take precedence only
      // while a diff is pending (so ⌘N still means "new file" otherwise).
      // ⌘Y keep nearest · ⌘N undo nearest · ⌘↵ keep all.
      {
        const diffApi = activeEditorApi();
        const diffMod = isMac ? e.metaKey : e.ctrlKey;
        if (diffApi?.hasPendingDiffs() && diffMod && !e.shiftKey && !e.altKey) {
          if (e.key === "Enter") {
            e.preventDefault();
            diffApi.keepAllDiffs();
            return;
          }
          if (e.key === "y" || e.key === "Y") {
            e.preventDefault();
            diffApi.keepNearestDiff();
            return;
          }
          if (e.key === "n" || e.key === "N") {
            e.preventDefault();
            diffApi.undoNearestDiff();
            return;
          }
        }
      }

      // Open exactly one overlay at a time. Each shortcut closes the siblings
      // before toggling its own — otherwise two palettes can stack on screen.
      function openOnly(target: "quick" | "command" | "symbol" | "wsymbol" | "find" | "help") {
        if (target !== "quick") setQuickOpenVisible(false);
        if (target !== "command") setCommandPaletteVisible(false);
        if (target !== "symbol") setSymbolPaletteVisible(false);
        if (target !== "wsymbol") setWorkspaceSymbolPaletteVisible(false);
        if (target !== "find") setFindInFilesVisible(false);
        if (target !== "help") setShortcutsHelpVisible(false);
        switch (target) {
          case "quick":
            setQuickOpenVisible((v) => !v);
            break;
          case "command":
            setCommandPaletteVisible((v) => !v);
            break;
          case "symbol":
            setSymbolPaletteVisible((v) => !v);
            break;
          case "wsymbol":
            setWorkspaceSymbolPaletteVisible((v) => !v);
            break;
          case "find":
            setFindInFilesVisible((v) => !v);
            break;
          case "help":
            setShortcutsHelpVisible((v) => !v);
            break;
        }
      }

      function cycleTab(prev: boolean) {
        const tabs = tabStore().tabs();
        const activeId = tabStore().activeTabId();
        if (tabs.length < 2 || !activeId) return;
        const i = tabs.findIndex((t) => t.id === activeId);
        const nextIdx = prev ? (i - 1 + tabs.length) % tabs.length : (i + 1) % tabs.length;
        void handleActivateTab(tabs[nextIdx]!.id);
      }

      // Action per catalog shortcut id. A single dispatcher below matches the
      // event against each shortcut's EFFECTIVE keys (user override or default),
      // so all of these are user-remappable from Settings → Keybindings.
      const keyCommands: Record<string, (e: KeyboardEvent) => void> = {
        "tab.close": (ev) => {
          const activeTab = tabStore().activeTabId();
          if (activeTab) {
            ev.preventDefault();
            handleCloseTab(activeTab);
          }
        },
        "tab.new": (ev) => {
          ev.preventDefault();
          handleNewTab();
        },
        "tab.reopen": (ev) => {
          ev.preventDefault();
          const reopened = tabStore().reopenClosedTab();
          if (reopened) void handleActivateTab(reopened.id);
        },
        "tab.next": (ev) => {
          ev.preventDefault();
          cycleTab(false);
        },
        "tab.prev": (ev) => {
          ev.preventDefault();
          cycleTab(true);
        },
        "nav.quickOpen": (ev) => {
          // preventDefault even on an empty workspace so the webview's native
          // print dialog (Ctrl+P) never leaks through.
          ev.preventDefault();
          if (rootPaths().size === 0) return;
          openOnly("quick");
        },
        "nav.commandPalette": (ev) => {
          ev.preventDefault();
          openOnly("command");
        },
        "nav.goToSymbol": (ev) => {
          ev.preventDefault();
          if (!state.selectedFile()) return;
          openOnly("symbol");
        },
        "nav.workspaceSymbols": (ev) => {
          ev.preventDefault();
          if (rootPaths().size === 0) return;
          openOnly("wsymbol");
        },
        "nav.findInFiles": (ev) => {
          ev.preventDefault();
          if (rootPaths().size === 0) return;
          openOnly("find");
        },
        "help.shortcuts": (ev) => {
          ev.preventDefault();
          openOnly("help");
        },
        "view.splitEditor": (ev) => {
          if (rootPaths().size === 0) return;
          ev.preventDefault();
          if (state.paneManager.panes().length >= 2) state.paneManager.collapseRightPane();
          else state.paneManager.splitFromActive();
        },
        "view.focusFirstPane": (ev) => {
          if (state.paneManager.panes().length < 2) return;
          ev.preventDefault();
          state.paneManager.setActivePane(0);
        },
        "view.focusSecondPane": (ev) => {
          if (state.paneManager.panes().length < 2) return;
          ev.preventDefault();
          state.paneManager.setActivePane(1);
        },
        "view.toggleReaderMode": (ev) => {
          ev.preventDefault();
          state.setReaderMode((v) => !v);
        },
        "ai.openChat": (ev) => {
          ev.preventDefault();
          state.focusAiComposer();
        },
        "ai.inlineAction": (ev) => {
          // ⌘I attaches the current selection to the chat as a chip — the
          // Excalidraw diagram selection over an `.excalidraw`, else the editor
          // text selection, else a DOM selection in the rendered preview
          // (`.doc-body`). No-op when there's nothing selected.
          ev.preventDefault();
          void addExcalidrawSelectionToChat().then((attached) => {
            if (attached || addSelectionToChat() || addPreviewSelectionToChat()) {
              state.focusAiComposer();
            }
          });
        },
        "app.settings": (ev) => {
          ev.preventDefault();
          setSettingsOpen(true);
        },
      };

      // Single configurable dispatch: first catalog shortcut whose effective
      // keys match the event wins.
      const overrides = getStoredKeybindings();
      for (const sc of SHORTCUTS) {
        const cmd = keyCommands[sc.id];
        if (cmd && matchBinding(e, effectiveKeys(sc.id, platform, overrides))) {
          cmd(e);
          return;
        }
      }

      // ── Shortcuts NOT in the catalog (not user-remappable) ──────────────────
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // Cmd/Ctrl+N: new file; Cmd/Ctrl+Shift+N: new folder (inline in the tree).
      if (mod && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        if (rootPaths().size === 0) return;
        startInlineCreate(e.shiftKey ? "folder" : "file");
        return;
      }
      // F11: Reader/Zen fallback (the catalog binding ⌘. is handled above). F11
      // is hijacked by macOS Mission Control, so ⌘. is the primary chord.
      if (e.key === "F11" && !mod && !e.shiftKey) {
        e.preventDefault();
        state.setReaderMode((v) => !v);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  const isWindows = navigator.platform.startsWith("Win");

  return (
    <>
      {isWindows && <WindowControls />}
      <AppShell
      state={state}
      hasRoot={rootPaths().size > 0}
      aiProviderLabel={aiProviderLabel()}
      aiModelGroups={aiModelGroups()}
      aiCurrentModel={aiCurrentModel()}
      aiContextLimit={aiContextLimit()}
      aiDisplayText={displayAi}
      aiSlashCommands={aiSlashCommands()}
      // Freshness without a file watcher: opening the "/" popover re-runs the
      // loader (the open transition itself debounces; latest-wins guard above).
      onAiSlashMenuOpen={reloadAiCommands}
      onSelectAiModel={selectAiModel}
      onOpenSettings={() => setSettingsOpen(true)}
      settingsOpen={settingsOpen()}
      onSettingsClose={() => setSettingsOpen(false)}
      aiProviders={aiProviders()}
      aiSelectedModel={getStoredAiModel()}
      aiAllModels={aiModelGroupsAll()}
      aiHiddenModels={hiddenModels()}
      onToggleModel={toggleHiddenModel}
      indexingTier={indexingTier()}
      onIndexingTierChange={(t) => {
        setIndexingTier(t);
        setStoredIndexingTier(t);
      }}
      aiReasoning={aiReasoning()}
      onAiReasoningChange={(v) => {
        // The Select hands back a plain string; the prefs setter narrows it
        // through its lenient parse (unknown values fall back to "off").
        const next: AIReasoningEffort =
          v === "low" || v === "medium" || v === "high" ? v : "off";
        setAiReasoning(next);
        setStoredAiReasoning(next);
      }}
      aiStreaming={aiStreaming()}
      onAiStreamingChange={(v) => {
        setAiStreaming(v);
        setStoredAiStreaming(v);
      }}
      onListModels={listAiModels}
      onSaveAiProvider={saveAiProvider}
      onSaveCustomProvider={saveCustomProvider}
      onConnectProvider={connectProvider}
      onRemoveProvider={removeProvider}
      mcpServers={mcpServersView()}
      onSaveMcpServer={saveMcpServer}
      onRemoveMcpServer={removeMcpServer}
      onToggleMcpServer={toggleMcpServer}
      showRecentHistory={true}
      showEditorTabs={rootPaths().size > 0}
      showNavButtons={rootPaths().size > 0}
      showToolbar={rootPaths().size > 0}
      showSidebar={state.sidebarVisible() && rootPaths().size > 0}
      showWindowControls={navigator.platform.startsWith("Win")}
      showCloseBehaviorToggle={true}
      toolbarFilePath={state.selectedFile()?.path ?? null}
      toolbarRootName={state.rootName()}
      windowFrameToolbar={true}
      onWindowDragStart={handleWindowDragStart}
      onWindowTitleDoubleClick={handleWindowTitleDoubleClick}
      onCheckForUpdates={() => checkForAppUpdates(false)}
      onReleaseNotes={() => { void openReleaseNotes(); }}
      tabStore={tabStore()}
      onActivateTab={handleActivateTab}
      onCloseTab={handleCloseTab}
      onNewTab={handleNewTab}
      onMoveTab={handleMoveTab}
      quickOpenOpen={quickOpenVisible()}
      quickOpenRecents={quickOpenRecents()}
      onQuickOpenSelect={handleQuickOpenSelect}
      onQuickOpenClose={() => setQuickOpenVisible(false)}
      shortcutsHelpOpen={shortcutsHelpVisible()}
      onShortcutsHelpOpen={() => setShortcutsHelpVisible(true)}
      onShortcutsHelpClose={() => setShortcutsHelpVisible(false)}
      aboutOpen={aboutOpen()}
      aboutVersion={appVersion()}
      onAboutOpen={() => setAboutOpen(true)}
      onAboutClose={() => setAboutOpen(false)}
      commandPaletteOpen={commandPaletteVisible()}
      commandCatalog={commandCatalog()}
      onCommandPaletteClose={() => setCommandPaletteVisible(false)}
      symbolPaletteOpen={symbolPaletteVisible()}
      onSymbolPaletteClose={() => setSymbolPaletteVisible(false)}
      workspaceSymbolPaletteOpen={workspaceSymbolPaletteVisible()}
      workspaceSymbols={workspaceSymbols()}
      onWorkspaceSymbolPaletteClose={() => setWorkspaceSymbolPaletteVisible(false)}
      findInFilesOpen={findInFilesVisible()}
      findInFilesSearch={(rootId, query, opts) =>
        findInFiles(rootId, query, { caseSensitive: opts.caseSensitive })
      }
      onFindInFilesClose={() => setFindInFilesVisible(false)}
      onCloseRoot={(rootId) => folder.handleCloseRoot(rootId)}
      onCopyPath={folder.handleCopyPath}
      onRevealInFileManager={folder.handleRevealInFileManager}
      onGoBack={navigation.handleGoBack}
      onGoForward={navigation.handleGoForward}
      onLoadFile={handleLoadFileWithTab}
      onOpenInNewTab={handleOpenInNewTab}
      onAddFileMention={(f) => void addFileMention(f)}
      onDoubleClickFile={handleOpenInNewTab}
      onNavigate={navigation.handleNavigate}
      onOpenExternal={(url) => openUrl(url)}
      onOpenFolder={folder.handleOpenFolder}
      onOpenRecentFile={handleOpenRecentFile}
      onOpenRecentFolder={handleOpenRecentFolder}
      onRename={folder.handleRename}
      onCreate={handleCreate}
      onMove={(entry, targetDirRel, rootId, targetRootId) => folder.handleMove(entry, targetDirRel, rootId, targetRootId)}
      onCopy={(entry, targetDirRel, rootId, targetRootId) => {
        void folder.handleCopy(entry, targetDirRel, rootId, targetRootId);
      }}
      onDelete={async (entry, rootId) => {
        const label = entry.kind === "directory" ? "folder" : "file";
        const confirmed = await confirm({
          title: `Delete ${label}`,
          description: `Move "${entry.name}" to Trash?`,
          confirmLabel: "Move to Trash",
        });
        if (confirmed) {
          await folder.handleDelete(entry, rootId);
          // Close ALL tabs for deleted files (including duplicates)
          const tabsToClose = tabStore().tabs().filter((t) =>
            t.rootId === rootId && (
              t.filePath === entry.path ||
              (entry.kind === "directory" && t.filePath.startsWith(entry.path + "/"))
            ),
          );
          for (const tab of tabsToClose) {
            tabStore().closeTab(tab.id);
          }
        }
      }}
      resolveImageSrc={resolveImageSrc}
      resolveFileSrc={resolveFileSrc}
      htmlPreviewHost={htmlPreviewHost}
      renderExcalidraw={(file, rootId) => {
        const root = rootPaths().get(rootId);
        return root ? (
          <ExcalidrawFrame filePath={`${root}/${file.path}`} onFrameApi={registerExcalidrawFrame} />
        ) : null;
      }}
      onToggleShowHiddenEntries={() => folder.refreshAllRoots()}
      onToggleRespectGitignore={() => folder.refreshAllRoots()}
      onReorderRoots={(newOrder) => state.reorderRoots(newOrder)}
    />
    <UpdateAvailableDialog
      open={!!useUpdate()}
      version={useUpdate()?.version ?? ""}
      currentVersion={useUpdate()?.currentVersion ?? ""}
      notes={useUpdate()?.notes}
      downloadProgress={useDownloadProgress()}
      onDismiss={dismissUpdate}
      onInstall={() => {
        const update = useUpdate();
        if (!update) return;
        void update.install();
      }}
    />
    <ReleaseNotesDialog
      open={releaseNotesState().open}
      currentVersion={releaseNotesState().currentVersion}
      loading={releaseNotesState().loading}
      entries={releaseNotesState().entries}
      error={releaseNotesState().error}
      onClose={() => setReleaseNotesState((s) => ({ ...s, open: false }))}
      onOpenInBrowser={() => {
        // Always link to the public releases index — the dialog now
        // surfaces history, not a single version.
        void openUrl(RELEASES_INDEX_URL);
      }}
    />
    {/* Capture-to-Figma button hidden for now (per request).
        Restore: {import.meta.env.DEV && <FigmaCaptureButton />} + its import. */}
    {/* AI edits (app__propose_edit) apply optimistically and are reviewed via a
        Cursor-style inline diff in the editor — Keep/Undo per region (⌘Y/⌘N) or
        Keep all (⌘↵). No modal here anymore. */}

    {/* Prompt-tier tool approval (MCP / unknown tools): the model never runs an
        arbitrary server tool without an explicit Accept here. */}
    <Show when={pendingApproval()}>
      {(req) => (
        <div
          role="dialog"
          aria-label={m.ai_tool_approval_title()}
          style={{
            position: "fixed",
            bottom: "16px",
            left: "50%",
            transform: "translateX(-50%)",
            "z-index": "60",
            "max-width": "min(640px, 92vw)",
            display: "flex",
            "flex-direction": "column",
            gap: "10px",
            padding: "12px 14px",
            "border-radius": "10px",
            border: "1px solid hsl(var(--border))",
            background: "hsl(var(--popover))",
            color: "hsl(var(--popover-foreground))",
            "box-shadow": "0 10px 30px rgba(0, 0, 0, 0.25)",
          }}
        >
          <div style={{ "font-size": "13px", "font-weight": "600" }}>
            {m.ai_tool_approval_title()}
          </div>
          <div style={{ "font-size": "12px", opacity: "0.85" }}>
            <span style={{ "font-family": "var(--font-mono, monospace)" }}>{req().toolName}</span>
            <Show when={req().source}>
              {(src) => <span style={{ opacity: "0.6" }}>{`  ·  ${src()}`}</span>}
            </Show>
          </div>
          <pre
            style={{
              "font-size": "11px",
              "line-height": "1.4",
              margin: "0",
              "white-space": "pre-wrap",
              "word-break": "break-word",
              "max-height": "30vh",
              "overflow-y": "auto",
              opacity: "0.8",
            }}
          >
            {req().argsPreview}
          </pre>
          <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-md h-8 px-3 text-sm hover:bg-accent hover:text-accent-foreground border border-input"
              onClick={() => req().deny()}
            >
              {m.ai_inline_reject()}
            </button>
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-md h-8 px-3 text-sm bg-primary text-primary-foreground hover:opacity-90"
              onClick={() => req().approve()}
            >
              {m.ai_inline_accept()}
            </button>
          </div>
        </div>
      )}
    </Show>
    </>
  );
}
