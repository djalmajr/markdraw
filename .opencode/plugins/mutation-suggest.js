// OpenCode plugin — suggest running cargo-mutants when a `git push` is about
// to fire and the diff touches the helper zone of apps/desktop/src-tauri/src/lib.rs.
//
// Decision rationale & benchmark: Linear DJA-36.
// Pre-requisite cleanup: Linear DJA-43.
//
// This plugin is intentionally separate from wiki-guardrails.js (which is
// managed by wiki-init and gets overwritten by `update-hooks --write`).
// Keeping mutation-suggest as its own file means it survives template refreshes.

import { existsSync } from "node:fs";
import { join } from "node:path";

function text(value) {
  return typeof value === "string" ? value : "";
}

function looksLikeShellTool(input) {
  const tool = text(input?.tool || input?.name || input?.id).toLowerCase();
  return (
    tool === "bash" ||
    tool === "shell" ||
    tool === "local_shell" ||
    tool === "exec_command" ||
    tool.includes("bash") ||
    tool.includes("shell")
  );
}

function commandFrom(input) {
  const args = input?.args ?? input?.parameters ?? {};
  return text(args.command || args.cmd || args.script);
}

function makePayload(command) {
  return {
    tool_name: "Bash",
    tool_input: { command },
  };
}

async function streamText(stream) {
  if (!stream) return "";
  return new Response(stream).text();
}

async function runHook(root, rel, hookPayload) {
  const script = join(root, rel);
  if (!existsSync(script)) return { code: 0, stdout: "", stderr: "" };
  const proc = Bun.spawn(["bash", script], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  proc.stdin.write(JSON.stringify(hookPayload));
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    streamText(proc.stdout),
    streamText(proc.stderr),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function log(client, level, message) {
  if (!message) return;
  try {
    await client?.app?.log?.({
      body: { service: "mutation-suggest", level, message },
    });
  } catch {}
  if (level === "error") console.error(message);
  else console.warn(message);
}

export const MutationSuggest = async ({ client, directory, worktree }) => {
  const root = worktree || directory || process.cwd();

  return {
    "tool.execute.before": async (input) => {
      if (!looksLikeShellTool(input)) return;
      const command = commandFrom(input);
      if (!command.includes("git push")) return;

      const result = await runHook(
        root,
        ".opencode/hooks/suggest-mutation-test.sh",
        makePayload(command),
      );
      // The hook never blocks; its only output is a stderr suggestion.
      const message = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      if (message) {
        await log(client, "warn", message);
      }
    },
  };
};
