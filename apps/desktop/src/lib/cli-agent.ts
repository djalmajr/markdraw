// Tauri IPC bridge for CLI subscription providers (cli_agent.rs).

import { Channel } from "@tauri-apps/api/core";
import type { AIMessage } from "@asciimark/ai/types.ts";
import type { CliHost, CliStreamEvent } from "@asciimark/ai/engine.ts";
import type { CliProviderKind } from "@asciimark/ai/cli-providers.ts";
import { invoke } from "./chaos-invoke.ts";

export interface CliDetectResult {
  found: boolean;
  path?: string;
}

export interface CliProbeResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export async function detectCliBinary(
  binary: string,
  pathOverride?: string,
): Promise<CliDetectResult> {
  return invoke<CliDetectResult>("cli_detect_binary", {
    request: { binary, pathOverride },
  });
}

export async function probeCliSubscription(
  provider: CliProviderKind,
  pathOverride?: string,
): Promise<CliProbeResult> {
  return invoke<CliProbeResult>("cli_probe_subscription", {
    request: { provider, pathOverride },
  });
}

export function createCliHost(): CliHost {
  return {
    async streamChat(request, onEvent, signal) {
      const callId = crypto.randomUUID();

      const onAbort = () => {
        void invoke("cli_chat_cancel", { callId }).catch(() => {});
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          throw new DOMException("Aborted", "AbortError");
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      const channel = new Channel<CliStreamEvent>();
      channel.onmessage = (event) => onEvent(event);

      try {
        await invoke("cli_chat_stream", {
          request: {
            provider: request.provider,
            model: request.model,
            system: request.system,
            messages: request.messages,
            pathOverride: request.pathOverride,
          },
          callId,
          onEvent: channel,
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}