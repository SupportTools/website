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
# pushes that branch, opens (or reuses) its PR and asks for auto-merge (squash). The
# PR merges only when main's branch protection is satisfied: with the repo's
# auto-merge setting on, the CI `Test` check required, and the publisher App allowed
# past the review rule, that is once CI passes; otherwise a human approves and merges
# it. A failed auto-merge request is reported, not fatal (the PR is already open).
#
# Push-only mode, INTERIM (TaskForge supporttools-website-990 replaces it with the
# full GitHub App): website-job exports WEBSITE_GIT_MODE as one of
#   deploy-key     cloned and pushing over SSH with a write deploy key (GIT_DEPLOY_KEY),
#                  no GH_TOKEN;
#   app-push-only  the CronJob set WEBSITE_PUSH_ONLY=1: GH_TOKEN comes from an App
#                  (supporttools-chart-publisher) with contents:write but no
#                  pull-requests permission, so gh pr list/create/merge would fail.
# In either, regardless of GH_TOKEN, these helpers make no gh call at all:
# publish_changes pushes bot/<kind>-<YYYYMMDD> only (never main) and the bot-pr
# workflow (.github/workflows/bot-pr.yml) opens the PR for a human to merge, and the
# earlier-PR check reads the remote's bot/<kind>-* branches with git ls-remote.
# WEBSITE_GIT_MODE unset with GH_TOKEN set is full App mode (above); anything else
# stops the job.

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

# Provides the runtime npm dependencies (only @anthropic-ai/sdk) to the fresh clone.
# Fetch tier, in order:
#   1. baked into the job image: JOB_NODE_MODULES (default /opt/website-node/node_modules)
#      is symlinked to ./node_modules when its @anthropic-ai/sdk is the version
#      package.json pins. A symlink, not NODE_PATH: ESM import() ignores NODE_PATH.
#   2. fallback, a mirror we run: `npm ci --omit=dev` from NPM_REGISTRY (CI uses the
#      in-cluster Verdaccio pull-through cache, cluster-services npm-proxy/).
# Never falls back to the public registry.
ensure_node_deps() {
  if [ -d node_modules/@anthropic-ai/sdk ]; then return 0; fi
  local baked=${JOB_NODE_MODULES:-/opt/website-node/node_modules} want have
  want=$(jq -r '.dependencies["@anthropic-ai/sdk"] // empty' package.json 2>/dev/null || true)
  have=$(jq -r .version "$baked/@anthropic-ai/sdk/package.json" 2>/dev/null || true)
  if [ -n "$have" ] && [ "$have" = "$want" ] && [ ! -e node_modules ]; then
    ln -s "$baked" node_modules
    job_log "node_modules: baked into the image (@anthropic-ai/sdk $have)"
    return 0
  fi
  [ -z "$have" ] || echo "baked @anthropic-ai/sdk is $have, package.json pins $want; installing from the mirror" >&2
  if [ -z "${NPM_REGISTRY:-}" ]; then
    echo "NPM_REGISTRY is not set; refusing to install npm dependencies from the public registry" >&2
    return 1
  fi
  job_log "npm ci (runtime dependencies) from the mirror"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --registry="$NPM_REGISTRY"
}

# Push-only mode (INTERIM, #990), see the header. Returns 0 for push-only (deploy-key
# or app-push-only, whatever GH_TOKEN holds) and 1 for full App mode (WEBSITE_GIT_MODE
# unset, GH_TOKEN set). An App token that failed to mint and was exported empty, or an
# unknown WEBSITE_GIT_MODE, must stop the job, not quietly pick a mode. Exits (not
# returns) so an `if` cannot swallow it.
push_only_mode() {
  case "${WEBSITE_GIT_MODE:-}" in
    deploy-key | app-push-only) return 0 ;;
    '') ;;
    *)
      echo "unknown WEBSITE_GIT_MODE ${WEBSITE_GIT_MODE}; refusing to run" >&2
      exit 1
      ;;
  esac
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "GH_TOKEN is empty and WEBSITE_GIT_MODE is not deploy-key or app-push-only; refusing to run" >&2
    exit 1
  fi
  return 1
}

# Exits 1 when a PR from an earlier bot/<kind>-* branch is still open: its changes
# (for nightly-cards, the batch ids of art already paid for) are not on main yet,
# and running again from main would lose or repeat them.
refuse_if_earlier_bot_pr() {
  local kind=$1 prs open
  if push_only_mode; then
    # INTERIM (#990): no gh (no token, or one without pull-requests access), so any earlier bot/<kind>-* branch still on the
    # remote counts as an open PR. A merged PR's branch is deleted (the repo's
    # "Automatically delete head branches" setting); a branch left behind by a PR
    # closed without merging must be deleted by hand. A failed ls-remote stops the job.
    prs=$(git ls-remote --heads origin "refs/heads/bot/${kind}-*") \
      || { echo "cannot list remote bot/${kind}-* branches; refusing to run" >&2; return 1; }
    prs=$(sed -n 's#^[0-9a-f]*[[:space:]]*refs/heads/##p' <<<"$prs")
  else
    # A gh failure (auth, rate limit, network) must stop the job, not read as "no PR".
    prs=$(gh pr list -R "$JOB_REPO" --state open --limit 100 --json headRefName -q '.[].headRefName') \
      || { echo "cannot list open PRs; refusing to run" >&2; return 1; }
  fi
  open=$(grep "^bot/${kind}-" <<<"$prs" | grep -vx "bot/${kind}-${JOB_DAY}" || true)
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
    # Every added or removed line after the first hunk header (so a `+- item` or a
    # blank `+` counts), other than the one images line.
    other=$(git diff -U0 -- "$f" | awk '/^@@/ { h = 1; next } h && /^[-+]/' \
      | grep -vcE '^\+images *[:=] *\["https://cdn\.support\.tools/posts/' || true)
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

# Commits what is staged on bot/<kind>-<day>, pushes it, opens or reuses its PR and
# asks for auto-merge (push-only mode: pushes only, the bot-pr workflow opens the PR).
# Prints "nothing new" and returns 0 when nothing is staged.
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
  case "$branch" in bot/*) ;; *) echo "refusing to push $branch: only bot/* branches" >&2; return 1 ;; esac
  # The mode is settled before the push, so an empty token or an unknown
  # WEBSITE_GIT_MODE stops here with nothing pushed (INTERIM, #990).
  local push_only=
  if push_only_mode; then push_only=1; fi
  # A rerun on the same day replaces the branch (and so updates its open PR).
  git push -q --force origin "HEAD:refs/heads/${branch}"
  if [ -n "$push_only" ]; then
    # INTERIM (#990): the credential can push but cannot open PRs (a deploy key, or an
    # App without pull-requests permission), so the bot-pr workflow opens the PR on
    # this push; it never merges, a human does.
    echo "pushed $branch ($(git rev-parse --short HEAD)): $title"
    echo "${WEBSITE_GIT_MODE} mode: no PR opened here; the bot-pr workflow opens the PR for $branch and a human merges it"
    return 0
  fi
  local state
  state=$(gh pr view "$branch" -R "$JOB_REPO" --json state -q .state 2>/dev/null || true)
  if [ "$state" != OPEN ]; then
    # The bot-pr workflow (INTERIM, #990) may have opened it in the meantime; that is fine.
    gh pr create -R "$JOB_REPO" --base main --head "$branch" --title "$title" \
      --body "${body:-Opened by the ${kind} job (publisher). Auto-merge (squash) is requested; it lands once the branch protection on main is satisfied.}" \
      || [ "$(gh pr view "$branch" -R "$JOB_REPO" --json state -q .state 2>/dev/null || true)" = OPEN ] \
      || { echo "could not open a PR for $branch" >&2; return 1; }
  fi
  # Fails while the repo's auto-merge setting is off. The PR is open either way, so
  # this only warns; the next run's refuse_if_earlier_bot_pr still guards against a
  # PR nobody merged.
  gh pr merge "$branch" -R "$JOB_REPO" --auto --squash \
    || echo "WARNING: auto-merge not enabled for $branch (is the repo's auto-merge setting on?); a human must merge it" >&2
  echo "pushed $branch ($(git rev-parse --short HEAD)): $title"
}
