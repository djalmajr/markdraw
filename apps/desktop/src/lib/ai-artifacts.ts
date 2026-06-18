// Persistence for AI-produced artifacts (Plan-mode plans, chat exports).
// The chat store and plan turns keep `[secret-N]` placeholders by design
// (the provider must never see real secrets), and the secret map is
// session-scoped — a placeholder written to disk would be permanently
// unresolvable after restart. So anything leaving the session for a REAL
// file is restored here, at the write site.

import { slugifyTitle } from "@markdraw/ui/lib/chat-export.ts";

export interface PlanArtifactDeps {
  /** Map session `[secret-N]` placeholders back to their real values. */
  restoreSecrets: (text: string) => string;
  /** Write content to an ABSOLUTE path (parent dirs are created). */
  writeFile: (path: string, content: string) => Promise<void>;
}

export interface ChatExportDeps extends PlanArtifactDeps {
  /** Native Save As dialog. Resolves to the chosen absolute path, or
   *  null when the user cancels. */
  saveFileDialog: (defaultDir: string | null, defaultName: string) => Promise<string | null>;
}

/** Local-time filename stamp: YYYYMMDD-HHMMSS. */
function artifactStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Persist a Plan-mode result to `<root>/.markdraw/plans/plan-<stamp>.md`,
 *  restoring scrubbed placeholders first. Returns the written path. */
export async function savePlanArtifact(
  deps: PlanArtifactDeps,
  root: string,
  content: string,
  now: Date = new Date(),
): Promise<string> {
  const path = `${root}/.markdraw/plans/plan-${artifactStamp(now)}.md`;
  await deps.writeFile(path, deps.restoreSecrets(content));
  return path;
}

/** Export a chat transcript via Save As, defaulting to
 *  `<root>/.markdraw/chats/<slug>-<stamp>.md`, restoring scrubbed
 *  placeholders first. Returns the written path, or null on cancel. */
export async function exportChatArtifact(
  deps: ChatExportDeps,
  root: string | null,
  payload: { markdown: string; title: string },
  now: Date = new Date(),
): Promise<string | null> {
  const defaultName = `${slugifyTitle(payload.title)}-${artifactStamp(now)}.md`;
  const path = await deps.saveFileDialog(root ? `${root}/.markdraw/chats` : null, defaultName);
  if (!path) return null; // user cancelled
  await deps.writeFile(path, deps.restoreSecrets(payload.markdown));
  return path;
}
