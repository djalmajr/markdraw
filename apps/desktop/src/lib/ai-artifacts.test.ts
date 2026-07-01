import { describe, expect, it } from "bun:test";
import { restoreSecrets, scrubSecrets } from "@markdraw/ai/secret-scrub.ts";
import { exportChatArtifact, savePlanArtifact } from "./ai-artifacts.ts";

const SECRET = "sk-w7a4JDfGvnZklepfHyg1unjtehDPpY0b";
const NOW = new Date(2026, 5, 11, 8, 9, 10);

/** Deps wired the way the app does it: a session map seeded by scrubbing
 *  outbound context, and a write spy standing in for the Tauri write_file.
 *  `placeholder` is whatever the scrub assigned to SECRET — the nonce is
 *  random per map, so tests derive it instead of hardcoding the format. */
function artifactDeps() {
  const map = new Map<string, string>();
  // The model only ever saw the placeholder for SECRET.
  const placeholder = scrubSecrets(`key: ${SECRET}`, map).text.slice("key: ".length);
  const writes: { content: string; path: string }[] = [];
  const deps = {
    restoreSecrets: (text: string) => restoreSecrets(text, map),
    writeFile: async (path: string, content: string) => {
      writes.push({ content, path });
    },
  };
  return { deps, placeholder, writes };
}

describe("savePlanArtifact", () => {
  it("restores secret placeholders before the plan reaches disk", async () => {
    // Plan-mode turns receive the scrubbed context, so the model's plan
    // quotes placeholders; the map is session-scoped — a placeholder written
    // to disk would be permanently unresolvable after restart.
    const { deps, placeholder, writes } = artifactDeps();
    const path = await savePlanArtifact(deps, "/ws", `Call the API with key: ${placeholder}`, NOW);
    expect(path).toBe("/ws/.markdraw/plans/plan-20260611-080910.md");
    expect(writes).toEqual([{ content: `Call the API with key: ${SECRET}`, path }]);
  });
});

describe("exportChatArtifact", () => {
  it("restores placeholders so the default HTML export matches the displayed transcript", async () => {
    const { deps, placeholder, writes } = artifactDeps();
    const dialogCalls: { defaultDir: string | null; defaultName: string }[] = [];
    const path = await exportChatArtifact(
      {
        ...deps,
        saveFileDialog: async (defaultDir, defaultName) => {
          dialogCalls.push({ defaultDir, defaultName });
          return `/picked/${defaultName}`;
        },
      },
      "/ws",
      {
        html: `<h1>Chat</h1><p>my key is ${placeholder}</p>`,
        markdown: `## You\n\nmy key is ${placeholder}`,
        title: "My Chat",
      },
      NOW,
    );
    expect(dialogCalls).toEqual([
      { defaultDir: "/ws/.markdraw/chats", defaultName: "my-chat-20260611-080910.html" },
    ]);
    expect(path).toBe("/picked/my-chat-20260611-080910.html");
    expect(writes).toEqual([
      {
        content: `<h1>Chat</h1><p>my key is ${SECRET}</p>`,
        path: "/picked/my-chat-20260611-080910.html",
      },
    ]);
  });

  it("writes Markdown when the chosen path has a Markdown extension", async () => {
    const { deps, placeholder, writes } = artifactDeps();
    const path = await exportChatArtifact(
      {
        ...deps,
        saveFileDialog: async () => "/picked/my-chat.md",
      },
      "/ws",
      {
        html: `<h1>Chat</h1><p>my key is ${placeholder}</p>`,
        markdown: `## You\n\nmy key is ${placeholder}`,
        title: "My Chat",
      },
      NOW,
    );
    expect(path).toBe("/picked/my-chat.md");
    expect(writes).toEqual([
      { content: `## You\n\nmy key is ${SECRET}`, path: "/picked/my-chat.md" },
    ]);
  });

  it("writes nothing when the user cancels the dialog", async () => {
    const { deps, writes } = artifactDeps();
    const path = await exportChatArtifact(
      { ...deps, saveFileDialog: async () => null },
      null,
      { html: "<p>x</p>", markdown: "x", title: "t" },
      NOW,
    );
    expect(path).toBeNull();
    expect(writes).toHaveLength(0);
  });
});
