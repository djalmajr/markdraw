export interface ResolvedNavigationTarget {
  path: string;
  rootId?: string;
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function decodeMaybe(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function stripFileScheme(path: string): string {
  if (!path.toLowerCase().startsWith("file://")) return path;
  return path.replace(/^file:\/\//i, "");
}

function normalizeTargetPath(path: string): string {
  let normalized = decodeMaybe(stripFileScheme(path)).replace(/\\/g, "/");
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function basename(path: string): string {
  const normalized = withoutTrailingSlash(path.replace(/\\/g, "/"));
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:\//i.test(path);
}

export function resolveNavigationTarget(
  targetPath: string,
  roots: Map<string, string>,
): ResolvedNavigationTarget {
  const normalizedTarget = normalizeTargetPath(targetPath);

  if (isAbsolutePath(normalizedTarget)) {
    const rootMatches = [...roots.entries()]
      .map(([rootId, rootPath]) => ({
        rootId,
        rootPath: withoutTrailingSlash(rootPath.replace(/\\/g, "/")),
      }))
      .filter(({ rootPath }) =>
        normalizedTarget === rootPath || normalizedTarget.startsWith(`${rootPath}/`),
      )
      .sort((a, b) => b.rootPath.length - a.rootPath.length);
    const match = rootMatches[0];
    if (match) {
      return {
        path: normalizedTarget === match.rootPath
          ? ""
          : normalizedTarget.slice(match.rootPath.length + 1),
        rootId: match.rootId,
      };
    }
  }

  for (const [rootId, rootPath] of roots.entries()) {
    const rootName = basename(rootPath);
    if (rootName && normalizedTarget.startsWith(`${rootName}/`)) {
      return { path: normalizedTarget.slice(rootName.length + 1), rootId };
    }
  }

  return { path: normalizedTarget };
}
