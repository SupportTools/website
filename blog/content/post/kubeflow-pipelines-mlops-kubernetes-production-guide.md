---
title: "Kubeflow Pipelines: MLOps Workflow Orchestration on Kubernetes"
date: 2027-02-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kubeflow", "MLOps", "Machine Learning", "Pipelines"]
categories:
- Kubernetes
- MLOps
- Machine Learning
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubeflow Pipelines v2 on Kubernetes, covering architecture, KFP SDK v2 pipeline authoring, artifact passing, Helm deployment, MinIO and S3 backends, RBAC, experiment tracking, and GPU component scheduling."
more_link: "yes"
url: "/kubeflow-pipelines-mlops-kubernetes-production-guide/"
---

Machine learning teams moving from ad-hoc Jupyter notebooks to repeatable, auditable, production-grade workflows need a platform that speaks the same language as the rest of the Kubernetes ecosystem. **Kubeflow Pipelines** (KFP) v2 provides that foundation: a DAG-based pipeline engine, a typed artifact store, a multi-user UI, and a Python SDK that converts decorated functions into containerised pipeline steps. This guide covers everything from initial Helm deployment to running GPU-accelerated training pipelines with full experiment tracking.

<!--more-->

## Architecture: Core Components

Kubeflow Pipelines v2 decomposes into six server-side components that communicate over gRPC and share a MySQL metadata store.

```
                   ┌─────────────────────────────────────────┐
                   │  Kubeflow Pipelines                      │
                   │                                         │
  KFP SDK / UI ───►│  API Server            (REST + gRPC)    │
                   │       │                                  │
                   │  Persistence Agent ◄── Argo Workflows    │
                   │       │                                  │
                   │  Cache Server          (step dedup)      │
                   │       │                                  │
                   │  ScheduledWorkflow     (recurring runs)  │
                   │       │                                  │
                   │  Metadata Writer       (MLMD)            │
                   │                                         │
                   │  MySQL ◄─────────────────────────────── │
                   │  MinIO / S3  (artifact store)            │
                   └─────────────────────────────────────────┘
```

| Component | Role |
|-----------|------|
| **API Server** | Validates pipelines, manages experiments, triggers Argo Workflows |
| **Persistence Agent** | Watches Argo WorkflowRuns and syncs status to MySQL |
| **Scheduled Workflow** | Manages `PipelineRunSpec` CRDs for recurring runs |
| **Cache Server** | Skips re-executing a step whose inputs hash matches a prior run |
| **Metadata Writer** | Writes artifact lineage into ML Metadata (MLMD) via the API server |
| **Viewer CRD Controller** | Manages TensorBoard and visualization CRDs |

## Helm Deployment

### Repository Setup

```bash
helm repo add kubeflow https://kubeflow.github.io/manifests
helm repo update
kubectl create namespace kubeflow
```

### Production Values File

```yaml
# kfp-values.yaml
global:
  istio:
    enabled: false   # Disable Istio if using a plain ingress instead

# API Server
apiServer:
  replicaCount: 2
  image:
    tag: 2.2.0
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi
  env:
  - name: OBJECTSTORECONFIG_BUCKETNAME
    value: "mlpipelines"
  - name: OBJECTSTORECONFIG_REGION
    value: "us-east-1"

# Persistence Agent
persistenceAgent:
  replicaCount: 1
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

# MySQL backend
mysql:
  enabled: true
  auth:
    rootPassword: "EXAMPLE_MYSQL_ROOT_PASS_REPLACE_ME"
    database: mlpipeline
    username: kfp
    password: "EXAMPLE_MYSQL_KFP_PASS_REPLACE_ME"
  primary:
    persistence:
      enabled: true
      storageClass: gp3
      size: 20Gi
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: 2000m
        memory: 4Gi

# MinIO artifact store (swap for S3 in the next section)
minio:
  enabled: true
  auth:
    rootUser: "minio-admin"
    rootPassword: "EXAMPLE_MINIO_PASS_REPLACE_ME"
  persistence:
    enabled: true
    storageClass: gp3
    size: 100Gi
  resources:
    requests:
      cpu: 500m
      memory: 1Gi

# Argo Workflows (KFP dependency)
argo:
  workflow:
    serviceAccount: pipeline-runner
    namespace: kubeflow

# UI
ui:
  replicaCount: 2
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 1Gi

# Monitoring
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring
```

```bash
helm install kubeflow-pipelines kubeflow/kubeflow-pipelines \
  --namespace kubeflow \
  --values kfp-values.yaml \
  --version 2.2.0 \
  --wait \
  --timeout 15m
```

### Switching to S3 Artifact Store

Replace the MinIO section with an S3-backed configuration:

```yaml
minio:
  enabled: false

objectStore:
  host: s3.amazonaws.com
  port: ""
  secure: true
  region: us-east-1
  bucketName: company-mlpipelines
  # IRSA — no static credentials needed on EKS
  useIRSA: true

serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/KFP-S3-Access
```

S3 IAM policy for the artifact bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::company-mlpipelines",
        "arn:aws:s3:::company-mlpipelines/*"
      ]
    }
  ]
}
```

## RBAC and Multi-User Isolation

KFP v2 implements multi-user isolation through Kubernetes namespaces. Each team gets a dedicated profile namespace.

### Profile Creation

```yaml
apiVersion: kubeflow.org/v1
kind: Profile
metadata:
  name: team-data-science
spec:
  owner:
    kind: User
    name: alice@company.com
  resourceQuotaSpec:
    hard:
      cpu: "40"
      memory: "128Gi"
      requests.nvidia.com/gpu: "4"
      persistentvolumeclaims: "20"
  plugins:
  - kind: WorkloadIdentity
    spec:
      gcpServiceAccount: kfp-team-data-science@my-project.iam.gserviceaccount.com
```

### Pipeline Runner RBAC

The `pipeline-runner` service account executes all Argo workflow steps:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pipeline-runner
  namespace: team-data-science
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pipeline-runner-binding
  namespace: team-data-science
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubeflow-pipelines-edit
subjects:
- kind: ServiceAccount
  name: pipeline-runner
  namespace: team-data-science
```

## KFP SDK v2: Pipeline Authoring

Install the SDK:

```bash
pip install kfp==2.7.0
```

### Basic Pipeline with Python Function Components

```python
# pipeline.py
from kfp import dsl
from kfp.dsl import Dataset, Input, Model, Output, Metrics


@dsl.component(
    base_image="python:3.11-slim",
    packages_to_install=["pandas==2.1.4", "scikit-learn==1.4.0"],
)
def preprocess_data(
    raw_data_uri: str,
    processed_data: Output[Dataset],
    test_split: float = 0.2,
) -> None:
    import pandas as pd
    from sklearn.model_selection import train_test_split

    df = pd.read_csv(raw_data_uri)
    df = df.dropna()

    train, test = train_test_split(df, test_size=test_split, random_state=42)

    import os
    os.makedirs(processed_data.path, exist_ok=True)
    train.to_csv(f"{processed_data.path}/train.csv", index=False)
    test.to_csv(f"{processed_data.path}/test.csv", index=False)

    processed_data.metadata["n_train"] = len(train)
    processed_data.metadata["n_test"] = len(test)


@dsl.component(
    base_image="python:3.11-slim",
    packages_to_install=[
        "pandas==2.1.4",
        "scikit-learn==1.4.0",
        "joblib==1.3.2",
    ],
)
def train_model(
    processed_data: Input[Dataset],
    model: Output[Model],
    metrics: Output[Metrics],
    n_estimators: int = 100,
    max_depth: int = 5,
) -> None:
    import pandas as pd
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import accuracy_score, f1_score
    import joblib
    import os

    train = pd.read_csv(f"{processed_data.path}/train.csv")
    test = pd.read_csv(f"{processed_data.path}/test.csv")

    feature_cols = [c for c in train.columns if c != "label"]
    X_train, y_train = train[feature_cols], train["label"]
    X_test, y_test = test[feature_cols], test["label"]

    clf = RandomForestClassifier(
        n_estimators=n_estimators,
        max_depth=max_depth,
        n_jobs=-1,
        random_state=42,
    )
    clf.fit(X_train, y_train)

    preds = clf.predict(X_test)
    acc = accuracy_score(y_test, preds)
    f1 = f1_score(y_test, preds, average="weighted")

    metrics.log_metric("accuracy", acc)
    metrics.log_metric("f1_score", f1)
    metrics.log_metric("n_estimators", n_estimators)

    os.makedirs(model.path, exist_ok=True)
    joblib.dump(clf, f"{model.path}/model.joblib")
    model.metadata["framework"] = "scikit-learn"
    model.metadata["algorithm"] = "RandomForestClassifier"


@dsl.component(
    base_image="python:3.11-slim",
    packages_to_install=["joblib==1.3.2", "scikit-learn==1.4.0"],
)
def evaluate_model(
    model: Input[Model],
    metrics: Input[Metrics],
    accuracy_threshold: float = 0.85,
) -> bool:
    acc = metrics.metadata.get("accuracy", 0.0)
    passed = float(acc) >= accuracy_threshold
    print(f"Accuracy: {acc:.4f}, threshold: {accuracy_threshold}, passed: {passed}")
    return passed


@dsl.pipeline(
    name="classification-training-pipeline",
    description="End-to-end classification model training with quality gate",
)
def training_pipeline(
    raw_data_uri: str = "gs://company-data/datasets/raw/features.csv",
    n_estimators: int = 100,
    max_depth: int = 5,
    accuracy_threshold: float = 0.85,
):
    preprocess_task = preprocess_data(
        raw_data_uri=raw_data_uri,
        test_split=0.2,
    )
    preprocess_task.set_caching_options(True)

    train_task = train_model(
        processed_data=preprocess_task.outputs["processed_data"],
        n_estimators=n_estimators,
        max_depth=max_depth,
    )
    train_task.set_caching_options(False)
    train_task.set_cpu_request("2")
    train_task.set_memory_request("4G")

    eval_task = evaluate_model(
        model=train_task.outputs["model"],
        metrics=train_task.outputs["metrics"],
        accuracy_threshold=accuracy_threshold,
    )


if __name__ == "__main__":
    from kfp import compiler

    compiler.Compiler().compile(
        pipeline_func=training_pipeline,
        package_path="training_pipeline.yaml",
    )
    print("Pipeline compiled to training_pipeline.yaml")
```

Compile and submit:

```bash
python pipeline.py
# Submits to KFP API server
python - <<'EOF'
import kfp

client = kfp.Client(host="https://kfp.company.com")

run = client.create_run_from_pipeline_package(
    pipeline_file="training_pipeline.yaml",
    arguments={
        "raw_data_uri": "gs://company-data/datasets/raw/features-v3.csv",
        "n_estimators": 200,
        "max_depth": 8,
        "accuracy_threshold": 0.90,
    },
    run_name="training-run-v3",
    experiment_name="classification-experiments",
    namespace="team-data-science",
)
print(f"Run ID: {run.run_id}")
EOF
```

### Conditional Execution

Use `dsl.If` to branch pipeline execution based on a component output:

```python
@dsl.pipeline(name="conditional-pipeline")
def conditional_pipeline(raw_data_uri: str):
    preprocess_task = preprocess_data(raw_data_uri=raw_data_uri)
    train_task = train_model(processed_data=preprocess_task.outputs["processed_data"])

    with dsl.If(
        train_task.outputs["Output"] == True,
        name="quality-gate-passed",
    ):
        # Only runs if evaluate_model returned True
        register_task = register_model(
            model=train_task.outputs["model"],
            registry_uri="gs://company-models/registry",
        )
```

### Parallel Steps with ParallelFor

Train multiple hyperparameter configurations in parallel:

```python
@dsl.pipeline(name="parallel-hp-search")
def parallel_hp_search(raw_data_uri: str):
    preprocess_task = preprocess_data(raw_data_uri=raw_data_uri)

    hp_configs = [
        {"n_estimators": 50, "max_depth": 3},
        {"n_estimators": 100, "max_depth": 5},
        {"n_estimators": 200, "max_depth": 8},
        {"n_estimators": 300, "max_depth": 10},
    ]

    with dsl.ParallelFor(items=hp_configs, name="hp-search") as config:
        train_task = train_model(
            processed_data=preprocess_task.outputs["processed_data"],
            n_estimators=config["n_estimators"],
            max_depth=config["max_depth"],
        )
```

## Container Components for Heavy Workloads

For steps requiring custom Docker images (e.g., PyTorch training), use container-based components:

```python
@dsl.container_component
def pytorch_training_component(
    dataset_uri: str,
    model_uri: str,
    epochs: int,
    batch_size: int,
) -> dsl.ContainerSpec:
    return dsl.ContainerSpec(
        image="company/pytorch-trainer:1.2.0",
        command=["python", "train.py"],
        args=[
            "--dataset-uri", dataset_uri,
            "--model-uri", model_uri,
            "--epochs", str(epochs),
            "--batch-size", str(batch_size),
        ],
    )


@dsl.pipeline(name="pytorch-training-pipeline")
def pytorch_pipeline(dataset_uri: str, epochs: int = 30):
    train_task = pytorch_training_component(
        dataset_uri=dataset_uri,
        model_uri="gs://company-models/pytorch/latest",
        epochs=epochs,
        batch_size=64,
    )
    # Request GPU for the training step
    train_task.set_accelerator_type("NVIDIA_TESLA_V100")
    train_task.set_accelerator_limit(1)
    train_task.set_memory_request("16G")
    train_task.set_cpu_request("8")
    # Node selector for GPU nodes
    train_task.add_node_selector_constraint(
        "cloud.google.com/gke-accelerator", "nvidia-tesla-v100"
    )
```

## Pipeline Versioning and Experiments

### Uploading Pipeline Versions

```python
import kfp

client = kfp.Client(host="https://kfp.company.com")

# Create or get pipeline
pipeline = client.get_pipeline_id("classification-training-pipeline")
if pipeline is None:
    pipeline = client.upload_pipeline(
        pipeline_package_path="training_pipeline.yaml",
        pipeline_name="classification-training-pipeline",
        description="Random forest classification training pipeline",
    )
    pipeline_id = pipeline.pipeline_id
else:
    pipeline_id = pipeline

# Upload a new version
version = client.upload_pipeline_version(
    pipeline_package_path="training_pipeline.yaml",
    pipeline_version_name="v1.2.0",
    pipeline_id=pipeline_id,
    description="Added F1 score metric and quality gate threshold param",
)
print(f"Uploaded pipeline version: {version.pipeline_version_id}")
```

### Creating and Querying Experiments

```python
# Create experiment for a feature branch
experiment = client.create_experiment(
    name="feature/better-preprocessing",
    description="Testing improved preprocessing steps",
    namespace="team-data-science",
)

# List runs in an experiment
runs = client.list_runs(
    experiment_id=experiment.experiment_id,
    namespace="team-data-science",
)
for run in runs.runs or []:
    print(f"{run.run_id}: {run.state} — {run.display_name}")
```

## Recurring Runs

Schedule a nightly retraining job:

```python
recurring_run = client.create_recurring_run(
    experiment_id=experiment.experiment_id,
    job_name="nightly-retraining",
    description="Nightly model retraining on fresh data",
    cron_expression="0 2 * * *",  # 02:00 UTC daily
    max_concurrency=1,
    pipeline_id=pipeline_id,
    pipeline_version_id=version.pipeline_version_id,
    params={
        "raw_data_uri": "gs://company-data/datasets/daily/latest.csv",
        "n_estimators": 200,
        "max_depth": 8,
        "accuracy_threshold": 0.90,
    },
    namespace="team-data-science",
    enabled=True,
)
print(f"Recurring run created: {recurring_run.recurring_run_id}")
```

## Cache Server Configuration

The KFP cache server stores the outputs of successful pipeline steps keyed by the step's container image digest and input hashes. Steps are skipped on re-run if inputs are unchanged, cutting iteration time significantly.

```yaml
# Disable caching cluster-wide for a pipeline (useful during debugging)
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  annotations:
    pipelines.kubeflow.org/disable-cache: "true"
```

Per-component cache control in SDK v2:

```python
# Force re-execution regardless of cache hit
train_task.set_caching_options(enable_caching=False)

# Cache with a custom TTL (default is forever)
preprocess_task.set_caching_options(enable_caching=True)
```

## Monitoring

### Prometheus Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kubeflow-pipelines
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: ml-pipeline
  namespaceSelector:
    matchNames:
    - kubeflow
  endpoints:
  - port: http
    path: /metrics
    interval: 30s
```

### Key Metrics

| Metric | Description |
|--------|-------------|
| `pipeline_run_total` | Total pipeline runs by status |
| `pipeline_run_duration_seconds` | Run duration histogram |
| `pipeline_node_total` | Total component executions |
| `mlmd_store_operation_duration_seconds` | Metadata write latency |

### PrometheusRule Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kfp-alerts
  namespace: monitoring
spec:
  groups:
  - name: kubeflow-pipelines
    rules:
    - alert: KFPHighRunFailureRate
      expr: |
        rate(pipeline_run_total{status="Failed"}[15m]) /
        rate(pipeline_run_total[15m]) > 0.2
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Kubeflow Pipelines run failure rate elevated"
        description: "More than 20% of pipeline runs are failing over the last 15 minutes"

    - alert: KFPAPIServerDown
      expr: up{job="ml-pipeline"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Kubeflow Pipelines API server is down"

    - alert: KFPLongRunningPipeline
      expr: |
        pipeline_run_duration_seconds{status="Running"} > 7200
      for: 0m
      labels:
        severity: warning
      annotations:
        summary: "Pipeline run has been running for more than 2 hours"
        description: "Run {{ $labels.run_id }} in experiment {{ $labels.experiment_id }} has been running for {{ $value }}s"
```

## Production Considerations

### Resource Quotas per Profile Namespace

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: kfp-pipeline-quota
  namespace: team-data-science
spec:
  hard:
    pods: "50"
    requests.cpu: "40"
    requests.memory: "128Gi"
    requests.nvidia.com/gpu: "4"
    limits.cpu: "80"
    limits.memory: "256Gi"
    limits.nvidia.com/gpu: "4"
    persistentvolumeclaims: "20"
    requests.storage: "500Gi"
```

### Pipeline Runner Pod Security

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pipeline-runner
  namespace: team-data-science
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pipeline-runner-role
  namespace: team-data-science
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log", "pods/exec"]
  verbs: ["get", "list", "watch", "create", "delete", "patch"]
- apiGroups: [""]
  resources: ["secrets", "configmaps"]
  verbs: ["get", "list"]
- apiGroups: ["argoproj.io"]
  resources: ["workflows"]
  verbs: ["get", "list", "watch", "create", "delete", "patch", "update"]
```

### Artifact Store Backup

```bash
#!/bin/bash
# kfp-backup.sh — back up MySQL metadata and MinIO artifacts

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/backup/kfp/${TIMESTAMP}"
NAMESPACE="kubeflow"

mkdir -p "${BACKUP_DIR}"

# MySQL dump via kubectl exec
MYSQL_POD=$(kubectl get pod -n "${NAMESPACE}" -l app=mysql -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n "${NAMESPACE}" "${MYSQL_POD}" -- \
  mysqldump -u kfp -pEXAMPLE_MYSQL_KFP_PASS_REPLACE_ME mlpipeline \
  > "${BACKUP_DIR}/mlpipeline.sql"

# MinIO bucket sync to S3
MINIO_POD=$(kubectl get pod -n "${NAMESPACE}" -l app=minio -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n "${NAMESPACE}" "${MINIO_POD}" -- \
  mc mirror local/mlpipelines "s3/company-mlpipelines-backup/${TIMESTAMP}/"

echo "Backup complete: ${BACKUP_DIR}"
```

## Conclusion

Kubeflow Pipelines v2 brings a production-ready MLOps workflow engine to teams already invested in Kubernetes. The KFP SDK v2 `@component` decorator turns ordinary Python functions into reusable, cached pipeline steps with strongly-typed artifact interfaces. Multi-user profile namespaces enforce resource boundaries and access control without custom tooling.

Key architecture decisions for production deployments:

- Replace MinIO with an S3-compatible bucket and IRSA/Workload Identity for credential-free artifact access
- Use MySQL on a managed service (RDS, Cloud SQL) rather than the in-cluster instance for reliability and point-in-time recovery
- Enable the Argo Workflow cache server and set `set_caching_options(True)` on stable preprocessing steps to accelerate iterative experimentation
- Request GPU resources explicitly via `set_accelerator_type` and enforce node selectors to prevent GPU steps landing on CPU-only nodes
- Monitor `pipeline_run_total{status="Failed"}` and alert early — silent recurring-run failures are the most common cause of model staleness in production
