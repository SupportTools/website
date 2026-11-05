#!/usr/bin/env bash
# In-cluster weekly social drafts (publisher job kind weekly-social): runs the API
# drafter (scripts/social/weekly-drafter.mjs: Anthropic Messages API with tool use,
# Buffer GraphQL API) for next Monday-Sunday, then the same report-only link check
# weekly-buffer.sh runs. Drafts only; changes no files, so it never opens a PR.
# Arguments pass through to the drafter (for example --dry-run or --plan-only).
# Exit: the drafter's code (0 all planned drafts exist, 2 some missing, 4 spend cap,
# 1 failed); the guard check only reports.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=scripts/jobs/lib.sh
. scripts/jobs/lib.sh

# OG_WORK_DIR (the PVC) holds the monthly Anthropic ledger shared with the card
# reviewer; without it the ledger would start empty in every fresh clone and the
# monthly cap could not hold, so any run that calls Anthropic requires it.
case " $* " in
  *" --plan-only "*) ;;
  *" --dry-run "*) require_env ANTHROPIC_API_KEY OG_WORK_DIR ;;
  *) require_env ANTHROPIC_API_KEY BUFFER_API_KEY OG_WORK_DIR ;;
esac
ensure_node_deps

rc=0
node scripts/social/weekly-drafter.mjs "$@" || rc=$?
case " $* " in
  *" --plan-only "*|*" --dry-run "*) ;;
  *) SOCIAL_GUARD_NOTIFY=0 node scripts/social/guard.mjs check || echo "guard check reported problems (see above)" ;;
esac
exit "$rc"
