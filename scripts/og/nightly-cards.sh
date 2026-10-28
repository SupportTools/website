#!/usr/bin/env bash
# Nightly: make up to OG_NIGHTLY_LIMIT share cards (default 40), posts publishing
# soonest first. daily-publish.sh (00:15) commits and pushes whatever went live.
#   0 22 * * * /path/to/website/scripts/og/nightly-cards.sh
#
# Holds .og-work/run.lock for the whole run; daily-publish.sh waits on it so it
# never commits a post whose manifest entry is mid-write. run.mjs stops on its
# own after 5 failures in a row (e.g. the Codex usage limit) and exits 2; it
# exits 3 when Vault is unreachable and uploads stopped.
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
# cron does not read ~/.bash_profile; without this the vault CLI tries 127.0.0.1:8200.
export VAULT_ADDR="${VAULT_ADDR:-https://vault.support.tools}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${OG_NIGHTLY_LOG:-$HOME/.cache/og-nightly-cards.log}"
mkdir -p "$(dirname "$LOG")" "$REPO/.og-work"
exec >>"$LOG" 2>&1
echo "== $(date -Is)"
exec 8>"$REPO/.og-work/run.lock"
flock -n 8 || { echo "another card run holds the lock"; exit 0; }
cd "$REPO"
# The upload key's Vault token is periodic (7-day period, no max TTL): renewing it
# every night keeps it alive indefinitely. If renewal fails, uploads stop and cards
# wait as "ready"; say so loudly in the log.
tokfile="${OG_VAULT_TOKEN_FILE:-$HOME/.config/support-tools-og/vault-token}"
if [ -s "$tokfile" ]; then
  VAULT_TOKEN=$(cat "$tokfile") vault token renew -format=json 2>&1 \
    | jq -r '"vault token renewed, ttl \(.auth.lease_duration)s"' 2>/dev/null \
    || echo "WARNING: vault token renew failed; re-mint it (scripts/og/README.md)"
fi
rc=0
node scripts/og/run.mjs --limit "${OG_NIGHTLY_LIMIT:-40}" --concurrency 2 || rc=$?
echo "run.mjs exit $rc"
exit "$rc"
