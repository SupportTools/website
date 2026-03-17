---
title: "Kubernetes GitOps with Flux and GitHub Actions: Automated Image Scanning and Progressive Delivery"
date: 2031-08-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Flux", "GitOps", "GitHub Actions", "Progressive Delivery", "Security"]
categories:
- Kubernetes
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing enterprise GitOps with Flux v2 and GitHub Actions, covering automated vulnerability scanning gates, progressive delivery with Flagger, and multi-environment promotion workflows."
more_link: "yes"
url: "/kubernetes-gitops-flux-github-actions-image-scanning-progressive-delivery/"
---

GitOps with Flux v2 combined with GitHub Actions creates a powerful, auditable deployment pipeline. This post builds a complete enterprise GitOps workflow: from code commit through vulnerability scanning, to automated staging deployment, security gate evaluation, and progressive production rollout with automated canary analysis and rollback.

<!--more-->

# Kubernetes GitOps with Flux and GitHub Actions: Automated Image Scanning and Progressive Delivery

## Overview

The workflow this post builds:

```
Developer PR → GitHub Actions CI
                │
                ├── Build container image
                ├── Trivy vulnerability scan
                ├── SBOM generation
                ├── Cosign image signing
                └── Push to GHCR
                            │
                    Flux Image Reflector watches GHCR
                            │
                    Flux Image Updater commits new tag
                    to GitOps repo (dev branch)
                            │
                    Flux reconciles dev cluster
                            │
                    Staging promotion PR (automated)
                            │
                    Staging deployment
                            │
                    Integration tests pass?
                            │
                    Production PR
                            │
                    Flagger canary analysis
                            │
                    Progressive traffic shift (10% → 50% → 100%)
                            │
                    Automated rollback on SLO violation
```

---

## Section 1: Repository Structure

```
gitops-repo/
├── clusters/
│   ├── dev/
│   │   ├── flux-system/           # Flux system components
│   │   └── apps/                  # App deployments
│   ├── staging/
│   │   ├── flux-system/
│   │   └── apps/
│   └── production/
│       ├── flux-system/
│       └── apps/
├── infrastructure/
│   ├── cert-manager/
│   ├── ingress-nginx/
│   └── flagger/
└── apps/
    ├── base/                      # Base Kustomize configs
    │   └── myapp/
    │       ├── deployment.yaml
    │       ├── service.yaml
    │       ├── kustomization.yaml
    │       └── hpa.yaml
    └── overlays/
        ├── dev/
        │   ├── kustomization.yaml
        │   └── values-patch.yaml
        ├── staging/
        └── production/
            ├── kustomization.yaml
            ├── values-patch.yaml
            └── canary.yaml        # Flagger Canary resource
```

---

## Section 2: Flux v2 Installation

### 2.1 Bootstrap Flux

```bash
# Install Flux CLI
curl -s https://fluxcd.io/install.sh | sudo bash

# Bootstrap Flux on the cluster
# This installs Flux components and creates a GitOps repository connection
flux bootstrap github \
  --owner=yourorg \
  --repository=gitops-repo \
  --branch=main \
  --path=clusters/production \
  --personal=false \
  --token-auth \
  --components-extra=image-reflector-controller,image-automation-controller

# Verify installation
flux check
kubectl get pods -n flux-system
```

### 2.2 Cluster-Per-Environment Bootstrap

```bash
# Bootstrap each cluster with its own path
# Development cluster
flux bootstrap github \
  --owner=yourorg \
  --repository=gitops-repo \
  --branch=main \
  --path=clusters/dev \
  --context=dev-cluster

# Staging cluster
flux bootstrap github \
  --owner=yourorg \
  --repository=gitops-repo \
  --branch=main \
  --path=clusters/staging \
  --context=staging-cluster

# Production cluster
flux bootstrap github \
  --owner=yourorg \
  --repository=gitops-repo \
  --branch=main \
  --path=clusters/production \
  --context=prod-cluster
```

---

## Section 3: GitHub Actions CI Pipeline

### 3.1 Build, Scan, Sign, Push

```yaml
# .github/workflows/ci.yaml
name: Build and Push

on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'Dockerfile'
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-scan-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write           # Required for Cosign OIDC signing
      security-events: write    # Required for SARIF upload

    outputs:
      image-digest: ${{ steps.build.outputs.digest }}
      image-tag: ${{ steps.meta.outputs.version }}

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
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
            type=sha,prefix=,suffix=,format=short
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=ref,event=branch
          flavor: |
            latest=auto

      - name: Build image (no push for PRs)
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          sbom: true              # Generate SBOM
          provenance: true        # Generate SLSA provenance

      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.version }}
          format: sarif
          output: trivy-results.sarif
          severity: CRITICAL,HIGH
          exit-code: '1'          # Fail on CRITICAL/HIGH vulnerabilities
          ignore-unfixed: true

      - name: Upload Trivy SARIF report
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy-results.sarif

      - name: Install Cosign
        uses: sigstore/cosign-installer@v3

      - name: Sign image with Cosign (OIDC keyless)
        if: github.event_name != 'pull_request'
        run: |
          cosign sign --yes \
            --rekor-url=https://rekor.sigstore.dev \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}

      - name: Generate SBOM with Syft
        if: github.event_name != 'pull_request'
        run: |
          docker run --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            anchore/syft:latest \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.version }} \
            -o spdx-json > sbom.json

      - name: Attach SBOM to image
        if: github.event_name != 'pull_request'
        run: |
          cosign attach sbom \
            --sbom sbom.json \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}

      - name: Sign SBOM attestation
        if: github.event_name != 'pull_request'
        run: |
          cosign attest --yes \
            --predicate sbom.json \
            --type spdxjson \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}
```

### 3.2 Security Scan Quality Gate

```yaml
# .github/workflows/security-gate.yaml
name: Security Gate

on:
  workflow_call:
    inputs:
      image-ref:
        required: true
        type: string
    outputs:
      passed:
        value: ${{ jobs.scan.outputs.passed }}

jobs:
  scan:
    runs-on: ubuntu-latest
    outputs:
      passed: ${{ steps.evaluate.outputs.passed }}

    steps:
      - name: Run comprehensive scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ inputs.image-ref }}
          format: json
          output: scan-results.json
          severity: CRITICAL,HIGH,MEDIUM
          ignore-unfixed: false

      - name: Evaluate security policy
        id: evaluate
        run: |
          # Policy: fail on any CRITICAL CVE or more than 5 HIGH CVEs
          CRITICALS=$(jq '[.Results[].Vulnerabilities[]? | select(.Severity=="CRITICAL")] | length' scan-results.json)
          HIGHS=$(jq '[.Results[].Vulnerabilities[]? | select(.Severity=="HIGH")] | length' scan-results.json)

          echo "Critical vulnerabilities: $CRITICALS"
          echo "High vulnerabilities: $HIGHS"

          if [ "$CRITICALS" -gt 0 ]; then
            echo "FAIL: $CRITICALS critical vulnerabilities found"
            echo "passed=false" >> $GITHUB_OUTPUT
            exit 1
          fi

          if [ "$HIGHS" -gt 5 ]; then
            echo "FAIL: $HIGHS high vulnerabilities exceeds threshold of 5"
            echo "passed=false" >> $GITHUB_OUTPUT
            exit 1
          fi

          echo "PASS: Security gate passed"
          echo "passed=true" >> $GITHUB_OUTPUT

      - name: Check Cosign signature
        run: |
          cosign verify \
            --certificate-identity-regexp=".*" \
            --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
            ${{ inputs.image-ref }} || echo "WARNING: Image not signed"
```

---

## Section 4: Flux Image Automation

### 4.1 Image Repository and Policy

```yaml
# clusters/dev/apps/myapp-image-policy.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: myapp
  namespace: flux-system
spec:
  image: ghcr.io/yourorg/myapp
  interval: 1m
  # Credentials for private registry
  secretRef:
    name: ghcr-credentials
  # Only scan tags matching this pattern
  exclusionList:
    - "^.*\\.sig$"     # Exclude Cosign signature tags
    - "^.*\\.sbom$"    # Exclude SBOM tags
    - "^sha-.*$"       # Exclude raw SHA tags if not desired

---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: myapp
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: myapp
  # Semver: only accept v1.x.x releases (no major version bumps)
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"
```

### 4.2 Image Update Automation

```yaml
# clusters/dev/apps/myapp-image-update.yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: myapp
  namespace: flux-system
spec:
  interval: 5m

  sourceRef:
    kind: GitRepository
    name: flux-system

  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxcdbot@yourorg.com
        name: FluxCD Bot
      messageTemplate: |
        chore(dev): update myapp to {{range .Updated.Images}}{{.NewTag}}{{end}}

        Updated by Flux Image Automation
        Repository: {{.AutomationObject.Namespace}}/{{.AutomationObject.Name}}
        [skip ci]
    push:
      branch: main

  update:
    path: ./apps/overlays/dev
    strategy: Setters
```

Image setter marker in Kustomize overlay:

```yaml
# apps/overlays/dev/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base/myapp

images:
  - name: ghcr.io/yourorg/myapp
    newTag: v1.4.2 # {"$imagepolicy": "flux-system:myapp:tag"}
```

---

## Section 5: Multi-Environment Promotion with GitHub Actions

### 5.1 Automated Staging Promotion

```yaml
# .github/workflows/promote-to-staging.yaml
name: Promote to Staging

on:
  push:
    branches: [main]
    paths:
      - 'apps/overlays/dev/**'

jobs:
  check-dev-health:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up kubectl
        uses: azure/setup-kubectl@v4

      - name: Configure kubectl for dev cluster
        run: |
          echo "${{ secrets.DEV_KUBECONFIG }}" | base64 -d > kubeconfig
          echo "KUBECONFIG=$PWD/kubeconfig" >> $GITHUB_ENV

      - name: Wait for Flux reconciliation
        run: |
          flux wait kustomization myapp --timeout=5m

      - name: Run smoke tests against dev
        run: |
          kubectl wait deployment myapp -n myapp --for=condition=available --timeout=5m
          # Run basic health check
          kubectl exec -n myapp deploy/myapp -- wget -qO- http://localhost:8080/health

  create-staging-pr:
    needs: check-dev-health
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITOPS_PAT }}

      - name: Extract new image tag from dev overlay
        id: get-tag
        run: |
          TAG=$(grep 'newTag:' apps/overlays/dev/kustomization.yaml | grep -oP 'v[\d.]+')
          echo "tag=$TAG" >> $GITHUB_OUTPUT

      - name: Create staging promotion branch
        run: |
          git checkout -b promote-to-staging-${{ steps.get-tag.outputs.tag }}
          git config user.email "cibot@yourorg.com"
          git config user.name "CI Bot"

          # Update staging overlay with new tag
          sed -i "s|newTag: .*|newTag: ${{ steps.get-tag.outputs.tag }} # {\"\\$imagepolicy\": \"flux-system:myapp:tag\"}|" \
            apps/overlays/staging/kustomization.yaml

          git add apps/overlays/staging/kustomization.yaml
          git commit -m "chore(staging): promote myapp to ${{ steps.get-tag.outputs.tag }}"
          git push origin promote-to-staging-${{ steps.get-tag.outputs.tag }}

      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v6
        with:
          token: ${{ secrets.GITOPS_PAT }}
          branch: promote-to-staging-${{ steps.get-tag.outputs.tag }}
          base: main
          title: "chore(staging): promote myapp to ${{ steps.get-tag.outputs.tag }}"
          body: |
            ## Staging Promotion

            Promoting **myapp** to version **${{ steps.get-tag.outputs.tag }}** in staging.

            ### Pre-promotion Checks
            - [x] Dev deployment healthy
            - [x] Smoke tests passed
            - [ ] Manual review (if required)

            ### Changes
            - Updated `apps/overlays/staging/kustomization.yaml`

            **Auto-merge**: This PR will be merged automatically after all status checks pass.
          labels: |
            promotion
            automated
            staging
          auto-merge: squash
```

### 5.2 Integration Tests as Gate

```yaml
# .github/workflows/staging-integration-tests.yaml
name: Staging Integration Tests

on:
  push:
    branches: [main]
    paths:
      - 'apps/overlays/staging/**'

jobs:
  wait-for-deployment:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        run: |
          echo "${{ secrets.STAGING_KUBECONFIG }}" | base64 -d > kubeconfig
          echo "KUBECONFIG=$PWD/kubeconfig" >> $GITHUB_ENV

      - name: Wait for Flux to reconcile staging
        run: |
          flux wait kustomization myapp --timeout=10m

      - name: Wait for deployment rollout
        run: |
          kubectl rollout status deployment/myapp -n myapp --timeout=5m

  run-integration-tests:
    needs: wait-for-deployment
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: yourorg/integration-tests
          token: ${{ secrets.GITOPS_PAT }}

      - name: Run integration test suite
        env:
          TEST_BASE_URL: https://staging.yourapp.com
          TEST_API_KEY: ${{ secrets.STAGING_TEST_API_KEY }}
        run: |
          make integration-tests

      - name: Run performance tests
        run: |
          # k6 load test against staging
          k6 run tests/load/smoke.js \
            --env BASE_URL=https://staging.yourapp.com \
            --out json=results.json

          # Fail if p99 latency exceeds 500ms
          jq -e '.metrics.http_req_duration.values["p(99)"] < 500' results.json

  promote-to-production:
    needs: run-integration-tests
    if: success()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITOPS_PAT }}

      - name: Get staging version
        id: get-version
        run: |
          VERSION=$(grep 'newTag:' apps/overlays/staging/kustomization.yaml | grep -oP 'v[\d.]+')
          echo "version=$VERSION" >> $GITHUB_OUTPUT

      - name: Create production promotion PR
        uses: peter-evans/create-pull-request@v6
        with:
          token: ${{ secrets.GITOPS_PAT }}
          commit-message: "chore(production): promote myapp to ${{ steps.get-version.outputs.version }}"
          branch: promote-to-prod-${{ steps.get-version.outputs.version }}
          base: main
          title: "chore(production): promote myapp to ${{ steps.get-version.outputs.version }}"
          body: |
            ## Production Promotion

            Promoting **myapp** to **${{ steps.get-version.outputs.version }}** in production.

            ### Pre-promotion Checklist
            - [x] Staging deployment successful
            - [x] Integration tests passed
            - [x] Performance tests passed

            **This PR requires manual approval from the platform team.**

            After merge, Flagger will progressively roll out the change:
            1. 10% of traffic → canary (5 minutes)
            2. 50% of traffic → canary (5 minutes)
            3. 100% → full rollout

            Automatic rollback if error rate > 1% or p99 latency > 500ms.
          labels: |
            promotion
            production
            requires-approval
          reviewers: |
            platform-team
```

---

## Section 6: Flagger Progressive Delivery

### 6.1 Install Flagger

```yaml
# infrastructure/flagger/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2beta2
kind: HelmRelease
metadata:
  name: flagger
  namespace: flagger-system
spec:
  interval: 1h
  chart:
    spec:
      chart: flagger
      version: ">=1.36.0"
      sourceRef:
        kind: HelmRepository
        name: flagger
        namespace: flagger-system
  values:
    meshProvider: nginx
    metricsServer: http://prometheus.monitoring.svc.cluster.local:9090
    slack:
      url: https://hooks.slack.com/services/<slack-webhook-path>
      channel: "#deployments"
      username: flagger
```

### 6.2 Canary Resource

```yaml
# apps/overlays/production/canary.yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: myapp
  namespace: myapp
spec:
  # Deployment to canary-analyze
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp

  # Ingress for traffic splitting
  ingressRef:
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    name: myapp

  # HPA reference (Flagger pauses HPA during canary)
  autoscalerRef:
    apiVersion: autoscaling/v2
    kind: HorizontalPodAutoscaler
    name: myapp

  service:
    port: 80
    targetPort: 8080

  # Progressive delivery configuration
  analysis:
    # Duration between traffic weight increments
    interval: 5m
    # Number of metrics checks before incrementing
    threshold: 5
    # Max traffic percentage sent to canary
    maxWeight: 50
    # Traffic weight increment step
    stepWeight: 10

    # Traffic rollback thresholds
    metrics:
      # Error rate threshold
      - name: request-success-rate
        thresholdRange:
          min: 99       # Rollback if success rate < 99%
        interval: 1m

      # Latency threshold
      - name: request-duration
        thresholdRange:
          max: 500      # Rollback if p99 > 500ms
        interval: 1m

      # Custom metric: database error rate
      - name: db-error-rate
        templateRef:
          name: db-error-rate
          namespace: flagger-system
        thresholdRange:
          max: 0.01     # Rollback if DB error rate > 1%
        interval: 2m

    # Load testing during analysis (generates traffic for Prometheus)
    webhooks:
      - name: acceptance-test
        type: pre-rollout
        url: http://flagger-loadtester.flagger-system/
        timeout: 5m
        metadata:
          type: bash
          cmd: |
            curl -sd 'test' http://myapp-canary.myapp/test | grep "success"

      - name: load-test
        url: http://flagger-loadtester.flagger-system/
        timeout: 5s
        metadata:
          type: cmd
          cmd: |
            hey -z 1m -q 10 -c 2 http://myapp-canary.myapp/

      - name: notify-slack-canary-start
        type: event
        url: https://hooks.slack.com/services/<slack-webhook-path>
        metadata:
          text: |
            Starting canary analysis for {{ .name }}: {{ .canaryWeight }}% traffic
```

### 6.3 Custom Metric Templates

```yaml
# Custom Prometheus metric template for Flagger
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: db-error-rate
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring.svc.cluster.local:9090
  query: |
    sum(
      rate(
        myapp_database_errors_total{
          namespace="{{ namespace }}",
          app="{{ target }}"
        }[{{ interval }}]
      )
    )
    /
    sum(
      rate(
        myapp_database_queries_total{
          namespace="{{ namespace }}",
          app="{{ target }}"
        }[{{ interval }}]
      )
    )

---
apiVersion: flagger.app/v1beta1
kind: MetricTemplate
metadata:
  name: request-success-rate
  namespace: flagger-system
spec:
  provider:
    type: prometheus
    address: http://prometheus.monitoring.svc.cluster.local:9090
  query: |
    100 - sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          service=~"{{ target }}-canary",
          status=~"5.."
        }[{{ interval }}]
      )
    )
    /
    sum(
      rate(
        http_requests_total{
          namespace="{{ namespace }}",
          service=~"{{ target }}-canary"
        }[{{ interval }}]
      )
    ) * 100
```

---

## Section 7: Notification and Observability

### 7.1 Flux Notifications

```yaml
# Slack notifications for Flux events
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Provider
metadata:
  name: slack
  namespace: flux-system
spec:
  type: slack
  channel: "#deployments"
  secretRef:
    name: slack-webhook

---
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: all-clusters
  namespace: flux-system
spec:
  providerRef:
    name: slack
  eventSeverity: info
  eventSources:
    - kind: GitRepository
      name: "*"
    - kind: Kustomization
      name: "*"
    - kind: HelmRelease
      name: "*"
    - kind: ImageUpdateAutomation
      name: "*"
  exclusionList:
    - ".*no changes.*"
```

### 7.2 GitHub Deployment Environments

```yaml
# .github/workflows/create-deployment.yaml
name: Create GitHub Deployment

on:
  push:
    branches: [main]
    paths:
      - 'apps/overlays/production/**'

jobs:
  create-deployment:
    runs-on: ubuntu-latest
    steps:
      - name: Create deployment
        uses: chrnorm/deployment-action@v2
        id: deployment
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          environment: production
          auto-merge: false
          required_contexts: '[]'

      - name: Wait for Flagger canary completion
        run: |
          echo "Waiting for Flagger to complete canary analysis..."
          # Poll Flagger status
          for i in $(seq 1 60); do
            STATUS=$(kubectl get canary myapp -n myapp -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
            echo "Canary status: $STATUS (attempt $i/60)"

            if [ "$STATUS" = "Succeeded" ]; then
              echo "Deployment succeeded!"
              break
            elif [ "$STATUS" = "Failed" ]; then
              echo "Deployment failed — Flagger rolled back"
              exit 1
            fi
            sleep 30
          done

      - name: Update deployment status (success)
        if: success()
        uses: chrnorm/deployment-status@v2
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          deployment-id: ${{ steps.deployment.outputs.deployment_id }}
          state: success
          environment-url: https://app.yourcompany.com

      - name: Update deployment status (failure)
        if: failure()
        uses: chrnorm/deployment-status@v2
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          deployment-id: ${{ steps.deployment.outputs.deployment_id }}
          state: failure
```

---

## Section 8: Security Policy Enforcement

### 8.1 Cosign Signature Verification in Flux

```yaml
# Verify images are signed before deploying
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: myapp-verified
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: myapp
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"
  filterTags:
    pattern: "^v[0-9]+.[0-9]+.[0-9]+$"
    extract: "$version"
```

```yaml
# Kyverno policy to enforce signed images
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-signed-images
spec:
  validationFailureAction: enforce
  background: false
  rules:
    - name: verify-image-signature
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [production, staging]
      verifyImages:
        - imageReferences:
            - "ghcr.io/yourorg/*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/yourorg/*/.github/workflows/*@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
```

### 8.2 OPA Gatekeeper Constraints

```yaml
# Require specific labels on all deployments
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequiredLabels
metadata:
  name: require-team-label
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment"]
  parameters:
    labels:
      - key: "team"
        allowedRegex: "^[a-z-]+$"
      - key: "app.kubernetes.io/version"
      - key: "app.kubernetes.io/managed-by"
        allowedRegex: "^(flux|helm)$"
```

---

## Section 9: Disaster Recovery Procedures

### 9.1 Emergency Rollback

```bash
# Emergency rollback: suspend Flux automation and roll back manually
# Step 1: Suspend Flux automation to prevent re-deployment
flux suspend kustomization myapp --namespace flux-system

# Step 2: Roll back the deployment directly
kubectl rollout undo deployment/myapp -n myapp

# Step 3: If Flagger is managing the canary, abort the analysis
kubectl annotate canary myapp -n myapp flagger.app/manual-gate=false
# Wait for Flagger to abort and roll back to primary

# Step 4: Fix the issue in the Git repository
# (update the image tag to a working version)

# Step 5: Resume Flux
flux resume kustomization myapp --namespace flux-system
```

### 9.2 Full Cluster Bootstrap from Scratch

```bash
# If a cluster is lost completely, restore from GitOps state
# Step 1: Create the cluster
# (use your IaC tooling — Terraform, Pulumi, etc.)

# Step 2: Bootstrap Flux
flux bootstrap github \
  --owner=yourorg \
  --repository=gitops-repo \
  --branch=main \
  --path=clusters/production

# Step 3: Wait for Flux to restore all resources
flux get all --all-namespaces --watch

# Step 4: Verify application health
kubectl get deployments --all-namespaces
kubectl get canary --all-namespaces
```

---

## Section 10: Monitoring the Pipeline

### 10.1 Flux Metrics

```promql
# Flux reconciliation success rate
sum(rate(gotk_reconcile_condition{status="True",type="Ready"}[5m])) by (kind, name)
/
sum(rate(gotk_reconcile_condition[5m])) by (kind, name)

# Reconciliation duration p99
histogram_quantile(0.99,
  sum(rate(gotk_reconcile_duration_seconds_bucket[5m])) by (kind, name, le)
)

# Image update frequency
increase(gotk_image_automation_update_total[24h])

# Failed reconciliations
sum(gotk_reconcile_condition{status="False"}) by (kind, name, namespace)
```

### 10.2 Flagger Metrics

```promql
# Canary analysis success rate
sum(flagger_canary_total{phase="Succeeded"}) by (name, namespace)
/
sum(flagger_canary_total) by (name, namespace)

# Time to complete successful rollout
histogram_quantile(0.95,
  sum(rate(flagger_canary_duration_seconds_bucket{phase="Succeeded"}[7d])) by (le)
)

# Rollback rate
sum(flagger_canary_total{phase="Failed"}) by (name, namespace)
/
sum(flagger_canary_total) by (name, namespace)
```

---

## Summary

This GitOps pipeline with Flux and GitHub Actions creates a complete automation loop from code commit to production rollout:

1. **Security scanning as a gate** — Trivy blocks vulnerable images before they reach any environment
2. **Cosign signing** — every production image is signed with keyless OIDC, enabling policy enforcement at admission
3. **Environment progression** — dev → staging → production with automated smoke tests between each stage
4. **Manual approval gate** — production promotions require human review via PR
5. **Flagger canary analysis** — progressive traffic shifting with automatic rollback on SLO violation
6. **Fully auditable** — every change is a Git commit with a clear author, timestamp, and reason
7. **Disaster recovery** — the entire cluster state is in Git; bootstrapping a new cluster is a single Flux command

The key principle is that the GitOps repository is the single source of truth. No kubectl apply commands, no Helm upgrades from CI — everything flows through Git commits and Flux reconciliation.
