---
title: "GitHub Actions Advanced: Reusable Workflows, Matrix Strategies, and Self-Hosted Runners"
date: 2028-09-21T00:00:00-05:00
draft: false
tags: ["GitHub Actions", "CI/CD", "DevOps", "Automation", "Kubernetes"]
categories:
- GitHub Actions
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "Master GitHub Actions advanced features including reusable workflows with workflow_call, dynamic matrix strategies, composite actions, self-hosted runners on Kubernetes with ARC, OIDC authentication, and workflow optimization techniques for enterprise CI/CD pipelines."
more_link: "yes"
url: "/github-actions-advanced-reusable-workflows-guide/"
---

GitHub Actions has matured into a full-featured CI/CD platform, but most teams only scratch the surface of what it can do. Reusable workflows eliminate duplication across repositories, dynamic matrix strategies handle complex build permutations, and OIDC authentication removes the need to store long-lived credentials. Self-hosted runners on Kubernetes with the Actions Runner Controller (ARC) provide scalable, cost-efficient execution that matches your workload.

This guide covers the patterns that make large-scale GitHub Actions deployments maintainable and performant.

<!--more-->

# GitHub Actions Advanced: Reusable Workflows, Matrix Strategies, and Self-Hosted Runners

## Reusable Workflows with workflow_call

Reusable workflows let you define a workflow once and call it from multiple repositories or workflows. The calling workflow passes inputs and secrets; the called workflow exposes outputs.

### Defining a Reusable Workflow

Create `.github/workflows/build-and-test.yml` in a shared repository:

```yaml
# .github/workflows/build-and-test.yml
# In repository: my-org/shared-workflows
name: Build and Test

on:
  workflow_call:
    inputs:
      go-version:
        description: "Go version to use"
        type: string
        required: false
        default: "1.22"
      working-directory:
        description: "Directory containing go.mod"
        type: string
        required: false
        default: "."
      run-integration-tests:
        description: "Whether to run integration tests"
        type: boolean
        required: false
        default: false
      registry:
        description: "Container registry hostname"
        type: string
        required: false
        default: "ghcr.io"
    secrets:
      SONAR_TOKEN:
        required: false
      REGISTRY_PASSWORD:
        required: true
    outputs:
      image-tag:
        description: "The published container image tag"
        value: ${{ jobs.build.outputs.image-tag }}
      test-coverage:
        description: "Test coverage percentage"
        value: ${{ jobs.test.outputs.coverage }}

jobs:
  test:
    runs-on: ubuntu-latest
    outputs:
      coverage: ${{ steps.coverage.outputs.percentage }}
    defaults:
      run:
        working-directory: ${{ inputs.working-directory }}
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: ${{ inputs.go-version }}
          cache: true
          cache-dependency-path: ${{ inputs.working-directory }}/go.sum

      - name: Run unit tests
        run: |
          go test -v -race -coverprofile=coverage.out -covermode=atomic ./...
          go tool cover -func=coverage.out

      - name: Extract coverage percentage
        id: coverage
        run: |
          COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | sed 's/%//')
          echo "percentage=${COVERAGE}" >> "$GITHUB_OUTPUT"
          echo "Test coverage: ${COVERAGE}%"

      - name: Run integration tests
        if: inputs.run-integration-tests
        run: |
          go test -v -tags=integration -timeout=10m ./...

      - name: Upload coverage report
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: ${{ inputs.working-directory }}/coverage.out
          retention-days: 7

  lint:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${{ inputs.working-directory }}
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: ${{ inputs.go-version }}
          cache: true

      - name: Run golangci-lint
        uses: golangci/golangci-lint-action@v6
        with:
          version: v1.59
          working-directory: ${{ inputs.working-directory }}
          args: --timeout=5m

  build:
    runs-on: ubuntu-latest
    needs: [test, lint]
    outputs:
      image-tag: ${{ steps.meta.outputs.tags }}
    steps:
      - uses: actions/checkout@v4

      - name: Docker meta
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ inputs.registry }}/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=sha,prefix=sha-,format=short

      - name: Log in to registry
        uses: docker/login-action@v3
        with:
          registry: ${{ inputs.registry }}
          username: ${{ github.actor }}
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ${{ inputs.working-directory }}
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### Calling the Reusable Workflow

```yaml
# .github/workflows/ci.yml
# In any consuming repository
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  build-test:
    uses: my-org/shared-workflows/.github/workflows/build-and-test.yml@main
    with:
      go-version: "1.22"
      working-directory: "."
      run-integration-tests: ${{ github.ref == 'refs/heads/main' }}
      registry: ghcr.io
    secrets:
      REGISTRY_PASSWORD: ${{ secrets.GITHUB_TOKEN }}
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}

  notify-on-failure:
    runs-on: ubuntu-latest
    needs: build-test
    if: failure()
    steps:
      - name: Send Slack notification
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            {
              "text": "Build failed for ${{ github.repository }} on branch ${{ github.ref_name }}",
              "attachments": [{
                "color": "danger",
                "fields": [{
                  "title": "Coverage",
                  "value": "${{ needs.build-test.outputs.test-coverage }}%",
                  "short": true
                }]
              }]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## Matrix Strategies with Include and Exclude

Matrix strategies expand a single job into multiple parallel jobs. The `include` and `exclude` directives give fine-grained control over which combinations run.

### Multi-Platform Cross-Version Matrix

```yaml
# .github/workflows/matrix-build.yml
name: Matrix Build

on:
  push:
    branches: [main]

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-22.04, ubuntu-24.04, windows-latest, macos-14]
        go-version: ["1.21", "1.22", "1.23"]
        arch: [amd64, arm64]
        exclude:
          # Windows does not support arm64 runners in GitHub-hosted
          - os: windows-latest
            arch: arm64
          # macOS arm64 (M-series) only supports Go 1.21+, already covered
          # Skip oldest Go on newest OS to reduce matrix size
          - os: ubuntu-24.04
            go-version: "1.21"
        include:
          # Add an extra variable for the oldest supported config
          - os: ubuntu-22.04
            go-version: "1.21"
            arch: amd64
            is-minimum-supported: true
          # Test with gotip on latest Ubuntu only
          - os: ubuntu-24.04
            go-version: "tip"
            arch: amd64
            experimental: true

    runs-on: ${{ matrix.os }}
    continue-on-error: ${{ matrix.experimental == true }}

    steps:
      - uses: actions/checkout@v4

      - name: Set up Go ${{ matrix.go-version }}
        uses: actions/setup-go@v5
        with:
          go-version: ${{ matrix.go-version == 'tip' && '' || matrix.go-version }}
          go-version-file: ${{ matrix.go-version == 'tip' && 'go.mod' || '' }}
          check-latest: ${{ matrix.go-version == 'tip' }}

      - name: Build
        run: |
          GOARCH=${{ matrix.arch }} go build ./...

      - name: Test
        run: |
          GOARCH=${{ matrix.arch }} go test -v ./...

      - name: Run minimum-support checks
        if: matrix.is-minimum-supported
        run: |
          echo "Running extra checks for minimum supported configuration"
          go vet ./...
          go mod tidy
          git diff --exit-code go.sum
```

### Dynamic Matrix from JSON

Generate matrix configurations dynamically from an API or repository state:

```yaml
# .github/workflows/dynamic-matrix.yml
name: Dynamic Matrix

on:
  push:
    branches: [main]

jobs:
  generate-matrix:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.set-matrix.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4

      - name: Generate matrix from services
        id: set-matrix
        run: |
          # Discover all services with a Dockerfile
          SERVICES=$(find ./services -name "Dockerfile" -printf '%h\n' | sed 's|./services/||' | sort -u)

          # Build JSON matrix
          MATRIX=$(echo "$SERVICES" | jq -R -s -c '
            split("\n") |
            map(select(length > 0)) |
            map({
              "service": .,
              "registry": "ghcr.io/my-org"
            }) |
            {"include": .}
          ')

          echo "matrix=${MATRIX}" >> "$GITHUB_OUTPUT"
          echo "Generated matrix: ${MATRIX}"

  build-services:
    needs: generate-matrix
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.generate-matrix.outputs.matrix) }}

    steps:
      - uses: actions/checkout@v4

      - name: Build ${{ matrix.service }}
        uses: docker/build-push-action@v5
        with:
          context: ./services/${{ matrix.service }}
          push: true
          tags: ${{ matrix.registry }}/${{ matrix.service }}:${{ github.sha }}
```

## Composite Actions

Composite actions bundle multiple steps into a reusable action stored in the repository. Unlike reusable workflows, they run within the calling job's environment.

### Building a Composite Action

Create the action in `.github/actions/setup-environment/action.yml`:

```yaml
# .github/actions/setup-environment/action.yml
name: Setup Build Environment
description: Sets up Go, Docker buildx, and configures caching

inputs:
  go-version:
    description: "Go version"
    required: false
    default: "1.22"
  enable-docker:
    description: "Whether to set up Docker buildx"
    required: false
    default: "true"
  cache-key-prefix:
    description: "Prefix for cache keys"
    required: false
    default: "build"

outputs:
  go-cache-hit:
    description: "Whether the Go module cache was restored"
    value: ${{ steps.go-cache.outputs.cache-hit }}

runs:
  using: composite
  steps:
    - name: Set up Go
      uses: actions/setup-go@v5
      with:
        go-version: ${{ inputs.go-version }}
        cache: false  # We manage cache manually for more control

    - name: Restore Go module cache
      id: go-cache
      uses: actions/cache@v4
      with:
        path: |
          ~/go/pkg/mod
          ~/.cache/go-build
        key: ${{ runner.os }}-${{ inputs.cache-key-prefix }}-go-${{ inputs.go-version }}-${{ hashFiles('**/go.sum') }}
        restore-keys: |
          ${{ runner.os }}-${{ inputs.cache-key-prefix }}-go-${{ inputs.go-version }}-
          ${{ runner.os }}-${{ inputs.cache-key-prefix }}-go-

    - name: Install tools
      shell: bash
      run: |
        go install github.com/golangci/golangci-lint/cmd/golangci-lint@v1.59.1
        go install gotest.tools/gotestsum@latest
        go install github.com/axw/gocov/gocov@latest

    - name: Set up Docker Buildx
      if: inputs.enable-docker == 'true'
      uses: docker/setup-buildx-action@v3
      with:
        driver-opts: |
          network=host
          image=moby/buildkit:v0.13.0

    - name: Validate environment
      shell: bash
      run: |
        echo "Go version: $(go version)"
        echo "Go cache hit: ${{ steps.go-cache.outputs.cache-hit }}"
        if [[ "${{ inputs.enable-docker }}" == "true" ]]; then
          docker buildx version
        fi
```

Using the composite action:

```yaml
# .github/workflows/use-composite.yml
name: Use Composite Action

on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup environment
        uses: ./.github/actions/setup-environment
        with:
          go-version: "1.22"
          enable-docker: "true"
          cache-key-prefix: "ci"

      - name: Build
        run: go build ./...

      - name: Test
        run: gotestsum --format=testdox -- ./...
```

## Self-Hosted Runners on Kubernetes with ARC

The Actions Runner Controller (ARC) manages GitHub Actions runners as Kubernetes workloads. It scales runner pods on demand and tears them down after each job.

### Installing ARC with Helm

```bash
# Add the ARC Helm repository
helm repo add actions-runner-controller \
  https://actions-runner-controller.github.io/actions-runner-controller
helm repo update

# Create namespace
kubectl create namespace arc-system

# Install ARC controller
helm install arc \
  --namespace arc-system \
  --create-namespace \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller \
  --version 0.9.3 \
  --set "authSecret.create=true" \
  --set "authSecret.github_token=${GITHUB_PAT}"
```

### RunnerScaleSet Configuration

```yaml
# arc-runner-scale-set.yml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: arc-runner-scale-set
  namespace: arc-system
spec:
  chart: oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
  version: "0.9.3"
  targetNamespace: arc-runners
  createNamespace: true
  valuesContent: |-
    githubConfigUrl: "https://github.com/my-org/my-repo"
    githubConfigSecret: arc-runner-secret

    minRunners: 0
    maxRunners: 20

    runnerGroup: "kubernetes"
    runnerScaleSetName: "k8s-runners"

    template:
      spec:
        initContainers:
          - name: init-dind-externals
            image: ghcr.io/actions/actions-runner:latest
            command: ["cp", "-r", "-v", "/home/runner/externals/.", "/home/runner/tmpDir/"]
            volumeMounts:
              - name: dind-externals
                mountPath: /home/runner/tmpDir

        containers:
          - name: runner
            image: ghcr.io/actions/actions-runner:latest
            command: ["/home/runner/run.sh"]
            env:
              - name: DOCKER_HOST
                value: unix:///var/run/docker.sock
            resources:
              requests:
                cpu: "500m"
                memory: "512Mi"
              limits:
                cpu: "2"
                memory: "4Gi"
            volumeMounts:
              - name: work
                mountPath: /home/runner/_work
              - name: dind-sock
                mountPath: /var/run
              - name: dind-externals
                mountPath: /home/runner/externals

          - name: dind
            image: docker:24-dind
            args:
              - dockerd
              - --host=unix:///var/run/docker.sock
              - --group=$(DOCKER_GROUP_GID)
            env:
              - name: DOCKER_GROUP_GID
                value: "123"
            securityContext:
              privileged: true
            volumeMounts:
              - name: work
                mountPath: /home/runner/_work
              - name: dind-sock
                mountPath: /var/run
              - name: dind-externals
                mountPath: /home/runner/externals

        volumes:
          - name: work
            emptyDir: {}
          - name: dind-sock
            emptyDir: {}
          - name: dind-externals
            emptyDir: {}

        nodeSelector:
          kubernetes.io/os: linux
          node-role.kubernetes.io/worker: ""

        tolerations:
          - key: "dedicated"
            operator: "Equal"
            value: "ci"
            effect: "NoSchedule"
```

```bash
# Create the GitHub PAT secret
kubectl create secret generic arc-runner-secret \
  --namespace arc-runners \
  --from-literal=github_token="${GITHUB_PAT}"

# Apply the scale set
kubectl apply -f arc-runner-scale-set.yml
```

Referencing the self-hosted runner in a workflow:

```yaml
jobs:
  build-on-k8s:
    runs-on: k8s-runners  # matches runnerScaleSetName
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: go build ./...
```

## Caching Strategies

### Go Module and Build Cache

```yaml
# .github/workflows/go-caching.yml
name: Go with Optimal Caching

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          # setup-go handles go module and build cache automatically
          # when cache: true (default). Explicitly configure for monorepos:
          cache-dependency-path: |
            go.sum
            services/*/go.sum

      - name: Download dependencies
        run: go mod download -x

      - name: Build with build cache
        run: go build ./...

  # Separate job to show manual cache configuration
  build-manual-cache:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: false

      - name: Restore Go caches
        uses: actions/cache/restore@v4
        id: cache-restore
        with:
          path: |
            ~/go/pkg/mod
            ~/.cache/go-build
          key: go-${{ runner.os }}-${{ hashFiles('**/go.sum') }}
          restore-keys: |
            go-${{ runner.os }}-

      - name: Build
        run: go build ./...

      - name: Test
        run: go test ./...

      - name: Save Go caches
        if: always() && steps.cache-restore.outputs.cache-hit != 'true'
        uses: actions/cache/save@v4
        with:
          path: |
            ~/go/pkg/mod
            ~/.cache/go-build
          key: go-${{ runner.os }}-${{ hashFiles('**/go.sum') }}
```

### Docker Layer Caching with Buildx

```yaml
# .github/workflows/docker-cache.yml
name: Docker Build with Layer Cache

on:
  push:
    branches: [main]

jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push with registry cache
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
          # Cache from registry (persists across workflow runs)
          cache-from: |
            type=registry,ref=ghcr.io/${{ github.repository }}:cache
            type=registry,ref=ghcr.io/${{ github.repository }}:main
          cache-to: type=registry,ref=ghcr.io/${{ github.repository }}:cache,mode=max

      - name: Build with GHA cache (faster for self-hosted)
        uses: docker/build-push-action@v5
        with:
          context: .
          push: false
          tags: ghcr.io/${{ github.repository }}:test
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

## OIDC Authentication to AWS and GCP

OIDC lets workflows authenticate to cloud providers without storing long-lived credentials as secrets.

### AWS OIDC Setup

```bash
# Create the OIDC identity provider in AWS (one-time setup)
aws iam create-open-id-connect-provider \
  --url "https://token.actions.githubusercontent.com" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1"

# Create IAM role with trust policy
cat > trust-policy.json <<'EOF'
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
          "token.actions.githubusercontent.com:sub": "repo:my-org/my-repo:*"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
  --role-name GitHubActionsRole \
  --assume-role-policy-document file://trust-policy.json

aws iam attach-role-policy \
  --role-name GitHubActionsRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonECR-FullAccess
```

```yaml
# .github/workflows/aws-oidc.yml
name: Deploy to AWS with OIDC

on:
  push:
    branches: [main]

permissions:
  id-token: write   # Required for OIDC
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRole
          role-session-name: GitHubActions-${{ github.run_id }}
          aws-region: us-east-1

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push to ECR
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/my-app:$IMAGE_TAG .
          docker push $ECR_REGISTRY/my-app:$IMAGE_TAG

      - name: Deploy to EKS
        run: |
          aws eks update-kubeconfig --name my-cluster --region us-east-1
          kubectl set image deployment/my-app \
            app=${{ steps.login-ecr.outputs.registry }}/my-app:${{ github.sha }}
          kubectl rollout status deployment/my-app --timeout=5m
```

### GCP OIDC Setup

```bash
# Create a workload identity pool
gcloud iam workload-identity-pools create "github-actions" \
  --project="my-gcp-project" \
  --location="global" \
  --display-name="GitHub Actions Pool"

# Create the provider
gcloud iam workload-identity-pools providers create-oidc "github" \
  --project="my-gcp-project" \
  --location="global" \
  --workload-identity-pool="github-actions" \
  --display-name="GitHub OIDC Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# Allow the GitHub Actions service account to impersonate
gcloud iam service-accounts add-iam-policy-binding \
  "github-actions-sa@my-gcp-project.iam.gserviceaccount.com" \
  --project="my-gcp-project" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/github-actions/attribute.repository/my-org/my-repo"
```

```yaml
# .github/workflows/gcp-oidc.yml
name: Deploy to GCP with OIDC

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Authenticate to Google Cloud
        id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: "projects/123456789/locations/global/workloadIdentityPools/github-actions/providers/github"
          service_account: "github-actions-sa@my-gcp-project.iam.gserviceaccount.com"

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker us-central1-docker.pkg.dev --quiet

      - name: Build and push to Artifact Registry
        run: |
          IMAGE="us-central1-docker.pkg.dev/my-gcp-project/my-repo/app:${{ github.sha }}"
          docker build -t "$IMAGE" .
          docker push "$IMAGE"

      - name: Deploy to GKE
        uses: google-github-actions/get-gke-credentials@v2
        with:
          cluster_name: my-cluster
          location: us-central1

      - run: |
          kubectl set image deployment/my-app \
            app=us-central1-docker.pkg.dev/my-gcp-project/my-repo/app:${{ github.sha }}
          kubectl rollout status deployment/my-app
```

## Environment Protection Rules

Environment protection rules enforce gates such as required reviewers, wait timers, and branch restrictions before deployments proceed.

```yaml
# .github/workflows/deploy-with-environments.yml
name: Deploy with Environment Gates

on:
  push:
    branches: [main]

jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: https://staging.example.com
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to staging
        run: |
          echo "Deploying ${{ github.sha }} to staging"
          # Staging deployment commands here

  integration-tests:
    runs-on: ubuntu-latest
    needs: deploy-staging
    steps:
      - uses: actions/checkout@v4
      - name: Run integration tests against staging
        run: |
          curl -f https://staging.example.com/health
          # Run full integration test suite

  deploy-production:
    runs-on: ubuntu-latest
    needs: integration-tests
    # The 'production' environment requires manual approval
    # configured in GitHub repository settings
    environment:
      name: production
      url: https://example.com
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production
        run: |
          echo "Deploying ${{ github.sha }} to production"
          # Production deployment commands here
```

Configure environments via the GitHub API or UI. Protection rules include:

- Required reviewers (up to 6 people or teams)
- Wait timer (0 to 43,200 minutes)
- Deployment branches (only allow deployments from specific branches)
- Deployment tags (only allow tagged releases)

```bash
# Configure environment protection via GitHub CLI
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/my-org/my-repo/environments/production \
  --field "wait_timer=5" \
  --field "prevent_self_review=true" \
  --field 'reviewers=[{"type":"Team","id":12345}]' \
  --field 'deployment_branch_policy={"protected_branches":true,"custom_branch_policies":false}'
```

## Workflow Optimization and Performance

### Concurrency Controls

```yaml
# .github/workflows/optimized.yml
name: Optimized CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# Cancel in-progress runs for the same branch/PR when a new push arrives
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      backend: ${{ steps.filter.outputs.backend }}
      frontend: ${{ steps.filter.outputs.frontend }}
      infra: ${{ steps.filter.outputs.infra }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            backend:
              - 'backend/**'
              - 'go.mod'
              - 'go.sum'
            frontend:
              - 'frontend/**'
              - 'package.json'
              - 'package-lock.json'
            infra:
              - 'terraform/**'
              - 'helm/**'

  backend:
    needs: changes
    if: needs.changes.outputs.backend == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
      - run: go test ./backend/...

  frontend:
    needs: changes
    if: needs.changes.outputs.frontend == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
      - run: npm ci
      - run: npm test

  infra:
    needs: changes
    if: needs.changes.outputs.infra == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.9.0"
      - run: terraform -chdir=terraform fmt -check
      - run: terraform -chdir=terraform validate
```

### Workflow Security Hardening

```yaml
# .github/workflows/secure.yml
name: Secure Workflow

on:
  pull_request:
    branches: [main]

# Minimal top-level permissions
permissions:
  contents: read

jobs:
  security-scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write  # Only what this job needs
    steps:
      - uses: actions/checkout@v4
        with:
          # Avoid git credential persistence
          persist-credentials: false

      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@0.20.0  # Pin to exact version, not a tag
        with:
          scan-type: "fs"
          scan-ref: "."
          format: "sarif"
          output: "trivy-results.sarif"

      - name: Upload Trivy results to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: "trivy-results.sarif"

      - name: Run Semgrep
        uses: returntocorp/semgrep-action@v1
        with:
          config: >-
            p/security-audit
            p/golang
```

## Advanced Job Dependencies and Fan-out Fan-in

```yaml
# .github/workflows/fan-out-in.yml
name: Fan-Out Fan-In Pattern

on: [push]

jobs:
  # Fan-out: run tests in parallel across 4 shards
  test-shard:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
      - name: Run shard ${{ matrix.shard }} of 4
        run: |
          # Use gotestsum's sharding support
          go install gotest.tools/gotestsum@latest
          gotestsum \
            --format=dots \
            --junitfile=test-results-${{ matrix.shard }}.xml \
            -- \
            -count=1 \
            $(go list ./... | awk "NR % 4 == (${{ matrix.shard }} - 1)")

      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results-shard-${{ matrix.shard }}
          path: test-results-${{ matrix.shard }}.xml

  # Fan-in: collect all results
  test-report:
    runs-on: ubuntu-latest
    needs: test-shard
    if: always()
    steps:
      - name: Download all test results
        uses: actions/download-artifact@v4
        with:
          pattern: test-results-shard-*
          merge-multiple: true

      - name: Publish test report
        uses: dorny/test-reporter@v1
        with:
          name: Go Tests
          path: "*.xml"
          reporter: java-junit
```

## Summary

GitHub Actions advanced features dramatically reduce CI/CD complexity at scale:

- **Reusable workflows** with `workflow_call` eliminate duplication across repositories and enforce consistent build patterns
- **Dynamic matrix strategies** with `include`/`exclude` and JSON generation handle complex build permutations efficiently
- **Composite actions** bundle common steps without the overhead of a separate repository or workflow
- **ARC on Kubernetes** provides auto-scaling, ephemeral runners that match exactly the compute you need and scale to zero between builds
- **GHA cache and registry cache** for Docker layers reduce build times by 60-80% in practice
- **OIDC authentication** removes long-lived credentials from secrets entirely, replacing them with short-lived tokens scoped to a specific workflow run
- **Environment protection rules** enforce compliance gates for production deployments without custom tooling
- **Concurrency controls** and **path filters** prevent wasted compute on redundant or irrelevant runs

The investment in proper workflow architecture pays off quickly as team size and repository count grow.
