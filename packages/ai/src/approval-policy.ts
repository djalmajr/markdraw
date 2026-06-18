// Decides whether a tool call runs automatically or asks the user first
// (human-in-the-loop). This is a tiny pure policy, separate from how the prompt
// is rendered: `prompt`-tier tools are wrapped so their `execute` awaits an
// Accept/Reject before running (the omp two-tier model, applied to Markdraw).
// The wrap is applied by the ENGINE when the host passes
// `ChatOptions.onApprovalRequest` (engines/ai-sdk.ts — the single enforcement
// point); hosts that pre-wrap tools themselves keep working unchanged.
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
  /** The run's abort signal. When it fires, the gate auto-denies and hides the
   *  prompt, so Stop/clear unblock a turn waiting on an approval. */
  signal?: AbortSignal;
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
      const aborted = (): boolean => opts?.signal?.aborted === true;
      // Already stopped before we even ask -> never run the side effect.
      if (aborted()) {
        return { rejected: true, error: `The "${tool.name}" tool call was aborted.` };
      }
      const approved = await requestApproval({
        toolName: tool.name,
        source: tool.source,
        args,
        signal: opts?.signal,
      });
      // Re-check after the await: a Stop during the prompt must win over a late
      // Accept, so a side effect never fires for an abandoned turn.
      if (aborted()) {
        return { rejected: true, error: `The "${tool.name}" tool call was aborted.` };
      }
      if (!approved) {
        return { rejected: true, error: `User rejected the "${tool.name}" tool call.` };
      }
      return tool.execute(args, opts);
    },
  };
}

/** Shows the approval UI for `req` and calls `decide(approved)` exactly once
 *  (on the user's choice). Returns a cleanup that hides the UI. */
export type ApprovalPrompt = (
  req: ApprovalRequest,
  decide: (approved: boolean) => void,
) => () => void;

/**
 * Build a `requestApproval` that (1) SERIALIZES prompts FIFO so concurrent
 * prompt-tier tool calls in one model step don't clobber a single-slot UI (the
 * SDK runs a step's tools via Promise.all), and (2) auto-denies + hides on the
 * request's abort signal so Stop/clear settle a pending approval and unblock the
 * turn. The host supplies only `show` (render/hide one prompt).
 */
export function createApprovalGate(show: ApprovalPrompt): (req: ApprovalRequest) => Promise<boolean> {
  let chain: Promise<unknown> = Promise.resolve();
  return (req) => {
    const run = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (req.signal?.aborted) {
          resolve(false);
          return;
        }
        let settled = false;
        let hide: () => void = () => {};
        const settle = (approved: boolean): void => {
          if (settled) return;
          settled = true;
          req.signal?.removeEventListener("abort", onAbort);
          hide();
          resolve(approved);
        };
        const onAbort = (): void => settle(false);
        req.signal?.addEventListener("abort", onAbort, { once: true });
        hide = show(req, settle);
      });
    const result = chain.then(run);
    // Advance the queue whether the prompt resolved or threw.
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
