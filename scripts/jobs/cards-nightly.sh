#!/usr/bin/env bash
# In-cluster nightly share cards (publisher job kind nightly-cards), the OpenAI Batch
# flow of scripts/og/nightly-cards.sh without the workstation parts (Vault token,
# flock, log file, codex):
#   1. collect-batch: fetch art from earlier batches (raw.png into OG_WORK_DIR)
#   2. --only-drawn: compose, review (Anthropic API) and upload those cards
#   3. submit-batch: queue art for the next OG_NIGHTLY_LIMIT cards (default 40)
# then commits the manifest (and posts that gained a card) on bot/nightly-cards-<day>
# and opens an auto-merge PR. The manifest is committed even when a step failed:
# it records which batches are in flight, so the next night collects them instead
# of paying for them again. Exit: the last failing step's code (2 halted, 3 uploads
# stopped, 4 a monthly spend cap), else 0.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/jobs/lib.sh
. scripts/jobs/lib.sh

require_env OG_WORK_DIR OPENAI_API_KEY ANTHROPIC_API_KEY OG_WASABI_ACCESS_KEY_ID OG_WASABI_SECRET_ACCESS_KEY
export OG_IMAGE_PROVIDER=openai OG_REVIEW_PROVIDER=anthropic
mkdir -p "$OG_WORK_DIR"
ensure_node_deps
[ -n "${JOB_DRY_RUN:-}" ] || refuse_if_earlier_bot_pr nightly-cards

rc=0
job_log "collect-batch"
node scripts/og/run.mjs collect-batch || rc=$?
job_log "finish drawn cards"
node scripts/og/run.mjs --only-drawn --concurrency 2 || rc=$?
job_log "submit-batch"
node scripts/og/run.mjs submit-batch --limit "${OG_NIGHTLY_LIMIT:-40}" || rc=$?
node scripts/og/run.mjs status || true

stage_card_changes
if git diff --cached --quiet; then
  echo "nothing new"
  exit "$rc"
fi
check_live_cards_linked || exit 1
live=$(live_card_count)
if [ "$CARD_POSTS_STAGED" -gt 0 ]; then
  title="chore(og): $CARD_POSTS_STAGED more share cards ($live live)"
else
  title="chore(og): nightly card state ($live live)"
fi
publish_changes nightly-cards "$title"
exit "$rc"
