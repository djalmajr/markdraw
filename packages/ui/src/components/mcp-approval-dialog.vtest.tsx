import { flush } from "solid-js";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent } from "@ui-sdk/solid/agent";
import { createMcpApprovalQueue, McpApprovalDialog } from "./mcp-approval-dialog.tsx";

afterEach(cleanup);
const agent = createAgent({ allow: (step) => !step.confirm });

it("queues requests, permits once, refuses, and dismisses as refusal", async () => {
  const respond = vi.fn(async (_response: { id: string; approved: boolean }) => {});
  let queue!: ReturnType<typeof createMcpApprovalQueue>;
  render(() => {
    queue = createMcpApprovalQueue(respond);
    return <McpApprovalDialog request={queue.current()} onDecide={queue.decide} />;
  });
  queue.enqueue({ id: "a", operation: "write", target: "one.md", summary: "first" });
  queue.enqueue({ id: "b", operation: "delete", target: "two.md", summary: "second" });
  queue.enqueue({ id: "c", operation: "move", target: "three.md", summary: "third" });
  queue.enqueue({ id: "a", operation: "write", target: "one.md", summary: "duplicate" });
  flush();
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.queryByText("second")).toBeNull();
  expect(screen.getByText("Authenticated local MCP client")).toBeTruthy();
  const labels = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== "more").map((entry) => entry.label);
  expect(labels).toContain("Allow once");
  expect(labels).toContain("Deny");
  const rejected = await agent.act({ steps: [{ ref: "Allow once", action: "press" }] });
  expect(rejected.ok).toBe(false);
  expect(respond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  queue.decide("a", false);
  flush();
  expect(respond.mock.calls).toEqual([[{ id: "a", approved: true }]]);
  expect(screen.getByText("second")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  flush();
  expect(screen.getByText("third")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  flush();
  expect(respond.mock.calls).toEqual([[{ id: "a", approved: true }], [{ id: "b", approved: false }], [{ id: "c", approved: false }]]);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("drops a request the server ended, whether it is on screen or still waiting", () => {
  const respond = vi.fn(async (_response: { id: string; approved: boolean }) => {});
  let queue!: ReturnType<typeof createMcpApprovalQueue>;
  render(() => {
    queue = createMcpApprovalQueue(respond);
    return <McpApprovalDialog request={queue.current()} onDecide={queue.decide} />;
  });
  queue.enqueue({ id: "a", operation: "write", target: "one.md", summary: "first" });
  queue.enqueue({ id: "b", operation: "delete", target: "two.md", summary: "second" });
  queue.enqueue({ id: "c", operation: "move", target: "three.md", summary: "third" });
  flush();
  expect(screen.getByText("first")).toBeTruthy();
  // A waiting one expires: the one on screen stays.
  queue.resolve("b");
  flush();
  expect(screen.getByText("first")).toBeTruthy();
  // The one on screen is cancelled: the next waiting one is shown, nothing is answered.
  queue.resolve("a");
  flush();
  expect(screen.getByText("third")).toBeTruthy();
  expect(screen.queryByText("first")).toBeNull();
  // A late request event for an ended id is not shown again.
  queue.enqueue({ id: "a", operation: "write", target: "one.md", summary: "first" });
  flush();
  expect(screen.queryByText("first")).toBeNull();
  // Ending the last one closes the dialog; an unknown id changes nothing.
  queue.resolve("zzz");
  queue.resolve("c");
  flush();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(respond).not.toHaveBeenCalled();
  // A request that ended before it was heard is never shown.
  queue.resolve("early");
  queue.enqueue({ id: "early", operation: "write", target: "x.md", summary: "early" });
  flush();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
