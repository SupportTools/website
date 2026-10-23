You are drafting next week's social posts for the support.tools blog in Buffer.
Today is {{TODAY}}. The target week is {{WEEK_START}} (Monday) through {{WEEK_END}} (Sunday).
Work in the repo at {{REPO}}. Do not edit any file. Do not delete or edit Buffer posts.

## 1. Find the articles
Posts live in blog/content/post/*.md. An article publishes on the `date` in its
frontmatter (America/Chicago). Collect every post whose date falls in the target
week and is not `draft: true`. For each, note: title, description, slug (the file
name without .md), publish time (00:00 or 09:00 local), and the share card URL if
scripts/og/manifest.json has an entry for the slug with "status": "live".
The page URL is https://support.tools + the frontmatter `url` when it is set; a post
with no `url` lives at https://support.tools/post/<slug>/ (never /<slug>/).

## 2. Check Buffer
Organization "My Organization" 674ab6a112a6ba07b02cc3b3 (timezone America/Chicago).
Channels: LinkedIn 674ab74c9be8e4e2b7ec7886 (slots 08:45 and 17:33),
Bluesky 674ab6c69be8e4e2b7e9e909 (slots 08:53 and 16:26).
Call get_account for the current time and offset, then list_posts for both channels
covering the target week (drafts and scheduled). Skip any article whose URL already
appears in a post on that channel. Never schedule a dueAt in the past.

## 3. Write the posts (rules approved by the owner)
- LinkedIn: at most 1 post per day. When a day has two articles, pick the stronger
  one (prefer war stories, incidents and opinion pieces over generic guides).
  Native text with a concrete hook in the first line, a few short paragraphs of real
  substance from the article, 3-5 hashtags. Put the link in
  metadata.linkedin.firstComment, never in the body. If the article has a live share
  card, attach it as the post image.
- Bluesky: every article (up to 2 per day). One punchy line under 300 characters.
  Link via metadata.bluesky.linkAttachment {url, title, description, thumbnail}, with
  thumbnail set to the article's live share card URL (omit it only if there is none).
- Slot: an article publishing at 09:00 gets the afternoon slot (LinkedIn 17:33,
  Bluesky 16:26), because the morning slot fires before the page is live. An article
  publishing at 00:00 gets the morning slot (08:45 / 08:53). A second Bluesky article
  on the same day takes the other slot only if that slot is after its publish time;
  otherwise skip it.
- Links: the article's page URL from step 1 plus ?utm_source=linkedin&utm_medium=social
  (or utm_source=bluesky). After this run, scripts/social/guard.mjs checks every
  draft's link against the content files and reports any that do not match.
- No em dashes or en dashes anywhere in the copy. No emoji walls, no "In today's
  fast-paced world" openers, no invented facts: use only what the article says.
- dueAt: ISO 8601 in America/Chicago with the correct offset for that date
  (-05:00 during daylight time, -06:00 after DST ends on the first Sunday of November).
- Create every post with create_post, saveToDraft: true, mode: customScheduled.
  Do not add tags. The owner reviews the drafts and tags the ones to publish
  "approved"; scripts/social/guard.mjs promote then schedules each approved draft
  only after its article is live (its link returns 200).

## 4. Report
End with a short plain-text summary: for each day, which article went to which
channel and slot, which articles you skipped and why, and any errors. If there were
no articles in the week, say so and create nothing.
