import { describe, expect, it } from "bun:test";
import {
  dedupeDiscovered,
  discoveryToolsFor,
  serverIdentity,
  type DiscoveredMcpServer,
} from "./mcp-discovery.ts";

const srv = (over: Partial<DiscoveredMcpServer>): DiscoveredMcpServer => ({
  name: "x",
  transport: "stdio",
  tool: "claude",
  scope: "global",
  sourcePath: "/p",
  ...over,
});

describe("serverIdentity", () => {
  it("keys http by url and stdio by command+args", () => {
    expect(serverIdentity({ transport: "http", url: "https://a/mcp" })).toBe("http:https://a/mcp");
    expect(serverIdentity({ transport: "stdio", command: "npx", args: ["-y", "p"] })).toBe(
      "stdio:npx -y p",
    );
  });

  it("ignores env/headers so the same target is one server", () => {
    const a = serverIdentity({ transport: "http", url: "https://a/mcp" });
    const b = serverIdentity({ transport: "http", url: "https://a/mcp" });
    expect(a).toBe(b);
  });
});

describe("dedupeDiscovered", () => {
  it("collapses the same server across tools and records every source", () => {
    const servers = [
      srv({ name: "memory", transport: "http", url: "https://m/mcp", tool: "claude" }),
      srv({ name: "memory", transport: "http", url: "https://m/mcp", tool: "codex" }),
      srv({ name: "memory", transport: "http", url: "https://m/mcp", tool: "opencode" }),
    ];
    const out = dedupeDiscovered(servers, new Set());
    expect(out).toHaveLength(1);
    expect(out[0]!.sources.map((s) => s.tool)).toEqual(["claude", "codex", "opencode"]);
    expect(out[0]!.id).toMatch(/^discovered:/);
  });

  it("marks an entry global when ANY source is global; project-only otherwise", () => {
    const globalAndProject = dedupeDiscovered(
      [
        srv({ transport: "http", url: "https://a/mcp", scope: "project", root: "/r" }),
        srv({ transport: "http", url: "https://a/mcp", scope: "global" }),
      ],
      new Set(),
    );
    expect(globalAndProject[0]!.scope).toBe("global");

    const projectOnly = dedupeDiscovered(
      [srv({ transport: "http", url: "https://b/mcp", scope: "project", root: "/r" })],
      new Set(),
    );
    expect(projectOnly[0]!.scope).toBe("project");
    expect(projectOnly[0]!.root).toBe("/r");
  });

  it("drops servers whose identity already exists in ai.json", () => {
    const existing = new Set([serverIdentity({ transport: "http", url: "https://m/mcp" })]);
    const out = dedupeDiscovered(
      [srv({ transport: "http", url: "https://m/mcp", tool: "claude" })],
      existing,
    );
    expect(out).toHaveLength(0);
  });
});

describe("discoveryToolsFor", () => {
  const providerKinds = {
    "claude-sub": "claude-cli",
    anthropic: "anthropic",
    "codex-sub": "codex-cli",
    openai: "openai",
  };

  it("reads claude when a claude-cli or anthropic provider is connected", () => {
    expect(
      discoveryToolsFor({ connected: { "claude-sub": true }, providerKinds, importOpenCode: false }),
    ).toEqual(["claude"]);
    expect(
      discoveryToolsFor({ connected: { anthropic: true }, providerKinds, importOpenCode: false }),
    ).toEqual(["claude"]);
  });

  it("reads codex only when the codex provider is connected", () => {
    expect(
      discoveryToolsFor({ connected: { "codex-sub": true }, providerKinds, importOpenCode: false }),
    ).toEqual(["codex"]);
  });

  it("reads opencode only when the toggle is on (no provider gate)", () => {
    expect(
      discoveryToolsFor({ connected: {}, providerKinds, importOpenCode: true }),
    ).toEqual(["opencode"]);
  });

  it("reads nothing when nothing is connected and opencode is off", () => {
    expect(
      discoveryToolsFor({ connected: { openai: true }, providerKinds, importOpenCode: false }),
    ).toEqual([]);
  });
});
