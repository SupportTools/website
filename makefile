#Dockerfile vars
TAG=0.0.0

#vars
IMAGENAME=website
REPO=docker.io/supporttools
IMAGEFULLNAME=${REPO}/${IMAGENAME}:${TAG}

.PHONY: help build push all dev

help:
	    @echo "Makefile arguments:"
	    @echo ""
	    @echo "tag - Docker Tag"
	    @echo ""
	    @echo "Makefile commands:"
	    @echo "build - Build the Docker image"
	    @echo "push  - Push the Docker image to repository"
		@echo "bump  - Build and push the Docker image"
	    @echo "all   - Build and push the Docker image"
		@echo "dev   - Run local development server"

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

all: build push
