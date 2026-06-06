// Thin client for the tauri-plugin-mcp-bridge WebSocket protocol.
// The app actually binds the bridge on 127.0.0.1:9223 (lib.rs `.base_port(9223)`,
// the plugin default). This client deliberately DEFAULTS to 9233 — a port the
// app never binds — so that a bare `bun test` (no orchestration) can't reach a
// bridge and the integration specs skip themselves. The real runs go through
// `scripts/run-e2e.sh`, which spawns the app and exports TAURI_MCP_BRIDGE_PORT=9223
// so this client connects to it. Each request is a JSON object
// { id, command, args }; each response is { id, success, data | error }.
//
// We need this client because the plugin only routes a fixed set of
// `plugin:mcp-bridge|*` Tauri commands — it does NOT proxy arbitrary app
// commands. To exercise our own backend (`read_dir`, `read_file_relative`,
// `trash_path`, …) we go through `execute_js` and call
// `window.__TAURI_INTERNALS__.invoke()` from the webview.

let messageCounter = 0;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

export interface Bridge {
  send: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  invoke: (tauriCommand: string, args?: Record<string, unknown>) => Promise<unknown>;
  evalJs: (script: string) => Promise<unknown>;
  emit: (eventName: string, payload?: unknown) => Promise<unknown>;
  close: () => void;
}

/**
 * Connect to the MCP bridge on a fixed port and resolve when a handshake
 * round-trip succeeds. Defaults to 127.0.0.1:9233 (an unbound port, so bare
 * test runs skip) — run-e2e.sh overrides it to 9223 via env
 * vars TAURI_MCP_BRIDGE_HOST / TAURI_MCP_BRIDGE_PORT.
 *
 * Performs a `list_windows` round-trip during connect so we don't return a
 * Bridge bound to some other process that happens to accept WebSocket
 * connections (e.g., Node's --inspect on 9229).
 */
export async function connectBridge(opts?: {
  host?: string;
  port?: number;
  handshakeTimeoutMs?: number;
}): Promise<Bridge> {
  const host = opts?.host ?? process.env.TAURI_MCP_BRIDGE_HOST ?? "127.0.0.1";
  const port = opts?.port ?? Number(process.env.TAURI_MCP_BRIDGE_PORT ?? 9233);
  const handshakeTimeoutMs = opts?.handshakeTimeoutMs ?? 1500;
  return tryConnect(`ws://${host}:${port}`, handshakeTimeoutMs);
}

function tryConnect(url: string, handshakeTimeoutMs: number): Promise<Bridge> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map<string, PendingRequest>();
    let connected = false;

    const giveUp = setTimeout(() => {
      if (!connected) {
        ws.close();
        reject(new Error(`timeout connecting to ${url}`));
      }
    }, handshakeTimeoutMs);

    ws.onerror = () => {
      if (!connected) {
        clearTimeout(giveUp);
        reject(new Error(`ws error on ${url}`));
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      let parsed: { id?: string; success?: boolean; data?: unknown; error?: string };
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (!parsed.id) return; // broadcast event, not a response — ignore
      const req = pending.get(parsed.id);
      if (!req) return;
      pending.delete(parsed.id);
      if (parsed.success) req.resolve(parsed.data);
      else req.reject(new Error(parsed.error ?? "unknown bridge error"));
    };

    const send = (
      command: string,
      args: Record<string, unknown> = {},
      timeoutMs = 10_000,
    ): Promise<unknown> => {
      const id = `req-${++messageCounter}`;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, command, args }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`bridge timeout for ${command}`));
          }
        }, timeoutMs);
      });
    };

    ws.onopen = async () => {
      // Handshake: ask for the window list. The MCP bridge always responds
      // (even if there are zero windows). A non-bridge server on the same
      // port either won't respond in JSON or won't respond at all.
      try {
        await send("list_windows", {}, handshakeTimeoutMs);
      } catch (err) {
        clearTimeout(giveUp);
        ws.close();
        reject(
          new Error(
            `${url} accepted WS but failed handshake (not the MCP bridge?): ${(err as Error).message}`,
          ),
        );
        return;
      }

      connected = true;
      clearTimeout(giveUp);

      const invoke = async (
        tauriCommand: string,
        args: Record<string, unknown> = {},
      ): Promise<unknown> => {
        const script = `(async () => { return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(tauriCommand)}, ${JSON.stringify(args)}); })()`;
        const result = await send("execute_js", { script });
        if (result && typeof result === "object" && "__mcp_error__" in result) {
          throw new Error(
            `tauri invoke ${tauriCommand} failed: ${(result as { __mcp_error__: string }).__mcp_error__}`,
          );
        }
        return result;
      };

      const evalJs = (script: string) => send("execute_js", { script });

      const emit = (eventName: string, payload: unknown = null) =>
        send("invoke_tauri", {
          command: "plugin:mcp-bridge|emit_event",
          args: { eventName, payload },
        });

      const close = () => {
        ws.close();
      };

      resolve({ send, invoke, evalJs, emit, close });
    };
  });
}
