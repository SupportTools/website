---
title: "MLOps Pipeline Implementation with Kubeflow and Kubernetes: Production-Ready ML Infrastructure"
date: 2026-09-24T00:00:00-05:00
draft: false
tags: ["MLOps", "Kubeflow", "Kubernetes", "Machine Learning", "AI Infrastructure", "Data Science", "DevOps"]
categories:
- MLOps
- Kubernetes
- Machine Learning
- AI Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to implementing production-ready MLOps pipelines using Kubeflow on Kubernetes with automated training, hyperparameter tuning, model serving, and monitoring strategies."
more_link: "yes"
url: "/mlops-pipeline-implementation-kubeflow-kubernetes/"
---

Building robust MLOps pipelines requires a sophisticated orchestration platform that can handle the complexity of machine learning workloads at scale. Kubeflow, running on Kubernetes, provides a comprehensive solution for managing the entire ML lifecycle from data preparation to model deployment and monitoring. This comprehensive guide explores implementing production-ready MLOps pipelines with practical examples and best practices.

<!--more-->

# [MLOps Pipeline Implementation with Kubeflow and Kubernetes](#mlops-pipeline-implementation-kubeflow-kubernetes)

## Section 1: Kubeflow Architecture and Core Components

### Understanding Kubeflow's Ecosystem

Kubeflow is a cloud-native platform for machine learning workflows on Kubernetes that provides a unified interface for managing ML pipelines, experiments, and model serving. The platform consists of several key components that work together to provide a complete MLOps solution.

```yaml
# kubeflow-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: kubeflow
  labels:
    control-plane: kubeflow
    istio-injection: enabled
---
apiVersion: v1
kind: Namespace
metadata:
  name: kubeflow-user-example-com
  labels:
    control-plane: kubeflow
    istio-injection: enabled
    katib.kubeflow.org/metrics-collector-injection: enabled
```

### Core Kubeflow Components Installation

Installing Kubeflow requires careful orchestration of multiple components. Here's a production-ready installation approach:

```bash
#!/bin/bash
# install-kubeflow.sh

set -euo pipefail

KUBEFLOW_VERSION="v1.8.0"
KUSTOMIZE_VERSION="v5.0.3"

# Install kustomize
curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash
sudo mv kustomize /usr/local/bin/

# Clone Kubeflow manifests
git clone https://github.com/kubeflow/manifests.git
cd manifests
git checkout ${KUBEFLOW_VERSION}

# Install cert-manager
kustomize build common/cert-manager/cert-manager/base | kubectl apply -f -
kustomize build common/cert-manager/kubeflow-issuer/base | kubectl apply -f -

# Install Istio
kustomize build common/istio-1-17/istio-crds/base | kubectl apply -f -
kustomize build common/istio-1-17/istio-namespace/base | kubectl apply -f -
kustomize build common/istio-1-17/istio-install/base | kubectl apply -f -

# Install OIDC AuthService
kustomize build common/oidc-authservice/base | kubectl apply -f -

# Install Dex
kustomize build common/dex/overlays/istio | kubectl apply -f -

# Install KNative
kustomize build common/knative/knative-serving/overlays/gateways | kubectl apply -f -
kustomize build common/istio-1-17/cluster-local-gateway/base | kubectl apply -f -

# Install Kubeflow Pipelines
kustomize build apps/pipeline/upstream/env/cert-manager/platform-agnostic-multi-user | kubectl apply -f -

# Install KServe
kustomize build contrib/kserve/kserve | kubectl apply -f -
kustomize build contrib/kserve/models-web-app/overlays/kubeflow | kubectl apply -f -

# Install Katib
kustomize build apps/katib/upstream/installs/katib-with-kubeflow | kubectl apply -f -

# Install Central Dashboard
kustomize build apps/centraldashboard/upstream/overlays/kserve | kubectl apply -f -

# Install Admission Webhook
kustomize build apps/admission-webhook/upstream/overlays/cert-manager | kubectl apply -f -

# Install Notebooks & Jupyter Web App
kustomize build apps/jupyter/notebook-controller/upstream/overlays/kubeflow | kubectl apply -f -
kustomize build apps/jupyter/jupyter-web-app/upstream/overlays/istio | kubectl apply -f -

# Install Profiles + KFAM
kustomize build apps/profiles/upstream/overlays/kubeflow | kubectl apply -f -

# Install Volumes Web App
kustomize build apps/volumes-web-app/upstream/overlays/istio | kubectl apply -f -

# Install Tensorboard
kustomize build apps/tensorboard/tensorboards-web-app/upstream/overlays/istio | kubectl apply -f -
kustomize build apps/tensorboard/tensorboard-controller/upstream/overlays/kubeflow | kubectl apply -f -

# Install Training Operator
kustomize build apps/training-operator/upstream/overlays/kubeflow | kubectl apply -f -

# Install User Namespace
kustomize build common/user-namespace/base | kubectl apply -f -

echo "Kubeflow installation completed. Waiting for pods to be ready..."
kubectl wait --for=condition=ready pod --all -n kubeflow --timeout=600s
```

### Advanced Kubeflow Configuration

```yaml
# kubeflow-custom-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubeflow-config
  namespace: kubeflow
data:
  config.yaml: |
    pipeline:
      defaultPipelineRoot: "minio://mlpipeline/v2/artifacts"
      bucketName: "mlpipeline"
      cacheEnabled: true
      cacheMaxSizeBytes: "2Gi"
    metadata:
      grpcPort: "8080"
      restPort: "8080"
    ui:
      clusterDomain: "cluster.local"
      mlmdApiServer: "metadata-service.kubeflow:8080"
    katib:
      suggestionImagePrefix: "docker.io/kubeflowkatib/"
      metricsCollectorImagePrefix: "docker.io/kubeflowkatib/"
---
apiVersion: v1
kind: Secret
metadata:
  name: mlpipeline-minio-artifact
  namespace: kubeflow
type: Opaque
data:
  accesskey: bWluaW8=  # minio
  secretkey: bWluaW8xMjM=  # minio123
```

## Section 2: ML Pipeline Development and Automation

### Creating Kubeflow Pipelines

Kubeflow Pipelines provide a platform for building and deploying portable, scalable machine learning workflows. Here's how to create sophisticated pipelines:

```python
# ml_pipeline.py
import kfp
from kfp import dsl
from kfp.components import func_to_container_op, OutputPath, InputPath
import pandas as pd
from typing import NamedTuple

@func_to_container_op
def data_preprocessing(
    input_data_path: str,
    output_data_path: OutputPath(),
    train_test_split_ratio: float = 0.8
) -> NamedTuple('Outputs', [('num_features', int), ('num_samples', int)]):
    """Preprocess data for machine learning pipeline."""
    import pandas as pd
    import numpy as np
    from sklearn.model_selection import train_test_split
    from sklearn.preprocessing import StandardScaler
    import joblib
    import os
    
    # Load data
    df = pd.read_csv(input_data_path)
    
    # Feature engineering
    df = df.dropna()
    X = df.drop(['target'], axis=1)
    y = df['target']
    
    # Split data
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=1-train_test_split_ratio, random_state=42
    )
    
    # Scale features
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)
    
    # Save processed data
    os.makedirs(output_data_path, exist_ok=True)
    
    train_df = pd.DataFrame(X_train_scaled, columns=X.columns)
    train_df['target'] = y_train.reset_index(drop=True)
    train_df.to_csv(f"{output_data_path}/train.csv", index=False)
    
    test_df = pd.DataFrame(X_test_scaled, columns=X.columns)
    test_df['target'] = y_test.reset_index(drop=True)
    test_df.to_csv(f"{output_data_path}/test.csv", index=False)
    
    # Save scaler
    joblib.dump(scaler, f"{output_data_path}/scaler.pkl")
    
    return (len(X.columns), len(df))

@func_to_container_op
def model_training(
    data_path: InputPath(),
    model_path: OutputPath(),
    learning_rate: float = 0.01,
    n_estimators: int = 100,
    max_depth: int = 10
) -> NamedTuple('Outputs', [('accuracy', float), ('f1_score', float)]):
    """Train machine learning model."""
    import pandas as pd
    import joblib
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.metrics import accuracy_score, f1_score
    import os
    
    # Load data
    train_df = pd.read_csv(f"{data_path}/train.csv")
    test_df = pd.read_csv(f"{data_path}/test.csv")
    
    X_train = train_df.drop(['target'], axis=1)
    y_train = train_df['target']
    X_test = test_df.drop(['target'], axis=1)
    y_test = test_df['target']
    
    # Train model
    model = GradientBoostingClassifier(
        learning_rate=learning_rate,
        n_estimators=n_estimators,
        max_depth=max_depth,
        random_state=42
    )
    
    model.fit(X_train, y_train)
    
    # Evaluate model
    y_pred = model.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    f1 = f1_score(y_test, y_pred, average='weighted')
    
    # Save model
    os.makedirs(model_path, exist_ok=True)
    joblib.dump(model, f"{model_path}/model.pkl")
    
    # Save metrics
    metrics = {
        'accuracy': accuracy,
        'f1_score': f1,
        'n_estimators': n_estimators,
        'learning_rate': learning_rate,
        'max_depth': max_depth
    }
    
    import json
    with open(f"{model_path}/metrics.json", 'w') as f:
        json.dump(metrics, f)
    
    return (accuracy, f1)

@func_to_container_op
def model_validation(
    model_path: InputPath(),
    validation_threshold: float = 0.85
) -> bool:
    """Validate model performance against threshold."""
    import json
    import os
    
    # Load metrics
    with open(f"{model_path}/metrics.json", 'r') as f:
        metrics = json.load(f)
    
    accuracy = metrics['accuracy']
    
    # Validate against threshold
    is_valid = accuracy >= validation_threshold
    
    print(f"Model accuracy: {accuracy:.4f}")
    print(f"Validation threshold: {validation_threshold}")
    print(f"Model validation: {'PASSED' if is_valid else 'FAILED'}")
    
    return is_valid

@dsl.pipeline(
    name='ml-training-pipeline',
    description='End-to-end ML training pipeline with validation'
)
def ml_training_pipeline(
    input_data_url: str = "gs://my-bucket/data/training_data.csv",
    train_test_split_ratio: float = 0.8,
    learning_rate: float = 0.01,
    n_estimators: int = 100,
    max_depth: int = 10,
    validation_threshold: float = 0.85
):
    """Complete ML training pipeline."""
    
    # Data preprocessing step
    preprocess_op = data_preprocessing(
        input_data_path=input_data_url,
        train_test_split_ratio=train_test_split_ratio
    )
    
    # Model training step
    training_op = model_training(
        data_path=preprocess_op.outputs['output_data_path'],
        learning_rate=learning_rate,
        n_estimators=n_estimators,
        max_depth=max_depth
    )
    
    # Model validation step
    validation_op = model_validation(
        model_path=training_op.outputs['model_path'],
        validation_threshold=validation_threshold
    )
    
    # Set execution order
    training_op.after(preprocess_op)
    validation_op.after(training_op)

# Compile pipeline
if __name__ == '__main__':
    kfp.compiler.Compiler().compile(ml_training_pipeline, 'ml_training_pipeline.yaml')
```

### Advanced Pipeline Orchestration

```python
# advanced_pipeline.py
import kfp
from kfp import dsl
from kfp.components import func_to_container_op, OutputPath, InputPath
from kubernetes import client as k8s_client

@dsl.pipeline(
    name='advanced-ml-pipeline',
    description='Advanced ML pipeline with conditional execution and parallel training'
)
def advanced_ml_pipeline(
    data_source: str = "postgresql://user:pass@host:5432/db",
    model_types: list = ["xgboost", "lightgbm", "catboost"],
    enable_feature_selection: bool = True,
    cross_validation_folds: int = 5
):
    """Advanced ML pipeline with multiple models and conditional logic."""
    
    # Data ingestion with database connection
    data_ingestion_op = dsl.ContainerOp(
        name='data-ingestion',
        image='gcr.io/my-project/data-ingestion:latest',
        arguments=[
            '--source', data_source,
            '--output-path', '/tmp/data'
        ],
        file_outputs={
            'data_path': '/tmp/data/output.csv',
            'metadata': '/tmp/data/metadata.json'
        }
    )
    
    # Conditional feature selection
    with dsl.Condition(enable_feature_selection == True):
        feature_selection_op = dsl.ContainerOp(
            name='feature-selection',
            image='gcr.io/my-project/feature-selection:latest',
            arguments=[
                '--input-data', data_ingestion_op.outputs['data_path'],
                '--method', 'recursive_feature_elimination',
                '--n_features', '50'
            ],
            file_outputs={
                'selected_data': '/tmp/features/selected_data.csv',
                'feature_importance': '/tmp/features/importance.json'
            }
        )
        data_for_training = feature_selection_op.outputs['selected_data']
    
    # Use original data if feature selection is disabled
    with dsl.Condition(enable_feature_selection == False):
        data_for_training = data_ingestion_op.outputs['data_path']
    
    # Parallel model training
    model_training_ops = []
    for model_type in model_types:
        training_op = dsl.ContainerOp(
            name=f'train-{model_type}',
            image=f'gcr.io/my-project/model-training:latest',
            arguments=[
                '--input-data', data_for_training,
                '--model-type', model_type,
                '--cv-folds', str(cross_validation_folds),
                '--output-path', f'/tmp/models/{model_type}'
            ],
            file_outputs={
                'model': f'/tmp/models/{model_type}/model.pkl',
                'metrics': f'/tmp/models/{model_type}/metrics.json'
            }
        )
        model_training_ops.append(training_op)
    
    # Model comparison and selection
    model_comparison_op = dsl.ContainerOp(
        name='model-comparison',
        image='gcr.io/my-project/model-comparison:latest',
        arguments=[
            '--model-paths'
        ] + [op.outputs['model'] for op in model_training_ops] + [
            '--metrics-paths'
        ] + [op.outputs['metrics'] for op in model_training_ops],
        file_outputs={
            'best_model': '/tmp/comparison/best_model.pkl',
            'comparison_report': '/tmp/comparison/report.json'
        }
    )
    
    # Model deployment preparation
    deployment_prep_op = dsl.ContainerOp(
        name='deployment-preparation',
        image='gcr.io/my-project/deployment-prep:latest',
        arguments=[
            '--model-path', model_comparison_op.outputs['best_model'],
            '--deployment-config', '/config/deployment.yaml'
        ],
        file_outputs={
            'deployment_artifacts': '/tmp/deployment/artifacts.tar.gz'
        }
    )
```

## Section 3: Hyperparameter Tuning at Scale with Katib

### Katib Configuration for Automated Hyperparameter Optimization

Katib is Kubeflow's native system for hyperparameter tuning and neural architecture search. Here's how to implement scalable hyperparameter optimization:

```yaml
# katib-experiment.yaml
apiVersion: kubeflow.org/v1beta1
kind: Experiment
metadata:
  name: ml-hyperparameter-tuning
  namespace: kubeflow-user-example-com
spec:
  algorithm:
    algorithmName: bayesian-optimization
    algorithmSettings:
      - name: "random_state"
        value: "10"
      - name: "n_initial_points"
        value: "10"
      - name: "acq_func"
        value: "gp_hedge"
  objective:
    type: maximize
    goal: 0.99
    objectiveMetricName: accuracy
    additionalMetricNames:
      - precision
      - recall
      - f1_score
  parameters:
    - name: learning_rate
      parameterType: double
      feasibleSpace:
        min: "0.001"
        max: "0.3"
        step: "0.001"
    - name: n_estimators
      parameterType: int
      feasibleSpace:
        min: "50"
        max: "500"
        step: "10"
    - name: max_depth
      parameterType: int
      feasibleSpace:
        min: "3"
        max: "20"
        step: "1"
    - name: subsample
      parameterType: double
      feasibleSpace:
        min: "0.5"
        max: "1.0"
        step: "0.1"
    - name: min_child_weight
      parameterType: int
      feasibleSpace:
        min: "1"
        max: "10"
        step: "1"
  trialTemplate:
    primaryContainerName: training-container
    trialParameters:
      - name: learning_rate
        description: Learning rate for the optimizer
        reference: learning_rate
      - name: n_estimators
        description: Number of boosting rounds
        reference: n_estimators
      - name: max_depth
        description: Maximum tree depth
        reference: max_depth
      - name: subsample
        description: Subsample ratio of training instances
        reference: subsample
      - name: min_child_weight
        description: Minimum sum of instance weight needed in a child
        reference: min_child_weight
    trialSpec:
      apiVersion: batch/v1
      kind: Job
      spec:
        template:
          spec:
            containers:
              - name: training-container
                image: gcr.io/my-project/hyperparameter-training:latest
                command:
                  - "python"
                  - "/app/train.py"
                  - "--learning_rate=${trialParameters.learning_rate}"
                  - "--n_estimators=${trialParameters.n_estimators}"
                  - "--max_depth=${trialParameters.max_depth}"
                  - "--subsample=${trialParameters.subsample}"
                  - "--min_child_weight=${trialParameters.min_child_weight}"
                  - "--output_dir=/tmp/model"
                resources:
                  requests:
                    memory: "4Gi"
                    cpu: "2"
                    nvidia.com/gpu: "1"
                  limits:
                    memory: "8Gi"
                    cpu: "4"
                    nvidia.com/gpu: "1"
                volumeMounts:
                  - name: data-volume
                    mountPath: /data
                  - name: model-volume
                    mountPath: /tmp/model
            volumes:
              - name: data-volume
                persistentVolumeClaim:
                  claimName: training-data-pvc
              - name: model-volume
                persistentVolumeClaim:
                  claimName: model-storage-pvc
            restartPolicy: Never
  parallelTrialCount: 4
  maxTrialCount: 50
  maxFailedTrialCount: 5
  metricsCollectorSpec:
    source:
      fileSystemPath:
        path: /tmp/model/metrics.txt
        kind: File
    collector:
      kind: File
  earlyStoppingSpec:
    algorithmName: medianstop
    algorithmSettings:
      - name: min_trials_required
        value: "5"
      - name: start_step
        value: "4"
```

### Custom Hyperparameter Training Script

```python
# hyperparameter_training.py
import argparse
import json
import os
import sys
from datetime import datetime
import pandas as pd
import numpy as np
from sklearn.model_selection import cross_val_score
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score
import xgboost as xgb
import joblib
import mlflow
import mlflow.xgboost

def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description='Hyperparameter tuning training script')
    parser.add_argument('--learning_rate', type=float, required=True,
                       help='Learning rate for XGBoost')
    parser.add_argument('--n_estimators', type=int, required=True,
                       help='Number of estimators')
    parser.add_argument('--max_depth', type=int, required=True,
                       help='Maximum depth of trees')
    parser.add_argument('--subsample', type=float, required=True,
                       help='Subsample ratio')
    parser.add_argument('--min_child_weight', type=int, required=True,
                       help='Minimum child weight')
    parser.add_argument('--data_path', type=str, default='/data/train.csv',
                       help='Path to training data')
    parser.add_argument('--output_dir', type=str, default='/tmp/model',
                       help='Output directory for model and metrics')
    return parser.parse_args()

def load_data(data_path):
    """Load and prepare training data."""
    try:
        df = pd.read_csv(data_path)
        X = df.drop(['target'], axis=1)
        y = df['target']
        return X, y
    except Exception as e:
        print(f"Error loading data: {e}")
        sys.exit(1)

def train_model(X, y, params):
    """Train XGBoost model with given parameters."""
    model = xgb.XGBClassifier(
        learning_rate=params['learning_rate'],
        n_estimators=params['n_estimators'],
        max_depth=params['max_depth'],
        subsample=params['subsample'],
        min_child_weight=params['min_child_weight'],
        random_state=42,
        eval_metric='mlogloss',
        use_label_encoder=False
    )
    
    # Perform cross-validation
    cv_scores = cross_val_score(model, X, y, cv=5, scoring='accuracy')
    
    # Train final model
    model.fit(X, y)
    
    # Make predictions for detailed metrics
    y_pred = model.predict(X)
    
    metrics = {
        'accuracy': accuracy_score(y, y_pred),
        'precision': precision_score(y, y_pred, average='weighted'),
        'recall': recall_score(y, y_pred, average='weighted'),
        'f1_score': f1_score(y, y_pred, average='weighted'),
        'cv_mean': cv_scores.mean(),
        'cv_std': cv_scores.std(),
        'params': params
    }
    
    return model, metrics

def save_results(model, metrics, output_dir):
    """Save model and metrics to output directory."""
    os.makedirs(output_dir, exist_ok=True)
    
    # Save model
    model_path = os.path.join(output_dir, 'model.pkl')
    joblib.dump(model, model_path)
    
    # Save detailed metrics
    metrics_path = os.path.join(output_dir, 'metrics.json')
    with open(metrics_path, 'w') as f:
        json.dump(metrics, f, indent=2)
    
    # Save metrics for Katib (simple format)
    katib_metrics_path = os.path.join(output_dir, 'metrics.txt')
    with open(katib_metrics_path, 'w') as f:
        f.write(f"accuracy={metrics['accuracy']:.6f}\n")
        f.write(f"precision={metrics['precision']:.6f}\n")
        f.write(f"recall={metrics['recall']:.6f}\n")
        f.write(f"f1_score={metrics['f1_score']:.6f}\n")
    
    return model_path, metrics_path

def main():
    """Main training function."""
    args = parse_args()
    
    # Prepare parameters
    params = {
        'learning_rate': args.learning_rate,
        'n_estimators': args.n_estimators,
        'max_depth': args.max_depth,
        'subsample': args.subsample,
        'min_child_weight': args.min_child_weight
    }
    
    print(f"Starting training with parameters: {params}")
    
    # Load data
    X, y = load_data(args.data_path)
    print(f"Loaded data: {X.shape[0]} samples, {X.shape[1]} features")
    
    # Start MLflow run
    with mlflow.start_run():
        # Log parameters
        mlflow.log_params(params)
        
        # Train model
        model, metrics = train_model(X, y, params)
        
        # Log metrics
        mlflow.log_metrics({
            'accuracy': metrics['accuracy'],
            'precision': metrics['precision'],
            'recall': metrics['recall'],
            'f1_score': metrics['f1_score'],
            'cv_mean': metrics['cv_mean'],
            'cv_std': metrics['cv_std']
        })
        
        # Save results
        model_path, metrics_path = save_results(model, metrics, args.output_dir)
        
        # Log model to MLflow
        mlflow.xgboost.log_model(model, "model")
        
        print(f"Training completed successfully!")
        print(f"Model saved to: {model_path}")
        print(f"Metrics saved to: {metrics_path}")
        print(f"Final accuracy: {metrics['accuracy']:.6f}")

if __name__ == "__main__":
    main()
```

## Section 4: Model Serving and Versioning

### KServe Model Serving Configuration

KServe provides Kubernetes-native model serving with advanced features like auto-scaling, traffic splitting, and A/B testing:

```yaml
# model-serving-config.yaml
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: ml-model-server
  namespace: kubeflow-user-example-com
  annotations:
    serving.kserve.io/autoscaling.knative.dev: "true"
    serving.kserve.io/autoscaling.class: "kpa.autoscaling.knative.dev"
    serving.kserve.io/metric: "concurrency"
    serving.kserve.io/target: "10"
    serving.kserve.io/target-utilization-percentage: "80"
spec:
  predictor:
    serviceAccountName: kserve-sa
    minReplicas: 1
    maxReplicas: 10
    containers:
      - name: kserve-container
        image: gcr.io/my-project/model-server:v1.2.0
        ports:
          - containerPort: 8080
            protocol: TCP
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
            nvidia.com/gpu: "1"
          limits:
            cpu: "2"
            memory: 4Gi
            nvidia.com/gpu: "1"
        env:
          - name: MODEL_PATH
            value: "/mnt/models/model.pkl"
          - name: PROTOCOL_VERSION
            value: "v1"
          - name: MODEL_NAME
            value: "ml-classifier"
        volumeMounts:
          - name: model-storage
            mountPath: /mnt/models
            readOnly: true
        livenessProbe:
          httpGet:
            path: /v1/models/ml-classifier
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /v1/models/ml-classifier
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 5
    volumes:
      - name: model-storage
        persistentVolumeClaim:
          claimName: model-storage-pvc
  canaryTrafficPercent: 0
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kserve-sa
  namespace: kubeflow-user-example-com
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kserve-role
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "endpoints"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["serving.kserve.io"]
    resources: ["inferenceservices"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kserve-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kserve-role
subjects:
  - kind: ServiceAccount
    name: kserve-sa
    namespace: kubeflow-user-example-com
```

### Custom Model Server Implementation

```python
# model_server.py
import os
import pickle
import json
import logging
import uvicorn
from datetime import datetime
from typing import Dict, List, Any, Optional
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import pandas as pd
import numpy as np
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from prometheus_client.exposition import CONTENT_TYPE_LATEST
import joblib
import asyncio
import aioredis

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Prometheus metrics
PREDICTION_COUNT = Counter('model_predictions_total', 'Total predictions made')
PREDICTION_LATENCY = Histogram('model_prediction_duration_seconds', 'Prediction latency')
MODEL_LOAD_TIME = Gauge('model_load_time_seconds', 'Time taken to load model')
ACTIVE_CONNECTIONS = Gauge('active_connections', 'Number of active connections')

class PredictionRequest(BaseModel):
    instances: List[Dict[str, Any]] = Field(..., description="Input instances for prediction")
    parameters: Optional[Dict[str, Any]] = Field(None, description="Additional parameters")

class PredictionResponse(BaseModel):
    predictions: List[Dict[str, Any]]
    model_name: str
    model_version: str
    timestamp: str

class ModelServer:
    def __init__(self):
        self.app = FastAPI(title="ML Model Server", version="1.0.0")
        self.model = None
        self.scaler = None
        self.model_metadata = {}
        self.redis_client = None
        self.setup_middleware()
        self.setup_routes()
        
    def setup_middleware(self):
        """Setup FastAPI middleware."""
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        
        @self.app.middleware("http")
        async def add_process_time_header(request: Request, call_next):
            ACTIVE_CONNECTIONS.inc()
            try:
                response = await call_next(request)
                return response
            finally:
                ACTIVE_CONNECTIONS.dec()
    
    async def load_model(self):
        """Load model and preprocessing components."""
        start_time = datetime.now()
        
        model_path = os.getenv('MODEL_PATH', '/mnt/models/model.pkl')
        scaler_path = os.getenv('SCALER_PATH', '/mnt/models/scaler.pkl')
        metadata_path = os.getenv('METADATA_PATH', '/mnt/models/metadata.json')
        
        try:
            # Load model
            logger.info(f"Loading model from {model_path}")
            self.model = joblib.load(model_path)
            
            # Load scaler if exists
            if os.path.exists(scaler_path):
                logger.info(f"Loading scaler from {scaler_path}")
                self.scaler = joblib.load(scaler_path)
            
            # Load metadata if exists
            if os.path.exists(metadata_path):
                with open(metadata_path, 'r') as f:
                    self.model_metadata = json.load(f)
            
            # Setup Redis connection for caching
            redis_url = os.getenv('REDIS_URL', 'redis://localhost:6379')
            try:
                self.redis_client = await aioredis.from_url(redis_url)
                logger.info("Connected to Redis for caching")
            except Exception as e:
                logger.warning(f"Could not connect to Redis: {e}")
            
            load_time = (datetime.now() - start_time).total_seconds()
            MODEL_LOAD_TIME.set(load_time)
            logger.info(f"Model loaded successfully in {load_time:.2f} seconds")
            
        except Exception as e:
            logger.error(f"Error loading model: {e}")
            raise
    
    def setup_routes(self):
        """Setup FastAPI routes."""
        
        @self.app.on_event("startup")
        async def startup_event():
            await self.load_model()
        
        @self.app.get("/")
        async def root():
            return {"message": "ML Model Server", "status": "healthy"}
        
        @self.app.get("/health")
        async def health_check():
            """Health check endpoint for Kubernetes probes."""
            if self.model is None:
                raise HTTPException(status_code=503, detail="Model not loaded")
            return {"status": "healthy", "model_loaded": True}
        
        @self.app.get("/v1/models/{model_name}")
        async def model_info(model_name: str):
            """Get model information."""
            if self.model is None:
                raise HTTPException(status_code=503, detail="Model not loaded")
            
            return {
                "name": model_name,
                "version": self.model_metadata.get("version", "unknown"),
                "state": "AVAILABLE",
                "status": "ready",
                "metadata": self.model_metadata
            }
        
        @self.app.post("/v1/models/{model_name}:predict", response_model=PredictionResponse)
        async def predict(model_name: str, request: PredictionRequest):
            """Make predictions."""
            if self.model is None:
                raise HTTPException(status_code=503, detail="Model not loaded")
            
            with PREDICTION_LATENCY.time():
                try:
                    # Check cache first
                    cache_key = None
                    if self.redis_client:
                        cache_key = f"prediction:{hash(str(request.instances))}"
                        cached_result = await self.redis_client.get(cache_key)
                        if cached_result:
                            logger.info("Serving prediction from cache")
                            PREDICTION_COUNT.inc()
                            return PredictionResponse.parse_raw(cached_result)
                    
                    # Prepare input data
                    df = pd.DataFrame(request.instances)
                    
                    # Apply preprocessing if scaler is available
                    if self.scaler:
                        features_scaled = self.scaler.transform(df)
                        df_scaled = pd.DataFrame(features_scaled, columns=df.columns)
                    else:
                        df_scaled = df
                    
                    # Make predictions
                    predictions = self.model.predict(df_scaled)
                    probabilities = None
                    
                    # Get prediction probabilities if available
                    if hasattr(self.model, 'predict_proba'):
                        probabilities = self.model.predict_proba(df_scaled)
                    
                    # Format response
                    prediction_results = []
                    for i, pred in enumerate(predictions):
                        result = {"prediction": int(pred) if isinstance(pred, np.integer) else float(pred)}
                        
                        if probabilities is not None:
                            result["probabilities"] = probabilities[i].tolist()
                        
                        prediction_results.append(result)
                    
                    response = PredictionResponse(
                        predictions=prediction_results,
                        model_name=model_name,
                        model_version=self.model_metadata.get("version", "unknown"),
                        timestamp=datetime.now().isoformat()
                    )
                    
                    # Cache the result
                    if self.redis_client and cache_key:
                        await self.redis_client.setex(
                            cache_key, 
                            300,  # 5 minute TTL
                            response.json()
                        )
                    
                    PREDICTION_COUNT.inc()
                    return response
                    
                except Exception as e:
                    logger.error(f"Prediction error: {e}")
                    raise HTTPException(status_code=500, detail=f"Prediction failed: {str(e)}")
        
        @self.app.get("/metrics")
        async def metrics():
            """Prometheus metrics endpoint."""
            return generate_latest().decode('utf-8')

def create_app():
    """Create and configure the FastAPI application."""
    server = ModelServer()
    return server.app

if __name__ == "__main__":
    app = create_app()
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8080")),
        workers=1,
        loop="asyncio"
    )
```

## Section 5: Production Monitoring and Observability

### MLflow Integration for Model Tracking

```python
# mlflow_tracking.py
import mlflow
import mlflow.sklearn
import mlflow.xgboost
from mlflow.tracking import MlflowClient
import pandas as pd
import numpy as np
from datetime import datetime
import logging
import os
from typing import Dict, Any, List

class MLflowModelTracker:
    """Comprehensive MLflow tracking for ML models."""
    
    def __init__(self, tracking_uri: str = None, experiment_name: str = "default"):
        self.tracking_uri = tracking_uri or os.getenv('MLFLOW_TRACKING_URI', 'http://mlflow:5000')
        self.experiment_name = experiment_name
        self.client = MlflowClient(tracking_uri=self.tracking_uri)
        self.setup_experiment()
        
    def setup_experiment(self):
        """Setup MLflow experiment."""
        try:
            self.experiment = self.client.get_experiment_by_name(self.experiment_name)
            if self.experiment is None:
                experiment_id = self.client.create_experiment(
                    name=self.experiment_name,
                    tags={
                        "created_by": "kubeflow-pipeline",
                        "created_at": datetime.now().isoformat()
                    }
                )
                self.experiment = self.client.get_experiment(experiment_id)
        except Exception as e:
            logging.error(f"Error setting up MLflow experiment: {e}")
            raise
    
    def log_model_training(self, 
                          model, 
                          metrics: Dict[str, float],
                          params: Dict[str, Any],
                          dataset_info: Dict[str, Any],
                          artifacts: Dict[str, str] = None):
        """Log complete model training information."""
        
        with mlflow.start_run(experiment_id=self.experiment.experiment_id) as run:
            # Log parameters
            mlflow.log_params(params)
            
            # Log metrics
            mlflow.log_metrics(metrics)
            
            # Log dataset information
            mlflow.log_params({
                f"dataset_{k}": v for k, v in dataset_info.items()
            })
            
            # Log model based on type
            if hasattr(model, 'get_booster'):  # XGBoost
                mlflow.xgboost.log_model(model, "model")
            else:  # Sklearn
                mlflow.sklearn.log_model(model, "model")
            
            # Log additional artifacts
            if artifacts:
                for name, path in artifacts.items():
                    mlflow.log_artifact(path, name)
            
            # Log system information
            mlflow.log_params({
                "python_version": os.sys.version,
                "training_time": datetime.now().isoformat(),
                "node_name": os.getenv('NODE_NAME', 'unknown'),
                "pod_name": os.getenv('POD_NAME', 'unknown')
            })
            
            return run.info.run_id
    
    def register_model(self, 
                      run_id: str, 
                      model_name: str,
                      stage: str = "Staging",
                      description: str = None):
        """Register model in MLflow Model Registry."""
        
        model_uri = f"runs:/{run_id}/model"
        
        try:
            # Register model
            registered_model = mlflow.register_model(
                model_uri=model_uri,
                name=model_name,
                tags={
                    "registered_at": datetime.now().isoformat(),
                    "source_run": run_id
                }
            )
            
            # Transition to specified stage
            self.client.transition_model_version_stage(
                name=model_name,
                version=registered_model.version,
                stage=stage,
                archive_existing_versions=False
            )
            
            # Add description if provided
            if description:
                self.client.update_model_version(
                    name=model_name,
                    version=registered_model.version,
                    description=description
                )
            
            return registered_model
            
        except Exception as e:
            logging.error(f"Error registering model: {e}")
            raise
    
    def promote_model(self, model_name: str, version: str, target_stage: str):
        """Promote model to production stage."""
        
        try:
            # Archive current production models
            if target_stage.lower() == "production":
                current_prod_models = self.client.get_latest_versions(
                    model_name, stages=["Production"]
                )
                
                for model in current_prod_models:
                    self.client.transition_model_version_stage(
                        name=model_name,
                        version=model.version,
                        stage="Archived"
                    )
            
            # Promote new model
            self.client.transition_model_version_stage(
                name=model_name,
                version=version,
                stage=target_stage,
                archive_existing_versions=False
            )
            
            logging.info(f"Model {model_name} v{version} promoted to {target_stage}")
            
        except Exception as e:
            logging.error(f"Error promoting model: {e}")
            raise
    
    def compare_models(self, model_name: str, metric_name: str = "accuracy"):
        """Compare model versions by metric."""
        
        try:
            # Get all versions
            versions = self.client.search_model_versions(f"name='{model_name}'")
            
            comparison_data = []
            for version in versions:
                run = self.client.get_run(version.run_id)
                metric_value = run.data.metrics.get(metric_name)
                
                comparison_data.append({
                    "version": version.version,
                    "stage": version.current_stage,
                    "run_id": version.run_id,
                    metric_name: metric_value,
                    "created_at": version.creation_timestamp
                })
            
            return pd.DataFrame(comparison_data).sort_values(
                metric_name, ascending=False
            )
            
        except Exception as e:
            logging.error(f"Error comparing models: {e}")
            raise
```

### Comprehensive Monitoring Dashboard

```yaml
# monitoring-stack.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: kubeflow
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s

    rule_files:
      - "ml_alerts.yml"

    scrape_configs:
      - job_name: 'kubeflow-pipelines'
        kubernetes_sd_configs:
          - role: pod
            namespaces:
              names:
                - kubeflow
                - kubeflow-user-example-com
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
            action: keep
            regex: true
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
            action: replace
            target_label: __metrics_path__
            regex: (.+)

      - job_name: 'ml-model-servers'
        kubernetes_sd_configs:
          - role: service
            namespaces:
              names:
                - kubeflow-user-example-com
        relabel_configs:
          - source_labels: [__meta_kubernetes_service_label_app]
            action: keep
            regex: ml-model-server
          - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scrape]
            action: keep
            regex: true

      - job_name: 'katib-experiments'
        kubernetes_sd_configs:
          - role: pod
            namespaces:
              names:
                - kubeflow-user-example-com
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_label_katib_kubeflow_org_trial]
            action: keep
            regex: (.+)

    alerting:
      alertmanagers:
        - static_configs:
            - targets:
              - alertmanager:9093

  ml_alerts.yml: |
    groups:
      - name: ml_model_alerts
        rules:
          - alert: ModelPredictionLatencyHigh
            expr: histogram_quantile(0.95, model_prediction_duration_seconds_bucket) > 5
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "High prediction latency detected"
              description: "95th percentile prediction latency is {{ $value }}s"

          - alert: ModelAccuracyDegraded
            expr: model_accuracy < 0.85
            for: 10m
            labels:
              severity: critical
            annotations:
              summary: "Model accuracy has degraded"
              description: "Model accuracy is {{ $value }}, below threshold"

          - alert: PipelineJobFailed
            expr: increase(pipeline_job_failures_total[5m]) > 0
            for: 1m
            labels:
              severity: critical
            annotations:
              summary: "ML Pipeline job failed"
              description: "{{ $value }} pipeline jobs have failed in the last 5 minutes"

          - alert: HyperparameterTuningStalled
            expr: time() - katib_experiment_last_update_time > 3600
            for: 5m
            labels:
              severity: warning
            annotations:
              summary: "Hyperparameter tuning experiment stalled"
              description: "Katib experiment has not updated in over 1 hour"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  namespace: kubeflow
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      containers:
        - name: prometheus
          image: prom/prometheus:v2.45.0
          ports:
            - containerPort: 9090
          volumeMounts:
            - name: config-volume
              mountPath: /etc/prometheus
            - name: storage-volume
              mountPath: /prometheus
          args:
            - '--config.file=/etc/prometheus/prometheus.yml'
            - '--storage.tsdb.path=/prometheus'
            - '--web.console.libraries=/etc/prometheus/console_libraries'
            - '--web.console.templates=/etc/prometheus/consoles'
            - '--storage.tsdb.retention.time=15d'
            - '--web.enable-lifecycle'
            - '--web.enable-admin-api'
      volumes:
        - name: config-volume
          configMap:
            name: prometheus-config
        - name: storage-volume
          persistentVolumeClaim:
            claimName: prometheus-storage
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus
  namespace: kubeflow
spec:
  selector:
    app: prometheus
  ports:
    - port: 9090
      targetPort: 9090
  type: ClusterIP
```

## Section 6: Cost Optimization Strategies

### Resource Management and Auto-scaling

```yaml
# cost-optimization-policies.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ml-workload-quota
  namespace: kubeflow-user-example-com
spec:
  hard:
    requests.cpu: "50"
    requests.memory: 200Gi
    requests.nvidia.com/gpu: "10"
    limits.cpu: "100"
    limits.memory: 400Gi
    limits.nvidia.com/gpu: "10"
    persistentvolumeclaims: "20"
    requests.storage: 1Ti
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ml-model-server-pdb
  namespace: kubeflow-user-example-com
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: ml-model-server
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ml-model-server-hpa
  namespace: kubeflow-user-example-com
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ml-model-server
  minReplicas: 1
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
    - type: Pods
      pods:
        metric:
          name: concurrent_requests
        target:
          type: AverageValue
          averageValue: "10"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
        - type: Pods
          value: 2
          periodSeconds: 30
      selectPolicy: Max
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ml-training-scaler
  namespace: kubeflow-user-example-com
spec:
  scaleTargetRef:
    name: ml-training-deployment
  minReplicaCount: 0
  maxReplicaCount: 10
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus:9090
        metricName: training_queue_length
        threshold: '5'
        query: training_queue_length
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 9 * * 1-5"  # Scale up weekdays at 9 AM
        end: "0 18 * * 1-5"   # Scale down weekdays at 6 PM
        desiredReplicas: "3"
```

### Cost Monitoring and Optimization

```python
# cost_optimization.py
import kubernetes
from kubernetes import client, config
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import logging
from typing import Dict, List, Tuple
import prometheus_client
from prometheus_client.parser import text_string_to_metric_families
import requests

class KubeflorwCostOptimizer:
    """Kubeflow cost optimization and monitoring."""
    
    def __init__(self, prometheus_url: str = "http://prometheus:9090"):
        self.prometheus_url = prometheus_url
        config.load_incluster_config()
        self.v1 = client.CoreV1Api()
        self.apps_v1 = client.AppsV1Api()
        self.metrics_v1beta1 = client.CustomObjectsApi()
        
    def get_resource_usage(self, namespace: str = "kubeflow-user-example-com") -> pd.DataFrame:
        """Get current resource usage for all pods."""
        
        try:
            pods = self.v1.list_namespaced_pod(namespace)
            usage_data = []
            
            for pod in pods.items:
                if pod.status.phase == "Running":
                    # Get pod metrics
                    try:
                        metrics = self.metrics_v1beta1.get_namespaced_custom_object(
                            group="metrics.k8s.io",
                            version="v1beta1",
                            namespace=namespace,
                            plural="pods",
                            name=pod.metadata.name
                        )
                        
                        cpu_usage = 0
                        memory_usage = 0
                        
                        for container in metrics.get('containers', []):
                            cpu_usage += self._parse_cpu(container['usage'].get('cpu', '0'))
                            memory_usage += self._parse_memory(container['usage'].get('memory', '0'))
                        
                        # Get resource requests/limits
                        cpu_request = 0
                        memory_request = 0
                        cpu_limit = 0
                        memory_limit = 0
                        
                        for container in pod.spec.containers:
                            if container.resources:
                                if container.resources.requests:
                                    cpu_request += self._parse_cpu(
                                        container.resources.requests.get('cpu', '0')
                                    )
                                    memory_request += self._parse_memory(
                                        container.resources.requests.get('memory', '0')
                                    )
                                
                                if container.resources.limits:
                                    cpu_limit += self._parse_cpu(
                                        container.resources.limits.get('cpu', '0')
                                    )
                                    memory_limit += self._parse_memory(
                                        container.resources.limits.get('memory', '0')
                                    )
                        
                        usage_data.append({
                            'pod_name': pod.metadata.name,
                            'namespace': namespace,
                            'cpu_usage_cores': cpu_usage,
                            'memory_usage_bytes': memory_usage,
                            'cpu_request_cores': cpu_request,
                            'memory_request_bytes': memory_request,
                            'cpu_limit_cores': cpu_limit,
                            'memory_limit_bytes': memory_limit,
                            'cpu_utilization': (cpu_usage / cpu_request * 100) if cpu_request > 0 else 0,
                            'memory_utilization': (memory_usage / memory_request * 100) if memory_request > 0 else 0,
                            'created_at': pod.metadata.creation_timestamp
                        })
                        
                    except Exception as e:
                        logging.warning(f"Could not get metrics for pod {pod.metadata.name}: {e}")
            
            return pd.DataFrame(usage_data)
            
        except Exception as e:
            logging.error(f"Error getting resource usage: {e}")
            return pd.DataFrame()
    
    def analyze_cost_efficiency(self, usage_df: pd.DataFrame) -> Dict:
        """Analyze cost efficiency and provide recommendations."""
        
        if usage_df.empty:
            return {"status": "error", "message": "No usage data available"}
        
        # Calculate waste metrics
        cpu_waste = usage_df['cpu_request_cores'] - usage_df['cpu_usage_cores']
        memory_waste = usage_df['memory_request_bytes'] - usage_df['memory_usage_bytes']
        
        # Identify optimization opportunities
        over_provisioned_cpu = usage_df[usage_df['cpu_utilization'] < 30]
        over_provisioned_memory = usage_df[usage_df['memory_utilization'] < 30]
        under_provisioned_cpu = usage_df[usage_df['cpu_utilization'] > 90]
        under_provisioned_memory = usage_df[usage_df['memory_utilization'] > 90]
        
        recommendations = []
        
        # CPU optimization recommendations
        if len(over_provisioned_cpu) > 0:
            avg_cpu_waste = over_provisioned_cpu['cpu_usage_cores'].sum()
            recommendations.append({
                "type": "cpu_over_provisioning",
                "affected_pods": len(over_provisioned_cpu),
                "potential_savings_cores": avg_cpu_waste,
                "description": f"Reduce CPU requests for {len(over_provisioned_cpu)} pods with <30% utilization"
            })
        
        if len(under_provisioned_cpu) > 0:
            recommendations.append({
                "type": "cpu_under_provisioning",
                "affected_pods": len(under_provisioned_cpu),
                "description": f"Increase CPU requests for {len(under_provisioned_cpu)} pods with >90% utilization"
            })
        
        # Memory optimization recommendations
        if len(over_provisioned_memory) > 0:
            avg_memory_waste = over_provisioned_memory['memory_usage_bytes'].sum()
            recommendations.append({
                "type": "memory_over_provisioning",
                "affected_pods": len(over_provisioned_memory),
                "potential_savings_gb": avg_memory_waste / (1024**3),
                "description": f"Reduce memory requests for {len(over_provisioned_memory)} pods with <30% utilization"
            })
        
        if len(under_provisioned_memory) > 0:
            recommendations.append({
                "type": "memory_under_provisioning",
                "affected_pods": len(under_provisioned_memory),
                "description": f"Increase memory requests for {len(under_provisioned_memory)} pods with >90% utilization"
            })
        
        # Idle pod detection
        idle_pods = usage_df[
            (usage_df['cpu_utilization'] < 5) & 
            (usage_df['memory_utilization'] < 10)
        ]
        
        if len(idle_pods) > 0:
            recommendations.append({
                "type": "idle_pods",
                "affected_pods": len(idle_pods),
                "pod_names": idle_pods['pod_name'].tolist(),
                "description": f"Consider terminating {len(idle_pods)} idle pods"
            })
        
        return {
            "timestamp": datetime.now().isoformat(),
            "total_pods_analyzed": len(usage_df),
            "average_cpu_utilization": usage_df['cpu_utilization'].mean(),
            "average_memory_utilization": usage_df['memory_utilization'].mean(),
            "total_cpu_waste_cores": cpu_waste.sum(),
            "total_memory_waste_gb": memory_waste.sum() / (1024**3),
            "recommendations": recommendations
        }
    
    def _parse_cpu(self, cpu_str: str) -> float:
        """Parse CPU string to cores."""
        if not cpu_str or cpu_str == '0':
            return 0.0
        
        if cpu_str.endswith('m'):
            return float(cpu_str[:-1]) / 1000
        elif cpu_str.endswith('n'):
            return float(cpu_str[:-1]) / 1000000000
        else:
            return float(cpu_str)
    
    def _parse_memory(self, memory_str: str) -> int:
        """Parse memory string to bytes."""
        if not memory_str or memory_str == '0':
            return 0
        
        units = {
            'Ki': 1024,
            'Mi': 1024**2,
            'Gi': 1024**3,
            'Ti': 1024**4,
            'K': 1000,
            'M': 1000**2,
            'G': 1000**3,
            'T': 1000**4
        }
        
        for unit, multiplier in units.items():
            if memory_str.endswith(unit):
                return int(float(memory_str[:-len(unit)]) * multiplier)
        
        return int(memory_str)
    
    def generate_cost_report(self, namespace: str = "kubeflow-user-example-com") -> Dict:
        """Generate comprehensive cost optimization report."""
        
        usage_df = self.get_resource_usage(namespace)
        analysis = self.analyze_cost_efficiency(usage_df)
        
        # Get historical trends
        historical_data = self._get_historical_metrics()
        
        report = {
            "report_date": datetime.now().isoformat(),
            "namespace": namespace,
            "current_analysis": analysis,
            "historical_trends": historical_data,
            "action_items": self._generate_action_items(analysis)
        }
        
        return report
    
    def _get_historical_metrics(self) -> Dict:
        """Get historical resource usage metrics from Prometheus."""
        
        queries = {
            "avg_cpu_utilization": 'avg(rate(container_cpu_usage_seconds_total[1h]))',
            "avg_memory_utilization": 'avg(container_memory_usage_bytes / container_spec_memory_limit_bytes)',
            "cost_trend": 'sum(kube_pod_container_resource_requests_cpu_cores * 0.048)'  # Assuming $0.048 per CPU hour
        }
        
        historical_data = {}
        
        for metric_name, query in queries.items():
            try:
                url = f"{self.prometheus_url}/api/v1/query_range"
                params = {
                    'query': query,
                    'start': (datetime.now() - timedelta(days=7)).timestamp(),
                    'end': datetime.now().timestamp(),
                    'step': '1h'
                }
                
                response = requests.get(url, params=params)
                data = response.json()
                
                if data['status'] == 'success':
                    historical_data[metric_name] = data['data']['result']
                
            except Exception as e:
                logging.warning(f"Could not fetch historical data for {metric_name}: {e}")
        
        return historical_data
    
    def _generate_action_items(self, analysis: Dict) -> List[Dict]:
        """Generate specific action items based on analysis."""
        
        action_items = []
        
        for recommendation in analysis.get('recommendations', []):
            if recommendation['type'] == 'cpu_over_provisioning':
                action_items.append({
                    "priority": "medium",
                    "action": "Reduce CPU requests",
                    "command": "kubectl patch deployment <deployment-name> -p '{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"<container-name>\",\"resources\":{\"requests\":{\"cpu\":\"<new-value>\"}}}]}}}}'",
                    "estimated_savings": f"{recommendation.get('potential_savings_cores', 0):.2f} CPU cores"
                })
            
            elif recommendation['type'] == 'memory_over_provisioning':
                action_items.append({
                    "priority": "medium",
                    "action": "Reduce memory requests",
                    "command": "kubectl patch deployment <deployment-name> -p '{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"name\":\"<container-name>\",\"resources\":{\"requests\":{\"memory\":\"<new-value>\"}}}]}}}}'",
                    "estimated_savings": f"{recommendation.get('potential_savings_gb', 0):.2f} GB memory"
                })
            
            elif recommendation['type'] == 'idle_pods':
                for pod_name in recommendation.get('pod_names', []):
                    action_items.append({
                        "priority": "high",
                        "action": f"Investigate idle pod: {pod_name}",
                        "command": f"kubectl delete pod {pod_name}",
                        "estimated_savings": "Variable based on pod resources"
                    })
        
        return action_items

# Usage example
if __name__ == "__main__":
    optimizer = KubeflorwCostOptimizer()
    report = optimizer.generate_cost_report()
    print(json.dumps(report, indent=2))
```

This comprehensive guide provides a production-ready approach to implementing MLOps pipelines with Kubeflow on Kubernetes. The examples include sophisticated pipeline orchestration, automated hyperparameter tuning, robust model serving, comprehensive monitoring, and cost optimization strategies that are essential for running ML workloads at scale in production environments.

The implementation covers all aspects of the ML lifecycle from data preprocessing and model training to deployment and monitoring, providing a solid foundation for building enterprise-grade MLOps infrastructure.