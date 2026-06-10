// Deterministic MCP server over stdio for the e2e specs. Speaks newline-
// delimited JSON-RPC 2.0 (MCP stdio framing — one JSON object per line, no
// Content-Length headers) and exposes two trivial tools (`echo`, `add`) so the
// Rust rmcp client can be exercised without downloading a real server from the
// network in tests. Plain Node ESM, zero dependencies; run with
// `node mcp-echo-server.mjs`. Stdout carries ONLY JSON-RPC lines — any debug
// output goes to stderr.

import { createInterface } from "node:readline";

const SERVER_INFO = { name: "mcp-echo-fixture", version: "1.0.0" };
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the provided text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === "echo") {
    sendResult(id, { content: [{ type: "text", text: args.text }] });
    return;
  }

  if (name === "add") {
    sendResult(id, { content: [{ type: "text", text: String(args.a + args.b) }] });
    return;
  }

  sendResult(id, { isError: true, content: [{ type: "text", text: "unknown tool" }] });
}

function handleMessage(message) {
  const { id, method, params } = message;

  // Notifications (no id) carry no reply — `notifications/initialized` included.
  if (id === undefined || id === null) {
    return;
  }

  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      break;
    case "tools/call":
      handleToolCall(id, params);
      break;
    case "ping":
      sendResult(id, {});
      break;
    default:
      sendError(id, -32601, "method not found");
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stderr.write(`mcp-echo-fixture: ignoring unparseable line\n`);
    return;
  }

  try {
    handleMessage(message);
  } catch (err) {
    process.stderr.write(`mcp-echo-fixture: handler error: ${err}\n`);
  }
});

rl.on("close", () => {
  process.exit(0);
});
