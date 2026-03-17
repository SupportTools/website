---
title: "Kubernetes Tekton Pipelines: Cloud-Native CI/CD Patterns"
date: 2029-08-27T00:00:00-05:00
draft: false
tags: ["Tekton", "Kubernetes", "CI/CD", "Supply Chain Security", "DevOps", "Tekton Triggers", "Tekton Chains"]
categories: ["Kubernetes", "CI/CD", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building cloud-native CI/CD pipelines with Tekton, covering Task/Pipeline/PipelineRun CRDs, workspace sharing, Tekton Triggers, Tekton Chains for supply chain security, and a detailed comparison with GitHub Actions."
more_link: "yes"
url: "/kubernetes-tekton-pipelines-cloud-native-cicd-patterns/"
---

Tekton has matured into the de facto standard for cloud-native CI/CD on Kubernetes. Unlike external CI systems bolted onto a cluster, Tekton lives entirely inside Kubernetes, expressing every build concept as a custom resource. This guide walks through the full Tekton stack — from writing your first Task to signing artifacts with Tekton Chains — and explains when to choose Tekton over GitHub Actions or other hosted solutions.

<!--more-->

# Kubernetes Tekton Pipelines: Cloud-Native CI/CD Patterns

## Section 1: Why Tekton for Cloud-Native CI/CD

Traditional CI/CD systems were designed for monolithic applications running on fixed infrastructure. Jenkins requires dedicated servers, GitHub Actions couples your pipeline logic to GitHub's runtime, and most hosted CI platforms cannot access private Kubernetes APIs without network gymnastics. Tekton takes a fundamentally different approach: it runs entirely inside your Kubernetes cluster as a set of CRDs, uses standard Kubernetes primitives for scheduling and secrets, and integrates natively with service accounts, RBAC, and network policies.

The core Tekton design goals are:

- **Reusability**: Tasks are parameterized and composable into Pipelines
- **Isolation**: Every step runs in its own container with explicit resource limits
- **Auditability**: Every run creates immutable Kubernetes objects that can be queried and retained
- **Extensibility**: The Tekton Hub provides hundreds of community Tasks; custom Tasks are straightforward to write

For enterprise environments where compliance, air-gapped deployment, and integration with internal Kubernetes APIs matter, Tekton is often the only viable fully-native option.

### Installation

```bash
# Install Tekton Pipelines (latest stable)
kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/latest/release.yaml

# Install Tekton Triggers
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/release.yaml

# Install Tekton Chains
kubectl apply -f https://storage.googleapis.com/tekton-releases/chains/latest/release.yaml

# Install Tekton Dashboard (optional but useful)
kubectl apply -f https://storage.googleapis.com/tekton-releases/dashboard/latest/release.yaml

# Verify all components are running
kubectl get pods -n tekton-pipelines
kubectl get pods -n tekton-triggers
kubectl get pods -n tekton-chains
```

### RBAC Baseline

```yaml
# tekton-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tekton-sa
  namespace: ci
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: tekton-pipeline-runner
rules:
  - apiGroups: ["tekton.dev"]
    resources: ["tasks", "pipelines", "taskruns", "pipelineruns"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["pods", "pods/log", "secrets", "configmaps", "persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-pipeline-runner-binding
subjects:
  - kind: ServiceAccount
    name: tekton-sa
    namespace: ci
roleRef:
  kind: ClusterRole
  name: tekton-pipeline-runner
  apiGroup: rbac.authorization.k8s.io
```

## Section 2: Task CRD Deep Dive

A `Task` is the fundamental unit of work in Tekton. It defines a series of steps, each running in its own container image. Steps within a Task share an ephemeral workspace and can pass data between themselves via files.

### Anatomy of a Task

```yaml
# task-go-build.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: go-build
  namespace: ci
  labels:
    app.kubernetes.io/version: "0.1"
  annotations:
    tekton.dev/pipelines.minVersion: "0.44.0"
    tekton.dev/tags: go, build, test
spec:
  description: |
    Build and test a Go application, producing a binary and test coverage report.

  params:
    - name: image
      type: string
      description: Go builder image to use
      default: "golang:1.22-alpine"
    - name: package
      type: string
      description: Go package path (e.g., ./...)
      default: "./..."
    - name: go-flags
      type: string
      description: Additional go build flags
      default: "-trimpath -ldflags '-s -w'"
    - name: enable-race-detector
      type: string
      description: Enable Go race detector during tests
      default: "false"

  workspaces:
    - name: source
      description: Git source code
    - name: cache
      description: Go module cache
      optional: true

  results:
    - name: binary-path
      description: Path to the compiled binary
    - name: test-coverage
      description: Test coverage percentage
    - name: go-version
      description: Go version used for the build

  steps:
    - name: detect-go-version
      image: "$(params.image)"
      workingDir: "$(workspaces.source.path)"
      script: |
        #!/bin/sh
        set -eu
        GO_VER=$(go version | awk '{print $3}')
        echo "Building with ${GO_VER}"
        printf "%s" "${GO_VER}" | tee $(results.go-version.path)

    - name: download-modules
      image: "$(params.image)"
      workingDir: "$(workspaces.source.path)"
      env:
        - name: GOMODCACHE
          value: "$(workspaces.cache.path)/mod"
        - name: GOPROXY
          value: "https://proxy.golang.org,direct"
        - name: GONOSUMCHECK
          value: "*.internal.corp"
      script: |
        #!/bin/sh
        set -eu
        go mod download
        go mod verify

    - name: run-tests
      image: "$(params.image)"
      workingDir: "$(workspaces.source.path)"
      env:
        - name: GOMODCACHE
          value: "$(workspaces.cache.path)/mod"
        - name: RACE_FLAG
          value: "$(params.enable-race-detector)"
      script: |
        #!/bin/sh
        set -eu
        RACE=""
        if [ "${RACE_FLAG}" = "true" ]; then
          RACE="-race"
        fi
        go test ${RACE} -coverprofile=coverage.out -covermode=atomic $(params.package)
        COVERAGE=$(go tool cover -func coverage.out | grep total | awk '{print $3}')
        echo "Total coverage: ${COVERAGE}"
        printf "%s" "${COVERAGE}" | tee $(results.test-coverage.path)

    - name: build-binary
      image: "$(params.image)"
      workingDir: "$(workspaces.source.path)"
      env:
        - name: GOMODCACHE
          value: "$(workspaces.cache.path)/mod"
        - name: CGO_ENABLED
          value: "0"
        - name: GOOS
          value: "linux"
        - name: GOARCH
          value: "amd64"
      script: |
        #!/bin/sh
        set -eu
        BINARY_PATH="./bin/app"
        mkdir -p ./bin
        go build $(params.go-flags) -o ${BINARY_PATH} .
        ls -lh ${BINARY_PATH}
        printf "%s" "${BINARY_PATH}" | tee $(results.binary-path.path)

  sidecars:
    - name: docker-daemon
      image: docker:24-dind
      securityContext:
        privileged: true
      volumeMounts:
        - name: docker-graph-storage
          mountPath: /var/lib/docker

  volumes:
    - name: docker-graph-storage
      emptyDir: {}
```

### Parameterized Image Build Task

```yaml
# task-buildah.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: buildah
  namespace: ci
spec:
  params:
    - name: IMAGE
      description: Reference of the image buildah will produce
    - name: DOCKERFILE
      description: Path to the Dockerfile
      default: ./Dockerfile
    - name: CONTEXT
      description: Path to the build context
      default: .
    - name: BUILD_EXTRA_ARGS
      description: Extra args for buildah bud
      default: ""
    - name: PUSH_EXTRA_ARGS
      description: Extra args for buildah push
      default: ""
    - name: SKIP_PUSH
      description: Skip pushing the image
      default: "false"
    - name: TLS_VERIFY
      description: Verify TLS on the registry endpoint
      default: "true"

  workspaces:
    - name: source
    - name: dockerconfig
      description: An optional workspace that allows providing a .docker/config.json file for Buildah to access the container registry.
      optional: true
      mountPath: /root/.docker

  results:
    - name: IMAGE_DIGEST
      description: Digest of the image just built
    - name: IMAGE_URL
      description: URL of the image just pushed

  stepTemplate:
    securityContext:
      privileged: true
    env:
      - name: STORAGE_DRIVER
        value: overlay

  steps:
    - name: build
      image: quay.io/buildah/stable:latest
      workingDir: "$(workspaces.source.path)"
      script: |
        #!/usr/bin/env bash
        set -euo pipefail

        # Handle build args from environment
        buildah bud \
          --format=oci \
          --tls-verify=$(params.TLS_VERIFY) \
          --no-cache \
          $(params.BUILD_EXTRA_ARGS) \
          --file $(params.DOCKERFILE) \
          --tag $(params.IMAGE) \
          $(params.CONTEXT)

        [ "$(params.SKIP_PUSH)" = "true" ] && echo "Skipping push." && exit 0

        buildah push \
          --tls-verify=$(params.TLS_VERIFY) \
          $(params.PUSH_EXTRA_ARGS) \
          --digestfile /tmp/image-digest \
          $(params.IMAGE) \
          docker://$(params.IMAGE)

        cat /tmp/image-digest | tee $(results.IMAGE_DIGEST.path)
        echo -n "$(params.IMAGE)" | tee $(results.IMAGE_URL.path)

      volumeMounts:
        - name: varlibcontainers
          mountPath: /var/lib/containers

  volumes:
    - name: varlibcontainers
      emptyDir: {}
```

## Section 3: Pipeline CRD and Workspace Sharing

A `Pipeline` orchestrates multiple Tasks, defining execution order through `runAfter` dependencies, and sharing data through `workspaces`.

### Full Application Build Pipeline

```yaml
# pipeline-build-test-push.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: build-test-push
  namespace: ci
spec:
  description: |
    Build, test, scan, and push a Go application container image.

  params:
    - name: repo-url
      type: string
      description: Git repository URL
    - name: repo-revision
      type: string
      description: Git revision (branch, tag, SHA)
      default: main
    - name: image-name
      type: string
      description: Target container image name (without tag)
    - name: image-tag
      type: string
      description: Container image tag
    - name: dockerfile
      type: string
      default: ./Dockerfile
    - name: sonar-project-key
      type: string
      description: SonarQube project key
      default: ""

  workspaces:
    - name: shared-data
      description: Workspace shared across all tasks for source code
    - name: git-credentials
      description: SSH or HTTPS credentials for git clone
      optional: true
    - name: docker-credentials
      description: Docker registry credentials
    - name: go-cache
      description: Go module download cache
      optional: true

  results:
    - name: image-url
      description: Fully qualified image URL with digest
      value: "$(tasks.push-image.results.IMAGE_URL)@$(tasks.push-image.results.IMAGE_DIGEST)"
    - name: test-coverage
      value: "$(tasks.build-and-test.results.test-coverage)"
    - name: vulnerability-count
      value: "$(tasks.scan-image.results.vulnerability-count)"

  tasks:
    - name: fetch-source
      taskRef:
        resolver: hub
        params:
          - name: catalog
            value: tekton
          - name: type
            value: task
          - name: name
            value: git-clone
          - name: version
            value: "0.9"
      workspaces:
        - name: output
          workspace: shared-data
        - name: ssh-directory
          workspace: git-credentials
      params:
        - name: url
          value: "$(params.repo-url)"
        - name: revision
          value: "$(params.repo-revision)"
        - name: deleteExisting
          value: "true"

    - name: build-and-test
      taskRef:
        name: go-build
      runAfter:
        - fetch-source
      workspaces:
        - name: source
          workspace: shared-data
        - name: cache
          workspace: go-cache
      params:
        - name: package
          value: "./..."
        - name: enable-race-detector
          value: "true"

    - name: lint-code
      taskRef:
        resolver: hub
        params:
          - name: catalog
            value: tekton
          - name: type
            value: task
          - name: name
            value: golangci-lint
          - name: version
            value: "0.2"
      runAfter:
        - fetch-source
      workspaces:
        - name: source
          workspace: shared-data
      params:
        - name: package
          value: "./..."
        - name: flags
          value: "--timeout 5m"

    - name: push-image
      taskRef:
        name: buildah
      runAfter:
        - build-and-test
        - lint-code
      workspaces:
        - name: source
          workspace: shared-data
        - name: dockerconfig
          workspace: docker-credentials
      params:
        - name: IMAGE
          value: "$(params.image-name):$(params.image-tag)"
        - name: DOCKERFILE
          value: "$(params.dockerfile)"

    - name: scan-image
      taskRef:
        resolver: hub
        params:
          - name: catalog
            value: tekton
          - name: type
            value: task
          - name: name
            value: trivy-scanner
          - name: version
            value: "0.1"
      runAfter:
        - push-image
      params:
        - name: IMAGE_URL
          value: "$(tasks.push-image.results.IMAGE_URL)"
        - name: IMAGE_DIGEST
          value: "$(tasks.push-image.results.IMAGE_DIGEST)"
        - name: SEVERITY
          value: "CRITICAL,HIGH"

  finally:
    - name: notify-slack
      taskRef:
        name: send-to-channel-slack
      params:
        - name: token-secret
          value: slack-token
        - name: channel
          value: "#ci-notifications"
        - name: message
          value: "Pipeline $(context.pipelineRun.name) completed with status $(tasks.status)"
```

### PipelineRun with Dynamic Workspace Provisioning

```yaml
# pipelinerun-example.yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: build-myapp-run-001
  namespace: ci
  labels:
    app: myapp
    git-sha: abc1234
  annotations:
    tekton.dev/chains-signed: "false"
spec:
  pipelineRef:
    name: build-test-push
  serviceAccountName: tekton-sa

  params:
    - name: repo-url
      value: "https://github.com/myorg/myapp.git"
    - name: repo-revision
      value: "main"
    - name: image-name
      value: "registry.internal.corp/myorg/myapp"
    - name: image-tag
      value: "v1.2.3"

  workspaces:
    - name: shared-data
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          storageClassName: fast-ssd
          resources:
            requests:
              storage: 2Gi

    - name: git-credentials
      secret:
        secretName: git-ssh-credentials

    - name: docker-credentials
      secret:
        secretName: registry-dockerconfig

    - name: go-cache
      persistentVolumeClaim:
        claimName: go-module-cache
        readOnly: false

  timeouts:
    pipeline: "1h"
    tasks: "45m"
    finally: "10m"

  taskRunSpecs:
    - pipelineTaskName: build-and-test
      stepSpecs:
        - name: run-tests
          computeResources:
            requests:
              cpu: "2"
              memory: "4Gi"
            limits:
              cpu: "4"
              memory: "8Gi"
    - pipelineTaskName: push-image
      stepSpecs:
        - name: build
          computeResources:
            requests:
              cpu: "4"
              memory: "8Gi"
            limits:
              cpu: "8"
              memory: "16Gi"
```

## Section 4: Tekton Triggers — Event-Driven Pipeline Execution

Tekton Triggers connects external events (GitHub webhooks, GitLab hooks, container registry pushes) to PipelineRuns without requiring any external CI orchestrator.

### EventListener and TriggerBinding

```yaml
# triggers.yaml
---
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: push-trigger-template
  namespace: ci
spec:
  params:
    - name: git-repo-url
    - name: git-revision
    - name: git-repo-name
    - name: image-tag

  resourcetemplates:
    - apiVersion: tekton.dev/v1
      kind: PipelineRun
      metadata:
        generateName: "$(tt.params.git-repo-name)-run-"
        namespace: ci
        labels:
          tekton.dev/pipeline: build-test-push
          git-revision: "$(tt.params.git-revision)"
      spec:
        pipelineRef:
          name: build-test-push
        serviceAccountName: tekton-sa
        params:
          - name: repo-url
            value: "$(tt.params.git-repo-url)"
          - name: repo-revision
            value: "$(tt.params.git-revision)"
          - name: image-name
            value: "registry.internal.corp/myorg/$(tt.params.git-repo-name)"
          - name: image-tag
            value: "$(tt.params.image-tag)"
        workspaces:
          - name: shared-data
            volumeClaimTemplate:
              spec:
                accessModes:
                  - ReadWriteOnce
                storageClassName: fast-ssd
                resources:
                  requests:
                    storage: 2Gi
          - name: git-credentials
            secret:
              secretName: git-ssh-credentials
          - name: docker-credentials
            secret:
              secretName: registry-dockerconfig

---
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-push-binding
  namespace: ci
spec:
  params:
    - name: git-repo-url
      value: "$(body.repository.clone_url)"
    - name: git-revision
      value: "$(body.after)"
    - name: git-repo-name
      value: "$(body.repository.name)"
    - name: image-tag
      value: "$(body.after)"

---
apiVersion: triggers.tekton.dev/v1beta1
kind: Trigger
metadata:
  name: github-push-trigger
  namespace: ci
spec:
  interceptors:
    - ref:
        name: github
        kind: ClusterInterceptor
        apiVersion: triggers.tekton.dev/v1alpha1
      params:
        - name: secretRef
          value:
            secretName: github-webhook-secret
            secretKey: secret
        - name: eventTypes
          value:
            - push
    - ref:
        name: cel
        kind: ClusterInterceptor
        apiVersion: triggers.tekton.dev/v1alpha1
      params:
        - name: filter
          value: >-
            body.ref.startsWith('refs/heads/main') ||
            body.ref.startsWith('refs/tags/v')
        - name: overlays
          value:
            - key: image_tag
              expression: >-
                body.ref.startsWith('refs/tags/')
                ? body.ref.split('/')[2]
                : body.after.truncate(8)
  bindings:
    - ref: github-push-binding
  template:
    ref: push-trigger-template

---
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: github-listener
  namespace: ci
spec:
  serviceAccountName: tekton-triggers-sa
  resources:
    kubernetesResource:
      replicas: 2
      spec:
        template:
          spec:
            containers:
              - resources:
                  requests:
                    memory: "64Mi"
                    cpu: "250m"
                  limits:
                    memory: "128Mi"
                    cpu: "500m"
  triggers:
    - triggerRef: github-push-trigger
  namespaceSelector:
    matchNames:
      - ci
```

### Exposing the EventListener

```yaml
# eventlistener-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tekton-triggers-ingress
  namespace: ci
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - tekton-hooks.internal.corp
      secretName: tekton-hooks-tls
  rules:
    - host: tekton-hooks.internal.corp
      http:
        paths:
          - path: /github
            pathType: Prefix
            backend:
              service:
                name: el-github-listener
                port:
                  number: 8080
```

## Section 5: Tekton Chains — Supply Chain Security

Tekton Chains automatically signs TaskRun and PipelineRun results, producing in-toto attestations and SLSA provenance. This implements supply chain security without modifying any existing Task or Pipeline.

### Configuring Tekton Chains with Cosign

```bash
# Generate a cosign key pair (store private key in a Kubernetes secret)
cosign generate-key-pair k8s://tekton-chains/signing-secrets

# Verify the secret was created
kubectl get secret signing-secrets -n tekton-chains -o yaml
```

```yaml
# tekton-chains-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: chains-config
  namespace: tekton-chains
data:
  # Artifact storage backend
  artifacts.oci.storage: "oci"
  artifacts.oci.format: "simplesigning"
  artifacts.oci.signer: "x509"

  # TaskRun storage
  artifacts.taskrun.format: "in-toto"
  artifacts.taskrun.storage: "oci"
  artifacts.taskrun.signer: "x509"

  # PipelineRun storage
  artifacts.pipelinerun.format: "slsa/v1"
  artifacts.pipelinerun.storage: "oci"
  artifacts.pipelinerun.signer: "x509"

  # Transparency log
  transparency.enabled: "true"
  transparency.url: "https://rekor.sigstore.dev"

  # Builder ID for SLSA provenance
  builder.id: "https://tekton.internal.corp/chains/v2"
```

### Verifying Signatures

```bash
# After a PipelineRun completes, verify the image signature
IMAGE="registry.internal.corp/myorg/myapp:v1.2.3"

# Verify using cosign
cosign verify \
  --certificate-identity-regexp="https://github.com/myorg/myapp" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  "${IMAGE}"

# Verify SLSA provenance
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp="https://tekton.internal.corp" \
  --certificate-oidc-issuer="https://kubernetes.default.svc" \
  "${IMAGE}" | jq '.payload | @base64d | fromjson'

# Check Rekor transparency log entry
rekor-cli search --email tekton-sa@ci.svc.cluster.local
```

### Policy Enforcement with OPA

```yaml
# chains-policy.rego
package tekton.chains.policy

import future.keywords.if
import future.keywords.in

# Deny images that lack a valid Tekton Chains signature
deny[msg] if {
  input.kind == "Pod"
  container := input.spec.containers[_]
  not has_valid_signature(container.image)
  msg := sprintf("Container image %v lacks a valid Tekton Chains signature", [container.image])
}

has_valid_signature(image) if {
  # This would integrate with your actual signature verification mechanism
  # e.g., via Sigstore policy-controller admission webhook
  image != ""
}

# Enforce minimum SLSA level 2 provenance
deny[msg] if {
  input.kind == "Pod"
  container := input.spec.containers[_]
  provenance := get_provenance(container.image)
  provenance.predicate.buildType != "https://tekton.dev/attestations/chains/pipelinerun@v2"
  msg := sprintf("Image %v does not meet SLSA level 2 requirements", [container.image])
}
```

## Section 6: Advanced Workspace Patterns

### Shared PVC for Build Caching

```yaml
# persistent-cache-workspace.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: go-module-cache
  namespace: ci
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-fast
  resources:
    requests:
      storage: 50Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: buildah-layer-cache
  namespace: ci
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-fast
  resources:
    requests:
      storage: 100Gi
```

### CSI Secret Store Workspace

```yaml
# task-with-vault-workspace.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: deploy-with-secrets
  namespace: ci
spec:
  workspaces:
    - name: vault-secrets
      description: Secrets mounted from Vault via CSI driver
      readOnly: true

  steps:
    - name: deploy
      image: bitnami/kubectl:latest
      script: |
        #!/bin/bash
        # Read database password from Vault-mounted workspace
        DB_PASS=$(cat $(workspaces.vault-secrets.path)/db-password)
        # Use secret in deployment
        kubectl create secret generic app-db-secret \
          --from-literal=password="${DB_PASS}" \
          --dry-run=client -o yaml | kubectl apply -f -
```

## Section 7: Tekton vs GitHub Actions — Decision Framework

| Feature | Tekton | GitHub Actions |
|---|---|---|
| Runs on-cluster | Yes (native K8s) | No (external runners) |
| Private K8s API access | Native | Requires self-hosted runner |
| Air-gapped support | Full | Limited |
| Supply chain signing | Tekton Chains (built-in) | Requires manual cosign setup |
| Reusability | Tasks, StepActions | Composite actions |
| Community catalog | Tekton Hub | GitHub Marketplace |
| Learning curve | High (K8s expertise) | Low |
| Parallelism | Kubernetes scheduler | Matrix jobs |
| Cost model | Cluster resources | Per-minute billing |
| Secrets management | K8s Secrets / CSI | GitHub Secrets / OIDC |
| Audit trail | K8s objects (etcd) | GitHub logs (limited retention) |
| Custom resource limits | Per-step K8s resources | Runner hardware tiers |

### When to Choose Tekton

Choose Tekton when:
- Your build artifacts need to interact with private Kubernetes APIs during the build process
- Compliance requires on-premises CI with full audit trails stored in your own infrastructure
- You need SLSA provenance generation without external dependencies
- Your team already operates Kubernetes and wants to avoid managing a separate CI system
- You require fine-grained resource limits per build step

### When to Choose GitHub Actions

Choose GitHub Actions when:
- Your team is small and Kubernetes expertise is limited
- Build times are more important than security isolation
- You need tight integration with GitHub PRs, issues, and the GitHub ecosystem
- You want marketplace actions without maintaining a Task catalog
- Your builds do not require access to private Kubernetes APIs

## Section 8: Observability and Debugging

### Prometheus Metrics for Tekton

```yaml
# tekton-metrics-podmonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: tekton-pipelines
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - tekton-pipelines
      - tekton-chains
  selector:
    matchLabels:
      app.kubernetes.io/part-of: tekton-pipelines
  podMetricsEndpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

```yaml
# tekton-dashboard-grafana.yaml - Key metrics to monitor
# tekton_taskrun_duration_seconds - histogram of task run durations
# tekton_pipelinerun_duration_seconds - histogram of pipeline run durations
# tekton_taskrun_count - counter of task runs by status
# tekton_pipelinerun_count - counter of pipeline runs by status

# Example Prometheus alerting rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tekton-alerts
  namespace: monitoring
spec:
  groups:
    - name: tekton.pipeline
      interval: 1m
      rules:
        - alert: TektonPipelineRunFailureRate
          expr: |
            rate(tekton_pipelinerun_count{status="failed"}[15m])
            /
            rate(tekton_pipelinerun_count[15m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Tekton PipelineRun failure rate is above 10%"
            description: "Pipeline {{ $labels.pipeline }} has a {{ $value | humanizePercentage }} failure rate"

        - alert: TektonTaskRunDurationHigh
          expr: |
            histogram_quantile(0.95, rate(tekton_taskrun_duration_seconds_bucket[30m])) > 1800
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Tekton TaskRun p95 duration exceeds 30 minutes"
```

### Debugging Failed TaskRuns

```bash
# List recent PipelineRuns with status
kubectl get pipelineruns -n ci --sort-by=.metadata.creationTimestamp

# Describe a failed PipelineRun
kubectl describe pipelinerun build-myapp-run-001 -n ci

# Get logs from a specific TaskRun step
kubectl logs -n ci \
  -l tekton.dev/taskRun=build-myapp-run-001-build-and-test \
  -c step-run-tests

# Use Tekton CLI for a better experience
tkn pipelinerun describe build-myapp-run-001 -n ci
tkn pipelinerun logs build-myapp-run-001 -f -n ci

# List all TaskRuns for a PipelineRun
tkn taskrun list -n ci --label "tekton.dev/pipelineRun=build-myapp-run-001"

# Get the full execution graph
tkn pipelinerun describe build-myapp-run-001 -n ci --output yaml | \
  yq '.status.childReferences[].displayName'
```

## Section 9: Production Best Practices

### Cleanup Policy

```yaml
# cleanup-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-leader-election
  namespace: tekton-pipelines
data:
  # Keep only the last 5 PipelineRuns per Pipeline
  max-pipeline-runs-per-pipeline: "5"
  max-task-runs-per-task: "10"
```

```bash
# CronJob to clean up old PipelineRuns (alternative approach)
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: CronJob
metadata:
  name: tekton-cleanup
  namespace: ci
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: tekton-sa
          containers:
            - name: cleanup
              image: bitnami/kubectl:latest
              command:
                - /bin/sh
                - -c
                - |
                  # Delete PipelineRuns older than 7 days
                  kubectl get pipelineruns -n ci \
                    --sort-by=.metadata.creationTimestamp \
                    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\n"}{end}' | \
                  awk -v cutoff="$(date -d '7 days ago' -Ins --utc | sed 's/+0000/Z/')" '$2 < cutoff {print $1}' | \
                  xargs -r kubectl delete pipelinerun -n ci
          restartPolicy: OnFailure
EOF
```

### High Availability Configuration

```yaml
# tekton-ha-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-leader-election
  namespace: tekton-pipelines
data:
  lease-duration: "60s"
  renew-deadline: "40s"
  retry-period: "10s"
  buckets: "3"
---
# Scale the controller for HA
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tekton-pipelines-controller
  namespace: tekton-pipelines
spec:
  replicas: 2
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: tekton-pipelines-controller
```

## Section 10: Real-World Pipeline Patterns

### Monorepo Multi-Service Pipeline

```yaml
# pipeline-monorepo.yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: monorepo-selective-build
  namespace: ci
spec:
  params:
    - name: repo-url
    - name: git-sha
    - name: changed-paths
      type: array
      description: List of changed file paths from git diff

  tasks:
    - name: detect-changes
      taskRef:
        name: detect-monorepo-changes
      params:
        - name: changed-paths
          value: "$(params.changed-paths[*])"

    - name: build-service-a
      when:
        - input: "$(tasks.detect-changes.results.service-a-changed)"
          operator: in
          values: ["true"]
      taskRef:
        name: build-service
      runAfter:
        - detect-changes
      params:
        - name: service-path
          value: ./services/service-a

    - name: build-service-b
      when:
        - input: "$(tasks.detect-changes.results.service-b-changed)"
          operator: in
          values: ["true"]
      taskRef:
        name: build-service
      runAfter:
        - detect-changes
      params:
        - name: service-path
          value: ./services/service-b
```

### GitOps Integration Pattern

```yaml
# task-update-gitops-repo.yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: update-gitops-manifest
  namespace: ci
spec:
  params:
    - name: image-url
      description: New image URL with digest
    - name: gitops-repo
      description: GitOps repository URL
    - name: service-name
      description: Service name to update
    - name: environment
      description: Target environment (dev, staging, prod)

  workspaces:
    - name: gitops-credentials
      mountPath: /root/.ssh

  steps:
    - name: clone-and-update
      image: alpine/git:latest
      script: |
        #!/bin/sh
        set -eu
        # Configure git
        git config --global user.email "tekton-bot@internal.corp"
        git config --global user.name "Tekton Bot"
        git config --global core.sshCommand "ssh -i /root/.ssh/id_rsa -o StrictHostKeyChecking=no"

        # Clone GitOps repo
        git clone "$(params.gitops-repo)" /workspace/gitops
        cd /workspace/gitops

        # Update image tag using yq
        yq e -i \
          '.spec.template.spec.containers[0].image = "$(params.image-url)"' \
          "environments/$(params.environment)/$(params.service-name)/deployment.yaml"

        # Commit and push
        git add .
        git diff --staged --quiet && echo "No changes" && exit 0
        git commit -m "ci: update $(params.service-name) to $(params.image-url) in $(params.environment)"
        git push origin HEAD
```

## Conclusion

Tekton provides a Kubernetes-native CI/CD foundation that integrates seamlessly with the broader cloud-native ecosystem. Its CRD-based model means your pipeline definitions live alongside your application manifests in Git, enabling the same GitOps workflows you apply to everything else. Tekton Chains adds a critical supply chain security layer with minimal configuration overhead, while Tekton Triggers eliminates the need for any external webhook processing infrastructure.

The key to productive Tekton adoption is investing in a solid Task library up front. Centralizing reusable Tasks in a dedicated repository, versioning them via Tekton Hub or a private catalog, and combining them with parameterized Pipelines gives you a CI/CD platform that scales across hundreds of services without duplicating pipeline logic.

For teams already operating Kubernetes in production, the operational overhead of running Tekton is marginal. For teams new to Kubernetes, starting with GitHub Actions and migrating to Tekton as Kubernetes maturity grows is a pragmatic approach.
