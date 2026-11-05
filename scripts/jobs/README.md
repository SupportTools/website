# In-cluster jobs

Run by the publisher's CronJobs as
`publisher job run --kind <kind> -- website-job <script>`. `website-job` (in the job
image) clones main into `/tmp/website` with an installation token for the dedicated
`supporttools-publisher-bot` GitHub App (`contents` and `pull-requests` write, installed
on this repo only), exports `GH_TOKEN`, sets the bot git author (the job env sets
`GIT_BOT_NAME` to `supporttools-publisher-bot[bot]`) and runs `scripts/jobs/<script>`
from the clone.
`publisher job run` records the run in the `jobs` table and exits with the script's code.

| Kind | Script | Does |
|---|---|---|
| `nightly-cards` | `cards-nightly.sh` | OpenAI Batch art: collect, finish drawn cards (Anthropic or, interim, OpenAI review; Wasabi upload), submit the next `OG_NIGHTLY_LIMIT` (default 40); commits the manifest and posts |
| `daily-publish` | `daily-publish.sh` | URL baseline (`tests/fixtures/published-urls.txt`) and any uncommitted live cards |
| `weekly-social` | `weekly-social.sh` | `scripts/social/weekly-drafter.mjs`: next week's Buffer drafts, then `guard.mjs check` |

A script that changes files commits on `bot/<kind>-<YYYYMMDD>` (America/Chicago),
pushes that branch, opens a PR and requests auto-merge (squash); it never pushes
main. In the push-only fallback (below) it only pushes the branch. Nothing changed:
`nothing new`, exit 0. `cards-nightly.sh` refuses to run while
an earlier `bot/nightly-cards-*` PR is open (or while open PRs cannot be listed; in
the push-only fallback, while an earlier such branch is on the remote),
because the batch ids in that PR's manifest would otherwise be lost and paid for
twice. When a live card is not linked from its post, it still commits the manifest
alone ("state only") and exits 1. `JOB_DRY_RUN=1` commits locally and pushes nothing.

Merging: a bot PR lands without a human because the repo settings allow it:

1. Auto-merge allowed (`allow_auto_merge`). Were it off, the auto-merge request would
   fail; the job warns and leaves the PR open for a human.
2. The CI `Test` check required on main, so auto-merge waits for it.
   `cloudflare-workers.yml` runs Test on pushes to `bot/**` (and on the PR).
   Deploy-Production only runs for `refs/heads/main` (and the schedule), so a bot
   branch never deploys.
3. "Automatically delete head branches" (Settings > General). A merged PR's branch
   disappears; a PR closed without merging leaves its branch, which the push-only
   fallback's earlier-PR check would count as open: delete it by hand once its
   changes are not needed.

While yesterday's nightly cards PR is still open, the nightly cards job stops at the
next run.

## Push-only fallbacks (TaskForge supporttools-website-990, unused today)

Before the `supporttools-publisher-bot` App existed the jobs ran with a credential
that could push but not open PRs, and `lib.sh` keeps those code paths as fallbacks.
`website-job` exports `WEBSITE_GIT_MODE` to select one:

- `app-push-only`: the CronJob sets `WEBSITE_PUSH_ONLY=1` and the `GH_APP_*`
  credentials are an App with `contents: write` but no `pull-requests` permission.
  `GH_TOKEN` is set (pushes use it), but `gh pr list/create/merge` would be refused.
- `deploy-key`: no App; with `GIT_DEPLOY_KEY` set it clones and pushes over SSH with
  GitHub's host keys baked into the image and does not export `GH_TOKEN`. (An
  enterprise policy blocks deploy keys on this repo.)

In both, whatever `GH_TOKEN` holds, `lib.sh` makes no `gh` call. Full App mode (gh
opens the PR and requests auto-merge, the mode in use) is `WEBSITE_GIT_MODE` unset
with `GH_TOKEN` set. An empty `GH_TOKEN` with `WEBSITE_GIT_MODE` unset (an App token
that failed to mint), or any other `WEBSITE_GIT_MODE` value, stops the job before any
push:

- `publish_changes` pushes `bot/<kind>-<YYYYMMDD>` only (never main), opens no PR and
  requests no auto-merge; a human opens and merges the PR. (No workflow opens it: the
  enterprise policy refuses "Allow GitHub Actions to create and approve pull
  requests".)
- The "earlier bot PR still open" check reads the remote instead of gh:
  `git ls-remote --heads origin 'refs/heads/bot/<kind>-*'`. Any earlier branch still
  there stops the job (and so does a failed ls-remote).

The nightly cards job may review with OpenAI: with `OG_REVIEW_PROVIDER=openai` (see
`scripts/og/README.md`) it needs no `ANTHROPIC_API_KEY`; review spend shares the
OpenAI ledger and `OG_OPENAI_MONTHLY_CAP_USD` with the art (exit 4 at the cap). Unset,
the job reviews with the Anthropic API. Weekly social has no OpenAI path.

Environment (from the chart's externalSecrets, names as in Vault):

- cards: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (not with `OG_REVIEW_PROVIDER=openai`),
  `OG_WASABI_*`, `OG_WORK_DIR=/work/og` (PVC), optional `OG_REVIEW_PROVIDER`
  (`anthropic`, the default, or `openai`), `OG_NIGHTLY_LIMIT`,
  `OG_OPENAI_MONTHLY_CAP_USD`, `OG_ANTHROPIC_MONTHLY_CAP_USD`, `OG_OPENAI_REVIEW_MODEL`.
- social: `ANTHROPIC_API_KEY`, `BUFFER_API_KEY`, `OG_WORK_DIR` (shared Anthropic
  ledger; required except for `--plan-only`), optional `SOCIAL_ANTHROPIC_RUN_CAP_USD`
  (default 3; a value that is not a number >= 0 exits 4), `PUSHGATEWAY_URL`.
- all: `GH_TOKEN` and git push credentials from `website-job` (App mode), or, in a
  push-only fallback (above), `WEBSITE_GIT_MODE=app-push-only` or `deploy-key` with
  its push credential. Runtime npm
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
