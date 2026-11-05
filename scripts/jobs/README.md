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
pushes that branch, opens a PR and enables auto-merge (squash); it never pushes
main. Nothing changed: `nothing new`, exit 0. `cards-nightly.sh` refuses to run while
an earlier `bot/nightly-cards-*` PR is open, because the batch ids in that PR's
manifest would otherwise be lost and paid for twice. `JOB_DRY_RUN=1` commits locally
and pushes nothing.

Environment (from the chart's externalSecrets, names as in Vault):

- cards: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OG_WASABI_*`, `OG_WORK_DIR=/work/og`
  (PVC), optional `OG_NIGHTLY_LIMIT`, `OG_OPENAI_MONTHLY_CAP_USD`,
  `OG_ANTHROPIC_MONTHLY_CAP_USD`.
- social: `ANTHROPIC_API_KEY`, `BUFFER_API_KEY`, `OG_WORK_DIR` (shared Anthropic
  ledger), optional `SOCIAL_ANTHROPIC_RUN_CAP_USD` (default 3), `PUSHGATEWAY_URL`.
- all: `NPM_REGISTRY` (npm mirror; runtime dependencies are installed from it with
  `npm ci --omit=dev`, never from the public registry), `GH_TOKEN` and git push
  credentials from `website-job`.

Image tools: node 22, git, gh, jq, bash, ImageMagick 7 with
`/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf` (card compose), and hugo extended
plus Dart Sass at the versions pinned in `.github/workflows/cloudflare-workers.yml`
(daily-publish builds the site). No aws or vault CLI.
