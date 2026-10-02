#!/usr/bin/env bash
# Replaces the vendored OpenCode with another release.
#
#   scripts/dragon/sync-opencode.sh <tag>        e.g. v2.0.19
#
# Imports the tag as a plain tree into opencode/, prunes what PIN.json lists, reapplies
# opencode-patches/*.patch in order, and updates PIN.json.
set -euo pipefail

TAG="${1:?usage: sync-opencode.sh <tag>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone -q --depth 1 --branch "$TAG" https://github.com/sst/opencode.git "$WORK/opencode"
COMMIT="$(git -C "$WORK/opencode" rev-parse HEAD)"

cd "$ROOT"
KEEP_PIN="$(cat opencode/PIN.json)"
rm -rf opencode
mkdir opencode
git -C "$WORK/opencode" archive HEAD | tar -x -C opencode
rm -rf opencode/artifacts
find opencode -name '*.mp4' -delete
find opencode -maxdepth 1 -name 'README.*.md' -delete

for patch in opencode-patches/*.patch; do
	[ -e "$patch" ] || continue
	echo "Applying $patch"
	git apply --directory=opencode "$patch"
done

node -e '
const pin = JSON.parse(process.argv[1]);
pin.tag = process.argv[2]; pin.commit = process.argv[3]; pin.importedAt = new Date().toISOString().slice(0, 10);
require("fs").writeFileSync("opencode/PIN.json", JSON.stringify(pin, null, "\t") + "\n");
' "$KEEP_PIN" "$TAG" "$COMMIT"
sed -i.bak "s/| \`v[0-9.]*\` (\`[0-9a-f]*\`) | \`opencode\/\`/| \`$TAG\` (\`$COMMIT\`) | \`opencode\/\`/" UPSTREAM.md && rm -f UPSTREAM.md.bak
echo "OpenCode $TAG ($COMMIT) imported. Next: npm run dragon:build-opencode && npm --prefix extensions/dragon-agent test"
