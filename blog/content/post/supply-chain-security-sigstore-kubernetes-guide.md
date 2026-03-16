---
title: "Supply Chain Security with Sigstore: Implementing Cryptographic Verification for Container Images in Kubernetes"
date: 2026-11-28T00:00:00-05:00
draft: false
tags: ["Sigstore", "Supply Chain Security", "Kubernetes", "Cosign", "Rekor", "Container Security", "Image Signing"]
categories: ["Kubernetes", "Security", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing supply chain security with Sigstore in Kubernetes environments, covering Cosign image signing, Rekor transparency logs, and automated verification policies for enterprise deployments."
more_link: "yes"
url: "/supply-chain-security-sigstore-kubernetes-guide/"
---

Supply chain security has become a critical concern for organizations running containerized workloads in production. Sigstore provides an open-source framework for signing, verifying, and protecting software supply chains using cryptographic signatures and transparency logs. This comprehensive guide explores implementing Sigstore in enterprise Kubernetes environments, covering image signing with Cosign, transparency logging with Rekor, and automated verification policies.

Understanding supply chain security is essential for organizations facing regulatory requirements, seeking to prevent supply chain attacks, and maintaining trust in their software delivery pipelines. This guide provides production-ready implementations, CI/CD integration patterns, and operational best practices.

<!--more-->

# Supply Chain Security with Sigstore

## Understanding Sigstore Components

### Core Sigstore Services

**Cosign**
- Sign and verify container images and artifacts
- Support for keyless signing with OIDC providers
- Hardware token integration (YubiKey, etc.)
- OCI registry compatibility

**Rekor**
- Immutable transparency log for signatures
- Cryptographic proof of signature creation time
- Public audit trail for verification
- Integration with Sigstore ecosystem

**Fulcio**
- Certificate Authority for code signing
- OIDC-based identity verification
- Short-lived certificates (10-20 minutes)
- No long-term key management required

**Policy Controller**
- Kubernetes admission controller for signature verification
- Enforce signature requirements cluster-wide
- Support for complex policy definitions
- Integration with attestation frameworks

### Security Benefits

1. **Authenticity**: Verify image publisher identity
2. **Integrity**: Detect image tampering
3. **Non-repudiation**: Immutable proof of signing
4. **Transparency**: Public audit trail in Rekor
5. **Compliance**: Meet regulatory requirements
6. **Defense-in-depth**: Additional security layer

## Setting Up Cosign

### Installation and Configuration

Install Cosign CLI:

```bash
#!/bin/bash
# install-cosign.sh

COSIGN_VERSION="v2.2.0"

# Install Cosign
curl -Lo cosign https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64
chmod +x cosign
sudo mv cosign /usr/local/bin/

# Verify installation
cosign version

# Initialize Cosign (optional - for key-based signing)
cosign initialize
```

### Key-Based Signing

Generate signing keys:

```bash
#!/bin/bash
# generate-signing-keys.sh

# Generate key pair
cosign generate-key-pair

# This creates:
# - cosign.key (private key - keep secure!)
# - cosign.pub (public key - distribute widely)

# Store private key in secret management system
# For example, HashiCorp Vault:
vault kv put secret/cosign/signing-key \
    private-key=@cosign.key \
    public-key=@cosign.pub

# Or Kubernetes Secret (for CI/CD):
kubectl create secret generic cosign-signing-key \
    --from-file=cosign.key=cosign.key \
    --from-file=cosign.pub=cosign.pub \
    -n ci-system

# Clean up local files
shred -u cosign.key
```

### Keyless Signing with OIDC

Configure keyless signing using GitHub Actions:

```bash
# Keyless signing - no key management required
cosign sign --oidc-issuer=https://token.actions.githubusercontent.com \
    gcr.io/mycompany/myapp:v1.0.0

# Verification
cosign verify \
    --certificate-identity-regexp=".*" \
    --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
    gcr.io/mycompany/myapp:v1.0.0
```

## Container Image Signing

### CI/CD Integration - GitHub Actions

Complete GitHub Actions workflow with Cosign:

```yaml
# .github/workflows/build-sign-push.yml
name: Build, Sign, and Push Container Image

on:
  push:
    branches: [ main ]
    tags: [ 'v*' ]

env:
  REGISTRY: gcr.io
  IMAGE_NAME: mycompany/myapp

permissions:
  contents: read
  packages: write
  id-token: write  # Required for keyless signing

jobs:
  build-sign-push:
    runs-on: ubuntu-latest
    steps:
    - name: Checkout code
      uses: actions/checkout@v3

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@v2

    - name: Install Cosign
      uses: sigstore/cosign-installer@v3
      with:
        cosign-release: 'v2.2.0'

    - name: Log in to Container Registry
      uses: docker/login-action@v2
      with:
        registry: ${{ env.REGISTRY }}
        username: _json_key
        password: ${{ secrets.GCR_JSON_KEY }}

    - name: Extract metadata
      id: meta
      uses: docker/metadata-action@v4
      with:
        images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
        tags: |
          type=ref,event=branch
          type=ref,event=pr
          type=semver,pattern={{version}}
          type=semver,pattern={{major}}.{{minor}}
          type=sha,prefix={{branch}}-

    - name: Build and push image
      id: build
      uses: docker/build-push-action@v4
      with:
        context: .
        push: true
        tags: ${{ steps.meta.outputs.tags }}
        labels: ${{ steps.meta.outputs.labels }}
        cache-from: type=gha
        cache-to: type=gha,mode=max
        provenance: true
        sbom: true

    - name: Sign container image (keyless)
      env:
        DIGEST: ${{ steps.build.outputs.digest }}
        TAGS: ${{ steps.meta.outputs.tags }}
      run: |
        echo "Signing image with digest: ${DIGEST}"
        for tag in ${TAGS}; do
          echo "Signing ${tag}"
          cosign sign --yes "${tag}@${DIGEST}"
        done

    - name: Generate SBOM
      uses: anchore/sbom-action@v0
      with:
        image: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}
        format: spdx-json
        output-file: sbom.spdx.json

    - name: Attach SBOM to image
      run: |
        cosign attach sbom \
          --sbom sbom.spdx.json \
          ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}

    - name: Sign SBOM
      run: |
        cosign sign --yes \
          --attachment sbom \
          ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}

    - name: Verify signatures
      run: |
        cosign verify \
          --certificate-identity-regexp="https://github.com/${{ github.repository }}" \
          --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
          ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}
```

### GitLab CI Integration

```yaml
# .gitlab-ci.yml
variables:
  IMAGE_NAME: registry.gitlab.com/mycompany/myapp
  COSIGN_VERSION: "v2.2.0"

stages:
  - build
  - sign
  - verify

build:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  before_script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  script:
    - docker build -t ${IMAGE_NAME}:${CI_COMMIT_SHA} .
    - docker push ${IMAGE_NAME}:${CI_COMMIT_SHA}
    - echo "IMAGE_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' ${IMAGE_NAME}:${CI_COMMIT_SHA} | cut -d'@' -f2)" >> build.env
  artifacts:
    reports:
      dotenv: build.env

sign:
  stage: sign
  image: alpine:latest
  dependencies:
    - build
  before_script:
    - apk add --no-cache curl
    - curl -Lo cosign https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64
    - chmod +x cosign
    - mv cosign /usr/local/bin/
  script:
    - echo "${COSIGN_PRIVATE_KEY}" | base64 -d > cosign.key
    - cosign sign --key cosign.key --yes ${IMAGE_NAME}@${IMAGE_DIGEST}
    - rm -f cosign.key
  only:
    - main
    - tags

verify:
  stage: verify
  image: alpine:latest
  dependencies:
    - build
  before_script:
    - apk add --no-cache curl
    - curl -Lo cosign https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64
    - chmod +x cosign
    - mv cosign /usr/local/bin/
  script:
    - echo "${COSIGN_PUBLIC_KEY}" | base64 -d > cosign.pub
    - cosign verify --key cosign.pub ${IMAGE_NAME}@${IMAGE_DIGEST}
  only:
    - main
    - tags
```

## Implementing Policy Controller

### Installation

Deploy Sigstore Policy Controller to Kubernetes:

```bash
#!/bin/bash
# install-policy-controller.sh

# Add Sigstore Helm repository
helm repo add sigstore https://sigstore.github.io/helm-charts
helm repo update

# Create namespace
kubectl create namespace cosign-system

# Install Policy Controller
helm install policy-controller sigstore/policy-controller \
    --namespace cosign-system \
    --set webhook.replicaCount=3 \
    --set webhook.resources.requests.cpu=100m \
    --set webhook.resources.requests.memory=128Mi \
    --set webhook.resources.limits.cpu=500m \
    --set webhook.resources.limits.memory=512Mi \
    --create-namespace

# Verify installation
kubectl get pods -n cosign-system
kubectl get validatingwebhookconfigurations
```

### Basic Policy Configuration

Define a ClusterImagePolicy for signature verification:

```yaml
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: require-signed-images
spec:
  images:
  - glob: "gcr.io/mycompany/**"
  - glob: "registry.gitlab.com/mycompany/**"
  authorities:
  - keyless:
      url: https://fulcio.sigstore.dev
      identities:
      - issuerRegExp: ".*"
        subjectRegExp: ".*@mycompany\\.com$"
    ctlog:
      url: https://rekor.sigstore.dev
```

### Advanced Policy Patterns

**Key-Based Verification**

```yaml
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: production-images-signed
spec:
  images:
  - glob: "gcr.io/mycompany/prod-*"
  authorities:
  - key:
      data: |
        -----BEGIN PUBLIC KEY-----
        MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
        -----END PUBLIC KEY-----
    ctlog:
      url: https://rekor.sigstore.dev
```

**Multiple Authority Support**

```yaml
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: multi-authority-policy
spec:
  images:
  - glob: "gcr.io/mycompany/**"
  authorities:
  # Require signature from CI system
  - keyless:
      url: https://fulcio.sigstore.dev
      identities:
      - issuer: https://token.actions.githubusercontent.com
        subjectRegExp: "https://github.com/mycompany/.*"
  # OR require signature from security team
  - key:
      secretRef:
        name: security-team-public-key
    ctlog:
      url: https://rekor.sigstore.dev
  # Require attestation
  - attestations:
    - name: must-have-sbom
      predicateType: https://spdx.dev/Document
      policy:
        type: cue
        data: |
          predicateType: "https://spdx.dev/Document"
```

**Namespace-Scoped Policies**

```yaml
apiVersion: policy.sigstore.dev/v1beta1
kind: ImagePolicy
metadata:
  name: development-policy
  namespace: development
spec:
  images:
  - glob: "**"
  authorities:
  - keyless:
      url: https://fulcio.sigstore.dev
      identities:
      - issuerRegExp: ".*"
        subjectRegExp: ".*"
  policy:
    type: cue
    data: |
      // More permissive for development
      predicateType: "*"
---
apiVersion: policy.sigstore.dev/v1beta1
kind: ImagePolicy
metadata:
  name: production-policy
  namespace: production
spec:
  images:
  - glob: "**"
  authorities:
  - key:
      secretRef:
        name: production-signing-key
    ctlog:
      url: https://rekor.sigstore.dev
  policy:
    type: cue
    data: |
      // Strict validation for production
      import "time"

      // Signature must be recent
      before: time.Now()
      after: time.Now().Add(-24 * time.Hour)

      // Require specific annotations
      annotations: {
        "security-scan": "passed"
        "vulnerability-scan": "passed"
      }
```

## Attestation and SBOM

### Generating Attestations

Create in-toto attestations for images:

```bash
#!/bin/bash
# generate-attestation.sh

IMAGE="gcr.io/mycompany/myapp@sha256:abc123..."

# Generate build attestation
cosign attest --yes \
    --predicate=<(cat <<EOF
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "subject": [
    {
      "name": "${IMAGE}",
      "digest": {
        "sha256": "abc123..."
      }
    }
  ],
  "predicate": {
    "builder": {
      "id": "https://github.com/mycompany/myapp/actions/runs/123456"
    },
    "buildType": "https://github.com/Attestations/GitHubActionsWorkflow@v1",
    "invocation": {
      "configSource": {
        "uri": "git+https://github.com/mycompany/myapp",
        "digest": {
          "sha1": "abc123"
        },
        "entryPoint": ".github/workflows/build.yml"
      }
    },
    "metadata": {
      "buildStartedOn": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
      "buildFinishedOn": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    },
    "materials": [
      {
        "uri": "git+https://github.com/mycompany/myapp",
        "digest": {
          "sha1": "abc123"
        }
      }
    ]
  }
}
EOF
) \
    "${IMAGE}"

# Generate vulnerability scan attestation
cosign attest --yes \
    --type vuln \
    --predicate=<(grype -o json "${IMAGE}") \
    "${IMAGE}"

# Generate SLSA provenance
cosign attest --yes \
    --type slsaprovenance \
    --predicate=slsa-provenance.json \
    "${IMAGE}"
```

### SBOM Signing and Verification

```bash
#!/bin/bash
# sbom-workflow.sh

IMAGE="gcr.io/mycompany/myapp:v1.0.0"

# Generate SBOM with Syft
syft packages "${IMAGE}" -o spdx-json > sbom.spdx.json

# Attach SBOM to image
cosign attach sbom --sbom sbom.spdx.json "${IMAGE}"

# Sign the SBOM
cosign sign --yes --attachment sbom "${IMAGE}"

# Verify SBOM signature
cosign verify --attachment sbom \
    --certificate-identity-regexp=".*" \
    --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
    "${IMAGE}"

# Download and inspect SBOM
cosign download sbom "${IMAGE}" | jq .
```

## Private Sigstore Infrastructure

### Deploying Private Rekor

Deploy your own Rekor transparency log:

```yaml
# rekor-deployment.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: sigstore-system
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rekor-server
  namespace: sigstore-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: rekor-server
  template:
    metadata:
      labels:
        app: rekor-server
    spec:
      containers:
      - name: rekor
        image: gcr.io/projectsigstore/rekor-server:latest
        args:
        - serve
        - --trillian_log_server.address=trillian-log-server:8090
        - --trillian_log_server.tlog_id=$(TREE_ID)
        - --redis_server.address=redis:6379
        - --rekor_server.address=0.0.0.0:3000
        - --enable_attestation_storage
        - --attestation_storage_bucket=$(GCS_BUCKET)
        ports:
        - containerPort: 3000
          name: http
        - containerPort: 2112
          name: metrics
        env:
        - name: TREE_ID
          valueFrom:
            configMapKeyRef:
              name: rekor-config
              key: treeID
        - name: GCS_BUCKET
          value: rekor-attestations
        livenessProbe:
          httpGet:
            path: /ping
            port: 3000
          initialDelaySeconds: 10
        readinessProbe:
          httpGet:
            path: /ping
            port: 3000
          initialDelaySeconds: 5
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
---
apiVersion: v1
kind: Service
metadata:
  name: rekor-server
  namespace: sigstore-system
spec:
  selector:
    app: rekor-server
  ports:
  - name: http
    port: 80
    targetPort: 3000
  - name: metrics
    port: 2112
    targetPort: 2112
---
# Trillian Log Server
apiVersion: apps/v1
kind: Deployment
metadata:
  name: trillian-log-server
  namespace: sigstore-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: trillian-log-server
  template:
    metadata:
      labels:
        app: trillian-log-server
    spec:
      containers:
      - name: trillian
        image: gcr.io/trillian-opensource-ci/log_server:latest
        args:
        - --storage_system=mysql
        - --mysql_uri=$(MYSQL_USER):$(MYSQL_PASSWORD)@tcp($(MYSQL_HOST):3306)/$(MYSQL_DATABASE)
        - --rpc_endpoint=0.0.0.0:8090
        - --http_endpoint=0.0.0.0:8091
        - --alsologtostderr
        ports:
        - containerPort: 8090
          name: grpc
        - containerPort: 8091
          name: http
        env:
        - name: MYSQL_HOST
          value: mysql
        - name: MYSQL_USER
          valueFrom:
            secretKeyRef:
              name: trillian-mysql
              key: username
        - name: MYSQL_PASSWORD
          valueFrom:
            secretKeyRef:
              name: trillian-mysql
              key: password
        - name: MYSQL_DATABASE
          value: trillian
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
---
apiVersion: v1
kind: Service
metadata:
  name: trillian-log-server
  namespace: sigstore-system
spec:
  selector:
    app: trillian-log-server
  ports:
  - name: grpc
    port: 8090
    targetPort: 8090
  - name: http
    port: 8091
    targetPort: 8091
```

### Private Fulcio CA

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fulcio-server
  namespace: sigstore-system
spec:
  replicas: 3
  selector:
    matchLabels:
      app: fulcio-server
  template:
    metadata:
      labels:
        app: fulcio-server
    spec:
      serviceAccountName: fulcio-server
      containers:
      - name: fulcio
        image: gcr.io/projectsigstore/fulcio:latest
        args:
        - serve
        - --port=5555
        - --grpc-port=5554
        - --ca=pkcs11ca
        - --hsm-caroot-id=1
        - --ct-log-url=http://ctlog-server/test
        - --log_type=prod
        ports:
        - containerPort: 5555
          name: http
        - containerPort: 5554
          name: grpc
        - containerPort: 2112
          name: metrics
        volumeMounts:
        - name: fulcio-config
          mountPath: /etc/fulcio-config
          readOnly: true
        env:
        - name: FULCIO_CONFIG
          value: /etc/fulcio-config/config.json
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 1Gi
      volumes:
      - name: fulcio-config
        configMap:
          name: fulcio-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: fulcio-config
  namespace: sigstore-system
data:
  config.json: |
    {
      "OIDCIssuers": {
        "https://accounts.google.com": {
          "IssuerURL": "https://accounts.google.com",
          "ClientID": "sigstore",
          "Type": "email"
        },
        "https://token.actions.githubusercontent.com": {
          "IssuerURL": "https://token.actions.githubusercontent.com",
          "ClientID": "sigstore",
          "Type": "github-workflow"
        }
      },
      "MetaIssuers": {
        "https://oidc.example.com/*": {
          "ClientID": "sigstore",
          "Type": "uri"
        }
      }
    }
```

## Monitoring and Auditing

### Prometheus Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: policy-controller
  namespace: cosign-system
spec:
  selector:
    matchLabels:
      app: policy-controller
  endpoints:
  - port: metrics
    interval: 30s
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: sigstore-alerts
  namespace: cosign-system
spec:
  groups:
  - name: sigstore
    interval: 30s
    rules:
    - alert: UnsignedImageRejected
      expr: rate(cosign_policy_webhook_request_count{result="deny"}[5m]) > 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High rate of unsigned image rejections"
        description: "Namespace {{ $labels.namespace }} has high unsigned image rejection rate"

    - alert: SignatureVerificationFailure
      expr: rate(cosign_policy_signature_verification_errors_total[5m]) > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Signature verification failures detected"
        description: "Image verification failing for {{ $labels.image }}"

    - alert: RekorUnavailable
      expr: up{job="rekor-server"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Rekor transparency log unavailable"
        description: "Rekor service is down"
```

### Audit Logging

Query Rekor for signature audit:

```bash
#!/bin/bash
# audit-signatures.sh

# Search for signatures by subject
rekor-cli search --email developer@mycompany.com

# Get signature details
rekor-cli get --uuid <uuid>

# Verify signature in Rekor
rekor-cli verify --uuid <uuid> \
    --artifact /path/to/image.tar.gz \
    --signature /path/to/signature

# Search by artifact hash
rekor-cli search --sha sha256:abc123...

# Export audit log
rekor-cli loginfo --format json > rekor-audit.json
```

## Troubleshooting

### Common Issues

**Issue 1: Signature Verification Failures**

```bash
# Check policy configuration
kubectl get clusterimagepolicy -A -o yaml

# View webhook logs
kubectl logs -n cosign-system deployment/policy-controller-webhook

# Test verification manually
cosign verify \
    --certificate-identity-regexp=".*" \
    --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
    gcr.io/mycompany/myapp:v1.0.0

# Check Rekor entry
rekor-cli search --artifact gcr.io/mycompany/myapp:v1.0.0
```

**Issue 2: Keyless Signing Failures**

```bash
# Verify OIDC token
curl -H "Authorization: bearer ${OIDC_TOKEN}" \
    https://fulcio.sigstore.dev/api/v1/rootCert

# Check Fulcio connectivity
curl https://fulcio.sigstore.dev/api/v1/rootCert

# Verify Rekor connectivity
curl https://rekor.sigstore.dev/api/v1/log

# Test with verbose logging
COSIGN_EXPERIMENTAL=1 cosign sign -v=9 \
    gcr.io/mycompany/myapp:v1.0.0
```

**Issue 3: Policy Controller Rejections**

```bash
# Check admission webhook configuration
kubectl get validatingwebhookconfigurations \
    -l app.kubernetes.io/name=policy-controller

# Test pod creation
kubectl run test --image=gcr.io/mycompany/myapp:v1.0.0 \
    --dry-run=server

# Check policy evaluation
kubectl logs -n cosign-system deployment/policy-controller-webhook \
    --tail=100 | grep -A 10 "policy evaluation"

# Describe rejected pod
kubectl describe pod <pod-name>
```

## Best Practices

### Production Deployment

1. **High Availability**: Deploy multiple replicas of policy controller
2. **Private Infrastructure**: Run private Rekor/Fulcio for sensitive environments
3. **Key Management**: Use hardware security modules (HSM) for signing keys
4. **Automated Rotation**: Implement automated key rotation policies
5. **Monitoring**: Comprehensive metrics and alerting
6. **Disaster Recovery**: Backup Rekor logs and Fulcio certificates
7. **Testing**: Thorough testing in staging before production rollout

### Security Hardening

```yaml
# Secure policy controller deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: policy-controller-webhook
  namespace: cosign-system
spec:
  replicas: 3
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        fsGroup: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: webhook
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          capabilities:
            drop:
            - ALL
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
```

### Policy Governance

1. **Progressive Enforcement**: Start with warnings, move to enforcement
2. **Exemptions**: Define clear exemption processes
3. **Namespace Isolation**: Use namespace-scoped policies for flexibility
4. **Regular Audits**: Review Rekor logs regularly
5. **Compliance Reports**: Generate automated compliance reports
6. **Developer Training**: Educate teams on signing workflows

## Conclusion

Sigstore provides a comprehensive framework for securing software supply chains in Kubernetes environments. By implementing cryptographic signing, verification, and transparency logging, organizations can:

- Prevent unsigned or tampered images from running
- Maintain audit trails of all signatures
- Meet compliance and regulatory requirements
- Build trust in software delivery pipelines
- Detect and prevent supply chain attacks

Success with Sigstore requires careful planning, robust CI/CD integration, comprehensive policies, and ongoing operational excellence. When combined with other security controls like admission webhooks, Pod Security Standards, and runtime protection, Sigstore enables defense-in-depth security for cloud-native applications.