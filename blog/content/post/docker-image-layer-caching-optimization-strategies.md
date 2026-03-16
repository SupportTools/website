---
title: "Docker Image Layer Caching: Optimization Strategies for Faster Builds"
date: 2026-06-14T00:00:00-05:00
draft: false
tags: ["Docker", "Containers", "CI/CD", "Performance", "Build Optimization", "DevOps", "Container Registry"]
categories: ["Containers", "Performance", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Docker image layer caching strategies, including multi-stage builds, BuildKit optimization, cache mount strategies, and production CI/CD integration for maximum build performance."
more_link: "yes"
url: "/docker-image-layer-caching-optimization-strategies/"
---

Master Docker image layer caching for dramatically faster build times with this comprehensive guide covering layer optimization, multi-stage builds, BuildKit features, cache mount strategies, and CI/CD integration techniques for production environments.

<!--more-->

# Docker Image Layer Caching: Optimization Strategies for Faster Builds

## Executive Summary

Docker image layer caching is critical for efficient CI/CD pipelines and developer productivity. Understanding how Docker's layer caching works and implementing optimization strategies can reduce build times from minutes to seconds. This guide provides production-tested techniques for maximizing cache efficiency, including multi-stage builds, BuildKit features, and advanced caching strategies for enterprise environments.

## Understanding Docker Layer Caching

### How Layer Caching Works

Docker builds images in layers, with each instruction in a Dockerfile creating a new layer:

```dockerfile
# Dockerfile demonstrating layer creation

# Layer 1: Base image
FROM ubuntu:22.04

# Layer 2: Update package lists
RUN apt-get update

# Layer 3: Install packages
RUN apt-get install -y python3 python3-pip

# Layer 4: Set working directory (metadata layer)
WORKDIR /app

# Layer 5: Copy requirements
COPY requirements.txt .

# Layer 6: Install Python dependencies
RUN pip3 install -r requirements.txt

# Layer 7: Copy application code
COPY . .

# Layer 8: Set CMD (metadata layer)
CMD ["python3", "app.py"]
```

### Cache Invalidation Rules

```bash
#!/bin/bash
# Demonstrate cache invalidation behavior

cat << 'EOF' > /usr/local/bin/docker-cache-demo.sh
#!/bin/bash

set -e

echo "=== Docker Layer Caching Demonstration ==="
echo

# Create test directory
mkdir -p /tmp/docker-cache-demo
cd /tmp/docker-cache-demo

# Example 1: Cache hit on all layers
echo "Example 1: Building with no changes (full cache hit)"
cat > Dockerfile.v1 << 'DOCKERFILE'
FROM alpine:3.19
RUN echo "Step 1" && sleep 2
RUN echo "Step 2" && sleep 2
RUN echo "Step 3" && sleep 2
DOCKERFILE

time docker build -t cache-demo:v1 -f Dockerfile.v1 .
echo "First build completed"

# Build again - should use cache
echo
echo "Building again (should use cache):"
time docker build -t cache-demo:v1 -f Dockerfile.v1 .

# Example 2: Cache invalidation from middle
echo
echo "Example 2: Modifying middle layer (invalidates subsequent layers)"
cat > Dockerfile.v2 << 'DOCKERFILE'
FROM alpine:3.19
RUN echo "Step 1" && sleep 2
RUN echo "Step 2 MODIFIED" && sleep 2  # Changed
RUN echo "Step 3" && sleep 2
DOCKERFILE

time docker build -t cache-demo:v2 -f Dockerfile.v2 .

# Example 3: Optimal layer ordering
echo
echo "Example 3: Optimal layer ordering"
cat > Dockerfile.v3 << 'DOCKERFILE'
FROM alpine:3.19

# Infrequently changing layers first
RUN apk add --no-cache python3 py3-pip

# Copy dependency file
COPY requirements.txt /app/

# Install dependencies (cached unless requirements.txt changes)
RUN pip3 install -r /app/requirements.txt

# Copy source code (changes frequently)
COPY src/ /app/src/

CMD ["python3", "/app/src/main.py"]
DOCKERFILE

echo "requirements.txt" > requirements.txt
echo "flask==2.3.0" >> requirements.txt
mkdir -p src
echo "print('Hello')" > src/main.py

time docker build -t cache-demo:v3 -f Dockerfile.v3 .

# Modify only source code
echo "print('Hello Modified')" > src/main.py

echo
echo "Rebuilding after source change (dependencies cached):"
time docker build -t cache-demo:v3 -f Dockerfile.v3 .

# Cleanup
cd /
rm -rf /tmp/docker-cache-demo

echo
echo "=== Cache Behavior Summary ==="
echo "1. Cache is used until a layer changes"
echo "2. Once invalidated, all subsequent layers rebuild"
echo "3. Order matters: place frequently changing layers last"
EOF

chmod +x /usr/local/bin/docker-cache-demo.sh
```

### Layer Inspection Tools

```bash
#!/bin/bash
# Tools for inspecting Docker image layers

cat << 'EOF' > /usr/local/bin/docker-layer-analyzer.sh
#!/bin/bash

set -e

# Analyze image layers
analyze_image() {
    local image=$1

    echo "=== Image Layer Analysis: $image ==="
    echo

    # Show layer history
    echo "Layer History:"
    docker history "$image" --no-trunc

    echo
    echo "=== Layer Size Analysis ==="
    docker history "$image" --format "table {{.Size}}\t{{.CreatedBy}}" | \
        head -20

    echo
    echo "=== Total Image Size ==="
    docker images "$image" --format "{{.Repository}}:{{.Tag}}\t{{.Size}}"

    # Detailed layer information
    echo
    echo "=== Detailed Layer Information ==="
    docker inspect "$image" | jq -r '
        .[0].RootFS.Layers[] as $layer |
        "\($layer)"
    ' | nl

    # Layer count
    LAYER_COUNT=$(docker inspect "$image" | jq -r '.[0].RootFS.Layers | length')
    echo
    echo "Total Layers: $LAYER_COUNT"
}

# Compare two images
compare_images() {
    local image1=$1
    local image2=$2

    echo "=== Comparing Images ==="
    echo "Image 1: $image1"
    echo "Image 2: $image2"
    echo

    # Get layers for both images
    LAYERS1=$(docker inspect "$image1" | jq -r '.[0].RootFS.Layers[]' | sort)
    LAYERS2=$(docker inspect "$image2" | jq -r '.[0].RootFS.Layers[]' | sort)

    # Find common layers
    COMMON=$(comm -12 <(echo "$LAYERS1") <(echo "$LAYERS2") | wc -l)
    TOTAL1=$(echo "$LAYERS1" | wc -l)
    TOTAL2=$(echo "$LAYERS2" | wc -l)

    echo "Image 1 layers: $TOTAL1"
    echo "Image 2 layers: $TOTAL2"
    echo "Common layers: $COMMON"
    echo "Cache hit ratio: $(echo "scale=2; $COMMON * 100 / $TOTAL1" | bc)%"
}

# Show layer sizes sorted
show_largest_layers() {
    local image=$1
    local count=${2:-10}

    echo "=== Top $count Largest Layers in $image ==="
    echo

    docker history "$image" --no-trunc --format "{{.Size}}\t{{.CreatedBy}}" | \
        grep -v "0B" | \
        sort -h -r | \
        head -n "$count"
}

# Calculate cache potential
calculate_cache_potential() {
    local image=$1

    echo "=== Cache Optimization Potential for $image ==="
    echo

    # Analyze COPY/ADD instructions
    echo "COPY/ADD Operations:"
    docker history "$image" --no-trunc | grep -E "COPY|ADD" | \
        awk '{print $1, $NF}'

    echo
    echo "RUN Instructions:"
    docker history "$image" --no-trunc | grep "RUN" | \
        awk '{print $1, $NF}' | head -10

    echo
    echo "Optimization Suggestions:"
    echo "1. Combine multiple RUN commands to reduce layers"
    echo "2. Place COPY instructions for frequently changing files last"
    echo "3. Use .dockerignore to exclude unnecessary files"
    echo "4. Consider multi-stage builds to reduce final image size"
}

# Main execution
case "${1:-help}" in
    analyze)
        if [ -z "$2" ]; then
            echo "Usage: $0 analyze <image>"
            exit 1
        fi
        analyze_image "$2"
        ;;
    compare)
        if [ -z "$3" ]; then
            echo "Usage: $0 compare <image1> <image2>"
            exit 1
        fi
        compare_images "$2" "$3"
        ;;
    largest)
        if [ -z "$2" ]; then
            echo "Usage: $0 largest <image> [count]"
            exit 1
        fi
        show_largest_layers "$2" "${3:-10}"
        ;;
    potential)
        if [ -z "$2" ]; then
            echo "Usage: $0 potential <image>"
            exit 1
        fi
        calculate_cache_potential "$2"
        ;;
    *)
        echo "Usage: $0 {analyze|compare|largest|potential} [args]"
        echo
        echo "Commands:"
        echo "  analyze <image>              - Analyze image layers"
        echo "  compare <img1> <img2>        - Compare two images"
        echo "  largest <image> [count]      - Show largest layers"
        echo "  potential <image>            - Calculate optimization potential"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/docker-layer-analyzer.sh
```

## Optimization Strategies

### Optimal Dockerfile Structure

```dockerfile
# Dockerfile.optimized
# Example of optimized Dockerfile with proper layer ordering

# Use specific version tags (not 'latest')
FROM node:20.11-alpine3.19 AS base

# Install system dependencies (rarely changes)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/cache/apk/*

# Set working directory
WORKDIR /app

# ============================================
# Dependencies stage
# ============================================
FROM base AS dependencies

# Copy package files first (changes less frequently than source code)
COPY package.json package-lock.json ./

# Install dependencies with frozen lockfile
RUN npm ci --only=production --ignore-scripts

# Separate dev dependencies (for build stage)
RUN npm ci --only=development --ignore-scripts && \
    cp -R node_modules /tmp/dev_node_modules

# ============================================
# Build stage
# ============================================
FROM base AS build

# Copy dev dependencies
COPY --from=dependencies /tmp/dev_node_modules ./node_modules

# Copy package files
COPY package.json package-lock.json ./

# Copy source code (changes frequently)
COPY src/ ./src/
COPY tsconfig.json ./

# Build application
RUN npm run build

# ============================================
# Production stage
# ============================================
FROM base AS production

# Copy production dependencies
COPY --from=dependencies /app/node_modules ./node_modules

# Copy built application
COPY --from=build /app/dist ./dist

# Copy package.json for metadata
COPY package.json ./

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "dist/main.js"]
```

### Multi-Stage Build Patterns

```dockerfile
# Dockerfile.multistage-patterns
# Advanced multi-stage build patterns

# ============================================
# Pattern 1: Build Once, Use Many
# ============================================
FROM golang:1.21-alpine AS builder

WORKDIR /build

# Cache Go modules
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build multiple binaries
RUN CGO_ENABLED=0 GOOS=linux go build -o api ./cmd/api
RUN CGO_ENABLED=0 GOOS=linux go build -o worker ./cmd/worker
RUN CGO_ENABLED=0 GOOS=linux go build -o migrator ./cmd/migrator

# ============================================
# Pattern 2: Separate Runtime Images
# ============================================

# API Server
FROM alpine:3.19 AS api
RUN apk add --no-cache ca-certificates
COPY --from=builder /build/api /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/api"]

# Worker
FROM alpine:3.19 AS worker
RUN apk add --no-cache ca-certificates
COPY --from=builder /build/worker /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/worker"]

# Migrator
FROM alpine:3.19 AS migrator
RUN apk add --no-cache ca-certificates postgresql-client
COPY --from=builder /build/migrator /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/migrator"]

# ============================================
# Pattern 3: Dependency Caching with Multiple Languages
# ============================================
FROM node:20-alpine AS frontend-deps
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci

FROM node:20-alpine AS frontend-build
WORKDIR /frontend
COPY --from=frontend-deps /frontend/node_modules ./node_modules
COPY frontend/ ./
RUN npm run build

FROM python:3.11-alpine AS backend-deps
WORKDIR /backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.11-alpine AS backend
WORKDIR /backend
COPY --from=backend-deps /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=frontend-build /frontend/dist ./static
COPY backend/ ./
CMD ["python", "app.py"]

# ============================================
# Pattern 4: Testing Stage
# ============================================
FROM golang:1.21-alpine AS test-base
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

FROM test-base AS unit-test
RUN go test -v ./...

FROM test-base AS integration-test
RUN go test -v -tags=integration ./...

FROM test-base AS lint
RUN go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
RUN golangci-lint run

# ============================================
# Pattern 5: Conditional Stages
# ============================================
FROM alpine:3.19 AS runtime-base
RUN apk add --no-cache ca-certificates

# Development image
FROM runtime-base AS development
RUN apk add --no-cache \
    bash \
    vim \
    curl \
    postgresql-client
COPY --from=builder /build/api /usr/local/bin/
ENV DEBUG=true
CMD ["/usr/local/bin/api"]

# Production image
FROM runtime-base AS production
COPY --from=builder /build/api /usr/local/bin/
USER nobody
CMD ["/usr/local/bin/api"]
```

## BuildKit Advanced Features

### Cache Mounts

```dockerfile
# Dockerfile.buildkit-cache
# Using BuildKit cache mounts for maximum efficiency

# syntax=docker/dockerfile:1.4

FROM python:3.11-slim AS base

# ============================================
# Using cache mount for package manager
# ============================================
FROM base AS python-deps

WORKDIR /app

# Mount pip cache
RUN --mount=type=cache,target=/root/.cache/pip \
    --mount=type=bind,source=requirements.txt,target=requirements.txt \
    pip install -r requirements.txt

# ============================================
# Using cache mount for apt
# ============================================
FROM base AS system-deps

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# ============================================
# Node.js with npm cache mount
# ============================================
FROM node:20-alpine AS node-deps

WORKDIR /app

# Mount npm cache
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    npm ci --prefer-offline

# ============================================
# Go with module cache mount
# ============================================
FROM golang:1.21-alpine AS go-deps

WORKDIR /app

# Mount Go module cache
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=bind,source=go.mod,target=go.mod \
    --mount=type=bind,source=go.sum,target=go.sum \
    go mod download

# ============================================
# Rust with cargo cache mount
# ============================================
FROM rust:1.75-alpine AS rust-deps

WORKDIR /app

# Mount cargo cache
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=bind,source=Cargo.toml,target=Cargo.toml \
    --mount=type=bind,source=Cargo.lock,target=Cargo.lock \
    cargo fetch

# ============================================
# Maven with local repository cache
# ============================================
FROM maven:3.9-eclipse-temurin-21 AS maven-deps

WORKDIR /app

# Mount Maven local repository
RUN --mount=type=cache,target=/root/.m2/repository \
    --mount=type=bind,source=pom.xml,target=pom.xml \
    mvn dependency:go-offline

# ============================================
# Build stage using cached dependencies
# ============================================
FROM golang:1.21-alpine AS build

WORKDIR /app

# Use cached modules
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=bind,source=.,target=. \
    go build -o /app/server ./cmd/server

# ============================================
# Final stage
# ============================================
FROM alpine:3.19

COPY --from=build /app/server /usr/local/bin/

CMD ["/usr/local/bin/server"]
```

### Secret Mounts

```dockerfile
# Dockerfile.secrets
# Secure handling of secrets during build

# syntax=docker/dockerfile:1.4

FROM node:20-alpine AS base

WORKDIR /app

# ============================================
# Using secret mounts (secrets never cached)
# ============================================

# Mount NPM token for private registry
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm install private-package

# Mount SSH key for git clone
RUN --mount=type=ssh \
    --mount=type=secret,id=known_hosts,target=/root/.ssh/known_hosts \
    git clone git@github.com:private/repo.git

# Mount multiple secrets
RUN --mount=type=secret,id=aws_access_key \
    --mount=type=secret,id=aws_secret_key \
    --mount=type=cache,target=/root/.cache/pip \
    pip install \
        --extra-index-url https://pypi.example.com \
        private-package

# ============================================
# Build with secret environment variables
# ============================================
RUN --mount=type=secret,id=api_key,env=API_KEY \
    curl -H "Authorization: Bearer ${API_KEY}" \
        https://api.example.com/data > data.json

# ============================================
# Using secret files
# ============================================
FROM python:3.11-slim AS python-build

WORKDIR /app

# Read secret from file
RUN --mount=type=secret,id=service_account,target=/run/secrets/service_account.json \
    python setup.py build --service-account=/run/secrets/service_account.json

# Build command with secrets:
# docker build --secret id=npmrc,src=$HOME/.npmrc \
#              --secret id=api_key,env=API_KEY \
#              --ssh default \
#              -t myimage .
```

### Build Context Optimization

```dockerfile
# Dockerfile.context-optimization
# Optimizing build context for faster uploads

# syntax=docker/dockerfile:1.4

FROM node:20-alpine

WORKDIR /app

# ============================================
# Using bind mounts to avoid COPY overhead
# ============================================

# Build without copying large files into image
RUN --mount=type=bind,source=.,target=/build,rw \
    cd /build && \
    npm install && \
    npm run build && \
    cp -r dist /app/

# ============================================
# Selective file copying
# ============================================

# Only copy specific files
COPY package.json package-lock.json ./

# Install dependencies first (cached layer)
RUN npm ci

# Copy only necessary files
COPY src/ ./src/
COPY public/ ./public/
COPY tsconfig.json ./

# Build
RUN npm run build

# ============================================
# Using .dockerignore effectively
# ============================================

# .dockerignore file content:
# node_modules
# dist
# .git
# .env*
# *.log
# coverage
# .vscode
# .idea
# *.md
# Dockerfile*
# .dockerignore
# tests
# docs
```

## CI/CD Integration

### GitLab CI Cache Strategy

```yaml
# .gitlab-ci.yml
# Optimized Docker build with caching

variables:
  DOCKER_DRIVER: overlay2
  DOCKER_TLS_CERTDIR: "/certs"
  DOCKER_BUILDKIT: 1
  BUILDKIT_PROGRESS: plain

  # Cache registry
  CACHE_REGISTRY: $CI_REGISTRY_IMAGE/cache

stages:
  - build
  - test
  - deploy

# Build stage with layer caching
build:
  stage: build
  image: docker:24-git
  services:
    - docker:24-dind
  before_script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  script:
    # Pull previous image for layer cache
    - docker pull $CI_REGISTRY_IMAGE:latest || true
    - docker pull $CACHE_REGISTRY:buildcache || true

    # Build with cache from previous image
    - |
      docker build \
        --cache-from $CI_REGISTRY_IMAGE:latest \
        --cache-from $CACHE_REGISTRY:buildcache \
        --build-arg BUILDKIT_INLINE_CACHE=1 \
        --tag $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA \
        --tag $CI_REGISTRY_IMAGE:latest \
        --file Dockerfile \
        .

    # Push images
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA
    - docker push $CI_REGISTRY_IMAGE:latest

  # Cache Docker layers between jobs
  cache:
    key: docker-layer-cache-$CI_COMMIT_REF_SLUG
    paths:
      - .docker-cache/

  only:
    - branches
    - tags

# Build with BuildKit cache export
build-buildkit:
  stage: build
  image: docker:24-git
  services:
    - docker:24-dind
  before_script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  script:
    # Build with cache export
    - |
      docker buildx build \
        --cache-from type=registry,ref=$CACHE_REGISTRY:buildcache \
        --cache-to type=registry,ref=$CACHE_REGISTRY:buildcache,mode=max \
        --push \
        --tag $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA \
        --tag $CI_REGISTRY_IMAGE:latest \
        --file Dockerfile \
        .
  only:
    - main

# Multi-stage build with separate cache per stage
build-multistage:
  stage: build
  image: docker:24-git
  services:
    - docker:24-dind
  before_script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  script:
    # Build and cache each stage separately
    - |
      docker buildx build \
        --target dependencies \
        --cache-from type=registry,ref=$CACHE_REGISTRY:deps \
        --cache-to type=registry,ref=$CACHE_REGISTRY:deps,mode=max \
        --tag $CACHE_REGISTRY:deps \
        .

    - |
      docker buildx build \
        --target build \
        --cache-from type=registry,ref=$CACHE_REGISTRY:deps \
        --cache-from type=registry,ref=$CACHE_REGISTRY:build \
        --cache-to type=registry,ref=$CACHE_REGISTRY:build,mode=max \
        --tag $CACHE_REGISTRY:build \
        .

    - |
      docker buildx build \
        --cache-from type=registry,ref=$CACHE_REGISTRY:deps \
        --cache-from type=registry,ref=$CACHE_REGISTRY:build \
        --cache-from type=registry,ref=$CI_REGISTRY_IMAGE:latest \
        --cache-to type=registry,ref=$CACHE_REGISTRY:final,mode=max \
        --push \
        --tag $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA \
        --tag $CI_REGISTRY_IMAGE:latest \
        .
```

### GitHub Actions Cache Strategy

```yaml
# .github/workflows/docker-build.yml
# Optimized Docker build in GitHub Actions

name: Build and Push Docker Image

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha

      # Cache Docker layers in GitHub Actions cache
      - name: Cache Docker layers
        uses: actions/cache@v3
        with:
          path: /tmp/.buildx-cache
          key: ${{ runner.os }}-buildx-${{ github.sha }}
          restore-keys: |
            ${{ runner.os }}-buildx-

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: |
            type=local,src=/tmp/.buildx-cache
            type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:buildcache
          cache-to: |
            type=local,dest=/tmp/.buildx-cache-new,mode=max
            type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:buildcache,mode=max
          build-args: |
            BUILDKIT_INLINE_CACHE=1

      # Temp fix for cache size growth
      - name: Move cache
        run: |
          rm -rf /tmp/.buildx-cache
          mv /tmp/.buildx-cache-new /tmp/.buildx-cache

  # Multi-stage build with stage caching
  build-multistage:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      # Build dependencies stage separately
      - name: Build dependencies
        uses: docker/build-push-action@v5
        with:
          context: .
          target: dependencies
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:deps-cache
          cache-from: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:deps-cache
          cache-to: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:deps-cache,mode=max

      # Build final image using cached dependencies
      - name: Build and push final image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          cache-from: |
            type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:deps-cache
            type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
          cache-to: type=inline
```

### Jenkins Pipeline with Cache

```groovy
// Jenkinsfile
// Docker build with layer caching

pipeline {
    agent {
        label 'docker'
    }

    environment {
        DOCKER_REGISTRY = 'registry.example.com'
        IMAGE_NAME = 'myapp'
        DOCKER_BUILDKIT = '1'
        BUILDKIT_PROGRESS = 'plain'
    }

    stages {
        stage('Build with Cache') {
            steps {
                script {
                    // Pull previous image for cache
                    sh """
                        docker pull ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest || true
                        docker pull ${DOCKER_REGISTRY}/${IMAGE_NAME}:cache || true
                    """

                    // Build with cache
                    sh """
                        docker build \\
                            --cache-from ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest \\
                            --cache-from ${DOCKER_REGISTRY}/${IMAGE_NAME}:cache \\
                            --build-arg BUILDKIT_INLINE_CACHE=1 \\
                            --tag ${DOCKER_REGISTRY}/${IMAGE_NAME}:${BUILD_NUMBER} \\
                            --tag ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest \\
                            --file Dockerfile \\
                            .
                    """
                }
            }
        }

        stage('Push Images') {
            steps {
                script {
                    docker.withRegistry("https://${DOCKER_REGISTRY}", 'docker-registry-credentials') {
                        sh """
                            docker push ${DOCKER_REGISTRY}/${IMAGE_NAME}:${BUILD_NUMBER}
                            docker push ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest
                        """
                    }
                }
            }
        }

        stage('Build with BuildKit Cache Export') {
            when {
                branch 'main'
            }
            steps {
                script {
                    sh """
                        docker buildx build \\
                            --cache-from type=registry,ref=${DOCKER_REGISTRY}/${IMAGE_NAME}:buildcache \\
                            --cache-to type=registry,ref=${DOCKER_REGISTRY}/${IMAGE_NAME}:buildcache,mode=max \\
                            --push \\
                            --tag ${DOCKER_REGISTRY}/${IMAGE_NAME}:${BUILD_NUMBER} \\
                            --tag ${DOCKER_REGISTRY}/${IMAGE_NAME}:latest \\
                            --file Dockerfile \\
                            .
                    """
                }
            }
        }
    }

    post {
        always {
            // Cleanup
            sh 'docker system prune -f --filter "until=24h"'
        }
    }
}
```

## Performance Monitoring

### Build Time Analysis

```bash
#!/bin/bash
# Analyze Docker build performance

cat << 'EOF' > /usr/local/bin/docker-build-analyzer.sh
#!/bin/bash

set -e

# Build with timing information
build_with_timing() {
    local dockerfile=$1
    local tag=$2
    local build_args="${@:3}"

    echo "=== Building $tag with timing ==="
    echo "Dockerfile: $dockerfile"
    echo "Build args: $build_args"
    echo

    # Enable BuildKit for better output
    export DOCKER_BUILDKIT=1
    export BUILDKIT_PROGRESS=plain

    # Build and capture timing
    START_TIME=$(date +%s)

    docker build \
        -f "$dockerfile" \
        -t "$tag" \
        $build_args \
        . 2>&1 | tee /tmp/build-output.log

    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))

    echo
    echo "=== Build Summary ==="
    echo "Total build time: ${DURATION}s"

    # Analyze cache hits
    CACHE_HITS=$(grep -c "CACHED" /tmp/build-output.log || echo "0")
    TOTAL_STEPS=$(grep -c "RUN\|COPY\|ADD" "$dockerfile" || echo "1")
    CACHE_RATE=$(echo "scale=2; $CACHE_HITS * 100 / $TOTAL_STEPS" | bc)

    echo "Cache hits: $CACHE_HITS / $TOTAL_STEPS ($CACHE_RATE%)"

    # Find slowest steps
    echo
    echo "=== Slowest Build Steps ==="
    grep -E "^\[.*\] RUN" /tmp/build-output.log | \
        awk '{print $NF}' | \
        sort -rn | \
        head -5
}

# Compare build times
compare_builds() {
    local dockerfile=$1
    local tag=$2

    echo "=== Build Time Comparison ==="

    # First build (cold cache)
    docker builder prune -af >/dev/null 2>&1
    echo "Build 1: Cold cache"
    START1=$(date +%s)
    docker build -f "$dockerfile" -t "$tag" . >/dev/null 2>&1
    END1=$(date +%s)
    TIME1=$((END1 - START1))
    echo "Time: ${TIME1}s"

    # Second build (warm cache)
    echo
    echo "Build 2: Warm cache (no changes)"
    START2=$(date +%s)
    docker build -f "$dockerfile" -t "$tag" . >/dev/null 2>&1
    END2=$(date +%s)
    TIME2=$((END2 - START2))
    echo "Time: ${TIME2}s"

    # Third build (source code change)
    echo
    echo "Build 3: Source code change"
    touch src/dummy-change-$$
    START3=$(date +%s)
    docker build -f "$dockerfile" -t "$tag" . >/dev/null 2>&1
    END3=$(date +%s)
    TIME3=$((END3 - START3))
    echo "Time: ${TIME3}s"
    rm -f src/dummy-change-$$

    # Summary
    echo
    echo "=== Summary ==="
    echo "Cold cache:        ${TIME1}s"
    echo "Warm cache:        ${TIME2}s ($(echo "scale=1; ($TIME1 - $TIME2) * 100 / $TIME1" | bc)% faster)"
    echo "Source change:     ${TIME3}s ($(echo "scale=1; ($TIME1 - $TIME3) * 100 / $TIME1" | bc)% faster)"

    SPEEDUP=$(echo "scale=1; $TIME1 / $TIME2" | bc)
    echo "Cache speedup:     ${SPEEDUP}x"
}

# Analyze layer sizes and times
analyze_layer_performance() {
    local image=$1

    echo "=== Layer Performance Analysis for $image ==="
    echo

    # Get layer information
    docker history "$image" --no-trunc --format "{{.Size}}\t{{.CreatedBy}}" | \
        awk -F'\t' '
        BEGIN {
            print "Size\t\tCommand"
            print "----\t\t-------"
        }
        {
            # Extract size
            size = $1
            cmd = $2

            # Print formatted
            printf "%-12s\t%s\n", size, substr(cmd, 1, 80)
        }
        ' | head -20

    # Calculate total size
    TOTAL_SIZE=$(docker images "$image" --format "{{.Size}}")
    echo
    echo "Total image size: $TOTAL_SIZE"
}

# Cache effectiveness report
cache_effectiveness_report() {
    local build_log=$1

    echo "=== Cache Effectiveness Report ==="
    echo

    if [ ! -f "$build_log" ]; then
        echo "Error: Build log not found: $build_log"
        return 1
    fi

    # Count cache hits vs misses
    CACHED=$(grep -c "CACHED" "$build_log" || echo "0")
    TOTAL=$(grep -c "^\[.*\] (RUN\|COPY\|ADD)" "$build_log" || echo "1")
    UNCACHED=$((TOTAL - CACHED))

    echo "Total steps:    $TOTAL"
    echo "Cached steps:   $CACHED"
    echo "Uncached steps: $UNCACHED"
    echo "Cache hit rate: $(echo "scale=2; $CACHED * 100 / $TOTAL" | bc)%"

    echo
    echo "=== Uncached Layers ==="
    grep -B1 "^\[.*\] (RUN\|COPY\|ADD)" "$build_log" | \
        grep -v "CACHED" | \
        grep -v "^--$" | \
        head -10
}

# Main execution
case "${1:-help}" in
    build)
        shift
        build_with_timing "$@"
        ;;
    compare)
        if [ $# -lt 3 ]; then
            echo "Usage: $0 compare <dockerfile> <tag>"
            exit 1
        fi
        compare_builds "$2" "$3"
        ;;
    analyze)
        if [ -z "$2" ]; then
            echo "Usage: $0 analyze <image>"
            exit 1
        fi
        analyze_layer_performance "$2"
        ;;
    report)
        if [ -z "$2" ]; then
            echo "Usage: $0 report <build-log-file>"
            exit 1
        fi
        cache_effectiveness_report "$2"
        ;;
    *)
        echo "Usage: $0 {build|compare|analyze|report} [args]"
        echo
        echo "Commands:"
        echo "  build <dockerfile> <tag> [build-args]  - Build with timing analysis"
        echo "  compare <dockerfile> <tag>             - Compare cold vs warm builds"
        echo "  analyze <image>                        - Analyze layer performance"
        echo "  report <build-log>                     - Generate cache effectiveness report"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/docker-build-analyzer.sh
```

## Conclusion

Effective Docker image layer caching is essential for fast, efficient CI/CD pipelines. By understanding cache behavior, implementing optimal Dockerfile structure, leveraging BuildKit features like cache mounts and secrets, and integrating caching strategies into CI/CD pipelines, organizations can dramatically reduce build times and improve developer productivity.

Key strategies for optimal caching:
- Order Dockerfile instructions from least to most frequently changing
- Use multi-stage builds to cache dependencies separately from source code
- Leverage BuildKit cache mounts for package managers
- Implement registry-based cache storage for CI/CD pipelines
- Use .dockerignore to minimize build context
- Monitor cache effectiveness and adjust strategies accordingly
- Consider separate cache images for different build stages
- Use specific version tags rather than 'latest' for base images
- Regularly prune unused cache to manage storage