---
title: "GitHub Actions Kubernetes Deployment Patterns: OIDC, Self-Hosted Runners, and Security"
date: 2027-06-22T00:00:00-05:00
draft: false
tags: ["GitHub Actions", "CI/CD", "Kubernetes", "OIDC", "Security", "Self-Hosted Runners"]
categories:
- GitHub Actions
- CI/CD
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to GitHub Actions for Kubernetes deployments covering OIDC token-based authentication to AWS/GCP/Azure, self-hosted runners with Actions Runner Controller, workflow security hardening, reusable workflows, matrix deployments, and deployment freeze patterns."
more_link: "yes"
url: "/github-actions-kubernetes-deployment-patterns-guide/"
---

GitHub Actions has evolved from a simple automation tool into a comprehensive CI/CD platform capable of orchestrating complex multi-environment Kubernetes deployments. The addition of OIDC-based cloud authentication eliminated the need for long-lived cloud credentials in repositories, and the Actions Runner Controller brought self-hosted runner infrastructure under GitOps management. This guide covers the patterns required to build secure, scalable GitHub Actions pipelines for production Kubernetes workloads.

<!--more-->

# GitHub Actions Kubernetes Deployment Patterns

## Section 1: OIDC Token-Based Cloud Authentication

The most impactful security improvement in modern GitHub Actions workflows is eliminating stored cloud credentials entirely using OIDC (OpenID Connect) token exchange. Instead of storing `AWS_ACCESS_KEY_ID`, `AZURE_CLIENT_SECRET`, or service account keys as GitHub Secrets, the workflow requests a short-lived OIDC token from GitHub's token endpoint and exchanges it for cloud provider credentials.

### AWS OIDC Configuration

First, configure the OIDC trust relationship in AWS:

```bash
# Create the OIDC provider in AWS (one-time setup)
aws iam create-open-id-connect-provider \
  --url "https://token.actions.githubusercontent.com" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1"
```

Create an IAM role with the trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:org/app-repo:*"
        }
      }
    }
  ]
}
```

For finer-grained control, restrict to specific branches or environments:

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:org/app-repo:environment:production"
  }
}
```

Using the role in a workflow:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write    # Required for OIDC
      contents: read

    steps:
    - name: Configure AWS credentials via OIDC
      uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: arn:aws:iam::123456789012:role/github-actions-deploy
        role-session-name: github-actions-${{ github.run_id }}
        aws-region: us-east-1
        role-duration-seconds: 3600

    - name: Login to Amazon ECR
      id: login-ecr
      uses: aws-actions/amazon-ecr-login@v2

    - name: Update kubeconfig for EKS
      run: |
        aws eks update-kubeconfig \
          --region us-east-1 \
          --name production-cluster \
          --alias production
```

### GCP OIDC Configuration (Workload Identity Federation)

```bash
# Create Workload Identity Pool
gcloud iam workload-identity-pools create "github-pool" \
  --project="my-project" \
  --location="global" \
  --display-name="GitHub Actions Pool"

# Create Workload Identity Provider
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project="my-project" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# Bind the service account
gcloud iam service-accounts add-iam-policy-binding \
  "deploy-sa@my-project.iam.gserviceaccount.com" \
  --project="my-project" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/org/app-repo"
```

```yaml
# GCP OIDC workflow
- name: Authenticate to GCP
  uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: "projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider"
    service_account: "deploy-sa@my-project.iam.gserviceaccount.com"

- name: Get GKE credentials
  uses: google-github-actions/get-gke-credentials@v2
  with:
    cluster_name: production-cluster
    location: us-east1
```

### Azure OIDC Configuration

```bash
# Create app registration
APP_ID=$(az ad app create --display-name "github-actions-deploy" \
  --query appId -o tsv)

# Create service principal
az ad sp create --id $APP_ID

# Create federated identity credential
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-production-env",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:org/app-repo:environment:production",
  "description": "GitHub Actions production environment",
  "audiences": ["api://AzureADTokenExchange"]
}'

# Assign role
az role assignment create \
  --assignee $APP_ID \
  --role "Contributor" \
  --scope "/subscriptions/SUBSCRIPTION_ID/resourceGroups/production-rg"
```

```yaml
# Azure OIDC workflow
- name: Login to Azure
  uses: azure/login@v2
  with:
    client-id: ${{ secrets.AZURE_CLIENT_ID }}
    tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

- name: Get AKS credentials
  uses: azure/aks-set-context@v4
  with:
    resource-group: production-rg
    cluster-name: production-aks
```

## Section 2: Actions Runner Controller (ARC)

The Actions Runner Controller runs self-hosted GitHub Actions runners as Kubernetes pods, providing autoscaling, isolation, and GitOps management of runner infrastructure.

### ARC Installation

```bash
# Install ARC using Helm
helm install arc \
  --namespace arc-systems \
  --create-namespace \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller

# Create GitHub App or PAT secret
kubectl create secret generic github-config-secret \
  --namespace arc-runners \
  --from-literal=github_token="GITHUB_PAT_REPLACE_WITH_YOUR_TOKEN"
```

### Runner Scale Set Configuration

```yaml
# Install a runner scale set targeting a specific repository
helm install arc-runner-set \
  --namespace arc-runners \
  --create-namespace \
  --set githubConfigUrl="https://github.com/org/app-repo" \
  --set githubConfigSecret="github-config-secret" \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

Full values file for production runners:

```yaml
# arc-runner-values.yaml
githubConfigUrl: "https://github.com/org"
githubConfigSecret:
  github_app_id: "APP_ID"
  github_app_installation_id: "INSTALLATION_ID"
  github_app_private_key: |
    -----BEGIN RSA PRIVATE KEY (PLACEHOLDER)-----
    ...
    -----END RSA PRIVATE KEY (PLACEHOLDER)-----

minRunners: 2
maxRunners: 20

runnerGroup: "kubernetes-runners"
runnerScaleSetName: "arc-runner-set"

# Runner pod template
template:
  spec:
    nodeSelector:
      node-role: ci-runners
    tolerations:
    - key: "ci-runners"
      operator: "Exists"
      effect: "NoSchedule"
    securityContext:
      runAsNonRoot: true
      fsGroup: 1001
    containers:
    - name: runner
      image: ghcr.io/actions/actions-runner:latest
      resources:
        requests:
          cpu: "1"
          memory: "2Gi"
        limits:
          cpu: "4"
          memory: "8Gi"
      env:
      - name: RUNNER_FEATURE_FLAG_EPHEMERAL
        value: "true"
      volumeMounts:
      - name: work
        mountPath: /home/runner/_work
    volumes:
    - name: work
      ephemeral:
        volumeClaimTemplate:
          spec:
            accessModes: [ReadWriteOnce]
            storageClassName: gp3-fast
            resources:
              requests:
                storage: 20Gi

# DinD (Docker-in-Docker) for container builds
containerMode:
  type: "dind"
  kubernetesModeWorkVolumeClaim:
    accessModes: [ReadWriteOnce]
    storageClassName: gp3-fast
    resources:
      requests:
        storage: 20Gi
```

### Using ARC Runners in Workflows

```yaml
jobs:
  build:
    runs-on: arc-runner-set   # Matches runnerScaleSetName
    container:
      image: golang:1.22-alpine
    steps:
    - uses: actions/checkout@v4
    - name: Build
      run: go build ./...
```

## Section 3: Workflow Security Hardening

### Minimal Permissions

Every job should declare only the permissions it actually needs:

```yaml
# Top-level default — deny everything
permissions: {}

jobs:
  build:
    permissions:
      contents: read          # Checkout code
      packages: write         # Push to GHCR
      id-token: write         # OIDC token for cloud auth
      security-events: write  # Upload SARIF to Code Scanning

  deploy:
    permissions:
      id-token: write    # OIDC for cloud
      contents: read

  notify:
    permissions:
      issues: write      # Create issues
      pull-requests: write
```

### Pinning Actions to Commit SHA

Supply chain attacks on GitHub Actions can compromise CI pipelines. Pin all third-party actions to immutable commit SHAs:

```yaml
steps:
# INSECURE — tag is mutable
- uses: aws-actions/configure-aws-credentials@v4

# SECURE — pinned to immutable commit SHA
- uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502  # v4.0.2
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
- uses: docker/build-push-action@471d1dc4e07e5cdedd8fcfe5faff9ef7f15fd03b  # v6.9.0
```

Tools like Dependabot or Renovate can automatically update these SHAs when new versions are released.

### Secret Scanning and Prevention

```yaml
# .github/workflows/security-checks.yml
name: Security Checks
on: [push, pull_request]

jobs:
  secret-scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
      with:
        fetch-depth: 0  # Full history for secret scanning

    - name: Run Gitleaks
      uses: gitleaks/gitleaks-action@44c470ffd0258bd65d87f5060ab18ca00d8bb34c  # v2.3.2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

    - name: Run TruffleHog
      uses: trufflesecurity/trufflehog@main
      with:
        extra_args: --only-verified --fail

  dependency-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
    - name: Dependency Review
      uses: actions/dependency-review-action@ce3cf9537a52e8119d91fd484ab5974b6b1a9cac  # v4.3.4
      with:
        fail-on-severity: high
        deny-licenses: GPL-3.0, AGPL-3.0
```

### Preventing Script Injection

Untrusted input (PR titles, branch names, commit messages) must never be interpolated directly into `run` steps:

```yaml
# VULNERABLE to injection
- name: Echo PR title
  run: echo "PR: ${{ github.event.pull_request.title }}"

# SAFE — pass through environment variable
- name: Echo PR title
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "PR: $PR_TITLE"
```

## Section 4: Reusable Workflows

Reusable workflows (`workflow_call`) allow workflow definitions to be shared across repositories, reducing duplication and enforcing standards.

### Defining a Reusable Workflow

```yaml
# .github/workflows/reusable-deploy.yml in org/platform-workflows repo
name: Reusable Deploy

on:
  workflow_call:
    inputs:
      environment:
        required: true
        type: string
        description: "Target environment (staging/production)"
      image-tag:
        required: true
        type: string
        description: "Container image tag to deploy"
      helm-chart:
        required: false
        type: string
        default: "app"
      namespace:
        required: false
        type: string
        default: "default"
      timeout:
        required: false
        type: string
        default: "5m"
    secrets:
      AWS_ROLE_ARN:
        required: true
      CLUSTER_NAME:
        required: true
    outputs:
      deployment-url:
        description: "URL of the deployed application"
        value: ${{ jobs.deploy.outputs.url }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: ${{ inputs.environment }}
      url: ${{ steps.get-url.outputs.url }}
    outputs:
      url: ${{ steps.get-url.outputs.url }}
    permissions:
      id-token: write
      contents: read

    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502  # v4.0.2
      with:
        role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
        aws-region: us-east-1

    - name: Update kubeconfig
      run: |
        aws eks update-kubeconfig \
          --region us-east-1 \
          --name "${{ secrets.CLUSTER_NAME }}"

    - name: Deploy with Helm
      run: |
        helm upgrade --install \
          --namespace "${{ inputs.namespace }}" \
          --create-namespace \
          --set image.tag="${{ inputs.image-tag }}" \
          --set environment="${{ inputs.environment }}" \
          --wait \
          --timeout="${{ inputs.timeout }}" \
          --atomic \
          "${{ inputs.helm-chart }}" \
          ./helm/"${{ inputs.helm-chart }}"

    - name: Get deployment URL
      id: get-url
      run: |
        URL=$(kubectl get ingress \
          -n "${{ inputs.namespace }}" \
          -o jsonpath='{.items[0].spec.rules[0].host}')
        echo "url=https://${URL}" >> "$GITHUB_OUTPUT"

    - name: Run smoke tests
      run: |
        URL=$(kubectl get ingress \
          -n "${{ inputs.namespace }}" \
          -o jsonpath='{.items[0].spec.rules[0].host}')
        for i in $(seq 1 10); do
          if curl -sf "https://${URL}/health" | grep -q "ok"; then
            echo "Smoke test passed"
            exit 0
          fi
          sleep 10
        done
        echo "Smoke test failed"
        exit 1
```

### Calling the Reusable Workflow

```yaml
# .github/workflows/deploy.yml in org/app-repo
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
        default: staging

jobs:
  build:
    uses: org/platform-workflows/.github/workflows/reusable-build.yml@main
    with:
      registry: ghcr.io/org
      image-name: payment-api
    secrets: inherit

  deploy-staging:
    needs: build
    uses: org/platform-workflows/.github/workflows/reusable-deploy.yml@main
    with:
      environment: staging
      image-tag: ${{ needs.build.outputs.image-tag }}
      namespace: payment-api-staging
    secrets:
      AWS_ROLE_ARN: ${{ secrets.STAGING_AWS_ROLE_ARN }}
      CLUSTER_NAME: ${{ secrets.STAGING_CLUSTER_NAME }}

  deploy-production:
    needs: [build, deploy-staging]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    uses: org/platform-workflows/.github/workflows/reusable-deploy.yml@main
    with:
      environment: production
      image-tag: ${{ needs.build.outputs.image-tag }}
      namespace: payment-api-production
      timeout: 10m
    secrets:
      AWS_ROLE_ARN: ${{ secrets.PRODUCTION_AWS_ROLE_ARN }}
      CLUSTER_NAME: ${{ secrets.PRODUCTION_CLUSTER_NAME }}
```

## Section 5: Composite Actions

Composite actions group multiple steps into a reusable action without the overhead of a separate workflow:

```yaml
# .github/actions/setup-kubectl/action.yml
name: Setup kubectl and cloud auth
description: Configures kubectl for a target Kubernetes cluster

inputs:
  cloud-provider:
    description: "Cloud provider (aws/gcp/azure)"
    required: true
  cluster-name:
    description: "Cluster name"
    required: true
  region:
    description: "Cloud region"
    required: true
  aws-role-arn:
    description: "AWS role ARN (for AWS)"
    required: false
  gcp-workload-identity-provider:
    description: "GCP Workload Identity Provider (for GCP)"
    required: false
  gcp-service-account:
    description: "GCP Service Account email (for GCP)"
    required: false

outputs:
  context:
    description: "kubectl context name"
    value: ${{ steps.get-context.outputs.context }}

runs:
  using: composite
  steps:
  - name: Install kubectl
    shell: bash
    run: |
      KUBECTL_VERSION=$(curl -sL https://dl.k8s.io/release/stable.txt)
      curl -sLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
      chmod +x kubectl
      sudo mv kubectl /usr/local/bin/

  - name: AWS auth and kubeconfig
    if: inputs.cloud-provider == 'aws'
    uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502  # v4.0.2
    with:
      role-to-assume: ${{ inputs.aws-role-arn }}
      aws-region: ${{ inputs.region }}

  - name: AWS get kubeconfig
    if: inputs.cloud-provider == 'aws'
    shell: bash
    run: |
      aws eks update-kubeconfig \
        --region "${{ inputs.region }}" \
        --name "${{ inputs.cluster-name }}"

  - name: GCP auth
    if: inputs.cloud-provider == 'gcp'
    uses: google-github-actions/auth@v2
    with:
      workload_identity_provider: ${{ inputs.gcp-workload-identity-provider }}
      service_account: ${{ inputs.gcp-service-account }}

  - name: GCP get kubeconfig
    if: inputs.cloud-provider == 'gcp'
    uses: google-github-actions/get-gke-credentials@v2
    with:
      cluster_name: ${{ inputs.cluster-name }}
      location: ${{ inputs.region }}

  - name: Get context name
    id: get-context
    shell: bash
    run: |
      CONTEXT=$(kubectl config current-context)
      echo "context=${CONTEXT}" >> "$GITHUB_OUTPUT"
```

Using the composite action:

```yaml
- name: Setup kubectl
  uses: ./.github/actions/setup-kubectl
  with:
    cloud-provider: aws
    cluster-name: production-cluster
    region: us-east-1
    aws-role-arn: ${{ secrets.AWS_ROLE_ARN }}
```

## Section 6: Matrix Deployments

Matrix deployments enable parallel deployment to multiple environments, regions, or clusters:

```yaml
jobs:
  deploy:
    strategy:
      fail-fast: false    # Don't cancel other deployments if one fails
      max-parallel: 3
      matrix:
        include:
        - environment: production
          cluster: prod-us-east-1
          region: us-east-1
          role_arn_secret: PROD_USE1_ROLE_ARN
          weight: 40
        - environment: production
          cluster: prod-eu-west-1
          region: eu-west-1
          role_arn_secret: PROD_EUW1_ROLE_ARN
          weight: 35
        - environment: production
          cluster: prod-ap-southeast-1
          region: ap-southeast-1
          role_arn_secret: PROD_APSE1_ROLE_ARN
          weight: 25

    runs-on: ubuntu-latest
    environment:
      name: ${{ matrix.environment }}

    permissions:
      id-token: write
      contents: read

    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502  # v4.0.2
      with:
        role-to-assume: ${{ secrets[matrix.role_arn_secret] }}
        aws-region: ${{ matrix.region }}

    - name: Deploy to ${{ matrix.cluster }}
      run: |
        aws eks update-kubeconfig \
          --region "${{ matrix.region }}" \
          --name "${{ matrix.cluster }}"

        helm upgrade --install \
          --namespace payment-api \
          --set image.tag="${{ github.sha }}" \
          --set replicaCount="${{ matrix.weight }}" \
          --wait --atomic \
          payment-api ./helm/payment-api

    - name: Verify deployment health
      run: |
        kubectl rollout status deployment/payment-api \
          -n payment-api \
          --timeout=5m

    - name: Create deployment summary
      run: |
        echo "### Deployment to ${{ matrix.cluster }}" >> "$GITHUB_STEP_SUMMARY"
        echo "" >> "$GITHUB_STEP_SUMMARY"
        echo "- Image: \`${{ github.sha }}\`" >> "$GITHUB_STEP_SUMMARY"
        echo "- Region: \`${{ matrix.region }}\`" >> "$GITHUB_STEP_SUMMARY"
        echo "- Weight: \`${{ matrix.weight }}%\`" >> "$GITHUB_STEP_SUMMARY"
```

## Section 7: Environment Protection Rules and Deployment Freeze

### Environment Configuration

GitHub Environments provide deployment protection rules, required reviewers, and secret scoping:

```yaml
# .github/workflows/production-deploy.yml
jobs:
  deploy:
    environment:
      name: production                          # Links to GitHub Environment settings
      url: https://api.example.com/health
    runs-on: ubuntu-latest
```

Protection rules are configured in the GitHub UI or via the API:

```bash
# Configure environment via GitHub CLI
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/org/app-repo/environments/production \
  -f deployment_branch_policy='{"protected_branches":true,"custom_branch_policies":false}' \
  -F reviewers='[{"type":"Team","id":TEAM_ID}]' \
  -F wait_timer=5
```

### Deployment Freeze Pattern

Implement deployment freeze windows using concurrency groups and conditional logic:

```yaml
jobs:
  check-freeze:
    runs-on: ubuntu-latest
    outputs:
      is-frozen: ${{ steps.check.outputs.frozen }}
    steps:
    - name: Check deployment freeze
      id: check
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        # Check for freeze label on the latest release
        FROZEN=$(gh api \
          /repos/${{ github.repository }}/issues \
          --jq '[.[] | select(.labels[].name == "deployment-freeze")] | length > 0')
        echo "frozen=${FROZEN}" >> "$GITHUB_OUTPUT"
        if [ "${FROZEN}" = "true" ]; then
          echo "::warning::Deployment freeze is active. Deployment blocked."
        fi

  deploy:
    needs: check-freeze
    if: needs.check-freeze.outputs.is-frozen != 'true'
    runs-on: ubuntu-latest
    # ...
```

### Concurrency Control

Prevent multiple deployments from running simultaneously to the same environment:

```yaml
# Workflow-level concurrency
concurrency:
  group: deploy-${{ github.ref }}-${{ inputs.environment }}
  cancel-in-progress: false  # Queue, don't cancel in-progress deployments

jobs:
  deploy:
    # Job-level concurrency for environment-specific locks
    concurrency:
      group: environment-${{ matrix.cluster }}
      cancel-in-progress: false
```

## Section 8: Caching and Artifact Management

### Dependency Caching

```yaml
- name: Cache Go modules
  uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c6158d  # v4.2.0
  with:
    path: |
      ~/.cache/go-build
      ~/go/pkg/mod
    key: ${{ runner.os }}-go-${{ hashFiles('**/go.sum') }}
    restore-keys: |
      ${{ runner.os }}-go-

- name: Cache Docker layers
  uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c6158d  # v4.2.0
  with:
    path: /tmp/.buildx-cache
    key: ${{ runner.os }}-buildx-${{ github.sha }}
    restore-keys: |
      ${{ runner.os }}-buildx-

- name: Build with layer caching
  uses: docker/build-push-action@471d1dc4e07e5cdedd8fcfe5faff9ef7f15fd03b  # v6.9.0
  with:
    context: .
    push: true
    tags: ghcr.io/org/app:${{ github.sha }}
    cache-from: type=local,src=/tmp/.buildx-cache
    cache-to: type=local,dest=/tmp/.buildx-cache-new,mode=max

# Prevent cache from growing indefinitely
- name: Move cache
  run: |
    rm -rf /tmp/.buildx-cache
    mv /tmp/.buildx-cache-new /tmp/.buildx-cache
```

### Using GitHub Actions Cache for Large Test Fixtures

```yaml
- name: Restore test database fixtures
  id: cache-fixtures
  uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c6158d  # v4.2.0
  with:
    path: testdata/fixtures
    key: fixtures-${{ hashFiles('scripts/generate-fixtures.sh') }}

- name: Generate fixtures if cache miss
  if: steps.cache-fixtures.outputs.cache-hit != 'true'
  run: ./scripts/generate-fixtures.sh
```

### Artifact Passing Between Jobs

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.meta.outputs.version }}
    steps:
    - name: Build binary
      run: go build -o ./dist/app ./cmd/app

    - name: Upload binary artifact
      uses: actions/upload-artifact@6f51ac03b9356f520e9adb1b1b7802705f340c2b  # v4.5.0
      with:
        name: app-binary
        path: ./dist/app
        retention-days: 7

    - name: Extract Docker metadata
      id: meta
      uses: docker/metadata-action@369eb591f429131d6889c46b94e711f089e6ca96  # v5.6.1
      with:
        images: ghcr.io/org/app

  integration-test:
    needs: build
    runs-on: ubuntu-latest
    steps:
    - name: Download binary
      uses: actions/download-artifact@fa0a91b85d4f404e444306234fc2a35e4b0c66a0  # v4.1.8
      with:
        name: app-binary
        path: ./dist

    - name: Run integration tests
      run: |
        chmod +x ./dist/app
        ./dist/app &
        sleep 2
        curl -sf http://localhost:8080/health
```

## Section 9: Complete Multi-Environment Deployment Pipeline

Bringing all patterns together into a complete, production-grade pipeline:

```yaml
# .github/workflows/ci-cd.yml
name: CI/CD Pipeline

on:
  push:
    branches: [main, "release/*"]
  pull_request:
    branches: [main]
  workflow_dispatch:
    inputs:
      deploy-environment:
        type: choice
        options: [staging, production]
        description: "Target environment"

# Default to minimal permissions — override per job
permissions: {}

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  # ─── Static Analysis ────────────────────────────────────────────────────────
  lint-and-test:
    name: Lint and Test
    runs-on: arc-runner-set
    permissions:
      contents: read
      checks: write
    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

    - name: Setup Go
      uses: actions/setup-go@f111f3307d8850f501ac008e886eec1fd1932a34  # v5.3.0
      with:
        go-version-file: go.mod
        cache: true

    - name: Run tests
      run: go test -race -coverprofile=coverage.out ./...

    - name: Upload coverage to Codecov
      uses: codecov/codecov-action@v5
      with:
        files: coverage.out

  # ─── Security Scanning ──────────────────────────────────────────────────────
  security-scan:
    name: Security Scan
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

    - name: Run Trivy vulnerability scanner
      uses: aquasecurity/trivy-action@master
      with:
        scan-type: fs
        scan-ref: .
        exit-code: 1
        severity: HIGH,CRITICAL
        format: sarif
        output: trivy-results.sarif

    - name: Upload Trivy results
      uses: github/codeql-action/upload-sarif@v3
      with:
        sarif_file: trivy-results.sarif

  # ─── Build and Push ─────────────────────────────────────────────────────────
  build:
    name: Build and Push
    needs: [lint-and-test, security-scan]
    runs-on: arc-runner-set
    permissions:
      contents: read
      packages: write
      id-token: write
      attestations: write
    outputs:
      image-digest: ${{ steps.build.outputs.digest }}
      image-url: ${{ steps.build.outputs.imageid }}
      version: ${{ steps.meta.outputs.version }}
    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

    - name: Login to GHCR
      uses: docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567  # v3.3.0
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Extract metadata
      id: meta
      uses: docker/metadata-action@369eb591f429131d6889c46b94e711f089e6ca96  # v5.6.1
      with:
        images: ghcr.io/${{ github.repository }}
        tags: |
          type=sha,prefix=,suffix=,format=long
          type=semver,pattern={{version}}
          type=ref,event=branch

    - name: Build and push
      id: build
      uses: docker/build-push-action@471d1dc4e07e5cdedd8fcfe5faff9ef7f15fd03b  # v6.9.0
      with:
        context: .
        push: true
        tags: ${{ steps.meta.outputs.tags }}
        labels: ${{ steps.meta.outputs.labels }}
        provenance: true
        sbom: true

    - name: Generate artifact attestation
      uses: actions/attest-build-provenance@v2
      with:
        subject-name: ghcr.io/${{ github.repository }}
        subject-digest: ${{ steps.build.outputs.digest }}
        push-to-registry: true

  # ─── Deploy Staging ─────────────────────────────────────────────────────────
  deploy-staging:
    name: Deploy to Staging
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: https://staging.api.example.com/health
    permissions:
      id-token: write
      contents: read
    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
    - uses: ./.github/actions/setup-kubectl
      with:
        cloud-provider: aws
        cluster-name: staging-cluster
        region: us-east-1
        aws-role-arn: ${{ secrets.STAGING_AWS_ROLE_ARN }}

    - name: Deploy
      run: |
        helm upgrade --install payment-api ./helm/payment-api \
          --namespace payment-api-staging \
          --create-namespace \
          --set image.tag="${{ github.sha }}" \
          --set environment=staging \
          --wait --atomic --timeout=10m

  # ─── Deploy Production ──────────────────────────────────────────────────────
  deploy-production:
    name: Deploy to Production
    needs: [build, deploy-staging]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://api.example.com/health
    permissions:
      id-token: write
      contents: read
    strategy:
      fail-fast: false
      matrix:
        region: [us-east-1, eu-west-1]
    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502  # v4.0.2
      with:
        role-to-assume: ${{ secrets[format('PROD_{0}_ROLE_ARN', matrix.region)] }}
        aws-region: ${{ matrix.region }}

    - name: Deploy to ${{ matrix.region }}
      run: |
        aws eks update-kubeconfig \
          --region "${{ matrix.region }}" \
          --name "prod-${{ matrix.region }}"

        helm upgrade --install payment-api ./helm/payment-api \
          --namespace payment-api \
          --create-namespace \
          --set image.tag="${{ github.sha }}" \
          --set environment=production \
          --wait --atomic --timeout=10m

    - name: Deployment summary
      run: |
        echo "## Production Deployment — ${{ matrix.region }}" >> "$GITHUB_STEP_SUMMARY"
        echo "- Image: \`${{ github.sha }}\`" >> "$GITHUB_STEP_SUMMARY"
        echo "- Status: Success" >> "$GITHUB_STEP_SUMMARY"
```

## Section 10: Workflow Monitoring and Observability

### Job Summaries

GitHub Actions job summaries provide rich HTML output in the Actions UI:

```bash
# In any run step
cat << 'EOF' >> "$GITHUB_STEP_SUMMARY"
## Deployment Report

| Environment | Cluster | Status | Duration |
|-------------|---------|--------|----------|
| Production  | us-east-1 | ✅ Success | 3m 42s |
| Production  | eu-west-1 | ✅ Success | 4m 11s |

### Image Details
- **Tag**: `${{ github.sha }}`
- **Digest**: `sha256:abc123...`
- **SBOM**: [View attestation](https://ghcr.io/org/app@sha256:abc123...)
EOF
```

### Sending Workflow Status to External Systems

```yaml
- name: Notify deployment status
  if: always()
  uses: slackapi/slack-github-action@v2
  with:
    webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
    webhook-type: incoming-webhook
    payload: |
      {
        "text": "${{ job.status == 'success' && 'Deployment succeeded' || 'Deployment FAILED' }}: ${{ github.repository }} to production",
        "attachments": [
          {
            "color": "${{ job.status == 'success' && '#36a64f' || '#dc3545' }}",
            "fields": [
              {"title": "Repository", "value": "${{ github.repository }}", "short": true},
              {"title": "Branch", "value": "${{ github.ref_name }}", "short": true},
              {"title": "Commit", "value": "${{ github.sha }}", "short": true},
              {"title": "Actor", "value": "${{ github.actor }}", "short": true},
              {"title": "Run", "value": "<${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View Run>", "short": false}
            ]
          }
        ]
      }
```

The combination of OIDC-based authentication, ARC self-hosted runners, environment protection rules, and reusable workflows creates a GitHub Actions platform that matches enterprise security requirements while maintaining the developer experience advantages that make GitHub Actions the most widely adopted CI/CD system in the industry.
