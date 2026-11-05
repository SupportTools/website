#!/usr/bin/env bash
# In-cluster nightly share cards (publisher job kind nightly-cards), the OpenAI Batch
# flow of scripts/og/nightly-cards.sh without the workstation parts (Vault token,
# flock, log file, codex):
#   1. collect-batch: fetch art from earlier batches (raw.png into OG_WORK_DIR)
#   2. --only-drawn: compose, review (Anthropic API, or OpenAI: see below) and upload those cards
#   3. submit-batch: queue art for the next OG_NIGHTLY_LIMIT cards (default 40)
# then commits the manifest (and posts that gained a card) on bot/nightly-cards-<day>
# and opens a PR with auto-merge requested (or, in push-only mode, pushes the
# branch only and the bot-pr workflow opens the PR; see lib.sh). The manifest is
# committed even when a step failed or a live card is not linked from its post (then alone, with a "state
# only" title, and exit 1): it records which batches are in flight, so the next night
# collects them instead of paying for them again. Exit: the last failing step's code
# (2 halted, 3 uploads stopped, 4 a monthly spend cap), else 0.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/jobs/lib.sh
. scripts/jobs/lib.sh

# The reviewer is the Anthropic API unless OG_REVIEW_PROVIDER=openai. INTERIM
# (TaskForge supporttools-website-990): the chart sets openai while the job has no
# Anthropic key; #990 adds the key and drops the override, so anthropic stays the default.
OG_REVIEW_PROVIDER=${OG_REVIEW_PROVIDER:-anthropic}
case "$OG_REVIEW_PROVIDER" in
  anthropic) review_env=(ANTHROPIC_API_KEY) ;;
  openai) review_env=() ;; # reviews with OPENAI_API_KEY, already required
  *) echo "OG_REVIEW_PROVIDER must be anthropic or openai in the job, got $OG_REVIEW_PROVIDER" >&2; exit 1 ;;
esac
require_env OG_WORK_DIR OPENAI_API_KEY "${review_env[@]}" OG_WASABI_ACCESS_KEY_ID OG_WASABI_SECRET_ACCESS_KEY
export OG_IMAGE_PROVIDER=openai OG_REVIEW_PROVIDER
job_log "review provider: $OG_REVIEW_PROVIDER"
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
if ! check_live_cards_linked; then
  # The posts are not committed, but the manifest still is: it holds tonight's
  # in-flight batch ids, and dropping it would pay for that art again tomorrow.
  git add -- scripts/og/manifest.json
  publish_changes nightly-cards "chore(og): nightly card state only, live cards not linked ($(live_card_count) live)" \
    "Opened by the nightly-cards job (publisher). State only: some live cards are not linked from their posts (see the job log for MISMATCH lines), so no posts are included. Fix the links by hand; the batch ids here must land so they are not submitted again."
  exit 1
fi
live=$(live_card_count)
if [ "$CARD_POSTS_STAGED" -gt 0 ]; then
  title="chore(og): $CARD_POSTS_STAGED more share cards ($live live)"
else
  title="chore(og): nightly card state ($live live)"
fi
publish_changes nightly-cards "$title"
exit "$rc"
