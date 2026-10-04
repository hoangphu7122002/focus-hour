#!/bin/sh
# Release a new version: bump the version everywhere, test, commit, push, GitHub release (+ the editor extension).
#   scripts/release.sh 0.2.0 "One-line summary of what changed"
set -e
VERSION=$1
SUMMARY=$2
[ -n "$VERSION" ] && [ -n "$SUMMARY" ] || { echo 'usage: scripts/release.sh <version> "<summary>"'; exit 1; }
cd "$(dirname "$0")/.."
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first"; exit 1; }

node --test test/*.test.mjs >/dev/null
claude plugin test . >/dev/null
claude plugin validate . >/dev/null

for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json package.json; do
  sed -i '' -E "s/\"version\": \"[0-9.]+\"/\"version\": \"$VERSION\"/" "$f"
done
git commit -qam "Release v$VERSION: $SUMMARY"
git push -q

VSIX=$(ls vscode/*.vsix | sort -V | tail -1)
gh release create "v$VERSION" "$VSIX" --target main --title "Focus Hour v$VERSION" --notes "$SUMMARY

Install or update: see README (claude plugin update focus-hour@focus-hour)."

# Update the copy this machine runs.
claude plugin marketplace update focus-hour >/dev/null && claude plugin update focus-hour@focus-hour
