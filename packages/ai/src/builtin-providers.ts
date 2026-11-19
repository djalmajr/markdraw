// Built-in provider catalog (engine-neutral; see config-schema.ts `kind`).
// The user's ai.json is deep-merged over this — known providers inherit
// kind/name/models and let the user override options (baseURL) and add models;
// local providers (Ollama, LM Studio) ship with no models so the user lists the
// ones they have installed. Mirrors the Figma "Manage providers" cards.

import type { AIConfig, ProviderConfig, UserAIConfig } from "./config-schema.ts";
import { mergeConfigs } from "./config-schema.ts";

export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    kind: "anthropic",
    name: "Anthropic",
    // Shares the "Claude" connect card with the claude-sub subscription so the
    // user picks API key OR subscription in one place.
    connectGroup: "Claude",
    // Newest non-deprecated model per Claude family in models.dev, by
    // release_date (Fable / Haiku / Sonnet / Opus). Names and limits come from
    // that payload; older generations and dated ids are added by hand if needed.
    models: {
      "claude-fable-5-2": { name: "Claude Fable 5.2", limit: { context: 1000000, output: 128000 } },
      "claude-haiku-5-5": { name: "Claude Haiku 5.5", limit: { context: 1000000, output: 128000 } },
      "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", limit: { context: 1000000, output: 128000 } },
      "claude-opus-5-5": { name: "Claude Opus 5.5", limit: { context: 1000000, output: 128000 } },
    },
  },
  openai: {
    kind: "openai",
    name: "OpenAI",
    // Shares the "OpenAI" connect card with the Codex subscription: GPT models
    // via API key, or the Codex CLI via subscription.
    connectGroup: "OpenAI",
    // Chat models are fetched live from /v1/models on connect (empty here so the
    // connect flow triggers the fetch). listAiModels filters to chat models —
    // OpenAI's catalog also lists embeddings, audio, image and legacy models.
    options: { baseURL: "https://api.openai.com/v1" },
    models: {},
    // Embedding models for the "Full" workspace index. `dim` is the native
    // vector size; switching models (different dim) forces a reindex. Kept
    // hand-declared — /v1/models doesn't expose embedding dimensions.
    embeddingModels: {
      "text-embedding-3-small": { name: "Text Embedding 3 Small", dim: 1536 },
      "text-embedding-3-large": { name: "Text Embedding 3 Large", dim: 3072 },
    },
  },
  openrouter: {
    kind: "openai-compatible",
    name: "OpenRouter",
    options: { baseURL: "https://openrouter.ai/api/v1" },
    models: {}, // 200+ models — the user lists the ones they use
  },
  // xAI / Grok — OpenAI-compatible API at api.x.ai. Shares the "Grok" connect
  // card with the Grok CLI subscription (added under the same connectGroup).
  // Models are fetched live from /v1/models on connect (always current).
  xai: {
    kind: "openai-compatible",
    name: "xAI",
    connectGroup: "Grok",
    options: { baseURL: "https://api.x.ai/v1" },
    models: {},
  },
  // OpenCode Go (https://opencode.ai/zen/go/v1) — one service, one key, but its
  // catalog spans two API shapes, so it is two provider entries (the `kind`
  // decides both the SDK and the endpoint: anthropic → /messages, openai-compatible
  // → /chat/completions). The settings Connect catalog merges them by base name
  // into a single "OpenCode Go" row. Model ids per opencode.ai/zen/go/v1/models.
  "opencode-go": {
    kind: "anthropic", // /messages
    name: "OpenCode Go",
    options: { baseURL: "https://opencode.ai/zen/go/v1" },
    // Hand-maintained: the live /models can't say which API shape each model
    // uses, so we keep the /messages-vs-/chat split curated (no live refresh).
    curatedModels: true,
    models: {
      "claude-haiku-5-5": { name: "Claude Haiku 5.5" },
      "minimax-m3": { name: "MiniMax-M3" },
      "qwen3.8-max": { name: "Qwen3.8 Max" },
      "qwen3.8-flash": { name: "Qwen3.8 Flash" },
      "qwen3.7-plus": { name: "Qwen3.7 Plus" },
      "qwen4-max": { name: "Qwen4 Max" },
    },
  },
  "opencode-go-chat": {
    kind: "openai-compatible", // /chat/completions
    name: "OpenCode Go (chat)",
    options: { baseURL: "https://opencode.ai/zen/go/v1" },
    curatedModels: true, // see opencode-go — hand-maintained split
    models: {
      "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash 1017" },
      "deepseek-v4-pro": { name: "DeepSeek V4 Pro" },
      "glm-5.3": { name: "GLM-5.3" },
      "glm-5.3-flash": { name: "GLM-5.3-Flash" },
      "hy3": { name: "Hy3" },
      "hy4-preview": { name: "Hy4 preview" },
      "kimi-k2.7-code": { name: "Kimi K2.7 Code" },
      "kimi-k3": { name: "Kimi K3" },
      "mimo-v2.6-flash": { name: "MiMo-V2.6-Flash" },
      "mimo-v2.6-pro": { name: "MiMo-V2.6-Pro" },
      "minimax-m3.1-flash": { name: "MiniMax M3.1 Flash" },
      "longcat-2.0": { name: "LongCat-2.0" },
      "step-5-preview": { name: "Step 5 Preview" },
      "beam-free": { name: "Beam Free" },
      "kimi-k3.1-pro": { name: "Kimi K3.1 Pro" },
      "iceman-contributor-free": { name: "Iceman Contributor Free" },
      "hy4": { name: "Hy4" },
      "longcat-2.5-free": { name: "LongCat 2.5 Free" },
      "hy4-flash-free": { name: "Hy4 flash Free" },
    },
  },
  // OpenCode Zen (https://opencode.ai/zen/v1) — distinct catalog; models live from /models.
  "opencode-zen": {
    kind: "openai-compatible",
    name: "OpenCode Zen",
    options: { baseURL: "https://opencode.ai/zen/v1" },
    models: {}, // fetched live from /models (see model-catalog.ts)
  },
  ollama: {
    kind: "openai-compatible",
    name: "Ollama (local)",
    options: { baseURL: "http://localhost:11434/v1" },
    models: {}, // the user lists installed models (e.g. "llama3.1:8b")
  },
  lmstudio: {
    kind: "openai-compatible",
    name: "LM Studio (local)",
    options: { baseURL: "http://localhost:1234/v1" },
    models: {}, // the user lists models loaded in LM Studio's local server
  },
  // Claude Code / Codex subscription — routed through the official local CLI
  // (Rust spawn + JSONL parse). No API key; auth comes from the CLI install.
  "claude-sub": {
    kind: "claude-cli",
    name: "Claude (subscription)",
    connectGroup: "Claude",
    // Same four-model Claude snapshot as the API-key provider above.
    models: {
      "claude-fable-5-2": { name: "Claude Fable 5.2", limit: { context: 1000000, output: 128000 } },
      "claude-haiku-5-5": { name: "Claude Haiku 5.5", limit: { context: 1000000, output: 128000 } },
      "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", limit: { context: 1000000, output: 128000 } },
      "claude-opus-5-5": { name: "Claude Opus 5.5", limit: { context: 1000000, output: 128000 } },
    },
  },
  "codex-sub": {
    kind: "codex-cli",
    name: "Codex (subscription)",
    connectGroup: "OpenAI",
    // Mirrors the official Codex model picker (desktop + CLI), newest first.
    // Snapshot of ~/.codex/models_cache.json `slug`/`display_name` where
    // `visibility` is "list" (the picker's visibility field; "hide" is excluded).
    models: {
      "gpt-6.2-sol": { name: "GPT-6.2-Sol" },
      "gpt-6.2-astra": { name: "GPT-6.2-Astra" },
      "gpt-6.1-terra": { name: "GPT-6.1 Terra" },
      "gpt-6.1-sol": { name: "GPT-6.1-Sol" },
      "gpt-6-astra": { name: "GPT-6-Astra" },
      "gpt-6-sol": { name: "GPT-6-Sol" },
      "gpt-6-luna": { name: "GPT-6-Luna" },
      "gpt-5.6-sol": { name: "GPT-5.6-Sol" },
      "gpt-5.6-terra": { name: "GPT-5.6-Terra" },
      "gpt-5.6-luna": { name: "GPT-5.6-Luna" },
    },
  },
  // Grok CLI subscription — routed through the official local `grok` binary
  // (Rust spawn + JSONL parse). Shares the "Grok" connect card with the xAI API
  // key. Models mirror `grok models` (the CLI's own agentic catalog).
  "grok-sub": {
    kind: "grok-cli",
    name: "Grok (subscription)",
    connectGroup: "Grok",
    models: {
      // `grok models` prints ids only (the `*` marks the default).
      "grok-4.6": { name: "grok-4.6" },
      "grok-4.5": { name: "grok-4.5" },
    },
  },
  // Google Gemini API (OpenAI-compatible endpoint). Shares the "Antigravity"
  // connect card with the Antigravity CLI subscription. Models fetched live.
  gemini: {
    kind: "openai-compatible",
    name: "Gemini",
    connectGroup: "Antigravity",
    options: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
    models: {},
  },
  // Antigravity CLI subscription — routed through the official local `agy`
  // binary (Rust spawn, plain-text stdout). Shares the "Antigravity" connect
  // card with the Gemini API key. Models mirror `agy models` (its agentic
  // catalog): each line is `id<TAB>display name`, and --model accepts the
  // display name (the values an invalid --model error lists as available),
  // so the display name is both the key and the label here.
  "antigravity-sub": {
    kind: "antigravity-cli",
    name: "Antigravity (subscription)",
    connectGroup: "Antigravity",
    models: {
      "Gemini 4 Neon (High)": { name: "Gemini 4 Neon (High)" },
      "Gemini 4 Neon (XHigh)": { name: "Gemini 4 Neon (XHigh)" },
      "Gemini 4 Neon (Medium)": { name: "Gemini 4 Neon (Medium)" },
      "Gemini 4 Neon (Low)": { name: "Gemini 4 Neon (Low)" },
      "Gemini 4 Argon (Medium)": { name: "Gemini 4 Argon (Medium)" },
      "Gemini 4 Argon (High)": { name: "Gemini 4 Argon (High)" },
      "Gemini 4 Argon (Low)": { name: "Gemini 4 Argon (Low)" },
      "Gemini 4 Hydrogen (High)": { name: "Gemini 4 Hydrogen (High)" },
      "Gemini 4 Hydrogen (XHigh)": { name: "Gemini 4 Hydrogen (XHigh)" },
      "Gemini 4 Hydrogen (Medium)": { name: "Gemini 4 Hydrogen (Medium)" },
      "Gemini 4 Hydrogen (Low)": { name: "Gemini 4 Hydrogen (Low)" },
      "Orchestrator (Neon)": { name: "Orchestrator (Neon)" },
      "Orchestrator (Argon)": { name: "Orchestrator (Argon)" },
      "Gemini 3.8 Flash (High)": { name: "Gemini 3.8 Flash (High)" },
      "Gemini 3.8 Flash (Medium)": { name: "Gemini 3.8 Flash (Medium)" },
      "Gemini 3.8 Flash (Low)": { name: "Gemini 3.8 Flash (Low)" },
      "Claude Opus 5.5 (Low)": { name: "Claude Opus 5.5 (Low)" },
      "Claude Opus 5.5 (Medium)": { name: "Claude Opus 5.5 (Medium)" },
      "Claude Opus 5.5 (High)": { name: "Claude Opus 5.5 (High)" },
      "Claude Sonnet 5.5 (Low)": { name: "Claude Sonnet 5.5 (Low)" },
      "Claude Sonnet 5.5 (Medium)": { name: "Claude Sonnet 5.5 (Medium)" },
      "Claude Sonnet 5.5 (High)": { name: "Claude Sonnet 5.5 (High)" },
      "GPT-OSS 120B (Medium)": { name: "GPT-OSS 120B (Medium)" },
    },
  },
};

/** Deep-merge a parsed user config over the built-in catalog. */
export function withBuiltins(user: UserAIConfig): AIConfig {
  return mergeConfigs(BUILTIN_PROVIDERS, user);
}
