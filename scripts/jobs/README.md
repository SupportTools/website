# In-cluster jobs

Run by the publisher's CronJobs as
`publisher job run --kind <kind> -- website-job <script>`. `website-job` (in the job
image) clones main into `/tmp/website` with a GitHub App installation token, exports
`GH_TOKEN`, sets the bot git author and runs `scripts/jobs/<script>` from the clone.
`publisher job run` records the run in the `jobs` table and exits with the script's code.

| Kind | Script | Does |
|---|---|---|
| `nightly-cards` | `cards-nightly.sh` | OpenAI Batch art: collect, finish drawn cards (Anthropic or, interim, OpenAI review; Wasabi upload), submit the next `OG_NIGHTLY_LIMIT` (default 40); commits the manifest and posts |
| `daily-publish` | `daily-publish.sh` | URL baseline (`tests/fixtures/published-urls.txt`) and any uncommitted live cards |
| `weekly-social` | `weekly-social.sh` | `scripts/social/weekly-drafter.mjs`: next week's Buffer drafts, then `guard.mjs check` |

A script that changes files commits on `bot/<kind>-<YYYYMMDD>` (America/Chicago),
pushes that branch, opens a PR and requests auto-merge (squash); it never pushes
main. In deploy-key mode (below) it only pushes the branch and the bot-pr workflow
opens the PR. Nothing changed: `nothing new`, exit 0. `cards-nightly.sh` refuses to run while
an earlier `bot/nightly-cards-*` PR is open (or while open PRs cannot be listed; in
deploy-key mode, while an earlier such branch is on the remote),
because the batch ids in that PR's manifest would otherwise be lost and paid for
twice. When a live card is not linked from its post, it still commits the manifest
alone ("state only") and exits 1. `JOB_DRY_RUN=1` commits locally and pushes nothing.

Merging: a bot PR lands without a human only when all of these hold in the repo
settings; until then a human approves and merges each one, and the nightly cards
job stops at the next run while yesterday's PR is open.

1. Auto-merge allowed (`allow_auto_merge`). Otherwise the auto-merge request fails;
   the job warns and leaves the PR open.
2. The CI `Test` check required on main. Do this before (1): with no required
   check, auto-merge merges at once, ungated.
3. The publisher GitHub App able to pass the review rule (a ruleset bypass actor for
   the App on `bot/*` PRs), or no approving review required for those PRs.

## Deploy-key mode (INTERIM, TaskForge supporttools-website-990)

Until #990 gives the jobs the publisher GitHub App (and the Anthropic key), they can
run with a write deploy key instead. `website-job` uses the App whenever `GH_APP_*`
is set; otherwise, with `GIT_DEPLOY_KEY` set (Vault `secret/publisher/github-deploy-key`,
chart externalSecrets item `githubDeployKey`), it clones and pushes over SSH with
GitHub's host keys baked into the image, exports `WEBSITE_GIT_MODE=deploy-key` and
does not export `GH_TOKEN`. With `GH_TOKEN` unset, `lib.sh` makes no `gh` call:

- `publish_changes` pushes `bot/<kind>-<YYYYMMDD>` only (never main) and prints that
  the bot-pr workflow opens the PR. No auto-merge is requested.
- `.github/workflows/bot-pr.yml` runs on every push to `bot/**` (permissions
  `contents: read`, `pull-requests: write`) and opens a PR to main titled with the
  head commit subject, unless one is already open for that branch. It never merges
  and never enables auto-merge; a human merges. It waits 60s first so that a job in
  App mode, which opens its own PR, is never raced.
- PRs opened with `GITHUB_TOKEN` do not trigger `pull_request` workflows, so
  `cloudflare-workers.yml` also runs on pushes to `bot/**`: the Test check lands on
  the PR's head commit. Deploy-Production only runs for `refs/heads/main` (and the
  schedule), so a bot branch never deploys.
- The "earlier bot PR still open" check reads the remote instead of gh:
  `git ls-remote --heads origin 'refs/heads/bot/<kind>-*'`. Any earlier branch still
  there stops the job (and so does a failed ls-remote).

Repository settings this mode needs (an admin sets them; nothing here changes them):

1. "Allow GitHub Actions to create and approve pull requests" (Settings > Actions >
   General). Without it the bot-pr run fails with "GitHub Actions is not permitted to
   create or approve pull requests" and no PR opens.
2. "Automatically delete head branches" (Settings > General). A merged PR's branch
   must disappear, or the next run of that kind refuses to start. A PR closed without
   merging leaves its branch: delete it by hand once its changes are not needed.

The nightly cards job reviews with OpenAI in this period: the chart sets
`OG_REVIEW_PROVIDER=openai` (see `scripts/og/README.md`), so it needs no
`ANTHROPIC_API_KEY`; review spend shares the OpenAI ledger and
`OG_OPENAI_MONTHLY_CAP_USD` with the art (exit 4 at the cap). Unset, the job reviews
with the Anthropic API as before. Weekly social stays disabled: it has no OpenAI path.

Environment (from the chart's externalSecrets, names as in Vault):

- cards: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (not with `OG_REVIEW_PROVIDER=openai`),
  `OG_WASABI_*`, `OG_WORK_DIR=/work/og` (PVC), optional `OG_REVIEW_PROVIDER`
  (`anthropic`, the default, or `openai`), `OG_NIGHTLY_LIMIT`,
  `OG_OPENAI_MONTHLY_CAP_USD`, `OG_ANTHROPIC_MONTHLY_CAP_USD`, `OG_OPENAI_REVIEW_MODEL`.
- social: `ANTHROPIC_API_KEY`, `BUFFER_API_KEY`, `OG_WORK_DIR` (shared Anthropic
  ledger; required except for `--plan-only`), optional `SOCIAL_ANTHROPIC_RUN_CAP_USD`
  (default 3; a value that is not a number >= 0 exits 4), `PUSHGATEWAY_URL`.
- all: `GH_TOKEN` and git push credentials from `website-job` (App mode), or
  `GIT_DEPLOY_KEY` and no `GH_TOKEN` (deploy-key mode, above). Runtime npm
  dependencies (`@anthropic-ai/sdk`, the version `package.json` pins) come from the
  image: `JOB_NODE_MODULES` (default `/opt/website-node/node_modules`) is symlinked
  to `./node_modules` (a symlink because ESM `import()` ignores `NODE_PATH`). Only
  when that is missing or a different version: `npm ci --omit=dev` from
  `NPM_REGISTRY` (the npm mirror), never from the public registry.

Image tools: node 22, git, gh, jq, bash, `@anthropic-ai/sdk@0.137.0` installed under
`/opt/website-node/node_modules` at image build (from the npm mirror), ImageMagick 7 with
`/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf` (card compose), and hugo extended
plus Dart Sass at the versions pinned in `.github/workflows/cloudflare-workers.yml`
(daily-publish builds the site). No aws or vault CLI.
