// Serialize an AI chat transcript to Markdown for the "Export" tab action.
// Pure (no Date / no IO) so it's trivially testable; the host adds the
// timestamped filename and writes the file.

import type { ChatTurn } from "../composables/create-ai-chat-store.ts";
import { renderChatMarkdown } from "./chat-markdown.ts";

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatToolSummary(turn: ChatTurn): string {
  if (!turn.tools?.length) return "";
  const items = turn.tools
    .map((tool) => {
      const source = tool.source && tool.source !== "app" ? ` · ${tool.source}` : "";
      const artifact = tool.resultArtifact ? ` · artifact ${tool.resultArtifact.id}` : "";
      return `<li><code>${escapeHtml(tool.toolName)}</code>${escapeHtml(source)} — ${escapeHtml(tool.status)}${escapeHtml(artifact)}</li>`;
    })
    .join("");
  return `<ul class="tools">${items}</ul>`;
}

function formatAdvisorNotes(turn: ChatTurn): string {
  if (!turn.advisorNotes?.length) return "";
  const items = turn.advisorNotes
    .map(
      (note) =>
        `<div class="advisor advisor-${note.severity}"><strong>${escapeHtml(note.title ?? "Advisor")}</strong><span>${escapeHtml(note.message)}</span></div>`,
    )
    .join("");
  return `<div class="advisors">${items}</div>`;
}

/** Render a self-contained HTML transcript for chat export. */
export function formatChatTranscriptHtml(title: string, turns: ChatTurn[]): string {
  const safeTitle = escapeHtml(title.trim() || "Chat");
  const body = turns
    .map((turn) => {
      const role = ROLE_HEADING[turn.role];
      const content =
        turn.role === "assistant"
          ? renderChatMarkdown(turn.content)
          : `<p>${escapeHtml(turn.content)}</p>`;
      return `<section class="turn turn-${turn.role}"><h2>${escapeHtml(role)}</h2><div class="content">${content}</div>${formatToolSummary(turn)}${formatAdvisorNotes(turn)}</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
body{margin:0;background:#f7f7f8;color:#1f2328;font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px}
h1{font-size:28px;margin:0 0 24px}
.turn{border-top:1px solid #d8dee4;padding:18px 0}
.turn h2{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:#667085;margin:0 0 8px}
.content>:first-child{margin-top:0}.content>:last-child{margin-bottom:0}
.tools{margin:10px 0 0;padding-left:20px;color:#57606a}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.advisors{display:grid;gap:8px;margin-top:10px}
.advisor{border:1px solid #d8dee4;border-radius:6px;padding:8px 10px;background:#fff}
.advisor strong{display:block;font-size:11px;text-transform:uppercase;color:#667085}
.advisor span{display:block;margin-top:2px}
.advisor-warning{border-color:#d29922;background:#fff8c5}
.advisor-blocker{border-color:#cf222e;background:#ffebe9}
</style>
</head>
<body>
<main>
<h1>${safeTitle}</h1>
${body}
</main>
</body>
</html>
`;
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
