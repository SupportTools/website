---
title: "Zot OCI Registry: Lightweight Container Registry with Built-in Supply Chain Security"
date: 2027-01-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OCI Registry", "Zot", "Supply Chain Security", "Sigstore"]
categories:
- Security
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for deploying Zot OCI registry on Kubernetes with S3 storage, authentication, Cosign signature storage, SBOM attachment, and air-gapped image sync workflows."
more_link: "yes"
url: "/zot-oci-registry-sigstore-kubernetes-supply-chain-guide/"
---

**Zot** is a fully OCI-spec-compliant container registry purpose-built for simplicity, security, and supply chain integrity. Unlike Harbor, which requires half a dozen microservices, a separate Redis instance, and a PostgreSQL database just to reach a functional state, Zot ships as a single Go binary with an embedded database. It natively stores Cosign signatures, SBOMs, and attestations as OCI referrers — no external signing infrastructure bolt-ons required. This guide covers a production Kubernetes deployment with S3 storage, LDAP authentication, Cosign signature workflows, and air-gapped image sync.

<!--more-->

## Zot vs Harbor for Lightweight Deployments

| Dimension | Zot | Harbor |
|-----------|-----|--------|
| Architecture | Single binary | 8+ microservices |
| Database | Embedded (bbolt) | PostgreSQL + Redis |
| Memory footprint (idle) | ~50 MB | 1–2 GB |
| OCI Referrers API | Native | v2.10+ |
| Cosign/Notation storage | Native OCI referrers | Plugin |
| SBOM storage | Native OCI referrers | Plugin |
| Web UI | Basic | Full-featured |
| RBAC granularity | Policy-based | Role-based |
| Multi-tenancy | Namespace policies | Projects |
| Replication | Built-in sync | Built-in |
| Vulnerability scanning | Plugin (Trivy) | Built-in (Trivy) |
| Air-gap image sync | `zli image sync` | Replication policies |

Harbor remains the better choice for organizations that need a full-featured UI, deep Kubernetes integration with Notary v2, and enterprise RBAC. For teams deploying registries in air-gapped clusters, edge locations, or CI environments where minimal footprint matters, Zot is the right tool.

## Architecture Overview

```
┌────────────────────────────────────────────────────────┐
│                      Zot Process                       │
│                                                        │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ OCI HTTP   │  │ Auth Engine  │  │  Extension API │  │
│  │ API v2     │  │ (htpasswd /  │  │  (metrics,     │  │
│  │            │  │  LDAP /      │  │   search,      │  │
│  │            │  │  bearer)     │  │   scrub,       │  │
│  └─────┬──────┘  └──────────────┘  │   sync)        │  │
│        │                           └────────────────┘  │
│        ▼                                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Storage Driver                     │   │
│  │   filesystem  │  S3  │  Azure Blob              │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
         │                     │
   OCI Blobs              Referrers
   (layers, configs)      (Cosign sigs,
                           SBOMs, attest)
```

## Deploying Zot on Kubernetes

### ConfigMap: zot Configuration

```yaml
# zot-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: zot-config
  namespace: registry
data:
  config.json: |
    {
      "distSpecVersion": "1.1.0",
      "storage": {
        "rootDirectory": "/var/lib/registry",
        "storageDriver": {
          "name": "s3",
          "region": "us-east-1",
          "bucket": "zot-registry-prod",
          "regionEndpoint": "",
          "forcepathstyle": false,
          "skipverify": false,
          "encrypt": true
        },
        "cacheDriver": {
          "name": "boltdb",
          "parameters": {
            "rootDir": "/var/cache/zot"
          }
        },
        "gc": true,
        "gcDelay": "1h",
        "gcInterval": "6h",
        "dedupe": true,
        "commit": true
      },
      "http": {
        "address": "0.0.0.0",
        "port": "5000",
        "realm": "zot",
        "tls": {
          "cert": "/etc/zot/tls/tls.crt",
          "key": "/etc/zot/tls/tls.key"
        }
      },
      "log": {
        "level": "info",
        "audit": "/var/log/zot/audit.log"
      },
      "extensions": {
        "metrics": {
          "enable": true,
          "prometheus": {
            "path": "/metrics"
          }
        },
        "search": {
          "enable": true,
          "cve": {
            "updateInterval": "24h"
          }
        },
        "scrub": {
          "enable": true,
          "interval": "24h"
        },
        "sync": {
          "enable": true,
          "credentialsFile": "/etc/zot/sync-credentials.json",
          "registries": []
        },
        "ui": {
          "enable": true
        }
      },
      "accessControl": {
        "repositories": {
          "**": {
            "defaultPolicy": [],
            "anonymousPolicy": []
          }
        },
        "adminPolicy": {
          "users": ["admin"],
          "actions": ["read", "create", "update", "delete"]
        },
        "groups": {
          "developers": {
            "users": []
          },
          "readonly": {
            "users": []
          }
        }
      },
      "auth": {
        "htpasswd": {
          "path": "/etc/zot/htpasswd"
        },
        "ldap": {
          "address": "ldap.internal.example.com",
          "port": 389,
          "startTLS": true,
          "baseDN": "ou=users,dc=internal,dc=example,dc=com",
          "userAttribute": "uid",
          "bindDN": "cn=zot-bind,ou=service-accounts,dc=internal,dc=example,dc=com",
          "bindPassword": "LDAP_BIND_PASSWORD_ENV",
          "searchFilter": "(&(objectClass=person)(uid=%s))",
          "groupSearch": {
            "base": "ou=groups,dc=internal,dc=example,dc=com",
            "filter": "(member=%s)",
            "groupAttribute": "cn"
          }
        },
        "bearer": {
          "realm": "https://registry.internal.example.com/auth/token",
          "service": "registry.internal.example.com",
          "cert": "/etc/zot/tls/ca.crt"
        }
      }
    }
```

### Deployment Manifest

```yaml
# zot-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zot
  namespace: registry
  labels:
    app.kubernetes.io/name: zot
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: zot
  template:
    metadata:
      labels:
        app.kubernetes.io/name: zot
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "5000"
        prometheus.io/path: "/metrics"
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      serviceAccountName: zot
      containers:
        - name: zot
          image: ghcr.io/project-zot/zot-linux-amd64:v2.1.0
          args:
            - serve
            - /etc/zot/config.json
          env:
            - name: AWS_REGION
              value: us-east-1
            - name: AWS_ACCESS_KEY_ID
              valueFrom:
                secretKeyRef:
                  name: zot-s3-credentials
                  key: access_key_id
            - name: AWS_SECRET_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: zot-s3-credentials
                  key: secret_access_key
            - name: LDAP_BIND_PASSWORD_ENV
              valueFrom:
                secretKeyRef:
                  name: zot-ldap-credentials
                  key: bind_password
          ports:
            - name: registry
              containerPort: 5000
          readinessProbe:
            httpGet:
              path: /v2/
              port: 5000
              scheme: HTTPS
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /v2/
              port: 5000
              scheme: HTTPS
            initialDelaySeconds: 30
            periodSeconds: 15
          volumeMounts:
            - name: config
              mountPath: /etc/zot
              readOnly: true
            - name: tls
              mountPath: /etc/zot/tls
              readOnly: true
            - name: htpasswd
              mountPath: /etc/zot/htpasswd
              subPath: htpasswd
              readOnly: true
            - name: cache
              mountPath: /var/cache/zot
            - name: audit-log
              mountPath: /var/log/zot
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "2"
              memory: 1Gi
      volumes:
        - name: config
          configMap:
            name: zot-config
        - name: tls
          secret:
            secretName: zot-tls
        - name: htpasswd
          secret:
            secretName: zot-htpasswd
        - name: cache
          emptyDir:
            sizeLimit: 5Gi
        - name: audit-log
          emptyDir:
            sizeLimit: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: zot
  namespace: registry
  labels:
    app.kubernetes.io/name: zot
spec:
  selector:
    app.kubernetes.io/name: zot
  ports:
    - name: registry
      port: 443
      targetPort: 5000
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: zot
  namespace: registry
  annotations:
    cert-manager.io/cluster-issuer: internal-ca
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - registry.internal.example.com
      secretName: zot-tls
  rules:
    - host: registry.internal.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: zot
                port:
                  number: 443
```

### htpasswd Authentication Setup

```bash
# Generate htpasswd file (bcrypt)
kubectl create namespace registry

# Create admin credentials
htpasswd -Bc /tmp/htpasswd admin
# Enter password when prompted

# Add service account credentials for CI
htpasswd -B /tmp/htpasswd ci-push

# Store as secret
kubectl create secret generic zot-htpasswd \
  --namespace registry \
  --from-file=htpasswd=/tmp/htpasswd

rm /tmp/htpasswd
```

### Access Control Policy Configuration

```json
{
  "accessControl": {
    "repositories": {
      "**": {
        "defaultPolicy": ["read"],
        "anonymousPolicy": []
      },
      "internal/**": {
        "defaultPolicy": [],
        "anonymousPolicy": [],
        "policies": [
          {
            "users": ["ci-push"],
            "actions": ["read", "create", "update"]
          },
          {
            "groups": ["developers"],
            "actions": ["read"]
          }
        ]
      },
      "mirrors/**": {
        "defaultPolicy": ["read"],
        "anonymousPolicy": [],
        "policies": [
          {
            "users": ["mirror-sync"],
            "actions": ["read", "create", "update", "delete"]
          }
        ]
      }
    },
    "adminPolicy": {
      "users": ["admin"],
      "actions": ["read", "create", "update", "delete"]
    }
  }
}
```

## S3 Storage Backend Configuration

```bash
# Create S3 bucket with versioning and lifecycle
aws s3api create-bucket \
  --bucket zot-registry-prod \
  --region us-east-1 \
  --create-bucket-configuration LocationConstraint=us-east-1

aws s3api put-bucket-versioning \
  --bucket zot-registry-prod \
  --versioning-configuration Status=Enabled

# Lifecycle policy to delete old versions after 30 days
aws s3api put-bucket-lifecycle-configuration \
  --bucket zot-registry-prod \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "delete-old-versions",
      "Status": "Enabled",
      "NoncurrentVersionExpiration": {"NoncurrentDays": 30},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}
    }]
  }'

# Bucket policy for zot IAM user
aws s3api put-bucket-policy \
  --bucket zot-registry-prod \
  --policy '{
    "Version": "2012-10-17",
    "Statement": [{
      "Sid": "ZotRegistryAccess",
      "Effect": "Allow",
      "Principal": {"AWS": "arn:aws:iam::123456789012:user/zot-registry"},
      "Action": [
        "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
        "s3:ListBucket", "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:iam::123456789012:zot-registry-prod",
        "arn:aws:iam::123456789012:zot-registry-prod/*"
      ]
    }]
  }'
```

## Cosign Signature Storage via OCI Referrers

Cosign v2 stores signatures as **OCI referrers** — they are attached to the image manifest via the `referrers` API. Zot's native support for the OCI Referrers API means signatures and SBOMs are stored and retrievable without any external infrastructure.

### Signing Images with Cosign

```bash
# Generate a signing key pair
cosign generate-key-pair \
  --output-key-prefix cosign-signing-key

kubectl create secret generic cosign-signing-key \
  --namespace ci \
  --from-file=cosign.key=cosign-signing-key.key \
  --from-file=cosign.pub=cosign-signing-key.pub

# Sign an image (stores signature as OCI referrer in Zot)
REGISTRY="registry.internal.example.com"
IMAGE_REF="${REGISTRY}/internal/app:v1.2.3"
IMAGE_DIGEST=$(crane digest ${IMAGE_REF})

cosign sign \
  --key cosign-signing-key.key \
  --tlog-upload=false \
  "${REGISTRY}/internal/app@${IMAGE_DIGEST}"

# Verify the signature
cosign verify \
  --key cosign-signing-key.pub \
  --insecure-ignore-tlog \
  "${REGISTRY}/internal/app@${IMAGE_DIGEST}"
```

### Automated Signing in CI

```yaml
# .gitea/workflows/build-sign.yaml
name: Build and Sign

on:
  push:
    branches: [main]

jobs:
  build-sign-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build image
        run: |
          docker build \
            -t ${{ env.REGISTRY }}/internal/app:${{ github.sha }} \
            -t ${{ env.REGISTRY }}/internal/app:latest \
            .

      - name: Push image
        run: |
          echo "${{ secrets.REGISTRY_PASSWORD }}" | \
            docker login ${{ env.REGISTRY }} \
              -u ${{ secrets.REGISTRY_USER }} \
              --password-stdin
          docker push ${{ env.REGISTRY }}/internal/app:${{ github.sha }}

      - name: Sign image
        env:
          COSIGN_PRIVATE_KEY: ${{ secrets.COSIGN_PRIVATE_KEY }}
          COSIGN_PASSWORD: ${{ secrets.COSIGN_PASSWORD }}
        run: |
          IMAGE_DIGEST=$(crane digest \
            ${{ env.REGISTRY }}/internal/app:${{ github.sha }})
          cosign sign \
            --key env://COSIGN_PRIVATE_KEY \
            --tlog-upload=false \
            ${{ env.REGISTRY }}/internal/app@${IMAGE_DIGEST}

      - name: Attach SBOM
        run: |
          # Generate SBOM with syft
          syft packages \
            --output cyclonedx-json \
            ${{ env.REGISTRY }}/internal/app:${{ github.sha }} \
            > sbom.json

          IMAGE_DIGEST=$(crane digest \
            ${{ env.REGISTRY }}/internal/app:${{ github.sha }})

          cosign attach sbom \
            --sbom sbom.json \
            --type cyclonedx \
            ${{ env.REGISTRY }}/internal/app@${IMAGE_DIGEST}
```

### Querying Referrers via the OCI API

```bash
# List all referrers (signatures, SBOMs, attestations) for an image
IMAGE_DIGEST=$(crane digest registry.internal.example.com/internal/app:v1.2.3)

curl -s \
  -u admin:EXAMPLE_PASSWORD \
  "https://registry.internal.example.com/v2/internal/app/referrers/${IMAGE_DIGEST}" \
  | jq '.manifests[] | {artifactType: .artifactType, digest: .digest}'

# Expected output:
# {
#   "artifactType": "application/vnd.dev.cosign.artifact.sig.v1+json",
#   "digest": "sha256:abc123..."
# }
# {
#   "artifactType": "application/vnd.cyclonedx+json",
#   "digest": "sha256:def456..."
# }
```

## SBOM Attachment Workflow

```bash
# Attach a CycloneDX SBOM to an existing image (no rebuild required)
IMAGE="registry.internal.example.com/internal/app:v1.2.3"
IMAGE_DIGEST=$(crane digest ${IMAGE})

# Generate SBOM
syft packages --output cyclonedx-json ${IMAGE} > sbom-v1.2.3.json

# Attach as OCI referrer
cosign attach sbom \
  --sbom sbom-v1.2.3.json \
  --type cyclonedx \
  "registry.internal.example.com/internal/app@${IMAGE_DIGEST}"

# Verify SBOM attachment
cosign download sbom \
  "registry.internal.example.com/internal/app@${IMAGE_DIGEST}" \
  | jq '.metadata.component.name'
```

## Registry Synchronization and Replication

The `sync` extension allows Zot to pull images from upstream registries on a schedule or on demand — critical for air-gapped environments.

```json
{
  "extensions": {
    "sync": {
      "enable": true,
      "credentialsFile": "/etc/zot/sync-credentials.json",
      "registries": [
        {
          "urls": ["https://registry-1.docker.io"],
          "onDemand": true,
          "tlsVerify": true,
          "content": [
            {
              "prefix": "library",
              "tags": {
                "regex": "^(latest|[0-9]+\\.[0-9]+)$",
                "semver": true
              }
            }
          ]
        },
        {
          "urls": ["https://ghcr.io"],
          "onDemand": true,
          "tlsVerify": true,
          "content": [
            {
              "prefix": "project-zot",
              "destination": "mirrors/zot",
              "stripPrefix": false
            }
          ]
        },
        {
          "urls": ["https://registry.k8s.io"],
          "onDemand": false,
          "tlsVerify": true,
          "pollInterval": "12h",
          "content": [
            {
              "prefix": "**",
              "destination": "mirrors/k8s",
              "tags": {
                "regex": "^v[0-9]+\\.[0-9]+\\.[0-9]+$"
              }
            }
          ]
        }
      ]
    }
  }
}
```

```json
// sync-credentials.json
{
  "registry-1.docker.io": {
    "username": "dockerhub-mirror-user",
    "password": "EXAMPLE_DOCKERHUB_PASSWORD"
  },
  "ghcr.io": {
    "username": "ghcr-sync-user",
    "password": "EXAMPLE_GHCR_TOKEN"
  }
}
```

## zli CLI Usage

`zli` is the Zot-native CLI for registry management, image inspection, and sync operations:

```bash
# Install zli
curl -L https://github.com/project-zot/zot/releases/download/v2.1.0/zli-linux-amd64 \
  -o /usr/local/bin/zli
chmod +x /usr/local/bin/zli

# Configure a registry connection
zli config add prod \
  --url https://registry.internal.example.com \
  --user admin \
  --password EXAMPLE_PASSWORD

# List repositories
zli images --config prod

# Search images by name
zli images --config prod --name "internal/app"

# Show image layers
zli images --config prod --name "internal/app" --verbose

# Trigger an on-demand sync
zli image sync \
  --config prod \
  --registry ghcr.io \
  --repo project-zot/zot \
  --tag v2.1.0

# Run a scrub (detect and repair corrupt blobs)
zli image scrub --config prod
```

## Garbage Collection

Zot's garbage collector removes unreferenced blobs and untagged manifests. Configure it in the storage section:

```json
{
  "storage": {
    "gc": true,
    "gcDelay": "1h",
    "gcInterval": "6h",
    "untaggedImageRetentionPeriod": "24h",
    "referrersRetentionPolicy": {
      "keepAlways": ["application/vnd.dev.cosign.artifact.sig.v1+json"],
      "keepNewest": 5
    }
  }
}
```

The `keepAlways` list ensures Cosign signatures are never garbage-collected. The `keepNewest` setting on other referrer types prevents unbounded SBOM accumulation.

## Storage Scrubbing and Deduplication

```bash
# Manual scrub via the Zot management API
curl -s -X POST \
  -u admin:EXAMPLE_PASSWORD \
  "https://registry.internal.example.com/zot/mgmt/images/scrub"

# Check scrub results
curl -s \
  -u admin:EXAMPLE_PASSWORD \
  "https://registry.internal.example.com/zot/mgmt/images/scrub" \
  | jq '.result'
```

Deduplication is handled automatically at the storage layer. Blobs shared across multiple images (base layers, common libraries) are stored only once in S3, referenced by digest.

## Monitoring with Prometheus

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: zot-registry
  namespace: registry
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: zot
  endpoints:
    - port: registry
      scheme: https
      tlsConfig:
        caFile: /etc/prometheus/secrets/zot-tls/ca.crt
        insecureSkipVerify: false
      path: /metrics
      interval: 60s
      basicAuth:
        username:
          name: zot-monitoring-credentials
          key: username
        password:
          name: zot-monitoring-credentials
          key: password
```

Key metrics:

```
# Total number of image pulls
zot_registry_http_requests_total{method="GET"}

# Push latency (P99)
zot_registry_http_request_duration_seconds_bucket{method="PUT"}

# Storage usage
zot_registry_storage_bytes

# Number of repositories
zot_registry_repo_count

# Number of images
zot_registry_images_count

# Sync errors
zot_registry_sync_errors_total
```

### Alert Rules

```yaml
groups:
  - name: zot-registry
    rules:
      - alert: ZotRegistryHighErrorRate
        expr: |
          rate(zot_registry_http_requests_total{code=~"5.."}[5m]) /
          rate(zot_registry_http_requests_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Zot registry has elevated error rate"

      - alert: ZotRegistryStorageFull
        expr: zot_registry_storage_bytes / (500 * 1024 * 1024 * 1024) > 0.85
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Zot registry S3 storage is over 85% of quota"
```

## Admission Webhook: Enforcing Signed Images

Use Kyverno or OPA Gatekeeper to enforce that only Cosign-signed images from Zot are admitted to the cluster:

```yaml
# Kyverno policy enforcing Cosign signatures from internal registry
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: verify-cosign-signature
      match:
        any:
          - resources:
              kinds: ["Pod"]
      verifyImages:
        - imageReferences:
            - "registry.internal.example.com/internal/*"
          attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXAMPLEKEY==
                      -----END PUBLIC KEY-----
                    rekor:
                      ignoreTlog: true
          attestations:
            - predicateType: https://cyclonedx.org/bom/v1.4
              attestors:
                - count: 1
                  entries:
                    - keys:
                        publicKeys: |-
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXAMPLEKEY==
                          -----END PUBLIC KEY-----
                        rekor:
                          ignoreTlog: true
```

## Air-Gapped Image Sync Workflow

For environments with no internet access during operation:

```bash
#!/usr/bin/env bash
# air-gap-sync.sh — Pre-populate Zot before moving to air-gapped environment

set -euo pipefail

EXTERNAL_REGISTRY="registry-1.docker.io"
INTERNAL_REGISTRY="registry.internal.example.com"
REGISTRY_USER="admin"
REGISTRY_PASS="EXAMPLE_PASSWORD"

# List of images to sync (curated manifest)
IMAGES=(
  "library/nginx:1.26-alpine"
  "library/postgres:16.2-alpine"
  "library/redis:7.2-alpine"
  "bitnami/kubectl:1.30.2"
)

# Login to internal registry
echo "${REGISTRY_PASS}" | docker login ${INTERNAL_REGISTRY} \
  -u "${REGISTRY_USER}" --password-stdin

for image in "${IMAGES[@]}"; do
  src="${EXTERNAL_REGISTRY}/${image}"
  dest="${INTERNAL_REGISTRY}/mirrors/${image}"

  echo "Syncing ${src} -> ${dest}"

  # Copy with all referrers (signatures, SBOMs)
  crane copy \
    --all-tags=false \
    "${src}" "${dest}"

  echo "Completed: ${dest}"
done

echo "Air-gap sync complete."
```

Zot's combination of OCI-native referrers support, minimal operational footprint, and built-in sync capabilities makes it an excellent foundation for supply chain security programs in regulated and air-gapped environments. The native Cosign integration removes the need for a separate Rekor transparency log in private deployments while still providing full signature verification through Kyverno or OPA policies at admission time.
