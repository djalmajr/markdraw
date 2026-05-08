#!/usr/bin/env bash
# Pre-Bash hook — suggest running mutation testing before push when the diff
# touches the helper zone of apps/desktop/src-tauri/src/lib.rs (lines covered
# by .cargo/mutants.toml's examine_globs/exclude_re).
#
# Decision rationale & benchmark: Linear DJA-36.
# Pre-requisite cleanup before this becomes a blocking gate: Linear DJA-43.
#
# Behaviour:
#   - Reads the upcoming Bash command from stdin (Claude Code hook payload).
#   - Exits silently (0) if the command is not `git push` or doesn't touch
#     critical lib.rs lines.
#   - Otherwise prints a short suggestion to stderr and exits 0 (never blocks).

set -uo pipefail

# Project root — Claude Code sets CLAUDE_PROJECT_DIR.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LIB_RS="$PROJECT_DIR/apps/desktop/src-tauri/src/lib.rs"

# Mutation hot zone derived from the current mutants.toml configuration.
# Update if examine_globs / exclude_re changes meaningfully.
HOT_START=57
HOT_END=403

# Read hook payload (JSON) from stdin. We only care about `tool_input.command`.
PAYLOAD=$(cat || true)
[ -z "$PAYLOAD" ] && exit 0

# Extract the bash command string. Use python (always available) to parse JSON
# safely without requiring jq.
CMD=$(printf '%s' "$PAYLOAD" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get("tool_input", {}).get("command", ""))
except Exception:
    pass
' 2>/dev/null)

# Only fire on `git push` (with or without flags / aliases like `git push origin main`).
case "$CMD" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

# No-op if lib.rs doesn't exist (e.g. checkout without the desktop app).
[ -f "$LIB_RS" ] || exit 0

# Compute diff range. Falls back to HEAD~1 if origin/main isn't fetched.
cd "$PROJECT_DIR" || exit 0
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  RANGE="origin/main..HEAD"
else
  RANGE="HEAD~1..HEAD"
fi

# Did the diff touch lib.rs at all?
git diff --quiet "$RANGE" -- apps/desktop/src-tauri/src/lib.rs && exit 0

# Did it touch the hot zone? Parse hunk headers from the unified diff.
DIFF=$(git diff "$RANGE" -- apps/desktop/src-tauri/src/lib.rs 2>/dev/null) || exit 0
TOUCHES_HOT=$(printf '%s\n' "$DIFF" | awk -v s="$HOT_START" -v e="$HOT_END" '
  /^@@ / {
    # @@ -<old>,<oldcount> +<new>,<newcount> @@
    if (match($0, /\+([0-9]+)(,([0-9]+))?/, a)) {
      start = a[1] + 0
      count = (a[3] == "") ? 1 : a[3] + 0
      end = start + count - 1
      if (end >= s && start <= e) { print "yes"; exit }
    }
  }
')

[ "$TOUCHES_HOT" = "yes" ] || exit 0

# Print the suggestion to stderr (Claude Code surfaces hook stderr to the agent).
cat >&2 <<'MSG'
[mutation-test] Heads up: this push touches the helper zone of apps/desktop/src-tauri/src/lib.rs
(read_dir / find_in_files / read_file / write_file / rename_file / trash_path / read_dir_recursive).

Mutation kill rate is currently soft in this zone (11 mutations survive — Linear DJA-43).
Consider running the manual gate before pushing if your change altered logic:

    bun run test:mutation:rust

Reference: Linear DJA-36 explains why this isn't a blocking pre-push hook.
MSG

exit 0
