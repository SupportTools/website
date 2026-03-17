---
title: "Go Module Proxies: Private Module Hosting with Athens and GOPROXY"
date: 2029-01-16T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Go Modules", "Athens", "GOPROXY", "Module Proxy", "Air-Gapped", "Private Registry"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying Athens as a private Go module proxy for enterprise environments, covering GOPROXY configuration, private module authentication, air-gapped builds, caching strategies, and Kubernetes deployment."
more_link: "yes"
url: "/go-module-proxies-athens-goproxy/"
---

Go module proxies solve two critical enterprise problems: ensuring build reproducibility by caching module content, and enabling builds in air-gapped or network-restricted environments. Athens is the leading open-source Go module proxy implementation, providing a full proxy protocol implementation with configurable storage backends, authentication, and fine-grained access control. This guide covers deploying Athens in production Kubernetes environments, configuring GOPROXY for private and public modules, and implementing authentication for private repositories.

<!--more-->

## Go Module Proxy Protocol

The Go module proxy protocol defines a simple HTTP API that `go` tooling consumes when fetching modules:

```
GET $GOPROXY/<module>/@v/list          # List available versions
GET $GOPROXY/<module>/@v/<version>.info  # Module version metadata
GET $GOPROXY/<module>/@v/<version>.mod   # go.mod file
GET $GOPROXY/<module>/@v/<version>.zip   # Module source zip
GET $GOPROXY/<module>/@latest           # Latest version info
```

The `GOPROXY` environment variable accepts a comma-separated list of proxy URLs and two special values:

- `direct`: Download directly from the VCS
- `off`: Disallow direct downloads (all modules must be in proxy)

```bash
# Example GOPROXY configurations

# Public modules via proxy.golang.org, fall back to direct, then fail
GOPROXY=https://proxy.golang.org,direct

# Enterprise: Athens for all modules, no fallback
GOPROXY=https://athens.corp.example.com

# Enterprise: Private modules via Athens, public via Go proxy
GOPROXY=https://athens.corp.example.com,https://proxy.golang.org,direct

# Air-gapped: Athens only, no external fallback
GOPROXY=https://athens.corp.example.com,off

# Module-path-specific routing (Go 1.22+)
GOPROXY=github.com/corp/*=https://athens.corp.example.com,\
        golang.org/*=https://proxy.golang.org,\
        *=https://proxy.golang.org,direct
```

## Athens Deployment on Kubernetes

### Prerequisites and Storage Backend

Athens supports multiple storage backends: disk, GCS, S3, Azure Blob, MongoDB, and MinIO. For production Kubernetes deployments, S3-compatible storage (AWS S3 or MinIO) provides the best balance of durability and operational simplicity.

```yaml
# athens/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: athens
  labels:
    app.kubernetes.io/name: athens
---
# athens/pvc.yaml (for disk-backed dev deployment only)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: athens-storage
  namespace: athens
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3
  resources:
    requests:
      storage: 100Gi
```

### Athens Configuration

```yaml
# athens/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: athens-config
  namespace: athens
data:
  config.toml: |
    # GoBinary is the path to the go binary Athens uses for operations
    GoBinary = "/usr/local/go/bin/go"

    # GoEnv controls the environment for go operations
    GoEnv = "development"

    # GoGetWorkers sets the number of parallel go get operations
    GoGetWorkers = 10

    # ProtocolWorkers is the number of workers serving proxy protocol requests
    ProtocolWorkers = 30

    # LogLevel: debug, info, warn, error
    LogLevel = "info"

    # LogFormat: text, json
    LogFormat = "json"

    # CloudRuntime: none, gcp, azure, aws
    CloudRuntime = "aws"

    # EnablePprof enables profiling endpoint /debug/pprof/
    EnablePprof = false

    # Storage backend: memory, disk, mongo, gcs, s3, azureblob, minio, external
    StorageType = "s3"

    [Storage]
      [Storage.S3]
        Region = "us-east-1"
        Bucket = "corp-go-modules"
        Prefix = "athens/"
        ForcePathStyle = false
        # Credentials via IAM role (recommended for EKS)
        UseDefaultConfiguration = true
        # CredentialsEndpoint = ""  # Optional: use custom endpoint

    # Upstream proxy for cache misses
    # Athens will fetch from this proxy if a module is not in its cache
    [Proxy]
      StorageType = "s3"
      # Redirect Athens to use the upstream when it doesn't have a module
      UpstreamProxy = {
        url = "https://proxy.golang.org"
        workers = 5
      }

    # Private module pattern exclusions (bypass upstream, must be in Athens)
    NoSumDBPatterns = [
      "github.com/corp/*",
      "gitlab.corp.example.com/*"
    ]

    # Sum database configuration
    # Set to "off" for fully air-gapped environments
    # SumDB = "off"
    SumDB = "sum.golang.org"

    # GoNoProxy: modules matched here bypass GOPROXY entirely
    # This is read by go tool when Athens passes it through
    GoNoProxy = "github.com/corp/*,gitlab.corp.example.com/*"

    # Authentication for private upstream VCS
    [AuthFilter]
      Enabled = true

    # Network access policies
    [NetworkMode]
      # strict: Only serve modules already in the cache (for air-gapped)
      # offline: Like strict but reads from disk cache
      # default: Fetch from upstream on cache miss
      # redirect: Redirect to upstream instead of proxying
      Strict = false

    # Timeout for upstream fetches
    Timeout = 300

    # Maximum module zip size (in MB)
    # MaxModuleZipSize = 50
```

### Athens Secret for VCS Authentication

```yaml
# athens/secret.yaml
# Store credentials for private VCS (GitHub/GitLab Enterprise)
apiVersion: v1
kind: Secret
metadata:
  name: athens-vcs-credentials
  namespace: athens
type: Opaque
stringData:
  netrc: |
    machine github.corp.example.com
      login go-bot
      password ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    machine gitlab.corp.example.com
      login go-build-bot
      password glpat-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
  # Git credentials for go get -d operations
  gitconfig: |
    [url "https://github.corp.example.com/"]
      insteadOf = ssh://git@github.corp.example.com/
    [url "https://gitlab.corp.example.com/"]
      insteadOf = git@gitlab.corp.example.com:
```

### Athens Deployment

```yaml
# athens/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: athens
  namespace: athens
  labels:
    app.kubernetes.io/name: athens
    app.kubernetes.io/version: v0.14.0
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: athens
  template:
    metadata:
      labels:
        app.kubernetes.io/name: athens
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3001"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: athens
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: athens
      containers:
        - name: athens
          image: gomods/athens:v0.14.0
          ports:
            - name: http
              containerPort: 3000
            - name: metrics
              containerPort: 3001
          env:
            - name: ATHENS_STORAGE_TYPE
              value: s3
            - name: AWS_REGION
              value: us-east-1
            - name: ATHENS_S3_BUCKET_NAME
              value: corp-go-modules
            - name: ATHENS_GOPATH
              value: /go
            - name: ATHENS_NETRC_PATH
              value: /home/athens/.netrc
            - name: ATHENS_GITCONFIG_PATH
              value: /home/athens/.gitconfig
            # GONOSUMCHECK for private modules
            - name: GONOSUMCHECK
              value: "github.com/corp/*,gitlab.corp.example.com/*"
            - name: GONOSUMDB
              value: "github.com/corp/*,gitlab.corp.example.com/*"
            - name: GOFLAGS
              value: "-mod=mod"
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /readyz
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          volumeMounts:
            - name: config
              mountPath: /config/athens
            - name: vcs-credentials
              mountPath: /home/athens
              readOnly: true
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            runAsGroup: 1000
            readOnlyRootFilesystem: false  # Athens needs to write temp files
            allowPrivilegeEscalation: false
      volumes:
        - name: config
          configMap:
            name: athens-config
        - name: vcs-credentials
          secret:
            secretName: athens-vcs-credentials
            defaultMode: 0400
---
apiVersion: v1
kind: Service
metadata:
  name: athens
  namespace: athens
spec:
  selector:
    app.kubernetes.io/name: athens
  ports:
    - name: http
      port: 443
      targetPort: 3000
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: athens
  namespace: athens
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-body-size: "256m"
    cert-manager.io/cluster-issuer: corp-internal-ca
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - athens.corp.example.com
      secretName: athens-tls
  rules:
    - host: athens.corp.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: athens
                port:
                  name: http
```

## Client-Side GOPROXY Configuration

### Developer Workstation Setup

```bash
# ~/.bashrc or ~/.zshrc for developers
export GOPROXY=https://athens.corp.example.com,https://proxy.golang.org,direct
export GONOSUMDB="github.com/corp/*,gitlab.corp.example.com/*"
export GONOSUMCHECK="github.com/corp/*,gitlab.corp.example.com/*"
export GOFLAGS="-mod=mod"

# For air-gapped environments (no external fallback)
export GOPROXY=https://athens.corp.example.com,off
export GONOSUMDB="*"
export GONOSUMCHECK="*"
export GOFLAGS="-mod=mod"

# Verify Athens is reachable
go env GOPROXY
curl -sf https://athens.corp.example.com/healthz && echo "Athens reachable"

# Test module fetch
GOMODCACHE=/tmp/test-modcache go get github.com/corp/internal-lib@v1.2.3
```

### CI/CD Pipeline Configuration

```yaml
# .github/workflows/build.yaml
name: Build and Test
on: [push, pull_request]
env:
  GOPROXY: https://athens.corp.example.com,https://proxy.golang.org,direct
  GONOSUMDB: "github.com/corp/*"
  GONOSUMCHECK: "github.com/corp/*"
  # Cache Go modules in CI using Athens as the source of truth
  GOMODCACHE: /home/runner/.cache/go/mod
jobs:
  test:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true
      - name: Download dependencies
        run: go mod download
      - name: Test
        run: go test -race ./...
```

### Pre-Populating Athens for Air-Gapped Builds

```bash
#!/usr/bin/env bash
# scripts/seed-athens.sh
# Pre-populate Athens cache with all direct and transitive dependencies
# Run this from a machine with internet access before deploying to air-gapped env

set -euo pipefail

ATHENS_URL="${ATHENS_URL:-https://athens.corp.example.com}"
REPO_DIR="${1:-.}"

cd "${REPO_DIR}"

echo "=== Seeding Athens at ${ATHENS_URL} ==="
echo "=== Collecting module graph ==="

# Get all dependencies including transitive
go mod graph | awk '{print $2}' | sort -u | while read -r mod; do
    module=$(echo "${mod}" | cut -d@ -f1)
    version=$(echo "${mod}" | cut -d@ -f2)

    echo "Seeding: ${module}@${version}"

    # Fetch via Athens to populate its cache
    GOMODCACHE=$(mktemp -d) \
    GOPROXY="${ATHENS_URL}" \
    GONOSUMDB="*" \
    go get "${module}@${version}" 2>/dev/null || true

    rm -rf "${GOMODCACHE}"
done

echo "=== Athens seeding complete ==="

# Verify key modules are cached
go mod graph | awk '{print $2}' | sort -u | head -5 | while read -r mod; do
    module=$(echo "${mod}" | cut -d@ -f1)
    version=$(echo "${mod}" | cut -d@ -f2)
    encoded_module=$(echo "${module}" | sed 's/[A-Z]/!\l&/g')
    status=$(curl -sf -o /dev/null -w "%{http_code}" \
        "${ATHENS_URL}/${encoded_module}/@v/${version}.info" || echo "000")
    echo "Cache status [${status}]: ${module}@${version}"
done
```

## Module Path Encoding

Athens and the Go proxy protocol require module path encoding (uppercase letters become `!` + lowercase). This is critical for constructing API calls directly.

```bash
# Module path encoding rules:
# Uppercase A-Z → !a to !z
# Example: github.com/BurntSushi/toml → github.com/!burnt!sushi/toml

encode_module_path() {
    local path="$1"
    echo "${path}" | python3 -c "
import sys, re
def encode(path):
    return re.sub(r'[A-Z]', lambda m: '!' + m.group().lower(), path)
print(encode(sys.stdin.read().strip()))
"
}

# Check if a specific module version is in Athens cache
check_module() {
    local module="$1"
    local version="$2"
    local encoded
    encoded=$(encode_module_path "${module}")

    response=$(curl -sf -o /dev/null -w "%{http_code}" \
        "https://athens.corp.example.com/${encoded}/@v/${version}.info")

    if [ "${response}" = "200" ]; then
        echo "CACHED: ${module}@${version}"
    else
        echo "MISSING (${response}): ${module}@${version}"
    fi
}

# Check all go.sum entries
while read -r module version _; do
    if [[ "${version}" != *"/go.mod" ]]; then
        check_module "${module}" "${version}"
    fi
done < go.sum | sort | uniq
```

## Private Module Access with GOAUTH

Go 1.22+ supports `GOAUTH` for authenticated module access:

```bash
# GOAUTH configuration for private GitHub Enterprise
# Uses a credential helper command
export GOAUTH="git:github.corp.example.com"

# .netrc-based authentication (most compatible)
cat >> ~/.netrc << 'EOF'
machine github.corp.example.com
  login go-build-bot
  password ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EOF
chmod 600 ~/.netrc

# Test private module access
GONOSUMDB="github.com/corp/*" \
go get github.com/corp/internal-payments-lib@v2.1.0
```

## Athens Metrics and Observability

```bash
# Key Prometheus metrics exposed by Athens
curl -s https://athens.corp.example.com/metrics | grep -E 'athens_'
# athens_proxy_cache_hit_total{module="github.com/gin-gonic/gin",version="v1.9.1"} 1523
# athens_proxy_cache_miss_total{module="github.com/jackc/pgx/v5",version="v5.6.0"} 3
# athens_proxy_http_requests_total{code="200",handler="/",method="GET"} 48291
# athens_proxy_storage_get_duration_seconds_bucket{...}
# athens_proxy_upstream_fetch_duration_seconds_bucket{...}
```

```yaml
# prometheus/rules/athens.yaml
groups:
  - name: athens_proxy
    rules:
      - alert: AthensHighCacheMissRate
        expr: |
          rate(athens_proxy_cache_miss_total[10m]) /
          (rate(athens_proxy_cache_hit_total[10m]) + rate(athens_proxy_cache_miss_total[10m]))
          > 0.20
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Athens cache miss rate above 20%"
          description: >
            Athens cache miss rate is {{ $value | humanizePercentage }}.
            This may indicate new modules being fetched or cache eviction.
            Seed the cache if running in air-gapped mode.

      - alert: AthensUpstreamFetchSlow
        expr: |
          histogram_quantile(0.95,
            rate(athens_proxy_upstream_fetch_duration_seconds_bucket[5m])
          ) > 30
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Athens upstream fetches taking > 30s at p95"
```

## Athens Access Control with OIDC

```toml
# Athens enterprise access control via OAuth2/OIDC
[AuthFilter]
  Enabled = true

[[AuthFilter.AllowedOrigins]]
  # Allow authenticated users from corporate SSO
  Audience = "athens.corp.example.com"
  Issuer = "https://sso.corp.example.com"
  ClientID = "athens-proxy"
  # Restrict to modules matching these patterns
  AllowedModules = ["*"]  # All modules (restrict per team as needed)
```

## Summary

Athens provides a robust, enterprise-grade Go module proxy implementation that addresses the key operational requirements of Go module management at scale:

- Use S3-compatible storage for Athens persistence; disk storage is unsuitable for multi-replica deployments
- Configure `GONOSUMDB` and `GONOSUMCHECK` for private modules to bypass the sum database
- Pre-seed Athens before deploying to air-gapped environments using the module graph approach
- Set `GOPROXY=https://athens.corp.example.com,off` in CI/CD for reproducible builds that never reach the internet
- Monitor cache miss rates to detect configuration issues or unexpected internet dependency
- Use `netrc`-based authentication for private VCS access; GOAUTH provides a more modern alternative in Go 1.22+

## Athens Module Exclusion and Bypass Rules

Not all modules should be routed through Athens. Configure exclusions for modules that must always be fetched directly:

```bash
# GONOSUMDB: Modules not verified against the sum database
# These should include your private org's modules
export GONOSUMDB="github.com/corp/*,gitlab.corp.example.com/*"

# GOPRIVATE: Convenience setting that sets both GONOSUMDB and GONOPROXY
export GOPRIVATE="github.com/corp/*,gitlab.corp.example.com/*"

# GONOPROXY: Modules that bypass the proxy entirely (fetched direct from VCS)
# Use when private modules should NEVER be uploaded to Athens storage
export GONOPROXY="github.com/corp/secrets-*,gitlab.corp.example.com/finance/*"

# GOFLAGS: Default flags for all go commands
export GOFLAGS="-mod=mod"

# Verify effective configuration
go env GOPRIVATE GONOSUMDB GONOPROXY GOFLAGS GOPROXY
```

## Vanity Import Paths

Many organizations use vanity import paths (e.g., `go.corp.example.com/mylib`) that redirect to actual Git repositories. Athens supports these via Go's module proxy protocol:

```nginx
# nginx vanity import path configuration
# go get go.corp.example.com/mylib resolves via HTML meta tag

server {
    listen 443 ssl;
    server_name go.corp.example.com;

    location /mylib {
        return 200 '<!DOCTYPE html>
<html>
<head>
<meta name="go-import" content="go.corp.example.com/mylib git https://github.corp.example.com/corp/mylib">
<meta name="go-source" content="go.corp.example.com/mylib _ https://github.corp.example.com/corp/mylib/tree/main{/dir} https://github.corp.example.com/corp/mylib/blob/main{/dir}/{file}#L{line}">
</head>
<body>go get go.corp.example.com/mylib</body>
</html>';
        add_header Content-Type text/html;
    }
}
```

```bash
# Usage with vanity import path
GOPROXY=https://athens.corp.example.com \
GONOSUMDB="go.corp.example.com/*" \
go get go.corp.example.com/mylib@v1.2.0
```

## Athens in Kubernetes with Horizontal Pod Autoscaler

For high-throughput environments where many CI runners fetch modules simultaneously:

```yaml
# athens/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: athens
  namespace: athens
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: athens
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
    - type: Pods
      pods:
        metric:
          name: athens_proxy_http_requests_per_second
        target:
          type: AverageValue
          averageValue: "50"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

## Module Deprecation and Retraction

Athens forwards module retraction information from `go.mod` files, enabling organizations to enforce deprecated module detection:

```bash
# Check if a module version is retracted
GOMODCACHE=/tmp/test-modcache \
GOPROXY=https://athens.corp.example.com \
go list -json -versions github.com/corp/internal-lib@v1.0.0 2>&1 | \
  jq '.Retracted // "not retracted"'

# List all retracted versions for a module
go list -json -m -versions github.com/corp/internal-lib | jq '.Retracted[]'

# In go.mod, retract problematic versions:
# retract (
#     v1.2.3  // Security vulnerability CVE-2029-12345
#     v1.2.4  // Regression in payment processing
# )
```

## Verifying Athens Cache Integrity

```bash
#!/usr/bin/env bash
# scripts/verify-athens-cache.sh
# Verify that all modules in go.sum are present in Athens

set -euo pipefail

ATHENS_URL="${ATHENS_URL:-https://athens.corp.example.com}"
MISSING=0

encode_module() {
    python3 -c "
import sys, re
path = sys.argv[1]
print(re.sub(r'([A-Z])', lambda m: '!' + m.group().lower(), path))
" "$1"
}

while read -r module version hash; do
    # Skip go.mod entries
    [[ "${version}" == *"/go.mod" ]] && continue

    encoded=$(encode_module "${module}")
    url="${ATHENS_URL}/${encoded}/@v/${version}.info"

    http_code=$(curl -sf -o /dev/null -w "%{http_code}" "${url}" 2>/dev/null || echo "000")
    if [ "${http_code}" != "200" ]; then
        echo "MISSING [${http_code}]: ${module}@${version}"
        MISSING=$((MISSING + 1))
    fi
done < go.sum

if [ "${MISSING}" -gt 0 ]; then
    echo ""
    echo "ERROR: ${MISSING} modules not found in Athens cache"
    echo "Run: go mod download to seed the cache"
    exit 1
fi

echo "All modules verified in Athens cache"
```
