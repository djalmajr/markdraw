import { describe, expect, it } from "bun:test";
import { buildMcpTools, namespacedToolName, type MCPBridge } from "./mcp-tools.ts";

describe("namespacedToolName", () => {
  it("joins server and tool with a double underscore", () => {
    expect(namespacedToolName("ai-memory", "memory_query")).toBe("ai-memory__memory_query");
  });

  it("sanitizes characters outside the provider name grammar", () => {
    expect(namespacedToolName("fs.local", "read file")).toBe("fs_local__read_file");
    expect(namespacedToolName("a/b", "c:d")).toBe("a_b__c_d");
  });

  it("caps over-long names with a stable hash suffix", () => {
    const long = "x".repeat(80);
    const a = namespacedToolName("srv", long);
    const b = namespacedToolName("srv", long);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).toBe(b); // deterministic
  });
});

describe("buildMcpTools", () => {
  it("maps descriptors to AITool[] and routes execute through the bridge", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const bridge: MCPBridge = {
      listTools: async () => [
        {
          server: "ai-memory",
          name: "memory_query",
          description: "Search memory",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
        },
        { server: "fs", name: "read", inputSchema: { type: "object" } },
      ],
      callTool: async (server, name, args) => {
        calls.push([server, name, args]);
        return { ok: true };
      },
    };

    const tools = await buildMcpTools(bridge);

    expect(tools.map((t) => t.name)).toEqual(["ai-memory__memory_query", "fs__read"]);
    expect(tools[0]!.source).toBe("ai-memory");
    expect(tools[0]!.description).toBe("Search memory");
    expect(tools[0]!.inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });

    const result = await tools[0]!.execute({ q: "hello" });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([["ai-memory", "memory_query", { q: "hello" }]]);
  });

  it("returns [] when no servers expose tools", async () => {
    const bridge: MCPBridge = { listTools: async () => [], callTool: async () => null };
    expect(await buildMcpTools(bridge)).toEqual([]);
  });

  it("sanitizes the input schema (oneOf -> anyOf) by default", async () => {
    const bridge: MCPBridge = {
      listTools: async () => [
        {
          server: "srv",
          name: "t",
          inputSchema: { type: "object", properties: { v: { oneOf: [{ type: "string" }] } } },
        },
      ],
      callTool: async () => null,
    };
    const [tool] = await buildMcpTools(bridge);
    expect((tool!.inputSchema.properties as any).v).toEqual({ anyOf: [{ type: "string" }] });
  });

  it("applies strict tightening when strictSchema is set", async () => {
    const bridge: MCPBridge = {
      listTools: async () => [
        { server: "srv", name: "t", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
      ],
      callTool: async () => null,
    };
    const [tool] = await buildMcpTools(bridge, { strictSchema: true });
    expect(tool!.inputSchema.additionalProperties).toBe(false);
    expect(tool!.inputSchema.required).toEqual(["a"]);
  });

  it("routes execute to the original server/name even when the display name is sanitized", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const bridge: MCPBridge = {
      listTools: async () => [{ server: "fs.local", name: "read file", inputSchema: { type: "object" } }],
      callTool: async (server, name, args) => {
        calls.push([server, name, args]);
        return "ok";
      },
    };
    const [tool] = await buildMcpTools(bridge);
    expect(tool!.name).toBe("fs_local__read_file");
    await tool!.execute({ p: 1 });
    expect(calls).toEqual([["fs.local", "read file", { p: 1 }]]); // original, unsanitized
  });
});
