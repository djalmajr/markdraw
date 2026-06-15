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
    models: {
      "claude-opus-4-8": {
        name: "Claude Opus 4.8",
        limit: { context: 200000, output: 64000 },
      },
      "claude-sonnet-4-6": {
        name: "Claude Sonnet 4.6",
        limit: { context: 200000, output: 64000 },
      },
      "claude-haiku-4-5": {
        name: "Claude Haiku 4.5",
        limit: { context: 200000, output: 64000 },
      },
    },
  },
  openai: {
    kind: "openai",
    name: "OpenAI",
    // Shares the "OpenAI" connect card with the Codex subscription: GPT models
    // via API key, or the Codex CLI via subscription.
    connectGroup: "OpenAI",
    models: {
      "gpt-4o": { name: "GPT-4o", limit: { context: 128000, output: 16384 } },
      "gpt-4o-mini": {
        name: "GPT-4o mini",
        limit: { context: 128000, output: 16384 },
      },
    },
    // Embedding models for the "Full" workspace index. `dim` is the native
    // vector size; switching models (different dim) forces a reindex.
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
    models: {
      "minimax-m3": { name: "MiniMax M3" },
      "minimax-m2.7": { name: "MiniMax M2.7" },
      "minimax-m2.5": { name: "MiniMax M2.5" },
      "qwen3.7-max": { name: "Qwen3.7 Max" },
      "qwen3.7-plus": { name: "Qwen3.7 Plus" },
      "qwen3.6-plus": { name: "Qwen3.6 Plus" },
    },
  },
  "opencode-go-chat": {
    kind: "openai-compatible", // /chat/completions
    name: "OpenCode Go (chat)",
    options: { baseURL: "https://opencode.ai/zen/go/v1" },
    models: {
      "glm-5.1": { name: "GLM-5.1" },
      "glm-5": { name: "GLM-5" },
      "kimi-k2.7-code": { name: "Kimi K2.7 Code" },
      "kimi-k2.6": { name: "Kimi K2.6" },
      "deepseek-v4-pro": { name: "DeepSeek V4 Pro" },
      "deepseek-v4-flash": { name: "DeepSeek V4 Flash" },
      "mimo-v2.5": { name: "MiMo-V2.5" },
      "mimo-v2.5-pro": { name: "MiMo-V2.5-Pro" },
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
    models: {
      "claude-opus-4-8": {
        name: "Claude Opus 4.8",
        limit: { context: 200000, output: 64000 },
      },
      "claude-sonnet-4-6": {
        name: "Claude Sonnet 4.6",
        limit: { context: 200000, output: 64000 },
      },
    },
  },
  "codex-sub": {
    kind: "codex-cli",
    name: "Codex (subscription)",
    connectGroup: "OpenAI",
    // Mirrors the official Codex model picker (desktop + CLI), newest first.
    models: {
      "gpt-5.5": { name: "GPT-5.5" },
      "gpt-5.4": { name: "GPT-5.4" },
      "gpt-5.4-mini": { name: "GPT-5.4-Mini" },
      "gpt-5.3-codex-spark": { name: "GPT-5.3-Codex-Spark" },
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
      "grok-composer-2.5-fast": { name: "Grok Composer 2.5 Fast" },
      "grok-build": { name: "Grok Build" },
    },
  },
};

/** Deep-merge a parsed user config over the built-in catalog. */
export function withBuiltins(user: UserAIConfig): AIConfig {
  return mergeConfigs(BUILTIN_PROVIDERS, user);
}
