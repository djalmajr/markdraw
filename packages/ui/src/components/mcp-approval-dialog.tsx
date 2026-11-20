import { createSignal } from "solid-js";
import * as m from "@markdraw/i18n";
import { useLocale } from "@markdraw/i18n/solid";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";

export interface McpApprovalRequest {
  id: string;
  operation: string;
  target: string;
  summary: string;
}

export function createMcpApprovalQueue(respond: (response: { id: string; approved: boolean }) => Promise<unknown>) {
  const [current, setCurrent] = createSignal<McpApprovalRequest | null>(null);
  const queue: McpApprovalRequest[] = [];
  const seen = new Set<string>();
  function enqueue(request: McpApprovalRequest) {
    if (seen.has(request.id)) return;
    seen.add(request.id);
    queue.push(request);
    if (queue.length === 1) setCurrent(request);
  }
  function decide(id: string, approved: boolean) {
    if (queue[0]?.id !== id) return;
    const request = queue.shift()!;
    setCurrent(queue[0] ?? null);
    void respond({ id: request.id, approved }).catch(() => {});
  }
  /** The request ended without the user (deadline, queue full, cancelled): drop it, ask nothing. */
  function resolve(id: string) {
    // An id heard of only now is remembered, so a request event that arrives
    // after its own ending is not shown.
    seen.add(id);
    const index = queue.findIndex((request) => request.id === id);
    if (index < 0) return;
    queue.splice(index, 1);
    if (index === 0) setCurrent(queue[0] ?? null);
  }
  return { current, enqueue, decide, resolve };
}

export function McpApprovalDialog(props: {
  request: McpApprovalRequest | null;
  onDecide: (id: string, approved: boolean) => void;
}) {
  return (
    <AlertDialog open={!!props.request} onOpenChange={(open) => { if (!open && props.request) props.onDecide(props.request.id, false); }}>
      <AlertDialogContent>
        <AlertDialogTitle>{(useLocale(), m.mcp_approval_title())}</AlertDialogTitle>
        <AlertDialogDescription>{(useLocale(), m.mcp_approval_origin())}</AlertDialogDescription>
        <dl class="grid gap-2 text-sm break-words">
          <div><dt class="font-semibold">{(useLocale(), m.mcp_approval_operation())}</dt><dd>{props.request?.operation}</dd></div>
          <div><dt class="font-semibold">{(useLocale(), m.mcp_approval_target())}</dt><dd>{props.request?.target}</dd></div>
          <div><dt class="font-semibold">{(useLocale(), m.mcp_approval_summary())}</dt><dd>{props.request?.summary}</dd></div>
        </dl>
        <div class="flex justify-end gap-2 mt-2">
          <Button variant="outline" size="sm" onClick={() => { if (props.request) props.onDecide(props.request.id, false); }}>{(useLocale(), m.mcp_approval_deny())}</Button>
          <Button variant="default" size="sm" onClick={() => { if (props.request) props.onDecide(props.request.id, true); }} data-agent-confirm={(useLocale(), m.mcp_approval_allow())}>{(useLocale(), m.mcp_approval_allow())}</Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
