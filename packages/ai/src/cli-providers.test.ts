import { describe, expect, it } from "bun:test";
import {
  ANTIGRAVITY_SUB_PROVIDER_ID,
  CLAUDE_SUB_PROVIDER_ID,
  cliBinaryName,
  CODEX_SUB_PROVIDER_ID,
  GROK_SUB_PROVIDER_ID,
  isCliProviderKind,
  isCliSubscriptionProviderId,
  resolveEngineIdForKind,
} from "./cli-providers.ts";

describe("cli-providers", () => {
  it("identifies CLI subscription provider ids", () => {
    expect(isCliSubscriptionProviderId(CLAUDE_SUB_PROVIDER_ID)).toBe(true);
    expect(isCliSubscriptionProviderId(CODEX_SUB_PROVIDER_ID)).toBe(true);
    expect(isCliSubscriptionProviderId(GROK_SUB_PROVIDER_ID)).toBe(true);
    expect(isCliSubscriptionProviderId(ANTIGRAVITY_SUB_PROVIDER_ID)).toBe(true);
    expect(isCliSubscriptionProviderId("anthropic")).toBe(false);
  });

  it("maps kinds to CLI engines", () => {
    expect(isCliProviderKind("claude-cli")).toBe(true);
    expect(isCliProviderKind("codex-cli")).toBe(true);
    expect(isCliProviderKind("grok-cli")).toBe(true);
    expect(isCliProviderKind("antigravity-cli")).toBe(true);
    expect(isCliProviderKind("anthropic")).toBe(false);
    expect(resolveEngineIdForKind("claude-cli")).toBe("claude-cli");
    expect(resolveEngineIdForKind("codex-cli")).toBe("codex-cli");
    expect(resolveEngineIdForKind("grok-cli")).toBe("grok-cli");
    expect(resolveEngineIdForKind("antigravity-cli")).toBe("antigravity-cli");
    expect(resolveEngineIdForKind("openai")).toBe("ai-sdk");
  });

  it("maps kinds to CLI binary names", () => {
    expect(cliBinaryName("claude-cli")).toBe("claude");
    expect(cliBinaryName("codex-cli")).toBe("codex");
    expect(cliBinaryName("grok-cli")).toBe("grok");
    expect(cliBinaryName("antigravity-cli")).toBe("agy");
  });
});