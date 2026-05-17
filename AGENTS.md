# AGENTS.md — support.tools website

## Deployment

Single deployment path: **Cloudflare Workers** via `cloudflare-workers.yml`.

| Pipeline | Trigger | Target | Config |
|---|---|---|---|
| `cloudflare-workers.yml` | push to main, PR, daily 06:00 UTC | Cloudflare Workers (Wrangler) | `wrangler.toml`, `src/worker.js` |

**Retired:** `pipeline.yml` (Docker → K8s via ArgoCD) — disabled. `charts/`, `argocd/`, `Dockerfile`, `deploy.sh` are legacy artifacts.

## Environments

Cloudflare Workers: `development`, `mst`, `qas`, `tst`, `staging`, `production` (wrangler `--env` flag)

## Developer commands

```bash
make dev              # Hugo dev server at http://localhost:1313 (runs from blog/ subdir)
make deploy-workers env=production  # Cloudflare Workers deploy
make deploy-all-workers             # Deploy all CF envs except production
```

**Gotcha:** `makefile` is lowercase. `Makefile` does not exist.

## Hugo content

- All blog content lives under `blog/content/`
- Template: `blog/_template.md` — follow frontmatter structure exactly
- Check for drafts: `grep -R 'draft: true' blog/content/post`
- Check expired content: `cd blog && hugo list expired`
- Hugo config: `blog/config.toml` (theme: m10c, pagination: 8)
- Theme fix: `blog/themes/m10c/layouts/partials/icon.html` uses `hugo.Data` (not deprecated `.Site.Data`)

## Go webserver

- Entry point: `main.go` — serves Hugo static files with gzip + Prometheus metrics
- Two modes: filesystem serving (default) or in-memory (`USE_MEMORY=true`)
- Ports: HTTP `8080` (default), metrics `9090`
- Config via env vars only: `DEBUG`, `PORT`, `METRICS_PORT`, `WEBROOT`, `USE_MEMORY`, `LOG_FILE_PATH`
- No Go tests exist in this repo
- Go 1.22.2, minimal deps (prometheus client, logrus)

## CI specifics

- Runs on **GitHub-hosted** runners (`ubuntu-latest`), not self-hosted
- Daily scheduled builds catch Hugo `expiryDate` content rotation
- Test step uses `--panicOnWarning` — deprecation warnings fail the build
