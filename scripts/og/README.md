# Share cards (Open Graph images)

Every post gets a unique 1200x630 share card: a Codex illustration of the
article's subject with the short title, topic chip and support.tools mark laid
over the left side. The card is hosted on `cdn.support.tools` and linked from the
post's frontmatter `images` field, which feeds `og:image`, `twitter:image` and the
JSON-LD Article `image` (and so Buffer's link previews). The post page also shows it
as a cover under the header (`blog/themes/m10c/layouts/_default/single.html`).

Design record: `docs/superpowers/specs/2026-10-21-og-share-cards-design.md`.

## Per post

1. **Generate**: `codex exec` reads the title, summary and opening prose and draws
   one illustration (`raw.png`) in the house style (dark navy, teal and amber,
   isometric, no text, left side kept clear).
2. **Compose**: ImageMagick crops to 1200x630, adds the fade, chip, title (the
   part before the first `: `) and brand, and writes an ~100 KB JPEG.
3. **Review**: `claude -p` (Sonnet) checks topic fit, thumbnail legibility and
   stray text. On doubt the card is redrawn once with the reviewer's note; a
   second doubt marks it `flagged` for a human.
4. **Upload**: to `s3://cdn.support.tools/posts/<slug>/og-<hash>.jpg` on Wasabi,
   then a HEAD through the CDN must return 200 `image/*`.
5. **Link**: only after that, `images: ["<url>"]` is written into the post.

Order: posts publishing in the next 14 days, then live posts newest first, then
the rest of the queue by date. State lives in `manifest.json` (committed); card
files live in the gitignored `.og-work/<slug>/` on the machine that ran them.

## Commands

```bash
npm run og -- --limit 50              # process the next 50 posts that need work
npm run og -- --no-upload --limit 50  # generate and review only
npm run og -- --slug <post-file-name> # one post, regardless of state
npm run og -- status
npm run og -- flagged                 # list + contact sheet .og-work/flagged.html
npm run og -- approve <slug>          # upload the flagged card as is
npm run og -- reject <slug> [note]    # redraw; the note is passed to Codex
npm run test:og
scripts/og/daily-publish.sh           # commit + push new cards (deploys); cron 00:15
```

`daily-publish.sh` stages only the manifest and posts whose sole change is an
`images:` line, refuses to commit if a live card is not linked from its post,
and logs to `~/.cache/og-daily-publish.log`. `OG_PUBLISH_DRY_RUN=1` checks
without committing.

## Image provider: Codex or OpenAI

`OG_IMAGE_PROVIDER` picks who draws `raw.png`: `codex` (the default, as above) or
`openai` (the images API). Unset, nothing changes: the workstation cron keeps using
Codex. Compose, review (still `claude -p`) and upload are the same either way.

With `openai`, a normal run (`--slug`, `--limit`) calls
`POST https://api.openai.com/v1/images/generations` synchronously for each card:
use this for a single "publish today" card. Backfill and nightly runs go through the
Batch API instead, at half the price:

```bash
export OG_IMAGE_PROVIDER=openai OPENAI_API_KEY=...   # key from the environment only
npm run og -- --slug <post>                     # one card now, synchronous
npm run og -- submit-batch --limit 200          # queue art for the next 200 cards
npm run og -- collect-batch [batch_id] [--wait 60]  # fetch finished art as raw.png
npm run og -- --only-drawn                      # compose, review, upload what came back
```

- `submit-batch` takes cards in the same order as a normal run (no card yet,
  `failed` or `rejected`; a rejection note goes into the prompt), writes a JSONL
  file (`custom_id` is the post slug, one `POST /v1/images/generations` per line;
  a copy is kept in `.og-work/batches/`), uploads it with `purpose=batch` and
  creates a batch with `completion_window: 24h`. Batches hold at most 100 cards
  (`DEFAULT_BATCH_MAX` in `lib/batch.mjs`),
  because each image is a few MB of base64 in the output file. Each card becomes
  `batched` with `batchId` in the manifest.
- `collect-batch` with no id checks every batch that still has `batched` cards. A
  batch still running is left alone. When it has finished (completed, expired,
  cancelled or failed), each image is decoded to `.og-work/<slug>/raw.png` and the
  card becomes `drawn`; a card the batch did not draw becomes `failed` with the
  reason (the API error, an unusable image, or the batch status), so the next run
  retries it. Collecting twice is harmless.
- A normal run composes `drawn` cards from their batch art and reviews them; a
  doubted card is redrawn with the configured provider.
- `nightly-cards.sh` runs collect, `--only-drawn` and submit when
  `OG_IMAGE_PROVIDER=openai` is set in its environment (with `OPENAI_API_KEY`).

Settings: `OG_OPENAI_MODEL` (default `gpt-image-2.5-sunburst`), `OG_OPENAI_SIZE`
(`1536x1024`, cropped to 1200x630 by compose), `OG_OPENAI_QUALITY` (`medium`). Every
request has a timeout; 429 and 5xx responses are retried up to 4 times with
exponential backoff (`Retry-After` honoured). A synchronous generation is not
retried after a timeout or dropped connection, since it may already be billed.
A missing key, a 401/403 or the cap stops the run without marking cards failed.

The default moved off `gpt-image-1-mini`, which OpenAI shuts down on 2026-12-01.
`gpt-image-2.5-flare` is also priced and can be chosen with `OG_OPENAI_MODEL`. GPT
Image 2.5 bills by tokens, so its per-image price in `lib/budget.mjs` is measured
from the API's `usage` (about $0.014 per card sync, half that in a Batch). Switching
model, size or quality means adding that price to `lib/budget.mjs` first (unknown
combinations are refused).

### Monthly spend cap

`OG_OPENAI_MONTHLY_CAP_USD` (default 25) caps the estimated OpenAI spend per UTC
calendar month. Each request is priced before it is sent from the per-image table in
`lib/budget.mjs` (from OpenAI's model and pricing pages, dated in the file) plus the
prompt's text tokens, with the 50% Batch discount for batches. Anything that would
push the month over the cap is refused with a message and nothing is sent;
`submit-batch` queues as many cards as fit and stops there (exit 4). Spend is
recorded before the request goes out, credited back when a request fails without
being billed, and settled per card by `collect-batch`.

The ledger is `.og-work/openai-ledger.json` (override with `OG_OPENAI_LEDGER`):
gitignored and machine-local like the card files and `run.lock`, so it never shows
up as a change for `daily-publish.sh` and is never published. It is an estimate on
one machine, not OpenAI's bill; set a matching hard limit in the OpenAI project too.
`npm run og -- status` shows the month so far.

## In-cluster settings (work dir, reviewer, upload key)

These keep the workstation behaviour unchanged when unset; the publisher's nightly
job (`scripts/jobs/cards-nightly.sh`) sets them.

- `OG_WORK_DIR`: where card files, batch JSONL and both spend ledgers live
  (default `.og-work/`). The job points it at a PVC (`/work/og`) so raw images and
  ledgers survive between runs of a fresh clone.
- `OG_REVIEW_PROVIDER`: `claude-cli` (default, the local `claude -p`), `anthropic`
  (the Messages API, `ANTHROPIC_API_KEY`, model `claude-haiku-5-5`, override with
  `OG_ANTHROPIC_REVIEW_MODEL`; the card goes up as a base64 image). Spend is
  recorded in `<work dir>/anthropic-ledger.json` (`OG_ANTHROPIC_LEDGER`) against
  `OG_ANTHROPIC_MONTHLY_CAP_USD` (default 10, per UTC month, shared with the weekly
  social drafter). At the cap the run stops with exit 4, as for OpenAI.
  INTERIM (TaskForge supporttools-website-990), a third value, `openai`: Chat
  Completions with `OPENAI_API_KEY`, the card attached as a base64 JPEG data URL,
  model `gpt-6-luna` (the cheapest non-deprecated vision model on
  developers.openai.com/api/docs/pricing and its model page, read 2026-11-04;
  override with `OG_OPENAI_REVIEW_MODEL`, which must have a price in
  `lib/openai-review.mjs`). Same prompt and verdict as the others. Spend goes in
  the OpenAI ledger (`OG_OPENAI_LEDGER`, counted as `reviews`, not `images`) under
  `OG_OPENAI_MONTHLY_CAP_USD`, shared with the art; at the cap the run exits 4. The
  nightly job uses it until #990 brings the Anthropic key.
- `OG_WASABI_ACCESS_KEY_ID` and `OG_WASABI_SECRET_ACCESS_KEY` (plus optional
  `OG_WASABI_BUCKET`, `OG_WASABI_ENDPOINT`, `OG_WASABI_REGION`, `OG_WASABI_PREFIX`):
  when both key halves are set the upload is a signed S3 PUT in plain node
  (`lib/s3.mjs`), with no `aws` or `vault` CLI. `OG_WASABI_PREFIX` is the key prefix
  the key may write (e.g. `posts/`): checked, never prepended. A refused key stops
  uploads (exit 3) like a Vault failure.

## Requirements

- `codex` logged in (image generation, default provider). It runs with `--ignore-user-config`, so
  `~/.codex/config.toml` (MCP servers, plugins) is not loaded per card; the model
  is pinned by `OG_CODEX_MODEL` (default `gpt-5.6-sol`) and `OG_CODEX_EFFORT`
  (default `high`).
- `claude` logged in, ImageMagick 7,
  `/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf` (or set `OG_FONT`).
- `vault` logged in, with the Wasabi key at `secret/infra/wasabi-supporttools-og`
  (IAM user `svc-supporttools-og`, PutObject only on `posts/*/og-*.jpg`; fields `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `bucket`, `endpoint`, `region`;
  override the path with `OG_VAULT_PATH`). For runs longer than the 24h OIDC
  login, a scoped token in `~/.config/support-tools-og/vault-token` (mode 600,
  override with `OG_VAULT_TOKEN_FILE`) is tried first: policy
  `workstation-website-og-read` (cluster-services `vault/policies/`), read-only on
  that one path, orphan, periodic (7-day period, no max TTL); `nightly-cards.sh`
  renews it every night, so it only lapses if the workstation is off for 7 days.
  Mint or re-mint it with
  `vault token create -orphan -policy=workstation-website-og-read -period=168h -display-name=website-og-cards -field=token > ~/.config/support-tools-og/vault-token`
  (under `umask 077`); revoke with `vault token revoke` on it. The key is read into the process at
  run time and passed only to `aws`; it is never printed or written. If Vault is
  unavailable, uploads stop and reviewed cards wait as `ready`.

This is an operator tool run from a workstation. It is not part of the site build
or CI, and the build never fetches these images.
