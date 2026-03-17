---
title: "Harbor: Enterprise Container Registry with Security Scanning and Replication"
date: 2027-11-03T00:00:00-05:00
draft: false
tags: ["Harbor", "Container Registry", "Security", "Trivy", "Kubernetes"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Harbor HA deployment with Helm, project configuration, robot accounts, image scanning with Trivy, replication policies, Kubernetes integration with imagePullSecrets, vulnerability policies, and webhook configuration."
more_link: "yes"
url: "/harbor-private-registry-enterprise-guide/"
---

Harbor is the CNCF-graduated container registry that adds enterprise features on top of basic image storage: role-based access control, vulnerability scanning with Trivy, image signing, replication between registries, and fine-grained content trust policies. For organizations that need more than Docker Hub or a basic self-hosted registry, Harbor provides a complete platform for managing container images and Helm charts throughout the software supply chain.

<!--more-->

# Harbor: Enterprise Container Registry with Security Scanning and Replication

## Why Harbor

Public registries like Docker Hub are convenient but introduce supply chain security risks: rate limiting, data residency concerns, and lack of control over what gets pushed. Basic self-hosted registries (plain Distribution/Registry) provide storage but no security scanning, RBAC, or audit logging.

Harbor fills this gap with:

- **Vulnerability scanning**: Trivy scans images on push and on schedule, identifying CVEs before deployment
- **Content trust**: Cosign and Notary integration for image signing and verification
- **RBAC**: Fine-grained roles (admin, developer, guest, limited guest) per project
- **Replication**: Bidirectional replication with Docker Hub, GCR, ECR, and other Harbor instances
- **Webhook integration**: Notify CI/CD pipelines when scans complete or policies are violated
- **Proxy cache**: Cache images from Docker Hub, reducing egress costs and preventing rate limiting

## Installation with Helm

### Prerequisites

Harbor requires:
- Persistent storage (ReadWriteMany for HA, ReadWriteOnce acceptable for single-node)
- External database (PostgreSQL recommended for production)
- External cache (Redis)
- TLS certificate

```bash
helm repo add harbor https://helm.goharbor.io
helm repo update
```

### Production Values

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
      core: registry.company.com
    className: nginx
    annotations:
      nginx.ingress.kubernetes.io/proxy-body-size: "0"
      nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
      nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
      nginx.ingress.kubernetes.io/ssl-redirect: "true"

externalURL: https://registry.company.com

# Persistence configuration
persistence:
  enabled: true
  resourcePolicy: keep
  persistentVolumeClaim:
    registry:
      storageClass: "fast-ssd"
      accessMode: ReadWriteOnce
      size: 500Gi
    chartmuseum:
      storageClass: "fast-ssd"
      accessMode: ReadWriteOnce
      size: 10Gi
    jobservice:
      jobLog:
        storageClass: "fast-ssd"
        accessMode: ReadWriteOnce
        size: 10Gi
    database:
      storageClass: "fast-ssd"
      accessMode: ReadWriteOnce
      size: 10Gi
    redis:
      storageClass: "fast-ssd"
      accessMode: ReadWriteOnce
      size: 5Gi
    trivy:
      storageClass: "fast-ssd"
      accessMode: ReadWriteOnce
      size: 20Gi

# External database (recommended for production)
database:
  type: external
  external:
    host: postgresql.storage.svc.cluster.local
    port: "5432"
    username: harbor
    password: harbor-db-password
    coreDatabase: registry
    sslmode: require

# External Redis
redis:
  type: external
  external:
    addr: redis.storage.svc.cluster.local:6379
    password: redis-password

# Harbor core service
core:
  replicas: 2
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi

# Registry service
registry:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 1Gi

# Job service for async tasks
jobservice:
  replicas: 1
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

# Trivy vulnerability scanner
trivy:
  enabled: true
  replicas: 2
  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi
  # Update vulnerability database on startup and periodically
  skipUpdate: false
  skipJavaDBUpdate: false
  offlineScan: false
  githubToken: ""
  timeout: 5m0s
  vulnType: os,library
  severity: UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL
  ignoreUnfixed: false

# Notary for content trust (optional)
notary:
  enabled: false

# Log level
logLevel: info

# Admin password (override via secret in production)
harborAdminPassword: "CHANGE-ME-IN-PRODUCTION"

# Secret key for encryption (32 characters)
secretKey: "not-a-real-secret-key-change-me"

updateStrategy:
  type: RollingUpdate

# Metrics
metrics:
  enabled: true
  core:
    path: /metrics
    port: 8001
  registry:
    path: /metrics
    port: 8001
  jobservice:
    path: /metrics
    port: 8001

# Cache for proxying external registries
cache:
  enabled: true
  expireHours: 24
```

```bash
helm install harbor harbor/harbor \
  --namespace harbor \
  --create-namespace \
  --version 1.14.0 \
  --values harbor-values.yaml \
  --wait \
  --timeout 10m
```

### TLS Certificate

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: harbor-tls
  namespace: harbor
spec:
  secretName: harbor-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - registry.company.com
  duration: 2160h
  renewBefore: 360h
```

## Project Configuration

In Harbor, all images are organized under Projects. Each project has its own access control, scanning policies, and storage quotas.

### Creating Projects via API

```bash
# Create a production project
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/projects \
  -d '{
    "project_name": "production",
    "metadata": {
      "public": "false",
      "enable_content_trust": "true",
      "enable_content_trust_cosign": "false",
      "prevent_vul": "true",
      "severity": "high",
      "auto_scan": "true"
    },
    "storage_limit": 107374182400,
    "registry_id": null
  }'

# Create a development project with relaxed policies
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/projects \
  -d '{
    "project_name": "development",
    "metadata": {
      "public": "false",
      "enable_content_trust": "false",
      "prevent_vul": "false",
      "auto_scan": "true"
    },
    "storage_limit": 21474836480
  }'
```

### Vulnerability Policy Configuration

```bash
# Set vulnerability policy: block images with CRITICAL vulnerabilities
curl -sk -u admin:admin-password \
  -X PUT \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/projects/production/metadata \
  -d '{
    "metadata": {
      "prevent_vul": "true",
      "severity": "critical",
      "auto_scan": "true",
      "reuse_sys_cve_allowlist": "true",
      "enable_content_trust": "true"
    }
  }'
```

## Robot Accounts for CI/CD

Robot accounts provide service-level credentials for CI/CD systems with precisely scoped permissions:

```bash
# Create a robot account for a specific project with push/pull permissions
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/robots \
  -d '{
    "name": "ci-pipeline-robot",
    "description": "CI/CD pipeline for application builds",
    "duration": 365,
    "level": "project",
    "disable": false,
    "permissions": [
      {
        "kind": "project",
        "namespace": "production",
        "access": [
          {"resource": "repository", "action": "pull"},
          {"resource": "repository", "action": "push"},
          {"resource": "artifact", "action": "delete"},
          {"resource": "scan", "action": "create"},
          {"resource": "tag", "action": "create"},
          {"resource": "tag", "action": "delete"}
        ]
      }
    ]
  }'
```

The response contains the robot account secret -- save it immediately as it cannot be retrieved again.

## Kubernetes Integration

### Creating imagePullSecrets

```bash
# Create a namespace-scoped secret for pulling images from Harbor
kubectl create secret docker-registry harbor-registry-secret \
  --docker-server=registry.company.com \
  --docker-username='robot$ci-pipeline-robot' \
  --docker-password='robot-account-secret-here' \
  --namespace=production
```

### Cluster-Wide Default Pull Secret

For clusters that pull all images from Harbor, configure a default imagePullSecret that applies to all pods without explicitly specifying it:

```bash
# Patch the default service account in each namespace
for NS in production staging development; do
    kubectl create secret docker-registry harbor-registry-secret \
        --docker-server=registry.company.com \
        --docker-username='robot$cluster-pull-robot' \
        --docker-password='robot-account-secret-here' \
        --namespace=$NS

    kubectl patch serviceaccount default \
        --namespace=$NS \
        -p '{"imagePullSecrets": [{"name": "harbor-registry-secret"}]}'
done
```

### Admission Controller for Vulnerability Policy Enforcement

To enforce Harbor's vulnerability policies at the cluster level (not just at push time), use the Harbor notary or Cosign integration with a Kubernetes admission webhook:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: harbor-image-validator
  namespace: harbor
spec:
  replicas: 2
  selector:
    matchLabels:
      app: harbor-image-validator
  template:
    metadata:
      labels:
        app: harbor-image-validator
    spec:
      containers:
      - name: harbor-image-validator
        image: registry.company.com/tools/harbor-webhook:v1.0.0
        env:
        - name: HARBOR_URL
          value: "https://registry.company.com"
        - name: HARBOR_USERNAME
          valueFrom:
            secretKeyRef:
              name: harbor-validator-credentials
              key: username
        - name: HARBOR_PASSWORD
          valueFrom:
            secretKeyRef:
              name: harbor-validator-credentials
              key: password
        - name: BLOCKED_SEVERITY
          value: "CRITICAL,HIGH"
        ports:
        - containerPort: 8443
          name: https
        volumeMounts:
        - name: tls
          mountPath: /tls
          readOnly: true
      volumes:
      - name: tls
        secret:
          secretName: harbor-webhook-tls
```

## Replication Policies

Harbor can replicate images to and from other registries for disaster recovery and multi-region deployments:

```bash
# Create a replication target (push to ECR)
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/registries \
  -d '{
    "name": "aws-ecr-us-east-1",
    "type": "aws-ecr",
    "url": "https://123456789012.dkr.ecr.us-east-1.amazonaws.com",
    "credential": {
      "type": "basic",
      "access_key": "EXAMPLEAWSACCESSKEY123",
      "access_secret": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    },
    "description": "AWS ECR us-east-1 backup registry"
  }'

# Create a replication rule: push all images tagged as release to ECR
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/replication/policies \
  -d '{
    "name": "production-to-ecr",
    "description": "Replicate production release images to ECR for DR",
    "src_registry": null,
    "dest_registry": {"id": 1},
    "src_namespaces": ["production"],
    "filters": [
      {"type": "name", "value": "**"},
      {"type": "tag", "value": "v*.*.*"}
    ],
    "trigger": {
      "type": "event_based",
      "trigger_settings": {
        "cron": ""
      }
    },
    "deletion": false,
    "override": true,
    "enabled": true,
    "dest_namespace": "company-production",
    "dest_namespace_replace_count": 1,
    "copy_by_chunk": false,
    "speed": -1
  }'
```

### Proxy Cache for Docker Hub

Configure Harbor as a proxy cache for Docker Hub to avoid rate limiting and reduce egress costs:

```bash
# Create a proxy cache registry pointing to Docker Hub
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/registries \
  -d '{
    "name": "docker-hub-proxy",
    "type": "docker-hub",
    "url": "https://hub.docker.com",
    "credential": {
      "type": "basic",
      "access_key": "dockerhub-username",
      "access_secret": "dockerhub-password"
    },
    "description": "Docker Hub proxy cache"
  }'

# Create a proxy cache project
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/projects \
  -d '{
    "project_name": "dockerhub-cache",
    "metadata": {
      "public": "true",
      "auto_scan": "true"
    },
    "registry_id": 1
  }'
```

Pull Docker Hub images through the proxy:

```bash
# Instead of:
docker pull nginx:1.25
# Use:
docker pull registry.company.com/dockerhub-cache/nginx:1.25
```

## Webhook Configuration

Configure webhooks to notify CI/CD pipelines when important events occur:

```bash
# Create a webhook for image scan completion
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/projects/production/webhook/policies \
  -d '{
    "name": "ci-pipeline-notifications",
    "description": "Notify CI pipeline of scan results",
    "targets": [
      {
        "type": "http",
        "address": "https://jenkins.company.com/generic-webhook-trigger/invoke?token=harbor-webhook-token",
        "skip_cert_verify": false,
        "auth_header": "Bearer jenkins-webhook-token-here"
      }
    ],
    "event_types": [
      "SCANNING_COMPLETED",
      "SCANNING_FAILED",
      "TAG_RETENTION"
    ],
    "enabled": true
  }'
```

## Tag Retention Policies

Manage storage costs with tag retention policies:

```bash
# Create a retention policy: keep only the last 10 versions of production images
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/retentions \
  -d '{
    "algorithm": "or",
    "rules": [
      {
        "disabled": false,
        "action": "retain",
        "template": "latestActiveK",
        "params": {
          "latestActiveK": 10
        },
        "tag_selectors": [
          {
            "kind": "doublestar",
            "decoration": "matches",
            "pattern": "v*.*.*"
          }
        ],
        "scope_selectors": {
          "repository": [
            {
              "kind": "doublestar",
              "decoration": "repoMatches",
              "pattern": "**"
            }
          ]
        }
      },
      {
        "disabled": false,
        "action": "retain",
        "template": "always",
        "params": {},
        "tag_selectors": [
          {
            "kind": "doublestar",
            "decoration": "matches",
            "pattern": "latest"
          }
        ],
        "scope_selectors": {
          "repository": [
            {
              "kind": "doublestar",
              "decoration": "repoMatches",
              "pattern": "**"
            }
          ]
        }
      }
    ],
    "scope": {
      "level": "project",
      "ref": 1
    }
  }'
```

## Monitoring Harbor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: harbor
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: harbor
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
  - name: harbor
    rules:
    - alert: HarborHighCriticalVulnerabilities
      expr: harbor_artifact_vulnerability_count{severity="critical"} > 10
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "High number of critical vulnerabilities in Harbor project {{ $labels.project }}"
        description: "Project {{ $labels.project }} has {{ $value }} artifacts with critical vulnerabilities."

    - alert: HarborStorageUsageHigh
      expr: harbor_project_quota_usage_byte / harbor_project_quota_byte > 0.85
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Harbor project {{ $labels.public }} storage at 85% capacity"

    - alert: HarborCoreDown
      expr: absent(up{job="harbor-core"}) or up{job="harbor-core"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Harbor core service is down"
        description: "Harbor container registry is unavailable. Image pulls and pushes will fail."
```

## Backup and Disaster Recovery

```bash
#!/bin/bash
# harbor-backup.sh

BACKUP_DATE=$(date +%Y%m%d-%H%M%S)
HARBOR_DB_HOST=postgresql.storage.svc.cluster.local
HARBOR_DB_USER=harbor
HARBOR_DB_NAME=registry

echo "Starting Harbor backup: ${BACKUP_DATE}"

# Backup PostgreSQL database
PGPASSWORD=$HARBOR_DB_PASSWORD pg_dump \
  -h "$HARBOR_DB_HOST" \
  -U "$HARBOR_DB_USER" \
  -Fc \
  "$HARBOR_DB_NAME" \
  > "/tmp/harbor-db-${BACKUP_DATE}.pgdump"

# Upload to S3
aws s3 cp "/tmp/harbor-db-${BACKUP_DATE}.pgdump" \
  "s3://company-backups/harbor/${BACKUP_DATE}/harbor-db.pgdump"

echo "Database backup complete: s3://company-backups/harbor/${BACKUP_DATE}/harbor-db.pgdump"

# Image data is stored in the PVC - use Velero or VolumeSnapshot for this
# velero backup create harbor-backup-${BACKUP_DATE} \
#   --include-namespaces harbor \
#   --storage-location default
```

## Conclusion

Harbor provides the enterprise-grade container registry capabilities that production Kubernetes clusters require. The combination of Trivy vulnerability scanning with enforcement policies, RBAC, replication for DR, and proxy caching for Docker Hub creates a comprehensive image management platform.

The key to a successful Harbor deployment is establishing clear policies from the start: define which severity thresholds block deployment in production vs staging, establish robot accounts for all CI/CD pipelines rather than using admin credentials, and configure tag retention policies before storage fills up. With these governance policies in place, Harbor becomes a critical security control in your container supply chain, catching vulnerabilities before they reach production.

## Image Signing with Cosign

Harbor 2.5+ supports Cosign for container image signing and verification. This provides cryptographic proof that an image was built by your CI/CD pipeline and has not been tampered with.

### Setting Up Cosign

```bash
# Install cosign
curl -O -L https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x cosign-linux-amd64
sudo mv cosign-linux-amd64 /usr/local/bin/cosign

# Generate a key pair for signing
cosign generate-key-pair

# This creates cosign.key (private) and cosign.pub (public)
# Store cosign.key in your secret manager
# Store cosign.pub in your Kubernetes cluster and CI/CD config
```

### Signing Images in CI/CD

```bash
#!/bin/bash
# sign-and-push.sh - Called after building and pushing image

IMAGE_REF="registry.company.com/production/my-app:v1.2.3"
COSIGN_KEY=/tmp/cosign.key

# Build image
docker build -t "$IMAGE_REF" .

# Push to Harbor
docker push "$IMAGE_REF"

# Get the image digest (sign the digest, not the tag, for immutability)
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_REF")

# Sign the image
COSIGN_PASSWORD=$COSIGN_KEY_PASSWORD \
cosign sign \
  --key "$COSIGN_KEY" \
  --yes \
  "$DIGEST"

echo "Image signed: $DIGEST"

# Verify the signature immediately after signing
cosign verify \
  --key cosign.pub \
  "$IMAGE_REF" | jq .
```

### Verifying Signatures at Admission

Use the Sigstore Policy Controller to enforce signature verification in Kubernetes:

```yaml
apiVersion: policy.sigstore.dev/v1alpha1
kind: ClusterImagePolicy
metadata:
  name: require-signed-images
spec:
  images:
  - glob: "registry.company.com/production/**"
  authorities:
  - key:
      # The public key used to verify signatures
      data: |
        -----BEGIN PUBLIC KEY-----
        MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFgTQNH0JBnUFwFrBVJiH3FRz
        xamplePublicKeyDataHere==
        -----END PUBLIC KEY-----
    ctlog:
      url: https://rekor.sigstore.dev
```

## OIDC Integration for Developer Login

Configure Harbor to use your existing SSO (Keycloak) for developer authentication:

```bash
# Configure OIDC in Harbor via API
curl -sk -u admin:admin-password \
  -X PUT \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/configurations \
  -d '{
    "auth_mode": "oidc_auth",
    "oidc_name": "Company SSO",
    "oidc_endpoint": "https://sso.company.com/realms/company",
    "oidc_client_id": "harbor",
    "oidc_client_secret": "harbor-oidc-secret-here",
    "oidc_groups_claim": "groups",
    "oidc_admin_group": "harbor-admins",
    "oidc_scope": "openid,profile,email,groups",
    "oidc_auto_onboard": true,
    "oidc_user_claim": "preferred_username",
    "oidc_verify_cert": true,
    "self_registration": false,
    "token_expiration": 30
  }'
```

## Garbage Collection

Harbor does not automatically delete unreferenced image layers. Configure garbage collection to reclaim space:

```bash
# Schedule garbage collection
curl -sk -u admin:admin-password \
  -X POST \
  -H "Content-Type: application/json" \
  https://registry.company.com/api/v2.0/system/gc/schedule \
  -d '{
    "schedule": {
      "type": "Custom",
      "cron": "0 2 * * 0"
    },
    "parameters": {
      "delete_untagged": true,
      "workers": 1
    }
  }'

# Check garbage collection status
curl -sk -u admin:admin-password \
  https://registry.company.com/api/v2.0/system/gc | jq '.[0]'
```

## Helm Chart Repository

Harbor also serves as a Helm chart repository. Push and pull Helm charts alongside container images:

```bash
# Push a Helm chart to Harbor
helm package my-application/
helm push my-application-1.2.3.tgz oci://registry.company.com/production

# Pull and install a chart
helm install my-app oci://registry.company.com/production/my-application --version 1.2.3

# List charts in Harbor
curl -sk -u admin:admin-password \
  "https://registry.company.com/api/v2.0/projects/production/repositories?page_size=100" | \
  jq '.[] | select(.artifact_count > 0) | .name'
```

## Multi-Registry Configuration for Kubernetes

For environments pulling from multiple registries (Harbor for internal images, Docker Hub for base images via proxy), configure images to use the appropriate registry:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-application
  namespace: production
spec:
  template:
    spec:
      # Harbor pull secret for internal images
      imagePullSecrets:
      - name: harbor-registry-secret
      containers:
      # Internal application image from Harbor
      - name: app
        image: registry.company.com/production/my-application:v1.2.3
        resources:
          requests:
            cpu: 200m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 2Gi
      # Base tool image from Docker Hub via Harbor proxy cache
      - name: sidecar
        image: registry.company.com/dockerhub-cache/datadog/agent:7
```

## Advanced Trivy Scanner Configuration

For environments with air-gapped or restricted internet access, configure Trivy to use an offline vulnerability database:

```yaml
# Updated harbor-values.yaml for offline Trivy
trivy:
  enabled: true
  replicas: 1
  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi
  # Skip database updates from the internet
  skipUpdate: true
  # Mount the offline database from a PVC
  extraVolumes:
  - name: trivy-db
    persistentVolumeClaim:
      claimName: trivy-offline-db
  extraVolumeMounts:
  - name: trivy-db
    mountPath: /home/scanner/.cache/trivy
```

To update the offline database, create a Job that downloads the latest DB and copies it to the PVC:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: trivy-db-updater
  namespace: harbor
spec:
  schedule: "0 1 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: trivy-db-update
            image: aquasec/trivy:0.50.0
            command:
            - trivy
            - --cache-dir=/trivy-cache
            - image
            - --download-db-only
            volumeMounts:
            - name: trivy-db
              mountPath: /trivy-cache
          restartPolicy: OnFailure
          volumes:
          - name: trivy-db
            persistentVolumeClaim:
              claimName: trivy-offline-db
```

## Compliance and Audit Logging

Harbor records all operations in an audit log accessible via the API:

```bash
# Retrieve recent audit events for a project
curl -sk -u admin:admin-password \
  "https://registry.company.com/api/v2.0/audit-logs?page_size=50&page=1&q=project_name%3Dproduction" | \
  jq '.[] | {operation: .operation, username: .username, resource: .resource, timestamp: .timestamp}'

# Export audit logs for the last 7 days
curl -sk -u admin:admin-password \
  "https://registry.company.com/api/v2.0/audit-logs?page_size=1000&start_time=$(date -d '7 days ago' +%s)000" | \
  jq . > harbor-audit-$(date +%Y%m%d).json

# Specific operation types: push, pull, delete, create, update
curl -sk -u admin:admin-password \
  "https://registry.company.com/api/v2.0/audit-logs?q=operation%3Dpush" | \
  jq '.[] | .username + " pushed " + .resource + " at " + .timestamp'
```

## Storage Backend Options

Beyond local PVC storage, Harbor supports S3-compatible storage backends:

```yaml
# Update harbor-values.yaml for S3 storage
persistence:
  enabled: true
  imageChartStorage:
    disableredirect: false
    type: s3
    s3:
      region: us-east-1
      bucket: company-harbor-registry
      accesskey: ""  # Leave empty to use IRSA/IAM role
      secretkey: ""
      regionendpoint: ""
      encrypt: true
      secure: true
      v4auth: true
      chunksize: "5242880"
      rootdirectory: /registry
      storageclass: STANDARD
      multipartcopychunksize: "33554432"
      multipartcopymaxconcurrency: 100
      multipartcopythresholdsize: "33554432"
```

With S3 backend, the Harbor registry pods become stateless and can be scaled horizontally without worrying about shared storage access modes.

## Conclusion (Extended)

Harbor's rich feature set makes it the definitive enterprise container registry for organizations that require security scanning, access control, and supply chain security. The combination of Trivy integration for vulnerability detection, Cosign for image signing, OIDC for developer authentication, and webhook notifications for CI/CD integration covers the full lifecycle from image build to production deployment.

A mature Harbor deployment acts as a security gate in your supply chain: images with critical vulnerabilities cannot be deployed to production, unsigned images are rejected, and all registry operations are audited for compliance. Combined with proper retention policies and replication for disaster recovery, Harbor provides the foundation for a production-grade container supply chain.
