import * as v from "valibot";

const RecentFileSchema = v.object({
  name: v.string(),
  path: v.string(),
  rootName: v.string(),
  rootPath: v.string(),
});

const RecentFolderSchema = v.object({
  name: v.string(),
  path: v.string(),
});

const FavoriteFileSchema = v.object({
  name: v.string(),
  path: v.string(),
  rootName: v.string(),
  rootPath: v.string(),
});

const PersistedTabSchema = v.object({
  id: v.string(),
  filePath: v.string(),
  rootId: v.string(),
  fileName: v.string(),
  isPinned: v.boolean(),
  editorMode: v.picklist(["edit", "split", "preview"] as const),
});

const PersistedTabSessionSchema = v.object({
  tabs: v.array(PersistedTabSchema),
  activeTabId: v.nullable(v.string()),
});

const FontPrefsSchema = v.object({
  fontSize: v.number(),
  fontFamily: v.string(),
});

/** Lenient form used at the storage boundary so an older AsciiMark
 *  install that only persisted one of the two fields still upgrades
 *  cleanly — the caller merges the result onto its defaults. */
const PartialFontPrefsSchema = v.partial(FontPrefsSchema);

const RecentCommandIdsSchema = v.array(v.string());

type RecentFile = v.InferOutput<typeof RecentFileSchema>;
type RecentFolder = v.InferOutput<typeof RecentFolderSchema>;
type FavoriteFile = v.InferOutput<typeof FavoriteFileSchema>;
type PersistedTab = v.InferOutput<typeof PersistedTabSchema>;
type PersistedTabSession = v.InferOutput<typeof PersistedTabSessionSchema>;
type FontPrefs = v.InferOutput<typeof FontPrefsSchema>;

/** Try-parse: returns the validated value or null. Use at storage/IPC boundaries. */
function tryParse<TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
): v.InferOutput<TSchema> | null {
  const result = v.safeParse(schema, value);
  return result.success ? result.output : null;
}

/**
 * Reads a JSON string and validates it against the supplied schema.
 * Returns the validated value or `null` on JSON parse failure or
 * schema mismatch. Use at every localStorage / IPC boundary so
 * downstream code can stop coercing through `as unknown` / typeof
 * narrowing — the schema does the narrowing and the return type is
 * already strict.
 *
 * Mutation-survival contracts (locked in by `schemas.test.ts`):
 *   - Removing the `try/catch` lets a malformed JSON crash the
 *     storage read; the "corrupt JSON" assertion fails.
 *   - Returning the parsed value without `tryParse` lets unrelated
 *     shapes (e.g. `{ foo: 1 }` against a `{ name: string }` schema)
 *     leak through — the schema-mismatch assertion catches that.
 */
function safeJsonParse<TSchema extends v.GenericSchema>(
  raw: string | null,
  schema: TSchema,
): v.InferOutput<TSchema> | null {
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return tryParse(schema, parsed);
}

/**
 * Formats the first Valibot issue from a failed `parse()` into a
 * user-readable hint. Default Valibot traces leak schema internals
 * ("invalid type: Expected Object but received string"); this helper
 * pinpoints the field that failed. Callers wrap a `v.parse` in
 * try/catch and pass `(e as Error).message`-ish input through here
 * if they want to surface the cause to the user.
 */
interface PathSegment {
  readonly key?: PropertyKey;
}
interface FormattableIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PathSegment>;
}

function formatValibotError(error: unknown): string {
  if (!(error instanceof v.ValiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const issue = (error.issues as ReadonlyArray<FormattableIssue>)[0];
  if (!issue) return "Schema validation failed";
  const path: string = (issue.path ?? [])
    .map((segment): PropertyKey | undefined => segment.key)
    .filter((key): key is PropertyKey => key !== undefined)
    .join(".");
  const where = path ? `field "${path}"` : "input";
  return `${where} ${issue.message.toLowerCase()}`;
}

export {
  type FavoriteFile,
  type FontPrefs,
  type PersistedTab,
  type PersistedTabSession,
  type RecentFile,
  type RecentFolder,
  FavoriteFileSchema,
  FontPrefsSchema,
  PartialFontPrefsSchema,
  PersistedTabSchema,
  PersistedTabSessionSchema,
  RecentCommandIdsSchema,
  RecentFileSchema,
  RecentFolderSchema,
  formatValibotError,
  safeJsonParse,
  tryParse,
};
