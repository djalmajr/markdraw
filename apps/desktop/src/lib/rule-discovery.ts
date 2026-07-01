import { invoke } from "./chaos-invoke.ts";
import {
  buildRuleContextForPrompt,
  dedupeRules,
  evaluateRuleViolations,
  ruleIdentity,
  type AIRule,
  type DiscoveredRuleFile,
  type RuleViolation,
} from "@markdraw/core/ai-rules.ts";

export type DiscoveredRuleEntry = AIRule;

export function discoverRules(roots: string[]): Promise<DiscoveredRuleFile[]> {
  return invoke<DiscoveredRuleFile[]>("rules_discover", { roots });
}

export function normalizeRules(files: DiscoveredRuleFile[]): DiscoveredRuleEntry[] {
  return dedupeRules(files);
}

export function buildRulesForPrompt(rules: DiscoveredRuleEntry[], prompt: string): string | undefined {
  return buildRuleContextForPrompt(rules, prompt);
}

export function evaluateRulesForTurn(
  rules: DiscoveredRuleEntry[],
  request: { assistantText: string; toolNames: string[]; userMessage: string },
): RuleViolation | undefined {
  return evaluateRuleViolations(rules, request);
}

export { ruleIdentity };
