// Webview E2E for the Rust MCP manager (src-tauri/src/ai_mcp.rs), driven
// through the tauri-plugin-mcp-bridge: each `bridge.invoke` goes through
// `execute_js` + `window.__TAURI_INTERNALS__.invoke()`, so the args here use
// the camelCase keys the Tauri commands expect (config, server, name, args).
//
// The server under test is the stdio fixture `e2e/fixtures/mcp-echo-server.mjs`
// — a newline-delimited JSON-RPC 2.0 MCP server exposing two tools (echo, add)
// that the manager spawns via `node`. This covers the full loop the AI chat
// relies on: connect (spawn + initialize + tools/list), tool discovery,
// tools/call result flattening, and the not-connected error path.
//
// Skips silently when the MCP bridge is unreachable (no `bun run dev:app`
// running) — same pattern as the other webview specs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { connectBridge, type Bridge } from "../bridge.ts";

// Absolute path to the stdio fixture (e2e/specs -> ../fixtures). Normalized to
// forward slashes so Windows backslashes survive the two JSON.stringify hops
// (bridge script construction + WebSocket framing) without escaping surprises.
const FIXTURE = resolve(import.meta.dir, "../fixtures/mcp-echo-server.mjs").replace(/\\/g, "/");

const SERVER_ID = "e2e-echo";

interface McpServerStatus {
  connected: boolean;
  id: string;
  toolCount: number;
}

interface McpToolInfo {
  description?: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[]; type?: string };
  name: string;
  server: string;
}

let bridge: Bridge | null = null;

beforeAll(async () => {
  try {
    bridge = await connectBridge();
  } catch (err) {
    console.warn(
      `[e2e/webview] tauri-mcp-bridge unreachable — skipping. Start \`bun run dev:app\` first. Error: ${(err as Error).message}`,
    );
  }
});

afterAll(async () => {
  if (bridge) {
    // Tear the fixture server down so a re-run starts from a clean manager.
    // Ignore errors — the disconnect test path may already have removed it,
    // or the connect test may have skipped.
    await bridge.invoke("ai_mcp_disconnect", { id: SERVER_ID }).catch(() => {});
    bridge.close();
  }
});

describe("MCP manager (stdio)", () => {
  test("connects a stdio server and lists its tools", async () => {
    if (!bridge) return;

    // Connect spawns `node <fixture>`, runs the MCP initialize handshake and
    // caches tools/list. Node startup takes a moment; the bridge's default
    // 10s send timeout covers it comfortably.
    const status = (await bridge.invoke("ai_mcp_connect", {
      config: {
        id: SERVER_ID,
        transport: "stdio",
        command: "node",
        args: [FIXTURE],
      },
    })) as McpServerStatus;
    expect(status).toEqual({ id: SERVER_ID, connected: true, toolCount: 2 });

    const tools = (await bridge.invoke("ai_mcp_list_tools")) as McpToolInfo[];
    const echo = tools.find((t) => t.server === SERVER_ID && t.name === "echo");
    const add = tools.find((t) => t.server === SERVER_ID && t.name === "add");

    expect(echo).toBeDefined();
    expect(typeof echo!.inputSchema).toBe("object");
    expect(echo!.inputSchema.type).toBe("object");
    expect(echo!.inputSchema.required).toEqual(["text"]);

    expect(add).toBeDefined();
    expect(typeof add!.inputSchema).toBe("object");
    expect(add!.inputSchema.type).toBe("object");
    expect(add!.inputSchema.required).toEqual(["a", "b"]);
  });

  test("calls echo and add tools", async () => {
    if (!bridge) return;

    // The Rust manager flattens a single text content block to a plain
    // string, parsing JSON when it round-trips (parse_text_or_json). So echo
    // comes back as the string "ola"…
    const echoed = await bridge.invoke("ai_mcp_call_tool", {
      server: SERVER_ID,
      name: "echo",
      args: { text: "ola" },
    });
    expect(echoed).toBe("ola");

    // …while add's text block "5" parses as JSON and lands as the NUMBER 5.
    const sum = await bridge.invoke("ai_mcp_call_tool", {
      server: SERVER_ID,
      name: "add",
      args: { a: 2, b: 3 },
    });
    expect(sum).toBe(5);
  });

  test("errors cleanly for an unknown server", async () => {
    if (!bridge) return;

    // ai_mcp_call_tool rejects with "MCP server not connected: <id>"; the
    // bridge surfaces it through the __mcp_error__ wrapper as an Error whose
    // message keeps the original text.
    await expect(
      bridge.invoke("ai_mcp_call_tool", {
        server: "nope",
        name: "echo",
        args: { text: "ola" },
      }),
    ).rejects.toThrow(/not connected/);
  });
});
