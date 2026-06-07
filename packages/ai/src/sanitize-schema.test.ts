import { describe, expect, it } from "bun:test";
import { sanitizeJsonSchema } from "./sanitize-schema.ts";

describe("sanitizeJsonSchema — always pass", () => {
  it("rewrites oneOf to anyOf (recursively)", () => {
    const out = sanitizeJsonSchema({
      type: "object",
      properties: {
        v: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    });
    expect((out.properties as any).v).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  it("merges a lifted oneOf into an existing anyOf", () => {
    const out = sanitizeJsonSchema({
      anyOf: [{ type: "string" }],
      oneOf: [{ type: "number" }],
    });
    expect(out.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
    expect(out.oneOf).toBeUndefined();
  });

  it("inlines a local $ref and drops $defs", () => {
    const out = sanitizeJsonSchema({
      type: "object",
      properties: { who: { $ref: "#/$defs/Person" } },
      $defs: { Person: { type: "object", properties: { name: { type: "string" } } } },
    });
    expect(out.$defs).toBeUndefined();
    expect((out.properties as any).who).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  it("supports legacy `definitions` and #/definitions refs", () => {
    const out = sanitizeJsonSchema({
      properties: { x: { $ref: "#/definitions/T" } },
      definitions: { T: { type: "integer" } },
    });
    expect(out.definitions).toBeUndefined();
    expect((out.properties as any).x).toEqual({ type: "integer" });
  });

  it("merges $ref sibling keywords over the resolved target", () => {
    const out = sanitizeJsonSchema({
      properties: { x: { $ref: "#/$defs/T", description: "override" } },
      $defs: { T: { type: "string", description: "base" } },
    });
    expect((out.properties as any).x).toEqual({ type: "string", description: "override" });
  });

  it("collapses a cyclic $ref to a permissive {}", () => {
    const out = sanitizeJsonSchema({
      $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } },
      $ref: "#/$defs/Node",
    });
    // top resolves Node; Node.next is the cycle -> {}
    expect(out).toEqual({
      type: "object",
      properties: { next: {} },
    });
  });

  it("collapses a dangling/external $ref to {}", () => {
    expect(sanitizeJsonSchema({ $ref: "#/$defs/Missing" })).toEqual({});
    expect(sanitizeJsonSchema({ $ref: "https://example.com/x.json" })).toEqual({});
  });

  it("strips meta keywords ($schema/$id/$comment)", () => {
    const out = sanitizeJsonSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:x",
      $comment: "note",
      type: "object",
    });
    expect(out).toEqual({ type: "object" });
  });

  it("preserves leaf keywords and boolean additionalProperties in the non-strict pass", () => {
    const input = {
      type: "object",
      properties: { n: { type: "number", minimum: 0, description: "count" } },
      required: ["n"],
      additionalProperties: false,
    };
    expect(sanitizeJsonSchema(input)).toEqual(input);
  });

  it("recurses into tuple `items` (array form)", () => {
    const out = sanitizeJsonSchema({
      type: "array",
      items: [{ oneOf: [{ type: "string" }] }, { type: "number" }],
    });
    expect((out.items as any)[0]).toEqual({ anyOf: [{ type: "string" }] });
  });
});

describe("sanitizeJsonSchema — strict pass", () => {
  it("forces additionalProperties:false and fills required with all property keys", () => {
    const out = sanitizeJsonSchema(
      { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
      { strict: true },
    );
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(["a", "b"]);
  });

  it("strips strict-unsupported keywords (format/pattern/minimum/default)", () => {
    const out = sanitizeJsonSchema(
      {
        type: "object",
        properties: {
          s: { type: "string", format: "email", pattern: "@", minLength: 3 },
          n: { type: "number", minimum: 1, default: 5 },
        },
      },
      { strict: true },
    );
    expect((out.properties as any).s).toEqual({ type: "string" });
    expect((out.properties as any).n).toEqual({ type: "number" });
  });

  it("tightens nested object schemas too", () => {
    const out = sanitizeJsonSchema(
      { type: "object", properties: { inner: { type: "object", properties: { x: { type: "string" } } } } },
      { strict: true },
    );
    expect((out.properties as any).inner.additionalProperties).toBe(false);
    expect((out.properties as any).inner.required).toEqual(["x"]);
  });

  it("treats an untyped schema with properties as an object", () => {
    const out = sanitizeJsonSchema({ properties: { x: { type: "string" } } }, { strict: true });
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(["x"]);
  });
});

describe("sanitizeJsonSchema — purity & robustness", () => {
  it("never mutates the input", () => {
    const input = {
      type: "object",
      properties: { v: { oneOf: [{ type: "string" }] } },
      $defs: { Unused: { type: "string" } },
    };
    const snapshot = structuredClone(input);
    sanitizeJsonSchema(input, { strict: true });
    expect(input).toEqual(snapshot);
  });

  it("is idempotent (sanitize(sanitize(x)) === sanitize(x))", () => {
    const input = {
      type: "object",
      properties: { who: { $ref: "#/$defs/P" }, kind: { oneOf: [{ const: "a" }, { const: "b" }] } },
      $defs: { P: { type: "object", properties: { name: { type: "string", format: "email" } } } },
    };
    const once = sanitizeJsonSchema(input, { strict: true });
    const twice = sanitizeJsonSchema(once, { strict: true });
    expect(twice).toEqual(once);
  });

  it("returns {} for non-object input", () => {
    expect(sanitizeJsonSchema(null as unknown as Record<string, unknown>)).toEqual({});
    expect(sanitizeJsonSchema(undefined as unknown as Record<string, unknown>)).toEqual({});
  });

  it("handles an empty schema", () => {
    expect(sanitizeJsonSchema({})).toEqual({});
  });
});
