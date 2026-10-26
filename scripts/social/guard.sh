#!/usr/bin/env bash
# Manual wrapper for scripts/social/guard.mjs (social link guards) on a workstation.
# The scheduled runs (preflight 08:15 and 16:00, promote 01:30 and 09:40, check 18:45,
# America/Chicago) moved to a1-ops-prd CronJobs on 2026-10-23: cluster-services
# monitoring/a1-ops-prd/blog-social-guard.yaml. Do not also schedule this, or both
# will edit the same Buffer posts.
#   scripts/social/guard.sh check            # report only
#   scripts/social/guard.sh preflight --dry-run
# Reads the local checkout's content files as they are, so no git pull.
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
