---
title: "Harbor: Enterprise Container Registry on Kubernetes"
date: 2027-01-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Harbor", "Container Registry", "Security", "DevOps"]
categories: ["Kubernetes", "Security", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete production guide for deploying Harbor enterprise container registry on Kubernetes. Covers architecture, Helm deployment, project management, proxy cache, Trivy scanning, Cosign image signing, OIDC authentication, S3 storage backends, Gatekeeper admission control, replication, and monitoring."
more_link: "yes"
url: "/harbor-container-registry-kubernetes-production-guide/"
---

Pulling container images from Docker Hub in production environments introduces rate limiting, dependency on an external service, and no control over what gets cached or scanned. **Harbor** solves all three problems: it is a CNCF-graduated open-source registry that runs on Kubernetes, provides proxy caching for upstream registries, scans every image for CVEs with Trivy, enforces image signing with Cosign, and integrates with enterprise identity via OIDC and LDAP. This guide covers a full production deployment with S3-backed storage, multi-site replication, and Prometheus monitoring.

<!--more-->

## Executive Summary

**Harbor** is a cloud-native container registry built on top of the open-source distribution (formerly Docker Registry v2). The Harbor project adds a web UI, project-based access control, robot accounts for CI/CD pipelines, vulnerability scanning with Trivy, content trust with Notary/Cosign, proxy caching, and multi-site replication. Harbor runs comfortably on Kubernetes via its official Helm chart and integrates with cert-manager for TLS automation, external object storage for registry data, and Prometheus/Grafana for observability.

## Harbor Architecture

### Component Overview

```
          ┌───────────────────────────────────────────────────┐
          │                  Harbor Cluster                    │
          │                                                   │
  Pull/  │  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
  Push   │  │  Nginx   │  │   Core   │  │  Job Service  │  │
  ──────►│  │  Proxy   │  │  (API)   │  │  (async jobs) │  │
          │  └────┬─────┘  └────┬─────┘  └──────┬────────┘  │
          │       │              │               │           │
          │  ┌────▼─────────────▼───────────────▼────────┐  │
          │  │           Internal API Bus                  │  │
          │  └───┬────────────────────────────────────┬───┘  │
          │      │                                    │      │
          │  ┌───▼──────┐   ┌──────────┐   ┌────────▼───┐  │
          │  │ Registry │   │  Trivy   │   │  Notary /  │  │
          │  │(dist v2) │   │ Scanner  │   │  Cosign    │  │
          │  └───┬──────┘   └──────────┘   └────────────┘  │
          │      │                                          │
          │  ┌───▼──────────────────────────────────────┐  │
          │  │         Object Storage (S3/GCS/Azure)     │  │
          │  └──────────────────────────────────────────┘  │
          │  ┌──────────────────┐  ┌─────────────────────┐ │
          │  │   PostgreSQL     │  │       Redis         │ │
          │  └──────────────────┘  └─────────────────────┘ │
          └───────────────────────────────────────────────┘
```

### Core Components

| Component | Role |
|---|---|
| **Nginx Proxy** | Reverse proxy, TLS termination, request routing |
| **Core** | REST API, project/user management, RBAC enforcement |
| **Job Service** | Async operations: replication, GC, scan scheduling |
| **Registry** | OCI-compliant image push/pull using distribution spec |
| **Trivy** | CVE scanning of images on push and on schedule |
| **Notary** | Docker Content Trust (legacy) — Cosign is preferred |
| **Portal** | Single-page web UI (Angular) |
| **Exporter** | Prometheus metrics endpoint |

## Deploying Harbor with Helm

### Prerequisites

```bash
#!/bin/bash
# pre-install-harbor.sh

# Create namespace
kubectl create namespace harbor

# Create TLS secret (using cert-manager ClusterIssuer)
# cert-manager will auto-provision; we just need the annotation on the Ingress

# Create external secrets for Harbor admin password, secret key, etc.
kubectl create secret generic harbor-core-secret \
  --namespace harbor \
  --from-literal=secretKey="$(openssl rand -hex 16)" \
  --from-literal=CSRF_KEY="$(openssl rand -hex 16)"

kubectl create secret generic harbor-admin-secret \
  --namespace harbor \
  --from-literal=HARBOR_ADMIN_PASSWORD="ChangeMe-HarborAdmin123!"
```

### Helm Installation

```bash
#!/bin/bash
# install-harbor.sh

helm repo add harbor https://helm.goharbor.io
helm repo update

helm upgrade --install harbor harbor/harbor \
  --namespace harbor \
  --version 1.15.0 \
  --values harbor-values.yaml \
  --wait \
  --timeout 10m
```

### Production Helm Values

```yaml
# harbor-values.yaml
expose:
  type: ingress
  tls:
    enabled: true
    certSource: secret
    secret:
      secretName: harbor-tls
  ingress:
    hosts:
      core: harbor.example.com
    className: nginx
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
      nginx.ingress.kubernetes.io/ssl-redirect: "true"
      nginx.ingress.kubernetes.io/proxy-body-size: "0"
      nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
      nginx.ingress.kubernetes.io/proxy-send-timeout: "600"

externalURL: https://harbor.example.com

# Use external PostgreSQL and Redis for HA
database:
  type: external
  external:
    host: postgres.harbor.svc.cluster.local
    port: 5432
    username: harbor
    password: "EXAMPLE_DB_PASSWORD"
    coreDatabase: registry
    sslmode: require

redis:
  type: external
  external:
    addr: redis-master.harbor.svc.cluster.local:6379
    password: "EXAMPLE_REDIS_PASSWORD"

# S3 object storage for image layers
persistence:
  enabled: true
  resourcePolicy: keep
  imageChartStorage:
    disableredirect: false
    type: s3
    s3:
      region: us-east-1
      bucket: harbor-registry-prod
      # IRSA/workload identity recommended over access keys
      # accesskey and secretkey left empty when using IRSA
      rootdirectory: /harbor
      encrypt: true
      # Force path-style for non-AWS S3-compatible storage
      forcepathstyle: false

# Harbor core
core:
  replicas: 2
  revisionHistoryLimit: 3
  startupProbe:
    enabled: true
    initialDelaySeconds: 10
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 2000m
      memory: 2Gi
  existingSecret: harbor-core-secret
  secretName: harbor-core-secret

# Job service
jobservice:
  replicas: 2
  maxJobWorkers: 20
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 1000m
      memory: 1Gi

# Registry
registry:
  replicas: 2
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 2000m
      memory: 4Gi
  upload_purging:
    enabled: true
    age: 168h
    interval: 24h
    dryrun: false
  relativeurls: false

# Trivy scanner
trivy:
  enabled: true
  replicas: 1
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 4Gi
  # Use offline DB update if pulling from internet is restricted
  offlineScan: false
  ignoreUnfixed: false
  insecure: false
  githubToken: ""   # Set if GitHub rate limiting affects DB update
  skipUpdate: false
  timeout: 5m0s
  vulnType: "os,library"
  severity: "CRITICAL,HIGH,MEDIUM,LOW,UNKNOWN"

# Notary — disabled in favor of Cosign
notary:
  enabled: false

portal:
  replicas: 2
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 500m
      memory: 256Mi

exporter:
  replicas: 1
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 500m
      memory: 256Mi

# Harbor admin credentials (initial setup only)
harborAdminPassword: "EXAMPLE_ADMIN_PASSWORD_CHANGE_AFTER_INSTALL"

# Metrics
metrics:
  enabled: true
  core:
    path: /metrics
    port: 8001
  registry:
    path: /metrics
    port: 8001
  exporter:
    path: /metrics
    port: 8001
```

### IAM Role for S3 (IRSA)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": "arn:aws:s3:::harbor-registry-prod"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:AbortMultipartUpload",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:ListMultipartUploadParts",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::harbor-registry-prod/*"
    }
  ]
}
```

Annotate the Harbor service accounts to use IRSA:

```yaml
# harbor-irsa-patch.yaml
# Patch core, registry, and jobservice service accounts
apiVersion: v1
kind: ServiceAccount
metadata:
  name: harbor
  namespace: harbor
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::111122223333:role/HarborS3Role
```

## Project and User Management

### Project Structure

Harbor uses **projects** as the unit of access control, storage quota, and policy. Each project contains repositories (images) and can be configured independently.

```bash
#!/bin/bash
# harbor-project-setup.sh
HARBOR_URL="https://harbor.example.com"
HARBOR_USER="admin"
HARBOR_PASS="EXAMPLE_ADMIN_PASSWORD"

# Create a project
create_project() {
  local name="$1"
  local public="$2"
  curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
    -H "Content-Type: application/json" \
    -X POST "${HARBOR_URL}/api/v2.0/projects" \
    -d "{
      \"project_name\": \"${name}\",
      \"public\": ${public},
      \"metadata\": {
        \"enable_content_trust\": \"true\",
        \"prevent_vul\": \"true\",
        \"severity\": \"high\",
        \"auto_scan\": \"true\",
        \"reuse_sys_cve_allowlist\": \"false\"
      },
      \"storage_limit\": -1
    }"
}

create_project "platform"     false
create_project "applications" false
create_project "base-images"  false
create_project "public-cache" true

echo "Projects created."
```

### Robot Accounts for CI/CD

```bash
#!/bin/bash
# create-robot-account.sh

HARBOR_URL="https://harbor.example.com"
HARBOR_USER="admin"
HARBOR_PASS="EXAMPLE_ADMIN_PASSWORD"

# Create a project-level robot account for CI
curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -H "Content-Type: application/json" \
  -X POST "${HARBOR_URL}/api/v2.0/projects/applications/robots" \
  -d '{
    "name": "ci-pipeline",
    "description": "CI pipeline robot for applications project",
    "disable": false,
    "duration": -1,
    "permissions": [{
      "kind": "project",
      "namespace": "applications",
      "access": [
        {"resource": "repository", "action": "pull"},
        {"resource": "repository", "action": "push"},
        {"resource": "artifact", "action": "delete"},
        {"resource": "tag", "action": "create"},
        {"resource": "tag", "action": "delete"},
        {"resource": "scan", "action": "create"}
      ]
    }]
  }' | python3 -m json.tool

# System-level robot with cross-project access
curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -H "Content-Type: application/json" \
  -X POST "${HARBOR_URL}/api/v2.0/robots" \
  -d '{
    "name": "replication-robot",
    "description": "Cross-project replication service account",
    "disable": false,
    "duration": -1,
    "level": "system",
    "permissions": [
      {
        "kind": "project",
        "namespace": "applications",
        "access": [{"resource": "repository", "action": "pull"}]
      },
      {
        "kind": "project",
        "namespace": "platform",
        "access": [{"resource": "repository", "action": "pull"}]
      }
    ]
  }' | python3 -m json.tool
```

## Proxy Cache Registry

Harbor's proxy cache feature pulls images from upstream registries on-demand and caches them locally. This eliminates Docker Hub rate limits and provides an air-gapped fallback.

```bash
#!/bin/bash
# setup-proxy-cache.sh

HARBOR_URL="https://harbor.example.com"
HARBOR_USER="admin"
HARBOR_PASS="EXAMPLE_ADMIN_PASSWORD"

# Create proxy cache endpoint for Docker Hub
curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -H "Content-Type: application/json" \
  -X POST "${HARBOR_URL}/api/v2.0/registries" \
  -d '{
    "name": "docker-hub",
    "type": "docker-hub",
    "url": "https://hub.docker.com",
    "description": "Docker Hub proxy cache",
    "insecure": false
  }'

REGISTRY_ID=$(curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
  "${HARBOR_URL}/api/v2.0/registries?name=docker-hub" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")

# Create proxy cache project
curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -H "Content-Type: application/json" \
  -X POST "${HARBOR_URL}/api/v2.0/projects" \
  -d "{
    \"project_name\": \"dockerhub-cache\",
    \"registry_id\": ${REGISTRY_ID},
    \"public\": false,
    \"metadata\": {
      \"proxy_speed_kb\": \"-1\"
    }
  }"

echo "Proxy cache configured."
echo "Pull via: harbor.example.com/dockerhub-cache/library/nginx:1.25"

# Create proxy caches for other registries
for registry_config in \
  "quay-io|quay|https://quay.io|quay-cache" \
  "gcr-io|google-gcr|https://gcr.io|gcr-cache" \
  "ghcr-io|github|https://ghcr.io|ghcr-cache"; do
  name=$(echo $registry_config | cut -d'|' -f1)
  type=$(echo $registry_config | cut -d'|' -f2)
  url=$(echo $registry_config | cut -d'|' -f3)
  project=$(echo $registry_config | cut -d'|' -f4)

  curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
    -H "Content-Type: application/json" \
    -X POST "${HARBOR_URL}/api/v2.0/registries" \
    -d "{\"name\":\"${name}\",\"type\":\"${type}\",\"url\":\"${url}\",\"insecure\":false}"
done
```

### Using Proxy Cache in Kubernetes

```yaml
# imagePullSecrets must include harbor credentials
# Update image references in manifests:
containers:
- name: app
  # Old:  nginx:1.25
  # New (via Harbor proxy cache):
  image: harbor.example.com/dockerhub-cache/library/nginx:1.25
```

## Vulnerability Scanning with Trivy

### Scan on Push and Schedule

```bash
#!/bin/bash
# configure-scanning.sh

HARBOR_URL="https://harbor.example.com"
HARBOR_USER="admin"
HARBOR_PASS="EXAMPLE_ADMIN_PASSWORD"

# Enable auto-scan on push for a project
curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -H "Content-Type: application/json" \
  -X PUT "${HARBOR_URL}/api/v2.0/projects/applications" \
  -d '{
    "metadata": {
      "auto_scan": "true",
      "prevent_vul": "true",
      "severity": "critical",
      "enable_content_trust": "true"
    }
  }'

# Create scan schedule (daily at 02:00)
curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -H "Content-Type: application/json" \
  -X POST "${HARBOR_URL}/api/v2.0/system/scanAll/schedule" \
  -d '{
    "schedule": {
      "type": "Custom",
      "cron": "0 0 2 * * *"
    }
  }'

# Update Trivy DB
curl -s -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -X POST "${HARBOR_URL}/api/v2.0/system/scanners/all/metadata" \
  -d '{}'

echo "Scanning configured."
```

### CVE Allowlist

```bash
#!/bin/bash
# Add CVEs to system-level allowlist (when mitigated externally)

curl -s -u "admin:EXAMPLE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -X PUT "https://harbor.example.com/api/v2.0/system/CVEAllowlist" \
  -d '{
    "expires_at": 0,
    "items": [
      {"cve_id": "CVE-2021-44228"},
      {"cve_id": "CVE-2022-0847"}
    ]
  }'
```

## Image Signing with Cosign

### Sign Images in CI Pipeline

```bash
#!/bin/bash
# sign-image-cosign.sh
# Run in CI after docker push

IMAGE="harbor.example.com/applications/myapp:v1.2.3"
IMAGE_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' ${IMAGE})

# Sign using keyless (Sigstore) — requires OIDC token from CI
cosign sign \
  --yes \
  "${IMAGE_DIGEST}"

# Sign with a static key (air-gapped environments)
cosign sign \
  --key cosign.key \
  --yes \
  "${IMAGE_DIGEST}"

# Verify signature
cosign verify \
  --key cosign.pub \
  "${IMAGE_DIGEST}"

# Attach SBOM
syft "${IMAGE}" -o spdx-json > sbom.json
cosign attach sbom --sbom sbom.json "${IMAGE_DIGEST}"
cosign sign --attachment sbom "${IMAGE_DIGEST}" --key cosign.key --yes
```

### Harbor Cosign Integration (Notary v2)

Harbor 2.6+ natively supports Cosign signatures via the Notation/Cosign integration. Enable signature verification in project settings:

```bash
# Enable content trust for a project via API
curl -s -u "admin:EXAMPLE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -X PUT "https://harbor.example.com/api/v2.0/projects/applications" \
  -d '{
    "metadata": {
      "enable_content_trust_cosign": "true",
      "prevent_vul": "true",
      "severity": "high"
    }
  }'
```

## OIDC and LDAP Authentication

### OIDC Integration with Dex

```bash
#!/bin/bash
# configure-harbor-oidc.sh

curl -s -u "admin:EXAMPLE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -X PUT "https://harbor.example.com/api/v2.0/configurations" \
  -d '{
    "auth_mode": "oidc_auth",
    "oidc_name": "Dex",
    "oidc_endpoint": "https://dex.example.com",
    "oidc_client_id": "harbor",
    "oidc_client_secret": "EXAMPLE_HARBOR_CLIENT_SECRET",
    "oidc_groups_claim": "groups",
    "oidc_scope": "openid,profile,email,groups",
    "oidc_verify_cert": true,
    "oidc_auto_onboard": true,
    "oidc_user_claim": "email"
  }'
```

### LDAP Authentication

```bash
#!/bin/bash
# configure-harbor-ldap.sh

curl -s -u "admin:EXAMPLE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -X PUT "https://harbor.example.com/api/v2.0/configurations" \
  -d '{
    "auth_mode": "ldap_auth",
    "ldap_url": "ldaps://ldap.example.com:636",
    "ldap_base_dn": "dc=example,dc=com",
    "ldap_search_dn": "CN=svc-harbor,OU=ServiceAccounts,DC=example,DC=com",
    "ldap_search_password": "EXAMPLE_LDAP_PASSWORD",
    "ldap_uid": "sAMAccountName",
    "ldap_filter": "(objectClass=person)",
    "ldap_scope": 2,
    "ldap_timeout": 5,
    "ldap_verify_cert": true,
    "ldap_group_base_dn": "OU=Groups,DC=example,DC=com",
    "ldap_group_attribute_name": "cn",
    "ldap_group_search_filter": "(objectClass=group)",
    "ldap_group_search_scope": 2
  }'
```

## Replication Rules — Multi-Site

```bash
#!/bin/bash
# configure-replication.sh

HARBOR_PRIMARY="https://harbor-us.example.com"
HARBOR_AUTH="admin:EXAMPLE_ADMIN_PASSWORD"

# Register remote registry
curl -s -u "${HARBOR_AUTH}" \
  -H "Content-Type: application/json" \
  -X POST "${HARBOR_PRIMARY}/api/v2.0/registries" \
  -d '{
    "name": "harbor-eu",
    "type": "harbor",
    "url": "https://harbor-eu.example.com",
    "credential": {
      "type": "basic",
      "access_key": "replication-bot",
      "access_secret": "EXAMPLE_REPLICATION_SECRET"
    },
    "insecure": false,
    "description": "EU Harbor instance"
  }'

REMOTE_ID=$(curl -s -u "${HARBOR_AUTH}" \
  "${HARBOR_PRIMARY}/api/v2.0/registries?name=harbor-eu" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")

# Create push replication rule (push on event)
curl -s -u "${HARBOR_AUTH}" \
  -H "Content-Type: application/json" \
  -X POST "${HARBOR_PRIMARY}/api/v2.0/replicationPolicies" \
  -d "{
    \"name\": \"push-to-harbor-eu\",
    \"description\": \"Replicate applications project to EU\",
    \"src_registry\": null,
    \"dest_registry\": {\"id\": ${REMOTE_ID}},
    \"dest_namespace\": \"applications\",
    \"filters\": [
      {\"type\": \"name\", \"value\": \"applications/**\"},
      {\"type\": \"tag\", \"value\": \"v*\"},
      {\"type\": \"label\", \"value\": \"replicate=true\"}
    ],
    \"trigger\": {
      \"type\": \"event_based\",
      \"trigger_settings\": {\"cron\": \"\"}
    },
    \"enabled\": true,
    \"deletion\": false,
    \"override\": true,
    \"copy_by_chunk\": false,
    \"speed\": -1
  }"

echo "Replication rule created."
```

## Admission Control with Gatekeeper

Enforce that pods only pull from Harbor and only use images with no CRITICAL vulnerabilities:

```yaml
# harbor-gatekeeper-policies.yaml
---
# ConstraintTemplate: require images from approved registries
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requiredregistries
spec:
  crd:
    spec:
      names:
        kind: RequiredRegistries
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedRegistries:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package requiredregistries

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not starts_with_allowed(container.image)
        msg := sprintf("Container %v uses image %v which is not from an approved registry", [container.name, container.image])
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.initContainers[_]
        not starts_with_allowed(container.image)
        msg := sprintf("Init container %v uses image %v which is not from an approved registry", [container.name, container.image])
      }

      starts_with_allowed(image) {
        registry := input.parameters.allowedRegistries[_]
        startswith(image, registry)
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequiredRegistries
metadata:
  name: require-harbor
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    - apiGroups: ["batch"]
      kinds: ["Job", "CronJob"]
    namespaces:
    - production
    - staging
  parameters:
    allowedRegistries:
    - "harbor.example.com/"
    - "registry.k8s.io/"    # Allow official k8s images
```

## Garbage Collection

```bash
#!/bin/bash
# Schedule GC via API

curl -s -u "admin:EXAMPLE_ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -X POST "https://harbor.example.com/api/v2.0/system/gc/schedule" \
  -d '{
    "schedule": {
      "type": "Custom",
      "cron": "0 0 3 * * *"
    },
    "parameters": {
      "delete_untagged": true,
      "workers": 4
    }
  }'

# Check GC history
curl -s -u "admin:EXAMPLE_ADMIN_PASSWORD" \
  "https://harbor.example.com/api/v2.0/system/gc?page=1&page_size=10" | \
  python3 -m json.tool
```

## Monitoring

### Prometheus ServiceMonitor and Alerts

```yaml
# harbor-monitoring.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: harbor
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: harbor
      component: exporter
  namespaceSelector:
    matchNames:
    - harbor
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: harbor-alerts
  namespace: monitoring
spec:
  groups:
  - name: harbor.availability
    interval: 30s
    rules:
    - alert: HarborCoreDown
      expr: up{job="harbor-exporter"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Harbor registry is unreachable"

    - alert: HarborHighCVEImages
      expr: harbor_artifact_vulnerability_count{severity="Critical"} > 0
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Harbor project {{ $labels.project_name }} has critical CVE images"
        description: "{{ $value }} images with CRITICAL vulnerabilities in {{ $labels.repository_name }}"

    - alert: HarborReplicationFailing
      expr: |
        increase(harbor_replication_executions_total{status="Failed"}[30m]) > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Harbor replication failures detected"
        description: "Policy {{ $labels.policy_name }} has failed replication executions."

    - alert: HarborStorageUsageHigh
      expr: |
        harbor_project_quota_usage_byte / harbor_project_quota_byte > 0.85
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Harbor project {{ $labels.project_name }} storage usage above 85%"

    - alert: HarborScanQueueBacklog
      expr: harbor_scanner_queue_size > 50
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Harbor Trivy scan queue backlog"
        description: "{{ $value }} images waiting to be scanned."
```

## Operational Runbook

```bash
#!/bin/bash
# harbor-ops.sh

HARBOR_URL="https://harbor.example.com"
HARBOR_AUTH="admin:EXAMPLE_ADMIN_PASSWORD"

echo "=== Harbor Health Check ==="
curl -s -u "${HARBOR_AUTH}" "${HARBOR_URL}/api/v2.0/health" | python3 -m json.tool

echo ""
echo "=== Registry Statistics ==="
curl -s -u "${HARBOR_AUTH}" "${HARBOR_URL}/api/v2.0/statistics" | python3 -m json.tool

echo ""
echo "=== Active Replications ==="
curl -s -u "${HARBOR_AUTH}" \
  "${HARBOR_URL}/api/v2.0/replicationExecutions?status=InProgress" | \
  python3 -m json.tool

echo ""
echo "=== Pending Scan Jobs ==="
curl -s -u "${HARBOR_AUTH}" "${HARBOR_URL}/api/v2.0/scans/all/metrics" | \
  python3 -m json.tool

echo ""
echo "=== Harbor Pod Status ==="
kubectl get pods -n harbor -o wide

echo ""
echo "=== Harbor PVC Status ==="
kubectl get pvc -n harbor
```

## Conclusion

Harbor provides a complete enterprise container registry platform that reduces external dependency risk, centralizes image security policy, and integrates with every tier of the Kubernetes supply chain. Critical production recommendations:

- Back image storage with S3 using IRSA to avoid static credentials and benefit from S3 durability
- Enable auto-scan on push and configure `prevent_vul: true` with a `severity: high` threshold for production projects
- Deploy robot accounts per pipeline, not shared credentials, to enable revocation without disruption
- Schedule daily Trivy DB updates and GC during off-peak hours (02:00–04:00)
- Configure replication rules with `event_based` trigger for active-active multi-site deployments
- Monitor `harbor_artifact_vulnerability_count` and set alert thresholds appropriate to the team's remediation SLA
