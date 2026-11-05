# GitHub Actions Workflows

This directory contains automated workflows for the Support Tools website.

## Workflows

### 1. cloudflare-workers.yml - Cloudflare Workers Deployment

**Purpose**: Deploy the Hugo static site to Cloudflare Workers

**Triggers**:
- **Push to main**: Tests, then deploys to production
- **Push to `bot/**`** (INTERIM, TaskForge supporttools-website-990): Test only, so a
  bot PR opened by `bot-pr.yml` gets its check; the deploy job requires `refs/heads/main`
- **Pull Request**: Builds and runs the check gates only; never deploys
- **Manual dispatch**: Runs the Test job only (the production deploy does not match dispatch)
- **Schedule**: 06:00, 14:10 and 15:10 UTC daily (picks up scheduled posts), then deploys production

**Deployment Flow**:

```mermaid
graph TD
    A[Trigger] --> B[Test/Build Hugo]
    B --> C{Event?}
    C -->|PR or manual| D[Stop: no deploy]
    C -->|push to main or schedule| F[Deploy to Production]
```

**Environments**:
- `production` - https://support.tools (the only one)

The staging, development, mst, qas and tst Workers were retired in Phase 0 of the v2
publishing platform design. `wrangler.toml` sets `workers_dev = false` and
`preview_urls = false`, so no workers.dev or Version URL serves the site either. Previews
move in-cluster on internal DNS in a later phase.

The legacy `pipeline.yml` (Docker image to Kubernetes via Argo CD) was removed along with the
old Go web server.

### 2. bot-pr.yml - Open PRs for in-cluster job branches (INTERIM)

While the publisher jobs push with a deploy key (TaskForge supporttools-website-990
replaces this with a GitHub App), a push to `bot/**` runs this workflow, which opens
a PR to main titled with the head commit subject if none is open for the branch. It
uses `GITHUB_TOKEN` with `contents: read` and `pull-requests: write`, never merges
and never enables auto-merge. It needs "Allow GitHub Actions to create and approve
pull requests" enabled in the repository settings. See `scripts/jobs/README.md`.

## Secrets

None. The production deploy logs in to Vault with GitHub OIDC (role `gha-website-cf-deploy`,
which only accepts main-branch runs of `cloudflare-workers.yml`) and reads an account-owned
Cloudflare token scoped to the `support-tools` Worker and the `support.tools` routes. The job
needs `id-token: write`; no Cloudflare credential is stored in GitHub.

## Usage Examples

### Manual Deployment

1. Go to Actions tab
2. Select "Deploy to Cloudflare Workers"
3. Click "Run workflow"
4. Click "Run workflow" (this runs the Test job; production deploys from `main` and the schedule)

### Automatic Deployments

- **Production**: Push to `main` branch, or a scheduled run
- **Pull requests**: Test only, no deploy

## Monitoring Deployments

### View Logs
```bash
# Real-time logs
wrangler tail --env production

# GitHub Actions logs
gh run list --workflow=cloudflare-workers.yml
gh run view <run-id>
```

### Check Status
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://support.tools
```

## Rollback Procedure

1. **Via GitHub**:
   ```bash
   # List recent deployments
   gh run list --workflow=cloudflare-workers.yml --limit 10
   
   # Re-run a previous successful deployment
   gh run rerun <run-id>
   ```

2. **Via Wrangler**:
   ```bash
   # List versions
   wrangler deployments list
   
   # Rollback to previous version
   wrangler rollback --env production
   ```

## Troubleshooting

### Deployment Fails

1. Check GitHub Actions logs
2. Check the "Deploy to Cloudflare Workers" step: a Vault login error means the run was not a main-branch run of this workflow; "token is not active" means the Cloudflare token in `secret/cloudflare/workers-deploy-support-tools` expired or was revoked
3. Check Hugo build output
4. Verify DNS is pointing to Cloudflare

### Site Not Updating

1. Clear Cloudflare cache
2. Check if deployment completed
3. Verify correct environment deployed
4. Check Workers logs: `wrangler tail`

### Performance Issues

1. Check Workers analytics in Cloudflare Dashboard
2. Monitor request duration in logs
3. Verify static assets are cached
4. Check for large unoptimized images

## Migration from Kubernetes

The site has been migrated from Kubernetes to Cloudflare Workers:

- **Old**: Docker → Kubernetes → ArgoCD → Nginx
- **New**: Hugo → Cloudflare Workers → Global CDN

Benefits:
- ✅ Free hosting for static assets
- ✅ Global edge deployment
- ✅ No infrastructure to manage
- ✅ Faster deployment times
- ✅ Better performance