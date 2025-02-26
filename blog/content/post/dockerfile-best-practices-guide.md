---
title: "Dockerfile Best Practices: A Comprehensive Guide for 2025"
date: 2025-05-30T09:00:00-06:00
draft: false
tags: ["Docker", "DevOps", "Containerization", "Best Practices", "Infrastructure", "Performance"]
categories:
- Docker
- DevOps
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "Master the art of writing efficient and secure Dockerfiles. Learn best practices for creating optimized container images, from layer caching to security considerations."
more_link: "yes"
url: "/dockerfile-best-practices-guide/"
---

Learn how to write efficient, secure, and maintainable Dockerfiles following industry best practices and proven patterns.

<!--more-->

# Dockerfile Best Practices Guide

## Core Principles

1. **Efficiency**
   - Minimize layer count
   - Optimize caching
   - Reduce image size

2. **Security**
   - Use specific versions
   - Run as non-root
   - Scan for vulnerabilities

3. **Maintainability**
   - Clear documentation
   - Consistent structure
   - Version control

## Base Image Selection

### 1. Use Official Images

```dockerfile
# Good
FROM python:3.12-slim

# Better (with specific version)
FROM python:3.12.1-slim@sha256:abcdef123...
```

### 2. Choose Minimal Base Images

```dockerfile
# Avoid
FROM ubuntu:latest

# Better
FROM alpine:3.19

# Even better for compiled applications
FROM gcr.io/distroless/static-debian11
```

## Optimizing Layer Caching

### 1. Order Instructions Properly

```dockerfile
# Bad - Changes to source invalidate dependency caching
COPY . /app
RUN pip install -r requirements.txt

# Good - Dependencies cached separately
COPY requirements.txt /app/
RUN pip install -r requirements.txt
COPY . /app
```

### 2. Combine Related Commands

```dockerfile
# Bad - Multiple layers
RUN apt-get update
RUN apt-get install -y python3
RUN apt-get install -y nodejs
RUN apt-get clean

# Good - Single layer
RUN apt-get update && \
    apt-get install -y \
        python3 \
        nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
```

## Security Best Practices

### 1. Run as Non-Root User

```dockerfile
# Create user and set permissions
RUN useradd -r -s /bin/false appuser && \
    mkdir /app && \
    chown appuser:appuser /app

# Switch to non-root user
USER appuser

WORKDIR /app
```

### 2. Use Multi-Stage Builds

```dockerfile
# Build stage
FROM golang:1.21 AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 go build -o myapp

# Final stage
FROM gcr.io/distroless/static-debian11
COPY --from=builder /app/myapp /
USER nonroot
ENTRYPOINT ["/myapp"]
```

## Environment Configuration

### 1. ARG vs ENV Usage

```dockerfile
# Build-time configuration
ARG VERSION=1.0.0
ARG BUILD_DATE

# Runtime environment variables
ENV APP_HOME=/app
ENV APP_PORT=8080

# Using ARG in ENV
ENV VERSION=${VERSION}
```

### 2. Default Configuration

```dockerfile
# Set defaults but allow override
ENV NODE_ENV=production
ENV PORT=3000

# Document exposed ports
EXPOSE ${PORT}
```

## Optimization Techniques

### 1. Layer Optimization

```dockerfile
# Optimize for cache efficiency
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
```

### 2. Size Optimization

```dockerfile
# Remove unnecessary files
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        package1 \
        package2 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
```

## Development vs Production

### 1. Development Configuration

```dockerfile
# development.Dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]
```

### 2. Production Configuration

```dockerfile
# production.Dockerfile
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:18-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN npm ci --only=production
CMD ["npm", "start"]
```

## Health Checks and Monitoring

### 1. Implement Health Checks

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s \
    CMD curl -f http://localhost/health || exit 1
```

### 2. Logging Configuration

```dockerfile
# Configure logging
ENV LOG_LEVEL=info
ENV LOG_FORMAT=json

# Volume for logs
VOLUME ["/var/log/app"]
```

## Documentation and Metadata

### 1. Use Labels

```dockerfile
LABEL maintainer="team@company.com"
LABEL version="1.0.0"
LABEL description="Application description"
LABEL org.opencontainers.image.source="https://github.com/org/repo"
```

### 2. Document Exposed Ports and Volumes

```dockerfile
# Document the ports that should be exposed
EXPOSE 8080 8081

# Document volumes
VOLUME ["/data", "/config"]
```

## Best Practices Checklist

1. **Base Image**
   - [ ] Use official images
   - [ ] Specify exact versions
   - [ ] Consider distroless for production

2. **Security**
   - [ ] Run as non-root
   - [ ] Scan for vulnerabilities
   - [ ] Minimize installed packages

3. **Efficiency**
   - [ ] Optimize layer caching
   - [ ] Minimize image size
   - [ ] Use multi-stage builds

4. **Maintainability**
   - [ ] Document with comments
   - [ ] Use meaningful labels
   - [ ] Maintain version control

Remember that Dockerfile optimization is an iterative process. Regularly review and update your Dockerfiles to incorporate new best practices and security improvements.
