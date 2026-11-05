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

# Exits 1 when a PR from an earlier bot/<kind>-* branch is still open: its changes
# (for nightly-cards, the batch ids of art already paid for) are not on main yet,
# and running again from main would lose or repeat them.
refuse_if_earlier_bot_pr() {
  local kind=$1 prs open
  # A gh failure (auth, rate limit, network) must stop the job, not read as "no PR".
  prs=$(gh pr list -R "$JOB_REPO" --state open --limit 100 --json headRefName -q '.[].headRefName') \
    || { echo "cannot list open PRs; refusing to run" >&2; return 1; }
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
# asks for auto-merge. Prints "nothing new" and returns 0 when nothing is staged.
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
      --body "${body:-Opened by the ${kind} job (publisher). Auto-merge (squash) is requested; it lands once the branch protection on main is satisfied.}"
  fi
  # Fails while the repo's auto-merge setting is off. The PR is open either way, so
  # this only warns; the next run's refuse_if_earlier_bot_pr still guards against a
  # PR nobody merged.
  gh pr merge "$branch" -R "$JOB_REPO" --auto --squash \
    || echo "WARNING: auto-merge not enabled for $branch (is the repo's auto-merge setting on?); a human must merge it" >&2
  echo "pushed $branch ($(git rev-parse --short HEAD)): $title"
}
