import { beforeEach, describe, expect, it } from "bun:test";
import {
  getStoredAiEmbeddingModel,
  setStoredAiEmbeddingModel,
  getStoredAiEngine,
  getStoredAiMode,
  getStoredAiModel,
  getStoredAiReasoning,
  getStoredAiSmallModel,
  getStoredAiStreaming,
  getStoredConnectedSubscriptions,
  setStoredConnectedSubscriptions,
  getStoredHiddenModels,
  setStoredHiddenModels,
  getStoredIndexingTier,
  setStoredAiEngine,
  setStoredAiMode,
  setStoredAiModel,
  setStoredAiReasoning,
  setStoredAiSmallModel,
  setStoredAiStreaming,
  setStoredIndexingTier,
} from "./ai-prefs.ts";
import { installLocalStorageMock } from "./test-utils.ts";

installLocalStorageMock();

describe("ai preferences defaults", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults: no model, lite tier, ai-sdk engine, streaming off, reasoning default", () => {
    expect(getStoredAiModel()).toBeNull();
    expect(getStoredAiSmallModel()).toBeNull();
    expect(getStoredAiEmbeddingModel()).toBeNull();
    expect(getStoredIndexingTier()).toBe("lite");
    expect(getStoredAiEngine()).toBe("ai-sdk");
    expect(getStoredAiStreaming()).toBe(false);
    expect(getStoredAiMode()).toBe("build");
    expect(getStoredAiReasoning()).toBe("default");
  });

  it("falls back to build for an unknown/garbage mode value", () => {
    localStorage.setItem("markdraw-ai-mode", "garbage");
    expect(getStoredAiMode()).toBe("build");
  });

  it("falls back to lite for a corrupted tier value", () => {
    localStorage.setItem("markdraw-ai-indexing-tier", "garbage");
    expect(getStoredIndexingTier()).toBe("lite");
  });

  it("falls back to ai-sdk for an unknown engine value", () => {
    localStorage.setItem("markdraw-ai-engine", "nope");
    expect(getStoredAiEngine()).toBe("ai-sdk");
  });

  it("falls back to default for an unknown reasoning value", () => {
    localStorage.setItem("markdraw-ai-reasoning", "ultra");
    expect(getStoredAiReasoning()).toBe("default");
  });

  it("migrates the legacy \"off\" reasoning value to \"default\"", () => {
    localStorage.setItem("markdraw-ai-reasoning", "off");
    expect(getStoredAiReasoning()).toBe("default");
  });

  it("reads back the new effort labels (none / thinking / xhigh / max)", () => {
    for (const effort of ["none", "thinking", "minimal", "xhigh", "max"] as const) {
      localStorage.setItem("markdraw-ai-reasoning", effort);
      expect(getStoredAiReasoning()).toBe(effort);
    }
  });
});

describe("ai preferences round-trip", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists the selected model and clears it with null", () => {
    setStoredAiModel("ollama/llama3.1:8b");
    expect(getStoredAiModel()).toBe("ollama/llama3.1:8b");
    setStoredAiModel(null);
    expect(getStoredAiModel()).toBeNull();
  });

  it("persists the small model independently", () => {
    setStoredAiSmallModel("anthropic/claude-haiku-4-5");
    expect(getStoredAiSmallModel()).toBe("anthropic/claude-haiku-4-5");
  });

  it("persists the embedding model independently of the chat model", () => {
    setStoredAiModel("openai/gpt-4o");
    setStoredAiEmbeddingModel("openai/text-embedding-3-small");
    expect(getStoredAiEmbeddingModel()).toBe("openai/text-embedding-3-small");
    expect(getStoredAiModel()).toBe("openai/gpt-4o"); // chat model untouched
    setStoredAiEmbeddingModel(null);
    expect(getStoredAiEmbeddingModel()).toBeNull();
    expect(getStoredAiModel()).toBe("openai/gpt-4o");
  });

  it("persists tier and engine", () => {
    setStoredIndexingTier("full");
    expect(getStoredIndexingTier()).toBe("full");
    setStoredAiEngine("tanstack");
    expect(getStoredAiEngine()).toBe("tanstack");
  });

  it("persists the streaming flag", () => {
    setStoredAiStreaming(true);
    expect(getStoredAiStreaming()).toBe(true);
    setStoredAiStreaming(false);
    expect(getStoredAiStreaming()).toBe(false);
  });

  it("persists the reasoning effort across every level", () => {
    for (const effort of ["default", "low", "medium", "high", "max"] as const) {
      setStoredAiReasoning(effort);
      expect(getStoredAiReasoning()).toBe(effort);
    }
  });

  it("persists the chat mode (build ↔ plan)", () => {
    setStoredAiMode("plan");
    expect(getStoredAiMode()).toBe("plan");
    setStoredAiMode("build");
    expect(getStoredAiMode()).toBe("build");
  });

  it("hidden models default to empty and round-trip (deduped)", () => {
    expect(getStoredHiddenModels()).toEqual([]);
    setStoredHiddenModels(["openai/gpt-4o", "openai/gpt-4o", "anthropic/claude-haiku-4-5"]);
    expect(getStoredHiddenModels().sort()).toEqual(["anthropic/claude-haiku-4-5", "openai/gpt-4o"]);
  });

  it("connected subscriptions default to empty and round-trip (deduped)", () => {
    expect(getStoredConnectedSubscriptions()).toEqual([]);
    setStoredConnectedSubscriptions(["claude-sub", "claude-sub", "codex-sub"]);
    expect(getStoredConnectedSubscriptions().sort()).toEqual(["claude-sub", "codex-sub"]);
  });

  it("hidden models tolerate a corrupt blob (returns empty)", () => {
    localStorage.setItem("markdraw-ai-hidden-models", "{not json");
    expect(getStoredHiddenModels()).toEqual([]);
    localStorage.setItem("markdraw-ai-hidden-models", JSON.stringify([1, "ok", null]));
    expect(getStoredHiddenModels()).toEqual(["ok"]);
  });
});
