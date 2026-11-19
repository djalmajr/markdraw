// Writing the connect form into the user's ai.json entry. The connect flow only
// owns the selected model (and `model` at the top level); everything else in
// that provider's entry — a custom provider's `kind`/`name`/`options`, the
// sibling models a user or a refresh added — must survive the read-modify-write.
// Replacing the entry would delete them. Note that `parseUserConfig` already
// drops fields the schema does not know before this runs, so only what the
// schema keeps reaches the merge.

import type { ModelConfig, UserAIConfig, UserProviderConfig } from "@markdraw/ai/config-schema.ts";

/** Object-valued fields are merged into; anything else (null, array, string
 *  written by hand or by a future version) cannot carry the write and is
 *  replaced by the shape this write needs. */
function asRecord<T extends object>(value: unknown): T {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as T)
    : ({} as T);
}

type UserProviderModels = NonNullable<UserProviderConfig["models"]>;

/** Merge the connect form's selection into `provider[providerId]`, keeping every
 *  field the form does not own. Pure: the input config is never mutated, so a
 *  failed save leaves the caller's copy intact and a retry writes the same JSON.
 *
 *  - the chosen model is added only when absent: an existing definition keeps
 *    its `name`/`limit`/`reasoning` (a refresh or the user wrote it);
 *  - sibling models, `kind`, `name`, `options`, `embeddingModels`,
 *    `connectGroup` and any other field present in the input stay as they are;
 *  - top-level siblings (`mcp`, `small_model`) stay as well —
 *    this only sets `model` and the one provider entry. */
export function withProviderSelection(
  user: UserAIConfig,
  providerId: string,
  modelId: string,
): UserAIConfig {
  const providers = asRecord<NonNullable<UserAIConfig["provider"]>>(user.provider);
  const entry = asRecord<UserProviderConfig>(providers[providerId]);
  const models = asRecord<UserProviderModels>(entry.models);
  const selected: ModelConfig | undefined = models[modelId];
  return {
    ...user,
    model: `${providerId}/${modelId}`,
    provider: {
      ...providers,
      [providerId]: {
        ...entry,
        models: {
          ...models,
          [modelId]:
            typeof selected === "object" && selected !== null ? selected : { name: modelId },
        },
      },
    },
  };
}
