---
title: "AI/ML Workloads with Kubeflow: Enterprise Machine Learning Platform on Kubernetes"
date: 2026-04-25T00:00:00-05:00
draft: false
tags: ["Kubeflow", "Machine Learning", "AI", "Kubernetes", "MLOps", "TensorFlow", "PyTorch", "Model Training"]
categories: ["Machine Learning", "Kubernetes", "MLOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing AI/ML workloads with Kubeflow on Kubernetes, including pipeline orchestration, distributed training, model serving, experiment tracking, and production-ready MLOps patterns."
more_link: "yes"
url: "/aiml-workloads-kubeflow-enterprise-guide/"
---

Kubeflow provides a comprehensive machine learning platform on Kubernetes, enabling end-to-end ML workflows from experimentation to production. This guide covers implementing enterprise-grade ML infrastructure with Kubeflow, including pipeline orchestration, distributed training, model serving, and operational best practices.

<!--more-->

# AI/ML Workloads with Kubeflow: Enterprise Machine Learning Platform on Kubernetes

## Executive Summary

Kubeflow brings machine learning workflows to Kubernetes, providing tools for experiment tracking, pipeline orchestration, distributed training, hyperparameter tuning, and model serving. This guide provides practical implementation strategies for deploying production-grade ML platforms that enable data scientists and ML engineers to build, train, and deploy models at scale.

## Understanding Kubeflow Architecture

### Kubeflow Components Overview

**Kubeflow Platform Architecture:**
```yaml
# kubeflow-architecture.yaml
apiVersion: architecture.kubeflow.org/v1
kind: KubeflowArchitecture
metadata:
  name: enterprise-ml-platform
spec:
  coreComponents:
    kubeflowPipelines:
      description: "ML workflow orchestration"
      features:
        - "DAG-based pipeline definitions"
        - "Containerized steps"
        - "Artifact tracking"
        - "Pipeline versioning"
        - "Scheduled and triggered runs"
      storage:
        - "MinIO for artifacts"
        - "MySQL for metadata"

    notebooks:
      description: "Interactive development environment"
      features:
        - "JupyterLab interface"
        - "Pre-configured ML frameworks"
        - "GPU support"
        - "Persistent storage"
        - "Shared workspaces"

    training:
      operators:
        - name: "TFJob"
          framework: "TensorFlow"
          features: ["Distributed training", "Parameter server", "AllReduce"]
        - name: "PyTorchJob"
          framework: "PyTorch"
          features: ["Distributed training", "Gloo/NCCL backend"]
        - name: "MXNetJob"
          framework: "MXNet"
          features: ["Distributed training", "Parameter server"]
        - name: "XGBoostJob"
          framework: "XGBoost"
          features: ["Distributed XGBoost"]

    hyperparameterTuning:
      name: "Katib"
      features:
        - "Neural architecture search"
        - "Hyperparameter optimization"
        - "Early stopping"
        - "Multiple search algorithms"
      algorithms:
        - "Random search"
        - "Grid search"
        - "Bayesian optimization"
        - "Hyperband"

    modelServing:
      options:
        - name: "KServe"
          features:
            - "Multi-framework support"
            - "Auto-scaling"
            - "Canary rollouts"
            - "A/B testing"
            - "Explainability"
        - name: "Seldon Core"
          features:
            - "Advanced routing"
            - "Model monitoring"
            - "Outlier detection"

    metadata:
      name: "ML Metadata"
      features:
        - "Experiment tracking"
        - "Artifact lineage"
        - "Model registry"
        - "Dataset versioning"

  supportingServices:
    storage:
      - name: "MinIO"
        purpose: "Artifact storage"
      - name: "NFS/Ceph"
        purpose: "Shared datasets"

    databases:
      - name: "MySQL"
        purpose: "Pipeline metadata"
      - name: "PostgreSQL"
        purpose: "Katib experiments"

    monitoring:
      - "Prometheus for metrics"
      - "Grafana for dashboards"
      - "TensorBoard for training"

  mlWorkflow:
    dataPreparation:
      - "Data ingestion pipelines"
      - "Feature engineering"
      - "Data validation"
      - "Dataset versioning"

    experimentation:
      - "Interactive notebooks"
      - "Experiment tracking"
      - "Hyperparameter tuning"
      - "Model comparison"

    training:
      - "Single-node training"
      - "Distributed training"
      - "GPU acceleration"
      - "Training monitoring"

    evaluation:
      - "Model validation"
      - "Performance metrics"
      - "Model comparison"
      - "Fairness analysis"

    deployment:
      - "Model serving"
      - "A/B testing"
      - "Canary releases"
      - "Production monitoring"
```

### ML Platform Technology Stack

**Technology Selection Matrix:**
```go
// ml_platform_stack.go
package mlplatform

import (
    "fmt"
)

type MLComponent struct {
    Name           string
    Purpose        string
    Alternatives   []string
    Recommendation string
    UseCases       []string
}

func GetMLPlatformStack() []MLComponent {
    return []MLComponent{
        {
            Name:    "Kubeflow Pipelines",
            Purpose: "Workflow orchestration",
            Alternatives: []string{
                "Apache Airflow",
                "Argo Workflows",
                "MLflow",
                "Prefect",
            },
            Recommendation: "Best for ML-specific workflows with artifact tracking",
            UseCases: []string{
                "End-to-end ML pipelines",
                "Reproducible experiments",
                "Production model training",
            },
        },
        {
            Name:    "KServe (KFServing)",
            Purpose: "Model serving",
            Alternatives: []string{
                "TensorFlow Serving",
                "TorchServe",
                "Seldon Core",
                "BentoML",
            },
            Recommendation: "Best for multi-framework serving with auto-scaling",
            UseCases: []string{
                "Production inference",
                "A/B testing",
                "Canary deployments",
            },
        },
        {
            Name:    "Katib",
            Purpose: "Hyperparameter tuning",
            Alternatives: []string{
                "Ray Tune",
                "Optuna",
                "Hyperopt",
                "Azure ML HyperDrive",
            },
            Recommendation: "Best for Kubernetes-native HPO",
            UseCases: []string{
                "Model optimization",
                "Neural architecture search",
                "AutoML",
            },
        },
        {
            Name:    "Jupyter Notebooks",
            Purpose: "Interactive development",
            Alternatives: []string{
                "VS Code",
                "RStudio",
                "Zeppelin",
                "Google Colab",
            },
            Recommendation: "Standard for data science workflows",
            UseCases: []string{
                "Exploratory data analysis",
                "Model prototyping",
                "Visualization",
            },
        },
        {
            Name:    "MLflow",
            Purpose: "Experiment tracking",
            Alternatives: []string{
                "Weights & Biases",
                "Neptune.ai",
                "Comet.ml",
                "TensorBoard",
            },
            Recommendation: "Can integrate with Kubeflow for tracking",
            UseCases: []string{
                "Experiment logging",
                "Model registry",
                "Artifact storage",
            },
        },
    }
}

func PrintMLStack() {
    stack := GetMLPlatformStack()

    fmt.Println("===== Enterprise ML Platform Stack =====\n")

    for _, component := range stack {
        fmt.Printf("%s\n", component.Name)
        fmt.Printf("  Purpose: %s\n", component.Purpose)
        fmt.Printf("  Recommendation: %s\n", component.Recommendation)
        fmt.Printf("  Use Cases:\n")
        for _, uc := range component.UseCases {
            fmt.Printf("    - %s\n", uc)
        }
        fmt.Printf("  Alternatives: %v\n\n", component.Alternatives)
    }
}

// ML workload resource requirements
type ResourceProfile struct {
    Name        string
    CPUCores    int
    MemoryGB    int
    GPUCount    int
    GPUType     string
    StorageGB   int
    NetworkGbps int
}

func GetMLResourceProfiles() []ResourceProfile {
    return []ResourceProfile{
        {
            Name:        "Data Preprocessing",
            CPUCores:    16,
            MemoryGB:    64,
            GPUCount:    0,
            StorageGB:   500,
            NetworkGbps: 10,
        },
        {
            Name:        "Small Model Training",
            CPUCores:    8,
            MemoryGB:    32,
            GPUCount:    1,
            GPUType:     "NVIDIA T4",
            StorageGB:   100,
            NetworkGbps: 10,
        },
        {
            Name:        "Large Model Training",
            CPUCores:    32,
            MemoryGB:    128,
            GPUCount:    4,
            GPUType:     "NVIDIA A100",
            StorageGB:   1000,
            NetworkGbps: 100,
        },
        {
            Name:        "Distributed Training",
            CPUCores:    64,
            MemoryGB:    256,
            GPUCount:    8,
            GPUType:     "NVIDIA A100",
            StorageGB:   2000,
            NetworkGbps: 200,
        },
        {
            Name:        "Model Serving",
            CPUCores:    4,
            MemoryGB:    16,
            GPUCount:    1,
            GPUType:     "NVIDIA T4",
            StorageGB:   50,
            NetworkGbps: 10,
        },
        {
            Name:        "Batch Inference",
            CPUCores:    16,
            MemoryGB:    64,
            GPUCount:    2,
            GPUType:     "NVIDIA V100",
            StorageGB:   200,
            NetworkGbps: 25,
        },
    }
}
```

## Kubeflow Installation and Configuration

### Production Kubeflow Deployment

**Complete Kubeflow Installation:**
```bash
#!/bin/bash
# install-kubeflow.sh
# Deploy production-grade Kubeflow on Kubernetes

set -euo pipefail

KUBEFLOW_VERSION="1.8.0"
KUSTOMIZE_VERSION="5.0.0"

echo "Installing Kubeflow ${KUBEFLOW_VERSION}..."

# Install kustomize
echo "Installing kustomize..."
wget https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${KUSTOMIZE_VERSION}/kustomize_v${KUSTOMIZE_VERSION}_linux_amd64.tar.gz
tar -xzf kustomize_v${KUSTOMIZE_VERSION}_linux_amd64.tar.gz
sudo mv kustomize /usr/local/bin/
rm kustomize_v${KUSTOMIZE_VERSION}_linux_amd64.tar.gz

# Clone Kubeflow manifests
echo "Cloning Kubeflow manifests..."
git clone https://github.com/kubeflow/manifests.git
cd manifests
git checkout v${KUBEFLOW_VERSION}

# Install cert-manager (required for Kubeflow)
echo "Installing cert-manager..."
kustomize build common/cert-manager/cert-manager/base | kubectl apply -f -
kubectl wait --for=condition=ready pod -l 'app in (cert-manager,webhook)' \
    --timeout=180s -n cert-manager

kustomize build common/cert-manager/kubeflow-issuer/base | kubectl apply -f -

# Install Istio for service mesh
echo "Installing Istio..."
kustomize build common/istio-1-17/istio-crds/base | kubectl apply -f -
kustomize build common/istio-1-17/istio-namespace/base | kubectl apply -f -
kustomize build common/istio-1-17/istio-install/base | kubectl apply -f -

# Install Dex for authentication
echo "Installing Dex..."
kustomize build common/dex/overlays/istio | kubectl apply -f -

# Install OIDC AuthService
echo "Installing AuthService..."
kustomize build common/oidc-authservice/base | kubectl apply -f -

# Install Knative Serving (optional, for KServe)
echo "Installing Knative Serving..."
kustomize build common/knative/knative-serving/overlays/gateways | kubectl apply -f -
kustomize build common/istio-1-17/cluster-local-gateway/base | kubectl apply -f -

# Install Kubeflow Namespace
echo "Creating Kubeflow namespace..."
kustomize build common/kubeflow-namespace/base | kubectl apply -f -

# Install Kubeflow Roles
echo "Installing Kubeflow roles..."
kustomize build common/kubeflow-roles/base | kubectl apply -f -

# Install Kubeflow Istio Resources
echo "Installing Kubeflow Istio resources..."
kustomize build common/istio-1-17/kubeflow-istio-resources/base | kubectl apply -f -

# Install Kubeflow Pipelines
echo "Installing Kubeflow Pipelines..."
kustomize build apps/pipeline/upstream/env/cert-manager/platform-agnostic-multi-user | kubectl apply -f -

# Install KServe
echo "Installing KServe..."
kustomize build contrib/kserve/kserve | kubectl apply -f -
kustomize build contrib/kserve/models-web-app/overlays/kubeflow | kubectl apply -f -

# Install Katib
echo "Installing Katib..."
kustomize build apps/katib/upstream/installs/katib-with-kubeflow | kubectl apply -f -

# Install Central Dashboard
echo "Installing Central Dashboard..."
kustomize build apps/centraldashboard/upstream/overlays/kserve | kubectl apply -f -

# Install Admission Webhook
echo "Installing Admission Webhook..."
kustomize build apps/admission-webhook/upstream/overlays/cert-manager | kubectl apply -f -

# Install Notebook Controller
echo "Installing Notebook Controller..."
kustomize build apps/jupyter/notebook-controller/upstream/overlays/kubeflow | kubectl apply -f -

# Install Jupyter Web App
echo "Installing Jupyter Web App..."
kustomize build apps/jupyter/jupyter-web-app/upstream/overlays/istio | kubectl apply -f -

# Install Profiles + KFAM
echo "Installing Profiles..."
kustomize build apps/profiles/upstream/overlays/kubeflow | kubectl apply -f -

# Install Volumes Web App
echo "Installing Volumes Web App..."
kustomize build apps/volumes-web-app/upstream/overlays/istio | kubectl apply -f -

# Install Tensorboard Controller
echo "Installing Tensorboard Controller..."
kustomize build apps/tensorboard/tensorboard-controller/upstream/overlays/kubeflow | kubectl apply -f -

# Install Tensorboard Web App
echo "Installing Tensorboard Web App..."
kustomize build apps/tensorboard/tensorboards-web-app/upstream/overlays/istio | kubectl apply -f -

# Install Training Operator
echo "Installing Training Operator..."
kustomize build apps/training-operator/upstream/overlays/kubeflow | kubectl apply -f -

# Install User Namespace
echo "Creating user namespace..."
kustomize build common/user-namespace/base | kubectl apply -f -

echo "Waiting for Kubeflow components to be ready..."
kubectl wait --for=condition=ready pod --all -n kubeflow --timeout=600s

echo "Kubeflow installation complete!"
echo ""
echo "Access Kubeflow Dashboard:"
echo "kubectl port-forward svc/istio-ingressgateway -n istio-system 8080:80"
echo "Then open: http://localhost:8080"
echo ""
echo "Default credentials:"
echo "Email: user@example.com"
echo "Password: 12341234"
```

**Kubeflow Configuration:**
```yaml
# kubeflow-configuration.yaml
---
# GPU Node Pool Configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: gpu-config
  namespace: kubeflow
data:
  gpu-allocation.yaml: |
    # NVIDIA GPU node labels
    nodeSelector:
      cloud.google.com/gke-accelerator: nvidia-tesla-a100
      # or
      node.kubernetes.io/instance-type: p3.8xlarge

    # GPU resource limits
    resources:
      limits:
        nvidia.com/gpu: 1

    # NVIDIA device plugin daemonset
    tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule

---
# Notebook Server Configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: notebook-images
  namespace: kubeflow
data:
  spawner_ui_config.yaml: |
    spawnerFormDefaults:
      image:
        value: gcr.io/kubeflow-images-public/tensorflow-2.11.0-notebook-cpu:1.8.0
        options:
          - gcr.io/kubeflow-images-public/tensorflow-2.11.0-notebook-cpu:1.8.0
          - gcr.io/kubeflow-images-public/tensorflow-2.11.0-notebook-gpu:1.8.0
          - gcr.io/kubeflow-images-public/pytorch-1.13.0-notebook-cpu:1.8.0
          - gcr.io/kubeflow-images-public/pytorch-1.13.0-notebook-gpu:1.8.0
          - company/custom-ml-notebook:latest

      cpu:
        value: '2.0'
        readOnly: false
      memory:
        value: 4.0Gi
        readOnly: false

      workspaceVolume:
        value:
          mount: /home/jovyan
          newPvc:
            metadata:
              name: '{notebook-name}-workspace'
            spec:
              resources:
                requests:
                  storage: 10Gi
              accessModes:
                - ReadWriteOnce

      dataVolumes:
        value: []
        readOnly: false

      gpus:
        value:
          num: '0'
          vendors:
            - limitsKey: nvidia.com/gpu
              uiName: NVIDIA
          vendor: ''

---
# Pipeline Configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: pipeline-install-config
  namespace: kubeflow
data:
  config.yaml: |
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: pipeline-install-config
    data:
      # MinIO configuration
      bucketName: mlpipeline
      minioServiceRegion: us-west-1
      minioServicePort: "9000"

      # MySQL configuration
      mysqlDatabase: mlpipeline
      mysqlPort: "3306"

      # Cache configuration
      cacheEnabled: "true"
      cacheImage: gcr.io/google-containers/busybox

---
# Resource Quotas per Namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ml-team-quota
  namespace: kubeflow-ml-team
spec:
  hard:
    requests.cpu: "100"
    requests.memory: 500Gi
    requests.nvidia.com/gpu: "10"
    persistentvolumeclaims: "50"
    services.loadbalancers: "5"

---
# Network Policies
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kubeflow-network-policy
  namespace: kubeflow
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: kubeflow
        - namespaceSelector:
            matchLabels:
              name: istio-system
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              name: kubeflow
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 53
        - protocol: UDP
          port: 53
```

## ML Pipeline Development

### Kubeflow Pipelines SDK

**Complete ML Pipeline Example:**
```python
# ml_pipeline.py
import kfp
from kfp import dsl
from kfp.components import create_component_from_func
from typing import NamedTuple

# Define data preprocessing component
@create_component_from_func
def preprocess_data(
    input_data_path: str,
    output_data_path: str,
    test_size: float = 0.2
) -> NamedTuple('Outputs', [('num_samples', int), ('num_features', int)]):
    """Preprocess training data."""
    import pandas as pd
    from sklearn.model_selection import train_test_split
    import pickle

    # Load data
    df = pd.read_csv(input_data_path)

    # Feature engineering
    X = df.drop('target', axis=1)
    y = df['target']

    # Split data
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=test_size, random_state=42
    )

    # Save processed data
    with open(f'{output_data_path}/train.pkl', 'wb') as f:
        pickle.dump((X_train, y_train), f)

    with open(f'{output_data_path}/test.pkl', 'wb') as f:
        pickle.dump((X_test, y_test), f)

    outputs = NamedTuple('Outputs', [('num_samples', int), ('num_features', int)])
    return outputs(len(df), len(X.columns))

# Define training component
@create_component_from_func
def train_model(
    data_path: str,
    model_path: str,
    learning_rate: float = 0.001,
    epochs: int = 10,
    batch_size: int = 32
) -> NamedTuple('Outputs', [('accuracy', float), ('loss', float)]):
    """Train ML model."""
    import tensorflow as tf
    from tensorflow import keras
    import pickle
    import os

    # Load data
    with open(f'{data_path}/train.pkl', 'rb') as f:
        X_train, y_train = pickle.load(f)

    # Build model
    model = keras.Sequential([
        keras.layers.Dense(128, activation='relu', input_shape=(X_train.shape[1],)),
        keras.layers.Dropout(0.2),
        keras.layers.Dense(64, activation='relu'),
        keras.layers.Dropout(0.2),
        keras.layers.Dense(1, activation='sigmoid')
    ])

    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=learning_rate),
        loss='binary_crossentropy',
        metrics=['accuracy']
    )

    # Train model
    history = model.fit(
        X_train, y_train,
        epochs=epochs,
        batch_size=batch_size,
        validation_split=0.2,
        verbose=1
    )

    # Save model
    os.makedirs(model_path, exist_ok=True)
    model.save(f'{model_path}/model.h5')

    final_accuracy = history.history['val_accuracy'][-1]
    final_loss = history.history['val_loss'][-1]

    outputs = NamedTuple('Outputs', [('accuracy', float), ('loss', float)])
    return outputs(float(final_accuracy), float(final_loss))

# Define evaluation component
@create_component_from_func
def evaluate_model(
    data_path: str,
    model_path: str
) -> NamedTuple('Outputs', [('test_accuracy', float), ('test_loss', float)]):
    """Evaluate trained model."""
    import tensorflow as tf
    from tensorflow import keras
    import pickle

    # Load test data
    with open(f'{data_path}/test.pkl', 'rb') as f:
        X_test, y_test = pickle.load(f)

    # Load model
    model = keras.models.load_model(f'{model_path}/model.h5')

    # Evaluate
    test_loss, test_accuracy = model.evaluate(X_test, y_test, verbose=0)

    outputs = NamedTuple('Outputs', [('test_accuracy', float), ('test_loss', float)])
    return outputs(float(test_accuracy), float(test_loss))

# Define deployment component
@create_component_from_func
def deploy_model(
    model_path: str,
    model_name: str,
    namespace: str = 'kubeflow'
):
    """Deploy model to KServe."""
    from kubernetes import client, config
    import json

    config.load_incluster_config()

    # Create InferenceService
    inference_service = {
        'apiVersion': 'serving.kserve.io/v1beta1',
        'kind': 'InferenceService',
        'metadata': {
            'name': model_name,
            'namespace': namespace
        },
        'spec': {
            'predictor': {
                'tensorflow': {
                    'storageUri': model_path,
                    'resources': {
                        'limits': {
                            'cpu': '1',
                            'memory': '2Gi'
                        },
                        'requests': {
                            'cpu': '500m',
                            'memory': '1Gi'
                        }
                    }
                }
            }
        }
    }

    # Apply inference service
    api = client.CustomObjectsApi()
    api.create_namespaced_custom_object(
        group='serving.kserve.io',
        version='v1beta1',
        namespace=namespace,
        plural='inferenceservices',
        body=inference_service
    )

    print(f'Model {model_name} deployed successfully')

# Define complete pipeline
@dsl.pipeline(
    name='End-to-End ML Pipeline',
    description='Complete ML pipeline with training and deployment'
)
def ml_pipeline(
    input_data_path: str = 'gs://my-bucket/data/input.csv',
    learning_rate: float = 0.001,
    epochs: int = 10,
    batch_size: int = 32,
    model_name: str = 'my-model'
):
    """Complete ML pipeline."""

    # Create volumes for data and model storage
    vop = dsl.VolumeOp(
        name='data-volume',
        resource_name='data-pvc',
        size='10Gi',
        modes=dsl.VOLUME_MODE_RWO
    )

    model_vop = dsl.VolumeOp(
        name='model-volume',
        resource_name='model-pvc',
        size='5Gi',
        modes=dsl.VOLUME_MODE_RWO
    )

    # Step 1: Preprocess data
    preprocess = preprocess_data(
        input_data_path=input_data_path,
        output_data_path='/data'
    ).add_pvolumes({'/data': vop.volume})

    # Step 2: Train model
    train = train_model(
        data_path='/data',
        model_path='/model',
        learning_rate=learning_rate,
        epochs=epochs,
        batch_size=batch_size
    ).add_pvolumes({
        '/data': preprocess.pvolume,
        '/model': model_vop.volume
    }).after(preprocess)

    # Step 3: Evaluate model
    evaluate = evaluate_model(
        data_path='/data',
        model_path='/model'
    ).add_pvolumes({
        '/data': preprocess.pvolume,
        '/model': train.pvolume
    }).after(train)

    # Step 4: Deploy model (conditional on accuracy threshold)
    with dsl.Condition(evaluate.outputs['test_accuracy'] > 0.85):
        deploy = deploy_model(
            model_path='gs://my-bucket/models/' + model_name,
            model_name=model_name
        ).after(evaluate)

# Compile and submit pipeline
if __name__ == '__main__':
    import kfp.compiler as compiler

    # Compile pipeline
    compiler.Compiler().compile(
        ml_pipeline,
        'ml_pipeline.yaml'
    )

    # Submit to Kubeflow
    client = kfp.Client(host='http://localhost:8080')
    experiment = client.create_experiment(name='ml-experiments')

    run = client.run_pipeline(
        experiment.id,
        'ml-pipeline-run',
        'ml_pipeline.yaml',
        params={
            'input_data_path': 'gs://my-bucket/data/input.csv',
            'learning_rate': 0.001,
            'epochs': 20,
            'batch_size': 64,
            'model_name': 'production-model-v1'
        }
    )

    print(f'Pipeline run created: {run.id}')
```

## Distributed Training with Kubeflow

### PyTorch Distributed Training

**PyTorchJob Configuration:**
```yaml
# pytorch-distributed-training.yaml
apiVersion: kubeflow.org/v1
kind: PyTorchJob
metadata:
  name: pytorch-distributed-training
  namespace: kubeflow
spec:
  pytorchReplicaSpecs:
    Master:
      replicas: 1
      restartPolicy: OnFailure
      template:
        metadata:
          annotations:
            sidecar.istio.io/inject: "false"
        spec:
          containers:
            - name: pytorch
              image: pytorch/pytorch:2.0.0-cuda11.7-cudnn8-runtime
              imagePullPolicy: IfNotPresent
              command:
                - python
                - -m
                - torch.distributed.launch
                - --nproc_per_node=4
                - --nnodes=4
                - --node_rank=$(RANK)
                - --master_addr=$(MASTER_ADDR)
                - --master_port=$(MASTER_PORT)
                - train.py
                - --epochs=100
                - --batch-size=256
                - --lr=0.01

              env:
                - name: NCCL_DEBUG
                  value: INFO

              resources:
                limits:
                  nvidia.com/gpu: 4
                  memory: 64Gi
                  cpu: 16
                requests:
                  nvidia.com/gpu: 4
                  memory: 32Gi
                  cpu: 8

              volumeMounts:
                - name: training-data
                  mountPath: /data
                - name: model-output
                  mountPath: /output

          volumes:
            - name: training-data
              persistentVolumeClaim:
                claimName: training-data-pvc
            - name: model-output
              persistentVolumeClaim:
                claimName: model-output-pvc

    Worker:
      replicas: 3
      restartPolicy: OnFailure
      template:
        metadata:
          annotations:
            sidecar.istio.io/inject: "false"
        spec:
          containers:
            - name: pytorch
              image: pytorch/pytorch:2.0.0-cuda11.7-cudnn8-runtime
              command:
                - python
                - -m
                - torch.distributed.launch
                - --nproc_per_node=4
                - --nnodes=4
                - --node_rank=$(RANK)
                - --master_addr=$(MASTER_ADDR)
                - --master_port=$(MASTER_PORT)
                - train.py
                - --epochs=100
                - --batch-size=256
                - --lr=0.01

              resources:
                limits:
                  nvidia.com/gpu: 4
                  memory: 64Gi
                  cpu: 16
                requests:
                  nvidia.com/gpu: 4
                  memory: 32Gi
                  cpu: 8

              volumeMounts:
                - name: training-data
                  mountPath: /data
                - name: model-output
                  mountPath: /output

          volumes:
            - name: training-data
              persistentVolumeClaim:
                claimName: training-data-pvc
            - name: model-output
              persistentVolumeClaim:
                claimName: model-output-pvc
```

## Model Serving with KServe

**Production Model Deployment:**
```yaml
# kserve-inference-service.yaml
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: sklearn-iris-model
  namespace: kubeflow
spec:
  predictor:
    minReplicas: 2
    maxReplicas: 10
    scaleTarget: 80
    scaleMetric: concurrency

    sklearn:
      storageUri: "gs://kfserving-examples/models/sklearn/1.0/model"
      resources:
        requests:
          cpu: 100m
          memory: 256Mi
        limits:
          cpu: 1
          memory: 2Gi

    # Canary deployment
    canaryTrafficPercent: 10

  transformer:
    minReplicas: 1
    containers:
      - name: transformer
        image: company/feature-transformer:v1.0
        env:
          - name: PROTOCOL
            value: v2

  explainer:
    minReplicas: 1
    containers:
      - name: explainer
        image: kserve/alibi-explainer:latest
        args:
          - --model_name=sklearn-iris
          - --predictor_host=sklearn-iris-predictor
```

## Conclusion

Kubeflow provides enterprises with:

1. **End-to-End ML Platform**: From experimentation to production
2. **Distributed Training**: Scale training across multiple GPUs and nodes
3. **Pipeline Orchestration**: Reproducible ML workflows
4. **Model Serving**: Production-grade inference at scale
5. **Hyperparameter Tuning**: Automated model optimization
6. **Multi-Tenancy**: Isolated workspaces for teams

By implementing Kubeflow with the patterns in this guide, organizations can build scalable ML platforms that accelerate model development and deployment.

For more information on Kubeflow and MLOps, visit [support.tools](https://support.tools).