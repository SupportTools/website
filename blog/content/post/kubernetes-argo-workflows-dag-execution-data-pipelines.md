---
title: "Kubernetes Argo Workflows: Directed Acyclic Graph Execution for Data Pipelines"
date: 2031-01-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Argo Workflows", "DAG", "Data Pipelines", "CI/CD", "Workflow Automation"]
categories:
- Kubernetes
- Data Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Argo Workflows covering Workflow templates vs ClusterWorkflowTemplates, DAG vs steps execution, artifact passing, resource templates for Kubernetes Jobs, retry strategies, and parallelism control for production data pipelines."
more_link: "yes"
url: "/kubernetes-argo-workflows-dag-execution-data-pipelines/"
---

Argo Workflows brings native Kubernetes-first workflow orchestration that scales from simple CI/CD pipelines to complex multi-stage data processing pipelines with dynamic fan-out, conditional branching, and cross-task artifact passing. Unlike general-purpose workflow engines bolted onto Kubernetes, Argo Workflows treats each task as a Kubernetes Pod, giving you native resource management, RBAC, secrets, and node affinity for every task. This guide covers the full workflow authoring model from basic steps through advanced DAG composition, artifact management, and production-ready reliability patterns.

<!--more-->

# Kubernetes Argo Workflows: Directed Acyclic Graph Execution for Data Pipelines

## Section 1: Architecture and Components

### Core Components

Argo Workflows runs as a Kubernetes operator:

```
┌─────────────────────────────────────────────────┐
│               Argo Workflows                    │
│                                                 │
│  ┌─────────────────┐  ┌───────────────────────┐ │
│  │  Workflow        │  │  Workflow             │ │
│  │  Controller      │  │  Server               │ │
│  │  (main operator) │  │  (API + UI)           │ │
│  └────────┬─────────┘  └───────────────────────┘ │
│           │                                     │
│           │ Creates/manages Pods                │
│           ▼                                     │
│  ┌─────────────────────────────────────────────┐ │
│  │  Workflow Pods (one per task)               │ │
│  │  - init container: argoexec (wait)          │ │
│  │  - main container: user workload            │ │
│  │  - sidecar: argoexec (executor)             │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Installation

```bash
# Install Argo Workflows
kubectl create namespace argo
kubectl apply -n argo -f https://github.com/argoproj/argo-workflows/releases/download/v3.6.0/install.yaml

# Configure artifact repository (S3-compatible)
kubectl create secret generic s3-artifact-config \
    --from-literal=accessKey="<aws-access-key-id>" \
    --from-literal=secretKey="<aws-secret-access-key>" \
    -n argo

# Apply ConfigMap for artifact storage
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-controller-configmap
  namespace: argo
data:
  artifactRepository: |
    s3:
      bucket: my-workflow-artifacts
      endpoint: s3.amazonaws.com
      accessKeySecret:
        name: s3-artifact-config
        key: accessKey
      secretKeySecret:
        name: s3-artifact-config
        key: secretKey
EOF
```

## Section 2: Workflow Templates vs ClusterWorkflowTemplates

### WorkflowTemplate (Namespace-Scoped)

WorkflowTemplates are reusable workflow definitions stored in a namespace:

```yaml
# Basic WorkflowTemplate with reusable templates
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: data-processing-templates
  namespace: data-pipeline
spec:
  templates:
    # Template 1: Download data from S3
    - name: download-data
      inputs:
        parameters:
          - name: s3-path
          - name: output-file
      container:
        image: amazon/aws-cli:latest
        command: [sh, -c]
        args:
          - |
            aws s3 cp {{inputs.parameters.s3-path}} {{inputs.parameters.output-file}}
        env:
          - name: AWS_DEFAULT_REGION
            value: us-east-1
        volumeMounts:
          - name: workdir
            mountPath: /work

    # Template 2: Data validation
    - name: validate-data
      inputs:
        parameters:
          - name: input-file
        artifacts:
          - name: data-file
            path: /work/data.csv
      container:
        image: registry.example.com/data-validator:v1.2.0
        command: [python, /app/validate.py]
        args:
          - --input={{inputs.parameters.input-file}}
          - --schema=/config/schema.json
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2
            memory: 2Gi

    # Template 3: Transform data
    - name: transform-data
      inputs:
        parameters:
          - name: transform-type
          - name: input-path
          - name: output-path
        artifacts:
          - name: input-data
            path: /input
      outputs:
        artifacts:
          - name: transformed-data
            path: /output
      container:
        image: registry.example.com/data-transformer:v2.0.0
        command: [python, /app/transform.py]
        args:
          - --type={{inputs.parameters.transform-type}}
          - --input=/input
          - --output=/output
        resources:
          requests:
            cpu: 2
            memory: 4Gi
          limits:
            cpu: 4
            memory: 8Gi
```

### ClusterWorkflowTemplate (Cluster-Scoped)

ClusterWorkflowTemplates are available across all namespaces, making them ideal for shared infrastructure templates:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ClusterWorkflowTemplate
metadata:
  name: common-utilities
spec:
  templates:
    # Notification template used by all pipelines
    - name: send-slack-notification
      inputs:
        parameters:
          - name: message
          - name: channel
            value: "#data-pipeline-alerts"
          - name: status
            value: "info"
      script:
        image: registry.example.com/notification-tool:latest
        command: [python]
        source: |
          import sys
          import json
          import os
          import requests

          msg = "{{inputs.parameters.message}}"
          channel = "{{inputs.parameters.channel}}"
          status = "{{inputs.parameters.status}}"

          color_map = {"info": "#36a64f", "warning": "#ff9900", "error": "#ff0000"}
          color = color_map.get(status, "#36a64f")

          # Webhook URL from secret - not hardcoded
          webhook_url = os.environ["SLACK_WEBHOOK_URL"]
          payload = {
              "channel": channel,
              "attachments": [{
                  "color": color,
                  "text": msg
              }]
          }
          response = requests.post(webhook_url, json=payload)
          if response.status_code != 200:
              print(f"Notification failed: {response.text}", file=sys.stderr)
              sys.exit(1)
        env:
          - name: SLACK_WEBHOOK_URL
            valueFrom:
              secretKeyRef:
                name: slack-webhook
                key: url

    # Database backup template
    - name: backup-postgres
      inputs:
        parameters:
          - name: database-name
          - name: backup-bucket
      container:
        image: registry.example.com/pg-backup:latest
        command: [sh, -c]
        args:
          - |
            pg_dump $DATABASE_URL \
                | gzip \
                | aws s3 cp - s3://{{inputs.parameters.backup-bucket}}/{{inputs.parameters.database-name}}-$(date +%Y%m%d-%H%M%S).sql.gz
        env:
          - name: DATABASE_URL
            valueFrom:
              secretKeyRef:
                name: postgres-credentials
                key: url

    # Generic container health check
    - name: health-check
      inputs:
        parameters:
          - name: url
          - name: expected-status
            value: "200"
          - name: retries
            value: "5"
      script:
        image: curlimages/curl:latest
        command: [sh]
        source: |
          RETRIES={{inputs.parameters.retries}}
          URL="{{inputs.parameters.url}}"
          EXPECTED={{inputs.parameters.expected-status}}

          for i in $(seq 1 $RETRIES); do
            STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL")
            if [ "$STATUS" = "$EXPECTED" ]; then
              echo "Health check passed (status: $STATUS)"
              exit 0
            fi
            echo "Attempt $i: got $STATUS, expected $EXPECTED. Waiting..."
            sleep 10
          done

          echo "Health check failed after $RETRIES attempts"
          exit 1
```

### Referencing Templates Across Resources

```yaml
# Workflow that uses both WorkflowTemplate and ClusterWorkflowTemplate
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: my-pipeline-run-001
  namespace: data-pipeline
spec:
  entrypoint: main
  templates:
    - name: main
      steps:
        - - name: process
            templateRef:
              name: data-processing-templates    # WorkflowTemplate
              template: validate-data

        - - name: notify
            templateRef:
              name: common-utilities              # ClusterWorkflowTemplate
              clusterScope: true
              template: send-slack-notification
            arguments:
              parameters:
                - name: message
                  value: "Pipeline completed"
```

## Section 3: DAG vs Steps Execution

### Steps Execution (Sequential with Parallel Stages)

Steps execute in sequence by default. Multiple templates in the same step (same list level) run in parallel.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: etl-pipeline
  namespace: data-pipeline
spec:
  entrypoint: etl-steps
  arguments:
    parameters:
      - name: data-date
        value: "2031-01-16"

  templates:
    - name: etl-steps
      steps:
        # Stage 1: Extract (parallel sources)
        - - name: extract-mysql
            template: extract-from-mysql
            arguments:
              parameters:
                - name: date
                  value: "{{workflow.parameters.data-date}}"

          - name: extract-postgres
            template: extract-from-postgres
            arguments:
              parameters:
                - name: date
                  value: "{{workflow.parameters.data-date}}"

          - name: extract-kafka
            template: extract-from-kafka
            arguments:
              parameters:
                - name: date
                  value: "{{workflow.parameters.data-date}}"

        # Stage 2: Transform (sequential, depends on all extracts)
        - - name: transform-data
            template: run-transform
            arguments:
              artifacts:
                - name: mysql-data
                  from: "{{steps.extract-mysql.outputs.artifacts.data}}"
                - name: postgres-data
                  from: "{{steps.extract-postgres.outputs.artifacts.data}}"
                - name: kafka-data
                  from: "{{steps.extract-kafka.outputs.artifacts.data}}"

        # Stage 3: Load + Quality Check (parallel)
        - - name: load-warehouse
            template: load-to-warehouse
            arguments:
              artifacts:
                - name: transformed-data
                  from: "{{steps.transform-data.outputs.artifacts.result}}"

          - name: quality-check
            template: run-data-quality
            arguments:
              artifacts:
                - name: transformed-data
                  from: "{{steps.transform-data.outputs.artifacts.result}}"

        # Stage 4: Notify
        - - name: notify-success
            template: send-notification
            arguments:
              parameters:
                - name: message
                  value: "ETL complete for {{workflow.parameters.data-date}}"
```

### DAG Execution

DAG templates explicitly declare dependencies between tasks, allowing the scheduler to maximize parallelism automatically.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: ml-training-pipeline
  namespace: ml-platform
spec:
  entrypoint: training-dag
  arguments:
    parameters:
      - name: model-version
        value: "v3.2.1"
      - name: dataset-path
        value: "s3://ml-datasets/training/2031-01"

  templates:
    - name: training-dag
      dag:
        tasks:
          # Data preparation (runs first, no dependencies)
          - name: download-dataset
            template: s3-download
            arguments:
              parameters:
                - name: s3-path
                  value: "{{workflow.parameters.dataset-path}}"

          - name: download-base-model
            template: s3-download
            arguments:
              parameters:
                - name: s3-path
                  value: "s3://ml-models/base/{{workflow.parameters.model-version}}"

          # Preprocessing (depends on dataset download)
          - name: preprocess-features
            template: feature-engineering
            dependencies: [download-dataset]
            arguments:
              artifacts:
                - name: raw-data
                  from: "{{tasks.download-dataset.outputs.artifacts.data}}"

          - name: preprocess-labels
            template: label-encoding
            dependencies: [download-dataset]
            arguments:
              artifacts:
                - name: raw-data
                  from: "{{tasks.download-dataset.outputs.artifacts.data}}"

          # Train (depends on both preprocessed features and base model)
          - name: train-model
            template: model-training
            dependencies: [preprocess-features, preprocess-labels, download-base-model]
            arguments:
              artifacts:
                - name: features
                  from: "{{tasks.preprocess-features.outputs.artifacts.features}}"
                - name: labels
                  from: "{{tasks.preprocess-labels.outputs.artifacts.labels}}"
                - name: base-model
                  from: "{{tasks.download-base-model.outputs.artifacts.data}}"
              parameters:
                - name: model-version
                  value: "{{workflow.parameters.model-version}}"

          # Parallel evaluation (both depend on trained model)
          - name: evaluate-validation
            template: model-evaluation
            dependencies: [train-model]
            arguments:
              parameters:
                - name: split
                  value: "validation"
              artifacts:
                - name: model
                  from: "{{tasks.train-model.outputs.artifacts.model}}"

          - name: evaluate-test
            template: model-evaluation
            dependencies: [train-model]
            arguments:
              parameters:
                - name: split
                  value: "test"
              artifacts:
                - name: model
                  from: "{{tasks.train-model.outputs.artifacts.model}}"

          # Register model (depends on both evaluations passing)
          - name: register-model
            template: model-registry-upload
            dependencies: [evaluate-validation, evaluate-test]
            when: >-
              "{{tasks.evaluate-validation.outputs.parameters.accuracy}}" > "0.95" &&
              "{{tasks.evaluate-test.outputs.parameters.accuracy}}" > "0.93"
            arguments:
              artifacts:
                - name: model
                  from: "{{tasks.train-model.outputs.artifacts.model}}"
              parameters:
                - name: model-version
                  value: "{{workflow.parameters.model-version}}"
                - name: validation-accuracy
                  value: "{{tasks.evaluate-validation.outputs.parameters.accuracy}}"
                - name: test-accuracy
                  value: "{{tasks.evaluate-test.outputs.parameters.accuracy}}"
```

## Section 4: Artifact Passing Between Tasks

### Artifact Types

Argo Workflows supports several artifact backends:

```yaml
# S3 artifact
- name: my-artifact
  s3:
    bucket: my-bucket
    key: path/to/artifact
    endpoint: s3.amazonaws.com

# GCS artifact
- name: my-artifact
  gcs:
    bucket: my-bucket
    key: path/to/artifact

# HTTP artifact (download only)
- name: my-artifact
  http:
    url: https://example.com/data.csv

# Git artifact (clone a repository)
- name: source-code
  git:
    repo: https://github.com/example/repo.git
    revision: main

# Raw artifact (inline value)
- name: config
  raw:
    data: |
      key: value
      other: setting
```

### Artifact Input/Output Patterns

```yaml
templates:
  - name: data-transformer
    inputs:
      artifacts:
        # Download artifact to /input/data.parquet before container starts
        - name: raw-data
          path: /input/data.parquet

    outputs:
      artifacts:
        # Upload /output/result.parquet to artifact store after container finishes
        - name: processed-data
          path: /output/result.parquet
          # Optional: specify S3 location (else uses workflow-level artifact repo)
          s3:
            key: "{{workflow.name}}/{{pod.name}}/result.parquet"

      parameters:
        # Capture stdout as an output parameter
        - name: row-count
          valueFrom:
            path: /output/metrics.txt
            # Or from stdout/stderr:
            # stdout: true

    container:
      image: registry.example.com/data-processor:latest
      command: [python, /app/process.py]
      args:
        - --input=/input/data.parquet
        - --output=/output/result.parquet
        - --metrics=/output/metrics.txt
```

### Archive and Compression

```yaml
outputs:
  artifacts:
    - name: large-dataset
      path: /output/data-directory
      archive:
        none: {}     # No compression (default for directories: tar)
      # Or:
      archive:
        tar:
          compressionLevel: 6  # 0-9
      # Or skip archiving for a single file:
      archive:
        none: {}
```

## Section 5: Resource Templates for Kubernetes Jobs

Resource templates allow workflows to create and manage arbitrary Kubernetes resources:

```yaml
templates:
  - name: run-spark-job
    inputs:
      parameters:
        - name: input-path
        - name: output-path
    resource:
      action: create       # create, apply, delete, replace
      # Wait for the resource to reach a specific condition
      successCondition: status.applicationState.state == COMPLETED
      failureCondition: status.applicationState.state == FAILED
      manifest: |
        apiVersion: sparkoperator.k8s.io/v1beta2
        kind: SparkApplication
        metadata:
          name: spark-etl-{{workflow.name}}
          namespace: spark
        spec:
          type: Python
          pythonVersion: "3"
          mode: cluster
          image: registry.example.com/spark-etl:latest
          imagePullPolicy: Always
          mainApplicationFile: local:///app/etl.py
          sparkVersion: "3.5.0"
          arguments:
            - --input={{inputs.parameters.input-path}}
            - --output={{inputs.parameters.output-path}}
          driver:
            cores: 2
            memory: "2g"
            labels:
              version: 3.5.0
            serviceAccount: spark
          executor:
            cores: 4
            instances: 10
            memory: "4g"
            labels:
              version: 3.5.0
          dynamicAllocation:
            enabled: true
            initialExecutors: 2
            minExecutors: 1
            maxExecutors: 20

  - name: run-kubernetes-job
    inputs:
      parameters:
        - name: job-name
        - name: image
        - name: command
    resource:
      action: create
      successCondition: status.succeeded > 0
      failureCondition: status.failed > 3
      manifest: |
        apiVersion: batch/v1
        kind: Job
        metadata:
          name: {{inputs.parameters.job-name}}-{{workflow.name}}
        spec:
          template:
            spec:
              containers:
                - name: job
                  image: {{inputs.parameters.image}}
                  command: [sh, -c]
                  args: ["{{inputs.parameters.command}}"]
                  resources:
                    requests:
                      cpu: 2
                      memory: 4Gi
              restartPolicy: Never
          backoffLimit: 3
```

## Section 6: Retry Strategies

### Template-Level Retry

```yaml
templates:
  - name: flaky-api-call
    retryStrategy:
      limit: "5"                   # Maximum retry count
      retryPolicy: "Always"         # Always | OnFailure | OnError | OnTransientError
      backoff:
        duration: "10s"            # Initial backoff duration
        factor: "2"                # Multiply by this each retry
        maxDuration: "5m"          # Maximum backoff duration
      expression: "lastRetry.exitCode != 137"  # Only retry if not OOM killed
    container:
      image: registry.example.com/api-client:latest
      command: [python, /app/api_call.py]
```

### Workflow-Level Retry Policy

```yaml
spec:
  # Retry the entire workflow on failure
  retryStrategy:
    limit: "3"
    retryPolicy: "OnFailure"
    expression: >-
      lastRetry.status == "Error" ||
      (lastRetry.status == "Failed" && int(lastRetry.exitCode) == 1)
```

### Conditional Retry with Exit Code

```yaml
templates:
  - name: database-migration
    retryStrategy:
      limit: "10"
      retryPolicy: "OnError"
      backoff:
        duration: "30s"
        factor: "1.5"
        maxDuration: "10m"
      expression: >-
        lastRetry.exitCode == "1" &&
        !asInt(lastRetry.retries) > 5
    container:
      image: registry.example.com/db-migrate:latest
      command: [sh, -c]
      args:
        - |
          # Exit code 1: transient error, retry
          # Exit code 2: permanent error, don't retry
          # Exit code 3: migration already applied, skip (success)
          python /app/migrate.py
```

## Section 7: Parallelism Control

### Workflow-Level Parallelism

```yaml
spec:
  # Maximum number of concurrent pods in this workflow
  parallelism: 10

  # Limit concurrent workflow executions globally
  # (Set in workflow controller configmap)
  # parallelism: 20
```

### Template-Level Parallelism for Loops

```yaml
templates:
  - name: process-all-files
    inputs:
      parameters:
        - name: file-list  # JSON array: ["file1.csv", "file2.csv", ...]
    steps:
      - - name: process-file
          template: process-single-file
          arguments:
            parameters:
              - name: filename
                value: "{{item}}"
          withParam: "{{inputs.parameters.file-list}}"  # Fan-out over list

  # Or with a fixed list (withItems):
  - name: run-regional-jobs
    dag:
      tasks:
        - name: process-region
          template: regional-processor
          arguments:
            parameters:
              - name: region
                value: "{{item.region}}"
              - name: bucket
                value: "{{item.bucket}}"
          withItems:
            - {region: us-east-1, bucket: data-us-east}
            - {region: eu-west-1, bucket: data-eu-west}
            - {region: ap-southeast-1, bucket: data-ap}
```

### Synchronization - Mutexes and Semaphores

Argo Workflows supports workflow-level synchronization to prevent resource exhaustion:

```yaml
# Define synchronization in ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: argo
data:
  # Semaphore: allow at most 3 concurrent database operations
  workflow-db-semaphore: "3"

---
# Use semaphore in workflow
apiVersion: argoproj.io/v1alpha1
kind: Workflow
spec:
  synchronization:
    semaphore:
      configMapKeyRef:
        name: my-config
        key: workflow-db-semaphore

---
# Use mutex at template level to prevent concurrent access to shared resource
templates:
  - name: update-registry
    synchronization:
      mutex:
        name: registry-lock  # Only one task with this lock name runs at a time
    container:
      image: registry.example.com/registry-updater:latest
```

## Section 8: Dynamic Fan-Out with withParam

The most powerful Argo Workflows feature for data pipelines is dynamic fan-out: generating the list of work items from a previous task's output.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: dynamic-processing-pipeline
spec:
  entrypoint: dynamic-pipeline

  templates:
    - name: dynamic-pipeline
      dag:
        tasks:
          # Step 1: Discover work items
          - name: discover-partitions
            template: list-s3-partitions
            arguments:
              parameters:
                - name: s3-prefix
                  value: "s3://data-lake/raw/2031-01-16/"

          # Step 2: Dynamic fan-out based on discovered partitions
          - name: process-partition
            dependencies: [discover-partitions]
            template: process-single-partition
            arguments:
              parameters:
                - name: partition-path
                  value: "{{item}}"
            # withParam: takes JSON array from previous task's output
            withParam: "{{tasks.discover-partitions.outputs.result}}"

          # Step 3: Aggregate all processed partitions
          - name: merge-results
            dependencies: [process-partition]
            template: merge-partitions
            arguments:
              parameters:
                - name: partition-count
                  value: "{{tasks.process-partition.outputs.parameters.count}}"

    - name: list-s3-partitions
      inputs:
        parameters:
          - name: s3-prefix
      script:
        image: amazon/aws-cli:latest
        command: [sh]
        source: |
          # Output JSON array of partition paths
          aws s3 ls "{{inputs.parameters.s3-prefix}}" --recursive \
            | awk '{print $4}' \
            | grep '\.parquet$' \
            | python3 -c "import sys,json; print(json.dumps([l.strip() for l in sys.stdin]))"
      # The script's stdout becomes outputs.result
```

## Section 9: Exit Handlers and Cleanup

```yaml
spec:
  entrypoint: main
  onExit: cleanup-handler  # Always runs, regardless of workflow status

  templates:
    - name: main
      dag:
        tasks:
          - name: process
            template: data-processor

    # Runs after workflow completes (success or failure)
    - name: cleanup-handler
      steps:
        - - name: check-status
            template: notify-result

        - - name: cleanup-temp-files
            template: s3-cleanup
            when: "{{workflow.status}} != Running"

    - name: notify-result
      script:
        image: registry.example.com/notifier:latest
        command: [python]
        source: |
          status = "{{workflow.status}}"      # Succeeded, Failed, Error
          name = "{{workflow.name}}"
          duration = "{{workflow.duration}}"

          print(f"Workflow {name} finished with status: {status}")
          print(f"Duration: {duration}s")

          if status != "Succeeded":
              # Send alert
              import sys
              sys.exit(1)
```

## Section 10: Production Workflow Configuration

### Resource Quotas for Workflows

```yaml
# Limit workflow resource usage per namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: argo-workflow-quota
  namespace: data-pipeline
spec:
  hard:
    pods: "100"
    requests.cpu: "50"
    requests.memory: "200Gi"
    limits.cpu: "200"
    limits.memory: "800Gi"
    count/workflows.argoproj.io: "20"  # Max concurrent workflows
```

### Workflow Archive and Cleanup

```yaml
# workflow-controller-configmap
data:
  # Archive completed workflows to PostgreSQL
  persistence: |
    connectionPool:
      maxIdleConns: 100
      maxOpenConns: 0
      connMaxLifetime: 0s
    nodeStatusOffLoad: true
    archive: true
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

  # Automatic cleanup policy
  retentionPolicy: |
    completed: 10
    failed: 3
    errored: 3
```

### RBAC for Workflow Submission

```yaml
# Role for data engineers to submit and monitor workflows
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workflow-submitter
  namespace: data-pipeline
rules:
  - apiGroups: ["argoproj.io"]
    resources: ["workflows", "workflowtemplates"]
    verbs: ["create", "get", "list", "watch", "update", "patch", "delete"]
  - apiGroups: ["argoproj.io"]
    resources: ["clusterworkflowtemplates"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: workflow-submitters
  namespace: data-pipeline
subjects:
  - kind: Group
    name: data-engineers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: workflow-submitter
  apiGroup: rbac.authorization.k8s.io
```

### Monitoring Workflow Health

```promql
# Argo Workflows Prometheus metrics

# Workflows by status
sum(argo_workflows_count) by (status)

# Average workflow duration by template
avg(argo_workflow_info{status="Succeeded"}) by (workflow_template)

# Pod creation errors (workflow tasks failing to start)
rate(argo_pods_total{phase="Failed"}[5m])

# Queue depth (pending workflows)
argo_workflows_count{status="Pending"}

# Alert: workflow failures
sum(rate(argo_workflow_status_phase{status="Failed"}[1h])) > 5
```

Argo Workflows provides a powerful, Kubernetes-native foundation for data pipeline orchestration. The combination of DAG-based task dependency management, dynamic fan-out via `withParam`, and native Kubernetes resource integration (for Spark, Flink, and other operators) makes it the choice for teams building complex, scalable data platforms on Kubernetes.
