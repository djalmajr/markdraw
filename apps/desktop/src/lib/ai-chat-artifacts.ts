import { invoke } from "./chaos-invoke.ts";
import type { PersistedToolActivity } from "@markdraw/core/ai-chat-sessions.ts";

type ChatArtifactRef = NonNullable<PersistedToolActivity["resultArtifact"]>;

interface ArtifactWriteResult {
  byteLength: number;
  path: string;
}

function safeId(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "artifact";
}

function artifactId(input: { title: string; toolCallId?: string }): string {
  const base = safeId(input.toolCallId ?? input.title);
  return `${Date.now().toString(36)}-${base}`;
}

export async function writeChatArtifact(input: {
  content: string;
  kind: ChatArtifactRef["kind"];
  mime: string;
  sessionId: string;
  title: string;
  toolCallId?: string;
}): Promise<ChatArtifactRef> {
  const id = artifactId(input);
  const result = await invoke<ArtifactWriteResult>("ai_artifact_write", {
    artifactId: id,
    content: input.content,
    sessionId: input.sessionId,
  });
  return {
    byteLength: result.byteLength,
    id,
    kind: input.kind,
    mime: input.mime,
    preview: input.content.slice(0, 2_000),
    title: input.title,
  };
}

export async function copyChatArtifacts(sourceSessionId: string, targetSessionId: string): Promise<void> {
  await invoke("ai_artifact_copy_session", { sourceSessionId, targetSessionId });
}

export async function deleteChatArtifacts(sessionId: string): Promise<void> {
  await invoke("ai_artifact_delete_session", { sessionId });
}
