# AGENTS.md — support.tools website

## Deployment

Single deployment path: **Cloudflare Workers** via `cloudflare-workers.yml`.

| Pipeline | Trigger | Target | Config |
|---|---|---|---|
| `cloudflare-workers.yml` | push to main, PR, daily 06:00 UTC | Cloudflare Workers (Wrangler) | `wrangler.toml`, `src/worker.js` |

**Retired:** the old Go web server and its Docker → K8s via Argo CD path (`pipeline.yml`, `charts/`, `argocd/`, `Dockerfile`, `deploy.sh`) were removed from the repo, and their Argo CD apps were deleted.

## Environments

Cloudflare Workers: `production` only (wrangler `--env production`). The development, mst, qas, tst and staging envs were removed in Phase 0 of the v2 design; PRs build and test but never deploy.

## Developer commands

```bash
make dev              # Hugo dev server at http://localhost:1313 (runs from blog/ subdir)
make deploy-workers                 # Cloudflare Workers deploy (production, the only env)
make deploy-production              # Build Hugo, then deploy production
```

**Gotcha:** `makefile` is lowercase. `Makefile` does not exist.

## Hugo content

- All blog content lives under `blog/content/`
- Template: `blog/_template.md` — follow frontmatter structure exactly
- Check for drafts: `grep -R 'draft: true' blog/content/post`
- Check expired content: `cd blog && hugo list expired`
- Hugo config: `blog/config.toml` (theme: m10c, pagination: 8)
- Theme fix: `blog/themes/m10c/layouts/partials/icon.html` uses `hugo.Data` (not deprecated `.Site.Data`)

## Go code

- The only Go code is the `blog-metrics` exporter, its own module under `exporters/blog-metrics/`.

## CI specifics

- Runs on **GitHub-hosted** runners (`ubuntu-latest`), not self-hosted
- Daily scheduled builds catch Hugo `expiryDate` content rotation
- Test step uses `--panicOnWarning` — deprecation warnings fail the build
- The m10c theme compiles SCSS with **Dart Sass** (`css.Sass` `transpiler: dartsass`), not libsass. Local builds need the `sass` binary on PATH (Hugo errors with "You need to install Dart Sass" otherwise); CI installs a pinned, sha256-checked release via `DART_SASS_VERSION`/`DART_SASS_SHA256` in `cloudflare-workers.yml`
- Theme colors reach SCSS through `css.Sass` `vars` (`@use "hugo:vars"`), set in `blog/themes/m10c/layouts/_default/baseof.html`; do not reintroduce `@import` (Dart Sass deprecation = `--panicOnWarning` failure)
