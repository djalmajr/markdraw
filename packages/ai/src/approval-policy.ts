// Decides whether a tool call runs automatically or asks the user first
// (human-in-the-loop). This is a tiny pure policy, separate from how the prompt
// is rendered: the host wraps `prompt`-tier tools so their `execute` awaits an
// Accept/Reject before running (the omp two-tier model, applied to AsciiMark).
//
// Why a default policy instead of requiring every tool to declare a tier: MCP
// servers expose arbitrary tools we don't control, so the safe default for an
// unknown/MCP tool is to PROMPT. In-process app tools are ours and known-safe
// (reads; the edit tool runs its own Accept/Reject), so they auto-run.

import type { AITool, ApprovalTier } from "./types.ts";

/**
 * Resolve the approval tier for a tool. Precedence:
 *   1. an explicit `tool.approval`,
 *   2. in-process app tools (`source === "app"`) auto-run (reads are safe; the
 *      edit tool self-gates),
 *   3. everything else — notably arbitrary MCP/unknown tools — prompts.
 * The fallback is the safe one (`"prompt"`).
 */
export function resolveApprovalTier(tool: AITool): ApprovalTier {
  if (tool.approval) return tool.approval;
  if (tool.source === "app") return "auto";
  return "prompt";
}

/** Convenience: does this tool need a user prompt before running? */
export function needsApproval(tool: AITool): boolean {
  return resolveApprovalTier(tool) === "prompt";
}

/** What the host's approval prompt is shown about. */
export interface ApprovalRequest {
  toolName: string;
  source?: string;
  args: unknown;
}

/**
 * Wrap a tool so a `prompt`-tier call first awaits `requestApproval`. On a
 * rejection it returns a model-visible `{ rejected: true, error }` result
 * instead of executing — the model sees the refusal and can adapt, and no side
 * effect fires. `auto`-tier tools are returned unchanged (no wrapper cost).
 *
 * This is the execute-wrapper approach: it works on the current non-streaming
 * `generateText` path with no dependency on the SDK's loop-level approval, so
 * human-in-the-loop ships today regardless of the streaming work.
 */
export function withApproval(
  tool: AITool,
  requestApproval: (req: ApprovalRequest) => Promise<boolean>,
): AITool {
  if (!needsApproval(tool)) return tool;
  return {
    ...tool,
    execute: async (args, opts) => {
      const approved = await requestApproval({
        toolName: tool.name,
        source: tool.source,
        args,
      });
      if (!approved) {
        return { rejected: true, error: `User rejected the "${tool.name}" tool call.` };
      }
      return tool.execute(args, opts);
    },
  };
}
