---
title: "Kubernetes Argo Workflows: DAG Tasks, Artifact Passing, Template Libraries, and Parallelism Patterns"
date: 2032-04-08T00:00:00-05:00
draft: false
tags: ["Argo Workflows", "Kubernetes", "DAG", "CI/CD", "ML Pipelines", "Workflow Automation", "Parallelism"]
categories:
- Kubernetes
- CI/CD
- MLOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Argo Workflows covering DAG task orchestration, artifact passing between steps, template libraries for reusable workflow components, parallelism patterns, and production deployment strategies."
more_link: "yes"
url: "/kubernetes-argo-workflows-dag-tasks-artifact-passing-parallelism/"
---

Argo Workflows is the de facto standard for container-native workflow orchestration on Kubernetes. Its ability to express complex dependency graphs, pass data between steps via artifacts, and scale massively through parallelism makes it the workflow engine of choice for data engineering, ML pipelines, CI/CD, and ETL at scale. Unlike simpler pipeline tools, Argo Workflows runs entirely as Kubernetes resources — each workflow step is a pod, each dependency relationship is a first-class scheduling concern, and the entire workflow state is stored in etcd.

This guide covers the advanced Argo Workflows patterns that enterprise teams need: DAG-based workflow composition, artifact management for data-passing between steps, template libraries for DRY workflow definitions, parallelism and fan-out patterns, and the operational practices that keep large-scale workflow deployments stable.

<!--more-->

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Argo Workflows Architecture                    │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │  Workflow    │    │  Workflow    │    │   Workflow       │  │
│  │  Controller  │    │  Executor   │    │   Server (API)   │  │
│  │              │    │  (per pod)  │    │                  │  │
│  │  - Schedules │    │  - Collects │    │   - REST API     │  │
│  │    pods      │    │    outputs  │    │   - Web UI       │  │
│  │  - Tracks    │    │  - Saves    │    │   - Auth         │  │
│  │    status    │    │    artifacts│    │                  │  │
│  └──────┬───────┘    └──────┬──────┘    └──────────────────┘  │
│         │                  │                                    │
│         ▼                  ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Kubernetes API                          │  │
│  │  Workflow CR → Pod scheduling → ConfigMap/PVC artifacts  │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Installation and Configuration

### Production Installation with Helm

```yaml
# argo-workflows-values.yaml
---
controller:
  replicas: 2  # HA controller
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 1Gi
  workflowDefaults:
    metadata:
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
    spec:
      # Default service account for workflows
      serviceAccountName: argo-workflow
      # Automatic cleanup after 7 days
      ttlStrategy:
        secondsAfterCompletion: 604800
        secondsAfterSuccess: 86400
        secondsAfterFailure: 604800
      # Pod garbage collection
      podGC:
        strategy: OnPodCompletion
      # Default archive location for artifacts
      archiveLogs: true

server:
  enabled: true
  replicas: 2
  extraArgs:
    - --auth-mode=sso
  ingress:
    enabled: true
    hosts:
      - argo-workflows.example.com
    tls:
      - secretName: argo-workflows-tls
        hosts:
          - argo-workflows.example.com

executor:
  resources:
    requests:
      cpu: 100m
      memory: 64Mi
    limits:
      cpu: 500m
      memory: 512Mi

artifactRepository:
  s3:
    bucket: my-argo-artifacts
    region: us-east-1
    # Use IRSA for AWS credentials
    useSDKCreds: true
    endpoint: ""  # Use default AWS endpoint
    insecure: false
    keyFormat: "{{workflow.namespace}}/{{workflow.name}}/{{pod.name}}"
```

```bash
# Install via Helm
helm repo add argo https://argoproj.github.io/argo-helm
helm install argo-workflows argo/argo-workflows \
  --namespace argo \
  --create-namespace \
  --values argo-workflows-values.yaml \
  --version 0.41.0

# Verify installation
kubectl get pods -n argo
kubectl get crd | grep argoproj.io

# Install argo CLI
curl -sLO "https://github.com/argoproj/argo-workflows/releases/latest/download/argo-linux-amd64.gz"
gunzip argo-linux-amd64.gz
chmod +x argo-linux-amd64
mv argo-linux-amd64 /usr/local/bin/argo

# Verify
argo version
```

## DAG Workflows: Advanced Task Orchestration

### Basic DAG Structure

```yaml
# workflows/data-pipeline-dag.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: data-pipeline
  namespace: argo
spec:
  entrypoint: main-dag
  serviceAccountName: argo-workflow

  # Global workflow-level artifact repository
  artifactRepositoryRef:
    configMap: artifact-repositories
    key: s3

  templates:

  # Main DAG definition
  - name: main-dag
    dag:
      tasks:

      # Step 1: Ingest data (no dependencies)
      - name: ingest-raw-data
        template: ingest-data
        arguments:
          parameters:
          - name: source-url
            value: "s3://raw-data/daily/{{workflow.creationTimestamp.Year}}"
          - name: date
            value: "{{workflow.creationTimestamp}}"

      # Step 2a: Validate schema (depends on ingest)
      - name: validate-schema
        template: schema-validator
        dependencies: [ingest-raw-data]
        arguments:
          artifacts:
          - name: raw-data
            from: "{{tasks.ingest-raw-data.outputs.artifacts.dataset}}"

      # Step 2b: Compute statistics (depends on ingest, parallel with validate)
      - name: compute-stats
        template: statistics-calculator
        dependencies: [ingest-raw-data]
        arguments:
          artifacts:
          - name: raw-data
            from: "{{tasks.ingest-raw-data.outputs.artifacts.dataset}}"

      # Step 3: Transform data (depends on BOTH validation AND stats)
      - name: transform-data
        template: data-transformer
        dependencies: [validate-schema, compute-stats]
        arguments:
          artifacts:
          - name: raw-data
            from: "{{tasks.ingest-raw-data.outputs.artifacts.dataset}}"
          parameters:
          - name: schema-valid
            value: "{{tasks.validate-schema.outputs.parameters.is-valid}}"
          - name: null-threshold
            value: "{{tasks.compute-stats.outputs.parameters.null-percentage}}"

      # Step 4: Load to destination (depends on transform)
      - name: load-to-warehouse
        template: warehouse-loader
        dependencies: [transform-data]
        arguments:
          artifacts:
          - name: transformed-data
            from: "{{tasks.transform-data.outputs.artifacts.output}}"

      # Step 5: Send notification (always runs after load)
      - name: notify-completion
        template: notifier
        dependencies: [load-to-warehouse]
        arguments:
          parameters:
          - name: rows-loaded
            value: "{{tasks.load-to-warehouse.outputs.parameters.rows-loaded}}"
          - name: status
            value: "{{tasks.load-to-warehouse.status}}"

  # Template definitions
  - name: ingest-data
    inputs:
      parameters:
      - name: source-url
      - name: date
    outputs:
      artifacts:
      - name: dataset
        path: /data/output/dataset.parquet
        s3:
          key: "{{workflow.name}}/raw/dataset.parquet"
    container:
      image: registry.example.com/data-ingester:v2.0
      command: [python, ingest.py]
      args:
        - --source={{inputs.parameters.source-url}}
        - --date={{inputs.parameters.date}}
        - --output=/data/output/dataset.parquet
      resources:
        requests:
          cpu: "2"
          memory: "4Gi"
      volumeMounts:
      - name: data-volume
        mountPath: /data
    volumes:
    - name: data-volume
      emptyDir:
        medium: Memory
        sizeLimit: 8Gi
```

### Conditional DAG Execution

```yaml
# workflows/conditional-pipeline.yaml
---
  templates:

  - name: conditional-dag
    dag:
      tasks:

      # Always run data validation
      - name: validate-input
        template: validator
        arguments:
          parameters:
          - name: input-path
            value: "{{workflow.parameters.input-path}}"

      # Only run expensive ML training if data quality is high
      - name: run-ml-training
        template: ml-trainer
        dependencies: [validate-input]
        # Conditional execution based on previous task output
        when: "{{tasks.validate-input.outputs.parameters.quality-score}} >= 0.95"
        arguments:
          parameters:
          - name: quality-score
            value: "{{tasks.validate-input.outputs.parameters.quality-score}}"

      # Run cheaper fallback if data quality is insufficient
      - name: run-heuristic-fallback
        template: heuristic-model
        dependencies: [validate-input]
        when: "{{tasks.validate-input.outputs.parameters.quality-score}} < 0.95"

      # Merge results from whichever branch ran
      - name: merge-results
        template: result-merger
        dependencies: [run-ml-training, run-heuristic-fallback]
```

### Exit Handler Pattern

```yaml
# workflows/exit-handler.yaml — run cleanup regardless of success/failure
---
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: workflow-with-exit-handler
spec:
  entrypoint: main-pipeline
  onExit: cleanup-handler  # Always runs when workflow completes

  templates:

  - name: main-pipeline
    steps:
    - - name: step1
        template: risky-operation
    - - name: step2
        template: dependent-operation

  - name: risky-operation
    container:
      image: alpine
      command: [sh, -c]
      args: ["echo 'Running risky operation'"]

  - name: dependent-operation
    container:
      image: alpine
      command: [sh, -c]
      args: ["echo 'Dependent operation'"]

  # Cleanup template always runs
  - name: cleanup-handler
    steps:
    - - name: cleanup-temp-files
        template: cleanup
    - - name: send-notification
        template: send-slack-notification
        arguments:
          parameters:
          - name: status
            value: "{{workflow.status}}"
          - name: message
            value: "Workflow {{workflow.name}} completed with status: {{workflow.status}}"

  - name: send-slack-notification
    inputs:
      parameters:
      - name: status
      - name: message
    container:
      image: curlimages/curl
      command: [sh, -c]
      args:
        - |
          curl -X POST \
            -H 'Content-type: application/json' \
            --data "{\"text\":\"{{inputs.parameters.message}}\"}" \
            ${SLACK_WEBHOOK_URL}
      env:
      - name: SLACK_WEBHOOK_URL
        valueFrom:
          secretKeyRef:
            name: slack-credentials
            key: webhook-url
```

## Artifact Passing Between Steps

### S3 Artifact Configuration

```yaml
# configmaps/artifact-repositories.yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: artifact-repositories
  namespace: argo
data:
  s3: |
    s3:
      bucket: argo-artifacts-prod
      region: us-east-1
      keyFormat: "{{workflow.namespace}}/{{workflow.name}}/{{pod.name}}/{{inputs.parameters.step-name}}"
      useSDKCreds: true

  gcs: |
    gcs:
      bucket: argo-artifacts-prod
      keyFormat: "{{workflow.namespace}}/{{workflow.name}}/{{pod.name}}"
      serviceAccountKeySecret:
        name: gcs-credentials
        key: serviceAccountKey
```

### Complex Artifact Passing Pattern

```yaml
# workflows/artifact-pipeline.yaml
---
  templates:

  - name: feature-engineering
    inputs:
      artifacts:
      - name: raw-features
        path: /data/input/features.csv
        s3:
          key: "{{workflow.parameters.raw-features-key}}"
    outputs:
      artifacts:
      # Multiple output artifacts from one step
      - name: training-features
        path: /data/output/train_features.parquet
        s3:
          key: "{{workflow.name}}/features/train.parquet"
        archive:
          none: {}  # Don't compress (already compressed parquet)

      - name: validation-features
        path: /data/output/val_features.parquet
        s3:
          key: "{{workflow.name}}/features/val.parquet"
        archive:
          none: {}

      - name: feature-stats
        path: /data/output/stats.json
        s3:
          key: "{{workflow.name}}/features/stats.json"

      # Output parameter extracted from a file
      parameters:
      - name: feature-count
        valueFrom:
          path: /data/output/feature_count.txt
    container:
      image: registry.example.com/feature-engineer:v3.1
      command: [python, feature_engineering.py]
      args:
        - --input=/data/input/features.csv
        - --output-dir=/data/output/
      resources:
        requests:
          cpu: "4"
          memory: "8Gi"

  - name: model-training
    inputs:
      parameters:
      - name: feature-count
      artifacts:
      - name: training-features
        path: /model/input/train.parquet
      - name: validation-features
        path: /model/input/val.parquet
    outputs:
      artifacts:
      - name: trained-model
        path: /model/output/model.pkl
        s3:
          key: "{{workflow.name}}/models/model.pkl"
      parameters:
      - name: model-accuracy
        valueFrom:
          path: /model/output/accuracy.txt
      - name: model-id
        valueFrom:
          path: /model/output/model_id.txt
    container:
      image: registry.example.com/ml-trainer:v2.5
      command: [python, train.py]
      args:
        - --train=/model/input/train.parquet
        - --val=/model/input/val.parquet
        - --features={{inputs.parameters.feature-count}}
        - --output-dir=/model/output/
      resources:
        requests:
          cpu: "8"
          memory: "32Gi"
          nvidia.com/gpu: "1"
        limits:
          nvidia.com/gpu: "1"
```

### Inline Artifact (ConfigMap-backed)

```yaml
# For small configuration files that shouldn't go to S3
  - name: config-driven-processor
    inputs:
      artifacts:
      - name: config
        # Inline artifact from a raw value
        raw:
          data: |
            {
              "batch_size": 1024,
              "max_workers": 8,
              "output_format": "parquet"
            }
        path: /config/processor.json
    container:
      image: registry.example.com/processor:latest
      command: [python, process.py, --config=/config/processor.json]
```

## Template Libraries and Reusability

### WorkflowTemplate: Reusable Template Library

```yaml
# templates/data-engineering-library.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: data-engineering-library
  namespace: argo
  labels:
    template-type: data-engineering
    version: "v2.0"
spec:
  templates:

  # Reusable: Spark job runner
  - name: run-spark-job
    inputs:
      parameters:
      - name: job-class
      - name: input-path
      - name: output-path
      - name: executor-instances
        value: "4"
      - name: executor-memory
        value: "4g"
      - name: driver-memory
        value: "2g"
    resource:
      action: create
      successCondition: status.applicationState.state == COMPLETED
      failureCondition: status.applicationState.state == FAILED
      manifest: |
        apiVersion: sparkoperator.k8s.io/v1beta2
        kind: SparkApplication
        metadata:
          name: {{workflow.name}}-spark-{{inputs.parameters.job-class | lower}}
          namespace: argo
        spec:
          type: Scala
          mode: cluster
          image: registry.example.com/spark:3.4
          mainClass: {{inputs.parameters.job-class}}
          mainApplicationFile: "s3://spark-jars/jobs.jar"
          arguments:
            - --input={{inputs.parameters.input-path}}
            - --output={{inputs.parameters.output-path}}
          sparkConf:
            "spark.sql.adaptive.enabled": "true"
          driver:
            cores: 2
            memory: "{{inputs.parameters.driver-memory}}"
            serviceAccount: spark-driver
          executor:
            cores: 2
            instances: {{inputs.parameters.executor-instances}}
            memory: "{{inputs.parameters.executor-memory}}"

  # Reusable: dbt model run
  - name: run-dbt-models
    inputs:
      parameters:
      - name: models
        value: "+"
      - name: target
        value: "prod"
      - name: profiles-dir
        value: "/dbt/profiles"
    container:
      image: registry.example.com/dbt-runner:1.6
      command: [dbt, run]
      args:
        - --models={{inputs.parameters.models}}
        - --target={{inputs.parameters.target}}
        - --profiles-dir={{inputs.parameters.profiles-dir}}
      envFrom:
      - secretRef:
          name: dbt-credentials

  # Reusable: data quality check
  - name: run-great-expectations
    inputs:
      parameters:
      - name: suite-name
      - name: datasource-name
      - name: data-asset-name
      artifacts:
      - name: expectations-config
        path: /ge/expectations/{{inputs.parameters.suite-name}}.json
    outputs:
      parameters:
      - name: validation-passed
        valueFrom:
          path: /ge/results/passed.txt
    container:
      image: registry.example.com/great-expectations:0.18
      command: [python, run_validation.py]
      args:
        - --suite={{inputs.parameters.suite-name}}
        - --datasource={{inputs.parameters.datasource-name}}
        - --asset={{inputs.parameters.data-asset-name}}
      envFrom:
      - secretRef:
          name: database-credentials

  # Reusable: send Slack notification
  - name: slack-notify
    inputs:
      parameters:
      - name: channel
        value: "#data-pipeline-alerts"
      - name: message
      - name: status
        value: "info"
    script:
      image: curlimages/curl:latest
      command: [sh]
      source: |
        STATUS="{{inputs.parameters.status}}"
        if [ "$STATUS" = "success" ]; then
          EMOJI=":white_check_mark:"
        elif [ "$STATUS" = "failure" ]; then
          EMOJI=":x:"
        else
          EMOJI=":information_source:"
        fi

        curl -X POST \
          -H 'Content-type: application/json' \
          --data "{
            \"channel\": \"{{inputs.parameters.channel}}\",
            \"text\": \"${EMOJI} {{inputs.parameters.message}}\"
          }" \
          "${SLACK_WEBHOOK_URL}"
      env:
      - name: SLACK_WEBHOOK_URL
        valueFrom:
          secretKeyRef:
            name: slack-credentials
            key: webhook-url
```

### Consuming WorkflowTemplates

```yaml
# workflows/daily-pipeline.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: daily-pipeline-{{workflow.creationTimestamp.Y}}-{{workflow.creationTimestamp.m}}-{{workflow.creationTimestamp.d}}
spec:
  entrypoint: daily-etl
  serviceAccountName: argo-workflow

  templates:
  - name: daily-etl
    dag:
      tasks:

      # Use WorkflowTemplate reference
      - name: run-ingestion-spark
        templateRef:
          name: data-engineering-library
          template: run-spark-job
          clusterScope: false  # namespace-scoped template
        arguments:
          parameters:
          - name: job-class
            value: "com.example.jobs.IngestionJob"
          - name: input-path
            value: "s3://raw-data/{{workflow.parameters.date}}"
          - name: output-path
            value: "s3://processed-data/{{workflow.parameters.date}}"
          - name: executor-instances
            value: "8"

      - name: validate-ingested-data
        templateRef:
          name: data-engineering-library
          template: run-great-expectations
        dependencies: [run-ingestion-spark]
        arguments:
          parameters:
          - name: suite-name
            value: "ingested_data_suite"
          - name: datasource-name
            value: "s3_processed"
          - name: data-asset-name
            value: "{{workflow.parameters.date}}"

      - name: run-dbt-transformations
        templateRef:
          name: data-engineering-library
          template: run-dbt-models
        dependencies: [validate-ingested-data]
        when: "{{tasks.validate-ingested-data.outputs.parameters.validation-passed}} == true"
        arguments:
          parameters:
          - name: models
            value: "staging+ marts+"
          - name: target
            value: "prod"

      - name: notify-success
        templateRef:
          name: data-engineering-library
          template: slack-notify
        dependencies: [run-dbt-transformations]
        arguments:
          parameters:
          - name: message
            value: "Daily pipeline completed successfully for {{workflow.parameters.date}}"
          - name: status
            value: "success"
```

### ClusterWorkflowTemplate: Cluster-Wide Templates

```yaml
# cluster-templates/k8s-operations.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: ClusterWorkflowTemplate
metadata:
  name: kubernetes-operations
spec:
  templates:

  # Available in ALL namespaces
  - name: kubectl-apply
    inputs:
      parameters:
      - name: manifest-url
      - name: namespace
        value: "default"
    container:
      image: bitnami/kubectl:latest
      command: [kubectl, apply]
      args:
        - -f
        - "{{inputs.parameters.manifest-url}}"
        - -n
        - "{{inputs.parameters.namespace}}"
      env:
      - name: KUBECONFIG
        value: /config/kubeconfig
      volumeMounts:
      - name: kubeconfig
        mountPath: /config
    volumes:
    - name: kubeconfig
      secret:
        secretName: cluster-kubeconfig

  - name: helm-upgrade
    inputs:
      parameters:
      - name: release-name
      - name: chart
      - name: namespace
      - name: values-file
        value: ""
      - name: extra-args
        value: ""
    container:
      image: alpine/helm:3.13
      command: [sh, -c]
      args:
        - |
          EXTRA_ARGS=""
          if [ -n "{{inputs.parameters.values-file}}" ]; then
            EXTRA_ARGS="--values {{inputs.parameters.values-file}}"
          fi
          helm upgrade --install \
            {{inputs.parameters.release-name}} \
            {{inputs.parameters.chart}} \
            --namespace {{inputs.parameters.namespace}} \
            --create-namespace \
            --wait \
            --timeout 10m \
            $EXTRA_ARGS \
            {{inputs.parameters.extra-args}}
```

## Parallelism Patterns

### WithItems: Fan-Out Over a List

```yaml
# workflows/parallel-processing.yaml
---
  templates:

  - name: process-all-regions
    steps:
    - - name: process-region
        template: process-single-region
        arguments:
          parameters:
          - name: region
            value: "{{item}}"
        # Run one instance per item in the list - all in parallel
        withItems:
          - us-east-1
          - us-west-2
          - eu-west-1
          - ap-southeast-1
          - ap-northeast-1

  - name: process-single-region
    inputs:
      parameters:
      - name: region
    container:
      image: registry.example.com/region-processor:v1.0
      command: [python, process_region.py]
      args: [--region={{inputs.parameters.region}}]
```

### WithParam: Dynamic Fan-Out

```yaml
# workflows/dynamic-fanout.yaml
---
  templates:

  - name: dynamic-parallel-pipeline
    dag:
      tasks:

      # Step 1: Get list of items to process
      - name: enumerate-items
        template: list-items-to-process
        arguments:
          parameters:
          - name: date
            value: "{{workflow.parameters.date}}"

      # Step 2: Process each item in parallel (dynamic list from step 1)
      - name: process-item
        template: item-processor
        dependencies: [enumerate-items]
        arguments:
          parameters:
          - name: item-id
            value: "{{item.id}}"
          - name: item-config
            value: "{{item.config}}"
        # withParam reads JSON array from previous task output
        withParam: "{{tasks.enumerate-items.outputs.result}}"

      # Step 3: Collect results after all parallel items complete
      - name: aggregate-results
        template: results-aggregator
        dependencies: [process-item]

  - name: list-items-to-process
    inputs:
      parameters:
      - name: date
    script:
      image: python:3.11
      command: [python]
      source: |
        import json
        # Query database for items to process
        items = [
          {"id": "item-001", "config": "high-priority"},
          {"id": "item-002", "config": "standard"},
          {"id": "item-003", "config": "standard"},
        ]
        # Output must be JSON array for withParam
        print(json.dumps(items))
```

### Semaphore and Mutex: Concurrency Control

```yaml
# synchronization/semaphores.yaml — limit concurrent workflow execution
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-synchronization
  namespace: argo
data:
  # Named semaphore with limit of 3 concurrent holders
  database-connections: "3"
  # Workflow-level concurrency limit
  pipeline-concurrency: "5"

---
# Use semaphore in workflow to limit concurrent DB access
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: db-intensive-workflow
spec:
  entrypoint: main
  templates:
  - name: main
    steps:
    - - name: db-operation
        template: database-task

  - name: database-task
    # Acquire semaphore before running
    synchronization:
      semaphore:
        configMapKeyRef:
          name: argo-synchronization
          key: database-connections
    container:
      image: registry.example.com/db-worker:v1.0
      command: [python, process.py]

---
# Mutex: only one instance at a time (exclusive lock)
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: exclusive-resource-workflow
spec:
  entrypoint: main
  synchronization:
    mutex:
      name: exclusive-resource-lock
  templates:
  - name: main
    container:
      image: registry.example.com/exclusive-worker:v1.0
      command: [python, exclusive_process.py]
```

### Workflow-Level Parallelism Limits

```yaml
# workflows/bounded-parallel-workflow.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: bounded-parallel
spec:
  entrypoint: main
  # Limit concurrent pods across the entire workflow
  parallelism: 10

  templates:
  - name: main
    steps:
    - - name: generate-work-items
        template: work-generator
    - - name: process-item
        template: processor
        withParam: "{{steps.generate-work-items.outputs.result}}"
        arguments:
          parameters:
          - name: item
            value: "{{item}}"

  - name: processor
    # Per-template parallelism limit (max 5 concurrent regardless of workflow parallelism)
    parallelism: 5
    inputs:
      parameters:
      - name: item
    container:
      image: registry.example.com/processor:v1.0
      command: [python, process.py, --item={{inputs.parameters.item}}]
```

## CronWorkflow: Scheduled Workflows

```yaml
# cron-workflows/daily-pipeline.yaml
---
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: daily-data-pipeline
  namespace: argo
spec:
  # Cron expression (UTC)
  schedule: "0 2 * * *"  # 2 AM UTC daily
  timezone: "America/New_York"

  # Handle missed schedules (e.g., if cluster was down)
  startingDeadlineSeconds: 3600  # Run if missed by less than 1 hour

  # Concurrency policy
  concurrencyPolicy: Forbid  # Don't start if previous run still going
  # Alternatives:
  # Allow: run concurrently
  # Replace: stop previous, start new

  # Keep N completed runs
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3

  workflowSpec:
    entrypoint: daily-pipeline
    serviceAccountName: argo-workflow

    arguments:
      parameters:
      - name: date
        value: "{{workflow.creationTimestamp.Y}}-{{workflow.creationTimestamp.m}}-{{workflow.creationTimestamp.d}}"

    templates:
    - name: daily-pipeline
      dag:
        tasks:
        - name: run-pipeline
          templateRef:
            name: data-engineering-library
            template: run-spark-job
          arguments:
            parameters:
            - name: job-class
              value: "com.example.jobs.DailyJob"
            - name: input-path
              value: "s3://raw/{{workflow.parameters.date}}"
            - name: output-path
              value: "s3://processed/{{workflow.parameters.date}}"
```

## Workflow Monitoring and Observability

### Prometheus Metrics

```yaml
# monitoring/argo-workflows-servicemonitor.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: argo-workflows
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - argo
  selector:
    matchLabels:
      app.kubernetes.io/name: argo-workflows
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics

---
# Alerting rules for workflow failures
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argo-workflow-alerts
  namespace: monitoring
spec:
  groups:
  - name: argo-workflows
    rules:
    - alert: ArgoWorkflowFailed
      expr: |
        argo_workflows_count{status="Failed"} > 0
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "Argo Workflow failed"
        description: "{{ $value }} workflows failed in namespace {{ $labels.namespace }}"

    - alert: ArgoWorkflowRunningTooLong
      expr: |
        argo_workflows_count{status="Running"} > 0
        and
        (time() - argo_workflow_info{status="Running"}) > 14400
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Argo Workflow running too long (>4 hours)"
        description: "Workflow {{ $labels.name }} has been running for more than 4 hours"

    - alert: ArgoCronWorkflowMissed
      expr: |
        argo_cronjob_last_schedule_time{} + 86400 < time()
      for: 1h
      labels:
        severity: critical
      annotations:
        summary: "Argo CronWorkflow has not run in 24 hours"
        description: "CronWorkflow {{ $labels.name }} last ran more than 24 hours ago"
```

### Workflow Audit and Debugging

```bash
# List recent workflows with status
argo list -n argo --status Failed --since 24h

# Get workflow details
argo get -n argo my-workflow-xyz

# View logs from all pods
argo logs -n argo my-workflow-xyz

# View logs from specific step
argo logs -n argo my-workflow-xyz -c main --step-name process-data

# Re-submit failed workflow from last checkpoint
argo resubmit -n argo my-workflow-xyz --memoized

# Retry from failed step (if retryStrategy configured)
argo retry -n argo my-workflow-xyz

# Archive workflow (keep but don't show in default list)
argo archive -n argo my-workflow-xyz

# Delete old workflows
argo delete -n argo --completed --older 7d
```

## Conclusion

Argo Workflows provides the infrastructure for expressing arbitrary directed acyclic graphs of containerized work with enterprise-grade features: artifact persistence, template reusability via WorkflowTemplate libraries, sophisticated parallelism controls, and native Kubernetes scheduling integration. The DAG execution model, combined with dynamic fan-out through `withParam` and concurrency control via semaphores, covers the full range of data engineering, ML pipeline, and operational automation use cases.

The template library pattern, implemented through `WorkflowTemplate` and `ClusterWorkflowTemplate` resources, enables platform teams to build standardized tooling that all teams can consume. This standardization reduces the cognitive load on workflow authors while ensuring consistent observability, error handling, and resource management across all workflows in the cluster.

Production success with Argo Workflows depends on proper resource requests to prevent workflow pods from being evicted mid-execution, exit handlers for notification and cleanup, appropriate TTL policies to prevent etcd pressure from workflow history accumulation, and Prometheus alerting that catches failed or stalled workflows before they impact SLAs.
