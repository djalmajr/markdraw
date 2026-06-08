// Serialize an AI chat transcript to Markdown for the "Export" tab action.
// Pure (no Date / no IO) so it's trivially testable; the host adds the
// timestamped filename and writes the file.

import type { ChatTurn } from "../composables/create-ai-chat-store.ts";

const ROLE_HEADING: Record<ChatTurn["role"], string> = {
  user: "You",
  assistant: "Assistant",
};

/** Render a chat's turns as a readable Markdown transcript. */
export function formatChatTranscript(title: string, turns: ChatTurn[]): string {
  const lines: string[] = [`# ${title.trim() || "Chat"}`, ""];
  for (const turn of turns) {
    lines.push(`## ${ROLE_HEADING[turn.role]}`, "");
    if (turn.content.trim()) lines.push(turn.content.trimEnd(), "");
    if (turn.tools?.length) {
      for (const t of turn.tools) {
        const src = t.source && t.source !== "app" ? ` · ${t.source}` : "";
        lines.push(`- 🛠 \`${t.toolName}\`${src} — ${t.status}`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Filesystem-safe slug for a chat title (used in the export filename). */
export function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "chat";
}
