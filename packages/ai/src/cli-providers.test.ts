import { describe, expect, it } from "bun:test";
import {
  CLAUDE_SUB_PROVIDER_ID,
  CODEX_SUB_PROVIDER_ID,
  isCliProviderKind,
  isCliSubscriptionProviderId,
  resolveEngineIdForKind,
} from "./cli-providers.ts";

describe("cli-providers", () => {
  it("identifies CLI subscription provider ids", () => {
    expect(isCliSubscriptionProviderId(CLAUDE_SUB_PROVIDER_ID)).toBe(true);
    expect(isCliSubscriptionProviderId(CODEX_SUB_PROVIDER_ID)).toBe(true);
    expect(isCliSubscriptionProviderId("anthropic")).toBe(false);
  });

  it("maps kinds to CLI engines", () => {
    expect(isCliProviderKind("claude-cli")).toBe(true);
    expect(isCliProviderKind("codex-cli")).toBe(true);
    expect(isCliProviderKind("anthropic")).toBe(false);
    expect(resolveEngineIdForKind("claude-cli")).toBe("claude-cli");
    expect(resolveEngineIdForKind("codex-cli")).toBe("codex-cli");
    expect(resolveEngineIdForKind("openai")).toBe("ai-sdk");
  });
});