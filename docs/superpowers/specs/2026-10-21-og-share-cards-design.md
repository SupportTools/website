# Share cards for every post: design

Date: 2026-10-21. Status: approved in conversation; implemented in `scripts/og/`.

## Why

The goal is more traffic to the blog. Today every page falls back to the 200x200
site logo for `og:image`, so LinkedIn and Bluesky link cards show no picture,
Buffer previews are blank, and the JSON-LD Article image (40K pixels) is below
Google's 50K-pixel minimum, which keeps posts out of image-rich results and
Discover. A distinct, on-topic image per post fixes all three.

## Decisions (the owner's)

- **Style B**: an AI illustration of the article's subject with a short title
  overlay, chosen over a plain title card (A) and a hook-text card (C).
- **Codex generates** the illustrations.
- **Every post**, including the ~800 already published, not only posts that are
  shared socially (~2,900 in total).
- **AI review, human for doubtful ones**: a second model judges each card and
  only doubtful ones reach the owner.
- **Hosted on the Wasabi bucket behind cdn.support.tools**, uploaded ahead of
  publish; images are not committed to git (only a manifest is).
- **Vault** holds the upload key; the path follows the `secret/<app>/<purpose>`
  convention of the existing CDN push keys.

## Calls made by Claude (open to override)

- Text is composited by ImageMagick, never drawn by the image model (models
  misspell; scripted type is uniform and re-renderable without regenerating).
- Short title is the part before the first `: `; chip is the first category.
- Codex picks the scene from the title, summary and opening prose (code blocks
  removed), under fixed style rules; prompt text is versioned (`PROMPT_VERSION`).
- Reviewer is Claude Sonnet via `claude -p` (a different model family from the
  generator). Unparseable output counts as doubt. One automatic redraw with the
  reviewer's note before flagging.
- Object keys carry a content hash (`posts/<slug>/og-<hash>.jpg`) with
  `Cache-Control: immutable`; a redraw gets a new key instead of fighting caches.
- Frontmatter is changed only after the CDN serves the image, so a post never
  points at a missing image. Posts without a card keep the logo fallback.
- Order: next 14 days of the queue (feeds the Buffer pilot), then live posts
  newest first, then the rest of the queue. Traffic-ranked ordering of live
  posts was intended but no analytics source is wired in; newest-first stands in.
- Vault path: `secret/infra/wasabi-supporttools-og`, mirroring `secret/infra/wasabi-taskforge-cdn`: IAM user `svc-supporttools-og` minted from `svc-wasabi-admin`, managed policy `cdn-support-tools-og` allowing only `s3:PutObject` on `cdn.support.tools/posts/*/og-*.jpg` (cannot read, delete, or overwrite other assets). The policy also carries explicit
  Deny statements (writes outside that pattern; all deletes and bucket changes),
  because the bucket ACL's owner FULL_CONTROL grant lets every Wasabi sub-user write
  and delete anywhere in this bucket regardless of its IAM Allow; only an explicit
  Deny overrides that. Verified 2026-10-21 after propagation: outside put and
  deletes return AccessDenied, card put succeeds.
- Runs on the operator workstation where `codex` and `claude` are logged in; a
  cloud routine cannot use the Codex login. The weekly social routine only reads
  the manifest and existing image URLs.

## Non-goals

- No change to the theme or build: Hugo's internal OG/Twitter templates and the
  structured-data partial already emit an absolute `images[0]` unchanged
  (verified by build: `og:image`, `twitter:image` with `summary_large_image`,
  JSON-LD `image`).
- No image fetching at build time, no CI dependency on the CDN or the models.
- Not touching `cdn.support.tools/` in the repo or reviving its sync job.

## Measured

- One post end to end: ~66 s (Codex ~55 s, compose ~2 s, review ~6 s);
  card ~100 KB JPEG. The backlog is roughly 50-60 machine hours at concurrency 1,
  less at concurrency 2 subject to Codex rate limits.
