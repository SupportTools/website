---
title: "Kubernetes Argo Workflows v3.x: DAG Templates, Retry Strategies, Artifact Management, and Executor Comparison"
date: 2032-01-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Argo Workflows", "DAG", "CI/CD", "Artifacts", "Workflow Automation"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Argo Workflows v3.x covering DAG template design, retry strategies, artifact management with S3 and GCS, and a detailed comparison of workflow executors including emissary, PNS, and Docker."
more_link: "yes"
url: "/kubernetes-argo-workflows-v3-dag-templates-retry-artifact-management/"
---

Argo Workflows remains the most capable workflow engine for Kubernetes, but production deployments at scale surface a dense set of configuration decisions that can make or break reliability. This guide covers the internals of DAG template construction, retry policy tuning, artifact repository configuration, and the executor model changes introduced in v3.x.

<!--more-->

# Kubernetes Argo Workflows v3.x: Production Deep Dive

## Section 1: Architecture and the v3.x Changes

Argo Workflows v3.0 brought a significant executor overhaul. The legacy Docker executor was deprecated in favor of emissary and PNS (Process Namespace Sharing). Understanding why requires a look at how Argo executes work inside pods.

### The Executor Model

Each Argo workflow step runs as a Kubernetes pod with two containers:

1. **main** - the user's container that does actual work
2. **wait** (formerly **argoexec**) - the sidecar that coordinates artifact upload, output capture, and lifecycle signals

The sidecar communicates with the main container through shared process namespace or volume mounts depending on which executor is selected.

```
┌─────────────────────────────────────────────────┐
│  Workflow Pod                                   │
│                                                 │
│  ┌──────────────┐   ┌────────────────────────┐  │
│  │  main        │   │  wait (argoexec)       │  │
│  │  container   │◄──┤  - artifact upload     │  │
│  │              │   │  - output capture      │  │
│  │  user code   │   │  - signal forwarding   │  │
│  └──────────────┘   └────────────────────────┘  │
│                                                 │
│  Shared: /tmp/argo, emptyDir volumes            │
└─────────────────────────────────────────────────┘
```

### Executor Comparison

| Feature | emissary | PNS | Docker (deprecated) |
|---------|----------|-----|---------------------|
| Rootless support | Yes | Partial | No |
| Sidecar injection | Required | Required | Required |
| Process capture | Via /proc | Via /proc | Docker API |
| Docker socket needed | No | No | Yes |
| Works with containerd | Yes | Yes | No |
| Output capture method | Named pipes | ptrace | Docker attach |
| Kubernetes 1.24+ | Yes | Yes | No |

The emissary executor is the recommended choice for all new deployments. It uses named pipes at `/tmp/argo/outputs/` for capturing stdout/stderr without requiring privileged access.

### Installing Argo Workflows v3.x

```bash
kubectl create namespace argo

kubectl apply -n argo -f \
  https://github.com/argoproj/argo-workflows/releases/download/v3.5.10/install.yaml

# Patch the workflow controller configmap to use emissary
kubectl patch configmap workflow-controller-configmap \
  -n argo \
  --type merge \
  -p '{"data":{"containerRuntimeExecutor":"emissary"}}'
```

For production, use the Helm chart with explicit values:

```yaml
# values-production.yaml
controller:
  replicas: 2
  workflowWorkers: 32
  podWorkers: 32
  resourceRateLimit:
    limit: 20
    burst: 1
  parallelism: 50
  namespaceParallelism: 10
  metricsConfig:
    enabled: true
    path: /metrics
    port: 9090
  telemetryConfig:
    enabled: true
  persistence:
    connectionPool:
      maxIdleConns: 100
      maxOpenConns: 0
    nodeStatusOffLoad: true
    archive: true
    archiveTTL: 30d
    postgresql:
      host: postgres.argo.svc.cluster.local
      port: 5432
      database: argo
      tableName: argo_workflows
      userNameSecret:
        name: argo-postgres-config
        key: username
      passwordSecret:
        name: argo-postgres-config
        key: password

server:
  replicas: 2
  authModes:
    - server
    - client

executor:
  resources:
    requests:
      cpu: 100m
      memory: 64Mi
    limits:
      cpu: 500m
      memory: 512Mi
  env:
    - name: ARGO_CONTAINER_RUNTIME_EXECUTOR
      value: emissary
```

```bash
helm install argo-workflows argo/argo-workflows \
  -n argo \
  -f values-production.yaml \
  --version 0.42.0
```

## Section 2: DAG Templates

DAG (Directed Acyclic Graph) templates are Argo's most powerful construct for expressing complex dependency chains. They allow parallel execution of independent tasks while enforcing ordering constraints.

### Basic DAG Structure

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: dag-pipeline-
  namespace: argo
spec:
  entrypoint: main-dag
  templates:
    - name: main-dag
      dag:
        tasks:
          - name: fetch-data
            template: fetch-data-template
          - name: validate
            template: validate-template
            dependencies: [fetch-data]
          - name: transform-a
            template: transform-template
            dependencies: [validate]
            arguments:
              parameters:
                - name: mode
                  value: "mode-a"
          - name: transform-b
            template: transform-template
            dependencies: [validate]
            arguments:
              parameters:
                - name: mode
                  value: "mode-b"
          - name: merge
            template: merge-template
            dependencies: [transform-a, transform-b]
          - name: publish
            template: publish-template
            dependencies: [merge]

    - name: fetch-data-template
      container:
        image: python:3.11-slim
        command: [python, -c]
        args: ["import json; print(json.dumps({'rows': 1000}))"]

    - name: validate-template
      inputs:
        artifacts:
          - name: data
            from: "{{tasks.fetch-data.outputs.artifacts.result}}"
      container:
        image: python:3.11-slim
        command: [sh, -c]
        args: ["echo validated"]
```

### DAG with Conditional Tasks

Conditional execution uses `when` expressions based on task outputs:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: conditional-dag-
spec:
  entrypoint: conditional-pipeline
  templates:
    - name: conditional-pipeline
      dag:
        tasks:
          - name: check-environment
            template: check-env
          - name: deploy-production
            template: deploy
            dependencies: [check-environment]
            when: "{{tasks.check-environment.outputs.result}} == production"
            arguments:
              parameters:
                - name: environment
                  value: production
          - name: deploy-staging
            template: deploy
            dependencies: [check-environment]
            when: "{{tasks.check-environment.outputs.result}} == staging"
            arguments:
              parameters:
                - name: environment
                  value: staging
          - name: notify-success
            template: notify
            dependencies: [deploy-production, deploy-staging]
            arguments:
              parameters:
                - name: message
                  value: "Deployment complete to {{tasks.check-environment.outputs.result}}"

    - name: check-env
      script:
        image: alpine:3.19
        command: [sh]
        source: |
          if [ "${DEPLOY_ENV}" = "production" ]; then
            echo -n "production"
          else
            echo -n "staging"
          fi
      env:
        - name: DEPLOY_ENV
          valueFrom:
            configMapKeyRef:
              name: pipeline-config
              key: deploy-env

    - name: deploy
      inputs:
        parameters:
          - name: environment
      container:
        image: kubectl:1.29
        command: [sh, -c]
        args: ["echo Deploying to {{inputs.parameters.environment}}"]

    - name: notify
      inputs:
        parameters:
          - name: message
      container:
        image: curlimages/curl:8.5.0
        command: [sh, -c]
        args: ["echo {{inputs.parameters.message}}"]
```

### DAG with Dynamic Fan-Out Using withItems

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: fan-out-dag-
spec:
  entrypoint: fan-out-pipeline
  templates:
    - name: fan-out-pipeline
      dag:
        tasks:
          - name: get-regions
            template: list-regions
          - name: deploy-region
            template: deploy-to-region
            dependencies: [get-regions]
            arguments:
              parameters:
                - name: region
                  value: "{{item.region}}"
                - name: cluster
                  value: "{{item.cluster}}"
            withParam: "{{tasks.get-regions.outputs.result}}"

    - name: list-regions
      script:
        image: python:3.11-slim
        command: [python]
        source: |
          import json
          regions = [
            {"region": "us-east-1", "cluster": "prod-east"},
            {"region": "us-west-2", "cluster": "prod-west"},
            {"region": "eu-west-1", "cluster": "prod-eu"},
          ]
          print(json.dumps(regions))

    - name: deploy-to-region
      inputs:
        parameters:
          - name: region
          - name: cluster
      container:
        image: alpine:3.19
        command: [sh, -c]
        args:
          - |
            echo "Deploying to region={{inputs.parameters.region}} cluster={{inputs.parameters.cluster}}"
            sleep 2
            echo "Deploy complete"
```

### Nested DAG Templates

Complex pipelines benefit from nesting DAGs to build reusable sub-workflows:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: build-and-test
  namespace: argo
spec:
  templates:
    - name: build-and-test-dag
      inputs:
        parameters:
          - name: repo-url
          - name: commit-sha
          - name: image-tag
      dag:
        tasks:
          - name: clone
            template: git-clone
            arguments:
              parameters:
                - name: repo
                  value: "{{inputs.parameters.repo-url}}"
                - name: sha
                  value: "{{inputs.parameters.commit-sha}}"
          - name: unit-test
            template: run-tests
            dependencies: [clone]
            arguments:
              parameters:
                - name: test-suite
                  value: unit
              artifacts:
                - name: source
                  from: "{{tasks.clone.outputs.artifacts.source}}"
          - name: integration-test
            template: run-tests
            dependencies: [clone]
            arguments:
              parameters:
                - name: test-suite
                  value: integration
              artifacts:
                - name: source
                  from: "{{tasks.clone.outputs.artifacts.source}}"
          - name: build-image
            template: docker-build
            dependencies: [unit-test, integration-test]
            arguments:
              parameters:
                - name: image-tag
                  value: "{{inputs.parameters.image-tag}}"
              artifacts:
                - name: source
                  from: "{{tasks.clone.outputs.artifacts.source}}"

    - name: git-clone
      inputs:
        parameters:
          - name: repo
          - name: sha
      outputs:
        artifacts:
          - name: source
            path: /src
      container:
        image: alpine/git:2.43.0
        command: [sh, -c]
        args:
          - |
            git clone {{inputs.parameters.repo}} /src
            cd /src && git checkout {{inputs.parameters.sha}}

    - name: run-tests
      inputs:
        parameters:
          - name: test-suite
        artifacts:
          - name: source
            path: /src
      outputs:
        artifacts:
          - name: test-results
            path: /reports
      container:
        image: golang:1.22-alpine
        workingDir: /src
        command: [sh, -c]
        args:
          - |
            mkdir -p /reports
            go test ./... -v -run {{inputs.parameters.test-suite}} \
              -json > /reports/results.json 2>&1 || true

    - name: docker-build
      inputs:
        parameters:
          - name: image-tag
        artifacts:
          - name: source
            path: /src
      container:
        image: gcr.io/kaniko-project/executor:v1.20.0
        args:
          - --dockerfile=/src/Dockerfile
          - --context=/src
          - --destination=registry.example.com/app:{{inputs.parameters.image-tag}}
          - --cache=true
          - --cache-repo=registry.example.com/cache
```

## Section 3: Retry Strategies

Retry strategies in Argo Workflows are critical for building resilient pipelines. The v3.x retry model provides fine-grained control over when and how retries occur.

### Retry Configuration Fields

```yaml
retryStrategy:
  limit: "5"                    # maximum retry attempts (string or int)
  retryPolicy: OnFailure        # OnFailure | OnError | OnTransientError | Always
  backoff:
    duration: 30s               # base backoff duration
    factor: "2"                 # exponential multiplier
    maxDuration: 10m            # maximum backoff cap
  affinity:
    nodeAntiAffinity: {}        # avoid node that caused failure
  expression: >-
    lastRetry.status == "Error" &&
    int(lastRetry.exitCode) in [1, 137, 143]
```

### Retry Policy Types

- **OnFailure**: Retry when the pod exits with a non-zero exit code
- **OnError**: Retry on infrastructure errors (pod eviction, OOM kill, node failure)
- **OnTransientError**: Retry on errors marked as transient by the executor
- **Always**: Retry on any failure including explicit failure

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: retry-patterns
  namespace: argo
spec:
  templates:
    # Pattern 1: Simple exponential backoff for flaky network calls
    - name: http-call
      retryStrategy:
        limit: "3"
        retryPolicy: OnFailure
        backoff:
          duration: 10s
          factor: "2"
          maxDuration: 60s
      container:
        image: curlimages/curl:8.5.0
        command: [sh, -c]
        args: ["curl -f https://api.example.com/health"]

    # Pattern 2: Infrastructure error recovery with node anti-affinity
    - name: batch-job
      retryStrategy:
        limit: "5"
        retryPolicy: OnError
        backoff:
          duration: 1m
          factor: "1.5"
          maxDuration: 15m
        affinity:
          nodeAntiAffinity: {}
      container:
        image: python:3.11-slim
        resources:
          requests:
            cpu: 2000m
            memory: 4Gi
        command: [python, batch_processor.py]

    # Pattern 3: Expression-based conditional retry
    - name: conditional-retry
      retryStrategy:
        limit: "10"
        retryPolicy: OnFailure
        expression: >-
          lastRetry.status == "Failed" &&
          asInt(lastRetry.exitCode) in [1, 2, 124] &&
          !lastRetry.message.contains("PERMANENT_FAILURE")
        backoff:
          duration: 5s
          factor: "2"
          maxDuration: 5m
      script:
        image: python:3.11-slim
        command: [python]
        source: |
          import sys
          import random

          # Simulate various failure modes
          r = random.random()
          if r < 0.3:
              print("PERMANENT_FAILURE: Invalid input data")
              sys.exit(1)
          elif r < 0.5:
              print("Transient network error")
              sys.exit(2)
          elif r < 0.6:
              print("Timeout")
              sys.exit(124)
          else:
              print("Success")
              sys.exit(0)

    # Pattern 4: Workflow-level retry
    - name: entire-workflow-retry
      steps:
        - - name: step1
            template: http-call
          - name: step2
            template: batch-job
```

### Workflow-Level Retry Policy

Apply retry at the workflow level to restart the entire graph on failure:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: workflow-retry-
spec:
  retryStrategy:
    limit: "2"
    retryPolicy: OnFailure
    backoff:
      duration: 5m
      factor: "1"
  entrypoint: main
  templates:
    - name: main
      dag:
        tasks:
          - name: step1
            template: work
          - name: step2
            template: work
            dependencies: [step1]

    - name: work
      container:
        image: alpine:3.19
        command: [sh, -c]
        args: ["sleep 5 && echo done"]
```

### Memoization for Retry Efficiency

Memoization caches successful task outputs so retries skip completed steps:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: memoized-pipeline-
spec:
  entrypoint: pipeline
  templates:
    - name: pipeline
      dag:
        tasks:
          - name: expensive-compute
            template: compute
            memoize:
              key: "compute-{{workflow.parameters.input-hash}}"
              maxAge: "24h"
              cache:
                configMap:
                  name: workflow-cache
          - name: use-result
            template: use
            dependencies: [expensive-compute]
            arguments:
              parameters:
                - name: result
                  value: "{{tasks.expensive-compute.outputs.parameters.result}}"

    - name: compute
      outputs:
        parameters:
          - name: result
            valueFrom:
              path: /tmp/result
      container:
        image: python:3.11-slim
        command: [sh, -c]
        args:
          - |
            python -c "
            import time, random
            time.sleep(30)  # expensive computation
            result = random.randint(1, 1000)
            open('/tmp/result', 'w').write(str(result))
            "

    - name: use
      inputs:
        parameters:
          - name: result
      container:
        image: alpine:3.19
        command: [sh, -c]
        args: ["echo Using result: {{inputs.parameters.result}}"]
```

## Section 4: Artifact Management

Artifacts are the primary mechanism for passing data between workflow steps. Argo v3.x supports S3, GCS, Azure Blob, HDFS, and HTTP artifact repositories.

### Configuring the Default Artifact Repository

```yaml
# workflow-controller-configmap configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-controller-configmap
  namespace: argo
data:
  artifactRepository: |
    archiveLogs: true
    s3:
      bucket: argo-artifacts-production
      endpoint: s3.amazonaws.com
      region: us-east-1
      roleARN: arn:aws:iam::123456789012:role/argo-workflows-s3
      useSDKCreds: true
      encryptionOptions:
        enableEncryption: true
        serverSideCustomerAlgorithm: AES256
      keyFormat: >-
        {{workflow.namespace}}/
        {{workflow.name}}/
        {{pod.name}}
```

For on-premises MinIO:

```yaml
  artifactRepository: |
    s3:
      bucket: argo-artifacts
      endpoint: minio.storage.svc.cluster.local:9000
      insecure: true
      accessKeySecret:
        name: minio-credentials
        key: accessKey
      secretKeySecret:
        name: minio-credentials
        key: secretKey
      keyFormat: "{{workflow.namespace}}/{{workflow.name}}/{{pod.name}}"
```

### Artifact Input and Output Patterns

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: artifact-patterns
  namespace: argo
spec:
  templates:
    # Pattern 1: File artifact output
    - name: generate-report
      outputs:
        artifacts:
          - name: report
            path: /tmp/report
            archive:
              tar:
                compressionLevel: 6
            s3:
              key: "reports/{{workflow.name}}/report.tar.gz"
      container:
        image: python:3.11-slim
        command: [sh, -c]
        args:
          - |
            mkdir -p /tmp/report
            python generate_report.py --output /tmp/report

    # Pattern 2: Directory artifact with glob
    - name: collect-logs
      outputs:
        artifacts:
          - name: logs
            path: /var/log/app
            archive:
              none: {}       # keep as-is without compression
            s3:
              key: "logs/{{workflow.name}}/{{pod.name}}.tar"
      container:
        image: alpine:3.19
        command: [sh, -c]
        args:
          - |
            mkdir -p /var/log/app
            for i in $(seq 1 5); do
              echo "Log line $i at $(date)" >> /var/log/app/app.log
            done

    # Pattern 3: Artifact passed between steps
    - name: process-artifacts
      inputs:
        artifacts:
          - name: raw-data
            path: /data/input
            s3:
              key: "inputs/{{workflow.name}}/raw.csv"
      outputs:
        artifacts:
          - name: processed-data
            path: /data/output
      container:
        image: python:3.11-slim
        command: [python, -c]
        args:
          - |
            import pandas as pd
            import os
            os.makedirs('/data/output', exist_ok=True)
            df = pd.read_csv('/data/input')
            df_processed = df.dropna()
            df_processed.to_parquet('/data/output/result.parquet')

    # Pattern 4: HTTP artifact input
    - name: fetch-config
      inputs:
        artifacts:
          - name: config
            path: /config/settings.json
            http:
              url: https://config-server.example.com/v1/settings
              headers:
                - name: Authorization
                  valueFrom:
                    secretKeyRef:
                      name: config-server-token
                      key: token
      container:
        image: alpine:3.19
        command: [sh, -c]
        args: ["cat /config/settings.json"]

    # Pattern 5: GCS artifact
    - name: gcs-artifact-step
      inputs:
        artifacts:
          - name: model
            path: /models/current
            gcs:
              bucket: ml-models-production
              key: "models/{{workflow.parameters.model-version}}/weights.bin"
      container:
        image: tensorflow/tensorflow:2.15.0
        command: [python, inference.py]
        args: [--model-path, /models/current]
```

### Artifact Garbage Collection

Configure TTL and GC policies to prevent artifact storage bloat:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: gc-demo-
spec:
  artifactGC:
    strategy: OnWorkflowDeletion    # OnWorkflowCompletion | OnWorkflowDeletion | Never
    forceFinalizerRemoval: false
    podMetadata:
      labels:
        app: artifact-gc
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
    serviceAccountName: argo-artifact-gc
  entrypoint: main
  templates:
    - name: main
      outputs:
        artifacts:
          - name: result
            path: /tmp/result
            artifactGC:
              strategy: OnWorkflowCompletion    # override per-artifact
      container:
        image: alpine:3.19
        command: [sh, -c]
        args: ["echo hello > /tmp/result"]
```

## Section 5: Workflow Executor Deep Dive

### Emissary Executor Internals

The emissary executor uses named pipes to capture output:

```
/tmp/argo/outputs/
├── exitcode          # container exit code
├── result            # captured stdout for script templates
└── parameters/
    └── <param-name>  # per-parameter output files
```

Configure emissary-specific behavior:

```yaml
# Override executor image
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-controller-configmap
  namespace: argo
data:
  executor: |
    resources:
      requests:
        cpu: 200m
        memory: 128Mi
      limits:
        cpu: 1000m
        memory: 512Mi
    env:
      - name: ARGO_TRACE
        value: "1"
    securityContext:
      runAsNonRoot: true
      runAsUser: 65534
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: [ALL]
```

### Workflow Executor RBAC

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argo-workflow
  namespace: argo
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/argo-workflow-role
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: argo-workflow-role
  namespace: argo
rules:
  - apiGroups: [argoproj.io]
    resources: [workflows, workflowtaskresults]
    verbs: [get, list, watch, update, patch]
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [""]
    resources: [pods/log]
    verbs: [get, watch]
  - apiGroups: [""]
    resources: [secrets]
    verbs: [get]
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [get, list, watch, create, update, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: argo-workflow-binding
  namespace: argo
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: argo-workflow-role
subjects:
  - kind: ServiceAccount
    name: argo-workflow
    namespace: argo
```

## Section 6: Production Best Practices

### Workflow Controller Tuning

```yaml
# workflow-controller-configmap production settings
data:
  # Limit concurrent workflows
  parallelism: "50"

  # Node status offloading (required for large workflows)
  nodeStatusOffLoad: "true"

  # Workflow archive configuration
  persistence: |
    connectionPool:
      maxIdleConns: 100
      maxOpenConns: 200
      connMaxLifetime: 5m
    nodeStatusOffLoad: true
    archive: true
    archiveTTL: 90d
    postgresql:
      host: postgres.argo.svc.cluster.local
      port: 5432
      database: argo
      tableName: argo_workflows
      userNameSecret:
        name: argo-postgres-config
        key: username
      passwordSecret:
        name: argo-postgres-config
        key: password

  # Rate limiting to protect the API server
  resourceRateLimit: |
    limit: 10
    burst: 1

  # Workflow default settings
  workflowDefaults: |
    spec:
      ttlStrategy:
        secondsAfterCompletion: 604800   # 7 days
        secondsAfterSuccess: 259200       # 3 days
        secondsAfterFailure: 604800       # 7 days
      podGC:
        strategy: OnPodSuccess
      activeDeadlineSeconds: 3600         # 1 hour max runtime
```

### Monitoring Argo Workflows

```yaml
# ServiceMonitor for Prometheus
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: argo-workflows
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: argo-workflows-workflow-controller
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
  namespaceSelector:
    matchNames:
      - argo
```

Key Prometheus metrics to alert on:

```yaml
# PrometheusRule for Argo Workflows
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argo-workflow-alerts
  namespace: monitoring
spec:
  groups:
    - name: argo-workflows
      interval: 60s
      rules:
        - alert: ArgoWorkflowFailed
          expr: |
            increase(argo_workflows_count{status="Failed"}[5m]) > 0
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Argo workflow failed"
            description: "{{ $value }} workflows failed in the last 5 minutes"

        - alert: ArgoWorkflowQueueBacklog
          expr: |
            argo_queue_depth_gauge{queue_name="workflow"} > 100
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "Argo workflow queue backlog"

        - alert: ArgoPodPendingLong
          expr: |
            argo_pods_gauge{status="Pending"} > 50
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Many Argo pods pending"
```

### Cron Workflow Configuration

```yaml
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: nightly-pipeline
  namespace: argo
spec:
  schedule: "0 2 * * *"
  timezone: "America/New_York"
  concurrencyPolicy: Replace       # Allow | Forbid | Replace
  startingDeadlineSeconds: 300
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  workflowSpec:
    entrypoint: nightly-dag
    serviceAccountName: argo-workflow
    podGC:
      strategy: OnWorkflowSuccess
    ttlStrategy:
      secondsAfterCompletion: 86400
    templates:
      - name: nightly-dag
        dag:
          tasks:
            - name: backup
              template: run-backup
            - name: cleanup
              template: run-cleanup
              dependencies: [backup]
            - name: report
              template: send-report
              dependencies: [cleanup]

      - name: run-backup
        retryStrategy:
          limit: "3"
          retryPolicy: OnFailure
          backoff:
            duration: 5m
            factor: "2"
        container:
          image: backup-tool:latest
          command: [/usr/local/bin/backup]

      - name: run-cleanup
        container:
          image: cleanup-tool:latest
          command: [/usr/local/bin/cleanup]
          args: ["--days=30"]

      - name: send-report
        container:
          image: reporting-tool:latest
          command: [/usr/local/bin/report]
          args: ["--format=html", "--recipients=ops@example.com"]
```

### Workflow Template Versioning

```yaml
# Use labels for version control of shared templates
apiVersion: argoproj.io/v1alpha1
kind: ClusterWorkflowTemplate
metadata:
  name: build-pipeline-v2
  labels:
    version: "2.0.0"
    stability: stable
spec:
  templates:
    - name: build
      inputs:
        parameters:
          - name: image
          - name: tag
          - name: dockerfile
            value: Dockerfile
      container:
        image: gcr.io/kaniko-project/executor:v1.20.0
        args:
          - --dockerfile={{inputs.parameters.dockerfile}}
          - --destination={{inputs.parameters.image}}:{{inputs.parameters.tag}}
          - --cache=true
          - --snapshot-mode=redo
        volumeMounts:
          - name: kaniko-secret
            mountPath: /kaniko/.docker
      volumes:
        - name: kaniko-secret
          secret:
            secretName: registry-credentials
            items:
              - key: .dockerconfigjson
                path: config.json
```

## Section 7: Troubleshooting

### Common Issues and Solutions

**Workflow stuck in Pending state:**

```bash
# Check controller logs
kubectl logs -n argo -l app=workflow-controller --tail=100 | \
  grep -E "ERROR|WARN|pending"

# Check workflow status
kubectl get workflow <name> -n argo -o jsonpath='{.status.message}'

# Check for resource quota issues
kubectl describe workflow <name> -n argo | grep -A 20 "Status:"
```

**Artifact upload failures:**

```bash
# Check executor logs in the wait container
kubectl logs <pod-name> -n argo -c wait

# Verify S3 credentials
kubectl get secret -n argo minio-credentials -o jsonpath='{.data.accessKey}' | base64 -d

# Test connectivity from within the namespace
kubectl run -it --rm debug --image=minio/mc:latest -n argo -- \
  mc alias set minio http://minio.storage.svc.cluster.local:9000 \
  <access-key> <secret-key>
```

**Memory/CPU resource issues:**

```bash
# Check if nodes have enough resources
kubectl top nodes

# View workflow resource requirements
kubectl get workflow <name> -n argo -o json | \
  jq '.spec.templates[].container.resources'

# Add resource limits to workflow controller
kubectl patch deployment workflow-controller -n argo \
  --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/resources","value":{"requests":{"cpu":"500m","memory":"512Mi"},"limits":{"cpu":"2000m","memory":"2Gi"}}}]'
```

### Debugging Workflow Templates

```yaml
# Add debug template for inspection
- name: debug
  container:
    image: alpine:3.19
    command: [sh, -c]
    args:
      - |
        echo "=== Environment ==="
        env | sort
        echo "=== Filesystem ==="
        find /tmp -type f 2>/dev/null
        echo "=== Workflow vars ==="
        echo "Name: {{workflow.name}}"
        echo "UID: {{workflow.uid}}"
        echo "Status: {{workflow.status}}"
        sleep 3600  # keep alive for exec access
```

Argo Workflows v3.x provides a mature, production-ready workflow execution platform. The key to operating it reliably at scale is understanding the executor model, configuring appropriate retry strategies for each class of failure, and using artifact repositories that match your durability and performance requirements.
