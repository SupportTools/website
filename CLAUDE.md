# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This repository contains the codebase for Support Tools website (support.tools):

1. A Hugo-based blog (m10c theme) under `blog/`
2. A Cloudflare Worker (`src/worker.js`, `wrangler.toml`) that serves the built static files
3. Node scripts and tests for content checks, share cards, social drafts and IndexNow (`scripts/`, `tests/`)
4. The `blog-metrics` Prometheus exporter, its own Go module under `exporters/blog-metrics/`

The old Go web server, its Docker image, Helm chart, Argo CD apps and `deploy.sh` were retired in
Phase 0 of the v2 publishing design. Production is the only environment.

## Project Architecture

### Hugo Blog Component
- Uses the m10c theme
- Content is organized into multiple sections:
  - Blog posts
  - Training materials
  - Known good designs
  - About/certificates/publications

### Deployment Architecture
- `.github/workflows/cloudflare-workers.yml` builds Hugo and runs the check scripts on every PR
  and push, and deploys `--env production` with Wrangler on pushes to main and on the daily
  schedule. PRs never deploy.
- workers.dev and Preview URLs are disabled in `wrangler.toml`.

## Development Workflow

### Local Development

To run the Hugo development server locally:

```bash
make dev
```

This starts a Hugo server at http://localhost:1313 with live reloading.

### Deployment

Merging to main deploys. To deploy by hand (production is the only environment):

```bash
make deploy-production
```

## Adding New Blog Content

New blog posts should be added to the `blog/content/post/` directory using the Markdown format with appropriate frontmatter.

## Blog Writing Guidelines

When creating blog content:

1. Follow the template in `blog/_template.md` exactly, including frontmatter structure
2. Use appropriate tags and categories based on content topics
3. Create relevant SEO-friendly titles, descriptions, and keywords
4. Maintain a highly technical writing style that demonstrates expertise
5. Use future dates for posts, with more recent dates for version updates or news
6. Place featured images at the top of posts when applicable
7. Ensure URLs match the content topic and are SEO-friendly
8. Include code examples, command snippets, and technical details where relevant
9. Structure content with clear sections and hierarchical headings
10. Do not use em dashes (—) or en dashes (–) in prose. Rewrite with commas, colons, periods, or parentheses instead. This applies to post body and frontmatter (titles, descriptions); command-line flags such as `--limit` are unaffected.