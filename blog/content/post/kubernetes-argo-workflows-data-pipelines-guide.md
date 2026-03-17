---
title: "Argo Workflows: Building Data Pipelines and ML Training Jobs on Kubernetes"
date: 2028-12-06T00:00:00-05:00
draft: false
tags: ["Argo Workflows", "Kubernetes", "Data Pipelines", "AI/ML", "CI/CD"]
categories:
- Argo Workflows
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for Argo Workflows: DAG templates, S3 artifact management, CronWorkflows, Argo Events integration, Python SDK submission, retry strategies, and monitoring for data pipelines and ML training on Kubernetes."
more_link: "yes"
url: "/kubernetes-argo-workflows-data-pipelines-guide/"
---

Argo Workflows is a Kubernetes-native workflow engine that executes directed acyclic graphs (DAGs) of containerized tasks. Each step in a workflow is a pod, making it inherently scalable and observable. For data engineering and machine learning teams, Argo Workflows replaces Airflow's operator complexity with simple container definitions, provides built-in artifact management, and integrates natively with Kubernetes RBAC, resource quotas, and node scheduling.

This guide covers the core template types, artifact management with S3, CronWorkflows for scheduled pipelines, Argo Events for event-driven triggering, the Python SDK for programmatic submission, and production operational patterns.

<!--more-->

# Argo Workflows: Data Pipelines and ML Training

## Section 1: Installation and Configuration

```bash
# Install Argo Workflows
kubectl create namespace argo
kubectl apply -n argo \
  -f https://github.com/argoproj/argo-workflows/releases/download/v3.5.5/install.yaml

# Wait for pods
kubectl wait --for=condition=Ready pods --all -n argo --timeout=120s

# Install CLI
curl -sLO https://github.com/argoproj/argo-workflows/releases/download/v3.5.5/argo-linux-amd64.gz
gunzip argo-linux-amd64.gz
chmod +x argo-linux-amd64
mv argo-linux-amd64 /usr/local/bin/argo

# Port-forward UI
kubectl -n argo port-forward deployment/argo-server 2746:2746 &
# Open http://localhost:2746
```

Configure artifact repository (MinIO or S3):

```yaml
# argo-artifact-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: artifact-repositories
  namespace: argo
  annotations:
    workflows.argoproj.io/default-artifact-repository: default
data:
  default: |
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
---
apiVersion: v1
kind: Secret
metadata:
  name: argo-minio-creds
  namespace: argo
type: Opaque
stringData:
  accessKey: "minioadmin"
  secretKey: "minioadmin123"
```

## Section 2: Basic Template Types

### Container template

```yaml
# simple-hello.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: hello-
  namespace: argo
spec:
  entrypoint: hello
  templates:
    - name: hello
      container:
        image: alpine:3.19
        command: [sh, -c]
        args: ["echo 'Hello, Argo!'; date; hostname"]
        resources:
          requests:
            cpu: "100m"
            memory: "64Mi"
```

```bash
argo submit --watch simple-hello.yaml
```

### Steps template — sequential and parallel

```yaml
# steps-pipeline.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: steps-pipeline-
  namespace: argo
spec:
  entrypoint: main
  templates:
    - name: main
      steps:
        # Each list item runs sequentially
        - - name: extract
            template: extract-data
        - - name: transform-a
            template: transform
            arguments:
              parameters:
                - name: dataset
                  value: "dataset-a"
          - name: transform-b        # runs in parallel with transform-a
            template: transform
            arguments:
              parameters:
                - name: dataset
                  value: "dataset-b"
        - - name: load
            template: load-data

    - name: extract-data
      container:
        image: python:3.12-slim
        command: [python, -c]
        args:
          - |
            import json, time
            data = {"records": list(range(1000)), "timestamp": time.time()}
            with open("/tmp/extracted.json", "w") as f:
                json.dump(data, f)
            print(f"Extracted {len(data['records'])} records")
      outputs:
        artifacts:
          - name: extracted
            path: /tmp/extracted.json

    - name: transform
      inputs:
        parameters:
          - name: dataset
        artifacts:
          - name: extracted
            path: /tmp/input.json
      container:
        image: python:3.12-slim
        command: [python, -c]
        args:
          - |
            import json
            dataset = "{{inputs.parameters.dataset}}"
            with open("/tmp/input.json") as f:
                data = json.load(f)
            transformed = [r * 2 for r in data["records"]]
            with open(f"/tmp/{dataset}-output.json", "w") as f:
                json.dump({"dataset": dataset, "records": transformed}, f)
            print(f"Transformed {len(transformed)} records for {dataset}")
      outputs:
        artifacts:
          - name: transformed
            path: /tmp/{{inputs.parameters.dataset}}-output.json

    - name: load-data
      container:
        image: alpine:3.19
        command: [sh, -c]
        args: ["echo 'Loading data to warehouse...'; sleep 2; echo 'Done'"]
```

## Section 3: DAG Template for Complex Pipelines

DAG templates express dependency graphs directly rather than sequentially. Model artifacts are saved in MLflow-compatible format (ONNX or PyTorch `.pt`) via S3, not as raw serialized objects:

```yaml
# ml-training-dag.yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: ml-training-
  namespace: argo
spec:
  entrypoint: training-pipeline
  arguments:
    parameters:
      - name: model-version
        value: "v1.2.0"
      - name: dataset-date
        value: "2028-12-01"
      - name: learning-rate
        value: "0.001"

  templates:
    - name: training-pipeline
      dag:
        tasks:
          - name: validate-data
            template: validate
            arguments:
              parameters:
                - name: date
                  value: "{{workflow.parameters.dataset-date}}"

          - name: feature-engineering
            template: feature-eng
            dependencies: [validate-data]
            arguments:
              artifacts:
                - name: raw-data
                  from: "{{tasks.validate-data.outputs.artifacts.validated-data}}"

          - name: train-model-cpu
            template: train
            dependencies: [feature-engineering]
            arguments:
              parameters:
                - name: accelerator
                  value: "cpu"
                - name: learning-rate
                  value: "{{workflow.parameters.learning-rate}}"
              artifacts:
                - name: features
                  from: "{{tasks.feature-engineering.outputs.artifacts.features}}"

          - name: train-model-gpu
            template: train-gpu
            dependencies: [feature-engineering]
            arguments:
              parameters:
                - name: learning-rate
                  value: "{{workflow.parameters.learning-rate}}"
              artifacts:
                - name: features
                  from: "{{tasks.feature-engineering.outputs.artifacts.features}}"

          - name: evaluate
            template: evaluate-models
            dependencies: [train-model-cpu, train-model-gpu]
            arguments:
              artifacts:
                - name: cpu-model
                  from: "{{tasks.train-model-cpu.outputs.artifacts.model}}"
                - name: gpu-model
                  from: "{{tasks.train-model-gpu.outputs.artifacts.model}}"

          - name: register-model
            template: register
            dependencies: [evaluate]
            when: "{{tasks.evaluate.outputs.parameters.best-accuracy}} > 0.95"
            arguments:
              parameters:
                - name: version
                  value: "{{workflow.parameters.model-version}}"
              artifacts:
                - name: model
                  from: "{{tasks.evaluate.outputs.artifacts.best-model}}"

    - name: validate
      inputs:
        parameters:
          - name: date
      container:
        image: ghcr.io/example/ml-tools:latest
        command: [python, /app/validate.py]
        env:
          - name: DATASET_DATE
            value: "{{inputs.parameters.date}}"
          - name: DATA_SOURCE
            value: "s3://production-data/training/{{inputs.parameters.date}}"
      outputs:
        artifacts:
          - name: validated-data
            path: /tmp/validated.parquet
            s3:
              key: "artifacts/{{workflow.name}}/validated.parquet"
      retryStrategy:
        limit: "3"
        retryPolicy: Always
        backoff:
          duration: "10s"
          factor: "2"
          maxDuration: "5m"

    - name: feature-eng
      inputs:
        artifacts:
          - name: raw-data
            path: /tmp/raw.parquet
      container:
        image: ghcr.io/example/ml-tools:latest
        command: [python, /app/feature_engineering.py]
        resources:
          requests:
            cpu: "2"
            memory: "4Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
      outputs:
        artifacts:
          - name: features
            path: /tmp/features.parquet

    - name: train
      inputs:
        parameters:
          - name: accelerator
          - name: learning-rate
        artifacts:
          - name: features
            path: /tmp/features.parquet
      container:
        image: ghcr.io/example/ml-trainer:latest
        command: [python, /app/train.py]
        env:
          - name: LEARNING_RATE
            value: "{{inputs.parameters.learning-rate}}"
          - name: ACCELERATOR
            value: "{{inputs.parameters.accelerator}}"
          - name: MODEL_FORMAT
            value: "onnx"  # use ONNX for portable, safe model artifacts
        resources:
          requests:
            cpu: "4"
            memory: "8Gi"
          limits:
            cpu: "8"
            memory: "16Gi"
      outputs:
        artifacts:
          # Model saved as ONNX — safe, portable, no code execution on load
          - name: model
            path: /tmp/model.onnx
      retryStrategy:
        limit: "2"
        retryPolicy: OnError

    - name: train-gpu
      inputs:
        parameters:
          - name: learning-rate
        artifacts:
          - name: features
            path: /tmp/features.parquet
      container:
        image: ghcr.io/example/ml-trainer-gpu:latest
        command: [python, /app/train.py]
        env:
          - name: LEARNING_RATE
            value: "{{inputs.parameters.learning-rate}}"
          - name: MODEL_FORMAT
            value: "onnx"
        resources:
          requests:
            cpu: "4"
            memory: "16Gi"
            nvidia.com/gpu: "1"
          limits:
            cpu: "8"
            memory: "32Gi"
            nvidia.com/gpu: "1"
      nodeSelector:
        accelerator: nvidia-a100
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      outputs:
        artifacts:
          - name: model
            path: /tmp/model.onnx

    - name: evaluate-models
      inputs:
        artifacts:
          - name: cpu-model
            path: /tmp/cpu-model.onnx
          - name: gpu-model
            path: /tmp/gpu-model.onnx
      script:
        image: ghcr.io/example/ml-tools:latest
        command: [python]
        source: |
          import json, onnxruntime, numpy as np, shutil

          # Load ONNX models via onnxruntime (no arbitrary code execution)
          cpu_sess = onnxruntime.InferenceSession("/tmp/cpu-model.onnx",
              providers=["CPUExecutionProvider"])
          gpu_sess = onnxruntime.InferenceSession("/tmp/gpu-model.onnx",
              providers=["CPUExecutionProvider"])

          # Evaluate on held-out test set (abbreviated)
          test_input = np.random.randn(100, 32).astype(np.float32)
          cpu_out = cpu_sess.run(None, {"input": test_input})
          gpu_out = gpu_sess.run(None, {"input": test_input})

          cpu_accuracy = float(np.mean(np.argmax(cpu_out[0], axis=1) == 0))
          gpu_accuracy = float(np.mean(np.argmax(gpu_out[0], axis=1) == 0))

          best = "gpu" if gpu_accuracy > cpu_accuracy else "cpu"
          best_accuracy = max(cpu_accuracy, gpu_accuracy)
          print(json.dumps({"best": best, "accuracy": best_accuracy}))

          with open("/tmp/best-accuracy.txt", "w") as f:
              f.write(str(best_accuracy))
          shutil.copy(f"/tmp/{best}-model.onnx", "/tmp/best-model.onnx")
      outputs:
        parameters:
          - name: best-accuracy
            valueFrom:
              path: /tmp/best-accuracy.txt
        artifacts:
          - name: best-model
            path: /tmp/best-model.onnx

    - name: register
      inputs:
        parameters:
          - name: version
        artifacts:
          - name: model
            path: /tmp/model.onnx
      container:
        image: ghcr.io/example/ml-tools:latest
        command: [python, /app/register.py]
        env:
          - name: MODEL_VERSION
            value: "{{inputs.parameters.version}}"
          - name: MLFLOW_TRACKING_URI
            value: http://mlflow.mlops.svc.cluster.local:5000
```

## Section 4: CronWorkflow for Scheduled Pipelines

```yaml
# daily-etl-cron.yaml
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: daily-etl
  namespace: argo
spec:
  schedule: "0 2 * * *"          # Run at 2:00 AM UTC every day
  timezone: "America/New_York"
  concurrencyPolicy: Forbid       # Skip if previous run is still active
  startingDeadlineSeconds: 1800   # Skip if more than 30m late
  successfulJobsHistoryLimit: 10
  failedJobsHistoryLimit: 5
  workflowSpec:
    entrypoint: etl-pipeline
    arguments:
      parameters:
        - name: run-date
          value: "{{= toDate('2006-01-02', 'now') }}"
    templates:
      - name: etl-pipeline
        steps:
          - - name: extract
              template: extract
          - - name: transform
              template: transform
          - - name: load
              template: load

      - name: extract
        container:
          image: ghcr.io/example/etl:latest
          command: [python, extract.py]
          env:
            - name: RUN_DATE
              value: "{{workflow.parameters.run-date}}"
        outputs:
          artifacts:
            - name: raw-data
              path: /tmp/raw.parquet

      - name: transform
        inputs:
          artifacts:
            - name: raw-data
              path: /tmp/raw.parquet
        container:
          image: ghcr.io/example/etl:latest
          command: [python, transform.py]
        outputs:
          artifacts:
            - name: transformed
              path: /tmp/transformed.parquet

      - name: load
        inputs:
          artifacts:
            - name: transformed
              path: /tmp/transformed.parquet
        container:
          image: ghcr.io/example/etl:latest
          command: [python, load.py]
          env:
            - name: WAREHOUSE_DSN
              valueFrom:
                secretKeyRef:
                  name: warehouse-creds
                  key: dsn
```

```bash
# List CronWorkflows and their next runs
argo cron list -n argo

# Manually trigger a CronWorkflow
argo cron trigger daily-etl -n argo

# Suspend a CronWorkflow
argo cron suspend daily-etl -n argo

# Resume
argo cron resume daily-etl -n argo
```

## Section 5: Argo Events Integration

Argo Events triggers workflows based on external events (webhook, S3 upload, Kafka message, etc.).

```yaml
# event-source-s3.yaml — triggers when a new file lands in S3
apiVersion: argoproj.io/v1alpha1
kind: EventSource
metadata:
  name: s3-new-data
  namespace: argo-events
spec:
  s3:
    new-dataset:
      bucket:
        name: incoming-data
      endpoint: s3.us-east-1.amazonaws.com
      events:
        - s3:ObjectCreated:Put
      filter:
        prefix: "datasets/"
        suffix: ".parquet"
      accessKey:
        name: s3-creds
        key: accessKey
      secretKey:
        name: s3-creds
        key: secretKey
```

```yaml
# sensor-trigger-workflow.yaml — sensor that maps events to workflow submissions
apiVersion: argoproj.io/v1alpha1
kind: Sensor
metadata:
  name: s3-training-trigger
  namespace: argo-events
spec:
  dependencies:
    - name: s3-event
      eventSourceName: s3-new-data
      eventName: new-dataset
  triggers:
    - template:
        name: trigger-training
        argoWorkflow:
          operation: submit
          source:
            resource:
              apiVersion: argoproj.io/v1alpha1
              kind: Workflow
              metadata:
                generateName: triggered-training-
                namespace: argo
              spec:
                workflowTemplateRef:
                  name: ml-training-template
                arguments:
                  parameters:
                    - name: input-path
                      value: "{{.Input.body.Records.0.s3.object.key}}"
```

## Section 6: Python SDK for Programmatic Submission

```python
# submit_workflow.py
from argo_workflows.api_client import ApiClient, Configuration
from argo_workflows.apis import WorkflowServiceApi
from argo_workflows.models import (
    IoArgoprojWorkflowV1alpha1Workflow,
    IoArgoprojWorkflowV1alpha1WorkflowSpec,
    IoArgoprojWorkflowV1alpha1Arguments,
    IoArgoprojWorkflowV1alpha1Parameter,
    ObjectMeta,
)
import time
import urllib3

urllib3.disable_warnings()


def submit_training_workflow(
    model_version: str,
    dataset_date: str,
    learning_rate: float = 0.001,
) -> str:
    """Submit an ML training workflow and return the workflow name."""
    config = Configuration(host="https://localhost:2746")
    config.verify_ssl = False  # use proper certs in production

    with ApiClient(config) as api_client:
        api = WorkflowServiceApi(api_client)

        workflow = IoArgoprojWorkflowV1alpha1Workflow(
            metadata=ObjectMeta(
                generate_name="ml-training-",
                namespace="argo",
            ),
            spec=IoArgoprojWorkflowV1alpha1WorkflowSpec(
                workflow_template_ref={
                    "name": "ml-training-template",
                },
                arguments=IoArgoprojWorkflowV1alpha1Arguments(
                    parameters=[
                        IoArgoprojWorkflowV1alpha1Parameter(
                            name="model-version",
                            value=model_version,
                        ),
                        IoArgoprojWorkflowV1alpha1Parameter(
                            name="dataset-date",
                            value=dataset_date,
                        ),
                        IoArgoprojWorkflowV1alpha1Parameter(
                            name="learning-rate",
                            value=str(learning_rate),
                        ),
                    ]
                ),
            ),
        )

        result = api.submit_workflow(
            namespace="argo",
            body={"workflow": workflow, "serverDryRun": False},
        )
        print(f"Submitted workflow: {result.metadata.name}")
        return result.metadata.name


def wait_for_completion(workflow_name: str, timeout_seconds: int = 3600) -> str:
    """Poll a workflow until it completes or times out. Returns final phase."""
    config = Configuration(host="https://localhost:2746")
    config.verify_ssl = False

    with ApiClient(config) as api_client:
        api = WorkflowServiceApi(api_client)
        deadline = time.time() + timeout_seconds

        while time.time() < deadline:
            wf = api.get_workflow(namespace="argo", name=workflow_name)
            phase = wf.status.phase if wf.status else "Pending"
            print(f"  {workflow_name}: {phase}")

            if phase in ("Succeeded", "Failed", "Error"):
                return phase

            time.sleep(30)

        return "Timeout"


if __name__ == "__main__":
    name = submit_training_workflow(
        model_version="v2.0.0",
        dataset_date="2028-12-06",
        learning_rate=0.0005,
    )
    final_phase = wait_for_completion(name)
    print(f"Workflow {name} completed with phase: {final_phase}")
    if final_phase != "Succeeded":
        raise SystemExit(1)
```

## Section 7: WorkflowTemplate for Reusable Templates

```yaml
# workflow-template-etl.yaml
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: ml-training-template
  namespace: argo
spec:
  entrypoint: training-pipeline
  arguments:
    parameters:
      - name: model-version
        value: "v1.0.0"
      - name: dataset-date
        value: "2028-12-01"
      - name: learning-rate
        value: "0.001"
  templates:
    - name: training-pipeline
      dag:
        tasks:
          - name: validate
            template: validate-data
          - name: train
            template: train-model
            dependencies: [validate]
          - name: register
            template: register-model
            dependencies: [train]
            when: "{{tasks.train.outputs.parameters.accuracy}} > 0.90"

    - name: validate-data
      container:
        image: ghcr.io/example/ml-tools:latest
        command: [python, validate.py]
      outputs:
        artifacts:
          - name: data
            path: /tmp/data.parquet

    - name: train-model
      inputs:
        artifacts:
          - name: data
            path: /tmp/data.parquet
      container:
        image: ghcr.io/example/ml-trainer:latest
        command: [python, train.py]
        env:
          - name: LEARNING_RATE
            value: "{{workflow.parameters.learning-rate}}"
          - name: MODEL_FORMAT
            value: "onnx"
        resources:
          requests:
            cpu: "4"
            memory: "8Gi"
      outputs:
        parameters:
          - name: accuracy
            valueFrom:
              path: /tmp/accuracy.txt
        artifacts:
          - name: model
            path: /tmp/model.onnx

    - name: register-model
      inputs:
        parameters:
          - name: accuracy
            value: "{{tasks.train.outputs.parameters.accuracy}}"
        artifacts:
          - name: model
            path: /tmp/model.onnx
      container:
        image: ghcr.io/example/ml-tools:latest
        command: [python, register.py]
        env:
          - name: MODEL_VERSION
            value: "{{workflow.parameters.model-version}}"
          - name: MODEL_ACCURACY
            value: "{{inputs.parameters.accuracy}}"
```

## Section 8: Workflow Resource Management and RBAC

```yaml
# argo-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: workflow-runner
  namespace: argo
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workflow-runner
  namespace: argo
rules:
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list, watch, create, patch, delete]
  - apiGroups: [""]
    resources: [pods/log]
    verbs: [get]
  - apiGroups: [argoproj.io]
    resources: [workflows, workflowtasksets]
    verbs: [get, list, watch, update, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: workflow-runner
  namespace: argo
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: workflow-runner
subjects:
  - kind: ServiceAccount
    name: workflow-runner
    namespace: argo
```

```yaml
# Set default ServiceAccount for all workflows in namespace
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-controller-configmap
  namespace: argo
data:
  workflowDefaults: |
    spec:
      serviceAccountName: workflow-runner
      podGC:
        strategy: OnWorkflowCompletion
        deleteDelayDuration: 10s
      retryStrategy:
        limit: "2"
        retryPolicy: OnError
      ttlStrategy:
        secondsAfterCompletion: 86400
        secondsAfterSuccess: 86400
        secondsAfterFailure: 604800
      podPriorityClassName: batch-medium
```

## Section 9: Monitoring and Alerting

```bash
# Check workflow status
argo list -n argo --running
argo list -n argo --status Failed --limit 20

# Get logs for a specific step
argo logs -n argo ml-training-abc123 --follow

# Get workflow details
argo get -n argo ml-training-abc123 -o yaml
```

Prometheus scrape config for Argo Workflows:

```yaml
- job_name: argo-workflows
  static_configs:
    - targets: ['workflow-controller-metrics.argo:9090']
```

Key Prometheus queries:

```promql
# Workflow success rate
sum(argo_workflows_count{phase="Succeeded"}) /
sum(argo_workflows_count{phase=~"Succeeded|Failed|Error"})

# Average workflow duration
argo_workflow_duration_seconds{quantile="0.5"}

# Error rate by workflow name
sum by (name) (rate(argo_workflows_count{phase=~"Failed|Error"}[1h]))

# Pending workflow backlog
argo_workflows_count{phase="Pending"}
```

Alert for failed workflows:

```yaml
groups:
  - name: argo-workflows
    rules:
      - alert: WorkflowFailed
        expr: increase(argo_workflows_count{phase="Failed"}[10m]) > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Argo Workflow failed in namespace {{ $labels.namespace }}"

      - alert: WorkflowBacklogHigh
        expr: argo_workflows_count{phase="Pending"} > 20
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "More than 20 workflows pending in {{ $labels.namespace }}"
```

Argo Workflows scales from simple two-step ETL pipelines to multi-GPU ML training DAGs. The declarative YAML combined with container-per-task isolation makes it significantly easier to reason about and debug than operator-based workflow engines. The Python SDK and Argo Events integration make it a complete platform for event-driven data and ML workloads on Kubernetes.
