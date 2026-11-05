# shellcheck shell=bash
# Shared helpers for the in-cluster job scripts in scripts/jobs/. Sourced, not run.
#
# The publisher CronJobs run `publisher job run --kind <kind> -- website-job <script>`.
# website-job (in the job image) mints a GitHub App installation token, shallow-clones
# SupportTools/website main into /tmp/website, exports GH_TOKEN for gh, configures git
# so `git push origin` authenticates without the token in argv or logs, sets the git
# author to support-tools-publisher[bot] and runs scripts/jobs/<script> from the clone.
#
# Changes never go to main directly: publish_changes commits on bot/<kind>-<YYYYMMDD>,
# pushes that branch, opens (or reuses) its PR and turns on auto-merge (squash), so
# the PR lands only once CI passes.

JOB_REPO="${WEBSITE_REPO:-SupportTools/website}"
JOB_DAY="$(TZ=America/Chicago date +%Y%m%d)"

job_log() { echo "$(date -u +%H:%M:%S) $*"; }

# Fails unless every named variable is set and non-empty (values are never printed).
require_env() {
  local missing=() v
  for v in "$@"; do [ -n "${!v:-}" ] || missing+=("$v"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "missing environment: ${missing[*]}" >&2
    return 1
  fi
}

# Installs runtime npm dependencies (only @anthropic-ai/sdk; dev tools are skipped)
# into the fresh clone. Fetch tier: the npm mirror named by NPM_REGISTRY (the
# in-cluster Verdaccio pull-through cache), with the image's npm cache tried first.
# Refuses to fall back to the public registry.
ensure_node_deps() {
  if [ -d node_modules/@anthropic-ai/sdk ]; then return 0; fi
  if [ -z "${NPM_REGISTRY:-}" ]; then
    echo "NPM_REGISTRY is not set; refusing to install npm dependencies from the public registry" >&2
    return 1
  fi
  job_log "npm ci (runtime dependencies) from the mirror"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --registry="$NPM_REGISTRY"
}

# Exits 1 when a PR from an earlier bot/<kind>-* branch is still open: its changes
# (for nightly-cards, the batch ids of art already paid for) are not on main yet,
# and running again from main would lose or repeat them.
refuse_if_earlier_bot_pr() {
  local kind=$1 open
  open=$(gh pr list -R "$JOB_REPO" --state open --limit 100 --json headRefName -q '.[].headRefName' \
    | grep "^bot/${kind}-" | grep -vx "bot/${kind}-${JOB_DAY}" || true)
  if [ -n "$open" ]; then
    echo "earlier ${kind} PR still open ($(echo "$open" | tr '\n' ' ')); merge or close it first" >&2
    return 1
  fi
}

# Stages the card manifest and every post whose only change is an added
# `images: ["https://cdn.support.tools/posts/...` line, so nothing else is ever
# swept in. Sets CARD_POSTS_STAGED and CARD_POSTS_SKIPPED.
stage_card_changes() {
  local f other
  CARD_POSTS_STAGED=0
  CARD_POSTS_SKIPPED=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    other=$(git diff -U0 -- "$f" | grep -E '^[-+][^-+]' | grep -vcE '^\+images *[:=] *\["https://cdn\.support\.tools/posts/' || true)
    if [ "$other" = 0 ]; then
      git add -- "$f"
      CARD_POSTS_STAGED=$((CARD_POSTS_STAGED + 1))
    else
      CARD_POSTS_SKIPPED=$((CARD_POSTS_SKIPPED + 1))
      echo "left unstaged (other edits): $f"
    fi
  done < <(git diff --name-only -- blog/content/post)
  git add -- scripts/og/manifest.json
}

# Every card marked live in the staged manifest must be linked from its staged post.
# Unstages everything and returns 1 otherwise.
check_live_cards_linked() {
  local -A path
  local p b slug url bad=0
  while IFS= read -r p; do b=${p##*/}; path[${b%.md}]=$p; done < <(git ls-files 'blog/content/post/*.md')
  while read -r slug url; do
    [ -n "$slug" ] || continue
    p=${path[$slug]:-}
    # grep without -q reads to EOF; -q exits early, git show gets SIGPIPE and pipefail fails.
    if [ -z "$p" ] || ! git show ":$p" | grep -F "$url" >/dev/null; then echo "MISMATCH $slug"; bad=$((bad + 1)); fi
  done < <(git show :scripts/og/manifest.json | jq -r 'to_entries[] | select(.value.status=="live") | "\(.key) \(.value.url)"')
  if [ "$bad" -gt 0 ]; then
    echo "$bad live cards not linked in staged posts; unstaging"
    git reset -q
    return 1
  fi
}

live_card_count() {
  git show :scripts/og/manifest.json | jq '[.[] | select(.status=="live")] | length'
}

# Commits what is staged on bot/<kind>-<day>, pushes it and opens or reuses its PR
# with auto-merge. Prints "nothing new" and returns 0 when nothing is staged.
# JOB_DRY_RUN=1 commits locally and prints what it would push, without pushing.
publish_changes() {
  local kind=$1 title=$2 body=${3:-}
  local branch="bot/${kind}-${JOB_DAY}"
  if git diff --cached --quiet; then
    echo "nothing new"
    return 0
  fi
  git checkout -q -B "$branch"
  git commit -q -m "$title"
  if [ -n "${JOB_DRY_RUN:-}" ]; then
    echo "dry run: would push $branch ($(git rev-parse --short HEAD)) and open a PR: $title"
    git diff --stat HEAD~1 HEAD
    return 0
  fi
  # A rerun on the same day replaces the branch (and so updates its open PR).
  git push -q --force origin "HEAD:refs/heads/${branch}"
  local state
  state=$(gh pr view "$branch" -R "$JOB_REPO" --json state -q .state 2>/dev/null || true)
  if [ "$state" != OPEN ]; then
    gh pr create -R "$JOB_REPO" --base main --head "$branch" --title "$title" \
      --body "${body:-Opened by the ${kind} job (publisher). Auto-merges (squash) once CI passes.}"
  fi
  gh pr merge "$branch" -R "$JOB_REPO" --auto --squash
  echo "pushed $branch ($(git rev-parse --short HEAD)): $title"
}
