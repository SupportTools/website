#!/usr/bin/env bash
# Cron wrapper for scripts/social/guard.mjs (social link guards). Times are
# America/Chicago, the same clock as the Buffer posting slots:
#   15 8  * * * .../scripts/social/guard.sh preflight   # before the 08:45/08:53 slots
#   0  16 * * * .../scripts/social/guard.sh preflight   # before the 16:26/17:33 slots
#   30 1  * * * .../scripts/social/guard.sh promote     # after the 06:00 UTC rebuild is live
#   40 9  * * * .../scripts/social/guard.sh promote     # after the 09:10 rebuild is live
# Reads the local checkout's content files (where posts are written), so no git pull.
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${SOCIAL_GUARD_LOG:-$HOME/.cache/social-guard.log}"
mkdir -p "$(dirname "$LOG")" "$REPO/.og-work"
exec >>"$LOG" 2>&1
echo "== $(date -Is) $*"
exec 9>"$REPO/.og-work/social-guard.lock"
flock -w 600 9 || { echo "another guard run holds the lock"; exit 1; }
cd "$REPO"
node scripts/social/guard.mjs "$@"
rc=$?
echo "exit $rc"
exit $rc
