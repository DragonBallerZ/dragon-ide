#!/usr/bin/env bash
# Brings the next VS Code release into Dragon IDE.
#
#   scripts/dragon/sync-vscode.sh <next-tag>        e.g. 1.140.0
#
# VS Code was imported as a plain source tree (see UPSTREAM.md), so this applies the upstream
# diff between the pinned tag and <next-tag> with a three-way merge. Conflicts show up only
# where Dragon changed an upstream file: search for `DRAGON` markers and keep both sides.
set -euo pipefail

NEXT="${1:?usage: sync-vscode.sh <next-tag>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CURRENT="$(sed -n 's/.*`\([0-9][0-9.]*\)` (`\([0-9a-f]*\)`).*| repository root.*/\1/p' "$ROOT/UPSTREAM.md" | head -1)"
[ -n "$CURRENT" ] || { echo "Could not read the pinned VS Code tag from UPSTREAM.md" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$WORK" init -q
git -C "$WORK" remote add upstream https://github.com/microsoft/vscode.git
git -C "$WORK" fetch -q --depth 1 upstream "refs/tags/$CURRENT:refs/tags/$CURRENT" "refs/tags/$NEXT:refs/tags/$NEXT"

echo "Applying microsoft/vscode $CURRENT..$NEXT"
git -C "$WORK" diff --binary "$CURRENT" "$NEXT" -- . ':!extensions/copilot' > "$WORK/upstream.patch"
cd "$ROOT"
git apply --3way --whitespace=nowarn "$WORK/upstream.patch" || {
	echo "Conflicts: resolve them (keep DRAGON changes), then run the checks in CONTRIBUTING.md." >&2
	exit 1
}
NEXT_SHA="$(git -C "$WORK" rev-parse "$NEXT^{commit}")"
sed -i.bak "s/\`$CURRENT\` (\`[0-9a-f]*\`)/\`$NEXT\` (\`$NEXT_SHA\`)/" UPSTREAM.md && rm -f UPSTREAM.md.bak
echo "Done. Review, run 'npm ci && npm run compile && npm run dragon:check', and commit as 'chore: merge VS Code $NEXT'."
