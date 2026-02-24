#!/bin/bash
set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: bun run bump:ext <version>"
  echo "Example: bun run bump:ext 1.1.0"
  exit 1
fi

if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be semver format (e.g. 1.1.0)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1. apps/extension/package.json
bun --eval "
  const path = '${ROOT}/apps/extension/package.json';
  const pkg = JSON.parse(await Bun.file(path).text());
  pkg.version = '${VERSION}';
  await Bun.write(path, JSON.stringify(pkg, null, 2) + '\n');
"

# 2. apps/extension/public/manifest.json
bun --eval "
  const path = '${ROOT}/apps/extension/public/manifest.json';
  const manifest = JSON.parse(await Bun.file(path).text());
  manifest.version = '${VERSION}';
  await Bun.write(path, JSON.stringify(manifest, null, 2) + '\n');
"

echo "Bumped extension to ${VERSION}:"
echo "  - apps/extension/package.json"
echo "  - apps/extension/public/manifest.json"
