---
title: "MLflow on Kubernetes: Model Registry and Experiment Tracking at Enterprise Scale"
date: 2027-02-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "MLflow", "MLOps", "Machine Learning", "Model Registry"]
categories:
- Kubernetes
- MLOps
- Machine Learning
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to deploying MLflow on Kubernetes with PostgreSQL backend and S3 artifact store, covering OIDC authentication, experiment tracking, model registry lifecycle management, multi-environment promotion, monitoring, and backup procedures."
more_link: "yes"
url: "/mlflow-model-registry-kubernetes-enterprise-guide/"
---

Every mature ML platform needs a place to store experiments, compare model versions, and manage the lifecycle from prototype to production. **MLflow** provides those capabilities in a single open-source stack: a tracking server for metrics and parameters, an artifact store for models and datasets, and a model registry for lifecycle governance. Deploying MLflow on Kubernetes with a PostgreSQL backend and S3-compatible artifact store gives teams the durability and scalability their production model inventories demand.

<!--more-->

## Architecture Overview

An enterprise MLflow deployment consists of three tiers:

```
┌──────────────────────────────────────────────────────────┐
│  Client layer                                             │
│  ├─ Training scripts (mlflow.log_metric, mlflow.log_model)│
│  ├─ MLflow UI (browser)                                   │
│  └─ CI/CD pipelines (mlflow models serve, REST API)      │
└────────────────────┬─────────────────────────────────────┘
                     │ REST / gRPC
┌────────────────────▼─────────────────────────────────────┐
│  Tracking Server (mlflow server)                          │
│  ├─ Experiment metadata → PostgreSQL                      │
│  ├─ Artifact proxy → S3 / MinIO                           │
│  └─ Model Registry API                                    │
└────────────────────┬─────────────────────────────────────┘
                     │
          ┌──────────┴───────────┐
          ▼                      ▼
   PostgreSQL                 S3 / MinIO
   (run metadata,             (model binaries,
    params, metrics,           datasets, plots)
    model registry)
```

The tracking server is the only component that runs in Kubernetes as a long-lived deployment. All persistent state lives outside the server pod — in PostgreSQL and S3 — so the server itself is stateless and horizontally scalable.

## Helm Deployment

### Add the Community Chart

```bash
helm repo add community-charts https://community-charts.github.io/helm-charts
helm repo update
kubectl create namespace mlflow
```

### Production Values File

```yaml
# mlflow-values.yaml
replicaCount: 2

image:
  repository: ghcr.io/mlflow/mlflow
  tag: 2.11.3
  pullPolicy: IfNotPresent

# PostgreSQL backend
backendStore:
  postgres:
    enabled: true
    host: mlflow-postgresql.mlflow.svc.cluster.local
    port: 5432
    database: mlflow
    user: mlflow
    password: "EXAMPLE_MLFLOW_DB_PASS_REPLACE_ME"

# S3 artifact store
artifactRoot:
  s3:
    enabled: true
    bucket: company-mlflow-artifacts
    region: us-east-1
    # IRSA — no static credentials needed on EKS
    awsAccessKeyId: ""
    awsSecretAccessKey: ""

# Server configuration
extraArgs:
  serve-artifacts: "true"
  expose-prometheus: "true"
  default-artifact-root: "s3://company-mlflow-artifacts/mlflow"
  workers: "4"

# OIDC authentication (see separate section below)
extraEnvVars:
- name: MLFLOW_AUTH_CONFIG_PATH
  value: /etc/mlflow/auth.ini
- name: MLFLOW_FLASK_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: mlflow-auth-secret
      key: flask-secret-key

serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/MLflow-S3-Access

resources:
  requests:
    cpu: "1"
    memory: "2Gi"
  limits:
    cpu: "4"
    memory: "8Gi"

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 8
  targetCPUUtilizationPercentage: 70
  targetMemoryUtilizationPercentage: 80

ingress:
  enabled: true
  ingressClassName: nginx
  annotations:
    cert-manager.io/cluster-issuer: production-ca-issuer
    nginx.ingress.kubernetes.io/proxy-body-size: "5g"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
  hosts:
  - host: mlflow.company.com
    paths:
    - path: /
      pathType: Prefix
  tls:
  - secretName: mlflow-tls
    hosts:
    - mlflow.company.com

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring
    additionalLabels:
      app: mlflow
```

### PostgreSQL with Helm

Deploy a production PostgreSQL alongside MLflow:

```yaml
# postgresql-values.yaml
auth:
  postgresPassword: "EXAMPLE_PG_ROOT_PASS_REPLACE_ME"
  username: mlflow
  password: "EXAMPLE_MLFLOW_DB_PASS_REPLACE_ME"
  database: mlflow

primary:
  persistence:
    enabled: true
    storageClass: gp3
    size: 50Gi
  resources:
    requests:
      cpu: "1"
      memory: "2Gi"
    limits:
      cpu: "4"
      memory: "8Gi"
  # WAL archiving for point-in-time recovery
  extendedConfiguration: |
    wal_level = replica
    archive_mode = on
    archive_command = 'aws s3 cp %p s3://company-mlflow-wal/%f'
    max_wal_senders = 3

readReplicas:
  replicaCount: 1
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
```

```bash
helm install mlflow-postgresql bitnami/postgresql \
  --namespace mlflow \
  --values postgresql-values.yaml \
  --version 14.3.3 \
  --wait

helm install mlflow community-charts/mlflow \
  --namespace mlflow \
  --values mlflow-values.yaml \
  --version 0.7.19 \
  --wait
```

### S3 IAM Policy

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
        "s3:GetBucketLocation",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::company-mlflow-artifacts",
        "arn:aws:s3:::company-mlflow-artifacts/*"
      ]
    }
  ]
}
```

## OIDC Authentication

MLflow 2.0+ ships a pluggable authentication system. Configure OIDC to integrate with corporate SSO.

### Auth ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mlflow-auth-config
  namespace: mlflow
data:
  auth.ini: |
    [mlflow]
    default_permission = READ
    database_uri = postgresql://mlflow:EXAMPLE_MLFLOW_DB_PASS_REPLACE_ME@mlflow-postgresql.mlflow.svc.cluster.local:5432/mlflow_auth
    admin_username = admin
    admin_password = EXAMPLE_ADMIN_PASS_REPLACE_ME
    authorization_function = mlflow.server.auth:authenticate_request_basic_auth
```

For Keycloak/OIDC proxy (preferred for enterprise), deploy `oauth2-proxy` as a sidecar:

```yaml
# Deploy oauth2-proxy in front of MLflow
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mlflow-oauth2-proxy
  namespace: mlflow
spec:
  replicas: 2
  selector:
    matchLabels:
      app: mlflow-oauth2-proxy
  template:
    spec:
      containers:
      - name: oauth2-proxy
        image: quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
        args:
        - --http-address=0.0.0.0:4180
        - --upstream=http://mlflow.mlflow.svc.cluster.local:5000
        - --provider=oidc
        - --oidc-issuer-url=https://sso.company.com/realms/company
        - --client-id=mlflow
        - --email-domain=company.com
        - --redirect-url=https://mlflow.company.com/oauth2/callback
        - --cookie-secure=true
        - --pass-access-token=true
        - --skip-provider-button=true
        env:
        - name: OAUTH2_PROXY_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: mlflow-oauth2-secret
              key: client-secret
        - name: OAUTH2_PROXY_COOKIE_SECRET
          valueFrom:
            secretKeyRef:
              name: mlflow-oauth2-secret
              key: cookie-secret
        ports:
        - containerPort: 4180
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
```

## Experiment Tracking with the Python SDK

### Basic Experiment Setup

```python
# experiment_tracking.py
import mlflow
import mlflow.sklearn
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score
import pandas as pd
import numpy as np


# Configure the tracking server
mlflow.set_tracking_uri("https://mlflow.company.com")
mlflow.set_experiment("churn-prediction-v2")

# Load data
df = pd.read_parquet("gs://company-data/churn/features.parquet")
X = df.drop("churned", axis=1)
y = df["churned"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

with mlflow.start_run(run_name="gbt-baseline"):
    # Log hyperparameters
    params = {
        "n_estimators": 200,
        "learning_rate": 0.05,
        "max_depth": 4,
        "subsample": 0.8,
        "min_samples_split": 20,
    }
    mlflow.log_params(params)

    # Log dataset metadata
    mlflow.log_param("n_train", len(X_train))
    mlflow.log_param("n_test", len(X_test))
    mlflow.log_param("n_features", X_train.shape[1])

    # Train
    clf = GradientBoostingClassifier(**params, random_state=42)
    clf.fit(X_train, y_train)

    # Log per-epoch train loss (simulated iteration logging)
    for i, staged_pred in enumerate(clf.staged_predict(X_test)):
        mlflow.log_metric("staged_accuracy", accuracy_score(y_test, staged_pred), step=i)

    # Log final metrics
    preds = clf.predict(X_test)
    proba = clf.predict_proba(X_test)[:, 1]
    mlflow.log_metric("accuracy", accuracy_score(y_test, preds))
    mlflow.log_metric("f1_score", f1_score(y_test, preds))
    mlflow.log_metric("roc_auc", roc_auc_score(y_test, proba))

    # Log the model with input schema
    signature = mlflow.models.infer_signature(X_train, clf.predict(X_train))
    mlflow.sklearn.log_model(
        clf,
        "model",
        signature=signature,
        input_example=X_train.head(5),
        registered_model_name="churn-prediction",
    )

    # Log artifacts
    feature_importances = pd.Series(
        clf.feature_importances_, index=X.columns
    ).sort_values(ascending=False)
    feature_importances.to_csv("/tmp/feature_importances.csv")
    mlflow.log_artifact("/tmp/feature_importances.csv", "analysis")

    print(f"Run ID: {mlflow.active_run().info.run_id}")
```

### Autologging

MLflow autologging instruments popular frameworks with a single line:

```python
# scikit-learn autologging
import mlflow
mlflow.sklearn.autolog(
    log_models=True,
    log_datasets=True,
    log_post_training_metrics=True,
    max_tuning_runs=5,
)

# PyTorch Lightning autologging
mlflow.pytorch.autolog(log_every_n_epoch=1, log_models=True)

# XGBoost autologging
mlflow.xgboost.autolog(log_feature_importance=True)

# TensorFlow / Keras autologging
mlflow.tensorflow.autolog(log_models=True, log_datasets=True)

# Transformers (HuggingFace) autologging
mlflow.transformers.autolog(log_models=True)
```

## Model Registry Lifecycle

The MLflow Model Registry provides four lifecycle stages: **None** (initial), **Staging**, **Production**, and **Archived**.

### Registering and Transitioning Models

```python
from mlflow.tracking import MlflowClient

client = MlflowClient(tracking_uri="https://mlflow.company.com")

# Register a new model version from a run
model_version = client.create_model_version(
    name="churn-prediction",
    source="runs:/abc123def456/model",
    run_id="abc123def456",
    description="GBT baseline — 200 estimators, lr=0.05",
    tags={
        "team": "data-science",
        "framework": "scikit-learn",
        "git_commit": "a1b2c3d4",
    },
)
print(f"Registered version: {model_version.version}")

# Transition to Staging after automated tests pass
client.transition_model_version_stage(
    name="churn-prediction",
    version=model_version.version,
    stage="Staging",
    archive_existing_versions=False,
)

# Promote to Production after manual review
client.transition_model_version_stage(
    name="churn-prediction",
    version=model_version.version,
    stage="Production",
    archive_existing_versions=True,  # Archive the previous Production version
)
```

### Model Aliasing (MLflow 2.3+)

Model aliases provide named pointers that decouple serving configurations from version numbers:

```python
# Assign human-readable aliases
client.set_registered_model_alias(
    name="churn-prediction",
    alias="production",
    version="12",
)
client.set_registered_model_alias(
    name="churn-prediction",
    alias="shadow",
    version="13",
)

# Load by alias in serving code — version number never changes in config
model = mlflow.pyfunc.load_model("models:/churn-prediction@production")

# Promote by updating the alias, not the deployment config
client.set_registered_model_alias(
    name="churn-prediction",
    alias="production",
    version="13",
)
client.delete_registered_model_alias(
    name="churn-prediction",
    alias="shadow",
)
```

### Model Registry Webhooks

Trigger downstream actions when a model transitions stages:

```python
from mlflow.tracking import MlflowClient

client = MlflowClient(tracking_uri="https://mlflow.company.com")

# Create a webhook that fires when any model reaches Production
client.create_registry_webhook(
    events=["MODEL_VERSION_TRANSITIONED_STAGE"],
    http_url_spec=mlflow.utils.proto_json_utils.dict_to_json({
        "url": "https://jenkins.company.com/generic-webhook-trigger/invoke",
        "enable_ssl_verification": True,
        "secret": "EXAMPLE_WEBHOOK_SECRET_REPLACE_ME",
        "authorization": "Bearer EXAMPLE_CI_TOKEN_REPLACE_ME",
    }),
    description="Trigger integration tests on model stage transition",
    model_name="churn-prediction",
)

# List existing webhooks
webhooks = client.list_registry_webhooks(model_name="churn-prediction")
for wh in webhooks:
    print(f"ID: {wh.id}, Events: {wh.events}, URL: {wh.http_url_spec.url}")
```

## Multi-Environment Promotion Workflow

A complete promotion workflow keeps separate MLflow experiments per environment, with automated gates between stages.

```bash
#!/bin/bash
# promote-model.sh — promote a model from staging to production
set -euo pipefail

MODEL_NAME="churn-prediction"
STAGING_VERSION="$1"
TRACKING_URI="https://mlflow.company.com"
THRESHOLD_ROC_AUC=0.88

python3 - <<EOF
import mlflow
from mlflow.tracking import MlflowClient
import sys

client = MlflowClient(tracking_uri="${TRACKING_URI}")

# Fetch the staging version and its run metrics
mv = client.get_model_version("${MODEL_NAME}", "${STAGING_VERSION}")
run = client.get_run(mv.run_id)
roc_auc = float(run.data.metrics.get("roc_auc", 0.0))

print(f"Staging version ${STAGING_VERSION} — ROC AUC: {roc_auc:.4f}")

if roc_auc < ${THRESHOLD_ROC_AUC}:
    print(f"ERROR: ROC AUC {roc_auc:.4f} below threshold ${THRESHOLD_ROC_AUC}")
    sys.exit(1)

# Promote and archive the current Production version
client.transition_model_version_stage(
    name="${MODEL_NAME}",
    version="${STAGING_VERSION}",
    stage="Production",
    archive_existing_versions=True,
)

# Update the production alias
client.set_registered_model_alias(
    name="${MODEL_NAME}",
    alias="production",
    version="${STAGING_VERSION}",
)

print(f"Successfully promoted version ${STAGING_VERSION} to Production")
EOF
```

### CI/CD Pipeline Integration

```yaml
# .github/workflows/model-promotion.yaml
name: Promote Model to Production
on:
  workflow_dispatch:
    inputs:
      model_name:
        description: "MLflow model name"
        required: true
      model_version:
        description: "Staging version to promote"
        required: true

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - name: Run integration tests against staging model
      run: |
        pip install mlflow==2.11.3 scikit-learn pandas
        python tests/integration/test_model.py \
          --model-uri "models:/{{ inputs.model_name }}@staging" \
          --tracking-uri ${{ secrets.MLFLOW_TRACKING_URI }}

  promote:
    needs: integration-tests
    runs-on: ubuntu-latest
    environment: production    # Requires manual approval in GitHub
    steps:
    - uses: actions/checkout@v4
    - name: Promote model
      env:
        MLFLOW_TRACKING_URI: ${{ secrets.MLFLOW_TRACKING_URI }}
        MLFLOW_TRACKING_TOKEN: ${{ secrets.MLFLOW_TRACKING_TOKEN }}
      run: |
        bash ./scripts/promote-model.sh \
          ${{ inputs.model_name }} \
          ${{ inputs.model_version }}
```

## Model Serving with `mlflow models serve`

For low-traffic internal endpoints, MLflow's built-in serving is sufficient. For production traffic, use the REST API with a proper deployment wrapper.

### Kubernetes Deployment for Model Serving

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: churn-model-server
  namespace: model-serving
spec:
  replicas: 3
  selector:
    matchLabels:
      app: churn-model-server
  template:
    metadata:
      labels:
        app: churn-model-server
    spec:
      serviceAccountName: model-server
      initContainers:
      # Download model artifacts from MLflow at startup
      - name: model-fetcher
        image: ghcr.io/mlflow/mlflow:2.11.3
        command:
        - sh
        - -c
        - |
          mlflow artifacts download \
            --artifact-uri models:/churn-prediction@production/model \
            --dst-path /model
        env:
        - name: MLFLOW_TRACKING_URI
          value: https://mlflow.company.com
        - name: MLFLOW_TRACKING_TOKEN
          valueFrom:
            secretKeyRef:
              name: mlflow-serving-token
              key: token
        volumeMounts:
        - name: model-storage
          mountPath: /model
      containers:
      - name: model-server
        image: ghcr.io/mlflow/mlflow:2.11.3
        command:
        - mlflow
        - models
        - serve
        - --model-uri
        - /model
        - --host
        - "0.0.0.0"
        - --port
        - "8080"
        - --workers
        - "4"
        - --no-conda
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 60
          periodSeconds: 15
        resources:
          requests:
            cpu: "1"
            memory: "2Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
        volumeMounts:
        - name: model-storage
          mountPath: /model
      volumes:
      - name: model-storage
        emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: churn-model-server
  namespace: model-serving
spec:
  selector:
    app: churn-model-server
  ports:
  - port: 80
    targetPort: 8080
```

Query the endpoint:

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"dataframe_split": {"columns": ["feature_1", "feature_2"], "data": [[0.5, 1.2]]}}' \
  http://churn-model-server.model-serving.svc.cluster.local/invocations
```

## Integration with Kubeflow Pipelines

MLflow works alongside Kubeflow Pipelines as the experiment tracker and model registry, while KFP handles orchestration. This combination gives teams both pipeline DAG visibility and cross-run metric comparison.

```python
# Inside a KFP component — log to MLflow while running as a Kubernetes pod
from kfp.dsl import component, Output, Metrics, Model
import os


@component(
    base_image="python:3.11-slim",
    packages_to_install=[
        "mlflow==2.11.3",
        "scikit-learn==1.4.0",
        "boto3==1.34.0",
    ],
)
def train_and_register(
    dataset_uri: str,
    model_name: str,
    kfp_metrics: Output[Metrics],
    kfp_model: Output[Model],
) -> None:
    import mlflow
    import mlflow.sklearn
    from sklearn.ensemble import RandomForestClassifier
    import pandas as pd

    # MLflow tracking server is injected as an env var by the platform
    mlflow.set_tracking_uri(os.environ["MLFLOW_TRACKING_URI"])
    mlflow.set_experiment("kfp-integrated-training")

    df = pd.read_parquet(dataset_uri)
    X = df.drop("label", axis=1)
    y = df["label"]

    with mlflow.start_run() as run:
        clf = RandomForestClassifier(n_estimators=100, random_state=42)
        clf.fit(X, y)

        acc = (clf.predict(X) == y).mean()
        mlflow.log_metric("accuracy", acc)

        mlflow.sklearn.log_model(
            clf,
            "model",
            registered_model_name=model_name,
        )

        # Surface metrics back to KFP
        kfp_metrics.log_metric("accuracy", acc)
        kfp_metrics.log_metric("mlflow_run_id", run.info.run_id)

        # Point KFP model artifact at the MLflow model URI
        import json
        with open(kfp_model.path, "w") as f:
            json.dump({"mlflow_model_uri": f"models:/{model_name}/latest"}, f)
```

## Monitoring

### Prometheus Metrics

Enable the Prometheus endpoint in the MLflow server configuration:

```yaml
extraArgs:
  expose-prometheus: "true"
```

MLflow exposes metrics at `GET /metrics` on the same port as the tracking server.

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: mlflow
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: mlflow
  namespaceSelector:
    matchNames:
    - mlflow
  endpoints:
  - port: http
    path: /metrics
    interval: 30s
```

### Key Metrics

| Metric | Description |
|--------|-------------|
| `mlflow_run_count` | Total runs by experiment and status |
| `mlflow_artifact_upload_total` | Total artifact uploads |
| `mlflow_model_version_count` | Registered model versions by stage |
| `process_resident_memory_bytes` | Server memory usage |
| `http_request_duration_seconds` | API latency histogram |

### PrometheusRule

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: mlflow-alerts
  namespace: monitoring
spec:
  groups:
  - name: mlflow
    rules:
    - alert: MLflowServerDown
      expr: up{job="mlflow"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "MLflow tracking server is unreachable"
        description: "MLflow has been down for 5 minutes — experiment tracking will fail"

    - alert: MLflowHighApiLatency
      expr: |
        histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{job="mlflow"}[5m])) > 5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "MLflow API p99 latency exceeds 5 seconds"
        description: "Slow MLflow API responses may block training jobs from logging metrics"

    - alert: MLflowPostgresConnectionFailed
      expr: |
        rate(mlflow_db_connection_errors_total[5m]) > 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "MLflow cannot reach PostgreSQL"
        description: "Database connection errors — model registry writes will fail"
```

## Backup and Restore Procedures

### Automated Backup Script

```bash
#!/bin/bash
# mlflow-backup.sh
set -euo pipefail

NAMESPACE="mlflow"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_BUCKET="s3://company-mlflow-backups"
BACKUP_PREFIX="${BACKUP_BUCKET}/${TIMESTAMP}"

echo "Starting MLflow backup at ${TIMESTAMP}"

# 1. PostgreSQL dump
PG_POD=$(kubectl get pod -n "${NAMESPACE}" \
  -l app.kubernetes.io/name=postgresql \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n "${NAMESPACE}" "${PG_POD}" -- \
  pg_dump -U mlflow mlflow | \
  aws s3 cp - "${BACKUP_PREFIX}/mlflow.sql"

echo "Database backup complete"

# 2. Sync artifact bucket (incremental)
aws s3 sync \
  s3://company-mlflow-artifacts/ \
  "${BACKUP_PREFIX}/artifacts/" \
  --only-show-errors

echo "Artifact backup complete"

# 3. Export model registry metadata via MLflow API
python3 - <<'PYEOF'
import mlflow
import json
import subprocess

client = mlflow.tracking.MlflowClient(
    tracking_uri="https://mlflow.company.com"
)

registry_export = {}
for rm in client.search_registered_models():
    versions = client.search_model_versions(f"name='{rm.name}'")
    registry_export[rm.name] = {
        "tags": dict(rm.tags),
        "description": rm.description,
        "versions": [
            {
                "version": v.version,
                "stage": v.current_stage,
                "run_id": v.run_id,
                "tags": dict(v.tags),
                "description": v.description,
            }
            for v in versions
        ],
    }

with open("/tmp/model_registry_export.json", "w") as f:
    json.dump(registry_export, f, indent=2)

subprocess.run([
    "aws", "s3", "cp",
    "/tmp/model_registry_export.json",
    f"${BACKUP_PREFIX}/model_registry_export.json",
], check=True)
print(f"Exported {len(registry_export)} registered models")
PYEOF

echo "Backup complete: ${BACKUP_PREFIX}"
```

Schedule as a Kubernetes CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: mlflow-backup
  namespace: mlflow
spec:
  schedule: "0 3 * * *"  # 03:00 UTC daily
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: mlflow-backup
          restartPolicy: OnFailure
          containers:
          - name: backup
            image: amazon/aws-cli:2.15.0
            command: ["/bin/bash", "/scripts/mlflow-backup.sh"]
            env:
            - name: AWS_DEFAULT_REGION
              value: us-east-1
            volumeMounts:
            - name: backup-script
              mountPath: /scripts
          volumes:
          - name: backup-script
            configMap:
              name: mlflow-backup-script
              defaultMode: 0755
```

### Restore Procedure

```bash
#!/bin/bash
# mlflow-restore.sh <backup-timestamp>
BACKUP_TIMESTAMP="$1"
BACKUP_PREFIX="s3://company-mlflow-backups/${BACKUP_TIMESTAMP}"
NAMESPACE="mlflow"

# Scale down the tracking server to prevent writes during restore
kubectl scale deployment mlflow --namespace "${NAMESPACE}" --replicas=0

# Restore PostgreSQL
PG_POD=$(kubectl get pod -n "${NAMESPACE}" \
  -l app.kubernetes.io/name=postgresql \
  -o jsonpath='{.items[0].metadata.name}')

aws s3 cp "${BACKUP_PREFIX}/mlflow.sql" - | \
  kubectl exec -i -n "${NAMESPACE}" "${PG_POD}" -- \
    psql -U mlflow -d mlflow

# Sync artifact bucket
aws s3 sync \
  "${BACKUP_PREFIX}/artifacts/" \
  s3://company-mlflow-artifacts/ \
  --only-show-errors

# Scale the tracking server back up
kubectl scale deployment mlflow --namespace "${NAMESPACE}" --replicas=2
kubectl rollout status deployment/mlflow --namespace "${NAMESPACE}"

echo "Restore complete from backup: ${BACKUP_TIMESTAMP}"
```

## Conclusion

A production MLflow deployment on Kubernetes provides the experiment tracking, model registry, and artifact management capabilities that ML teams need to operate with engineering rigor. PostgreSQL and S3 backends decouple persistence from the stateless tracking server, enabling zero-downtime rolling updates and horizontal scaling.

Key operational priorities for enterprise deployments:

- Use IRSA or Workload Identity for S3 artifact access — rotate service account credentials automatically rather than storing static keys
- Deploy the PostgreSQL tracking store on a managed database service (RDS, Cloud SQL, Aurora) for automated failover and point-in-time recovery
- Adopt **model aliases** from MLflow 2.3+ — they decouple serving configuration from version numbers and make stage promotions atomic
- Implement the backup CronJob from day one and test restore procedures quarterly — the model registry is your team's audit trail for every model in production
- Enable the Prometheus endpoint and alert on `mlflow_db_connection_errors_total` — a silent database outage will silently drop training metrics without alerting users
- Integrate registry webhooks with CI/CD to enforce automated quality gates (metric thresholds, integration tests) before models reach the `Production` stage
