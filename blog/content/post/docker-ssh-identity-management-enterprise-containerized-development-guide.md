---
title: "Docker SSH Identity Management: Enterprise Containerized Development and Secure Build Pipeline Guide"
date: 2026-06-16T00:00:00-05:00
draft: false
tags: ["Docker", "SSH", "Container Security", "DevOps", "Identity Management", "Enterprise", "Build Pipeline"]
categories: ["DevOps", "Container Security", "Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Docker SSH identity management for enterprise containerized development with secure multi-key authentication, build secrets, and production-ready deployment strategies."
more_link: "yes"
url: "/docker-ssh-identity-management-enterprise-containerized-development-guide/"
---

Enterprise containerized development environments require sophisticated SSH identity management strategies that balance security, flexibility, and operational efficiency. Managing multiple SSH identities within Docker containers presents unique challenges, particularly when dealing with different repositories, environments, and security requirements across large-scale development teams.

Modern development workflows increasingly rely on containerized build processes that need secure access to private repositories, internal services, and restricted resources. Understanding how to properly manage SSH identities in Docker environments while maintaining security best practices is crucial for DevOps teams building production-grade containerized applications.

<!--more-->

## Executive Summary

Docker SSH identity management enables secure, flexible authentication in containerized development environments through build secrets, mount strategies, and explicit identity configuration. This comprehensive guide covers enterprise-grade patterns for managing multiple SSH identities, securing build processes, and implementing production-ready containerized development workflows that scale across complex organizational structures.

## Understanding Docker SSH Architecture

### Build Context and Security Model

Docker's SSH integration leverages build secrets and mount points to provide secure access to private keys during the build process:

```dockerfile
# Advanced multi-stage Dockerfile with SSH identity management
# syntax=docker/dockerfile:1.4
FROM node:18-alpine AS base

# Install essential packages for SSH operations
RUN apk add --no-cache \
    openssh-client \
    git \
    curl \
    ca-certificates

# Configure SSH client for container environment
RUN mkdir -p /root/.ssh && \
    chmod 700 /root/.ssh && \
    ssh-keyscan -H github.com >> /root/.ssh/known_hosts && \
    ssh-keyscan -H gitlab.com >> /root/.ssh/known_hosts && \
    ssh-keyscan -H bitbucket.org >> /root/.ssh/known_hosts

FROM base AS development

# Development stage with enhanced SSH configuration
COPY ssh-config/config /root/.ssh/config
RUN chmod 600 /root/.ssh/config

# Install development dependencies with SSH access
FROM base AS dependencies

# Use build secrets for SSH key access
ARG SSH_IDENTITY_FILE=/run/secrets/ssh_key
ARG GIT_SSH_COMMAND

# Configure SSH for specific repository access
RUN --mount=type=ssh,id=default \
    --mount=type=secret,id=ssh_key,target=/run/secrets/ssh_key \
    --mount=type=secret,id=ssh_config,target=/run/secrets/ssh_config \
    set -eux; \
    # Copy SSH configuration
    if [ -f /run/secrets/ssh_config ]; then \
        cp /run/secrets/ssh_config /root/.ssh/config; \
        chmod 600 /root/.ssh/config; \
    fi; \
    # Set up SSH agent
    eval $(ssh-agent); \
    # Add specific identity
    if [ -f /run/secrets/ssh_key ]; then \
        ssh-add /run/secrets/ssh_key; \
    fi; \
    # Clone private repositories
    git clone git@github.com:company/private-repo.git /tmp/private-repo; \
    # Install dependencies
    npm ci --only=production

FROM base AS runtime
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### SSH Configuration Management

Implement comprehensive SSH configuration for multiple identity scenarios:

```bash
# ssh-config/config
# SSH client configuration for containerized environments

Host github.com-personal
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_rsa_personal
    IdentitiesOnly yes
    StrictHostKeyChecking yes

Host github.com-work
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_rsa_work
    IdentitiesOnly yes
    StrictHostKeyChecking yes

Host gitlab.internal
    HostName gitlab.company.internal
    User git
    Port 2222
    IdentityFile ~/.ssh/id_rsa_internal
    IdentitiesOnly yes
    StrictHostKeyChecking yes

Host bitbucket.org-team
    HostName bitbucket.org
    User git
    IdentityFile ~/.ssh/id_rsa_team
    IdentitiesOnly yes
    StrictHostKeyChecking yes

# Default fallback configuration
Host *
    ServerAliveInterval 60
    ServerAliveCountMax 3
    TCPKeepAlive yes
    Compression yes
    HashKnownHosts yes
```

## Enterprise Build Pipeline Integration

### Multi-Environment Build Strategy

Design build pipelines that handle multiple SSH identities across different environments:

```bash
#!/bin/bash
# Script: docker-build-with-ssh.sh
# Purpose: Enterprise Docker build with SSH identity management

set -euo pipefail

# Configuration
BUILD_CONTEXT="${BUILD_CONTEXT:-$(pwd)}"
DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
ENVIRONMENT="${ENVIRONMENT:-development}"

# SSH identity configuration
declare -A SSH_IDENTITIES=(
    ["development"]="$HOME/.ssh/id_rsa_dev"
    ["staging"]="$HOME/.ssh/id_rsa_staging"
    ["production"]="$HOME/.ssh/id_rsa_prod"
    ["internal"]="$HOME/.ssh/id_rsa_internal"
)

# SSH configuration templates
declare -A SSH_CONFIGS=(
    ["development"]="ssh-config/dev-config"
    ["staging"]="ssh-config/staging-config"
    ["production"]="ssh-config/prod-config"
    ["internal"]="ssh-config/internal-config"
)

function validate_environment() {
    local env="$1"

    if [[ ! "${SSH_IDENTITIES[$env]+x}" ]]; then
        echo "❌ Invalid environment: $env"
        echo "Available environments: ${!SSH_IDENTITIES[*]}"
        exit 1
    fi

    local ssh_key="${SSH_IDENTITIES[$env]}"
    if [[ ! -f "$ssh_key" ]]; then
        echo "❌ SSH key not found: $ssh_key"
        exit 1
    fi

    echo "✅ Environment validated: $env"
    echo "📋 SSH key: $ssh_key"
}

function prepare_ssh_secrets() {
    local env="$1"
    local temp_dir
    temp_dir=$(mktemp -d)

    # Copy SSH key with restricted permissions
    local ssh_key="${SSH_IDENTITIES[$env]}"
    cp "$ssh_key" "$temp_dir/ssh_key"
    chmod 600 "$temp_dir/ssh_key"

    # Prepare SSH configuration
    local ssh_config="${SSH_CONFIGS[$env]}"
    if [[ -f "$ssh_config" ]]; then
        cp "$ssh_config" "$temp_dir/ssh_config"
        chmod 600 "$temp_dir/ssh_config"
    fi

    echo "$temp_dir"
}

function build_with_ssh_identity() {
    local env="$1"
    local image_name="$2"

    echo "🏗️  Building Docker image with SSH identity for $env"

    # Validate environment and prepare secrets
    validate_environment "$env"
    local secrets_dir
    secrets_dir=$(prepare_ssh_secrets "$env")

    # Construct SSH command
    local ssh_key="${SSH_IDENTITIES[$env]}"
    local git_ssh_command="ssh -i /run/secrets/ssh_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

    # Build arguments
    local build_args=(
        --build-arg "ENVIRONMENT=$env"
        --build-arg "GIT_SSH_COMMAND=$git_ssh_command"
        --build-arg "BUILD_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    )

    # SSH and secret mounts
    local mount_args=(
        --ssh "default=$ssh_key"
        --secret "id=ssh_key,src=$secrets_dir/ssh_key"
    )

    # Add SSH config if available
    if [[ -f "$secrets_dir/ssh_config" ]]; then
        mount_args+=("--secret" "id=ssh_config,src=$secrets_dir/ssh_config")
    fi

    # Execute Docker build
    DOCKER_BUILDKIT=1 docker build \
        "${build_args[@]}" \
        "${mount_args[@]}" \
        --tag "$image_name:$IMAGE_TAG" \
        --tag "$image_name:$env-$(git rev-parse --short HEAD)" \
        --file "$DOCKERFILE" \
        "$BUILD_CONTEXT"

    local build_exit_code=$?

    # Cleanup secrets
    rm -rf "$secrets_dir"

    if [[ $build_exit_code -eq 0 ]]; then
        echo "✅ Build completed successfully"
        echo "🏷️  Image: $image_name:$IMAGE_TAG"
    else
        echo "❌ Build failed with exit code $build_exit_code"
        exit $build_exit_code
    fi
}

function build_multi_platform() {
    local env="$1"
    local image_name="$2"
    local platforms="linux/amd64,linux/arm64"

    echo "🏗️  Building multi-platform Docker image"

    validate_environment "$env"
    local secrets_dir
    secrets_dir=$(prepare_ssh_secrets "$env")

    # Create builder if not exists
    docker buildx create --name multiarch --use 2>/dev/null || \
    docker buildx use multiarch 2>/dev/null || true

    # Multi-platform build
    DOCKER_BUILDKIT=1 docker buildx build \
        --platform "$platforms" \
        --build-arg "ENVIRONMENT=$env" \
        --build-arg "GIT_SSH_COMMAND=ssh -i /run/secrets/ssh_key -o IdentitiesOnly=yes" \
        --ssh "default=${SSH_IDENTITIES[$env]}" \
        --secret "id=ssh_key,src=$secrets_dir/ssh_key" \
        --tag "$image_name:$IMAGE_TAG" \
        --push \
        --file "$DOCKERFILE" \
        "$BUILD_CONTEXT"

    rm -rf "$secrets_dir"
}

# Main execution
case "${1:-build}" in
    "build")
        build_with_ssh_identity "$ENVIRONMENT" "${2:-myapp}"
        ;;
    "multi-platform")
        build_multi_platform "$ENVIRONMENT" "${2:-myapp}"
        ;;
    "validate")
        validate_environment "$ENVIRONMENT"
        ;;
    *)
        echo "Usage: $0 {build|multi-platform|validate} [image-name]"
        exit 1
        ;;
esac
```

### Advanced Makefile Integration

Create sophisticated Makefile targets for SSH-enabled Docker builds:

```makefile
# Advanced Makefile for Docker SSH identity management

# Configuration
PROJECT_NAME := enterprise-app
REGISTRY := registry.company.internal
DOCKER_BUILDKIT := 1
BUILD_CONTEXT := .

# Environment-specific configuration
DEV_SSH_KEY := $(HOME)/.ssh/id_rsa_dev
STAGING_SSH_KEY := $(HOME)/.ssh/id_rsa_staging
PROD_SSH_KEY := $(HOME)/.ssh/id_rsa_prod

# Dynamic environment detection
CURRENT_BRANCH := $(shell git branch --show-current)
GIT_SHA := $(shell git rev-parse --short HEAD)
BUILD_DATE := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

# Environment mapping
ifeq ($(CURRENT_BRANCH),main)
    ENVIRONMENT := production
    SSH_KEY := $(PROD_SSH_KEY)
else ifeq ($(CURRENT_BRANCH),staging)
    ENVIRONMENT := staging
    SSH_KEY := $(STAGING_SSH_KEY)
else
    ENVIRONMENT := development
    SSH_KEY := $(DEV_SSH_KEY)
endif

# Image naming
IMAGE_NAME := $(REGISTRY)/$(PROJECT_NAME)
IMAGE_TAG := $(ENVIRONMENT)-$(GIT_SHA)

# Validation targets
.PHONY: validate-ssh
validate-ssh:
	@echo "🔍 Validating SSH configuration for $(ENVIRONMENT)"
	@test -f "$(SSH_KEY)" || (echo "❌ SSH key not found: $(SSH_KEY)" && exit 1)
	@ssh-keygen -l -f "$(SSH_KEY)" > /dev/null || (echo "❌ Invalid SSH key format" && exit 1)
	@echo "✅ SSH key validated: $(SSH_KEY)"

.PHONY: validate-docker
validate-docker:
	@echo "🐳 Validating Docker configuration"
	@docker buildx version > /dev/null || (echo "❌ Docker Buildx not available" && exit 1)
	@docker info | grep -q "BuildKit" || export DOCKER_BUILDKIT=1
	@echo "✅ Docker validated with BuildKit support"

# SSH secret preparation
.PHONY: prepare-secrets
prepare-secrets: validate-ssh
	@echo "🔐 Preparing SSH secrets for $(ENVIRONMENT)"
	@mkdir -p .docker-secrets
	@cp "$(SSH_KEY)" .docker-secrets/ssh_key
	@chmod 600 .docker-secrets/ssh_key
	@if [ -f "ssh-config/$(ENVIRONMENT)-config" ]; then \
		cp "ssh-config/$(ENVIRONMENT)-config" .docker-secrets/ssh_config; \
		chmod 600 .docker-secrets/ssh_config; \
	fi

# Build targets
.PHONY: build
build: validate-docker prepare-secrets
	@echo "🏗️  Building $(IMAGE_NAME):$(IMAGE_TAG)"
	DOCKER_BUILDKIT=1 docker build \
		--build-arg ENVIRONMENT="$(ENVIRONMENT)" \
		--build-arg BUILD_DATE="$(BUILD_DATE)" \
		--build-arg GIT_SHA="$(GIT_SHA)" \
		--build-arg GIT_SSH_COMMAND="ssh -i /run/secrets/ssh_key -o IdentitiesOnly=yes" \
		--ssh default="$(SSH_KEY)" \
		--secret id=ssh_key,src=.docker-secrets/ssh_key \
		$(if $(wildcard .docker-secrets/ssh_config),--secret id=ssh_config$(,)src=.docker-secrets/ssh_config) \
		--tag "$(IMAGE_NAME):$(IMAGE_TAG)" \
		--tag "$(IMAGE_NAME):$(ENVIRONMENT)-latest" \
		--file Dockerfile \
		$(BUILD_CONTEXT)
	@$(MAKE) cleanup-secrets

.PHONY: build-with-cache
build-with-cache: prepare-secrets
	@echo "🏗️  Building with cache optimization"
	DOCKER_BUILDKIT=1 docker build \
		--build-arg BUILDKIT_INLINE_CACHE=1 \
		--build-arg ENVIRONMENT="$(ENVIRONMENT)" \
		--cache-from "$(IMAGE_NAME):$(ENVIRONMENT)-latest" \
		--ssh default="$(SSH_KEY)" \
		--secret id=ssh_key,src=.docker-secrets/ssh_key \
		--tag "$(IMAGE_NAME):$(IMAGE_TAG)" \
		$(BUILD_CONTEXT)
	@$(MAKE) cleanup-secrets

.PHONY: build-multi-platform
build-multi-platform: prepare-secrets
	@echo "🏗️  Building multi-platform image"
	@docker buildx create --name $(PROJECT_NAME)-builder --use 2>/dev/null || \
	 docker buildx use $(PROJECT_NAME)-builder 2>/dev/null || true
	DOCKER_BUILDKIT=1 docker buildx build \
		--platform linux/amd64,linux/arm64 \
		--build-arg ENVIRONMENT="$(ENVIRONMENT)" \
		--ssh default="$(SSH_KEY)" \
		--secret id=ssh_key,src=.docker-secrets/ssh_key \
		--tag "$(IMAGE_NAME):$(IMAGE_TAG)" \
		--push \
		$(BUILD_CONTEXT)
	@$(MAKE) cleanup-secrets

# Development targets
.PHONY: dev-build
dev-build:
	@$(MAKE) build ENVIRONMENT=development

.PHONY: staging-build
staging-build:
	@$(MAKE) build ENVIRONMENT=staging

.PHONY: prod-build
prod-build:
	@$(MAKE) build ENVIRONMENT=production

# Testing targets
.PHONY: test-ssh-access
test-ssh-access: prepare-secrets
	@echo "🧪 Testing SSH access in container"
	@docker run --rm -it \
		--mount type=bind,source=$(PWD)/.docker-secrets/ssh_key,target=/root/.ssh/id_rsa,readonly \
		--mount type=bind,source=$(PWD)/ssh-config,target=/root/.ssh/config,readonly \
		alpine/git \
		sh -c 'chmod 600 /root/.ssh/id_rsa && ssh -T git@github.com'
	@$(MAKE) cleanup-secrets

# Security scanning
.PHONY: security-scan
security-scan:
	@echo "🔒 Running security scan on $(IMAGE_NAME):$(IMAGE_TAG)"
	@docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
		aquasec/trivy image --exit-code 1 --severity HIGH,CRITICAL \
		"$(IMAGE_NAME):$(IMAGE_TAG)"

# Cleanup
.PHONY: cleanup-secrets
cleanup-secrets:
	@echo "🧹 Cleaning up SSH secrets"
	@rm -rf .docker-secrets

.PHONY: cleanup-builders
cleanup-builders:
	@echo "🧹 Cleaning up Docker builders"
	@docker buildx rm $(PROJECT_NAME)-builder 2>/dev/null || true

.PHONY: clean
clean: cleanup-secrets cleanup-builders
	@echo "🧹 Cleaning up Docker images"
	@docker image prune -f --filter "label=project=$(PROJECT_NAME)"

# Push targets
.PHONY: push
push:
	@echo "📤 Pushing $(IMAGE_NAME):$(IMAGE_TAG)"
	@docker push "$(IMAGE_NAME):$(IMAGE_TAG)"
	@docker push "$(IMAGE_NAME):$(ENVIRONMENT)-latest"

.PHONY: deploy
deploy: build push
	@echo "🚀 Deploying $(IMAGE_NAME):$(IMAGE_TAG)"
	@kubectl set image deployment/$(PROJECT_NAME) \
		$(PROJECT_NAME)="$(IMAGE_NAME):$(IMAGE_TAG)" \
		--namespace="$(ENVIRONMENT)"

# Help target
.PHONY: help
help:
	@echo "Available targets:"
	@echo "  build                 - Build Docker image for current environment"
	@echo "  build-multi-platform  - Build multi-platform Docker image"
	@echo "  dev-build            - Build for development environment"
	@echo "  staging-build        - Build for staging environment"
	@echo "  prod-build           - Build for production environment"
	@echo "  test-ssh-access      - Test SSH access in container"
	@echo "  security-scan        - Run security scan on built image"
	@echo "  push                 - Push image to registry"
	@echo "  deploy               - Build, push, and deploy"
	@echo "  clean                - Clean up images and secrets"
	@echo ""
	@echo "Current configuration:"
	@echo "  Environment: $(ENVIRONMENT)"
	@echo "  SSH Key: $(SSH_KEY)"
	@echo "  Image: $(IMAGE_NAME):$(IMAGE_TAG)"
```

## Security Patterns and Best Practices

### Secret Management and Key Rotation

Implement comprehensive secret management for SSH identities:

```bash
#!/bin/bash
# Script: ssh-key-rotation.sh
# Purpose: Automated SSH key rotation for Docker environments

set -euo pipefail

# Configuration
KEY_DIR="${HOME}/.ssh"
BACKUP_DIR="${KEY_DIR}/backups"
KEY_SIZE="4096"
KEY_TYPE="rsa"
ENVIRONMENTS=("development" "staging" "production" "internal")

function rotate_ssh_key() {
    local env="$1"
    local key_name="id_rsa_${env}"
    local key_path="${KEY_DIR}/${key_name}"
    local backup_timestamp=$(date +%Y%m%d_%H%M%S)

    echo "🔄 Rotating SSH key for environment: $env"

    # Create backup directory
    mkdir -p "$BACKUP_DIR"

    # Backup existing key if it exists
    if [[ -f "$key_path" ]]; then
        echo "💾 Backing up existing key"
        cp "$key_path" "${BACKUP_DIR}/${key_name}_${backup_timestamp}"
        cp "${key_path}.pub" "${BACKUP_DIR}/${key_name}.pub_${backup_timestamp}"
    fi

    # Generate new key pair
    echo "🔑 Generating new SSH key pair"
    ssh-keygen -t "$KEY_TYPE" -b "$KEY_SIZE" -f "$key_path" -N "" -C "${env}@$(hostname)-$(date +%Y%m%d)"

    # Set appropriate permissions
    chmod 600 "$key_path"
    chmod 644 "${key_path}.pub"

    # Update SSH configuration
    update_ssh_config "$env" "$key_name"

    echo "✅ SSH key rotation completed for $env"
    echo "📋 Public key: ${key_path}.pub"
    echo "🔑 Fingerprint: $(ssh-keygen -lf "$key_path")"
}

function update_ssh_config() {
    local env="$1"
    local key_name="$2"
    local config_file="${KEY_DIR}/config"
    local temp_config=$(mktemp)

    echo "⚙️  Updating SSH configuration"

    # Create or update SSH config
    if [[ -f "$config_file" ]]; then
        # Remove existing configuration for this environment
        awk -v env="$env" '
            BEGIN { skip=0 }
            /^Host.*-'"$env"'$/ { skip=1; next }
            /^Host / && skip { skip=0 }
            !skip { print }
        ' "$config_file" > "$temp_config"
    fi

    # Add new configuration
    cat >> "$temp_config" <<EOF

Host github.com-${env}
    HostName github.com
    User git
    IdentityFile ~/.ssh/${key_name}
    IdentitiesOnly yes
    StrictHostKeyChecking yes

Host gitlab.internal-${env}
    HostName gitlab.company.internal
    User git
    Port 2222
    IdentityFile ~/.ssh/${key_name}
    IdentitiesOnly yes
    StrictHostKeyChecking yes
EOF

    # Replace original configuration
    mv "$temp_config" "$config_file"
    chmod 600 "$config_file"

    echo "✅ SSH configuration updated"
}

function validate_key_access() {
    local env="$1"
    local key_name="id_rsa_${env}"
    local key_path="${KEY_DIR}/${key_name}"

    echo "🧪 Validating SSH key access for $env"

    # Test GitHub access
    if ssh -i "$key_path" -o IdentitiesOnly=yes -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
        echo "✅ GitHub access validated for $env"
    else
        echo "⚠️  GitHub access validation failed for $env"
    fi

    # Test GitLab access (if configured)
    if ssh -i "$key_path" -o IdentitiesOnly=yes -T git@gitlab.company.internal 2>&1 | grep -q "Welcome"; then
        echo "✅ GitLab access validated for $env"
    else
        echo "⚠️  GitLab access validation failed for $env"
    fi
}

function audit_ssh_keys() {
    echo "📊 SSH Key Audit Report"
    echo "======================="

    for env in "${ENVIRONMENTS[@]}"; do
        local key_name="id_rsa_${env}"
        local key_path="${KEY_DIR}/${key_name}"

        if [[ -f "$key_path" ]]; then
            local fingerprint=$(ssh-keygen -lf "$key_path" 2>/dev/null || echo "Invalid key")
            local creation_date=$(stat -c %y "$key_path" 2>/dev/null || echo "Unknown")

            echo "Environment: $env"
            echo "  Key: $key_path"
            echo "  Fingerprint: $fingerprint"
            echo "  Created: $creation_date"
            echo ""
        else
            echo "Environment: $env - ❌ Key not found"
            echo ""
        fi
    done
}

# Main execution
case "${1:-audit}" in
    "rotate")
        if [[ -n "${2:-}" ]]; then
            rotate_ssh_key "$2"
        else
            for env in "${ENVIRONMENTS[@]}"; do
                rotate_ssh_key "$env"
            done
        fi
        ;;
    "validate")
        if [[ -n "${2:-}" ]]; then
            validate_key_access "$2"
        else
            for env in "${ENVIRONMENTS[@]}"; do
                validate_key_access "$env"
            done
        fi
        ;;
    "audit")
        audit_ssh_keys
        ;;
    *)
        echo "Usage: $0 {rotate|validate|audit} [environment]"
        echo "Available environments: ${ENVIRONMENTS[*]}"
        exit 1
        ;;
esac
```

### Container Security Hardening

Implement security hardening for SSH-enabled containers:

```dockerfile
# Security-hardened Dockerfile with SSH identity management
# syntax=docker/dockerfile:1.4
FROM node:18-alpine AS security-base

# Install security scanning tools
RUN apk add --no-cache \
    openssh-client \
    git \
    ca-certificates \
    curl \
    dumb-init \
    && rm -rf /var/cache/apk/*

# Create non-root user for application
RUN addgroup -g 10001 -S appgroup && \
    adduser -u 10001 -S appuser -G appgroup -h /app

# Set up SSH directory with proper permissions
USER appuser
RUN mkdir -p /app/.ssh && \
    chmod 700 /app/.ssh

# Security configuration
FROM security-base AS secure-build

# Copy SSH configuration as non-root user
COPY --chown=appuser:appgroup ssh-config/config /app/.ssh/config
RUN chmod 600 /app/.ssh/config

# Add known hosts for common Git providers
RUN ssh-keyscan -H github.com >> /app/.ssh/known_hosts && \
    ssh-keyscan -H gitlab.com >> /app/.ssh/known_hosts && \
    chmod 644 /app/.ssh/known_hosts

# Install dependencies with SSH access
FROM secure-build AS dependencies

WORKDIR /app

# Copy package files
COPY --chown=appuser:appgroup package*.json ./

# Use build secrets for SSH access
RUN --mount=type=ssh,id=default,uid=10001,gid=10001 \
    --mount=type=secret,id=ssh_key,target=/app/.ssh/id_rsa,uid=10001,gid=10001,mode=600 \
    set -eux; \
    # Start SSH agent
    eval $(ssh-agent); \
    # Add SSH key
    ssh-add /app/.ssh/id_rsa; \
    # Install dependencies
    npm ci --only=production; \
    # Clear SSH agent
    ssh-agent -k || true

# Runtime stage
FROM security-base AS runtime

WORKDIR /app

# Copy application files
COPY --chown=appuser:appgroup --from=dependencies /app/node_modules ./node_modules
COPY --chown=appuser:appgroup . .

# Remove SSH directory from final image
RUN rm -rf /app/.ssh

# Security hardening
RUN chmod -R o-rwx /app && \
    find /app -type f -executable -exec chmod u+x,g-x,o-x {} \;

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose port
EXPOSE 3000

# Run as non-root user
USER appuser

# Start application
CMD ["npm", "start"]
```

## CI/CD Pipeline Integration

### GitHub Actions Workflow

Integrate SSH identity management with GitHub Actions:

```yaml
name: Docker Build with SSH Identity Management

on:
  push:
    branches: [main, develop, staging]
  pull_request:
    branches: [main]

env:
  REGISTRY: registry.company.internal
  IMAGE_NAME: enterprise-app

jobs:
  determine-environment:
    runs-on: ubuntu-latest
    outputs:
      environment: ${{ steps.env.outputs.environment }}
      ssh-key-secret: ${{ steps.env.outputs.ssh_key_secret }}
    steps:
      - name: Determine Environment
        id: env
        run: |
          case "${{ github.ref_name }}" in
            "main")
              echo "environment=production" >> $GITHUB_OUTPUT
              echo "ssh_key_secret=SSH_KEY_PRODUCTION" >> $GITHUB_OUTPUT
              ;;
            "staging")
              echo "environment=staging" >> $GITHUB_OUTPUT
              echo "ssh_key_secret=SSH_KEY_STAGING" >> $GITHUB_OUTPUT
              ;;
            *)
              echo "environment=development" >> $GITHUB_OUTPUT
              echo "ssh_key_secret=SSH_KEY_DEVELOPMENT" >> $GITHUB_OUTPUT
              ;;
          esac

  build-and-push:
    needs: determine-environment
    runs-on: ubuntu-latest
    environment: ${{ needs.determine-environment.outputs.environment }}

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ secrets.REGISTRY_USERNAME }}
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - name: Prepare SSH Key
        id: ssh-prep
        run: |
          mkdir -p /tmp/ssh-secrets
          echo "${{ secrets[needs.determine-environment.outputs.ssh-key-secret] }}" > /tmp/ssh-secrets/ssh_key
          chmod 600 /tmp/ssh-secrets/ssh_key

          # Verify SSH key format
          ssh-keygen -l -f /tmp/ssh-secrets/ssh_key

          echo "ssh_key_path=/tmp/ssh-secrets/ssh_key" >> $GITHUB_OUTPUT

      - name: Prepare SSH Configuration
        run: |
          mkdir -p /tmp/ssh-secrets
          cat > /tmp/ssh-secrets/ssh_config <<EOF
          Host github.com
              HostName github.com
              User git
              IdentityFile /run/secrets/ssh_key
              IdentitiesOnly yes
              StrictHostKeyChecking yes

          Host gitlab.company.internal
              HostName gitlab.company.internal
              User git
              Port 2222
              IdentityFile /run/secrets/ssh_key
              IdentitiesOnly yes
              StrictHostKeyChecking yes
          EOF
          chmod 600 /tmp/ssh-secrets/ssh_config

      - name: Extract Metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=sha,prefix={{branch}}-
            type=raw,value=${{ needs.determine-environment.outputs.environment }}-latest

      - name: Build and Push Docker Image
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          ssh: |
            default=${{ steps.ssh-prep.outputs.ssh_key_path }}
          secrets: |
            ssh_key=/tmp/ssh-secrets/ssh_key
            ssh_config=/tmp/ssh-secrets/ssh_config
          build-args: |
            ENVIRONMENT=${{ needs.determine-environment.outputs.environment }}
            BUILD_DATE=${{ fromJSON(steps.meta.outputs.json).labels['org.opencontainers.image.created'] }}
            GIT_SHA=${{ github.sha }}
            GIT_SSH_COMMAND=ssh -i /run/secrets/ssh_key -o IdentitiesOnly=yes

      - name: Security Scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          format: sarif
          output: trivy-results.sarif

      - name: Upload Security Scan Results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif

      - name: Cleanup SSH Secrets
        if: always()
        run: |
          rm -rf /tmp/ssh-secrets

  deploy:
    needs: [determine-environment, build-and-push]
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/staging'
    runs-on: ubuntu-latest
    environment: ${{ needs.determine-environment.outputs.environment }}

    steps:
      - name: Deploy to Kubernetes
        run: |
          echo "Deploying to ${{ needs.determine-environment.outputs.environment }}"
          # Kubernetes deployment commands would go here
```

## Troubleshooting and Debugging

### SSH Connection Diagnostics

Comprehensive troubleshooting tools for SSH issues in containers:

```bash
#!/bin/bash
# Script: debug-docker-ssh.sh
# Purpose: Diagnose SSH connectivity issues in Docker containers

set -euo pipefail

function test_ssh_from_container() {
    local image="$1"
    local ssh_key="$2"
    local target_host="${3:-github.com}"

    echo "🔍 Testing SSH connectivity from container"
    echo "Image: $image"
    echo "SSH Key: $ssh_key"
    echo "Target: $target_host"

    # Create temporary directory for secrets
    local temp_dir=$(mktemp -d)
    cp "$ssh_key" "$temp_dir/ssh_key"
    chmod 600 "$temp_dir/ssh_key"

    # Test SSH connectivity
    docker run --rm -it \
        --mount "type=bind,source=$temp_dir/ssh_key,target=/root/.ssh/id_rsa,readonly" \
        --entrypoint sh \
        "$image" \
        -c "
            set -ex
            chmod 600 /root/.ssh/id_rsa
            ssh-keyscan -H $target_host >> /root/.ssh/known_hosts

            echo '🧪 Testing SSH connection...'
            ssh -vvv -i /root/.ssh/id_rsa -o IdentitiesOnly=yes -T git@$target_host
        "

    local exit_code=$?
    rm -rf "$temp_dir"

    if [[ $exit_code -eq 0 ]]; then
        echo "✅ SSH connection successful"
    else
        echo "❌ SSH connection failed"
    fi

    return $exit_code
}

function analyze_build_logs() {
    local build_log="$1"

    echo "🔍 Analyzing Docker build logs for SSH issues"

    # Common SSH error patterns
    local error_patterns=(
        "Permission denied (publickey)"
        "Host key verification failed"
        "ssh: connect to host.*Connection refused"
        "git@.*: Permission denied"
        "fatal: Could not read from remote repository"
        "SSH_AUTH_SOCK"
        "ssh-agent"
    )

    for pattern in "${error_patterns[@]}"; do
        if grep -q "$pattern" "$build_log"; then
            echo "⚠️  Found SSH error pattern: $pattern"
            echo "📍 Context:"
            grep -n -A 2 -B 2 "$pattern" "$build_log" | head -10
            echo ""
        fi
    done

    # Check for BuildKit SSH mount issues
    if grep -q "mount.*ssh" "$build_log"; then
        echo "🔧 SSH mount usage detected"
        grep -n "mount.*ssh" "$build_log"
    fi
}

function validate_ssh_key_format() {
    local ssh_key="$1"

    echo "🔍 Validating SSH key format"

    if [[ ! -f "$ssh_key" ]]; then
        echo "❌ SSH key file not found: $ssh_key"
        return 1
    fi

    # Check file permissions
    local perms=$(stat -c "%a" "$ssh_key")
    if [[ "$perms" != "600" ]]; then
        echo "⚠️  SSH key permissions: $perms (should be 600)"
    fi

    # Validate key format
    if ssh-keygen -l -f "$ssh_key" >/dev/null 2>&1; then
        local fingerprint=$(ssh-keygen -l -f "$ssh_key")
        echo "✅ Valid SSH key: $fingerprint"
    else
        echo "❌ Invalid SSH key format"
        return 1
    fi

    # Check key type and size
    local key_info=$(ssh-keygen -l -f "$ssh_key")
    echo "📋 Key details: $key_info"

    if echo "$key_info" | grep -q "RSA" && echo "$key_info" | grep -qE "409[0-9]|[0-9]{4,}"; then
        echo "✅ Strong RSA key detected"
    elif echo "$key_info" | grep -q "ED25519"; then
        echo "✅ ED25519 key detected"
    else
        echo "⚠️  Consider using RSA 4096+ or ED25519 keys for better security"
    fi
}

function test_docker_buildkit_ssh() {
    echo "🔍 Testing Docker BuildKit SSH support"

    # Check Docker version
    local docker_version=$(docker version --format '{{.Server.Version}}')
    echo "Docker version: $docker_version"

    # Check BuildKit availability
    if docker buildx version >/dev/null 2>&1; then
        echo "✅ Docker BuildKit available"
        docker buildx version
    else
        echo "❌ Docker BuildKit not available"
        return 1
    fi

    # Test SSH mount capability
    local test_dockerfile=$(mktemp)
    cat > "$test_dockerfile" <<'EOF'
FROM alpine:latest
RUN --mount=type=ssh echo "SSH mount test successful"
EOF

    if DOCKER_BUILDKIT=1 docker build -f "$test_dockerfile" . >/dev/null 2>&1; then
        echo "✅ SSH mount support confirmed"
    else
        echo "❌ SSH mount support not available"
    fi

    rm -f "$test_dockerfile"
}

# Main execution
case "${1:-help}" in
    "test-connection")
        test_ssh_from_container "${2:-alpine/git}" "${3:-$HOME/.ssh/id_rsa}" "${4:-github.com}"
        ;;
    "analyze-logs")
        analyze_build_logs "${2:-build.log}"
        ;;
    "validate-key")
        validate_ssh_key_format "${2:-$HOME/.ssh/id_rsa}"
        ;;
    "test-buildkit")
        test_docker_buildkit_ssh
        ;;
    "full-diagnostic")
        echo "🩺 Running full SSH diagnostic suite"
        test_docker_buildkit_ssh
        validate_ssh_key_format "${2:-$HOME/.ssh/id_rsa}"
        test_ssh_from_container "alpine/git" "${2:-$HOME/.ssh/id_rsa}"
        ;;
    *)
        echo "Usage: $0 {test-connection|analyze-logs|validate-key|test-buildkit|full-diagnostic}"
        echo ""
        echo "Commands:"
        echo "  test-connection [image] [ssh-key] [host] - Test SSH from container"
        echo "  analyze-logs [log-file]                  - Analyze build logs for SSH issues"
        echo "  validate-key [ssh-key]                   - Validate SSH key format"
        echo "  test-buildkit                            - Test BuildKit SSH support"
        echo "  full-diagnostic [ssh-key]                - Run all diagnostics"
        ;;
esac
```

## Conclusion

Docker SSH identity management provides the foundation for secure, scalable containerized development workflows that meet enterprise security requirements while maintaining developer productivity. By implementing the patterns and strategies outlined in this guide, teams can build robust container build pipelines that handle multiple SSH identities, maintain security best practices, and scale across complex organizational structures.

The key to successful implementation lies in understanding the security model, properly managing secrets and key rotation, and designing build processes that gracefully handle different environments and authentication requirements. As your containerized infrastructure grows, these patterns provide a solid foundation for maintaining security and operational efficiency at scale.

Regular auditing, monitoring, and testing of SSH configurations ensures your containerized development environment remains secure and functional while supporting the diverse authentication needs of modern enterprise development teams.