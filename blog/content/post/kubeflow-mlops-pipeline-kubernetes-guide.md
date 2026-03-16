---
title: "Kubeflow MLOps Pipelines: Training, Serving, and Experiment Tracking on Kubernetes"
date: 2027-07-18T00:00:00-05:00
draft: false
tags: ["Kubeflow", "MLOps", "Kubernetes", "AI/ML", "Pipeline"]
categories:
- Kubernetes
- AI/ML
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubeflow MLOps on Kubernetes covering Pipelines DSL, distributed training with PyTorchJob, hyperparameter tuning with Katib, model registry with KServe, canary rollouts for models, MLflow experiment tracking, and multi-tenant RBAC for production ML platforms."
more_link: "yes"
url: "/kubeflow-mlops-pipeline-kubernetes-guide/"
---

Machine learning in production requires more than a trained model. It requires reproducible pipelines, experiment tracking, automated hyperparameter search, versioned model storage, and controlled serving rollouts. Kubeflow provides all of these capabilities as Kubernetes-native components, allowing ML practitioners to use the same infrastructure primitives — CRDs, RBAC, persistent storage, horizontal scaling — that platform teams already operate.

<!--more-->

# Kubeflow MLOps Pipelines: Training, Serving, and Experiment Tracking on Kubernetes

## Section 1: Kubeflow Architecture Overview

Kubeflow is a collection of independent but composable components:

| Component | Purpose |
|---|---|
| **Kubeflow Pipelines (KFP)** | DAG-based ML workflow orchestration |
| **Training Operator** | Distributed training CRDs (PyTorchJob, TFJob, MPIJob) |
| **Katib** | Automated hyperparameter tuning and NAS |
| **KServe** | Model serving with canary, traffic splitting, autoscaling |
| **Model Registry** | Versioned model artifact storage and lifecycle |
| **Notebooks** | JupyterLab environments with GPU support |
| **Profiles** | Multi-tenant namespace isolation with RBAC |

Components can be installed independently. A minimal production stack typically includes Pipelines, Training Operator, KServe, and Katib.

---

## Section 2: Installing Kubeflow

### Prerequisites

```bash
# Verify cluster requirements
kubectl version --client
kubectl get nodes -o jsonpath='{.items[*].status.allocatable.cpu}' | tr ' ' '\n' | sort -n

# Install kustomize
curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" \
  | bash
mv kustomize /usr/local/bin/
```

### Install with kustomize (Standalone Components)

**Kubeflow Pipelines (standalone):**

```bash
export PIPELINE_VERSION=2.3.0

kubectl apply -k "github.com/kubeflow/pipelines/manifests/kustomize/cluster-scoped-resources?ref=${PIPELINE_VERSION}"

kubectl wait --for=condition=established \
  --timeout=60s crd/applications.app.k8s.io

kubectl apply -k "github.com/kubeflow/pipelines/manifests/kustomize/env/platform-agnostic-pns?ref=${PIPELINE_VERSION}"

# Verify
kubectl get pods -n kubeflow
```

**Training Operator:**

```bash
kubectl apply -k "github.com/kubeflow/training-operator/manifests/overlays/standalone?ref=v1.8.0"

# Verify CRDs installed
kubectl get crd | grep kubeflow
```

**KServe:**

```bash
kubectl apply -f https://github.com/kserve/kserve/releases/download/v0.13.0/kserve.yaml
kubectl apply -f https://github.com/kserve/kserve/releases/download/v0.13.0/kserve-cluster-resources.yaml
```

**Katib:**

```bash
kubectl apply -k "github.com/kubeflow/katib/manifests/v1beta1/installs/katib-standalone?ref=v0.17.0"
```

---

## Section 3: Kubeflow Pipelines DSL

KFP v2 uses a Python SDK to define pipeline components and DAGs. Each component runs as an isolated container with typed inputs and outputs.

### Pipeline Components

**Define a reusable training component:**

```python
# components/train_model.py
from kfp import dsl
from kfp.dsl import Dataset, Model, Output, Input, Metrics
import os

@dsl.component(
    base_image="pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime",
    packages_to_install=[
        "transformers==4.43.0",
        "datasets==2.20.0",
        "peft==0.11.0"
    ]
)
def train_model(
    train_dataset: Input[Dataset],
    val_dataset: Input[Dataset],
    model_name: str,
    num_epochs: int,
    learning_rate: float,
    batch_size: int,
    trained_model: Output[Model],
    metrics: Output[Metrics]
) -> None:
    """Fine-tune a transformer model with LoRA."""
    import torch
    from transformers import (
        AutoModelForSequenceClassification,
        AutoTokenizer,
        TrainingArguments,
        Trainer
    )
    from datasets import load_from_disk
    from peft import LoraConfig, get_peft_model

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Training on: {device}")

    tokenizer = AutoTokenizer.from_pretrained(model_name)
    base_model = AutoModelForSequenceClassification.from_pretrained(
        model_name, num_labels=2
    )

    lora_config = LoraConfig(
        r=16,
        lora_alpha=32,
        target_modules=["q_proj", "v_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="SEQ_CLS"
    )
    peft_model = get_peft_model(base_model, lora_config)
    peft_model.print_trainable_parameters()

    train_data = load_from_disk(train_dataset.path)
    val_data = load_from_disk(val_dataset.path)

    args = TrainingArguments(
        output_dir=trained_model.path,
        num_train_epochs=num_epochs,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size,
        learning_rate=learning_rate,
        evaluation_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        fp16=torch.cuda.is_available(),
        report_to="none"
    )

    trainer = Trainer(
        model=peft_model,
        args=args,
        train_dataset=train_data,
        eval_dataset=val_data
    )
    trainer.train()

    # Log metrics to KFP
    eval_results = trainer.evaluate()
    metrics.log_metric("eval_loss", eval_results["eval_loss"])
    metrics.log_metric("eval_accuracy", eval_results.get("eval_accuracy", 0))
    print(f"Eval results: {eval_results}")
```

**Data preprocessing component:**

```python
@dsl.component(
    base_image="python:3.12-slim",
    packages_to_install=["datasets==2.20.0", "transformers==4.43.0"]
)
def preprocess_data(
    raw_data_path: str,
    model_name: str,
    max_length: int,
    train_dataset: Output[Dataset],
    val_dataset: Output[Dataset]
) -> None:
    """Tokenize and split dataset."""
    from datasets import load_dataset
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(model_name)

    dataset = load_dataset("csv", data_files=raw_data_path)["train"]

    def tokenize(examples):
        return tokenizer(
            examples["text"],
            truncation=True,
            padding="max_length",
            max_length=max_length
        )

    tokenized = dataset.map(tokenize, batched=True, remove_columns=["text"])
    split = tokenized.train_test_split(test_size=0.1, seed=42)

    split["train"].save_to_disk(train_dataset.path)
    split["test"].save_to_disk(val_dataset.path)
    print(f"Train: {len(split['train'])} | Val: {len(split['test'])}")
```

**Model evaluation and registry push component:**

```python
@dsl.component(
    base_image="python:3.12-slim",
    packages_to_install=["mlflow==2.15.0", "torch", "transformers"]
)
def evaluate_and_register(
    trained_model: Input[Model],
    val_dataset: Input[Dataset],
    mlflow_tracking_uri: str,
    experiment_name: str,
    model_name: str,
    accuracy_threshold: float,
    approved: Output[dsl.Artifact]
) -> bool:
    """Evaluate model and register if accuracy exceeds threshold."""
    import mlflow
    import mlflow.pytorch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    from datasets import load_from_disk
    import torch

    mlflow.set_tracking_uri(mlflow_tracking_uri)
    mlflow.set_experiment(experiment_name)

    loaded_model = AutoModelForSequenceClassification.from_pretrained(trained_model.path)
    tokenizer = AutoTokenizer.from_pretrained(trained_model.path)
    val_data = load_from_disk(val_dataset.path)

    correct = 0
    sample_size = min(500, len(val_data))
    loaded_model.eval()
    with torch.no_grad():
        for item in val_data.select(range(sample_size)):
            inputs = tokenizer(item["input_ids"], return_tensors="pt")
            logits = loaded_model(**inputs).logits
            pred = logits.argmax(-1).item()
            correct += int(pred == item["label"])

    accuracy = correct / sample_size
    print(f"Validation accuracy: {accuracy:.4f}")

    with mlflow.start_run():
        mlflow.log_metric("accuracy", accuracy)
        mlflow.log_param("model_path", trained_model.path)

        if accuracy >= accuracy_threshold:
            mlflow.pytorch.log_model(
                loaded_model,
                artifact_path="model",
                registered_model_name=model_name
            )
            with open(approved.path, "w") as f:
                f.write("approved")
            return True

    return False
```

### Full Pipeline Definition

```python
# pipeline.py
from kfp import dsl, compiler
from kfp.kubernetes import add_toleration

@dsl.pipeline(
    name="text-classification-training",
    description="Fine-tune a text classifier with LoRA"
)
def training_pipeline(
    raw_data_path: str = "gs://my-bucket/datasets/text-classification.csv",
    base_model: str = "bert-base-uncased",
    num_epochs: int = 3,
    learning_rate: float = 2e-5,
    batch_size: int = 32,
    max_length: int = 128,
    accuracy_threshold: float = 0.85,
    mlflow_uri: str = "http://mlflow.mlops.svc.cluster.local:5000",
    experiment_name: str = "text-classification"
):
    # Step 1: Preprocess
    preprocess_task = preprocess_data(
        raw_data_path=raw_data_path,
        model_name=base_model,
        max_length=max_length
    )

    # Step 2: Train on GPU
    train_task = train_model(
        train_dataset=preprocess_task.outputs["train_dataset"],
        val_dataset=preprocess_task.outputs["val_dataset"],
        model_name=base_model,
        num_epochs=num_epochs,
        learning_rate=learning_rate,
        batch_size=batch_size
    )
    train_task.set_accelerator_type("nvidia.com/gpu")
    train_task.set_accelerator_limit(1)
    train_task.set_memory_request("16G")
    train_task.set_cpu_request("4")
    add_toleration(
        train_task,
        key="nvidia.com/gpu",
        operator="Exists",
        effect="NoSchedule"
    )

    # Step 3: Evaluate and register
    evaluate_and_register(
        trained_model=train_task.outputs["trained_model"],
        val_dataset=preprocess_task.outputs["val_dataset"],
        mlflow_tracking_uri=mlflow_uri,
        experiment_name=experiment_name,
        model_name="text-classifier",
        accuracy_threshold=accuracy_threshold
    )

# Compile to YAML
compiler.Compiler().compile(
    pipeline_func=training_pipeline,
    package_path="text_classification_pipeline.yaml"
)
```

**Submit pipeline run:**

```python
import kfp

client = kfp.Client(host="http://ml-pipeline.kubeflow.svc.cluster.local:8888")

run = client.create_run_from_pipeline_func(
    pipeline_func=training_pipeline,
    arguments={
        "num_epochs": 5,
        "learning_rate": 3e-5,
        "accuracy_threshold": 0.88
    },
    experiment_name="production-training",
    run_name="run-2027-07-18"
)
print(f"Run ID: {run.run_id}")
```

---

## Section 4: Distributed Training with PyTorchJob

For large models, single-GPU training is too slow. The Training Operator's PyTorchJob distributes training across multiple pods using PyTorch Distributed Data Parallel (DDP).

### PyTorchJob for DDP Training

```yaml
# pytorch-ddp-job.yaml
apiVersion: kubeflow.org/v1
kind: PyTorchJob
metadata:
  name: bert-finetune-ddp
  namespace: ml-training
spec:
  pytorchReplicaSpecs:
    Master:
      replicas: 1
      restartPolicy: OnFailure
      template:
        metadata:
          labels:
            job: bert-finetune-ddp
        spec:
          tolerations:
            - key: nvidia.com/gpu
              operator: Exists
              effect: NoSchedule
          containers:
            - name: pytorch
              image: registry.myorg.com/ml/training:bert-v2.3
              command:
                - torchrun
                - --nproc_per_node=2
                - --nnodes=2
                - --node_rank=$(RANK)
                - --master_addr=$(MASTER_ADDR)
                - --master_port=23456
                - /workspace/train_ddp.py
                - --model=bert-large-uncased
                - --epochs=10
                - --batch-size=16
                - --lr=2e-5
                - --output-dir=/models/output
              env:
                - name: MASTER_ADDR
                  value: "bert-finetune-ddp-master-0"
                - name: NCCL_DEBUG
                  value: INFO
              resources:
                requests:
                  cpu: "8"
                  memory: 32Gi
                  nvidia.com/gpu: "2"
                limits:
                  cpu: "16"
                  memory: 64Gi
                  nvidia.com/gpu: "2"
              volumeMounts:
                - name: models
                  mountPath: /models
                - name: shm
                  mountPath: /dev/shm
          volumes:
            - name: models
              persistentVolumeClaim:
                claimName: ml-models-pvc
            - name: shm
              emptyDir:
                medium: Memory
                sizeLimit: 16Gi

    Worker:
      replicas: 1
      restartPolicy: OnFailure
      template:
        spec:
          tolerations:
            - key: nvidia.com/gpu
              operator: Exists
              effect: NoSchedule
          containers:
            - name: pytorch
              image: registry.myorg.com/ml/training:bert-v2.3
              command:
                - torchrun
                - --nproc_per_node=2
                - --nnodes=2
                - --node_rank=$(RANK)
                - --master_addr=$(MASTER_ADDR)
                - --master_port=23456
                - /workspace/train_ddp.py
                - --model=bert-large-uncased
                - --epochs=10
                - --batch-size=16
                - --lr=2e-5
                - --output-dir=/models/output
              resources:
                requests:
                  cpu: "8"
                  memory: 32Gi
                  nvidia.com/gpu: "2"
                limits:
                  cpu: "16"
                  memory: 64Gi
                  nvidia.com/gpu: "2"
              volumeMounts:
                - name: models
                  mountPath: /models
                - name: shm
                  mountPath: /dev/shm
          volumes:
            - name: models
              persistentVolumeClaim:
                claimName: ml-models-pvc
            - name: shm
              emptyDir:
                medium: Memory
                sizeLimit: 16Gi
```

**Monitor training job:**

```bash
# Watch job status
kubectl get pytorchjob bert-finetune-ddp -n ml-training -w

# Check training logs
kubectl logs -n ml-training \
  $(kubectl get pods -n ml-training -l job-name=bert-finetune-ddp \
    -o jsonpath='{.items[0].metadata.name}') -f

# List all training jobs with status
kubectl get pytorchjobs --all-namespaces \
  -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,STATUS:.status.conditions[-1].type,AGE:.metadata.creationTimestamp'
```

### TFJob for TensorFlow Distributed Training

```yaml
apiVersion: kubeflow.org/v1
kind: TFJob
metadata:
  name: resnet-training
  namespace: ml-training
spec:
  tfReplicaSpecs:
    PS:
      replicas: 1
      restartPolicy: OnFailure
      template:
        spec:
          containers:
            - name: tensorflow
              image: tensorflow/tensorflow:2.15.0-gpu
              command:
                - python3
                - /workspace/train_ps.py
              resources:
                requests:
                  cpu: "4"
                  memory: 16Gi
                  nvidia.com/gpu: "1"
                limits:
                  cpu: "8"
                  memory: 32Gi
                  nvidia.com/gpu: "1"
    Worker:
      replicas: 4
      restartPolicy: OnFailure
      template:
        spec:
          tolerations:
            - key: nvidia.com/gpu
              operator: Exists
              effect: NoSchedule
          containers:
            - name: tensorflow
              image: tensorflow/tensorflow:2.15.0-gpu
              command:
                - python3
                - /workspace/train_worker.py
              resources:
                requests:
                  cpu: "8"
                  memory: 32Gi
                  nvidia.com/gpu: "2"
                limits:
                  cpu: "16"
                  memory: 64Gi
                  nvidia.com/gpu: "2"
```

---

## Section 5: Hyperparameter Tuning with Katib

Katib automates hyperparameter search using Bayesian optimization, CMA-ES, random search, and grid search.

### Experiment Definition

```yaml
# katib-experiment.yaml
apiVersion: kubeflow.org/v1beta1
kind: Experiment
metadata:
  name: bert-hparam-search
  namespace: ml-training
spec:
  objective:
    type: maximize
    goal: 0.92
    objectiveMetricName: accuracy
    additionalMetricNames:
      - loss
  algorithm:
    algorithmName: bayesianoptimization
    algorithmSettings:
      - name: random_state
        value: "42"
  parallelTrialCount: 4
  maxTrialCount: 30
  maxFailedTrialCount: 5
  parameters:
    - name: learning_rate
      parameterType: double
      feasibleSpace:
        min: "1e-5"
        max: "5e-4"
    - name: batch_size
      parameterType: int
      feasibleSpace:
        min: "8"
        max: "64"
        step: "8"
    - name: warmup_ratio
      parameterType: double
      feasibleSpace:
        min: "0.0"
        max: "0.2"
    - name: weight_decay
      parameterType: double
      feasibleSpace:
        list:
          - "0.0"
          - "0.01"
          - "0.1"
  trialTemplate:
    primaryContainerName: training-container
    trialParameters:
      - name: learning_rate
        description: Learning rate
        reference: learning_rate
      - name: batch_size
        description: Batch size
        reference: batch_size
      - name: warmup_ratio
        description: Warmup ratio
        reference: warmup_ratio
      - name: weight_decay
        description: Weight decay
        reference: weight_decay
    trialSpec:
      apiVersion: batch/v1
      kind: Job
      spec:
        template:
          spec:
            tolerations:
              - key: nvidia.com/gpu
                operator: Exists
                effect: NoSchedule
            containers:
              - name: training-container
                image: registry.myorg.com/ml/training:bert-v2.3
                command:
                  - python3
                  - /workspace/train_katib.py
                  - --learning-rate
                  - "${trialParameters.learning_rate}"
                  - --batch-size
                  - "${trialParameters.batch_size}"
                  - --warmup-ratio
                  - "${trialParameters.warmup_ratio}"
                  - --weight-decay
                  - "${trialParameters.weight_decay}"
                resources:
                  requests:
                    cpu: "4"
                    memory: 16Gi
                    nvidia.com/gpu: "1"
                  limits:
                    cpu: "8"
                    memory: 32Gi
                    nvidia.com/gpu: "1"
            restartPolicy: Never
```

**Training script instrumented for Katib metric output:**

```python
# train_katib.py
"""Training script that emits metrics to stdout for Katib collection."""
import argparse
import sys

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--warmup-ratio", type=float, default=0.06)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    return parser.parse_args()

def run_training(lr, batch_size, warmup_ratio, weight_decay):
    """Replace with actual training loop using TrainingArguments."""
    # ... model loading, data loading, trainer.train() ...
    accuracy = 0.91   # Actual result from trainer.evaluate()
    loss = 0.23       # Actual result from trainer.evaluate()
    return accuracy, loss

def main():
    args = parse_args()
    accuracy, loss = run_training(
        args.learning_rate,
        args.batch_size,
        args.warmup_ratio,
        args.weight_decay
    )
    # Katib reads metrics from stdout in this exact key=value format
    print(f"accuracy={accuracy:.4f}")
    print(f"loss={loss:.4f}")
    sys.stdout.flush()

if __name__ == "__main__":
    main()
```

**Monitor Katib experiment:**

```bash
# Watch experiment progress
kubectl get experiment bert-hparam-search -n ml-training -w

# List all trials with results
kubectl get trials -n ml-training \
  -l katib.kubeflow.org/experiment=bert-hparam-search \
  -o custom-columns=\
'NAME:.metadata.name,STATUS:.status.conditions[-1].type,ACCURACY:.status.observation.metrics[0].latest'

# Get best hyperparameters
kubectl get experiment bert-hparam-search -n ml-training \
  -o jsonpath='{.status.currentOptimalTrial.parameterAssignments}' | jq .
```

---

## Section 6: Model Registry and Versioning with MLflow

MLflow provides experiment tracking, model versioning, and a model registry with lifecycle stages (Staging, Production, Archived).

### MLflow Deployment on Kubernetes

```yaml
# mlflow-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mlflow
  namespace: mlops
spec:
  replicas: 2
  selector:
    matchLabels:
      app: mlflow
  template:
    metadata:
      labels:
        app: mlflow
    spec:
      containers:
        - name: mlflow
          image: ghcr.io/mlflow/mlflow:v2.15.0
          command:
            - mlflow
            - server
            - --host
            - "0.0.0.0"
            - --port
            - "5000"
            - --backend-store-uri
            - "postgresql://$(DB_USER):$(DB_PASS)@$(DB_HOST):5432/mlflow"
            - --default-artifact-root
            - "s3://my-org-mlflow-artifacts"
            - --serve-artifacts
          env:
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: mlflow-db-credentials
                  key: username
            - name: DB_PASS
              valueFrom:
                secretKeyRef:
                  name: mlflow-db-credentials
                  key: password
            - name: DB_HOST
              value: "postgresql.mlops.svc.cluster.local"
            - name: AWS_DEFAULT_REGION
              value: "us-east-1"
          ports:
            - containerPort: 5000
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi
          livenessProbe:
            httpGet:
              path: /health
              port: 5000
            initialDelaySeconds: 30
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 5000
            initialDelaySeconds: 15
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: mlflow
  namespace: mlops
spec:
  selector:
    app: mlflow
  ports:
    - port: 5000
      targetPort: 5000
```

### Logging Experiments from Pipelines

```python
# mlflow_integration.py
import mlflow
import mlflow.pytorch
from mlflow.tracking import MlflowClient

MLFLOW_URI = "http://mlflow.mlops.svc.cluster.local:5000"
mlflow.set_tracking_uri(MLFLOW_URI)

def log_training_run(
    model,
    params: dict,
    metrics: dict,
    model_name: str,
    promote_to_staging: bool = False
):
    """Log a training run and optionally promote to staging."""
    client = MlflowClient()

    with mlflow.start_run() as run:
        mlflow.log_params(params)
        mlflow.log_metrics(metrics)

        mlflow.pytorch.log_model(
            model,
            artifact_path="model",
            registered_model_name=model_name
        )

        run_id = run.info.run_id
        print(f"Run ID: {run_id}")

    if promote_to_staging and metrics.get("accuracy", 0) > 0.85:
        versions = client.get_latest_versions(model_name, stages=["None"])
        if versions:
            version = versions[0].version
            client.transition_model_version_stage(
                name=model_name,
                version=version,
                stage="Staging",
                archive_existing_versions=False
            )
            print(f"Promoted {model_name} v{version} to Staging")

    return run_id
```

---

## Section 7: KServe InferenceService Deployment

KServe provides a Kubernetes-native model serving platform with autoscaling, traffic splitting, and runtime selection.

### Basic InferenceService

```yaml
# kserve-inference-service.yaml
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: text-classifier
  namespace: ml-serving
  annotations:
    serving.kserve.io/deploymentMode: Serverless
spec:
  predictor:
    minReplicas: 1
    maxReplicas: 10
    scaleTarget: 5
    scaleMetric: rps
    pytorch:
      storageUri: "s3://my-org-models/text-classifier/v3"
      runtimeVersion: "2.1.0"
      resources:
        requests:
          cpu: "2"
          memory: 4Gi
          nvidia.com/gpu: "1"
        limits:
          cpu: "8"
          memory: 16Gi
          nvidia.com/gpu: "1"
```

### MLflow Model Server via KServe

```yaml
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: text-classifier-mlflow
  namespace: ml-serving
spec:
  predictor:
    minReplicas: 1
    maxReplicas: 5
    model:
      modelFormat:
        name: mlflow
      storageUri: "s3://my-org-mlflow-artifacts/1/abc123def456/artifacts/model"
      resources:
        requests:
          cpu: "1"
          memory: 2Gi
        limits:
          cpu: "4"
          memory: 8Gi
```

### Canary Rollout for Model Updates

KServe supports canary traffic splitting between model versions at the InferenceService level:

```yaml
# kserve-canary-rollout.yaml
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: text-classifier
  namespace: ml-serving
spec:
  predictor:
    minReplicas: 2
    maxReplicas: 10
    canaryTrafficPercent: 20
    model:
      modelFormat:
        name: pytorch
      storageUri: "s3://my-org-models/text-classifier/v4"
      runtime: kserve-torchserve
      resources:
        requests:
          cpu: "2"
          memory: 4Gi
        limits:
          cpu: "8"
          memory: 16Gi
```

**Promote canary to 100% after validation:**

```bash
# Monitor canary metrics
kubectl get inferenceservice text-classifier -n ml-serving -o yaml \
  | grep -A5 "traffic"

# Gradually increase canary percentage
kubectl patch inferenceservice text-classifier -n ml-serving \
  --type=merge \
  -p '{"spec": {"predictor": {"canaryTrafficPercent": 50}}}'

# Promote to 100% (removes canary split)
kubectl patch inferenceservice text-classifier -n ml-serving \
  --type=merge \
  -p '{"spec": {"predictor": {"canaryTrafficPercent": 100}}}'
```

**Query the inference service:**

```bash
# Get the inference service URL
ISVC_URL=$(kubectl get inferenceservice text-classifier -n ml-serving \
  -o jsonpath='{.status.url}')

# Predict
curl -sf "${ISVC_URL}/v1/models/text-classifier:predict" \
  -H "Content-Type: application/json" \
  -d '{"instances": [{"text": "This product is excellent!"}]}' \
  | jq '.predictions'
```

---

## Section 8: Model Drift Monitoring

Production models degrade over time as input data distributions shift. Monitoring drift ensures models are retrained before accuracy degrades significantly.

### Prometheus-Based Drift Alerting

```python
# drift_monitor.py — runs as a Kubernetes CronJob
"""Monitor prediction distribution for statistical drift."""
import json
import requests
from scipy.stats import ks_2samp
from prometheus_client import Gauge, push_to_gateway, CollectorRegistry

REGISTRY = CollectorRegistry()
drift_score_gauge = Gauge(
    "model_drift_score",
    "KS test drift score vs baseline",
    ["model_name", "feature"],
    registry=REGISTRY
)
drift_detected_gauge = Gauge(
    "model_drift_detected",
    "1 if drift detected, 0 otherwise",
    ["model_name"],
    registry=REGISTRY
)

PUSHGATEWAY = "http://prometheus-pushgateway.monitoring.svc.cluster.local:9091"

def load_baseline_predictions(path: str) -> list:
    with open(path) as f:
        return json.load(f)["predictions"]

def compute_drift(
    baseline_preds: list,
    current_preds: list,
    model_name: str
) -> tuple:
    stat, p_value = ks_2samp(baseline_preds, current_preds)
    drift_score_gauge.labels(
        model_name=model_name, feature="confidence"
    ).set(stat)
    drift_detected_gauge.labels(model_name=model_name).set(
        1 if p_value < 0.05 else 0
    )
    if p_value < 0.05:
        print(f"DRIFT DETECTED: {model_name} KS={stat:.4f} p={p_value:.4f}")
    push_to_gateway(PUSHGATEWAY, job="drift-monitor", registry=REGISTRY)
    return stat, p_value
```

**Alert rule for model drift:**

```yaml
# drift-alert.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: model-drift-alerts
  namespace: monitoring
spec:
  groups:
    - name: mlops.drift
      rules:
        - alert: ModelDriftDetected
          expr: model_drift_detected == 1
          for: 0m
          labels:
            severity: warning
            team: ml-platform
          annotations:
            summary: "Model drift detected for {{ $labels.model_name }}"
            description: >
              Prediction distribution has shifted significantly.
              Consider triggering a retraining pipeline.

        - alert: ModelDriftHighScore
          expr: model_drift_score > 0.3
          for: 15m
          labels:
            severity: critical
          annotations:
            summary: "High drift score for {{ $labels.model_name }}"
            description: >
              KS drift score = {{ $value }}.
              Model should be retrained immediately.
```

---

## Section 9: RBAC for Multi-Tenant ML Platform

### Kubeflow Profiles for Team Isolation

Kubeflow Profiles create isolated namespaces with controlled access for each ML team:

```yaml
# kubeflow-profile-ml-team.yaml
apiVersion: kubeflow.org/v1
kind: Profile
metadata:
  name: team-nlp
spec:
  owner:
    kind: User
    name: alice@myorg.com
  resourceQuotaSpec:
    hard:
      cpu: "50"
      memory: 200Gi
      requests.nvidia.com/gpu: "4"
      persistentvolumeclaims: "10"
      pods: "50"
  plugins:
    - kind: WorkloadIdentity
      spec:
        gcpServiceAccount: kubeflow-team-nlp@my-project.iam.gserviceaccount.com
```

### RBAC for Pipeline Access

```yaml
# pipeline-developer-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pipeline-developer
  namespace: team-nlp
rules:
  - apiGroups: ["pipelines.kubeflow.org"]
    resources: ["pipelines", "runs", "jobs", "experiments"]
    verbs: ["create", "get", "list", "update", "delete"]
  - apiGroups: ["kubeflow.org"]
    resources: ["pytorchjobs", "tfjobs"]
    verbs: ["create", "get", "list", "watch"]
  - apiGroups: ["serving.kserve.io"]
    resources: ["inferenceservices"]
    verbs: ["create", "get", "list", "update"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["create", "get", "list", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: nlp-team-developer-binding
  namespace: team-nlp
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: pipeline-developer
subjects:
  - kind: User
    name: alice@myorg.com
  - kind: User
    name: bob@myorg.com
  - kind: Group
    name: team-nlp-developers
```

### Restricting Cross-Namespace Model Access

```yaml
# network-policy-ml-isolation.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ml-namespace-isolation
  namespace: team-nlp
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: team-nlp
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kubeflow
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: mlops
      ports:
        - port: 5000
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 443
```

---

## Section 10: End-to-End MLOps Pipeline Automation

### Triggering Retraining from Drift Detection

```python
#!/usr/bin/env python3
"""drift_triggered_retrain.py — Automatically trigger retraining on drift."""
import kfp

KFP_HOST = "http://ml-pipeline.kubeflow.svc.cluster.local:8888"
PIPELINE_NAME = "text-classification-training"

def trigger_retraining(model_name: str, drift_ks_score: float) -> str:
    """Submit a new pipeline run when drift is detected."""
    client = kfp.Client(host=KFP_HOST)

    pipeline_list = client.list_pipelines(filter=f'name="{PIPELINE_NAME}"')
    if not pipeline_list.pipelines:
        raise ValueError(f"Pipeline '{PIPELINE_NAME}' not found in KFP registry")

    pipeline_id = pipeline_list.pipelines[0].id
    experiment = client.get_experiment(experiment_name="auto-retrain")

    run = client.run_pipeline(
        experiment_id=experiment.id,
        job_name=f"drift-retrain-{model_name}",
        pipeline_id=pipeline_id,
        params={
            "num_epochs": "5",
            "learning_rate": "2e-5",
            "accuracy_threshold": "0.87"
        }
    )
    print(
        f"Triggered retraining run: {run.run_id} "
        f"(drift KS score: {drift_ks_score:.4f})"
    )
    return run.run_id
```

### Pipeline Notification on Completion

```python
@dsl.component(
    base_image="python:3.12-slim",
    packages_to_install=["requests"]
)
def notify_completion(
    run_status: str,
    accuracy: float,
    model_name: str,
    slack_webhook_url: str
) -> None:
    """Send Slack notification on pipeline completion."""
    import requests
    import json

    color = "good" if run_status == "Succeeded" else "danger"
    payload = {
        "attachments": [{
            "color": color,
            "title": f"ML Pipeline Completed: {model_name}",
            "fields": [
                {"title": "Status", "value": run_status, "short": True},
                {"title": "Accuracy", "value": f"{accuracy:.4f}", "short": True}
            ],
            "footer": "Kubeflow Pipelines"
        }]
    }
    # webhook_url injected from Kubernetes Secret via env var
    requests.post(slack_webhook_url, data=json.dumps(payload), timeout=10)
```

---

## Section 11: Monitoring the ML Platform

### Key Prometheus Metrics

```promql
# Pipeline run success rate over 24 hours
sum(kfp_run_status{status="Succeeded"}[24h])
/
sum(kfp_run_status[24h])

# Average training job duration
avg by (job_type) (
  kube_job_status_completion_time - kube_job_status_start_time
)

# KServe request latency P99
histogram_quantile(0.99,
  rate(revision_request_latencies_bucket{namespace="ml-serving"}[5m])
)

# KServe error rate
rate(revision_request_count{namespace="ml-serving",response_code!="200"}[5m])
/
rate(revision_request_count{namespace="ml-serving"}[5m])

# GPU utilization across training jobs
avg by (kubernetes_pod_name) (
  DCGM_FI_DEV_GPU_UTIL{namespace="ml-training"}
)
```

### Alert Rules for ML Platform

```yaml
# mlops-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: mlops-alerts
  namespace: monitoring
spec:
  groups:
    - name: mlops.health
      rules:
        - alert: TrainingJobFailed
          expr: |
            kube_job_status_failed{namespace=~"ml-training|team-.*"} > 0
          for: 0m
          labels:
            severity: warning
            team: ml-platform
          annotations:
            summary: "Training job failed: {{ $labels.job_name }}"
            description: >
              Kubernetes Job {{ $labels.job_name }} in namespace
              {{ $labels.namespace }} failed. Check pod logs for details.

        - alert: KServeHighErrorRate
          expr: |
            (
              rate(revision_request_count{
                namespace="ml-serving",
                response_code!~"2.."
              }[5m])
              /
              rate(revision_request_count{namespace="ml-serving"}[5m])
            ) > 0.05
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "KServe error rate >5% for {{ $labels.configuration_name }}"
            description: >
              Error rate = {{ $value | humanizePercentage }}.
              Check model health and recent deployments.

        - alert: GPUJobStuck
          expr: |
            kube_job_status_active{namespace=~"ml-training|team-.*"} > 0
            and
            (time() - kube_job_status_start_time{
              namespace=~"ml-training|team-.*"
            }) > 7200
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Training job running for >2 hours: {{ $labels.job_name }}"
            description: >
              Training job {{ $labels.job_name }} has been active for more than
              2 hours. Verify the job is making progress and not stuck.
```

---

## Section 12: Production MLOps Checklist

```
Infrastructure
  [ ] Kubeflow Pipelines, Training Operator, KServe, Katib installed
  [ ] MLflow deployed with PostgreSQL backend and S3 artifact store
  [ ] GPU nodes available with NVIDIA Operator
  [ ] Kubeflow Profiles created for each ML team

Pipelines
  [ ] All pipeline components use versioned container images
  [ ] Secrets accessed via Kubernetes Secrets, not hardcoded
  [ ] Pipeline artifacts stored in versioned S3 paths
  [ ] Failure notifications configured

Training
  [ ] PyTorchJob / TFJob with appropriate GPU resource limits
  [ ] /dev/shm mounted for multi-GPU NCCL communication
  [ ] Training logs exported to central logging system

Model Serving
  [ ] InferenceService with minReplicas: 1 and autoscaling configured
  [ ] Canary traffic split tested before full promotion
  [ ] Model signatures logged to MLflow for validation
  [ ] Liveness and readiness probes configured

Monitoring
  [ ] Drift monitoring CronJob scheduled
  [ ] Alert rules for training failures and serving errors
  [ ] GPU utilization tracked per team namespace
  [ ] Model performance metrics in Grafana dashboard

Security
  [ ] Profiles enforce namespace isolation
  [ ] NetworkPolicy restricts cross-team access
  [ ] RBAC prevents non-owners from deleting production models
  [ ] HuggingFace and S3 credentials stored in Kubernetes Secrets
```

---

## Summary

Kubeflow provides the operational primitives for enterprise ML at Kubernetes scale. Pipelines DSL enables reproducible, versioned workflows. Training Operator distributes model training across GPU clusters without bespoke infrastructure. Katib removes the human bottleneck from hyperparameter search. KServe delivers canary-safe model rollouts with autoscaling. MLflow closes the loop with experiment tracking and model registry integration.

The architecture described here supports multiple teams sharing GPU infrastructure safely through Profiles and RBAC, while drift monitoring and automated retraining pipelines ensure model quality is maintained over time. The result is an ML platform that meets the operational standards already applied to production application infrastructure.
