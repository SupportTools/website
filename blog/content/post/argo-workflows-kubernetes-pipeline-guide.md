---
title: "Argo Workflows: Kubernetes-Native Pipeline Orchestration at Scale"
date: 2027-03-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Argo Workflows", "CI/CD", "Pipelines", "Workflow Orchestration"]
categories: ["Kubernetes", "CI/CD", "Automation"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Argo Workflows on Kubernetes covering DAG and Steps templates, artifact passing, template references, WorkflowTemplates, workflow archiving with PostgreSQL, RBAC, Prometheus monitoring, and production-grade workflow patterns for ML pipelines and CI/CD."
more_link: "yes"
url: "/argo-workflows-kubernetes-pipeline-guide/"
---

Argo Workflows is one of the most capable workflow orchestration engines available in the Kubernetes ecosystem. Unlike general-purpose job schedulers bolted onto Kubernetes, Argo Workflows was designed from the ground up to use Kubernetes primitives — Pods, PersistentVolumeClaims, ServiceAccounts, and RBAC — as its execution substrate. Each workflow step runs as a Pod, and the entire workflow definition lives as a CRD object in etcd.

This guide covers the full production surface area: template design patterns, artifact passing, WorkflowTemplates for reuse, PostgreSQL-backed archiving, Prometheus metrics, RBAC hardening, and SSO integration. Concrete YAML and Go code examples are provided throughout.

<!--more-->

## Argo Workflows vs Tekton vs Apache Airflow

Before committing to Argo Workflows, it is worth understanding the trade-offs relative to the two most common alternatives.

### Tekton

Tekton is the CNCF pipeline framework underpinning many CI/CD platforms (Jenkins X, Red Hat Pipelines, Shipwright). Its primitives are Task, TaskRun, Pipeline, and PipelineRun. Tekton is purpose-built for CI/CD and has first-class support for git events via Triggers. However, its DAG capabilities are limited compared to Argo Workflows — Tekton pipelines are sequential by default, and parallel fan-out requires explicit configuration. Argo Workflows excels at arbitrary DAGs with complex dependencies, conditional branching, and iteration.

### Apache Airflow

Airflow is the dominant workflow tool in the data engineering world. Its DAGs are Python code, which is expressive but couples the scheduler to a Python environment. Airflow's KubernetesExecutor runs tasks as Pods, but the scheduler itself is a long-running process outside Kubernetes control. Argo Workflows is fully Kubernetes-native — there is no external scheduler process, and the controller can be managed with the same GitOps tooling as any other workload.

### When to choose Argo Workflows

- ML training pipelines with GPU node scheduling requirements
- Multi-step data pipelines with artifact hand-off between steps
- CI/CD pipelines that need complex branching, retries, and conditional logic
- Organizations already running ArgoCD who want a unified Argo ecosystem

## Installing Argo Workflows

The official Helm chart provides the recommended production installation path.

```bash
# Add the Argo Helm repository
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

# Create the namespace
kubectl create namespace argo

# Install Argo Workflows with production values
helm upgrade --install argo-workflows argo/argo-workflows \
  --namespace argo \
  --version 0.42.4 \
  --values argo-workflows-values.yaml \
  --wait
```

### Production Helm values

```yaml
# argo-workflows-values.yaml

# Controller configuration
controller:
  replicas: 2
  pdb:
    enabled: true
    minAvailable: 1
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 512Mi
  # Store workflow state in PostgreSQL instead of Kubernetes objects
  persistence:
    connectionPool:
      maxIdleConns: 100
      maxOpenConns: 0
    nodeStatusOffLoad: true
    archive: true
    archiveTTL: 180d
    postgresql:
      host: postgres.argo.svc.cluster.local
      port: 5432
      database: argo
      tableName: argo_workflows
      userNameSecret:
        name: argo-postgres-creds
        key: username
      passwordSecret:
        name: argo-postgres-creds
        key: password
  # Workflow worker threads
  workflowWorkers: 32
  podWorkers: 32
  # Default workflow TTL after completion
  workflowTTLStrategy:
    secondsAfterCompletion: 86400   # 24 hours
    secondsAfterSuccess: 86400
    secondsAfterFailure: 604800     # 7 days

# Server (UI + API)
server:
  enabled: true
  replicas: 2
  pdb:
    enabled: true
    minAvailable: 1
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi
  # Enable SSO — configure Dex separately
  sso:
    enabled: true
    issuer: https://dex.example.com
    clientId:
      name: argo-sso-secret
      key: client-id
    clientSecret:
      name: argo-sso-secret
      key: client-secret
    redirectUrl: https://argo.example.com/oauth2/callback
    scopes:
      - openid
      - profile
      - email
      - groups
    rbac:
      enabled: true

# Artifact repository backed by MinIO
artifactRepository:
  archiveLogs: true
  s3:
    endpoint: minio.minio.svc.cluster.local:9000
    bucket: argo-artifacts
    insecure: true
    accessKeySecret:
      name: argo-minio-creds
      key: accessKey
    secretKeySecret:
      name: argo-minio-creds
      key: secretKey

# Prometheus metrics
metricsConfig:
  enabled: true
  path: /metrics
  port: 9090
  serviceMonitor:
    enabled: true
    namespace: monitoring
    additionalLabels:
      release: kube-prometheus-stack
```

## Workflow CRD Anatomy

A `Workflow` object has three primary fields under `spec`:

- `entrypoint`: the name of the template to execute first
- `templates`: a list of template definitions
- `arguments`: top-level parameters and artifacts passed to the entrypoint

```yaml
# workflow-anatomy.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: data-pipeline-run-20270313
  namespace: argo
  labels:
    pipeline: data-pipeline
    version: "2.1.0"
spec:
  # Which template to start with
  entrypoint: main-dag

  # Top-level arguments accessible to all templates
  arguments:
    parameters:
      - name: dataset-date
        value: "2027-03-13"
      - name: model-version
        value: "v2.1.0"
      - name: parallelism
        value: "4"

  # Cluster-wide parallelism limit for this workflow
  parallelism: 8

  # Pod termination and cleanup settings
  podGC:
    strategy: OnWorkflowCompletion   # Delete pods when workflow finishes

  # Retry policy applied globally unless overridden per-template
  retryStrategy:
    limit: "3"
    retryPolicy: OnFailure
    backoff:
      duration: "30s"
      factor: "2"
      maxDuration: "5m"

  # TTL for this workflow object after completion
  ttlStrategy:
    secondsAfterCompletion: 86400
    secondsAfterSuccess: 86400
    secondsAfterFailure: 604800

  # ServiceAccount with permissions to create pods
  serviceAccountName: argo-workflow-sa

  # Volume definitions available to all templates
  volumes:
    - name: shared-data
      emptyDir: {}

  templates:
    - name: main-dag
      # DAG template defined below
      dag:
        tasks: []
```

## Steps vs DAG Templates

Argo Workflows supports two multi-step orchestration patterns: `steps` (sequential groups with parallel items per group) and `dag` (arbitrary directed acyclic graph with explicit dependency declarations).

### Steps template

```yaml
# steps-template.yaml — sequential stages with intra-stage parallelism
- name: ml-training-pipeline
  steps:
    # Stage 1: Data preparation (two parallel tasks)
    - - name: download-raw-data
        template: download-dataset
        arguments:
          parameters:
            - name: date
              value: "{{workflow.parameters.dataset-date}}"

      - name: validate-schema
        template: run-validation
        arguments:
          parameters:
            - name: schema-version
              value: "3.0"

    # Stage 2: Feature engineering (depends on stage 1 completing)
    - - name: feature-engineering
        template: compute-features
        arguments:
          artifacts:
            - name: raw-data
              from: "{{steps.download-raw-data.outputs.artifacts.dataset}}"

    # Stage 3: Conditional training
    - - name: train-model
        template: train-pytorch-model
        when: "{{steps.feature-engineering.outputs.parameters.record-count}} > 10000"
        arguments:
          parameters:
            - name: epochs
              value: "50"
          artifacts:
            - name: features
              from: "{{steps.feature-engineering.outputs.artifacts.features}}"

      - name: skip-training-notification
        template: send-slack-notification
        when: "{{steps.feature-engineering.outputs.parameters.record-count}} <= 10000"
        arguments:
          parameters:
            - name: message
              value: "Skipping training: insufficient records"
```

### DAG template with conditionals

```yaml
# dag-template.yaml — fine-grained dependency control
- name: main-dag
  dag:
    tasks:
      # Parallel data ingestion tasks
      - name: ingest-clickstream
        template: kafka-consumer
        arguments:
          parameters:
            - name: topic
              value: "clickstream-events"

      - name: ingest-transactions
        template: kafka-consumer
        arguments:
          parameters:
            - name: topic
              value: "transaction-events"

      - name: ingest-user-profiles
        template: s3-downloader
        arguments:
          parameters:
            - name: s3-key
              value: "profiles/{{workflow.parameters.dataset-date}}/profiles.parquet"

      # Join step depends on all three ingestion tasks
      - name: join-datasets
        template: spark-join
        dependencies:
          - ingest-clickstream
          - ingest-transactions
          - ingest-user-profiles
        arguments:
          artifacts:
            - name: clickstream
              from: "{{tasks.ingest-clickstream.outputs.artifacts.data}}"
            - name: transactions
              from: "{{tasks.ingest-transactions.outputs.artifacts.data}}"
            - name: profiles
              from: "{{tasks.ingest-user-profiles.outputs.artifacts.data}}"

      # Validation runs in parallel with feature engineering
      - name: validate-joined-data
        template: data-validator
        dependencies:
          - join-datasets
        arguments:
          artifacts:
            - name: dataset
              from: "{{tasks.join-datasets.outputs.artifacts.joined}}"

      - name: compute-features
        template: feature-pipeline
        dependencies:
          - join-datasets
        arguments:
          artifacts:
            - name: dataset
              from: "{{tasks.join-datasets.outputs.artifacts.joined}}"

      # Model training only if validation passes
      - name: train-model
        template: pytorch-trainer
        dependencies:
          - validate-joined-data
          - compute-features
        when: "{{tasks.validate-joined-data.outputs.parameters.status}} == passed"
        arguments:
          artifacts:
            - name: features
              from: "{{tasks.compute-features.outputs.artifacts.features}}"

      # Always run cleanup regardless of upstream success/failure
      - name: cleanup-temp-storage
        template: s3-cleanup
        dependencies:
          - train-model
        continueOn:
          failed: true
          error: true
        arguments:
          parameters:
            - name: prefix
              value: "temp/{{workflow.parameters.dataset-date}}"
```

## Artifact Passing

Argo Workflows supports artifact passing between steps using S3, GCS, Azure Blob, Git, HTTP, and raw (inline) sources. The artifact repository configured at installation time is the default, but individual templates can override it.

### Template with artifact inputs and outputs

```yaml
# artifact-template.yaml
- name: feature-pipeline
  inputs:
    artifacts:
      - name: dataset
        path: /data/input/dataset.parquet   # mounted inside the container at this path
  outputs:
    parameters:
      - name: record-count
        valueFrom:
          path: /data/output/record_count.txt   # container writes this file
    artifacts:
      - name: features
        path: /data/output/features.parquet     # container writes this file; uploaded to artifact store
        archive:
          none: {}   # do not compress — parquet is already columnar-compressed
  container:
    image: registry.example.com/data-pipeline:2.1.0
    command: [python, /app/feature_pipeline.py]
    args:
      - --input=/data/input/dataset.parquet
      - --output=/data/output/features.parquet
      - --record-count-file=/data/output/record_count.txt
    resources:
      requests:
        cpu: "2"
        memory: 8Gi
      limits:
        cpu: "4"
        memory: 16Gi
    volumeMounts:
      - name: shared-data
        mountPath: /data
```

### Referencing artifacts from previous steps

```yaml
# artifact-reference.yaml — artifact from an S3 location defined inline
- name: downstream-task
  inputs:
    artifacts:
      - name: features
        s3:
          endpoint: minio.minio.svc.cluster.local:9000
          bucket: argo-artifacts
          key: "pipelines/{{workflow.parameters.dataset-date}}/features.parquet"
          insecure: true
          accessKeySecret:
            name: argo-minio-creds
            key: accessKey
          secretKeySecret:
            name: argo-minio-creds
            key: secretKey
        path: /data/features.parquet
  container:
    image: registry.example.com/model-trainer:2.1.0
    command: [python, /app/train.py]
    args:
      - --features=/data/features.parquet
```

## WorkflowTemplate CRD for Reusable Templates

`WorkflowTemplate` is a cluster-namespaced (or namespace-scoped) CRD that stores templates for reuse across multiple Workflows. It replaces the older pattern of copying template definitions between Workflow objects.

```yaml
# workflowtemplate-common.yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: common-utilities
  namespace: argo
  labels:
    team: platform
    version: "3.0.0"
spec:
  templates:
    # Reusable Slack notification template
    - name: slack-notification
      inputs:
        parameters:
          - name: message
          - name: channel
            value: "#alerts"       # default value
          - name: severity
            value: "info"
      container:
        image: curlimages/curl:8.6.0
        command: [sh, -c]
        args:
          - |
            # Post message to Slack via webhook
            curl -s -X POST \
              -H 'Content-Type: application/json' \
              -d "{\"channel\": \"{{inputs.parameters.channel}}\", \"text\": \"[{{inputs.parameters.severity}}] {{inputs.parameters.message}}\"}" \
              "$SLACK_WEBHOOK_URL"
        env:
          - name: SLACK_WEBHOOK_URL
            valueFrom:
              secretKeyRef:
                name: slack-webhook
                key: url

    # Reusable S3 file existence check
    - name: s3-existence-check
      inputs:
        parameters:
          - name: bucket
          - name: key
      outputs:
        parameters:
          - name: exists
            valueFrom:
              path: /tmp/exists.txt
      container:
        image: amazon/aws-cli:2.15.0
        command: [sh, -c]
        args:
          - |
            # Check if object exists in S3
            if aws s3api head-object --bucket {{inputs.parameters.bucket}} --key {{inputs.parameters.key}} 2>/dev/null; then
              echo -n "true" > /tmp/exists.txt
            else
              echo -n "false" > /tmp/exists.txt
            fi
        env:
          - name: AWS_ACCESS_KEY_ID
            valueFrom:
              secretKeyRef:
                name: aws-credentials
                key: access-key-id
          - name: AWS_SECRET_ACCESS_KEY
            valueFrom:
              secretKeyRef:
                name: aws-credentials
                key: secret-access-key
          - name: AWS_DEFAULT_REGION
            value: us-east-1

    # Reusable database migration template
    - name: run-db-migration
      inputs:
        parameters:
          - name: migration-version
          - name: database-name
      container:
        image: registry.example.com/db-migrator:1.5.0
        command: [migrate]
        args:
          - --database={{inputs.parameters.database-name}}
          - --version={{inputs.parameters.migration-version}}
          - --direction=up
        env:
          - name: DATABASE_URL
            valueFrom:
              secretKeyRef:
                name: postgres-app-creds
                key: url
```

### Calling a WorkflowTemplate from a Workflow

```yaml
# workflow-using-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: etl-pipeline-20270313
  namespace: argo
spec:
  entrypoint: main
  serviceAccountName: argo-workflow-sa
  templates:
    - name: main
      steps:
        - - name: check-source-data
            # Reference a template from the WorkflowTemplate CRD
            templateRef:
              name: common-utilities      # WorkflowTemplate name
              template: s3-existence-check
            arguments:
              parameters:
                - name: bucket
                  value: "raw-data"
                - name: key
                  value: "2027/03/13/clickstream.parquet"

        - - name: run-pipeline
            template: etl-main
            when: "{{steps.check-source-data.outputs.parameters.exists}} == true"

        - - name: notify-missing-data
            templateRef:
              name: common-utilities
              template: slack-notification
            when: "{{steps.check-source-data.outputs.parameters.exists}} == false"
            arguments:
              parameters:
                - name: message
                  value: "Source data missing for 2027-03-13 — ETL pipeline skipped"
                - name: severity
                  value: "warning"
                - name: channel
                  value: "#data-alerts"

    - name: etl-main
      container:
        image: registry.example.com/etl-runner:3.0.0
        command: [python, /app/run_etl.py]
        resources:
          requests:
            cpu: "1"
            memory: 2Gi
```

## Parameterization with Inputs and Outputs

### Global parameters and template scope

```yaml
# parameterization.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: parameterized-build
  namespace: argo
spec:
  entrypoint: build-pipeline
  arguments:
    parameters:
      - name: git-repo
        value: "https://github.com/example-org/service-api.git"
      - name: git-branch
        value: "main"
      - name: image-tag
        value: "20270313.abc1234"
      - name: registry
        value: "registry.example.com"

  templates:
    - name: build-pipeline
      inputs:
        parameters:
          - name: git-repo
          - name: git-branch
          - name: image-tag
          - name: registry
      dag:
        tasks:
          - name: clone-repo
            template: git-clone
            arguments:
              parameters:
                - name: repo
                  value: "{{inputs.parameters.git-repo}}"
                - name: branch
                  value: "{{inputs.parameters.git-branch}}"

          - name: run-unit-tests
            template: go-test
            dependencies: [clone-repo]
            arguments:
              artifacts:
                - name: source
                  from: "{{tasks.clone-repo.outputs.artifacts.source}}"

          - name: build-image
            template: kaniko-build
            dependencies: [run-unit-tests]
            arguments:
              parameters:
                - name: image
                  value: "{{inputs.parameters.registry}}/service-api:{{inputs.parameters.image-tag}}"
              artifacts:
                - name: source
                  from: "{{tasks.clone-repo.outputs.artifacts.source}}"

          - name: scan-image
            template: trivy-scan
            dependencies: [build-image]
            arguments:
              parameters:
                - name: image
                  value: "{{inputs.parameters.registry}}/service-api:{{inputs.parameters.image-tag}}"

          - name: push-image
            template: docker-push
            dependencies: [scan-image]
            when: "{{tasks.scan-image.outputs.parameters.critical-cves}} == 0"
            arguments:
              parameters:
                - name: image
                  value: "{{inputs.parameters.registry}}/service-api:{{inputs.parameters.image-tag}}"

    - name: git-clone
      inputs:
        parameters:
          - name: repo
          - name: branch
      outputs:
        artifacts:
          - name: source
            path: /workspace/source
      container:
        image: bitnami/git:2.43.0
        command: [sh, -c]
        args:
          - |
            # Clone the repository into /workspace/source
            git clone --depth=1 --branch={{inputs.parameters.branch}} \
              {{inputs.parameters.repo}} /workspace/source
        volumeMounts:
          - name: workspace
            mountPath: /workspace
      volumes:
        - name: workspace
          emptyDir: {}

    - name: trivy-scan
      inputs:
        parameters:
          - name: image
      outputs:
        parameters:
          - name: critical-cves
            valueFrom:
              path: /tmp/critical_count.txt
      container:
        image: aquasec/trivy:0.50.0
        command: [sh, -c]
        args:
          - |
            # Run Trivy scan and extract critical CVE count
            trivy image --format json --output /tmp/trivy-report.json \
              --severity CRITICAL {{inputs.parameters.image}} || true
            python3 -c "
            import json, sys
            with open('/tmp/trivy-report.json') as f:
                data = json.load(f)
            count = sum(
                len([v for v in (r.get('Vulnerabilities') or []) if v.get('Severity') == 'CRITICAL'])
                for r in (data.get('Results') or [])
            )
            print(count, end='')
            " > /tmp/critical_count.txt
```

## GPU Node Scheduling for ML Workloads

```yaml
# gpu-workflow.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: gpu-training-run
  namespace: argo
spec:
  entrypoint: train-gpu
  serviceAccountName: argo-workflow-sa
  templates:
    - name: train-gpu
      nodeSelector:
        # Route to GPU nodes specifically
        nvidia.com/gpu.product: NVIDIA-A100-SXM4-40GB
      tolerations:
        # Allow scheduling on tainted GPU nodes
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: node.kubernetes.io/instance-type
                    operator: In
                    values:
                      - p4d.24xlarge
                      - a2-ultragpu-8g
      container:
        image: registry.example.com/pytorch-trainer:2.1.0-cuda12.1
        command: [python, /app/train_distributed.py]
        args:
          - --epochs=100
          - --batch-size=256
          - --learning-rate=0.001
          - --output-dir=/models/output
        resources:
          requests:
            cpu: "16"
            memory: 120Gi
            nvidia.com/gpu: "4"
          limits:
            cpu: "32"
            memory: 240Gi
            nvidia.com/gpu: "4"
        env:
          - name: NCCL_DEBUG
            value: INFO
          - name: PYTHONFAULTHANDLER
            value: "1"
        volumeMounts:
          - name: model-storage
            mountPath: /models
          - name: dshm                  # shared memory for PyTorch DataLoader workers
            mountPath: /dev/shm
      volumes:
        - name: model-storage
          persistentVolumeClaim:
            claimName: ml-models-pvc
        - name: dshm
          emptyDir:
            medium: Memory
            sizeLimit: 32Gi
```

## Retry Strategy and Pod GC

### Per-template retry strategy

```yaml
# retry-strategy.yaml
- name: flaky-api-call
  retryStrategy:
    limit: "5"
    retryPolicy: OnError         # retry on pod error (not on step failure)
    expression: "lastRetry.status == 'Error'"
    backoff:
      duration: "10s"
      factor: "2"
      maxDuration: "3m"
  container:
    image: curlimages/curl:8.6.0
    command: [sh, -c]
    args:
      - |
        # Call external API with timeout
        curl --fail --max-time 30 \
          -H "Authorization: Bearer $API_TOKEN" \
          https://api.example.com/v2/data/ingest
    env:
      - name: API_TOKEN
        valueFrom:
          secretKeyRef:
            name: api-credentials
            key: token
```

### Pod GC strategy options

```yaml
# pod-gc.yaml
spec:
  podGC:
    # Delete pods based on completion state:
    #   OnPodCompletion      — delete immediately when pod completes
    #   OnPodSuccess         — delete only on successful pods
    #   OnWorkflowCompletion — delete all pods when workflow finishes
    #   OnWorkflowSuccess    — delete only on successful workflow completion
    strategy: OnWorkflowCompletion
    labelSelector:
      matchLabels:
        workflows.argoproj.io/workflow: "{{workflow.name}}"
```

## Workflow Archiving with PostgreSQL

When `persistence.archive: true` is set in the controller configuration, completed workflows are serialized to PostgreSQL instead of being stored only as Kubernetes objects. This enables:

- Long-term history beyond Kubernetes etcd retention
- Workflow listing and filtering via the UI and CLI without etcd load
- Compliance audit trails

### PostgreSQL schema (auto-created by controller)

```sql
-- Argo Workflows auto-creates these tables on startup
-- Shown here for reference and index tuning

-- Main workflow archive table
CREATE TABLE argo_workflows (
    id            VARCHAR(128) NOT NULL,
    name          VARCHAR(256) NOT NULL,
    phase         VARCHAR(25)  NOT NULL,
    namespace     VARCHAR(256) NOT NULL,
    workflow      TEXT         NOT NULL,   -- JSON-encoded workflow object
    startedat     TIMESTAMP    NOT NULL,
    finishedat    TIMESTAMP,
    clustername   VARCHAR(64)  NOT NULL,
    PRIMARY KEY (clustername, namespace, name)
);

-- Index for common query patterns
CREATE INDEX idx_argo_workflows_phase_started
    ON argo_workflows (phase, startedat DESC);

CREATE INDEX idx_argo_workflows_namespace_started
    ON argo_workflows (namespace, startedat DESC);
```

### Creating the secret for PostgreSQL credentials

```bash
# Create the PostgreSQL credentials secret
kubectl create secret generic argo-postgres-creds \
  --namespace argo \
  --from-literal=username=argo_user \
  --from-literal=password=EXAMPLE_TOKEN_REPLACE_ME
```

### Querying archived workflows with the CLI

```bash
# List archived workflows
argo archive list --namespace argo

# List with label filter
argo archive list --namespace argo -l pipeline=data-pipeline

# Get a specific archived workflow (replace the UID with the actual workflow UID from 'argo archive list')
argo archive get 8a1b2c3d-4e5f-6789-abcd-ef0123456789 --namespace argo

# Delete archived workflows older than 90 days
argo archive delete --namespace argo \
  --older-than 90d
```

## RBAC for Workflow Submission

```yaml
# rbac.yaml — RBAC resources for workflow submission

# ServiceAccount used by workflow pods
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argo-workflow-sa
  namespace: argo

---
# Role allowing workflow management within the argo namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: argo-workflow-role
  namespace: argo
rules:
  # Workflow management
  - apiGroups: ["argoproj.io"]
    resources: ["workflows", "workflowtemplates", "cronworkflows", "workflowtaskresults"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Pod management — required for executor
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "create", "delete", "patch"]
  - apiGroups: [""]
    resources: ["pods/log", "pods/exec"]
    verbs: ["get", "list", "watch"]
  # ConfigMaps for artifact metadata
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
  # ServiceAccount tokens for workflow pods
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["get", "list"]
  # Secret access (for artifact credentials)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
  # PVC management for volume claim templates
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "delete"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: argo-workflow-rb
  namespace: argo
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: argo-workflow-role
subjects:
  - kind: ServiceAccount
    name: argo-workflow-sa
    namespace: argo

---
# Separate role for data science team — submit only, no delete
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workflow-submitter
  namespace: argo
rules:
  - apiGroups: ["argoproj.io"]
    resources: ["workflows"]
    verbs: ["create", "get", "list", "watch"]
  - apiGroups: ["argoproj.io"]
    resources: ["workflowtemplates"]
    verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: data-science-workflow-submitter
  namespace: argo
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: workflow-submitter
subjects:
  - kind: Group
    name: data-science-team    # Mapped from Dex/OIDC groups claim
    apiGroup: rbac.authorization.k8s.io
```

## Prometheus Metrics

Argo Workflows exposes metrics on the controller's `:9090/metrics` endpoint. The most operationally relevant metrics are:

### Key metrics

| Metric | Type | Description |
|---|---|---|
| `argo_workflows_count` | Gauge | Current workflows by phase (Running/Failed/Succeeded) |
| `argo_workflows_error_count` | Counter | Workflow error events |
| `argo_workflow_duration_seconds` | Histogram | Workflow completion duration |
| `argo_workflows_pods_total` | Gauge | Active pod count |
| `argo_queue_depth_gauge` | Gauge | Workflow controller queue depth |
| `argo_pod_pending_count` | Gauge | Pods stuck in Pending state |
| `argo_workers_busy_count` | Gauge | Active controller worker threads |

### Prometheus recording rules

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argo-workflows-rules
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: argo-workflows
      interval: 30s
      rules:
        # Workflow success rate (5-minute window)
        - record: argo:workflow_success_rate:5m
          expr: |
            rate(argo_workflows_error_count{namespace="argo"}[5m])
            /
            (rate(argo_workflows_error_count{namespace="argo"}[5m]) + rate(argo_workflow_duration_seconds_count{namespace="argo"}[5m]))

        # Alert: workflow failure rate above 10%
        - alert: ArgoWorkflowHighFailureRate
          expr: |
            (
              sum(rate(argo_workflows_error_count{namespace="argo"}[15m])) by (namespace)
              /
              sum(rate(argo_workflow_duration_seconds_count{namespace="argo"}[15m])) by (namespace)
            ) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High Argo Workflow failure rate in {{ $labels.namespace }}"
            description: "Workflow failure rate is {{ $value | humanizePercentage }} in namespace {{ $labels.namespace }}"

        # Alert: workflow stuck running for more than 2 hours
        - alert: ArgoWorkflowRunningTooLong
          expr: |
            argo_workflow_duration_seconds{phase="Running"} > 7200
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Argo Workflow running for over 2 hours"
            description: "Workflow {{ $labels.workflow }} in {{ $labels.namespace }} has been running for {{ $value | humanizeDuration }}"

        # Alert: controller queue depth backing up
        - alert: ArgoWorkflowControllerQueueDepthHigh
          expr: argo_queue_depth_gauge{queue_name="workflow"} > 50
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Argo Workflow controller queue depth is high"
            description: "Queue depth is {{ $value }} — controller may be overloaded"
```

## SSO with Dex

```yaml
# dex-argo-config.yaml — Dex connector and client for Argo Workflows SSO
apiVersion: v1
kind: ConfigMap
metadata:
  name: dex-config
  namespace: dex
data:
  config.yaml: |
    issuer: https://dex.example.com

    storage:
      type: kubernetes
      config:
        inCluster: true

    web:
      https: 0.0.0.0:5556
      tlsCert: /etc/dex/tls/tls.crt
      tlsKey: /etc/dex/tls/tls.key

    connectors:
      - type: ldap
        id: ldap
        name: Corporate LDAP
        config:
          host: ldap.example.com:636
          insecureNoSSL: false
          insecureSkipVerify: false
          bindDN: cn=dex-service,ou=services,dc=example,dc=com
          bindPW: $LDAP_BIND_PASSWORD
          userSearch:
            baseDN: ou=users,dc=example,dc=com
            filter: "(objectClass=person)"
            username: uid
            idAttr: uid
            emailAttr: mail
            nameAttr: cn
          groupSearch:
            baseDN: ou=groups,dc=example,dc=com
            filter: "(objectClass=groupOfNames)"
            userAttr: dn
            groupAttr: member
            nameAttr: cn

    staticClients:
      - id: argo-workflows
        redirectURIs:
          - https://argo.example.com/oauth2/callback
        name: Argo Workflows
        secretEnv: ARGO_SSO_CLIENT_SECRET

    oauth2:
      skipApprovalScreen: true
      responseTypes: [code]
```

### Argo RBAC configuration using SSO groups

```yaml
# argo-rbac-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-controller-configmap
  namespace: argo
data:
  # SSO RBAC policy
  # Format: p, <subject>, <resource>, <action>, <namespace>/<name>
  # Subjects can be: user:<email>, group:<group-name>
  sso: |
    rbac:
      enabled: true
      policy: |
        p, admin, workflows, *, argo/*
        p, admin, workflowtemplates, *, argo/*
        p, admin, cronworkflows, *, argo/*
        p, data-science-team, workflows, get, argo/*
        p, data-science-team, workflows, list, argo/*
        p, data-science-team, workflows, create, argo/*
        p, data-science-team, workflowtemplates, get, argo/*
        p, data-science-team, workflowtemplates, list, argo/*
        g, platform-team, admin
      scopes: "[groups]"
```

## CronWorkflow for Scheduled Pipelines

```yaml
# cronworkflow.yaml
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: nightly-data-pipeline
  namespace: argo
spec:
  schedule: "0 2 * * *"           # 2:00 AM UTC daily
  timezone: "America/Chicago"
  concurrencyPolicy: Forbid        # do not start a new run if previous is still running
  startingDeadlineSeconds: 1800    # give up if 30 minutes past scheduled time
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 10
  workflowSpec:
    entrypoint: nightly-pipeline
    serviceAccountName: argo-workflow-sa
    arguments:
      parameters:
        - name: dataset-date
          value: "{{= sprig.dateInZone(\"2006-01-02\", sprig.now(), \"America/Chicago\") }}"
    templates:
      - name: nightly-pipeline
        steps:
          - - name: run-etl
              template: etl-runner
            - name: run-aggregations
              template: aggregation-runner
          - - name: notify-complete
              templateRef:
                name: common-utilities
                template: slack-notification
              arguments:
                parameters:
                  - name: message
                    value: "Nightly pipeline completed for {{workflow.parameters.dataset-date}}"
                  - name: channel
                    value: "#data-platform"

      - name: etl-runner
        container:
          image: registry.example.com/etl:3.0.0
          command: [python, /app/run_etl.py]
          env:
            - name: DATE
              value: "{{workflow.parameters.dataset-date}}"

      - name: aggregation-runner
        container:
          image: registry.example.com/aggregations:3.0.0
          command: [python, /app/run_aggregations.py]
          env:
            - name: DATE
              value: "{{workflow.parameters.dataset-date}}"
```

## Production Operational Runbook

### Submitting a workflow from the CLI

```bash
# Submit a workflow directly
argo submit workflow.yaml --namespace argo --watch

# Submit with parameter overrides
argo submit workflow.yaml --namespace argo \
  --parameter dataset-date=2027-03-13 \
  --parameter model-version=v2.2.0 \
  --watch

# Resubmit a failed workflow with the same parameters
argo resubmit data-pipeline-run-20270313 --namespace argo

# Retry failed nodes in an existing workflow
argo retry data-pipeline-run-20270313 --namespace argo --node-field-selector phase=Failed
```

### Suspending and resuming workflows

```bash
# Suspend a running workflow at the next step boundary
argo suspend data-pipeline-run-20270313 --namespace argo

# Resume a suspended workflow
argo resume data-pipeline-run-20270313 --namespace argo

# Stop a workflow (moves to Failed phase)
argo stop data-pipeline-run-20270313 --namespace argo
```

### Diagnosing stuck workflows

```bash
# Check workflow status and pod events
argo get data-pipeline-run-20270313 --namespace argo

# Get logs from a specific workflow node (replace the node name with actual node from 'argo get')
argo logs data-pipeline-run-20270313 --namespace argo --node-name data-pipeline-run-20270313-join-datasets-1234567

# Get all logs from the workflow
argo logs data-pipeline-run-20270313 --namespace argo --follow

# Check controller logs for scheduling issues
kubectl logs -n argo -l app.kubernetes.io/name=argo-workflows-workflow-controller \
  --since=1h | grep -i "error\|failed\|warn"

# List pods created by a workflow
kubectl get pods -n argo -l workflows.argoproj.io/workflow=data-pipeline-run-20270313
```

### Cleaning up completed workflows

```bash
# Delete completed workflows older than 7 days
argo delete --namespace argo --completed --older-than 7d

# Delete all failed workflows
argo delete --namespace argo --field-selector status.phase=Failed
```

## Summary

Argo Workflows delivers robust, Kubernetes-native pipeline orchestration suitable for both CI/CD and ML workloads. The key production decisions are:

1. Use `WorkflowTemplate` for all reusable logic — never copy template definitions between `Workflow` objects
2. Enable PostgreSQL archiving for long-term workflow history and reduced etcd pressure
3. Configure `podGC` and `ttlStrategy` to avoid Kubernetes object accumulation in high-volume environments
4. Use DAG templates for complex dependency graphs; use Steps templates for sequential stages
5. Scope RBAC roles to the minimum required — workflow submitters should not have pod delete permissions
6. Monitor `argo_queue_depth_gauge` and `argo_pod_pending_count` as primary controller health signals
