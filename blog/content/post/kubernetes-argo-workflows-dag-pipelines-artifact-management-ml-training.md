---
title: "Kubernetes Argo Workflows: DAG Pipelines, Artifact Management, and ML Training Orchestration"
date: 2031-07-31T00:00:00-05:00
draft: false
tags: ["Argo Workflows", "Kubernetes", "DAG", "ML Training", "Artifacts", "Pipeline", "Machine Learning", "MLOps"]
categories:
- Kubernetes
- MLOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to building production Argo Workflow pipelines on Kubernetes, covering DAG orchestration, artifact management, parameter passing, ML training orchestration, and operational best practices."
more_link: "yes"
url: "/kubernetes-argo-workflows-dag-pipelines-artifact-management-ml-training-orchestration/"
---

Argo Workflows is the most widely deployed workflow engine for Kubernetes, and for good reason: it treats workflows as first-class Kubernetes resources, runs each workflow step as a Pod, and integrates naturally with the rest of your Kubernetes toolchain. Whether you are orchestrating a multi-stage data processing pipeline, running distributed ML training jobs, or automating CI/CD steps that require GPU resources, Argo provides the primitives to build reliable, observable, and retryable workflows.

This guide covers the full spectrum of production Argo Workflow usage: DAG pipelines with complex dependency graphs, artifact management for large data, parameter passing between steps, GPU-aware ML training orchestration, and the operational concerns that determine whether your pipelines stay reliable at scale.

<!--more-->

# Kubernetes Argo Workflows: DAG Pipelines, Artifact Management, and ML Training Orchestration

## Installation

The quickest production-grade installation uses the official manifests or Helm chart.

```bash
# Namespace for Argo Workflows
kubectl create namespace argo

# Install using Helm (recommended for production)
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update

helm install argo-workflows argo/argo-workflows \
  --namespace argo \
  --set workflow.serviceAccount.create=true \
  --set workflow.rbac.create=true \
  --set controller.containerRuntimeExecutor=emissary \
  --set server.enabled=true \
  --set server.ingress.enabled=true \
  --set server.ingress.hosts[0]=argo.internal.example.com \
  --version 0.41.0
```

Configure artifact storage immediately after installation. All artifact operations require a configured artifact repository.

```yaml
# ConfigMap for artifact storage configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-controller-configmap
  namespace: argo
data:
  artifactRepository: |
    archiveLogs: true
    s3:
      bucket: your-argo-artifacts-bucket
      endpoint: s3.us-east-1.amazonaws.com
      region: us-east-1
      useSDKCreds: true
      encryptionOptions:
        enableEncryption: true
  # Default workflow TTL
  workflowDefaults: |
    metadata:
      labels:
        workflows.argoproj.io/type: default
    spec:
      ttlStrategy:
        secondsAfterCompletion: 86400   # 24 hours
        secondsAfterSuccess: 3600       # 1 hour
        secondsAfterFailure: 86400      # 24 hours
      podGC:
        strategy: OnWorkflowCompletion
  executor: |
    resources:
      requests:
        cpu: 100m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 256Mi
```

## Workflow Building Blocks

### Steps vs DAG Templates

Argo provides two paradigms for multi-step workflows. Steps execute sequentially (with optional parallelism within a step group), while DAGs express dependencies as a directed acyclic graph.

```yaml
# Steps-based workflow: good for linear pipelines
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: data-pipeline-
  namespace: argo
spec:
  entrypoint: main
  templates:
    - name: main
      steps:
        # Group 1: runs first
        - - name: ingest
            template: data-ingest
        # Group 2: runs after group 1
        - - name: validate
            template: data-validate
            arguments:
              parameters:
                - name: input-path
                  value: "{{steps.ingest.outputs.parameters.output-path}}"
        # Group 3: two parallel tasks after validate
        - - name: transform-a
            template: transform-features
            arguments:
              parameters:
                - name: feature-set
                  value: "categorical"
          - name: transform-b
            template: transform-features
            arguments:
              parameters:
                - name: feature-set
                  value: "numerical"
```

DAG templates express the same pipeline with explicit dependency declarations:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: ml-training-dag-
  namespace: argo
spec:
  entrypoint: ml-pipeline
  arguments:
    parameters:
      - name: dataset-path
        value: "s3://your-data-bucket/datasets/2031-07-31/"
      - name: model-type
        value: "xgboost"
      - name: epochs
        value: "100"

  templates:
    - name: ml-pipeline
      dag:
        tasks:
          - name: download-dataset
            template: s3-downloader
            arguments:
              parameters:
                - name: s3-path
                  value: "{{workflow.parameters.dataset-path}}"

          - name: validate-schema
            template: schema-validator
            dependencies: [download-dataset]
            arguments:
              artifacts:
                - name: dataset
                  from: "{{tasks.download-dataset.outputs.artifacts.dataset}}"

          - name: split-train-test
            template: data-splitter
            dependencies: [validate-schema]
            arguments:
              artifacts:
                - name: dataset
                  from: "{{tasks.download-dataset.outputs.artifacts.dataset}}"
              parameters:
                - name: test-ratio
                  value: "0.2"

          - name: feature-engineering-categorical
            template: feature-engineer
            dependencies: [split-train-test]
            arguments:
              artifacts:
                - name: train-data
                  from: "{{tasks.split-train-test.outputs.artifacts.train-data}}"
              parameters:
                - name: feature-type
                  value: "categorical"

          - name: feature-engineering-numerical
            template: feature-engineer
            dependencies: [split-train-test]
            arguments:
              artifacts:
                - name: train-data
                  from: "{{tasks.split-train-test.outputs.artifacts.train-data}}"
              parameters:
                - name: feature-type
                  value: "numerical"

          - name: train-model
            template: model-trainer
            dependencies:
              - feature-engineering-categorical
              - feature-engineering-numerical
            arguments:
              artifacts:
                - name: categorical-features
                  from: "{{tasks.feature-engineering-categorical.outputs.artifacts.features}}"
                - name: numerical-features
                  from: "{{tasks.feature-engineering-numerical.outputs.artifacts.features}}"
                - name: test-data
                  from: "{{tasks.split-train-test.outputs.artifacts.test-data}}"
              parameters:
                - name: model-type
                  value: "{{workflow.parameters.model-type}}"
                - name: epochs
                  value: "{{workflow.parameters.epochs}}"

          - name: evaluate-model
            template: model-evaluator
            dependencies: [train-model]
            arguments:
              artifacts:
                - name: model
                  from: "{{tasks.train-model.outputs.artifacts.model}}"
                - name: test-data
                  from: "{{tasks.split-train-test.outputs.artifacts.test-data}}"

          - name: register-model
            template: model-registry-push
            dependencies: [evaluate-model]
            when: "{{tasks.evaluate-model.outputs.parameters.accuracy}} > 0.90"
            arguments:
              artifacts:
                - name: model
                  from: "{{tasks.train-model.outputs.artifacts.model}}"
              parameters:
                - name: model-name
                  value: "{{workflow.parameters.model-type}}-classifier"
                - name: accuracy
                  value: "{{tasks.evaluate-model.outputs.parameters.accuracy}}"
```

## Artifact Management

Artifacts are the primary mechanism for passing large data (model files, datasets, feature matrices) between workflow steps.

### Defining Artifact Templates

```yaml
templates:
  - name: s3-downloader
    inputs:
      parameters:
        - name: s3-path
    outputs:
      artifacts:
        - name: dataset
          path: /tmp/dataset
          s3:
            bucket: your-data-bucket
            key: "{{inputs.parameters.s3-path}}"
    container:
      image: amazon/aws-cli:2.15.0
      command: [sh, -c]
      args:
        - |
          aws s3 sync "{{inputs.parameters.s3-path}}" /tmp/dataset
          echo "Downloaded $(du -sh /tmp/dataset | cut -f1) of data"
      resources:
        requests:
          cpu: 500m
          memory: 1Gi

  - name: data-splitter
    inputs:
      parameters:
        - name: test-ratio
      artifacts:
        - name: dataset
          path: /tmp/input/dataset
    outputs:
      artifacts:
        - name: train-data
          path: /tmp/output/train
        - name: test-data
          path: /tmp/output/test
    container:
      image: yourorg/data-pipeline:v3.2.1
      command: [python, /app/split_dataset.py]
      args:
        - --input=/tmp/input/dataset
        - --output-train=/tmp/output/train
        - --output-test=/tmp/output/test
        - --test-ratio={{inputs.parameters.test-ratio}}
      resources:
        requests:
          cpu: 2000m
          memory: 8Gi
        limits:
          cpu: 4000m
          memory: 16Gi
```

### Artifact Garbage Collection

Large pipelines accumulate artifacts. Configure garbage collection to manage costs.

```yaml
spec:
  artifactGC:
    strategy: OnWorkflowDeletion
    serviceAccountName: argo-artifact-gc
    podMetadata:
      labels:
        artifact-gc: "true"
    forceFinalizerRemoval: false
```

### Artifact Location Override Per Task

Override artifact location per task for cost optimization (use cheaper storage for intermediate artifacts):

```yaml
- name: expensive-preprocessing
  template: preprocessor
  arguments:
    artifacts:
      - name: raw-data
        from: "{{tasks.download.outputs.artifacts.raw-data}}"
  outputs:
    artifacts:
      - name: preprocessed
        path: /tmp/preprocessed
        # Use a specific prefix for intermediate artifacts
        s3:
          bucket: your-temp-artifacts-bucket
          key: "workflow/{{workflow.name}}/preprocessed"
```

## Parameter Passing and Outputs

### Output Parameters

Output parameters carry small values (file paths, model accuracy, processing statistics) between steps.

```yaml
  - name: model-evaluator
    inputs:
      artifacts:
        - name: model
          path: /tmp/model
        - name: test-data
          path: /tmp/test-data
    outputs:
      parameters:
        - name: accuracy
          valueFrom:
            path: /tmp/metrics/accuracy.txt
        - name: f1-score
          valueFrom:
            path: /tmp/metrics/f1.txt
        - name: eval-report-path
          valueFrom:
            path: /tmp/metrics/report-path.txt
    container:
      image: yourorg/model-eval:v1.5.0
      command: [python, /app/evaluate.py]
      args:
        - --model=/tmp/model
        - --test-data=/tmp/test-data
        - --metrics-dir=/tmp/metrics
```

### Global Parameters and Workflow Arguments

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: ml-training-template
  namespace: argo
spec:
  arguments:
    parameters:
      - name: dataset-version
        value: "latest"
      - name: model-type
        enum:
          - xgboost
          - lightgbm
          - neural-network
      - name: hyperparameters
        value: '{"learning_rate": 0.01, "max_depth": 6}'
    artifacts:
      - name: base-config
        s3:
          bucket: your-config-bucket
          key: ml/base-config.yaml
```

## ML Training Orchestration

### Distributed Training with GPU Resources

```yaml
  - name: distributed-gpu-trainer
    inputs:
      parameters:
        - name: num-workers
        - name: model-config
      artifacts:
        - name: train-data
          path: /tmp/train-data
    outputs:
      artifacts:
        - name: model
          path: /tmp/model-output
        - name: checkpoints
          path: /tmp/checkpoints
    resource:
      action: create
      setOwnerReference: true
      successCondition: status.replicaStatuses.Worker.succeeded == "{{inputs.parameters.num-workers}}"
      failureCondition: status.conditions.#(type=="Failed").status == "True"
      manifest: |
        apiVersion: kubeflow.org/v1
        kind: PyTorchJob
        metadata:
          generateName: pytorch-training-
          namespace: argo
        spec:
          pytorchReplicaSpecs:
            Master:
              replicas: 1
              restartPolicy: OnFailure
              template:
                spec:
                  containers:
                    - name: pytorch
                      image: yourorg/pytorch-trainer:v2.1.0
                      command: [python, train.py]
                      args:
                        - --config={{inputs.parameters.model-config}}
                        - --data=/tmp/train-data
                        - --output=/tmp/model-output
                        - --checkpoints=/tmp/checkpoints
                      resources:
                        limits:
                          nvidia.com/gpu: "1"
                        requests:
                          cpu: "4"
                          memory: "16Gi"
                      volumeMounts:
                        - name: train-data
                          mountPath: /tmp/train-data
                        - name: model-output
                          mountPath: /tmp/model-output
                  volumes:
                    - name: train-data
                      persistentVolumeClaim:
                        claimName: train-data-pvc
                    - name: model-output
                      persistentVolumeClaim:
                        claimName: model-output-pvc
            Worker:
              replicas: {{inputs.parameters.num-workers}}
              restartPolicy: OnFailure
              template:
                spec:
                  containers:
                    - name: pytorch
                      image: yourorg/pytorch-trainer:v2.1.0
                      resources:
                        limits:
                          nvidia.com/gpu: "2"
                        requests:
                          cpu: "8"
                          memory: "32Gi"
                  nodeSelector:
                    node.kubernetes.io/gpu-type: a100
                  tolerations:
                    - key: nvidia.com/gpu
                      operator: Exists
                      effect: NoSchedule
```

### Hyperparameter Sweep with Parallelism

```yaml
  - name: hyperparameter-sweep
    steps:
      - - name: generate-configs
          template: config-generator
          arguments:
            parameters:
              - name: param-grid
                value: |
                  {
                    "learning_rate": [0.001, 0.01, 0.1],
                    "max_depth": [3, 6, 9],
                    "n_estimators": [100, 200]
                  }

      - - name: parallel-training
          template: train-single-config
          arguments:
            parameters:
              - name: config
                value: "{{item}}"
          withParam: "{{steps.generate-configs.outputs.parameters.configs}}"
          # Limit concurrent training jobs
          parallelism: 4

      - - name: select-best
          template: best-model-selector
          arguments:
            parameters:
              - name: results
                value: "{{steps.parallel-training.outputs.parameters}}"

  - name: train-single-config
    inputs:
      parameters:
        - name: config
    outputs:
      parameters:
        - name: accuracy
          valueFrom:
            path: /tmp/accuracy.txt
        - name: config-used
          value: "{{inputs.parameters.config}}"
    container:
      image: yourorg/ml-trainer:v2.0.0
      command: [python, train.py]
      args:
        - --config={{inputs.parameters.config}}
        - --output-accuracy=/tmp/accuracy.txt
      resources:
        requests:
          cpu: 4000m
          memory: 16Gi
        limits:
          cpu: 8000m
          memory: 32Gi
```

## Retry and Error Handling

### Retry Strategies

```yaml
  - name: flaky-data-downloader
    retryStrategy:
      limit: "5"
      retryPolicy: "Always"
      backoff:
        duration: "10s"
        factor: "2"
        maxDuration: "5m"
      # Expression for conditional retry
      expression: "lastRetry.status == 'Error'"
    container:
      image: yourorg/downloader:v1.0.0
      command: [python, download.py]
```

### Exit Handlers and Notifications

```yaml
spec:
  entrypoint: main
  # onExit runs regardless of workflow success or failure
  onExit: pipeline-exit-handler
  templates:
    - name: main
      dag:
        tasks:
          - name: training
            template: train-model

    - name: pipeline-exit-handler
      steps:
        - - name: notify-success
            template: slack-notification
            when: "{{workflow.status}} == Succeeded"
            arguments:
              parameters:
                - name: message
                  value: "Training pipeline completed successfully"
                - name: color
                  value: "good"
          - name: notify-failure
            template: slack-notification
            when: "{{workflow.status}} != Succeeded"
            arguments:
              parameters:
                - name: message
                  value: "Training pipeline FAILED: {{workflow.status}}"
                - name: color
                  value: "danger"
          - name: cleanup-temp-resources
            template: resource-cleanup
            arguments:
              parameters:
                - name: workflow-name
                  value: "{{workflow.name}}"

    - name: slack-notification
      inputs:
        parameters:
          - name: message
          - name: color
      container:
        image: curlimages/curl:8.7.1
        command: [sh, -c]
        args:
          - |
            curl -X POST -H 'Content-type: application/json' \
              --data "{\"attachments\":[{\"color\":\"{{inputs.parameters.color}}\",\"text\":\"{{inputs.parameters.message}}\"}]}" \
              "$SLACK_WEBHOOK_URL"
        env:
          - name: SLACK_WEBHOOK_URL
            valueFrom:
              secretKeyRef:
                name: slack-credentials
                key: webhook-url
```

## WorkflowTemplates and Reuse

WorkflowTemplates allow you to define reusable building blocks that workflows reference rather than embed.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: data-pipeline-templates
  namespace: argo
spec:
  templates:
    - name: python-runner
      inputs:
        parameters:
          - name: script
          - name: memory
            value: "4Gi"
          - name: cpu
            value: "2000m"
        artifacts:
          - name: input-data
            path: /tmp/input
            optional: true
      outputs:
        artifacts:
          - name: output-data
            path: /tmp/output
            optional: true
      container:
        image: python:3.12-slim
        command: [sh, -c]
        args:
          - |
            pip install pandas numpy scikit-learn --quiet
            python -c "{{inputs.parameters.script}}"
        resources:
          requests:
            cpu: "{{inputs.parameters.cpu}}"
            memory: "{{inputs.parameters.memory}}"
          limits:
            cpu: "{{inputs.parameters.cpu}}"
            memory: "{{inputs.parameters.memory}}"

    - name: dbt-run
      inputs:
        parameters:
          - name: project-dir
          - name: target
            value: "prod"
          - name: select
            value: ""
      container:
        image: ghcr.io/dbt-labs/dbt-bigquery:1.8.0
        command: [sh, -c]
        args:
          - |
            cd {{inputs.parameters.project-dir}}
            dbt run --target={{inputs.parameters.target}} \
              {{#if inputs.parameters.select}}--select={{inputs.parameters.select}}{{/if}} \
              --no-partial-parse
        volumeMounts:
          - name: dbt-profiles
            mountPath: /root/.dbt
      volumes:
        - name: dbt-profiles
          secret:
            secretName: dbt-profiles
```

Referencing the template from another workflow:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: my-pipeline-
spec:
  entrypoint: pipeline
  templates:
    - name: pipeline
      dag:
        tasks:
          - name: transform
            templateRef:
              name: data-pipeline-templates
              template: python-runner
              clusterScope: false
            arguments:
              parameters:
                - name: script
                  value: |
                    import pandas as pd
                    df = pd.read_parquet('/tmp/input/data.parquet')
                    df['processed'] = df['value'] * 2
                    df.to_parquet('/tmp/output/data.parquet')
```

## CronWorkflows for Scheduled Pipelines

```yaml
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: nightly-training
  namespace: argo
spec:
  schedule: "0 2 * * *"
  timezone: "America/New_York"
  concurrencyPolicy: "Forbid"
  startingDeadlineSeconds: 3600
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 30
  workflowSpec:
    entrypoint: ml-pipeline
    arguments:
      parameters:
        - name: dataset-path
          value: "s3://your-data-bucket/datasets/{{= toDate(\"2006-01-02\", sprig.dateModify(\"-24h\", sprig.now())) }}"
    templates:
      - name: ml-pipeline
        templateRef:
          name: ml-training-template
          template: main
```

## RBAC and Security

```yaml
# Service account for workflow execution
apiVersion: v1
kind: ServiceAccount
metadata:
  name: workflow-executor
  namespace: argo
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workflow-executor
  namespace: argo
rules:
  # Required for workflow controller to manage pods
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, watch, patch]
  - apiGroups: [""]
    resources: [pods/log]
    verbs: [get, watch]
  - apiGroups: [""]
    resources: [pods/exec]
    verbs: [create]
  # Required for artifact management
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [get, watch, list]
  # Required for creating PyTorchJobs
  - apiGroups: ["kubeflow.org"]
    resources: [pytorchjobs]
    verbs: [create, get, list, watch, delete]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: workflow-executor
  namespace: argo
subjects:
  - kind: ServiceAccount
    name: workflow-executor
    namespace: argo
roleRef:
  kind: Role
  name: workflow-executor
  apiGroup: rbac.authorization.k8s.io
---
# Workflow submission permissions for ML team
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workflow-submitter
  namespace: argo
rules:
  - apiGroups: ["argoproj.io"]
    resources: [workflows, workflowtemplates, cronworkflows]
    verbs: [create, get, list, watch, update, delete]
  - apiGroups: ["argoproj.io"]
    resources: [workflowevents]
    verbs: [watch]
```

## Workflow Observability

```bash
# Watch workflow progress via CLI
argo watch ml-training-dag-abc123 -n argo

# View logs for a specific step
argo logs ml-training-dag-abc123 -n argo --node-field-selector displayName=train-model

# List recent workflows
argo list -n argo --running
argo list -n argo --failed --since 24h

# Get workflow details
argo get ml-training-dag-abc123 -n argo -o yaml

# Re-submit a failed workflow from the last failed node
argo retry ml-training-dag-abc123 -n argo

# Re-submit with different parameters
argo resubmit ml-training-dag-abc123 -n argo \
  --parameter epochs=200

# Delete completed workflows to reclaim storage
argo delete --completed -n argo --older 7d
```

### Prometheus Metrics

The Argo Workflows controller exports Prometheus metrics on port 9090.

```yaml
# Alert on long-running workflows
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: argo-workflow-alerts
  namespace: monitoring
spec:
  groups:
    - name: argo.workflows
      rules:
        - alert: ArgoWorkflowRunningTooLong
          expr: |
            (time() - argo_workflow_start_time{status="Running"}) > 14400
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Argo workflow {{ $labels.name }} has been running for >4 hours"

        - alert: ArgoWorkflowFailureRate
          expr: |
            rate(argo_workflows_count{status="Failed"}[1h]) > 0.1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Argo workflow failure rate exceeds 10%/hour"

        - alert: ArgoControllerDown
          expr: absent(up{job="argo-workflows-controller"})
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Argo Workflows controller is down"
```

## Resource Management and Cost Optimization

### Pod Priority and Resource Limits

```yaml
spec:
  priority: 100
  podSpecPatch: |
    topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            workflows.argoproj.io/workflow: "{{workflow.name}}"
  templates:
    - name: model-trainer
      container:
        resources:
          requests:
            cpu: "4"
            memory: "16Gi"
          limits:
            cpu: "8"
            memory: "32Gi"
        # Use spot/preemptible instances for long training jobs
      nodeSelector:
        node.kubernetes.io/lifecycle: spot
      tolerations:
        - key: kubernetes.azure.com/scalesetpriority
          value: spot
          operator: Equal
          effect: NoSchedule
```

### Parallelism Limits

```yaml
spec:
  # Global parallelism limit for this workflow
  parallelism: 10
  # Per-template parallelism
  templates:
    - name: parallel-preprocessing
      parallelism: 5
      dag:
        tasks:
          - name: process-shard
            template: shard-processor
            withItems:
              - shard-001
              - shard-002
              - shard-003
              - shard-004
              - shard-005
              - shard-006
              - shard-007
              - shard-008
            arguments:
              parameters:
                - name: shard-id
                  value: "{{item}}"
```

## Summary

Argo Workflows provides a robust Kubernetes-native execution engine for complex, multi-step pipelines. The patterns in this guide that have the most impact in production:

- Use DAG templates when steps have complex dependencies; use Steps for linear pipelines with clear stages
- Store large data as artifacts in S3, not as output parameters; parameters are limited to small values
- Apply retry strategies to every network-dependent step and any step that calls external APIs
- Use WorkflowTemplates for reusable building blocks across multiple workflows
- Set `ttlStrategy` and `podGC` on all workflows to prevent accumulation of completed pods and stored workflow data
- Configure proper RBAC to separate workflow submission from workflow execution permissions
- For ML training, prefer delegating to a Kubernetes operator (PyTorchJob, TFJob) rather than running training directly in a workflow pod — this gives you distributed training with proper process coordination
