import { describe, expect, it } from "bun:test";
import { BUILTIN_PROVIDERS, withBuiltins } from "./builtin-providers.ts";

describe("BUILTIN_PROVIDERS", () => {
  it("ships the builtin providers with valid kinds", () => {
    expect(Object.keys(BUILTIN_PROVIDERS).sort()).toEqual([
      "anthropic",
      "antigravity-sub",
      "claude-sub",
      "codex-sub",
      "gemini",
      "grok-sub",
      "lmstudio",
      "ollama",
      "openai",
      "opencode-go",
      "opencode-go-chat",
      "opencode-zen",
      "openrouter",
      "xai",
    ]);
    expect(BUILTIN_PROVIDERS["claude-sub"].kind).toBe("claude-cli");
    expect(BUILTIN_PROVIDERS["codex-sub"].kind).toBe("codex-cli");
    expect(BUILTIN_PROVIDERS["grok-sub"].kind).toBe("grok-cli");
    expect(BUILTIN_PROVIDERS["grok-sub"].connectGroup).toBe("Grok");
    expect(BUILTIN_PROVIDERS.xai.connectGroup).toBe("Grok");
    expect(BUILTIN_PROVIDERS["antigravity-sub"].kind).toBe("antigravity-cli");
    expect(BUILTIN_PROVIDERS["antigravity-sub"].connectGroup).toBe("Antigravity");
    expect(BUILTIN_PROVIDERS.gemini.kind).toBe("openai-compatible");
    expect(BUILTIN_PROVIDERS.gemini.connectGroup).toBe("Antigravity");
    expect(BUILTIN_PROVIDERS.gemini.options?.baseURL).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(BUILTIN_PROVIDERS.anthropic.kind).toBe("anthropic");
    expect(BUILTIN_PROVIDERS.openai.kind).toBe("openai");
    expect(BUILTIN_PROVIDERS.ollama.kind).toBe("openai-compatible");
    expect(BUILTIN_PROVIDERS.ollama.options?.baseURL).toBe("http://localhost:11434/v1");
    expect(BUILTIN_PROVIDERS.lmstudio.options?.baseURL).toBe("http://localhost:1234/v1");
  });

  it("splits OpenCode Go into anthropic (/messages) and openai-compatible (/chat/completions) shapes sharing one base URL", () => {
    const go = BUILTIN_PROVIDERS["opencode-go"];
    const goChat = BUILTIN_PROVIDERS["opencode-go-chat"];
    expect(go.kind).toBe("anthropic");
    expect(goChat.kind).toBe("openai-compatible");
    expect(go.options?.baseURL).toBe("https://opencode.ai/zen/go/v1");
    expect(goChat.options?.baseURL).toBe("https://opencode.ai/zen/go/v1");
    expect(go.models["minimax-m3"].name).toBe("MiniMax-M3");
    expect(goChat.models["glm-5.3"].name).toBe("GLM-5.3");
    // Hand-maintained split — opted out of live /models refresh (the endpoint
    // can't say which API shape each model uses).
    expect(go.curatedModels).toBe(true);
    expect(goChat.curatedModels).toBe(true);
  });

  it("ships only the newest model per Claude family on both Claude providers", () => {
    const ids = [
      "claude-fable-5-2",
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    ];
    const names: Record<string, string> = {
      "claude-fable-5-2": "Claude Fable 5.2",
      "claude-haiku-5-5": "Claude Haiku 5.5",
      "claude-sonnet-5-5": "Claude Sonnet 5.5",
      "claude-opus-5-5": "Claude Opus 5.5",
    };
    for (const key of ["anthropic", "claude-sub"] as const) {
      const models = BUILTIN_PROVIDERS[key].models;
      expect(Object.keys(models)).toEqual(ids);
      for (const id of ids) {
        expect(models[id].name).toBe(names[id]);
        expect(models[id].limit).toEqual({ context: 1000000, output: 128000 });
      }
      // Deprecated, older generations and dated aliases stay out of the builtin.
      for (const removed of [
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5-1",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-5-20251101",
      ])
        expect(models[removed]).toBeUndefined();
    }
  });

  it("ships only the Codex models with visibility=list, using their display names", () => {
    const models = BUILTIN_PROVIDERS["codex-sub"].models;
    expect(Object.keys(models)).toEqual([
      "gpt-6.2-sol",
      "gpt-6.2-astra",
      "gpt-6.1-terra",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(models["gpt-6.2-sol"].name).toBe("GPT-6.2-Sol");
    expect(models["gpt-6.1-terra"].name).toBe("GPT-6.1 Terra");
    for (const hidden of ["gpt-6-chat-thinking", "gpt-reserve", "codex-auto-review"])
      expect(models[hidden]).toBeUndefined();
    expect(models["gpt-5.5"]).toBeUndefined();
  });

  it("ships the models printed by grok models", () => {
    const models = BUILTIN_PROVIDERS["grok-sub"].models;
    expect(Object.keys(models)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(models["grok-4.6"].name).toBe("grok-4.6");
    expect(models["grok-build"]).toBeUndefined();
  });

  it("keys Antigravity models by the display name agy --model accepts", () => {
    const names = [
      "Gemini 4 Neon (High)",
      "Gemini 4 Neon (XHigh)",
      "Gemini 4 Neon (Medium)",
      "Gemini 4 Neon (Low)",
      "Gemini 4 Argon (Medium)",
      "Gemini 4 Argon (High)",
      "Gemini 4 Argon (Low)",
      "Gemini 4 Hydrogen (High)",
      "Gemini 4 Hydrogen (XHigh)",
      "Gemini 4 Hydrogen (Medium)",
      "Gemini 4 Hydrogen (Low)",
      "Orchestrator (Neon)",
      "Orchestrator (Argon)",
      "Gemini 3.8 Flash (High)",
      "Gemini 3.8 Flash (Medium)",
      "Gemini 3.8 Flash (Low)",
      "Claude Opus 5.5 (Low)",
      "Claude Opus 5.5 (Medium)",
      "Claude Opus 5.5 (High)",
      "Claude Sonnet 5.5 (Low)",
      "Claude Sonnet 5.5 (Medium)",
      "Claude Sonnet 5.5 (High)",
      "GPT-OSS 120B (Medium)",
    ];
    const models = BUILTIN_PROVIDERS["antigravity-sub"].models;
    expect(Object.keys(models)).toEqual(names);
    for (const name of names) expect(models[name].name).toBe(name);
    expect(models["gemini-4-neon-high"]).toBeUndefined(); // CLI id, not the --model key
    expect(models["Gemini 3.5 Flash (High)"]).toBeUndefined();
  });

  it("splits the current OpenCode Go catalog by recommended_api", () => {
    const messages = Object.keys(BUILTIN_PROVIDERS["opencode-go"].models);
    const chat = Object.keys(BUILTIN_PROVIDERS["opencode-go-chat"].models);
    expect(messages).toEqual([
      "claude-haiku-5-5",
      "minimax-m3",
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.7-plus",
      "qwen4-max",
    ]);
    expect(chat).toEqual([
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "glm-5.3",
      "glm-5.3-flash",
      "hy3",
      "hy4-preview",
      "kimi-k2.7-code",
      "kimi-k3",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
      "minimax-m3.1-flash",
      "longcat-2.0",
      "step-5-preview",
      "beam-free",
      "kimi-k3.1-pro",
      "iceman-contributor-free",
      "hy4",
      "longcat-2.5-free",
      "hy4-flash-free",
    ]);
    expect(BUILTIN_PROVIDERS["opencode-go"].models["qwen4-max"].name).toBe("Qwen4 Max");
    expect(BUILTIN_PROVIDERS["opencode-go-chat"].models["deepseek-v4.1-flash"].name).toBe(
      "DeepSeek V4.1 Flash 1017",
    );
    for (const excluded of ["grok-4.7", "gpt-6-luna", "gemini-4-argon"])
      expect(chat).not.toContain(excluded); // responses / generate-content
    expect(messages).not.toContain("minimax-m3.1-flash"); // chat-completions
  });

  it("declares OpenAI embedding models with dims; chat-only providers have none", () => {
    expect(BUILTIN_PROVIDERS.openai.embeddingModels?.["text-embedding-3-small"]?.dim).toBe(1536);
    expect(BUILTIN_PROVIDERS.openai.embeddingModels?.["text-embedding-3-large"]?.dim).toBe(3072);
    // Subscription CLIs and Anthropic have no embeddings API.
    expect(BUILTIN_PROVIDERS.anthropic.embeddingModels).toBeUndefined();
    expect(BUILTIN_PROVIDERS["claude-sub"].embeddingModels).toBeUndefined();
    expect(BUILTIN_PROVIDERS["codex-sub"].embeddingModels).toBeUndefined();
    expect(BUILTIN_PROVIDERS["grok-sub"].embeddingModels).toBeUndefined();
    expect(BUILTIN_PROVIDERS["antigravity-sub"].embeddingModels).toBeUndefined();
  });

  it("ships OpenCode Zen as openai-compatible at zen/v1 with a live model catalog", () => {
    expect(BUILTIN_PROVIDERS["opencode-zen"].kind).toBe("openai-compatible");
    expect(BUILTIN_PROVIDERS["opencode-zen"].options?.baseURL).toBe("https://opencode.ai/zen/v1");
    expect(BUILTIN_PROVIDERS["opencode-zen"].models).toEqual({});
  });
});

describe("withBuiltins", () => {
  it("merges a user-added Ollama model onto the builtin", () => {
    const config = withBuiltins({
      model: "ollama/llama3.1:8b",
      provider: { ollama: { models: { "llama3.1:8b": { name: "Llama 3.1 8B" } } } },
    });
    expect(config.model).toBe("ollama/llama3.1:8b");
    expect(config.provider.ollama.models["llama3.1:8b"].name).toBe("Llama 3.1 8B");
    expect(config.provider.ollama.options?.baseURL).toBe("http://localhost:11434/v1");
    // builtins untouched
    expect(config.provider.anthropic.kind).toBe("anthropic");
  });

  it("returns the full catalog for an empty config", () => {
    const config = withBuiltins({});
    expect(Object.keys(config.provider)).toHaveLength(14);
    expect(config.provider["opencode-go"].options?.baseURL).toBe("https://opencode.ai/zen/go/v1");
    expect(config.provider["opencode-zen"].options?.baseURL).toBe("https://opencode.ai/zen/v1");
  });
});
