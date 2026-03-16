# Blog Post Publisher

Publish the blog post "$ARGUMENTS" to production at support.tools.

## Overview

Topic/filename: **$ARGUMENTS**

This command validates, commits, deploys, and verifies a single blog post.
Work through each step in order. Do NOT skip validation steps.

---

## Step 1: Locate the Post

- If `$ARGUMENTS` ends in `.md` — look for `blog/content/post/$ARGUMENTS`
- If `$ARGUMENTS` does not end in `.md` — look for `blog/content/post/$ARGUMENTS.md`
- If the exact file is not found, use Grep to search filenames and `title:` frontmatter for
  the argument, then ask the user to confirm which file to publish

Read the first 20 lines (frontmatter block) of the file.

---

## Step 2: Pre-Publish Validation

Check all of the following. Report any failures and ask the user how to proceed before
continuing.

### 2a — Draft Status
- `draft` must be `false`. If it is `true` or missing, **stop and report** — do not publish a
  draft post without explicit user confirmation.

### 2b — Date Safety (Critical)
The GitHub Actions CI build runs in UTC. Hugo excludes future-dated posts by default
(no `--buildFuture` flag is used). A post dated e.g. `2026-03-15T09:00:00-05:00` equals
`14:00 UTC`, which is in the future if the CI build runs before that time.

**Rule:** Convert the post `date` to UTC. If the UTC equivalent is more than 30 minutes
in the future from now, the post WILL be excluded from the build.

- Compute UTC equivalent of the post date
- Compare against current UTC time
- If immediate publish is intended: update the date to `{yesterday's date}T00:00:00-05:00`
  (05:00 UTC the prior day — unambiguously in the past for both on-demand and nightly builds)
- If scheduling for a future date (nightly auto-publish): leave the date as-is — the nightly
  pipeline will pick it up when that date passes
- Report any date change to the user before proceeding

### 2c — Required Frontmatter
Verify these fields are present and non-empty:
- `title` — non-empty string
- `date` — valid ISO 8601 with timezone
- `tags` — array with at least one entry
- `categories` — array with at least one entry
- `author` — `"Matthew Mattox - mmattox@support.tools"`
- `description` — non-empty string
- `url` — starts and ends with `/`

If any field is missing or malformed, report the issue. Ask the user whether to fix and
continue or abort.

---

## Step 3: Confirm Publish

Present a summary to the user:

```
Post:        <title>
File:        blog/content/post/<filename>
Date (UTC):  <computed UTC date>
URL:         https://support.tools<url-field>
Draft:       false ✓
```

Ask: "Should I commit and publish this post?"

**STOP and wait for the user's response.**

---

## Step 4: Commit and Push

Only stage the single post file — do not use `git add .` or `git add -A`:

```bash
git add blog/content/post/<filename>
```

Commit using conventional commit format. Use the post title to form the message:

```bash
git commit -m "feat: publish blog post — <title>"
```

Push to main:

```bash
git push origin main
```

Report the commit hash.

---

## Step 5: Monitor CI Pipeline

Run:
```bash
gh run list --limit 3 --repo SupportTools/website --workflow="Deploy to Cloudflare Workers"
```

Get the run ID for the commit just pushed, then watch it:
```bash
gh run watch <run-id> --repo SupportTools/website
```

Report each job's status as it completes (Test → Deploy-Staging → Deploy-Production).
If any job fails, report the failure and stop — do not attempt to re-push.

---

## Step 6: Verify Production

Once the pipeline completes successfully, verify the post is live:

```bash
curl -sI https://support.tools<url-field>
```

Expected: `HTTP/2 200`

If 404 is returned:
1. Check that the post date (UTC) was in the past at build time (Step 2b may not have caught
   an edge case — report this)
2. Check that the `url` frontmatter field matches the actual Hugo slug

Report the final result:

```
✓ Published successfully
  Live URL: https://support.tools<url-field>
  HTTP status: 200
  Pipeline: <run-url>
```

Or if failed:
```
✗ Publish failed — <reason>
  Pipeline: <run-url>
```
