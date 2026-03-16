---
title: "Tekton Pipeline Optimization Techniques: Advanced Strategies for Enterprise CI/CD"
date: 2026-11-29T00:00:00-05:00
draft: false
tags: ["Tekton", "CI/CD", "Kubernetes", "Pipeline Optimization", "DevOps", "Cloud Native", "Performance"]
categories: ["CI/CD", "DevOps", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Tekton pipeline optimization techniques for enterprise CI/CD workloads. Learn parallel execution, caching strategies, resource management, and performance tuning for production Kubernetes environments."
more_link: "yes"
url: "/tekton-pipeline-optimization-techniques-enterprise-cicd/"
---

Tekton has emerged as the Kubernetes-native CI/CD solution of choice for cloud-native organizations. However, as pipeline complexity grows and build volumes increase, optimization becomes critical for maintaining fast feedback loops and efficient resource utilization. This comprehensive guide explores advanced Tekton pipeline optimization techniques for enterprise environments.

<!--more-->

# Tekton Pipeline Optimization Techniques: Advanced Strategies for Enterprise CI/CD

## Executive Summary

Tekton Pipelines provides a powerful framework for building cloud-native CI/CD systems, but default configurations often leave significant performance on the table. This guide covers advanced optimization techniques including parallel task execution, intelligent caching strategies, resource tuning, workspace management, and monitoring approaches that can reduce pipeline execution times by 50-80% while improving resource efficiency.

## Understanding Tekton Performance Fundamentals

### Architecture Overview

Tekton's architecture impacts optimization strategies:

```yaml
# High-performance Tekton controller configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-defaults
  namespace: tekton-pipelines
data:
  # Increase default resource limits
  default-timeout-minutes: "60"
  default-service-account: "tekton-bot"
  default-managed-by-label-value: "tekton-pipelines"

  # Performance tuning
  default-pod-template: |
    nodeSelector:
      workload: tekton-builds
    tolerations:
    - key: "tekton"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
    # Use faster storage classes
    volumes:
    - name: tekton-internal-workspace
      emptyDir:
        medium: Memory
        sizeLimit: 2Gi
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: feature-flags
  namespace: tekton-pipelines
data:
  # Enable performance features
  disable-affinity-assistant: "false"
  disable-creds-init: "false"
  running-in-environment-with-injected-sidecars: "true"
  require-git-ssh-secret-known-hosts: "false"
  enable-tekton-oci-bundles: "true"
  enable-api-fields: "alpha"
  # Enable custom task versions
  enable-custom-tasks: "true"
  # Optimize step execution
  disable-home-env-overwrite: "true"
  disable-working-directory-overwrite: "true"
```

### Controller Performance Tuning

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tekton-pipelines-controller
  namespace: tekton-pipelines
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: controller
  template:
    metadata:
      labels:
        app.kubernetes.io/name: controller
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app.kubernetes.io/name: controller
              topologyKey: kubernetes.io/hostname
      containers:
      - name: tekton-pipelines-controller
        image: gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/controller:v0.53.0
        args:
        - -kubeconfig-writer-image
        - gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/kubeconfigwriter:v0.53.0
        - -git-image
        - gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/git-init:v0.53.0
        - -entrypoint-image
        - gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/entrypoint:v0.53.0
        - -nop-image
        - gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/nop:v0.53.0
        - -imagedigest-exporter-image
        - gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/imagedigestexporter:v0.53.0
        - -pr-image
        - gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/pullrequest-init:v0.53.0
        - -workingdirinit-image
        - gcr.io/tekton-releases/github.com/tektoncd/pipeline/cmd/workingdirinit:v0.53.0
        # Performance tuning
        - -threads-per-controller
        - "32"
        - -kube-api-qps
        - "50"
        - -kube-api-burst
        - "100"
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        env:
        - name: SYSTEM_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: CONFIG_LOGGING_NAME
          value: config-logging
        - name: CONFIG_OBSERVABILITY_NAME
          value: config-observability
        - name: METRICS_DOMAIN
          value: tekton.dev/pipeline
```

## Parallel Task Execution Strategies

### Task Dependency Optimization

Minimize sequential dependencies to maximize parallelism:

```yaml
apiVersion: tekton.dev/v1beta1
kind: Pipeline
metadata:
  name: optimized-build-pipeline
spec:
  params:
  - name: git-url
    type: string
  - name: git-revision
    type: string
    default: main
  workspaces:
  - name: shared-data
  - name: docker-credentials

  tasks:
  # Parallel initialization tasks
  - name: fetch-source
    taskRef:
      name: git-clone
    params:
    - name: url
      value: $(params.git-url)
    - name: revision
      value: $(params.git-revision)
    workspaces:
    - name: output
      workspace: shared-data

  - name: fetch-dependencies
    taskRef:
      name: fetch-cache
    params:
    - name: cache-key
      value: "deps-$(params.git-revision)"
    workspaces:
    - name: cache
      workspace: shared-data

  # Parallel analysis tasks (no dependency on each other)
  - name: security-scan
    runAfter: ["fetch-source"]
    taskRef:
      name: trivy-scan
    workspaces:
    - name: source
      workspace: shared-data

  - name: lint-code
    runAfter: ["fetch-source"]
    taskRef:
      name: golangci-lint
    workspaces:
    - name: source
      workspace: shared-data

  - name: unit-tests
    runAfter: ["fetch-source", "fetch-dependencies"]
    taskRef:
      name: go-test
    workspaces:
    - name: source
      workspace: shared-data

  - name: build-docs
    runAfter: ["fetch-source"]
    taskRef:
      name: build-documentation
    workspaces:
    - name: source
      workspace: shared-data

  # Build happens after analysis completes
  - name: build-binary
    runAfter: ["security-scan", "lint-code", "unit-tests"]
    taskRef:
      name: go-build
    workspaces:
    - name: source
      workspace: shared-data

  # Parallel container builds for multiple architectures
  - name: build-amd64
    runAfter: ["build-binary"]
    taskRef:
      name: kaniko-build
    params:
    - name: IMAGE
      value: "registry.example.com/app:$(params.git-revision)-amd64"
    - name: EXTRA_ARGS
      value: ["--platform=linux/amd64"]
    workspaces:
    - name: source
      workspace: shared-data
    - name: dockerconfig
      workspace: docker-credentials

  - name: build-arm64
    runAfter: ["build-binary"]
    taskRef:
      name: kaniko-build
    params:
    - name: IMAGE
      value: "registry.example.com/app:$(params.git-revision)-arm64"
    - name: EXTRA_ARGS
      value: ["--platform=linux/arm64"]
    workspaces:
    - name: source
      workspace: shared-data
    - name: dockerconfig
      workspace: docker-credentials

  # Create multi-arch manifest
  - name: create-manifest
    runAfter: ["build-amd64", "build-arm64"]
    taskRef:
      name: buildah-manifest
    params:
    - name: IMAGES
      value:
      - "registry.example.com/app:$(params.git-revision)-amd64"
      - "registry.example.com/app:$(params.git-revision)-arm64"
    - name: MANIFEST
      value: "registry.example.com/app:$(params.git-revision)"
```

### Matrix Strategy for Parallel Execution

Use matrix strategy for testing across multiple configurations:

```yaml
apiVersion: tekton.dev/v1beta1
kind: Pipeline
metadata:
  name: matrix-test-pipeline
spec:
  params:
  - name: git-url
    type: string
  workspaces:
  - name: shared-data

  tasks:
  - name: fetch-source
    taskRef:
      name: git-clone
    params:
    - name: url
      value: $(params.git-url)
    workspaces:
    - name: output
      workspace: shared-data

  # Matrix strategy for parallel test execution
  - name: test-matrix
    runAfter: ["fetch-source"]
    taskRef:
      name: go-test-matrix
    params:
    - name: versions
      value:
      - "1.21"
      - "1.22"
      - "1.23"
    - name: platforms
      value:
      - "linux/amd64"
      - "linux/arm64"
    workspaces:
    - name: source
      workspace: shared-data
---
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: go-test-matrix
spec:
  params:
  - name: versions
    type: array
  - name: platforms
    type: array
  workspaces:
  - name: source
  steps:
  - name: generate-matrix
    image: alpine:3.18
    script: |
      #!/bin/sh
      set -e
      # Generate all combinations
      echo '$(params.versions)' | tr ' ' '\n' > /tmp/versions
      echo '$(params.platforms)' | tr ' ' '\n' > /tmp/platforms

      # Create test combinations
      while read version; do
        while read platform; do
          echo "$version|$platform" >> /tmp/matrix
        done < /tmp/platforms
      done < /tmp/versions

      # Execute tests in parallel using background jobs
      while read combo; do
        version=$(echo $combo | cut -d'|' -f1)
        platform=$(echo $combo | cut -d'|' -f2)

        (
          echo "Testing Go $version on $platform"
          docker run --rm \
            -v $(workspaces.source.path):/workspace \
            -w /workspace \
            --platform=$platform \
            golang:$version \
            go test -v ./... > /tmp/test-$version-$(echo $platform | tr '/' '-').log 2>&1
          echo "Completed: Go $version on $platform"
        ) &
      done < /tmp/matrix

      # Wait for all background jobs
      wait

      # Check results
      failed=0
      for log in /tmp/test-*.log; do
        if grep -q "FAIL" $log; then
          echo "Failed: $log"
          cat $log
          failed=1
        fi
      done

      exit $failed
```

## Intelligent Caching Strategies

### Persistent Volume Caching

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: tekton-cache-pvc
spec:
  accessModes:
  - ReadWriteMany
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 100Gi
---
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: cached-build
spec:
  params:
  - name: cache-key
    type: string
  - name: cache-paths
    type: array
    default:
    - "~/.cache/go-build"
    - "~/go/pkg/mod"
  workspaces:
  - name: source
  - name: cache
  steps:
  - name: restore-cache
    image: alpine:3.18
    script: |
      #!/bin/sh
      set -e

      CACHE_KEY="$(params.cache-key)"
      CACHE_DIR="$(workspaces.cache.path)/$CACHE_KEY"

      if [ -d "$CACHE_DIR" ]; then
        echo "Restoring cache from $CACHE_DIR"

        # Restore each cached path
        for path in $(params.cache-paths); do
          expanded_path=$(eval echo $path)
          if [ -d "$CACHE_DIR/$(basename $expanded_path)" ]; then
            mkdir -p $(dirname $expanded_path)
            cp -r "$CACHE_DIR/$(basename $expanded_path)" $expanded_path
            echo "Restored: $expanded_path"
          fi
        done

        # Show cache statistics
        du -sh $CACHE_DIR
        echo "Cache hit: $CACHE_KEY"
      else
        echo "Cache miss: $CACHE_KEY"
      fi

  - name: build
    image: golang:1.22
    workingDir: $(workspaces.source.path)
    env:
    - name: GOCACHE
      value: "/root/.cache/go-build"
    - name: GOMODCACHE
      value: "/root/go/pkg/mod"
    script: |
      #!/bin/bash
      set -e

      echo "Building application..."
      go build -v -o bin/app ./cmd/app

      echo "Build completed successfully"

  - name: save-cache
    image: alpine:3.18
    script: |
      #!/bin/sh
      set -e

      CACHE_KEY="$(params.cache-key)"
      CACHE_DIR="$(workspaces.cache.path)/$CACHE_KEY"

      mkdir -p "$CACHE_DIR"

      # Save each cache path
      for path in $(params.cache-paths); do
        expanded_path=$(eval echo $path)
        if [ -d "$expanded_path" ]; then
          cp -r $expanded_path "$CACHE_DIR/$(basename $expanded_path)"
          echo "Cached: $expanded_path"
        fi
      done

      # Prune old caches (keep last 10)
      cd $(workspaces.cache.path)
      ls -t | tail -n +11 | xargs -r rm -rf

      du -sh $CACHE_DIR
      echo "Cache saved: $CACHE_KEY"
```

### Remote Cache with Registry

```yaml
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: docker-build-cached
spec:
  params:
  - name: IMAGE
    type: string
  - name: CACHE_IMAGE
    type: string
  - name: DOCKERFILE
    default: "./Dockerfile"
  workspaces:
  - name: source
  - name: dockerconfig
    mountPath: /kaniko/.docker
  steps:
  - name: build-with-cache
    image: gcr.io/kaniko-project/executor:v1.19.0
    env:
    - name: DOCKER_CONFIG
      value: /kaniko/.docker
    command:
    - /kaniko/executor
    args:
    - --dockerfile=$(params.DOCKERFILE)
    - --context=$(workspaces.source.path)
    - --destination=$(params.IMAGE)
    # Cache configuration
    - --cache=true
    - --cache-ttl=168h
    - --cache-repo=$(params.CACHE_IMAGE)
    # Use multi-stage caching
    - --cache-copy-layers
    # Compression for faster transfers
    - --compressed-caching
    # Snapshot mode for better performance
    - --snapshotMode=redo
    - --use-new-run
    # Build args for cache busting
    - --build-arg=BUILDKIT_INLINE_CACHE=1
    # Performance optimizations
    - --skip-unused-stages
    - --single-snapshot
---
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: buildkit-build-cached
spec:
  params:
  - name: IMAGE
    type: string
  - name: CACHE_REPO
    type: string
  workspaces:
  - name: source
  - name: dockerconfig
  sidecars:
  - name: buildkitd
    image: moby/buildkit:v0.12.0
    securityContext:
      privileged: true
    readinessProbe:
      exec:
        command: ["buildctl", "debug", "workers"]
      initialDelaySeconds: 5
      periodSeconds: 5
  steps:
  - name: build-and-push
    image: moby/buildkit:v0.12.0
    workingDir: $(workspaces.source.path)
    env:
    - name: BUILDKIT_HOST
      value: tcp://localhost:1234
    - name: DOCKER_CONFIG
      value: $(workspaces.dockerconfig.path)
    script: |
      #!/bin/sh
      set -e

      # Wait for buildkitd
      while ! buildctl debug workers; do
        echo "Waiting for buildkitd..."
        sleep 1
      done

      # Build with inline cache
      buildctl build \
        --frontend dockerfile.v0 \
        --local context=. \
        --local dockerfile=. \
        --output type=image,name=$(params.IMAGE),push=true \
        --export-cache type=registry,ref=$(params.CACHE_REPO):cache,mode=max \
        --import-cache type=registry,ref=$(params.CACHE_REPO):cache \
        --opt build-arg:BUILDKIT_INLINE_CACHE=1
```

## Resource Optimization

### Right-Sizing Task Resources

```yaml
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: optimized-build-task
spec:
  params:
  - name: build-type
    type: string
    default: "small"
  workspaces:
  - name: source
  steps:
  - name: determine-resources
    image: alpine:3.18
    script: |
      #!/bin/sh
      case "$(params.build-type)" in
        small)
          echo "500m" > /tmp/cpu-request
          echo "1000m" > /tmp/cpu-limit
          echo "512Mi" > /tmp/memory-request
          echo "1Gi" > /tmp/memory-limit
          ;;
        medium)
          echo "1000m" > /tmp/cpu-request
          echo "2000m" > /tmp/cpu-limit
          echo "2Gi" > /tmp/memory-request
          echo "4Gi" > /tmp/memory-limit
          ;;
        large)
          echo "2000m" > /tmp/cpu-request
          echo "4000m" > /tmp/cpu-limit
          echo "4Gi" > /tmp/memory-request
          echo "8Gi" > /tmp/memory-limit
          ;;
      esac

  - name: build
    image: golang:1.22
    computeResources:
      requests:
        cpu: $(cat /tmp/cpu-request)
        memory: $(cat /tmp/memory-request)
      limits:
        cpu: $(cat /tmp/cpu-limit)
        memory: $(cat /tmp/memory-limit)
    script: |
      #!/bin/bash
      set -e

      cd $(workspaces.source.path)

      # Limit parallelism based on available CPUs
      GOMAXPROCS=$(nproc)
      export GOMAXPROCS

      echo "Building with GOMAXPROCS=$GOMAXPROCS"
      go build -v -o bin/app ./cmd/app
---
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: vertical-pod-autoscaler-optimized
spec:
  workspaces:
  - name: source
  stepTemplate:
    # Default resources that VPA will adjust
    computeResources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 2000m
        memory: 4Gi
  steps:
  - name: compile
    image: golang:1.22
    script: |
      #!/bin/bash
      cd $(workspaces.source.path)
      go build -v ./...
```

### Node Affinity and Tolerations

```yaml
apiVersion: tekton.dev/v1beta1
kind: Pipeline
metadata:
  name: build-with-affinity
spec:
  params:
  - name: git-url
    type: string
  workspaces:
  - name: shared-data

  tasks:
  # Light tasks on standard nodes
  - name: fetch-source
    taskRef:
      name: git-clone
    params:
    - name: url
      value: $(params.git-url)
    workspaces:
    - name: output
      workspace: shared-data
    podTemplate:
      nodeSelector:
        workload: standard

  # CPU-intensive tasks on compute-optimized nodes
  - name: build
    runAfter: ["fetch-source"]
    taskRef:
      name: go-build
    workspaces:
    - name: source
      workspace: shared-data
    podTemplate:
      nodeSelector:
        workload: compute-optimized
        node.kubernetes.io/instance-type: c5.4xlarge
      tolerations:
      - key: "compute-intensive"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"

  # I/O intensive tasks on storage-optimized nodes
  - name: integration-tests
    runAfter: ["build"]
    taskRef:
      name: integration-test
    workspaces:
    - name: source
      workspace: shared-data
    podTemplate:
      nodeSelector:
        workload: storage-optimized
        node.kubernetes.io/instance-type: i3.2xlarge
      tolerations:
      - key: "storage-intensive"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"
      # Use local SSD for better I/O
      volumes:
      - name: local-ssd
        hostPath:
          path: /mnt/disks/ssd0
```

## Workspace Optimization

### EmptyDir with Memory Medium

```yaml
apiVersion: tekton.dev/v1beta1
kind: PipelineRun
metadata:
  name: fast-build-run
spec:
  pipelineRef:
    name: build-pipeline
  workspaces:
  # Use memory for small, frequently accessed data
  - name: shared-data
    volumeClaimTemplate:
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 2Gi
        storageClassName: fast-ssd

  # Use memory-backed emptyDir for temporary data
  - name: temp-workspace
    emptyDir:
      medium: Memory
      sizeLimit: 1Gi

  # Use persistent volume for cache
  - name: cache
    persistentVolumeClaim:
      claimName: tekton-cache-pvc
```

### Efficient Workspace Sharing

```yaml
apiVersion: tekton.dev/v1beta1
kind: Pipeline
metadata:
  name: efficient-workspace-pipeline
spec:
  workspaces:
  - name: source-code
  - name: build-artifacts
  - name: test-results

  tasks:
  - name: clone
    taskRef:
      name: git-clone
    workspaces:
    - name: output
      workspace: source-code

  - name: build
    runAfter: ["clone"]
    taskRef:
      name: build-app
    workspaces:
    # Read-only workspace for source
    - name: source
      workspace: source-code
      readOnly: true
    # Write workspace for artifacts
    - name: artifacts
      workspace: build-artifacts

  - name: test
    runAfter: ["build"]
    taskRef:
      name: run-tests
    workspaces:
    # Both workspaces read-only
    - name: source
      workspace: source-code
      readOnly: true
    - name: artifacts
      workspace: build-artifacts
      readOnly: true
    # Only test results writable
    - name: results
      workspace: test-results
---
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: build-app
spec:
  workspaces:
  - name: source
    readOnly: true
  - name: artifacts
  steps:
  - name: build
    image: golang:1.22
    script: |
      #!/bin/bash
      set -e

      # Source is read-only, artifacts is writable
      cd $(workspaces.source.path)
      go build -o $(workspaces.artifacts.path)/app ./cmd/app

      # Generate build metadata
      cat > $(workspaces.artifacts.path)/metadata.json <<EOF
      {
        "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
        "commit": "$(git rev-parse HEAD)",
        "builder": "$(hostname)"
      }
      EOF
```

## Step Optimization

### Combining Steps Efficiently

```yaml
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: optimized-steps
spec:
  workspaces:
  - name: source
  steps:
  # Bad: Multiple small steps with overhead
  # - name: install-deps
  # - name: run-linter
  # - name: run-tests
  # - name: build

  # Good: Combined related operations
  - name: build-and-test
    image: golang:1.22
    workingDir: $(workspaces.source.path)
    script: |
      #!/bin/bash
      set -e

      # Install dependencies once
      echo "Installing dependencies..."
      go mod download

      # Run operations in sequence without pod restart overhead
      echo "Running linter..."
      golangci-lint run ./...

      echo "Running tests..."
      go test -v -race -coverprofile=coverage.out ./...

      echo "Building application..."
      go build -v -o bin/app ./cmd/app

      echo "All steps completed successfully"
---
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: parallel-steps
spec:
  workspaces:
  - name: source
  steps:
  - name: parallel-analysis
    image: alpine:3.18
    workingDir: $(workspaces.source.path)
    script: |
      #!/bin/sh
      set -e

      # Run independent operations in parallel
      (
        echo "Running security scan..."
        trivy fs --severity HIGH,CRITICAL . > /tmp/security-scan.txt 2>&1
      ) &

      (
        echo "Running linter..."
        golangci-lint run ./... > /tmp/lint.txt 2>&1
      ) &

      (
        echo "Checking dependencies..."
        go mod verify > /tmp/deps.txt 2>&1
      ) &

      # Wait for all background jobs
      wait

      # Check results
      failed=0
      for result in /tmp/*.txt; do
        if grep -q "ERROR\|FAIL" $result; then
          echo "Failed: $result"
          cat $result
          failed=1
        fi
      done

      exit $failed
```

### Script Optimization

```yaml
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: efficient-scripting
spec:
  params:
  - name: files
    type: array
  workspaces:
  - name: source
  steps:
  - name: process-files
    image: alpine:3.18
    script: |
      #!/bin/sh
      set -e

      # Use efficient shell constructs
      cd $(workspaces.source.path)

      # Bad: Loop calling external commands repeatedly
      # for file in $(params.files); do
      #   cat $file | grep "pattern" | wc -l
      # done

      # Good: Batch processing
      grep -c "pattern" $(params.files) | awk '{sum+=$1} END {print sum}'

      # Use built-in commands instead of external ones
      # Bad: if [ $(echo $var | grep "pattern") ]; then
      # Good: if [ "${var##*pattern*}" != "$var" ]; then

      # Avoid unnecessary subshells
      # Bad: result=$(cat file.txt)
      # Good: result=$(<file.txt)

      # Use efficient file operations
      # Bad: for file in *.txt; do cp $file backup/; done
      # Good: cp *.txt backup/
```

## Pipeline-Level Optimization

### Custom Task Controllers

```yaml
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: custom-task-dispatcher
spec:
  params:
  - name: task-type
    type: string
  - name: task-config
    type: string
  results:
  - name: task-id
    description: ID of dispatched task
  steps:
  - name: dispatch
    image: curlimages/curl:8.5.0
    script: |
      #!/bin/sh
      set -e

      # Dispatch to custom task controller
      TASK_ID=$(curl -X POST \
        http://custom-task-controller.tekton-pipelines.svc.cluster.local:8080/tasks \
        -H "Content-Type: application/json" \
        -d '{
          "type": "$(params.task-type)",
          "config": $(params.task-config)
        }' | jq -r '.id')

      echo -n "$TASK_ID" > $(results.task-id.path)
      echo "Dispatched task: $TASK_ID"

  - name: wait-for-completion
    image: curlimages/curl:8.5.0
    script: |
      #!/bin/sh
      set -e

      TASK_ID=$(cat $(results.task-id.path))

      # Poll for completion
      while true; do
        STATUS=$(curl -s \
          http://custom-task-controller.tekton-pipelines.svc.cluster.local:8080/tasks/$TASK_ID \
          | jq -r '.status')

        case "$STATUS" in
          completed)
            echo "Task completed successfully"
            exit 0
            ;;
          failed)
            echo "Task failed"
            exit 1
            ;;
          *)
            echo "Task status: $STATUS"
            sleep 5
            ;;
        esac
      done
```

### Dynamic Pipeline Generation

```yaml
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: generate-pipeline
spec:
  params:
  - name: config-file
    type: string
  workspaces:
  - name: source
  results:
  - name: pipeline-name
  steps:
  - name: generate
    image: alpine:3.18
    script: |
      #!/bin/sh
      set -e

      cd $(workspaces.source.path)
      CONFIG=$(cat $(params.config-file))

      # Generate optimized pipeline based on config
      cat > /tmp/pipeline.yaml <<EOF
      apiVersion: tekton.dev/v1beta1
      kind: Pipeline
      metadata:
        name: generated-pipeline-$(date +%s)
      spec:
        tasks:
      EOF

      # Parse config and generate tasks
      echo "$CONFIG" | jq -r '.tasks[] | @base64' | while read task; do
        decoded=$(echo $task | base64 -d)
        name=$(echo $decoded | jq -r '.name')
        depends=$(echo $decoded | jq -r '.depends[]' | tr '\n' ',' | sed 's/,$//')

        cat >> /tmp/pipeline.yaml <<EOF
        - name: $name
      EOF

        if [ -n "$depends" ]; then
          echo "  runAfter: [\"$depends\"]" >> /tmp/pipeline.yaml
        fi

        echo "  taskRef:" >> /tmp/pipeline.yaml
        echo "    name: $(echo $decoded | jq -r '.taskRef')" >> /tmp/pipeline.yaml
      done

      # Apply generated pipeline
      kubectl apply -f /tmp/pipeline.yaml

      # Output pipeline name
      grep "name:" /tmp/pipeline.yaml | head -1 | awk '{print $2}' > $(results.pipeline-name.path)
```

## Monitoring and Performance Analysis

### Prometheus Metrics

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tekton-metrics-config
  namespace: tekton-pipelines
data:
  config.yaml: |
    metrics:
      # Enable detailed metrics
      taskrun-duration-type: "histogram"
      pipelinerun-duration-type: "histogram"

      # Custom metrics
      count-with-reason: "true"
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tekton-pipelines-controller
  namespace: tekton-pipelines
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: controller
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tekton-performance-alerts
  namespace: tekton-pipelines
spec:
  groups:
  - name: tekton-performance
    interval: 30s
    rules:
    # Alert on slow pipelines
    - alert: TektonPipelineSlowExecution
      expr: |
        histogram_quantile(0.95,
          sum(rate(tekton_pipelinerun_duration_seconds_bucket[5m])) by (le, pipeline)
        ) > 1800
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Pipeline {{ $labels.pipeline }} is running slow"
        description: "95th percentile duration is {{ $value }} seconds"

    # Alert on task failures
    - alert: TektonHighTaskFailureRate
      expr: |
        sum(rate(tekton_taskrun_count{status="failed"}[5m])) by (task)
        /
        sum(rate(tekton_taskrun_count[5m])) by (task)
        > 0.1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "High failure rate for task {{ $labels.task }}"
        description: "Failure rate is {{ $value | humanizePercentage }}"

    # Alert on resource saturation
    - alert: TektonControllerHighCPU
      expr: |
        rate(container_cpu_usage_seconds_total{
          namespace="tekton-pipelines",
          pod=~"tekton-pipelines-controller.*"
        }[5m]) > 0.8
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Tekton controller high CPU usage"
        description: "Controller CPU usage is {{ $value | humanizePercentage }}"
```

### Performance Analysis Dashboard

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tekton-dashboard
  namespace: tekton-pipelines
data:
  dashboard.json: |
    {
      "dashboard": {
        "title": "Tekton Pipeline Performance",
        "panels": [
          {
            "title": "Pipeline Duration (95th Percentile)",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, sum(rate(tekton_pipelinerun_duration_seconds_bucket[5m])) by (le, pipeline))"
              }
            ]
          },
          {
            "title": "Task Success Rate",
            "targets": [
              {
                "expr": "sum(rate(tekton_taskrun_count{status=\"succeeded\"}[5m])) by (task) / sum(rate(tekton_taskrun_count[5m])) by (task)"
              }
            ]
          },
          {
            "title": "Concurrent Pipeline Runs",
            "targets": [
              {
                "expr": "sum(tekton_running_pipelineruns_count)"
              }
            ]
          },
          {
            "title": "Pod Scheduling Latency",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, sum(rate(tekton_taskrun_pod_latency_milliseconds_bucket[5m])) by (le))"
              }
            ]
          },
          {
            "title": "Workspace Volume Provisioning Time",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, sum(rate(tekton_pvc_bound_latency_milliseconds_bucket[5m])) by (le))"
              }
            ]
          }
        ]
      }
    }
```

### Profiling and Tracing

```yaml
apiVersion: tekton.dev/v1beta1
kind: Task
metadata:
  name: profile-build
spec:
  params:
  - name: trace-enabled
    type: string
    default: "false"
  workspaces:
  - name: source
  steps:
  - name: build-with-profiling
    image: golang:1.22
    env:
    - name: GODEBUG
      value: "gctrace=1"
    script: |
      #!/bin/bash
      set -e

      cd $(workspaces.source.path)

      # Enable profiling if requested
      if [ "$(params.trace-enabled)" = "true" ]; then
        go build -gcflags="-m -m" -v ./... 2>&1 | tee /tmp/build-trace.log

        # Analyze escape analysis
        grep "escapes to heap" /tmp/build-trace.log > /tmp/escapes.log || true

        # Build with CPU profile
        go test -cpuprofile=/tmp/cpu.prof -bench=. ./...
        go tool pprof -text /tmp/cpu.prof > /tmp/cpu-profile.txt

        # Memory profile
        go test -memprofile=/tmp/mem.prof -bench=. ./...
        go tool pprof -text /tmp/mem.prof > /tmp/mem-profile.txt

        echo "Profiling data saved to /tmp/"
      else
        go build -v ./...
      fi

  - name: upload-profiles
    image: curlimages/curl:8.5.0
    script: |
      #!/bin/sh
      if [ "$(params.trace-enabled)" = "true" ]; then
        # Upload to profiling server
        for profile in /tmp/*.prof /tmp/*-profile.txt; do
          if [ -f "$profile" ]; then
            curl -X POST \
              -F "file=@$profile" \
              http://profiling-server.monitoring.svc.cluster.local/upload
          fi
        done
      fi
```

## Best Practices and Recommendations

### Pipeline Design Patterns

1. **Minimize Sequential Dependencies**: Design pipelines with maximum parallelism
2. **Use Appropriate Workspaces**: Choose the right workspace type for data access patterns
3. **Implement Caching**: Cache dependencies, build artifacts, and test data
4. **Right-Size Resources**: Profile tasks and allocate appropriate CPU/memory
5. **Node Affinity**: Place tasks on optimal node types for their workload

### Resource Management

1. **Use Resource Quotas**: Prevent runaway pipeline resource consumption
2. **Implement LimitRanges**: Set default and maximum resources per task
3. **Monitor Resource Utilization**: Track actual vs. requested resources
4. **Implement Pod Disruption Budgets**: Ensure pipeline stability during node maintenance
5. **Use Spot/Preemptible Instances**: For non-critical builds to reduce costs

### Operational Excellence

1. **Implement Comprehensive Monitoring**: Track pipeline performance metrics
2. **Set Up Alerting**: Alert on performance degradation and failures
3. **Regular Performance Reviews**: Analyze and optimize slow pipelines
4. **Capacity Planning**: Monitor cluster capacity and scale appropriately
5. **Documentation**: Document optimization decisions and benchmark results

## Conclusion

Optimizing Tekton pipelines requires a holistic approach covering task design, resource management, caching strategies, and operational monitoring. By implementing the techniques in this guide, you can achieve significant improvements in pipeline execution time, resource efficiency, and overall developer experience.

Key takeaways:
- Maximize parallelism through careful dependency management
- Implement multi-level caching strategies for dependencies and build artifacts
- Right-size resources based on actual task requirements
- Use appropriate node types for different workload characteristics
- Monitor performance continuously and iterate on optimizations

With these optimizations in place, you can build highly efficient CI/CD pipelines that scale with your organization's needs while maintaining fast feedback loops and optimal resource utilization.