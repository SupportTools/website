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

## Requirements

- `codex` logged in (image generation). It runs with `--ignore-user-config`, so
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
