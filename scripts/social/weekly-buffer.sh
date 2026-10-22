#!/usr/bin/env bash
# Weekly (Sunday evening): draft next Monday-Sunday's LinkedIn and Bluesky posts in
# Buffer as drafts with their scheduled times; the owner reviews and sends them.
#   0 18 * * 0 /path/to/website/scripts/social/weekly-buffer.sh
#
# Runs `claude -p` with the Buffer connector (remote MCP, logged in under the
# operator's claude account). Allowed tools are read-only on the repo plus the
# Buffer calls needed to read and create posts; it cannot edit or delete posts.
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${SOCIAL_WEEKLY_LOG:-$HOME/.cache/social-weekly-buffer.log}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "== $(date -Is)"
# Reads the local checkout as is: posts are written here, and the tree is usually
# dirty with card frontmatter until daily-publish.sh commits it, so no git pull.
cd "$REPO"

export TZ=America/Chicago
today=$(date +%F)
# Next Monday (tomorrow when run on Sunday) through the Sunday after it.
start=$(date -d "next monday" +%F)
end=$(date -d "$start + 6 days" +%F)
prompt=$(sed -e "s|{{TODAY}}|$today|" -e "s|{{WEEK_START}}|$start|" -e "s|{{WEEK_END}}|$end|" \
  -e "s|{{REPO}}|$REPO|" scripts/social/weekly-buffer-prompt.md)

tools="Read,Glob,Grep"
for t in get_account list_channels list_posts get_post create_post; do tools="$tools,mcp__buffer__$t"; done
claude -p "$prompt" --allowedTools "$tools" --max-turns 80 < /dev/null
