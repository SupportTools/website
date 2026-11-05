# In-cluster jobs

Run by the publisher's CronJobs as
`publisher job run --kind <kind> -- website-job <script>`. `website-job` (in the job
image) clones main into `/tmp/website` with a GitHub App installation token, exports
`GH_TOKEN`, sets the bot git author and runs `scripts/jobs/<script>` from the clone.
`publisher job run` records the run in the `jobs` table and exits with the script's code.

| Kind | Script | Does |
|---|---|---|
| `nightly-cards` | `cards-nightly.sh` | OpenAI Batch art: collect, finish drawn cards (Anthropic review, Wasabi upload), submit the next `OG_NIGHTLY_LIMIT` (default 40); commits the manifest and posts |
| `daily-publish` | `daily-publish.sh` | URL baseline (`tests/fixtures/published-urls.txt`) and any uncommitted live cards |
| `weekly-social` | `weekly-social.sh` | `scripts/social/weekly-drafter.mjs`: next week's Buffer drafts, then `guard.mjs check` |

A script that changes files commits on `bot/<kind>-<YYYYMMDD>` (America/Chicago),
pushes that branch, opens a PR and requests auto-merge (squash); it never pushes
main. Nothing changed: `nothing new`, exit 0. `cards-nightly.sh` refuses to run while
an earlier `bot/nightly-cards-*` PR is open (or while open PRs cannot be listed),
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

Environment (from the chart's externalSecrets, names as in Vault):

- cards: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OG_WASABI_*`, `OG_WORK_DIR=/work/og`
  (PVC), optional `OG_NIGHTLY_LIMIT`, `OG_OPENAI_MONTHLY_CAP_USD`,
  `OG_ANTHROPIC_MONTHLY_CAP_USD`.
- social: `ANTHROPIC_API_KEY`, `BUFFER_API_KEY`, `OG_WORK_DIR` (shared Anthropic
  ledger; required except for `--plan-only`), optional `SOCIAL_ANTHROPIC_RUN_CAP_USD`
  (default 3; a value that is not a number >= 0 exits 4), `PUSHGATEWAY_URL`.
- all: `GH_TOKEN` and git push credentials from `website-job`. Runtime npm
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
