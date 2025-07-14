#Dockerfile vars
TAG=0.0.0

#vars
IMAGENAME=website
REPO=docker.io/supporttools
IMAGEFULLNAME=${REPO}/${IMAGENAME}:${TAG}

.PHONY: help build push all dev build-hugo deploy-workers deploy-dev deploy-mst deploy-qas deploy-tst deploy-staging deploy-production deploy-all-workers

help:
	    @echo "Makefile arguments:"
	    @echo ""
	    @echo "tag - Docker Tag"
	    @echo "env - Environment (dev/staging/production)"
	    @echo ""
	    @echo "Makefile commands:"
	    @echo "build       - Build the Docker image"
	    @echo "push        - Push the Docker image to repository"
		@echo "bump        - Build and push the Docker image"
	    @echo "all         - Build and push the Docker image"
		@echo "dev         - Run local development server"
		@echo "build-hugo  - Build Hugo static site"
		@echo "deploy-workers - Deploy to Cloudflare Workers"
		@echo "deploy-dev  - Deploy to development environment"
		@echo "deploy-staging - Deploy to staging environment"
		@echo "deploy-production - Deploy to production environment"

.DEFAULT_GOAL := all

build:
	    @docker build --platform linux/amd64 --pull --build-arg GIT_COMMIT=`git rev-parse HEAD` --build-arg VERSION=${TAG} --build-arg BUILD_DATE=`date -u +"%Y-%m-%dT%H:%M:%SZ"` -t ${IMAGEFULLNAME} .

push:
	    @docker push ${IMAGEFULLNAME}
		@docker tag ${IMAGEFULLNAME} ${REPO}/${IMAGENAME}:latest
		@docker push ${REPO}/${IMAGENAME}:latest

bump:
		@make build push

dev:
	@echo "Starting local development server..."
	@cd blog && hugo server -D --bind=0.0.0.0 --baseURL=http://localhost:1313

# Cloudflare Workers commands
build-hugo:
	@echo "Building Hugo static site..."
	@cd blog && hugo --minify --gc --cleanDestinationDir --baseURL https://support.tools

deploy-workers:
	@echo "Deploying to Cloudflare Workers..."
	@npx wrangler deploy --env $(or $(env),production)

deploy-dev:
	@make build-hugo
	@make deploy-workers env=development

deploy-mst:
	@make build-hugo
	@make deploy-workers env=mst

deploy-qas:
	@make build-hugo
	@make deploy-workers env=qas

deploy-tst:
	@make build-hugo
	@make deploy-workers env=tst

deploy-staging:
	@make build-hugo
	@make deploy-workers env=staging

deploy-production:
	@make build-hugo
	@make deploy-workers env=production

deploy-all-workers:
	@echo "Deploying to all Cloudflare Workers environments..."
	@make deploy-dev
	@make deploy-mst
	@make deploy-qas
	@make deploy-tst
	@make deploy-staging
	@echo "WARNING: Skipping production deployment. Run 'make deploy-production' separately."

# Install wrangler if not present
install-wrangler:
	@which wrangler > /dev/null || npm install -g wrangler

all: build push
