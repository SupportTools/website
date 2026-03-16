---
title: "Ray on Kubernetes: Distributed ML Training and Serving at Scale"
date: 2027-02-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Ray", "Machine Learning", "Distributed Computing", "GPU"]
categories:
- Kubernetes
- MLOps
- Machine Learning
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to running Ray on Kubernetes with KubeRay operator, covering RayCluster, RayJob, RayService CRDs, GPU scheduling, distributed training with Ray Train, hyperparameter tuning with Ray Tune, model serving, and production monitoring."
more_link: "yes"
url: "/ray-distributed-ml-training-kubernetes-production-guide/"
---

As machine learning workloads scale beyond what a single GPU can handle, teams need a distributed computing framework that integrates naturally with Kubernetes scheduling, autoscaling, and observability. **Ray** provides exactly that: a Python-first distributed runtime that spans data preprocessing, distributed training, hyperparameter search, and model serving under a single unified framework. The **KubeRay** operator exposes Ray clusters as first-class Kubernetes resources, turning cluster lifecycle management into a declarative, GitOps-friendly operation.

<!--more-->

## Ray Architecture on Kubernetes

A Ray cluster consists of one head node and one or more worker nodes. The head node runs the **GCS** (Global Control Store), the **Raylet** scheduler, and optional component servers. Workers run only a Raylet and expose slots for task and actor execution.

```
┌─────────────────────────────────────────────────────────┐
│  Ray Cluster                                             │
│                                                         │
│  Head Node Pod                                          │
│  ├─ GCS Server       (cluster state, object directory)  │
│  ├─ Raylet           (local scheduling)                 │
│  ├─ Dashboard        (:8265)                            │
│  ├─ Metrics Server   (:44217 → Prometheus)              │
│  └─ Object Store     (shared memory, local)             │
│                                                         │
│  Worker Node Pods  (0..N, autoscaled)                   │
│  ├─ Raylet           (local scheduling)                 │
│  └─ Object Store     (distributed in-memory cache)      │
└─────────────────────────────────────────────────────────┘
```

The **KubeRay** operator introduces three CRDs:

| CRD | Purpose |
|-----|---------|
| `RayCluster` | Long-running cluster for interactive workloads |
| `RayJob` | Batch job that creates a cluster, runs a Python entrypoint, then tears down |
| `RayService` | Persistent cluster for Ray Serve deployments with zero-downtime rolling updates |

## Installing the KubeRay Operator

```bash
helm repo add kuberay https://ray-project.github.io/kuberay-helm/
helm repo update

helm install kuberay-operator kuberay/kuberay-operator \
  --namespace ray-system \
  --create-namespace \
  --version 1.1.1 \
  --set image.tag=v1.1.1 \
  --wait
```

Verify:

```bash
kubectl get pods -n ray-system
# NAME                               READY   STATUS    RESTARTS
# kuberay-operator-xxxxxxxxxx-xxxxx  1/1     Running   0
```

## RayCluster: Long-Running Cluster

### Basic CPU Cluster

```yaml
apiVersion: ray.io/v1
kind: RayCluster
metadata:
  name: ray-cluster
  namespace: ray-workloads
spec:
  rayVersion: "2.10.0"
  enableInTreeAutoscaling: true

  headGroupSpec:
    serviceType: ClusterIP
    rayStartParams:
      dashboard-host: "0.0.0.0"
      num-cpus: "0"    # Head node should not run compute tasks
    template:
      spec:
        containers:
        - name: ray-head
          image: rayproject/ray:2.10.0-py311
          resources:
            requests:
              cpu: "2"
              memory: "8Gi"
            limits:
              cpu: "4"
              memory: "16Gi"
          ports:
          - containerPort: 6379  # GCS
          - containerPort: 8265  # Dashboard
          - containerPort: 10001 # Client
          - containerPort: 44217 # Metrics
          env:
          - name: RAY_GRAFANA_HOST
            value: "http://grafana.monitoring.svc.cluster.local:3000"
          - name: RAY_PROMETHEUS_HOST
            value: "http://prometheus.monitoring.svc.cluster.local:9090"

  workerGroupSpecs:
  - groupName: small-workers
    replicas: 2
    minReplicas: 1
    maxReplicas: 20
    rayStartParams: {}
    template:
      spec:
        containers:
        - name: ray-worker
          image: rayproject/ray:2.10.0-py311
          resources:
            requests:
              cpu: "4"
              memory: "16Gi"
            limits:
              cpu: "8"
              memory: "32Gi"
        tolerations:
        - key: "ray.io/node-type"
          operator: "Equal"
          value: "worker"
          effect: "NoSchedule"
```

### GPU Worker Group

Add a separate worker group for GPU-intensive tasks:

```yaml
  workerGroupSpecs:
  - groupName: gpu-workers
    replicas: 0
    minReplicas: 0
    maxReplicas: 8
    rayStartParams:
      num-gpus: "1"
    template:
      metadata:
        labels:
          ray.io/node-type: gpu-worker
      spec:
        containers:
        - name: ray-gpu-worker
          image: rayproject/ray:2.10.0-py311-gpu
          resources:
            requests:
              cpu: "8"
              memory: "32Gi"
              nvidia.com/gpu: "1"
            limits:
              cpu: "16"
              memory: "64Gi"
              nvidia.com/gpu: "1"
        nodeSelector:
          accelerator: nvidia-a100
        tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
        - key: "ray.io/node-type"
          operator: "Equal"
          value: "gpu-worker"
          effect: "NoSchedule"
```

### Multi-GPU Training Group

For `torch.distributed` / `horovod`-style data-parallel training, each worker needs multiple GPUs:

```yaml
  workerGroupSpecs:
  - groupName: multi-gpu-workers
    replicas: 0
    minReplicas: 0
    maxReplicas: 4
    rayStartParams:
      num-gpus: "8"
    template:
      spec:
        containers:
        - name: ray-multi-gpu-worker
          image: rayproject/ray:2.10.0-py311-gpu
          resources:
            requests:
              cpu: "64"
              memory: "256Gi"
              nvidia.com/gpu: "8"
            limits:
              cpu: "96"
              memory: "384Gi"
              nvidia.com/gpu: "8"
        # RDMA/InfiniBand for fast GPU-to-GPU communication
        initContainers:
        - name: init-rdma
          image: mellanox/network-operator-init-container:latest
          command: ["sh", "-c", "modprobe mlx5_core"]
          securityContext:
            privileged: true
```

## Autoscaler Integration

KubeRay integrates Ray's native autoscaler with Kubernetes. The autoscaler runs as a sidecar on the head pod and requests or removes worker Pods based on pending task demand.

```yaml
spec:
  enableInTreeAutoscaling: true

  autoscalerOptions:
    upscalingMode: Default        # Conservative | Default | Aggressive
    idleTimeoutSeconds: 300       # Remove idle workers after 5 min
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "1000m"
        memory: "1Gi"
    env:
    - name: RAY_AUTOSCALER_V2
      value: "1"
```

## Ray Train: Distributed Model Training

Ray Train provides a unified API for distributed training across PyTorch, TensorFlow, Hugging Face, and XGBoost.

### PyTorch DDP Training Job

```python
# train_pytorch.py
import ray
from ray import train
from ray.train import RunConfig, ScalingConfig
from ray.train.torch import TorchTrainer
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset


def training_loop(config: dict):
    # Ray Train prepares the model and optimizer for DDP automatically
    model = nn.Sequential(
        nn.Linear(config["input_dim"], 256),
        nn.ReLU(),
        nn.Dropout(0.2),
        nn.Linear(256, 128),
        nn.ReLU(),
        nn.Linear(128, config["num_classes"]),
    )
    model = train.torch.prepare_model(model)

    optimizer = torch.optim.AdamW(model.parameters(), lr=config["lr"])
    criterion = nn.CrossEntropyLoss()

    # Data loading — each worker gets a shard automatically
    X = torch.randn(10000, config["input_dim"])
    y = torch.randint(0, config["num_classes"], (10000,))
    dataset = TensorDataset(X, y)
    loader = DataLoader(dataset, batch_size=config["batch_size"], shuffle=True)
    loader = train.torch.prepare_data_loader(loader)

    for epoch in range(config["epochs"]):
        model.train()
        total_loss = 0.0
        for batch_X, batch_y in loader:
            optimizer.zero_grad()
            output = model(batch_X)
            loss = criterion(output, batch_y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        avg_loss = total_loss / len(loader)
        train.report({"loss": avg_loss, "epoch": epoch})


trainer = TorchTrainer(
    train_loop_per_worker=training_loop,
    train_loop_config={
        "input_dim": 512,
        "num_classes": 10,
        "lr": 1e-3,
        "batch_size": 256,
        "epochs": 20,
    },
    scaling_config=ScalingConfig(
        num_workers=4,
        use_gpu=True,
        resources_per_worker={"CPU": 4, "GPU": 1},
    ),
    run_config=RunConfig(
        name="pytorch-ddp-training",
        storage_path="s3://company-ray/training-runs",
    ),
)

result = trainer.fit()
print(f"Best checkpoint: {result.best_checkpoints[0]}")
```

Submit via `RayJob`:

```yaml
apiVersion: ray.io/v1
kind: RayJob
metadata:
  name: pytorch-training-job
  namespace: ray-workloads
spec:
  entrypoint: "python /app/train_pytorch.py"
  runtimeEnvYAML: |
    working_dir: s3://company-ray/code/train-v1.tar.gz
    pip:
      - torch==2.2.0
      - torchvision==0.17.0
  shutdownAfterJobFinishes: true
  ttlSecondsAfterFinished: 3600

  rayClusterSpec:
    rayVersion: "2.10.0"
    headGroupSpec:
      rayStartParams:
        num-cpus: "0"
      template:
        spec:
          containers:
          - name: ray-head
            image: rayproject/ray:2.10.0-py311-gpu
            resources:
              requests:
                cpu: "2"
                memory: "8Gi"
    workerGroupSpecs:
    - groupName: gpu-workers
      replicas: 4
      minReplicas: 4
      maxReplicas: 4
      rayStartParams:
        num-gpus: "1"
      template:
        spec:
          containers:
          - name: ray-worker
            image: rayproject/ray:2.10.0-py311-gpu
            resources:
              requests:
                cpu: "8"
                memory: "32Gi"
                nvidia.com/gpu: "1"
              limits:
                nvidia.com/gpu: "1"
          tolerations:
          - key: "nvidia.com/gpu"
            operator: "Exists"
            effect: "NoSchedule"
```

## Ray Tune: Distributed Hyperparameter Search

Ray Tune runs hyperparameter search across hundreds of trial workers in parallel.

```python
# tune_search.py
from ray import tune
from ray.tune.schedulers import ASHAScheduler
from ray.tune.search.optuna import OptunaSearch
import optuna


def train_model_with_config(config: dict):
    import torch
    import torch.nn as nn

    model = nn.Linear(config["input_dim"], 10)
    optimizer = torch.optim.SGD(model.parameters(), lr=config["lr"], momentum=config["momentum"])
    criterion = nn.CrossEntropyLoss()

    X = torch.randn(1000, config["input_dim"])
    y = torch.randint(0, 10, (1000,))

    for epoch in range(20):
        optimizer.zero_grad()
        loss = criterion(model(X), y)
        loss.backward()
        optimizer.step()
        tune.report({"loss": loss.item(), "epoch": epoch})


search_space = {
    "lr": tune.loguniform(1e-5, 1e-1),
    "momentum": tune.uniform(0.8, 0.99),
    "input_dim": tune.choice([128, 256, 512]),
}

scheduler = ASHAScheduler(
    metric="loss",
    mode="min",
    max_t=20,
    grace_period=5,
    reduction_factor=2,
)

search_algo = OptunaSearch(metric="loss", mode="min")

tuner = tune.Tuner(
    tune.with_resources(
        train_model_with_config,
        resources={"CPU": 2, "GPU": 0.25},  # 4 trials per GPU
    ),
    tune_config=tune.TuneConfig(
        search_alg=search_algo,
        scheduler=scheduler,
        num_samples=100,
        max_concurrent_trials=16,
    ),
    param_space=search_space,
    run_config=tune.RunConfig(
        name="hp-search-v1",
        storage_path="s3://company-ray/tune-runs",
        stop={"loss": 0.01, "training_iteration": 20},
    ),
)

results = tuner.fit()
best = results.get_best_result(metric="loss", mode="min")
print(f"Best config: {best.config}")
print(f"Best loss: {best.metrics['loss']:.4f}")
```

## Ray Serve: Model Serving

Ray Serve turns a Python class or function into a scalable HTTP endpoint with per-deployment autoscaling.

### RayService CRD

```yaml
apiVersion: ray.io/v1
kind: RayService
metadata:
  name: model-service
  namespace: ray-workloads
spec:
  serveConfigV2: |
    applications:
    - name: classification-api
      route_prefix: /predict
      import_path: serve_app:app
      runtime_env:
        working_dir: s3://company-ray/serve-apps/v2.tar.gz
        pip:
          - scikit-learn==1.4.0
          - joblib==1.3.2
      deployments:
      - name: ClassificationModel
        num_replicas: 3
        max_ongoing_requests: 100
        autoscaling_config:
          min_replicas: 2
          max_replicas: 20
          target_ongoing_requests: 5
          upscale_delay_s: 30
          downscale_delay_s: 300
        ray_actor_options:
          num_cpus: 2
          num_gpus: 0
          memory: 4294967296  # 4 GiB
      - name: Preprocessor
        num_replicas: 2
        max_ongoing_requests: 200
        ray_actor_options:
          num_cpus: 1

  upgradeStrategy:
    type: RollingUpdate

  rayClusterConfig:
    rayVersion: "2.10.0"
    headGroupSpec:
      rayStartParams:
        num-cpus: "0"
        dashboard-host: "0.0.0.0"
      template:
        spec:
          containers:
          - name: ray-head
            image: rayproject/ray:2.10.0-py311
            resources:
              requests:
                cpu: "2"
                memory: "8Gi"
    workerGroupSpecs:
    - groupName: serve-workers
      replicas: 2
      minReplicas: 2
      maxReplicas: 10
      template:
        spec:
          containers:
          - name: ray-worker
            image: rayproject/ray:2.10.0-py311
            resources:
              requests:
                cpu: "4"
                memory: "16Gi"
```

Corresponding `serve_app.py` in the working directory:

```python
# serve_app.py
import joblib
import numpy as np
from ray import serve
from starlette.requests import Request


@serve.deployment(name="Preprocessor")
class Preprocessor:
    def __call__(self, data: list) -> np.ndarray:
        return np.array(data, dtype=np.float32)


@serve.deployment(name="ClassificationModel")
class ClassificationModel:
    def __init__(self):
        self.model = joblib.load("/app/models/classifier.joblib")
        self.preprocessor = Preprocessor.get_handle()

    async def __call__(self, request: Request) -> dict:
        body = await request.json()
        features = await self.preprocessor.remote(body["features"])
        prediction = self.model.predict(features.reshape(1, -1))
        probabilities = self.model.predict_proba(features.reshape(1, -1))
        return {
            "prediction": int(prediction[0]),
            "confidence": float(probabilities[0].max()),
        }


app = ClassificationModel.bind()
```

### A/B Deployment with Traffic Split

```python
from ray import serve
from ray.serve.handle import DeploymentHandle


@serve.deployment(name="Router")
class Router:
    def __init__(
        self,
        model_v1: DeploymentHandle,
        model_v2: DeploymentHandle,
        v2_traffic_fraction: float = 0.1,
    ):
        self.model_v1 = model_v1
        self.model_v2 = model_v2
        self.v2_traffic_fraction = v2_traffic_fraction

    async def __call__(self, request):
        import random
        if random.random() < self.v2_traffic_fraction:
            return await self.model_v2.remote(request)
        return await self.model_v1.remote(request)
```

## Fault Tolerance and Spot Instance Handling

Ray clusters on spot or preemptible instances must handle node loss gracefully.

### Head Node Resilience

The head node is a single point of failure for GCS state. Protect it:

```yaml
headGroupSpec:
  template:
    spec:
      # Prefer on-demand nodes for the head
      nodeSelector:
        node.kubernetes.io/lifecycle: normal
      priorityClassName: high-priority
      # Preserve GCS state on restart
      containers:
      - name: ray-head
        env:
        - name: RAY_gcs_server_rpc_server_thread_num
          value: "4"
        - name: RAY_enable_gcs_ha
          value: "1"
        volumeMounts:
        - name: gcs-storage
          mountPath: /tmp/ray/redis
      volumes:
      - name: gcs-storage
        persistentVolumeClaim:
          claimName: ray-gcs-pvc
```

### Worker Node Spot Tolerance

```yaml
workerGroupSpecs:
- groupName: spot-workers
  template:
    spec:
      nodeSelector:
        node.kubernetes.io/lifecycle: spot
      tolerations:
      - key: "cloud.google.com/gke-spot"
        operator: "Equal"
        value: "true"
        effect: "NoSchedule"
      terminationGracePeriodSeconds: 30
      containers:
      - name: ray-worker
        # SIGTERM handler — Ray workers drain tasks gracefully on SIGTERM
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "ray stop --force"]
```

Ray actors on failed workers are automatically restarted if `max_restarts` is set:

```python
@ray.remote(max_restarts=3, max_task_retries=2)
class ResilienceActor:
    def compute(self, data):
        return process(data)
```

## Resource Groups

Segregate CPU and GPU workloads into separate worker groups with labeled scheduling:

```yaml
  workerGroupSpecs:
  - groupName: cpu-default
    replicas: 3
    minReplicas: 1
    maxReplicas: 50
    rayStartParams:
      resources: '"{\"cpu_pool\": 1}"'
    template:
      spec:
        nodeSelector:
          workload-type: cpu
        containers:
        - name: ray-worker
          resources:
            requests:
              cpu: "8"
              memory: "32Gi"

  - groupName: gpu-a100
    replicas: 0
    minReplicas: 0
    maxReplicas: 8
    rayStartParams:
      num-gpus: "1"
      resources: '"{\"gpu_pool\": 1}"'
    template:
      spec:
        nodeSelector:
          accelerator: nvidia-a100
        containers:
        - name: ray-worker
          resources:
            requests:
              nvidia.com/gpu: "1"
```

Target specific resource pools from Python:

```python
@ray.remote(resources={"gpu_pool": 1, "GPU": 1})
def gpu_task(data):
    ...

@ray.remote(resources={"cpu_pool": 1})
def cpu_task(data):
    ...
```

## Monitoring

### Prometheus Scrape Configuration

Ray exports metrics from the head node on port `44217`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ray-cluster
  namespace: monitoring
spec:
  selector:
    matchLabels:
      ray.io/node-type: head
  namespaceSelector:
    matchNames:
    - ray-workloads
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
```

### Key Ray Metrics

| Metric | Description |
|--------|-------------|
| `ray_node_cpu_utilization` | CPU utilization per node |
| `ray_node_mem_used` | Memory used per node |
| `ray_node_gpus_utilization` | GPU utilization (requires DCGM or nvidia-smi) |
| `ray_tasks_running` | Currently executing tasks |
| `ray_tasks_failed_total` | Total failed task executions |
| `ray_actors_running` | Currently running actor handles |
| `ray_object_store_memory` | Object store used bytes |
| `ray_serve_deployment_request_total` | Requests per deployment |
| `ray_serve_deployment_error_total` | Errors per deployment |
| `ray_serve_deployment_processing_latency_ms` | Request latency histogram |

### PrometheusRule Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ray-alerts
  namespace: monitoring
spec:
  groups:
  - name: ray-cluster
    rules:
    - alert: RayHeadNodeDown
      expr: |
        absent(ray_node_cpu_utilization{node_type="head"})
      for: 3m
      labels:
        severity: critical
      annotations:
        summary: "Ray head node is unreachable"
        description: "No metrics from Ray head node for 3 minutes — cluster may be unrecoverable"

    - alert: RayHighTaskFailureRate
      expr: |
        rate(ray_tasks_failed_total[5m]) > 10
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "Ray task failure rate elevated"
        description: "Ray is failing more than 10 tasks per second"

    - alert: RayObjectStoreNearFull
      expr: |
        ray_object_store_memory / ray_node_mem_total > 0.85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Ray object store approaching capacity"
        description: "Node {{ $labels.node_id }} object store is {{ $value | humanizePercentage }} full"

    - alert: RayServeHighLatency
      expr: |
        histogram_quantile(0.99, rate(ray_serve_deployment_processing_latency_ms_bucket[5m])) > 1000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Ray Serve p99 latency exceeds 1 second"
        description: "Deployment {{ $labels.deployment }} p99 latency is {{ $value }}ms"
```

### Ray Dashboard Access

Expose the dashboard through an Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ray-dashboard
  namespace: ray-workloads
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - ray.company.com
    secretName: ray-dashboard-tls
  rules:
  - host: ray.company.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ray-cluster-head-svc
            port:
              number: 8265
```

## Production Sizing Recommendations

### Small Cluster (development / prototyping)

| Node Role | Count | CPU | Memory | GPU |
|-----------|-------|-----|--------|-----|
| Head | 1 | 4 vCPU | 16 GiB | 0 |
| CPU Workers | 2–5 | 8 vCPU | 32 GiB | 0 |
| GPU Workers | 0–2 | 8 vCPU | 32 GiB | 1× A10G |

### Medium Cluster (training teams, 5–20 users)

| Node Role | Count | CPU | Memory | GPU |
|-----------|-------|-----|--------|-----|
| Head | 1 | 16 vCPU | 64 GiB | 0 |
| CPU Workers | 5–20 | 32 vCPU | 128 GiB | 0 |
| GPU Workers | 0–8 | 32 vCPU | 128 GiB | 4× A100 |

### Large Cluster (LLM fine-tuning / production serving)

| Node Role | Count | CPU | Memory | GPU |
|-----------|-------|-----|--------|-----|
| Head (HA) | 2 | 32 vCPU | 128 GiB | 0 |
| CPU Workers | 10–100 | 64 vCPU | 256 GiB | 0 |
| GPU Workers | 0–32 | 96 vCPU | 384 GiB | 8× H100 |

Head node HA requires GCS fault tolerance with an external Redis or etcd backend, available in Ray 2.9+:

```yaml
headGroupSpec:
  rayStartParams:
    gcs-ft-redis-address: "redis://redis-ha.redis.svc.cluster.local:6379"
    storage: "redis://redis-ha.redis.svc.cluster.local:6379"
```

## Conclusion

KubeRay bridges the gap between Python-first distributed computing and Kubernetes-native operations. The three CRDs (`RayCluster`, `RayJob`, `RayService`) map cleanly to the three operational patterns — long-running interactive research, batch training jobs, and persistent model serving.

Key production takeaways:

- Always set `num-cpus: "0"` on the head node to reserve it exclusively for GCS and scheduling
- Use `RayJob` for training workloads rather than `RayCluster` — the automatic teardown prevents idle GPU billing
- Enable `enableInTreeAutoscaling` with conservative `idleTimeoutSeconds` (300–600s) to balance responsiveness and cost
- Protect spot-instance worker groups with `preStop` drain hooks and task-level `max_restarts`
- Configure the `ServiceMonitor` and alert on `ray_tasks_failed_total` and `ray_serve_deployment_error_total` before going to production
- For multi-GPU training, prefer node-local NVLink bandwidth — schedule all workers of a single training job on the same physical host when possible using pod affinity rules
