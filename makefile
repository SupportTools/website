.PHONY: help dev build-hugo deploy-workers deploy-production install-wrangler

help:
	@echo "Makefile commands:"
	@echo "dev               - Run local development server"
	@echo "build-hugo        - Build Hugo static site"
	@echo "deploy-workers    - Deploy to Cloudflare Workers (production, the only environment)"
	@echo "deploy-production - Build Hugo, then deploy to production"

.DEFAULT_GOAL := help

dev:
	@echo "Starting local development server..."
	@cd blog && hugo server -D --bind=0.0.0.0 --baseURL=http://localhost:1313

# Cloudflare Workers commands
build-hugo:
	@echo "Building Hugo static site..."
	@cd blog && hugo --minify --gc --cleanDestinationDir --baseURL https://support.tools

# Production is the only Worker environment (v2 design, Phase 0); the dev, mst, qas, tst
# and staging targets were removed along with their wrangler.toml envs.
deploy-workers:
	@if [ -n "$(env)" ] && [ "$(env)" != "production" ]; then echo "env=$(env) no longer exists; production is the only Worker environment" >&2; exit 1; fi
	@echo "Deploying to Cloudflare Workers (production)..."
	@npx wrangler deploy --env production

deploy-production:
	@make build-hugo
	@make deploy-workers

# Install wrangler if not present
install-wrangler:
	@which wrangler > /dev/null || npm install -g wrangler

