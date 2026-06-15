// Engine registry: turns an engine id + resolved model + credential resolver
// into a concrete AIProvider. Engines are loaded lazily INSIDE the provider's
// methods so this factory stays synchronous (the chat store's `getProvider()`
// is sync) and the heavy SDK code is only imported for the engine actually used.

import type {
  AIEngine,
  AIEngineId,
  AIEngineOptions,
  CredentialResolver,
} from "./engine.ts";
import type { ResolvedModel } from "./resolve-model.ts";
import type {
  AIMessage,
  AIProvider,
  AIStreamPart,
  ChatOptions,
  CompleteOptions,
} from "./types.ts";

async function loadEngine(id: AIEngineId): Promise<AIEngine> {
  switch (id) {
    case "ai-sdk":
      return (await import("./engines/ai-sdk.ts")).aiSdkEngine;
    case "tanstack":
      return (await import("./engines/tanstack.ts")).tanstackEngine;
    case "claude-cli":
      return (await import("./engines/cli-bridge.ts")).claudeCliEngine;
    case "codex-cli":
      return (await import("./engines/cli-bridge.ts")).codexCliEngine;
    case "grok-cli":
      return (await import("./engines/cli-bridge.ts")).grokCliEngine;
    case "antigravity-cli":
      return (await import("./engines/cli-bridge.ts")).antigravityCliEngine;
  }
}

/** Build a provider for the given engine. Construction is synchronous; the
 *  engine module (and its SDK) is dynamically imported on first use. */
export function createProvider(
  engineId: AIEngineId,
  resolved: ResolvedModel,
  getApiKey: CredentialResolver,
  engineOpts?: AIEngineOptions,
): AIProvider {
  async function* chat(
    messages: AIMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<AIStreamPart> {
    const engine = await loadEngine(engineId);
    yield* engine.createProvider(resolved, getApiKey, engineOpts).chat(messages, opts);
  }

  async function complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    const engine = await loadEngine(engineId);
    return engine.createProvider(resolved, getApiKey, engineOpts).complete(prompt, opts);
  }

  async function embed(text: string | string[]): Promise<number[][]> {
    const engine = await loadEngine(engineId);
    return engine.createProvider(resolved, getApiKey, engineOpts).embed(text);
  }

  return { chat, complete, embed };
}
