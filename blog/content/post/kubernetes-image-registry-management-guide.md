---
title: "Kubernetes Image Registry Management: Mirroring, Caching, and Supply Chain Security"
date: 2027-05-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Container Registry", "Harbor", "Supply Chain Security", "Cosign", "SBOM"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes image registry management covering Harbor deployment, registry mirroring, SBOM generation, image signing with Cosign, and supply chain security enforcement with Kyverno."
more_link: "yes"
url: "/kubernetes-image-registry-management-guide/"
---

Container image supply chain attacks have become one of the most consequential threat vectors in cloud-native infrastructure. From the SolarWinds build system compromise to the compromised `ua-parser-js` npm package injecting cryptocurrency miners, attackers have demonstrated that software delivery pipelines are high-value targets. A mature Kubernetes image registry strategy addresses this threat through private registry hosting, cryptographic image signing, Software Bill of Materials (SBOM) generation, vulnerability scanning, and policy-based admission control. This guide covers each layer of a production-grade registry architecture.

<!--more-->

## Registry Architecture Overview

### Why Private Registries Are Mandatory in Production

Pulling images directly from Docker Hub in production creates several problems:

- **Rate limiting**: Docker Hub applies pull rate limits (100 pulls per 6 hours for anonymous, 200 for free accounts). A cluster under load will hit these limits during rollouts or autoscaling events.
- **Availability dependency**: Public registry outages directly impact production deployments.
- **No provenance guarantees**: Tags are mutable — an upstream compromise can replace a previously safe image.
- **No scanning integration**: Public registries do not integrate with your vulnerability scanning workflows.
- **Compliance violations**: Many compliance frameworks (PCI-DSS, FedRAMP, HIPAA) require software to be sourced from controlled repositories.

A private registry solves all of these by providing: deterministic image availability, integrated vulnerability scanning, immutable image digests, pull-through caching, and audit logging of all pulls and pushes.

### Harbor: The Enterprise Registry Platform

Harbor is the most widely deployed CNCF-graduated private registry for Kubernetes. It provides:

- OCI-compliant image storage
- Role-based access control (RBAC) with LDAP/OIDC integration
- Integrated vulnerability scanning with Trivy and Clair
- Image signing and verification
- Replication between registry instances
- Content trust enforcement
- Garbage collection
- Helm chart hosting

## Deploying Harbor on Kubernetes

### Prerequisites and Storage Configuration

Harbor requires persistent storage for its database, Redis, and image blobs. In production, use a proper storage backend:

```yaml
# storageclass for Harbor components
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: harbor-storage
provisioner: ebs.csi.aws.com  # Adjust for your cloud provider
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
reclaimPolicy: Retain          # IMPORTANT: Retain prevents accidental deletion
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### Harbor Helm Deployment

```bash
# Add Harbor Helm repository
helm repo add harbor https://helm.goharbor.io
helm repo update

# Create namespace
kubectl create namespace harbor
```

Create a production values file:

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
      core: registry.internal.example.com
      notary: notary.internal.example.com
    className: nginx
    annotations:
      nginx.ingress.kubernetes.io/proxy-body-size: "0"
      nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
      nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
      cert-manager.io/cluster-issuer: "internal-ca"

externalURL: https://registry.internal.example.com

persistence:
  enabled: true
  resourcePolicy: "keep"
  persistentVolumeClaim:
    registry:
      storageClass: harbor-storage
      size: 200Gi
      accessMode: ReadWriteOnce
    jobservice:
      storageClass: harbor-storage
      size: 10Gi
      accessMode: ReadWriteOnce
    database:
      storageClass: harbor-storage
      size: 20Gi
      accessMode: ReadWriteOnce
    redis:
      storageClass: harbor-storage
      size: 5Gi
      accessMode: ReadWriteOnce
    trivy:
      storageClass: harbor-storage
      size: 10Gi
      accessMode: ReadWriteOnce

harborAdminPassword: "REPLACE_WITH_STRONG_PASSWORD"

secretKey: "REPLACE_WITH_16_CHAR_KEY"

database:
  type: internal
  internal:
    password: "REPLACE_WITH_DB_PASSWORD"

redis:
  type: internal

trivy:
  enabled: true
  gitHubToken: "REPLACE_WITH_GITHUB_TOKEN"  # Avoid GitHub rate limits
  skipUpdate: false
  offline: false
  ignoreUnfixed: false
  insecure: false
  vulnType: os,library
  severity: UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL
  timeout: 5m0s

notary:
  enabled: true

chartmuseum:
  enabled: true
  absoluteUrl: false

core:
  replicas: 2
  resources:
    requests:
      memory: 256Mi
      cpu: 100m
    limits:
      memory: 512Mi
      cpu: 500m
  livenessProbe:
    initialDelaySeconds: 300

jobservice:
  replicas: 1
  maxJobWorkers: 10
  resources:
    requests:
      memory: 256Mi
      cpu: 100m
    limits:
      memory: 512Mi
      cpu: 500m

registry:
  replicas: 2
  resources:
    requests:
      memory: 256Mi
      cpu: 100m
    limits:
      memory: 512Mi
      cpu: 500m

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
```

Deploy Harbor:

```bash
helm install harbor harbor/harbor \
  --namespace harbor \
  --values harbor-values.yaml \
  --wait \
  --timeout 10m

# Verify all pods are running
kubectl get pods -n harbor
```

### Configuring Harbor Projects and Policies

Create projects via the Harbor API for automation:

```bash
# Set Harbor endpoint
HARBOR_URL="https://registry.internal.example.com"
HARBOR_USER="admin"
HARBOR_PASS="your-admin-password"

# Create a production project
curl -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -X POST "${HARBOR_URL}/api/v2.0/projects" \
  -H "Content-Type: application/json" \
  -d '{
    "project_name": "production",
    "metadata": {
      "public": "false",
      "enable_content_trust": "true",
      "prevent_vul": "true",
      "severity": "high",
      "auto_scan": "true",
      "reuse_sys_cve_allowlist": "false"
    },
    "storage_limit": -1
  }'

# Create a pull-through proxy cache project for Docker Hub
curl -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -X POST "${HARBOR_URL}/api/v2.0/registries" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "docker-hub-mirror",
    "type": "docker-hub",
    "url": "https://hub.docker.com",
    "credential": {
      "access_key": "your-dockerhub-username",
      "access_secret": "your-dockerhub-token",
      "type": "basic"
    },
    "insecure": false
  }'

# Get the registry ID from the response, then create proxy cache project
curl -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -X POST "${HARBOR_URL}/api/v2.0/projects" \
  -H "Content-Type: application/json" \
  -d '{
    "project_name": "dockerhub-proxy",
    "metadata": {
      "public": "false",
      "auto_scan": "true"
    },
    "registry_id": 1
  }'
```

## Configuring containerd Registry Mirrors

### containerd Mirror Configuration

Configure all Kubernetes nodes to use Harbor as a pull-through cache. This applies to containerd (the standard Kubernetes runtime):

```toml
# /etc/containerd/config.toml
version = 2

[plugins."io.containerd.grpc.v1.cri"]
  [plugins."io.containerd.grpc.v1.cri".registry]
    config_path = "/etc/containerd/certs.d"

[plugins."io.containerd.grpc.v1.cri".containerd]
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
    runtime_type = "io.containerd.runc.v2"
    [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
      SystemdCgroup = true
```

Create registry configuration directories:

```bash
# Configure Docker Hub mirror
mkdir -p /etc/containerd/certs.d/docker.io
cat > /etc/containerd/certs.d/docker.io/hosts.toml << 'EOF'
server = "https://registry-1.docker.io"

[host."https://registry.internal.example.com/v2/dockerhub-proxy"]
  capabilities = ["pull", "resolve"]
  ca = "/etc/containerd/certs.d/docker.io/ca.crt"
  override_path = true
EOF

# Configure registry.k8s.io mirror
mkdir -p /etc/containerd/certs.d/registry.k8s.io
cat > /etc/containerd/certs.d/registry.k8s.io/hosts.toml << 'EOF'
server = "https://registry.k8s.io"

[host."https://registry.internal.example.com/v2/k8s-proxy"]
  capabilities = ["pull", "resolve"]
  ca = "/etc/containerd/certs.d/registry.k8s.io/ca.crt"
  override_path = true
EOF

# Configure gcr.io mirror
mkdir -p /etc/containerd/certs.d/gcr.io
cat > /etc/containerd/certs.d/gcr.io/hosts.toml << 'EOF'
server = "https://gcr.io"

[host."https://registry.internal.example.com/v2/gcr-proxy"]
  capabilities = ["pull", "resolve"]
  ca = "/etc/containerd/certs.d/gcr.io/ca.crt"
  override_path = true
EOF

# Copy Harbor CA certificate to each registry config directory
# (Replace with your actual CA certificate)
for dir in docker.io registry.k8s.io gcr.io; do
  cp /etc/ssl/certs/internal-ca.crt /etc/containerd/certs.d/${dir}/ca.crt
done
```

Automate mirror configuration across all nodes with a DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: containerd-mirror-config
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: containerd-mirror-config
  template:
    metadata:
      labels:
        app: containerd-mirror-config
    spec:
      hostPID: true
      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
      initContainers:
      - name: configure-mirrors
        image: ubuntu:22.04
        command:
        - /bin/bash
        - -c
        - |
          set -ex
          # Create configuration directories
          mkdir -p /host/etc/containerd/certs.d/docker.io
          mkdir -p /host/etc/containerd/certs.d/registry.k8s.io
          mkdir -p /host/etc/containerd/certs.d/gcr.io

          # Write mirror configurations
          cp /config/docker.io-hosts.toml /host/etc/containerd/certs.d/docker.io/hosts.toml
          cp /config/k8s-hosts.toml /host/etc/containerd/certs.d/registry.k8s.io/hosts.toml
          cp /config/gcr-hosts.toml /host/etc/containerd/certs.d/gcr.io/hosts.toml

          # Copy CA certificate
          cp /config/harbor-ca.crt /host/etc/containerd/certs.d/docker.io/ca.crt
          cp /config/harbor-ca.crt /host/etc/containerd/certs.d/registry.k8s.io/ca.crt
          cp /config/harbor-ca.crt /host/etc/containerd/certs.d/gcr.io/ca.crt

          # Restart containerd via nsenter
          nsenter -t 1 -m -u -i -n -p -- systemctl restart containerd
          echo "Mirror configuration complete"
        securityContext:
          privileged: true
        volumeMounts:
        - name: host-containerd
          mountPath: /host/etc/containerd
        - name: config
          mountPath: /config
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
      volumes:
      - name: host-containerd
        hostPath:
          path: /etc/containerd
          type: DirectoryOrCreate
      - name: config
        configMap:
          name: containerd-mirror-config
```

## Image Pull Secrets

### Creating Registry Credentials

```bash
# Create Docker registry secret for Harbor
kubectl create secret docker-registry harbor-pull-secret \
  --docker-server=registry.internal.example.com \
  --docker-username=robot-account \
  --docker-password=robot-token \
  --namespace=production

# Verify the secret
kubectl get secret harbor-pull-secret -n production -o json | \
  jq -r '.data[".dockerconfigjson"]' | base64 -d | jq .
```

### Automating Pull Secret Distribution

Rather than manually creating pull secrets in every namespace, use a controller to replicate them:

```yaml
# Using the Kubernetes Replicator or a simple script
apiVersion: v1
kind: ServiceAccount
metadata:
  name: secret-replicator
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: secret-replicator
rules:
- apiGroups: [""]
  resources: ["secrets", "namespaces"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: secret-replicator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: secret-replicator
subjects:
- kind: ServiceAccount
  name: secret-replicator
  namespace: kube-system
```

Alternatively, patch the default ServiceAccount in each namespace to include the pull secret:

```bash
#!/bin/bash
# patch-pull-secrets.sh — run after namespace creation
NAMESPACE=$1
SECRET_NAME="harbor-pull-secret"

# Copy the pull secret to the new namespace
kubectl get secret ${SECRET_NAME} -n production -o yaml | \
  sed "s/namespace: production/namespace: ${NAMESPACE}/" | \
  kubectl apply -f -

# Patch the default service account
kubectl patch serviceaccount default \
  -n ${NAMESPACE} \
  -p "{\"imagePullSecrets\": [{\"name\": \"${SECRET_NAME}\"}]}"
```

### imagePullPolicy Best Practices

The `imagePullPolicy` setting has significant security and operational implications:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-deployment
  namespace: production
spec:
  template:
    spec:
      containers:
      - name: api
        # PRODUCTION: Always use digest + IfNotPresent for reproducibility
        # The digest ensures the exact image is used even if tag is overwritten
        image: registry.internal.example.com/production/api@sha256:a1b2c3d4e5f6...
        imagePullPolicy: IfNotPresent

        # DEVELOPMENT: Use Always with a mutable tag to get latest builds
        # image: registry.internal.example.com/dev/api:latest
        # imagePullPolicy: Always
```

Use digest-pinned image references in production. Tags are mutable — a compromised registry account can overwrite a tag with a malicious image. Digests are content-addressed and immutable:

```bash
# Resolve a tag to its digest
docker pull registry.internal.example.com/production/api:v2.1.0
docker inspect registry.internal.example.com/production/api:v2.1.0 \
  --format='{{index .RepoDigests 0}}'
# Output: registry.internal.example.com/production/api@sha256:abc123...

# Or use crane
crane digest registry.internal.example.com/production/api:v2.1.0
```

## SBOM Generation with Syft

### Generating SBOMs in CI/CD

A Software Bill of Materials documents all components in an image — OS packages, language libraries, and their versions. SBOMs are foundational for vulnerability response (knowing which images contain a newly discovered CVE without re-scanning everything) and compliance (demonstrating component provenance).

Install Syft:

```bash
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin
syft version
```

Generate SBOMs in multiple formats:

```bash
# Generate SPDX JSON SBOM (standard format)
syft registry.internal.example.com/production/api:v2.1.0 \
  --output spdx-json=sbom-api-v2.1.0.spdx.json

# Generate CycloneDX XML (alternative standard)
syft registry.internal.example.com/production/api:v2.1.0 \
  --output cyclonedx-xml=sbom-api-v2.1.0.cyclonedx.xml

# Generate Syft's native JSON for detailed analysis
syft registry.internal.example.com/production/api:v2.1.0 \
  --output json=sbom-api-v2.1.0.syft.json

# Generate a human-readable table for quick review
syft registry.internal.example.com/production/api:v2.1.0 \
  --output table

# Scan a local image (useful in CI before push)
syft dir:/path/to/build/context --output spdx-json=sbom.json
```

### Attaching SBOMs to Images as OCI Artifacts

Store SBOMs alongside images in the registry using OCI artifact storage:

```bash
# Install cosign (used for both signing and SBOM attachment)
curl -O -L "https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64"
chmod +x cosign-linux-amd64
sudo mv cosign-linux-amd64 /usr/local/bin/cosign

# Attach SBOM to image
cosign attach sbom \
  --sbom sbom-api-v2.1.0.spdx.json \
  --type spdx \
  registry.internal.example.com/production/api:v2.1.0

# Verify the SBOM is attached
cosign download sbom registry.internal.example.com/production/api:v2.1.0
```

### CI/CD Integration for SBOM Generation

A complete GitHub Actions workflow integrating SBOM generation:

```yaml
# .github/workflows/build-and-attest.yml
name: Build, Scan, Sign, and Attest

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: registry.internal.example.com
  IMAGE_NAME: production/api

jobs:
  build-and-attest:
    runs-on: ubuntu-22.04
    permissions:
      contents: read
      id-token: write  # Required for Cosign keyless signing

    steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Log in to Harbor
      uses: docker/login-action@v3
      with:
        registry: ${{ env.REGISTRY }}
        username: ${{ secrets.HARBOR_USERNAME }}
        password: ${{ secrets.HARBOR_TOKEN }}

    - name: Extract metadata
      id: meta
      uses: docker/metadata-action@v5
      with:
        images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
        tags: |
          type=sha,prefix=,suffix=,format=long
          type=semver,pattern={{version}}
          type=ref,event=branch

    - name: Build and push
      id: build-push
      uses: docker/build-push-action@v5
      with:
        context: .
        push: true
        tags: ${{ steps.meta.outputs.tags }}
        labels: ${{ steps.meta.outputs.labels }}
        cache-from: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:cache
        cache-to: type=registry,ref=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:cache,mode=max
        sbom: true        # Generate SBOM with BuildKit
        provenance: true  # Generate SLSA provenance attestation

    - name: Install Syft
      run: |
        curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | \
          sh -s -- -b /usr/local/bin v0.101.0

    - name: Generate SPDX SBOM
      run: |
        IMAGE_DIGEST="${{ steps.build-push.outputs.digest }}"
        syft "${REGISTRY}/${IMAGE_NAME}@${IMAGE_DIGEST}" \
          --output spdx-json=sbom.spdx.json

    - name: Install Cosign
      uses: sigstore/cosign-installer@v3.4.0

    - name: Sign image with Cosign (keyless via OIDC)
      run: |
        IMAGE_DIGEST="${{ steps.build-push.outputs.digest }}"
        cosign sign --yes \
          "${REGISTRY}/${IMAGE_NAME}@${IMAGE_DIGEST}"

    - name: Attach SBOM
      run: |
        IMAGE_DIGEST="${{ steps.build-push.outputs.digest }}"
        cosign attach sbom \
          --sbom sbom.spdx.json \
          --type spdx \
          "${REGISTRY}/${IMAGE_NAME}@${IMAGE_DIGEST}"

    - name: Install Trivy
      run: |
        wget https://github.com/aquasecurity/trivy/releases/latest/download/trivy_0.50.0_Linux-64bit.deb
        sudo dpkg -i trivy_0.50.0_Linux-64bit.deb

    - name: Vulnerability scan
      run: |
        IMAGE_DIGEST="${{ steps.build-push.outputs.digest }}"
        trivy image \
          --exit-code 1 \
          --severity HIGH,CRITICAL \
          --ignore-unfixed \
          --format sarif \
          --output trivy-results.sarif \
          "${REGISTRY}/${IMAGE_NAME}@${IMAGE_DIGEST}"

    - name: Upload Trivy results to GitHub Security
      uses: github/codeql-action/upload-sarif@v3
      with:
        sarif_file: trivy-results.sarif
      if: always()
```

## Image Signing with Cosign

### Cosign Key Management Strategies

Cosign supports three signing modes:

**1. Key-based signing** — traditional approach with managed keys:

```bash
# Generate a key pair (store private key in a secrets manager, not in Git)
cosign generate-key-pair --output-key-prefix cosign

# This generates:
# cosign.key  — private signing key (keep secret)
# cosign.pub  — public verification key (commit to repository)

# Sign an image
cosign sign --key cosign.key \
  registry.internal.example.com/production/api@sha256:abc123...

# Verify a signature
cosign verify --key cosign.pub \
  registry.internal.example.com/production/api@sha256:abc123...
```

**2. Keyless signing** — uses OIDC identity (recommended for CI/CD):

```bash
# Sign using GitHub Actions OIDC identity (run from within GitHub Actions)
COSIGN_EXPERIMENTAL=1 cosign sign --yes \
  registry.internal.example.com/production/api@sha256:abc123...

# Verify keyless signature
COSIGN_EXPERIMENTAL=1 cosign verify \
  --certificate-identity-regexp "https://github.com/your-org/your-repo/.github/workflows/.*" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  registry.internal.example.com/production/api@sha256:abc123...
```

**3. KMS-backed signing** — keys stored in cloud KMS:

```bash
# Sign using AWS KMS
cosign sign --key awskms:///arn:aws:kms:us-east-1:123456789:key/key-id \
  registry.internal.example.com/production/api@sha256:abc123...

# Sign using GCP KMS
cosign sign --key gcpkms://projects/PROJECT/locations/LOCATION/keyRings/KEYRING/cryptoKeys/KEY \
  registry.internal.example.com/production/api@sha256:abc123...

# Sign using HashiCorp Vault Transit
cosign sign --key hashivault://transit/keys/cosign-key \
  registry.internal.example.com/production/api@sha256:abc123...
```

### SLSA Provenance Generation

SLSA (Supply-chain Levels for Software Artifacts) provenance attestations document the build process:

```bash
# Generate SLSA provenance attestation with cosign
cosign attest --yes \
  --predicate slsa-provenance.json \
  --type slsaprovenance \
  registry.internal.example.com/production/api@sha256:abc123...

# Verify attestation
cosign verify-attestation \
  --type slsaprovenance \
  --key cosign.pub \
  registry.internal.example.com/production/api@sha256:abc123...
```

## Enforcing Image Signatures with Kyverno

### Kyverno Image Verification Policies

Kyverno can enforce that only signed images are admitted to specific namespaces:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
  annotations:
    policies.kyverno.io/title: Verify Image Signatures
    policies.kyverno.io/category: Supply Chain Security
    policies.kyverno.io/severity: high
    policies.kyverno.io/description: >-
      Requires all container images in production to be signed with
      the organization's Cosign key. Prevents deployment of unsigned
      or tampered images.
spec:
  validationFailureAction: Enforce
  background: false
  webhookTimeoutSeconds: 30
  rules:
  - name: verify-production-images
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaceSelector:
            matchLabels:
              environment: production
    verifyImages:
    - imageReferences:
      - "registry.internal.example.com/production/*"
      attestors:
      - count: 1
        entries:
        - keys:
            publicKeys: |-
              -----BEGIN PUBLIC KEY-----
              MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
              -----END PUBLIC KEY-----
            rekor:
              url: https://rekor.sigstore.dev
            ctlog:
              url: https://ctfe.sigstore.dev
      # Require SBOM attestation
      attestations:
      - predicateType: https://spdx.dev/Document
        attestors:
        - count: 1
          entries:
          - keys:
              publicKeys: |-
                -----BEGIN PUBLIC KEY-----
                MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
                -----END PUBLIC KEY-----
  - name: verify-ci-built-images
    match:
      any:
      - resources:
          kinds:
          - Pod
    verifyImages:
    - imageReferences:
      - "registry.internal.example.com/*"
      attestors:
      - count: 1
        entries:
        - keyless:
            subject: "https://github.com/your-org/your-repo/.github/workflows/build.yml@refs/heads/main"
            issuer: "https://token.actions.githubusercontent.com"
            rekor:
              url: https://rekor.sigstore.dev
    mutateDigest: true      # Replace tag references with digest references
    verifyDigest: true      # Verify digest has not changed
    required: true          # Block pod if verification fails
```

### Verifying SBOMs Before Admission

Extend the Kyverno policy to validate SBOM content:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-sbom-attestation
spec:
  validationFailureAction: Enforce
  background: false
  rules:
  - name: check-sbom-exists
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaceSelector:
            matchLabels:
              environment: production
    verifyImages:
    - imageReferences:
      - "registry.internal.example.com/production/*"
      attestations:
      - predicateType: https://spdx.dev/Document
        conditions:
        - all:
          - key: "{{ documentNamespace }}"
            operator: NotEquals
            value: ""
          - key: "{{ packages | length(@) }}"
            operator: GreaterThan
            value: "0"
      attestors:
      - entries:
        - keyless:
            subject: "https://github.com/your-org/*"
            issuer: "https://token.actions.githubusercontent.com"
```

## Trivy Vulnerability Scanning in CI

### Trivy Integration Patterns

Trivy can scan images at multiple stages of the pipeline:

```bash
# Scan a local image during build
trivy image --exit-code 1 \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  my-app:latest

# Scan with JSON output for processing
trivy image \
  --format json \
  --output trivy-report.json \
  registry.internal.example.com/production/api:v2.1.0

# Scan a filesystem (in CI before docker build)
trivy fs \
  --exit-code 1 \
  --severity HIGH,CRITICAL \
  --security-checks vuln,config,secret \
  .

# Scan Kubernetes cluster for vulnerabilities
trivy k8s \
  --report summary \
  --severity HIGH,CRITICAL \
  --namespace production \
  cluster

# Scan container configurations (IaC-style)
trivy config \
  --severity HIGH,CRITICAL \
  --exit-code 1 \
  kubernetes/deployments/
```

### Configuring Trivy in Harbor for Continuous Scanning

Configure Harbor to automatically scan images on push:

```bash
# Enable auto-scan at project level
curl -u "admin:${HARBOR_PASS}" \
  -X PUT "${HARBOR_URL}/api/v2.0/projects/production" \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "auto_scan": "true",
      "prevent_vul": "true",
      "severity": "high"
    }
  }'

# Set up scheduled scan of all images (every 6 hours)
curl -u "admin:${HARBOR_PASS}" \
  -X POST "${HARBOR_URL}/api/v2.0/system/scanAll/schedule" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": {
      "type": "Custom",
      "cron": "0 0 */6 * * *"
    }
  }'
```

### Trivy Operator for Continuous Cluster Scanning

The Trivy Operator runs continuously in the cluster and reports vulnerabilities as Kubernetes Custom Resources:

```bash
# Install Trivy Operator
helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm repo update

helm install trivy-operator aqua/trivy-operator \
  --namespace trivy-system \
  --create-namespace \
  --set="trivy.ignoreUnfixed=true" \
  --set="trivy.severity=HIGH\,CRITICAL" \
  --set="operator.scannerReportTTL=168h" \
  --set="compliance.failEntriesLimit=10" \
  --wait
```

Query vulnerability reports:

```bash
# List all vulnerability reports
kubectl get vulnerabilityreports -A

# Check vulnerabilities in production namespace
kubectl get vulnerabilityreports -n production -o wide

# Get detailed vulnerability report for a specific workload
kubectl get vulnerabilityreport \
  -n production \
  replicaset-api-deployment-abc123-api \
  -o yaml

# Find all critical vulnerabilities across the cluster
kubectl get vulnerabilityreports -A \
  -o json | \
  jq -r '.items[] | select(.report.summary.criticalCount > 0) |
    "\(.metadata.namespace)/\(.metadata.name): \(.report.summary.criticalCount) critical"'
```

## OCI Artifact Storage for Helm Charts and Configs

### Using Harbor as OCI Registry for Helm

Harbor supports OCI-compliant Helm chart storage:

```bash
# Log in to OCI registry
helm registry login registry.internal.example.com \
  --username robot-ci \
  --password robot-token

# Package and push a Helm chart
helm package ./charts/api
helm push api-2.1.0.tgz oci://registry.internal.example.com/helm-charts

# Pull and install from OCI registry
helm pull oci://registry.internal.example.com/helm-charts/api \
  --version 2.1.0

helm install api \
  oci://registry.internal.example.com/helm-charts/api \
  --version 2.1.0 \
  --namespace production
```

### Storing OPA Policies as OCI Artifacts

Store policy bundles as OCI artifacts:

```bash
# Push OPA bundle as OCI artifact
oras push registry.internal.example.com/policies/opa-bundle:v1.0.0 \
  --manifest-config /dev/null:application/vnd.unknown.config.v1+json \
  bundle.tar.gz:application/vnd.opa.bundle.v1+tar+gzip
```

## Registry Garbage Collection

### Automated Garbage Collection in Harbor

Unreferenced layers accumulate over time. Configure scheduled garbage collection:

```bash
# Configure garbage collection schedule (daily at 2 AM)
curl -u "admin:${HARBOR_PASS}" \
  -X POST "${HARBOR_URL}/api/v2.0/system/gc/schedule" \
  -H "Content-Type: application/json" \
  -d '{
    "schedule": {
      "type": "Custom",
      "cron": "0 0 2 * * *"
    },
    "parameters": {
      "delete_untagged": true,
      "workers": 1
    }
  }'

# Check garbage collection status
curl -u "admin:${HARBOR_PASS}" \
  "${HARBOR_URL}/api/v2.0/system/gc/latest" | jq .
```

### Image Retention Policies

Configure retention policies to automatically delete old images:

```bash
# Create retention policy: keep last 10 tags per repository in production
curl -u "admin:${HARBOR_PASS}" \
  -X POST "${HARBOR_URL}/api/v2.0/retentions" \
  -H "Content-Type: application/json" \
  -d '{
    "algorithm": "or",
    "rules": [
      {
        "action": "retain",
        "template": "latestActiveK",
        "params": {
          "latestActiveK": 10
        },
        "scope_selectors": {
          "repository": [
            {
              "kind": "doublestar",
              "decoration": "repoMatches",
              "pattern": "**"
            }
          ]
        },
        "tag_selectors": [
          {
            "kind": "doublestar",
            "decoration": "matches",
            "pattern": "**"
          }
        ]
      }
    ],
    "trigger": {
      "kind": "Schedule",
      "settings": {
        "cron": "0 0 3 * * *"
      }
    },
    "scope": {
      "level": "project",
      "ref": 1
    }
  }'
```

## Air-Gapped Environment Setup

### Preparing an Air-Gapped Registry

For environments without internet access, all required images must be pre-loaded:

```bash
#!/bin/bash
# save-images.sh — run in internet-connected environment

IMAGES=(
  "registry.k8s.io/kube-apiserver:v1.29.0"
  "registry.k8s.io/kube-controller-manager:v1.29.0"
  "registry.k8s.io/kube-scheduler:v1.29.0"
  "registry.k8s.io/kube-proxy:v1.29.0"
  "registry.k8s.io/coredns/coredns:v1.11.1"
  "registry.k8s.io/etcd:3.5.10-0"
  "registry.k8s.io/pause:3.9"
  "quay.io/prometheus/prometheus:v2.49.0"
  "grafana/grafana:10.3.1"
  "docker.io/calico/node:v3.27.0"
  "docker.io/calico/cni:v3.27.0"
)

mkdir -p /tmp/airgap-images

for image in "${IMAGES[@]}"; do
  echo "Pulling: ${image}"
  docker pull "${image}"

  # Create safe filename
  filename=$(echo "${image}" | tr '/:' '__')
  echo "Saving: ${filename}.tar"
  docker save "${image}" -o "/tmp/airgap-images/${filename}.tar"
done

# Create a manifest for import
echo "${IMAGES[@]}" | tr ' ' '\n' > /tmp/airgap-images/manifest.txt

# Bundle for transfer
tar czf airgap-images.tar.gz -C /tmp airgap-images/
echo "Bundle ready: airgap-images.tar.gz"
```

Load and push images in the air-gapped environment:

```bash
#!/bin/bash
# load-and-push.sh — run in air-gapped environment

REGISTRY="registry.internal.example.com"
HARBOR_USER="admin"
HARBOR_PASS="${HARBOR_ADMIN_PASSWORD}"

# Log in
docker login "${REGISTRY}" -u "${HARBOR_USER}" -p "${HARBOR_PASS}"

# Extract bundle
tar xzf airgap-images.tar.gz

# Load and retag each image
while IFS= read -r original_image; do
  echo "Processing: ${original_image}"

  # Create safe filename (same logic as save script)
  filename=$(echo "${original_image}" | tr '/:' '__')

  # Load image
  docker load -i "airgap-images/${filename}.tar"

  # Create internal registry path
  # e.g., registry.k8s.io/pause:3.9 -> registry.internal.example.com/k8s-mirror/pause:3.9
  image_path=$(echo "${original_image}" | cut -d'/' -f2-)
  registry_prefix=$(echo "${original_image}" | cut -d'/' -f1 | tr '.' '-')
  internal_tag="${REGISTRY}/${registry_prefix}/${image_path}"

  # Retag and push
  docker tag "${original_image}" "${internal_tag}"
  docker push "${internal_tag}"

  echo "Pushed: ${internal_tag}"
done < airgap-images/manifest.txt

echo "All images loaded and pushed to internal registry"
```

## Monitoring Registry Health

### Prometheus Metrics for Harbor

Configure Prometheus to scrape Harbor metrics:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: harbor-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: harbor
      component: core
  endpoints:
  - port: http-metrics
    interval: 30s
    path: /metrics
  namespaceSelector:
    matchNames:
    - harbor
```

Key Harbor alerts:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: harbor-alerts
  namespace: monitoring
spec:
  groups:
  - name: harbor
    rules:
    - alert: HarborRegistryDown
      expr: up{job="harbor-core"} == 0
      for: 5m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Harbor registry is down"
        description: "Harbor registry has been unavailable for 5 minutes"

    - alert: HarborHighVulnerabilityCount
      expr: harbor_project_repo_count{} > 0 and harbor_project_vulnerability_count{severity="Critical"} > 10
      for: 1h
      labels:
        severity: high
        team: security
      annotations:
        summary: "High number of critical vulnerabilities in Harbor project"
        description: "Project {{ $labels.project }} has {{ $value }} critical vulnerabilities"

    - alert: HarborStorageUsageHigh
      expr: (harbor_registry_storage_used_bytes / harbor_registry_storage_total_bytes) > 0.85
      for: 15m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Harbor storage usage is above 85%"
        description: "Harbor is using {{ $value | humanizePercentage }} of available storage"
```

## Conclusion

A mature Kubernetes image registry strategy requires depth at every layer. Harbor provides the private registry foundation with integrated scanning and access control. containerd mirror configuration eliminates external registry dependencies and rate limiting risks. Image signing with Cosign and SBOM generation with Syft create cryptographic provenance for every artifact in the software supply chain. Kyverno admission policies ensure only verified, signed images reach production clusters.

Together, these controls address the primary supply chain attack vectors: compromised upstream images, mutable tags, unknown component inventories, and unauthorized image modifications. The investment in this infrastructure also satisfies supply chain security requirements from SLSA, NIST SSDF, and executive order 14028 for organizations operating in regulated environments.
