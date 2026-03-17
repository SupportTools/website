---
title: "Kubernetes GitOps Security: Signed Commits, Policy Gates, and Deployment Attestation"
date: 2031-02-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GitOps", "Sigstore", "Security", "ArgoCD", "SLSA", "Supply Chain"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes GitOps security covering Sigstore commit signing, Gitsign keyless signing, OPA/Kyverno policy gates in ArgoCD, SLSA provenance attestation, deployment approval workflows, and supply chain integrity verification."
more_link: "yes"
url: "/kubernetes-gitops-security-signed-commits-policy-gates-deployment-attestation/"
---

GitOps pipelines represent the critical path from developer code changes to production deployments. Securing this path requires commit signing for non-repudiation, policy gates to enforce deployment standards, and SLSA provenance attestation to verify supply chain integrity. This guide builds a complete GitOps security stack using Sigstore, ArgoCD, and Kyverno.

<!--more-->

# Kubernetes GitOps Security: Signed Commits, Policy Gates, and Deployment Attestation

## The GitOps Security Threat Model

A GitOps pipeline has several attack surfaces:

1. **Source repository**: Unsigned commits allow impersonation. An attacker who gains repository write access can merge malicious changes without a traceable identity.

2. **CI/CD pipeline**: Build artifacts (container images) must be associated with the exact source commit they were built from. Without attestation, a compromised pipeline can substitute a malicious image.

3. **GitOps operator**: ArgoCD or Flux must verify that the manifests it deploys are authorized. A compromised Git repository or registry should not be able to push arbitrary changes to production.

4. **Policy enforcement**: Deployment policies (image vulnerability scanning, RBAC requirements, network policies) must be enforced automatically, not relying on human review alone.

## Section 1: Sigstore and Gitsign for Keyless Commit Signing

### Understanding Keyless Signing

Traditional commit signing requires developers to manage GPG keys — generate them, protect them, and distribute their public keys. Keyless signing with Gitsign replaces this with ephemeral certificates issued by a certificate authority (Fulcio) after OIDC authentication, with all signing events logged in a tamper-evident transparency log (Rekor).

The flow is:
1. Developer initiates a git commit
2. Gitsign opens a browser for OIDC authentication (GitHub, Google, Microsoft)
3. Fulcio issues a short-lived X.509 certificate bound to the developer's email
4. The commit is signed with this ephemeral certificate
5. The signature is stored in Rekor, creating an immutable audit log

### Installing Gitsign

```bash
# Install Gitsign
# For Linux (AMD64)
curl -Lo gitsign https://github.com/sigstore/gitsign/releases/latest/download/gitsign_linux_amd64
chmod +x gitsign
sudo mv gitsign /usr/local/bin/

# Verify installation
gitsign version
```

### Configuring Gitsign Globally

```bash
# Configure Git to use Gitsign for signing
git config --global gpg.x509.program gitsign
git config --global gpg.format x509

# Sign commits automatically
git config --global commit.gpgsign true

# Configure Sigstore endpoints (use public Sigstore by default)
git config --global gitsign.fulcio https://fulcio.sigstore.dev
git config --global gitsign.rekor https://rekor.sigstore.dev
git config --global gitsign.issuer https://oauth2.sigstore.dev/auth
```

### For Enterprise Environments: Private Sigstore Instance

```bash
# Install Sigstore stack on your own infrastructure
# Using the sigstore-helm-operator

helm repo add sigstore https://sigstore.github.io/helm-charts
helm repo update

# Install Fulcio (certificate authority)
helm install sigstore-fulcio sigstore/fulcio \
  --namespace sigstore-system \
  --create-namespace \
  --values fulcio-values.yaml

# Install Rekor (transparency log)
helm install sigstore-rekor sigstore/rekor \
  --namespace sigstore-system \
  --values rekor-values.yaml

# Configure Gitsign to use internal endpoints
git config --global gitsign.fulcio https://fulcio.internal.example.com
git config --global gitsign.rekor https://rekor.internal.example.com
git config --global gitsign.issuer https://keycloak.internal.example.com/realms/dev
```

### Verifying Signed Commits

```bash
# Create a signed commit
git commit -m "feat: add new API endpoint" --gpg-sign

# During signing, Gitsign opens a browser for OIDC authentication
# After authentication, the commit is signed automatically

# Verify a commit signature
git verify-commit HEAD

# Example output:
# tlog index: 12345678
# gitsign: Signature made using certificate ID 0x... | CN=sigstore-intermediate,O=sigstore.dev
# gitsign: Good commit signature from:
#     [OIDC ISSUER] https://accounts.google.com
#     [SUBJECT]     developer@example.com
#     [ISSUER]      https://accounts.google.com
# gitsign: WARNING: git verify-commit does not verify the certificate against a root of trust

# For full verification against Fulcio's root:
gitsign verify \
  --certificate-identity=developer@example.com \
  --certificate-oidc-issuer=https://accounts.google.com \
  HEAD
```

### Enforcing Signed Commits via GitHub Branch Protection

```bash
# GitHub CLI: Enable required commit signing on main branch
gh api repos/myorg/myrepo/branches/main/protection \
  --method PUT \
  --field required_signatures=true \
  --field enforce_admins=true \
  --field required_status_checks='{"strict":true,"contexts":["ci/verify-signatures"]}' \
  --field required_pull_request_reviews='{"required_approving_review_count":2}'
```

## Section 2: Policy Gates in ArgoCD

### ArgoCD Resource Hooks for Policy Validation

ArgoCD's sync hooks allow running validation jobs before applying changes to a cluster:

```yaml
# argocd-presync-policy-check.yaml
# This Job runs before ArgoCD syncs the application.
# If it fails, the sync is blocked.

apiVersion: batch/v1
kind: Job
metadata:
  name: pre-sync-policy-check
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: policy-check
          image: openpolicyagent/conftest:latest
          command:
            - conftest
            - test
            - --policy
            - /policies
            - /manifests
          volumeMounts:
            - name: manifests
              mountPath: /manifests
              readOnly: true
            - name: policies
              mountPath: /policies
              readOnly: true
      volumes:
        - name: manifests
          configMap:
            name: application-manifests
        - name: policies
          configMap:
            name: deployment-policies
```

### Kyverno as an ArgoCD Policy Gate

Kyverno policies act as Kubernetes admission webhooks, automatically enforcing policies on every apply operation including ArgoCD syncs:

```yaml
# kyverno-image-verification-policy.yaml
# Requires all container images to be signed with Cosign and verifiable
# against the organization's signing key or OIDC identity.

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
  annotations:
    policies.kyverno.io/title: Verify Image Signatures
    policies.kyverno.io/category: Software Supply Chain Security
    policies.kyverno.io/description: >
      Requires all container images to be signed using Cosign
      with the organization's Sigstore identity.
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: verify-cosign-signature
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - production
                - staging
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestors:
            - count: 1
              entries:
                - keyless:
                    subject: "https://github.com/myorg/myrepo/.github/workflows/release.yml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
          mutateDigest: true    # Replace tags with digest references
          verifyDigest: true    # Verify the digest hasn't changed
          required: true
```

```yaml
# kyverno-deployment-standards-policy.yaml
# Enforce deployment best practices

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: enforce-deployment-standards
  annotations:
    policies.kyverno.io/title: Enforce Deployment Standards
spec:
  validationFailureAction: Enforce
  rules:
    - name: require-resource-limits
      match:
        any:
          - resources:
              kinds:
                - Deployment
                - StatefulSet
              namespaces:
                - production
      validate:
        message: "Resource limits must be set for all containers in production"
        pattern:
          spec:
            template:
              spec:
                containers:
                  - resources:
                      limits:
                        cpu: "?*"
                        memory: "?*"
                      requests:
                        cpu: "?*"
                        memory: "?*"

    - name: require-pod-disruption-budget
      match:
        any:
          - resources:
              kinds:
                - Deployment
              namespaces:
                - production
      preconditions:
        all:
          - key: "{{ request.object.spec.replicas }}"
            operator: GreaterThan
            value: 1
      validate:
        message: "Deployments with >1 replica must have a PodDisruptionBudget"
        deny:
          conditions:
            any:
              - key: "{{ length(request.object.metadata.annotations.\"platform.example.com/pdb-name\" || '') }}"
                operator: Equals
                value: 0

    - name: disallow-latest-tag
      match:
        any:
          - resources:
              kinds:
                - Deployment
                - StatefulSet
              namespaces:
                - production
      validate:
        message: "Image tag 'latest' is not allowed in production"
        pattern:
          spec:
            template:
              spec:
                containers:
                  - image: "!*:latest"
                initContainers:
                  - image: "!*:latest"
```

### OPA Gatekeeper Constraints

For teams already using OPA Gatekeeper, create ConstraintTemplates for GitOps policy enforcement:

```yaml
# gatekeeper-required-labels-template.yaml

apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requiredlabels
spec:
  crd:
    spec:
      names:
        kind: RequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requiredlabels

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_]}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("Missing required labels: %v", [missing])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequiredLabels
metadata:
  name: production-required-labels
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces: ["production"]
  parameters:
    labels:
      - "app.kubernetes.io/name"
      - "app.kubernetes.io/version"
      - "app.kubernetes.io/team"
      - "app.kubernetes.io/managed-by"
```

## Section 3: SLSA Provenance Attestation

### What is SLSA?

SLSA (Supply chain Levels for Software Artifacts) is a security framework defining four levels of supply chain integrity. Level 3 requires:
- Hermetic builds (no network access during build)
- Provenance attestation stored in a transparency log
- Build steps are reproducible

### Generating SLSA Provenance in GitHub Actions

```yaml
# .github/workflows/release.yml
# Builds a container image and generates SLSA L3 provenance

name: Build and Attest

on:
  push:
    branches:
      - main
    tags:
      - 'v*'

permissions:
  contents: read
  id-token: write    # Required for OIDC keyless signing
  packages: write    # Required for pushing to GHCR

jobs:
  build-and-attest:
    runs-on: ubuntu-latest
    outputs:
      image-digest: ${{ steps.build.outputs.digest }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to registry
        uses: docker/login-action@v3
        with:
          registry: registry.example.com
          username: ${{ secrets.REGISTRY_USER }}
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - name: Build and push
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: registry.example.com/myapp:${{ github.sha }}
          # Provenance and SBOM generation
          provenance: true
          sbom: true
          # Include build args in provenance
          build-args: |
            BUILD_DATE=${{ github.run_id }}
            GIT_COMMIT=${{ github.sha }}

      - name: Install Cosign
        uses: sigstore/cosign-installer@v3

      - name: Sign the container image
        env:
          IMAGE_DIGEST: ${{ steps.build.outputs.digest }}
        run: |
          cosign sign --yes \
            registry.example.com/myapp@${IMAGE_DIGEST}

      - name: Verify signature
        env:
          IMAGE_DIGEST: ${{ steps.build.outputs.digest }}
        run: |
          cosign verify \
            --certificate-identity-regexp="https://github.com/myorg/myrepo/.*" \
            --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
            registry.example.com/myapp@${IMAGE_DIGEST}

  # Generate SLSA provenance attestation
  provenance:
    needs: build-and-attest
    permissions:
      id-token: write
      contents: read
      actions: read
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v2.0.0
    with:
      image: registry.example.com/myapp
      digest: ${{ needs.build-and-attest.outputs.image-digest }}
    secrets:
      registry-username: ${{ secrets.REGISTRY_USER }}
      registry-password: ${{ secrets.REGISTRY_PASSWORD }}
```

### Attaching Custom Attestations

```bash
# Create a custom attestation (e.g., test results, vulnerability scan results)
SCAN_RESULTS=$(trivy image --format json registry.example.com/myapp:latest)

echo "${SCAN_RESULTS}" | cosign attest \
  --yes \
  --predicate - \
  --type vuln \
  registry.example.com/myapp@${IMAGE_DIGEST}

# Attach SBOM as attestation
syft registry.example.com/myapp:latest -o spdx-json > sbom.json

cosign attest \
  --yes \
  --predicate sbom.json \
  --type spdxjson \
  registry.example.com/myapp@${IMAGE_DIGEST}

# Verify attestation
cosign verify-attestation \
  --type vuln \
  --certificate-identity-regexp="https://github.com/myorg/myrepo/.*" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  registry.example.com/myapp@${IMAGE_DIGEST} \
  | jq '.payload | @base64d | fromjson'
```

### Kyverno Policy to Verify SLSA Provenance

```yaml
# kyverno-verify-slsa-provenance.yaml
# Verifies that images have valid SLSA provenance attestation

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-slsa-provenance
  annotations:
    policies.kyverno.io/title: Verify SLSA Provenance
    policies.kyverno.io/category: Software Supply Chain Security
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: verify-slsa-l3-attestation
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - production
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestations:
            - type: https://slsa.dev/provenance/v1
              attestors:
                - entries:
                    - keyless:
                        subject: "https://github.com/myorg/myrepo/.github/workflows/release.yml@refs/heads/main"
                        issuer: "https://token.actions.githubusercontent.com"
              conditions:
                - all:
                    - key: "{{ buildDefinition.buildType }}"
                      operator: Equals
                      value: "https://actions.github.io/buildtypes/workflow/v1"
                    - key: "{{ buildDefinition.externalParameters.workflow.ref }}"
                      operator: Equals
                      value: "refs/heads/main"
```

## Section 4: Deployment Approval Workflows

### ArgoCD ApplicationSet with Environment Promotion Gates

```yaml
# applicationset-with-gates.yaml
# Uses ArgoCD ApplicationSet to manage promotion across environments

apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: myapp-environments
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - env: dev
            cluster: dev-cluster
            namespace: myapp-dev
            autoSync: "true"
            allowEmpty: "false"
          - env: staging
            cluster: staging-cluster
            namespace: myapp-staging
            autoSync: "false"    # Manual sync required for staging
            allowEmpty: "false"
          - env: production
            cluster: prod-cluster
            namespace: myapp-production
            autoSync: "false"    # Manual approval required for production
            allowEmpty: "false"
  template:
    metadata:
      name: "myapp-{{env}}"
    spec:
      project: myapp
      source:
        repoURL: https://github.com/myorg/myapp-gitops.git
        targetRevision: HEAD
        path: "environments/{{env}}"
      destination:
        server: "{{cluster}}"
        namespace: "{{namespace}}"
      syncPolicy:
        automated:
          prune: "{{autoSync}}"
          selfHeal: "{{autoSync}}"
          allowEmpty: "{{allowEmpty}}"
        syncOptions:
          - Validate=true
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
          - RespectIgnoreDifferences=true
        retry:
          limit: 3
          backoff:
            duration: 5s
            factor: 2
            maxDuration: 3m
      # Require health checks to pass before considering sync complete
      ignoreDifferences:
        - group: apps
          kind: Deployment
          jsonPointers:
            - /spec/replicas
```

### Automated Promotion with Verification

```yaml
# .github/workflows/promote-to-production.yml
# Promotes a staging deployment to production after passing gate checks

name: Promote to Production

on:
  workflow_dispatch:
    inputs:
      image-tag:
        description: 'Image tag to promote'
        required: true
      staging-deployment-id:
        description: 'ArgoCD staging deployment ID to verify'
        required: true

jobs:
  verify-staging:
    runs-on: ubuntu-latest
    steps:
      - name: Verify image signature
        env:
          IMAGE_TAG: ${{ github.event.inputs.image-tag }}
        run: |
          cosign verify \
            --certificate-identity-regexp="https://github.com/${{ github.repository }}/.*" \
            --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
            registry.example.com/myapp:${IMAGE_TAG}
          echo "Image signature verified"

      - name: Verify SLSA provenance
        env:
          IMAGE_TAG: ${{ github.event.inputs.image-tag }}
        run: |
          cosign verify-attestation \
            --type slsaprovenance \
            --certificate-identity-regexp="https://github.com/${{ github.repository }}/.*" \
            --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
            registry.example.com/myapp:${IMAGE_TAG} \
            | jq -r '.payload | @base64d | fromjson | .predicate.buildDefinition.externalParameters.workflow.ref'

      - name: Check staging health
        env:
          ARGOCD_TOKEN: ${{ secrets.ARGOCD_TOKEN }}
        run: |
          APP_STATUS=$(curl -s \
            -H "Authorization: Bearer ${ARGOCD_TOKEN}" \
            https://argocd.internal.example.com/api/v1/applications/myapp-staging \
            | jq -r '.status.health.status')

          if [ "${APP_STATUS}" != "Healthy" ]; then
            echo "Staging is not healthy: ${APP_STATUS}"
            exit 1
          fi
          echo "Staging health verified: ${APP_STATUS}"

      - name: Verify smoke tests passed
        env:
          ARGOCD_TOKEN: ${{ secrets.ARGOCD_TOKEN }}
          STAGING_DEPLOYMENT_ID: ${{ github.event.inputs.staging-deployment-id }}
        run: |
          # Check that smoke tests passed for this specific deployment
          SYNC_STATUS=$(curl -s \
            -H "Authorization: Bearer ${ARGOCD_TOKEN}" \
            "https://argocd.internal.example.com/api/v1/applications/myapp-staging/resource-tree" \
            | jq -r '.nodes[] | select(.kind=="Job" and .name=="smoke-tests") | .health.status')

          if [ "${SYNC_STATUS}" != "Healthy" ]; then
            echo "Smoke tests did not pass: ${SYNC_STATUS}"
            exit 1
          fi

  promote-to-production:
    needs: verify-staging
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://app.example.com
    steps:
      - name: Checkout GitOps repository
        uses: actions/checkout@v4
        with:
          repository: myorg/myapp-gitops
          token: ${{ secrets.GITOPS_PAT }}

      - name: Update production image tag
        env:
          IMAGE_TAG: ${{ github.event.inputs.image-tag }}
        run: |
          # Update the production kustomization with the new image tag
          cd environments/production
          kustomize edit set image registry.example.com/myapp:${IMAGE_TAG}

      - name: Create signed commit
        run: |
          git config user.email "ci-bot@example.com"
          git config user.name "CI Bot"
          git add environments/production/kustomization.yaml
          git commit -m "chore: promote myapp ${IMAGE_TAG} to production

          Staging verification passed:
          - Image signature verified
          - SLSA provenance verified
          - Staging health: Healthy
          - Smoke tests: Passed

          Promoted by: ${{ github.actor }}
          Workflow run: ${{ github.run_id }}"

          git push

      - name: Trigger ArgoCD sync
        env:
          ARGOCD_TOKEN: ${{ secrets.ARGOCD_TOKEN }}
        run: |
          curl -X POST \
            -H "Authorization: Bearer ${ARGOCD_TOKEN}" \
            -H "Content-Type: application/json" \
            -d '{"revision": "HEAD", "prune": false, "dryRun": false, "force": false}' \
            https://argocd.internal.example.com/api/v1/applications/myapp-production/sync
```

## Section 5: Supply Chain Integrity Verification

### Cosign Image Verification at Admission

```bash
# Set up Cosign for cluster-wide verification
kubectl create namespace cosign-system

# Install Cosign webhook (Policy Controller)
helm repo add sigstore https://sigstore.github.io/helm-charts
helm install policy-controller sigstore/policy-controller \
  --namespace cosign-system \
  --set webhook.namespaceSelector='{"matchExpressions":[{"key":"cosign.sigstore.dev/policy","operator":"In","values":["enforce"]}]}'
```

```yaml
# sigstore-clusterimagepoliicy.yaml
# ClusterImagePolicy enforces signature verification for all images

apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: verify-org-images
spec:
  images:
    - glob: "registry.example.com/**"
  authorities:
    - keyless:
        url: https://fulcio.sigstore.dev
        identities:
          - issuerRegExp: "https://token.actions.githubusercontent.com"
            subjectRegExp: "https://github.com/myorg/.*"
      ctlog:
        url: https://rekor.sigstore.dev
      attestations:
        - name: must-have-slsa-provenance
          predicateType: https://slsa.dev/provenance/v1
          policy:
            type: rego
            data: |
              package sigstore

              default isCompliant = false

              isCompliant {
                input.predicate.buildDefinition.buildType == "https://actions.github.io/buildtypes/workflow/v1"
                startswith(input.predicate.buildDefinition.externalParameters.workflow.ref, "refs/heads/main")
              }
```

### Verifying the Full Supply Chain

```bash
#!/bin/bash
# verify-supply-chain.sh - Complete supply chain verification for a deployment

IMAGE_REF="${1}"  # e.g., registry.example.com/myapp@sha256:abc123...

if [ -z "$IMAGE_REF" ]; then
    echo "Usage: $0 <image-reference>"
    exit 1
fi

echo "=== Supply Chain Verification for ${IMAGE_REF} ==="
echo ""

# Step 1: Verify image signature
echo "1. Verifying image signature..."
cosign verify \
    --certificate-identity-regexp="https://github.com/myorg/.*" \
    --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
    "${IMAGE_REF}" 2>/dev/null

if [ $? -eq 0 ]; then
    echo "   PASS: Image signature verified"
else
    echo "   FAIL: Image signature verification failed"
    exit 1
fi

# Step 2: Verify SLSA provenance
echo "2. Verifying SLSA provenance..."
PROVENANCE=$(cosign verify-attestation \
    --type slsaprovenance \
    --certificate-identity-regexp="https://github.com/myorg/.*" \
    --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
    "${IMAGE_REF}" 2>/dev/null | jq -r '.payload | @base64d | fromjson')

if [ $? -eq 0 ] && [ -n "${PROVENANCE}" ]; then
    BUILD_TYPE=$(echo "${PROVENANCE}" | jq -r '.predicate.buildDefinition.buildType')
    WORKFLOW_REF=$(echo "${PROVENANCE}" | jq -r '.predicate.buildDefinition.externalParameters.workflow.ref')
    echo "   PASS: SLSA provenance verified"
    echo "   Build type: ${BUILD_TYPE}"
    echo "   Workflow ref: ${WORKFLOW_REF}"
else
    echo "   FAIL: SLSA provenance verification failed"
    exit 1
fi

# Step 3: Verify vulnerability scan attestation
echo "3. Checking vulnerability scan attestation..."
VULN_RESULT=$(cosign verify-attestation \
    --type vuln \
    --certificate-identity-regexp="https://github.com/myorg/.*" \
    --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
    "${IMAGE_REF}" 2>/dev/null | jq -r '.payload | @base64d | fromjson')

if [ $? -eq 0 ]; then
    CRITICAL_COUNT=$(echo "${VULN_RESULT}" | jq '.predicate.scanner.result.Results[]?.Vulnerabilities[]? | select(.Severity=="CRITICAL") | .VulnerabilityID' | wc -l)
    HIGH_COUNT=$(echo "${VULN_RESULT}" | jq '.predicate.scanner.result.Results[]?.Vulnerabilities[]? | select(.Severity=="HIGH") | .VulnerabilityID' | wc -l)
    echo "   PASS: Vulnerability scan attestation found"
    echo "   Critical vulnerabilities: ${CRITICAL_COUNT}"
    echo "   High vulnerabilities: ${HIGH_COUNT}"
    if [ "${CRITICAL_COUNT}" -gt 0 ]; then
        echo "   WARNING: Critical vulnerabilities present"
    fi
else
    echo "   WARN: No vulnerability scan attestation found"
fi

echo ""
echo "=== Supply chain verification complete ==="
```

## Section 6: ArgoCD RBAC and Project Isolation

```yaml
# argocd-project-security.yaml
# Defines an ArgoCD Project with strict source and destination constraints

apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: myapp-project
  namespace: argocd
spec:
  description: "MyApp production project"

  # Only allow deployments from specific repositories
  sourceRepos:
    - "https://github.com/myorg/myapp-gitops.git"
    - "registry.example.com/*"

  # Only allow deployment to specific namespaces and clusters
  destinations:
    - namespace: myapp-production
      server: https://prod-cluster:6443
    - namespace: myapp-staging
      server: https://staging-cluster:6443

  # Restrict cluster-scoped resources
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace

  # Namespace-scoped resources that are allowed
  namespaceResourceWhitelist:
    - group: "apps"
      kind: Deployment
    - group: "apps"
      kind: StatefulSet
    - group: ""
      kind: Service
    - group: ""
      kind: ConfigMap
    - group: "networking.k8s.io"
      kind: Ingress
    - group: "networking.k8s.io"
      kind: NetworkPolicy

  # Namespace-scoped resources that are explicitly blocked
  namespaceResourceBlacklist:
    - group: ""
      kind: Secret   # Secrets managed by External Secrets Operator, not Git

  # RBAC for the project
  roles:
    - name: developer
      description: "Read-only access for developers"
      policies:
        - p, proj:myapp-project:developer, applications, get, myapp-project/*, allow
        - p, proj:myapp-project:developer, applications, sync, myapp-project/myapp-dev, allow
      groups:
        - myorg:team-a-developers

    - name: release-engineer
      description: "Can sync staging and production with approval"
      policies:
        - p, proj:myapp-project:release-engineer, applications, *, myapp-project/*, allow
      groups:
        - myorg:release-engineers
```

## Conclusion

A complete GitOps security stack requires multiple complementary layers: Gitsign provides non-repudiation for every code change, Kyverno and OPA Gatekeeper enforce deployment policies at admission time, SLSA provenance attestation links deployments back to verified builds, and ArgoCD project constraints limit the blast radius of any single compromised component. The combination creates an auditable, enforceable chain from developer identity through the build pipeline to production deployment, satisfying SLSA Level 3 requirements while remaining operational for engineering teams. The investment in this infrastructure pays dividends in incident response, regulatory compliance, and developer confidence that production is running exactly what was reviewed and approved.
