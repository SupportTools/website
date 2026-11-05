#!/usr/bin/env bash
# In-cluster daily publish (publisher job kind daily-publish): the commit logic of
# scripts/og/daily-publish.sh without the workstation locks. Runs in a fresh clone
# of main, so the live-card part usually finds nothing (cards-nightly.sh already
# committed them); it stays for cards written by any other step. Then records URLs
# that went live since the last run in tests/fixtures/published-urls.txt (the CI
# URL guard), built from a clean export of HEAD. Opens an auto-merge PR on
# bot/daily-publish-<day>; never pushes main. "nothing new" and exit 0 otherwise.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/jobs/lib.sh
. scripts/jobs/lib.sh

git diff --cached --quiet || { echo "index already has staged changes; stopping"; exit 1; }
stage_card_changes

urls_new=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if git archive HEAD blog | tar -x -C "$tmp" \
   && (cd "$tmp/blog" && hugo --gc --baseURL https://support.tools -d "$tmp/public" >/dev/null 2>&1) \
   && out=$(node scripts/check-published-urls.mjs --update "$tmp/public"); then
  echo "$out"
  urls_new=$(sed -n 's/.*(\([0-9]*\) new).*/\1/p' <<<"$out")
  git add tests/fixtures/published-urls.txt
else
  echo "WARNING: URL baseline not updated (build failed, or a published URL no longer resolves)"
fi

if git diff --cached --quiet; then echo "nothing new"; exit 0; fi
check_live_cards_linked || exit 1
live=$(live_card_count)
if [ "$CARD_POSTS_STAGED" -gt 0 ]; then
  title="chore(og): $CARD_POSTS_STAGED more share cards ($live live)"
else
  title="chore(urls): ${urls_new:-0} newly published URLs"
fi
publish_changes daily-publish "$title"
