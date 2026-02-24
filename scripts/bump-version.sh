#!/bin/bash
set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: bun run bump:app <version>"
  echo "Example: bun run bump:app 0.3.0"
  exit 1
fi

# Validar formato semver (x.y.z)
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be semver format (e.g. 0.3.0)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1. apps/desktop/package.json
bun --eval "
  const path = '${ROOT}/apps/desktop/package.json';
  const pkg = JSON.parse(await Bun.file(path).text());
  pkg.version = '${VERSION}';
  await Bun.write(path, JSON.stringify(pkg, null, 2) + '\n');
"

# 2. apps/desktop/src-tauri/tauri.conf.json
bun --eval "
  const path = '${ROOT}/apps/desktop/src-tauri/tauri.conf.json';
  const conf = JSON.parse(await Bun.file(path).text());
  conf.version = '${VERSION}';
  await Bun.write(path, JSON.stringify(conf, null, 2) + '\n');
"

# 3. apps/desktop/src-tauri/Cargo.toml (only the package version, first occurrence)
bun --eval "
  const path = '${ROOT}/apps/desktop/src-tauri/Cargo.toml';
  let toml = await Bun.file(path).text();
  toml = toml.replace(/^version = \".*\"/m, 'version = \"${VERSION}\"');
  await Bun.write(path, toml);
"

echo "Bumped to ${VERSION}:"
echo "  - apps/desktop/package.json"
echo "  - apps/desktop/src-tauri/tauri.conf.json"
echo "  - apps/desktop/src-tauri/Cargo.toml"
echo ""
echo "Next steps:"
echo "  git add -u && git commit -m 'chore: bump version to ${VERSION}'"
echo "  git tag v${VERSION}"
echo "  git push origin main --tags"
