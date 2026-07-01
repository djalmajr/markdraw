import { djb2 } from "./hash.ts";

export type RuleScope = "global" | "project";
export type RuleSource = "markdraw" | "agents" | "claude" | "codex" | "cursor" | "windsurf" | "cline";

export interface DiscoveredRuleFile {
  alwaysApply?: boolean;
  condition?: string;
  content: string;
  description?: string;
  globs?: string[];
  name: string;
  root?: string;
  scope: RuleScope;
  source: RuleSource;
  sourcePath: string;
}

export interface AIRule {
  alwaysApply: boolean;
  condition?: string;
  content: string;
  contentHash: string;
  description?: string;
  globs: string[];
  id: string;
  name: string;
  root?: string;
  scope: RuleScope;
  source: RuleSource;
  sources: Array<{ active: boolean; path: string; scope: RuleScope; source: RuleSource }>;
}

export interface RuleViolation {
  message: string;
  reminder: string;
  rule: AIRule;
  signature: string;
}

export interface RuleTurnRequest {
  assistantText: string;
  toolNames: string[];
  userMessage: string;
}

const RULE_CONTEXT_CAP = 12_000;
/** Upper bound on how many rule blocks are injected, so an unbounded number of
 *  always-apply rules can't defeat RULE_CONTEXT_CAP. */
const MAX_RULE_BLOCKS = 16;
const SELECTED_RULE_CAP = 3;

export function ruleIdentity(rule: { name: string }): string {
  return rule.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sourcePriority(rule: Pick<DiscoveredRuleFile, "scope" | "source" | "sourcePath">): string {
  const scope = rule.scope === "project" ? 0 : 1;
  const sourceOrder: Record<RuleSource, number> = {
    markdraw: 0,
    codex: 1,
    agents: 2,
    claude: 3,
    cursor: 4,
    windsurf: 5,
    cline: 6,
  };
  return `${scope}:${sourceOrder[rule.source] ?? 99}:${rule.sourcePath}`;
}

function sourceOf(rule: DiscoveredRuleFile, active: boolean): AIRule["sources"][number] {
  return { active, path: rule.sourcePath, scope: rule.scope, source: rule.source };
}

export function dedupeRules(files: DiscoveredRuleFile[]): AIRule[] {
  const byIdentity = new Map<string, AIRule>();
  const activePriority = new Map<string, string>();
  for (const file of files) {
    const identity = ruleIdentity(file);
    if (!identity) continue;
    const nextPriority = sourcePriority(file);
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, {
        alwaysApply: file.alwaysApply === true,
        condition: file.condition,
        content: file.content,
        contentHash: djb2(file.content),
        description: file.description,
        globs: file.globs ?? [],
        id: `rule:${djb2(identity)}`,
        name: file.name,
        root: file.root,
        scope: file.scope,
        source: file.source,
        sources: [sourceOf(file, true)],
      });
      activePriority.set(identity, nextPriority);
      continue;
    }
    const currentPriority = activePriority.get(identity) ?? "";
    const shouldReplace = nextPriority < currentPriority;
    existing.sources.push(sourceOf(file, shouldReplace));
    if (!shouldReplace) continue;
    for (const source of existing.sources) source.active = source.path === file.sourcePath;
    existing.alwaysApply = file.alwaysApply === true;
    existing.condition = file.condition;
    existing.content = file.content;
    existing.contentHash = djb2(file.content);
    existing.description = file.description ?? existing.description;
    existing.globs = file.globs ?? [];
    existing.name = file.name;
    existing.root = file.root;
    existing.scope = file.scope;
    existing.source = file.source;
    activePriority.set(identity, nextPriority);
  }
  return [...byIdentity.values()].sort((a, b) => ruleIdentity(a).localeCompare(ruleIdentity(b)));
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9:_-]*/g)
      ?.filter((word) => word.length >= 3) ?? [],
  );
}

function scoreRule(rule: AIRule, prompt: string): number {
  const lower = prompt.toLowerCase();
  const identity = ruleIdentity(rule);
  let score = 0;
  if (lower.includes(`#${identity}`)) score += 1000;
  if (lower.includes(identity)) score += 80;
  const promptWords = words(prompt);
  for (const term of words(`${rule.name} ${rule.description ?? ""}`)) {
    if (promptWords.has(term)) score += 10;
  }
  return score;
}

export function selectRulesForPrompt(rules: AIRule[], prompt: string): AIRule[] {
  return rules
    .filter((rule) => !rule.alwaysApply)
    .map((rule) => ({ rule, score: scoreRule(rule, prompt) }))
    .filter((entry) => entry.score >= 10)
    .sort((a, b) => b.score - a.score || ruleIdentity(a.rule).localeCompare(ruleIdentity(b.rule)))
    .slice(0, SELECTED_RULE_CAP)
    .map((entry) => entry.rule);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 28)).trimEnd()}\n[rule content truncated]`;
}

export function buildRuleContextForPrompt(rules: AIRule[], prompt: string): string | undefined {
  const selected = [
    ...rules.filter((rule) => rule.alwaysApply),
    ...selectRulesForPrompt(rules, prompt),
  ];
  const unique = [...new Map(selected.map((rule) => [rule.id, rule])).values()];
  if (unique.length === 0) return undefined;
  // Hard-cap BOTH the block count and the total size. The old `max(800, cap/n)`
  // per-rule floor let an unbounded number of always-apply rules blow past
  // RULE_CONTEXT_CAP (800 × n); enforce a running byte budget instead.
  const capped = unique.slice(0, MAX_RULE_BLOCKS);
  const perRule = Math.max(400, Math.floor(RULE_CONTEXT_CAP / capped.length));
  const blocks: string[] = [];
  let used = 0;
  for (const rule of capped) {
    if (used >= RULE_CONTEXT_CAP) break;
    const budget = Math.min(perRule, RULE_CONTEXT_CAP - used);
    const block = [
      `--- rule: ${rule.name} (${rule.source}/${rule.scope}) ---`,
      truncate(rule.content.trim(), budget),
    ].join("\n");
    blocks.push(block);
    used += block.length;
  }
  return [
    "[Markdraw rules]",
    "Follow these sticky rules when they are relevant. Rules are discovered from Markdraw and local agent config files.",
    ...blocks,
    "[/Markdraw rules]",
  ].join("\n\n");
}

const RULE_CONDITION_MAX_LENGTH = 1_000;
const RULE_HAYSTACK_MAX_LENGTH = 20_000;

/** Whether two branch "first atoms" can match a common first character. Plain
 *  literals overlap only when equal; anything non-literal (escape `\d`, class
 *  `[...]`, `.`, a nested group, or an empty branch) is treated as overlapping
 *  — conservative on purpose (fail toward flagging untrusted patterns). */
function firstAtomsOverlap(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  const special = (s: string): boolean => "\\[.(".includes(s[0] ?? "");
  if (special(a) || special(b)) return true;
  return a === b;
}

/**
 * Linear-time, FAIL-CLOSED heuristic that flags regex patterns prone to
 * catastrophic (exponential) backtracking — ReDoS. Rule `condition`s come from
 * untrusted rule-file frontmatter and are `test()`ed SYNCHRONOUSLY on the UI
 * thread, so a flagged pattern is skipped rather than run.
 *
 * Catches both classic families:
 *  1. Nested quantifiers — an unbounded quantifier on a group whose body itself
 *     repeats: `(a+)+`, `(a*)*`, `(a?)+`.
 *  2. Overlapping alternation under an unbounded quantifier — `(a|a)*`,
 *     `(-|-)*z`, `(\d|\d\d)*` (branches that can start on the same character,
 *     giving exponentially many match paths).
 *
 * Bounded quantifiers (`{n}`, `{n,m}`, `?`) never trigger it, so `(a{2})+` and
 * `created? no tool` are evaluated normally. It is intentionally conservative:
 * a safe-but-complex pattern may be skipped, which only means a rare rule does
 * not trigger — strictly safer than hanging the app.
 */
function isCatastrophicRegex(pattern: string): boolean {
  interface Branch {
    first: string | null;
    canRepeat: boolean;
  }
  interface GroupAtom {
    kind: "group";
    overlap: boolean;
    branchCount: number;
    canRepeat: boolean;
  }
  type Atom = GroupAtom | { kind: "simple"; first: string };
  interface Frame {
    branches: Branch[];
    cur: Branch;
    lastAtom: Atom | null;
  }
  const newFrame = (): Frame => ({ branches: [], cur: { first: null, canRepeat: false }, lastAtom: null });
  const stack: Frame[] = [newFrame()];
  const pushAtom = (frame: Frame, atom: Atom): void => {
    if (frame.cur.first === null) frame.cur.first = atom.kind === "group" ? "(" : atom.first;
    frame.lastAtom = atom;
  };

  for (let i = 0; i < pattern.length; i += 1) {
    const top = stack[stack.length - 1]!;
    const ch = pattern[i]!;
    if (ch === "\\") {
      pushAtom(top, { kind: "simple", first: `\\${pattern[i + 1] ?? ""}` });
      i += 1;
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
      pushAtom(top, { kind: "simple", first: "[" });
      i = j;
      continue;
    }
    if (ch === "(") {
      // Skip a group prefix (?:  (?=  (?!  (?<=  (?<!  (?<name>) so it is not
      // parsed as content; the group itself is still analysed.
      if (pattern[i + 1] === "?") {
        if (pattern[i + 2] === "<" && pattern[i + 3] !== "=" && pattern[i + 3] !== "!") {
          let j = i + 2;
          while (j < pattern.length && pattern[j] !== ">") j += 1;
          i = j;
        } else if (pattern[i + 2] === "<") {
          i += 3;
        } else {
          i += 2;
        }
      }
      stack.push(newFrame());
      continue;
    }
    if (ch === ")") {
      if (stack.length === 1) continue; // stray ) — treat as no-op
      const g = stack.pop()!;
      g.branches.push(g.cur);
      const firsts = g.branches.map((b) => b.first);
      let overlap = false;
      for (let a = 0; a < firsts.length && !overlap; a += 1) {
        for (let b = a + 1; b < firsts.length; b += 1) {
          if (firstAtomsOverlap(firsts[a]!, firsts[b]!)) {
            overlap = true;
            break;
          }
        }
      }
      pushAtom(stack[stack.length - 1]!, {
        kind: "group",
        overlap,
        branchCount: g.branches.length,
        canRepeat: g.branches.some((b) => b.canRepeat),
      });
      continue;
    }
    if (ch === "|") {
      top.branches.push(top.cur);
      top.cur = { first: null, canRepeat: false };
      top.lastAtom = null;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "{" || ch === "?") {
      let unbounded = ch === "*" || ch === "+";
      if (ch === "{") {
        let j = i + 1;
        while (j < pattern.length && pattern[j] !== "}") j += 1;
        const body = pattern.slice(i + 1, j);
        unbounded = /^\d*,$/.test(body); // {n,} is unbounded; {n} / {n,m} are not
        i = j;
      }
      if (unbounded) {
        top.cur.canRepeat = true;
        const atom = top.lastAtom;
        if (atom && atom.kind === "group") {
          if (atom.canRepeat) return true; // nested quantifier
          if (atom.branchCount >= 2 && atom.overlap) return true; // overlapping alternation
        }
      }
      continue;
    }
    pushAtom(top, { kind: "simple", first: ch });
  }
  return false;
}

export function evaluateRuleViolations(rules: AIRule[], request: RuleTurnRequest): RuleViolation | undefined {
  const haystack = [request.userMessage, request.assistantText, request.toolNames.join(" ")]
    .join("\n")
    .slice(0, RULE_HAYSTACK_MAX_LENGTH);
  for (const rule of rules) {
    if (!rule.condition) continue;
    if (rule.condition.length > RULE_CONDITION_MAX_LENGTH) continue;
    if (isCatastrophicRegex(rule.condition)) continue;
    let regex: RegExp;
    try {
      regex = new RegExp(rule.condition, "iu");
    } catch {
      continue;
    }
    if (!regex.test(haystack)) continue;
    const message = `Rule "${rule.name}" was triggered. Retry with the rule reminder applied.`;
    return {
      message,
      reminder: [`[Rule reminder: ${rule.name}]`, rule.content.trim(), `[/Rule reminder: ${rule.name}]`].join("\n"),
      rule,
      signature: `${rule.id}:${rule.contentHash}`,
    };
  }
  return undefined;
}
