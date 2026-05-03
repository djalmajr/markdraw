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

type RecentFile = v.InferOutput<typeof RecentFileSchema>;
type RecentFolder = v.InferOutput<typeof RecentFolderSchema>;
type FavoriteFile = v.InferOutput<typeof FavoriteFileSchema>;
type PersistedTab = v.InferOutput<typeof PersistedTabSchema>;
type PersistedTabSession = v.InferOutput<typeof PersistedTabSessionSchema>;

/** Try-parse: returns the validated value or null. Use at storage/IPC boundaries. */
function tryParse<TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
): v.InferOutput<TSchema> | null {
  const result = v.safeParse(schema, value);
  return result.success ? result.output : null;
}

export {
  type FavoriteFile,
  type PersistedTab,
  type PersistedTabSession,
  type RecentFile,
  type RecentFolder,
  FavoriteFileSchema,
  PersistedTabSchema,
  PersistedTabSessionSchema,
  RecentFileSchema,
  RecentFolderSchema,
  tryParse,
};
