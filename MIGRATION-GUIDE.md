# Cloudflare Workers Migration Guide

This guide documents the migration of support.tools from Kubernetes to Cloudflare Workers.

## Overview

The migration moves from a containerized Go server running on Kubernetes to a serverless approach using Cloudflare Workers for static asset hosting.

## Prerequisites

1. **Cloudflare Account**: Pro plan or higher for custom domains
2. **Domain Configuration**: Nameservers must be managed by Cloudflare
3. **API Token**: Create a Cloudflare API token with Workers:Edit permissions
4. **Node.js**: For running Wrangler CLI

## Setup Instructions

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

Or set the API token:
```bash
export CLOUDFLARE_API_TOKEN=your_token_here
```

### 3. Configure GitHub Secrets

Add the following secret to your GitHub repository:
- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token

### 4. Domain Configuration

Ensure your domains are configured in Cloudflare with the following routes:
- `support.tools/*` → Production environment
- `stg.support.tools/*` → Staging environment  
- `dev.support.tools/*` → Development environment

## Deployment Commands

### Local Development
```bash
# Build Hugo site and serve locally
make dev

# Build Hugo static files
make build-hugo
```

### Manual Deployment
```bash
# Deploy to production
make deploy-production

# Deploy to staging
make deploy-staging

# Deploy to development
make deploy-dev
```

### GitHub Actions Deployment

The new workflow `.github/workflows/cloudflare-workers.yml` automatically:
1. Tests Hugo build
2. Checks for expired content
3. Builds static site
4. Deploys to Cloudflare Workers
5. Verifies deployment

Trigger deployments:
- **Automatic**: Push to `main` branch deploys to production
- **Manual**: Use GitHub Actions workflow dispatch to choose environment
- **Scheduled**: Daily builds at midnight UTC

## File Structure

```
.
├── src/
│   └── worker.js              # Cloudflare Worker script
├── wrangler.toml              # Wrangler configuration
├── blog/public/               # Hugo static output (auto-generated)
├── .github/workflows/
│   ├── pipeline.yml           # Original Kubernetes workflow
│   └── cloudflare-workers.yml # New Workers workflow
└── makefile                   # Updated with Workers commands
```

## Configuration Details

### wrangler.toml
- Defines environments (development, staging, production)
- Maps routes to custom domains
- Configures static assets binding

### worker.js
- Minimal Worker script for static asset serving
- Provides health endpoints (`/healthz`, `/version`)
- Handles error cases gracefully

## Migration Benefits

✅ **Cost Reduction**: Free static asset serving  
✅ **Global Performance**: Cloudflare's edge network  
✅ **Simplified Operations**: No servers to manage  
✅ **Automatic Scaling**: Handles traffic spikes seamlessly  
✅ **Built-in CDN**: No separate CDN configuration needed  

## Migration Considerations

❌ **Monitoring**: No native Prometheus metrics (use Cloudflare Analytics)  
❌ **Custom Logic**: Limited server-side processing capabilities  
❌ **Domain Requirements**: Must use Cloudflare nameservers  

## Rollback Plan

The original Kubernetes deployment remains intact. To rollback:

1. Switch DNS back to Kubernetes load balancer
2. Resume using the original pipeline.yml workflow
3. The Docker images and Helm charts are still maintained

## Health Checks

Workers provides these endpoints:
- `/healthz` - Returns "OK" status
- `/version` - Returns version information

## Monitoring & Analytics

Use Cloudflare Dashboard for:
- Request analytics
- Performance metrics  
- Error rates
- Geographic distribution

For Prometheus integration, deploy a [Cloudflare Exporter](https://github.com/lablabs/cloudflare-exporter).

## Troubleshooting

### Common Issues

1. **Domain not working**: Verify nameservers point to Cloudflare
2. **Deployment fails**: Check API token permissions
3. **Asset not found**: Ensure Hugo build completed successfully
4. **Worker errors**: Check Wrangler logs with `wrangler tail`

### Debug Commands

```bash
# View worker logs
wrangler tail --env production

# Test deployment locally  
wrangler dev

# Check deployment status
wrangler deployments list
```

## Performance Comparison

| Metric | Kubernetes | Cloudflare Workers |
|--------|------------|-------------------|
| Global Latency | Variable | ~50ms worldwide |
| Cold Start | N/A | <10ms |
| Scaling | Manual HPA | Automatic |
| Cost | $XXX/month | Free for static |
| Maintenance | High | Minimal |

## Next Steps

1. Monitor initial deployment performance
2. Update DNS to point to Workers
3. Verify all functionality works as expected
4. Consider deprecating Kubernetes infrastructure after successful migration
5. Update documentation and monitoring dashboards