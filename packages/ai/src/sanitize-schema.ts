// Sanitizes JSON Schemas (MCP tool `inputSchema`s) before they reach the AI
// SDK's `jsonSchema()` and, through it, a provider. MCP servers emit Draft-07 /
// 2020-12 schemas with `oneOf`, `$ref`/`$defs`, meta keywords, etc. that several
// providers reject with a 400 that fails the WHOLE generateText/streamText turn
// (a silent, hard-to-diagnose failure the moment a user adds a non-trivial MCP
// server). This module is a small, dependency-free walker that normalizes those
// constructs. It is pure: the input object is never mutated.
//
// Two tiers:
//   - ALWAYS (broad cross-provider fix, default): inline local `$ref`, drop
//     `$defs`/`definitions`, strip meta keywords (`$schema`/`$id`/...), and
//     rewrite `oneOf` -> `anyOf` (Gemini/Vertex don't support `oneOf`/`$ref`).
//   - STRICT (opt-in): additionally tighten every object for OpenAI strict mode
//     (`additionalProperties: false`, `required` = all property keys) and strip
//     keywords strict rejects. OFF by default because AsciiMark does not enable
//     OpenAI strict on its `dynamicTool`s today, and required-fill would force
//     otherwise-optional parameters.

type JsonSchema = Record<string, unknown>;

export interface SanitizeSchemaOptions {
  /** Apply OpenAI strict-mode tightening. Default false. */
  strict?: boolean;
}

/** Meta keywords stripped on every pass — some providers (Gemini/Vertex) 400 on them. */
const META_KEYWORDS = new Set(["$schema", "$id", "$anchor", "$comment", "$vocabulary"]);

/** Keywords OpenAI strict mode rejects ("Unsupported keyword"). Stripped only when `strict`. */
const STRICT_UNSUPPORTED = new Set([
  "format", "pattern", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minItems", "maxItems", "uniqueItems", "minContains", "maxContains",
  "minProperties", "maxProperties", "default", "examples",
  "contentMediaType", "contentEncoding",
]);

/** Keywords whose value is a single subschema (or, for `items`, possibly an array of them). */
const SCHEMA_KEYS = new Set([
  "items", "additionalItems", "contains", "additionalProperties",
  "propertyNames", "not", "if", "then", "else",
  "unevaluatedItems", "unevaluatedProperties",
]);

/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Keywords whose value is a map of name -> subschema. */
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "dependentSchemas"]);

/** Containers that hold definitions; dropped from output after `$ref`s are inlined. */
const DEFS_KEYS = new Set(["$defs", "definitions"]);

function isPlainObject(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Resolve a local JSON Pointer ref (`#/a/b`) against `root`. Returns undefined for
 *  external refs or dangling pointers. */
function resolvePointer(ref: string, root: JsonSchema): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined; // external/non-pointer ref — unsupported
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const part of parts) {
    if (isPlainObject(cur) && part in cur) cur = (cur as JsonSchema)[part];
    else if (Array.isArray(cur)) cur = cur[Number(part)];
    else return undefined;
  }
  return cur;
}

interface Ctx {
  root: JsonSchema;
  strict: boolean;
  /** Ref pointers currently on the resolution path — cycle guard. */
  seen: Set<string>;
}

function walk(node: unknown, ctx: Ctx): unknown {
  if (Array.isArray(node)) return node.map((n) => walk(n, ctx));
  if (!isPlainObject(node)) return node;

  // Inline a local $ref by resolving against the untouched root, merging any
  // sibling keywords over the target (Draft 2019+ allows $ref siblings).
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (ctx.seen.has(ref)) return {}; // cycle -> permissive
    const target = resolvePointer(ref, ctx.root);
    if (!isPlainObject(target)) return {}; // dangling/external -> permissive
    const { $ref: _omit, ...siblings } = node;
    const merged = { ...target, ...siblings };
    return walk(merged, { ...ctx, seen: new Set(ctx.seen).add(ref) });
  }

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (DEFS_KEYS.has(key) || META_KEYWORDS.has(key)) continue;
    if (ctx.strict && STRICT_UNSUPPORTED.has(key)) continue;

    if (key === "oneOf" && Array.isArray(value)) {
      // Gemini/Vertex don't support oneOf; anyOf is the closest portable form.
      const branches = value.map((v) => walk(v, ctx));
      out.anyOf = Array.isArray(out.anyOf) ? [...out.anyOf, ...branches] : branches;
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      const branches = value.map((v) => walk(v, ctx));
      out[key] = key === "anyOf" && Array.isArray(out.anyOf)
        ? [...out.anyOf, ...branches] // merge if a oneOf was already lifted into anyOf
        : branches;
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      const mapped: JsonSchema = {};
      for (const [k, v] of Object.entries(value)) mapped[k] = walk(v, ctx);
      out[key] = mapped;
      continue;
    }
    if (SCHEMA_KEYS.has(key)) {
      // `items` may be a tuple (array); `additionalProperties` may be a boolean.
      out[key] = isPlainObject(value) || Array.isArray(value) ? walk(value, ctx) : value;
      continue;
    }
    // Leaf keyword (type, enum, const, required, description, title, ...): copy.
    out[key] = value;
  }

  // OpenAI strict tightening on object schemas.
  if (ctx.strict && isObjectSchema(out)) {
    out.additionalProperties = false;
    if (isPlainObject(out.properties)) {
      out.required = Object.keys(out.properties);
    }
  }
  return out;
}

function isObjectSchema(s: JsonSchema): boolean {
  if (s.type === "object") return true;
  if (Array.isArray(s.type) && s.type.includes("object")) return true;
  // Untyped schema with `properties` is treated as an object.
  return s.type === undefined && isPlainObject(s.properties);
}

/**
 * Return a provider-safe copy of `schema`. Never mutates the input.
 * @param schema the raw JSON Schema (e.g. an MCP tool `inputSchema`).
 * @param options `{ strict }` to additionally apply OpenAI strict-mode tightening.
 */
export function sanitizeJsonSchema(
  schema: Record<string, unknown>,
  options: SanitizeSchemaOptions = {},
): Record<string, unknown> {
  if (!isPlainObject(schema)) return {};
  const root = structuredClone(schema) as JsonSchema;
  const result = walk(root, { root, strict: !!options.strict, seen: new Set() });
  return isPlainObject(result) ? result : {};
}
