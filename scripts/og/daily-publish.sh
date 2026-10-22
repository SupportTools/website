#!/usr/bin/env bash
# Daily: commit share cards that went live since the last run and push main, which
# deploys the site. Meant for cron on the workstation running the backlog, e.g.
#   15 0 * * * /path/to/website/scripts/og/daily-publish.sh
#
# Only stages the manifest and posts whose sole change is an `images:` line, so
# hand edits in progress are never swept in. Refuses to commit if a card marked
# live in the staged manifest is not linked from its staged post.
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${OG_PUBLISH_LOG:-$HOME/.cache/og-daily-publish.log}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "== $(date -Is)"
exec 9>"$REPO/.og-work/daily-publish.lock"
flock -n 9 || { echo "another run holds the lock"; exit 0; }
# Wait (up to 90 min) for nightly-cards.sh to finish so no card is mid-write.
exec 8>"$REPO/.og-work/run.lock"
flock -w 5400 8 || { echo "card run still going after 90 min; skipping"; exit 1; }
cd "$REPO"

[ "$(git branch --show-current)" = main ] || { echo "not on main; skipping"; exit 1; }
git diff --cached --quiet || { echo "index already has staged changes; skipping"; exit 1; }

# Posts whose diff is only added `images: [...]` lines.
mapfile -t posts < <(git diff --name-only -- blog/content/post)
staged=0 skipped=0
for f in "${posts[@]}"; do
  other=$(git diff -U0 -- "$f" | grep -E '^[-+][^-+]' | grep -vcE '^\+images *[:=] *\["https://cdn\.support\.tools/posts/' || true)
  if [ "$other" = 0 ]; then git add -- "$f"; staged=$((staged + 1)); else skipped=$((skipped + 1)); echo "left unstaged (other edits): $f"; fi
done
git add scripts/og/manifest.json

if git diff --cached --quiet; then echo "nothing new"; exit 0; fi

# Every live card in the staged manifest must be linked from its staged post.
declare -A path
while IFS= read -r p; do b=${p##*/}; path[${b%.md}]=$p; done < <(git ls-files 'blog/content/post/*.md')
bad=0
while read -r slug url; do
  p=${path[$slug]:-}
  # grep without -q reads to EOF; -q exits early, git show gets SIGPIPE and pipefail fails.
  if [ -z "$p" ] || ! git show ":$p" | grep -F "$url" >/dev/null; then echo "MISMATCH $slug"; bad=$((bad + 1)); fi
done < <(git show :scripts/og/manifest.json | jq -r 'to_entries[] | select(.value.status=="live") | "\(.key) \(.value.url)"')
if [ "$bad" -gt 0 ]; then
  echo "$bad live cards not linked in staged posts; unstaging and stopping"
  git reset -q
  exit 1
fi

live=$(git show :scripts/og/manifest.json | jq '[.[] | select(.status=="live")] | length')
if [ -n "${OG_PUBLISH_DRY_RUN:-}" ]; then
  echo "dry run: would commit $staged posts ($live live), $skipped skipped"
  git reset -q
  exit 0
fi
git commit -q -m "chore(og): $staged more share cards ($live live)"
git fetch -q origin main
if ! git merge-base --is-ancestor origin/main HEAD; then
  git rebase -q --autostash origin/main
fi
git push -q origin main
echo "pushed $(git rev-parse --short HEAD): $staged posts, $live live, $skipped skipped"
