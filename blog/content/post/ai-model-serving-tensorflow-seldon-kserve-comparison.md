---
title: "AI Model Serving: TensorFlow Serving vs Seldon vs KServe - Complete Production Comparison"
date: 2026-04-26T00:00:00-05:00
draft: false
tags: ["AI Model Serving", "TensorFlow Serving", "Seldon", "KServe", "Machine Learning", "MLOps", "Kubernetes", "AI Infrastructure"]
categories:
- AI Infrastructure
- MLOps
- Model Serving
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive comparison of TensorFlow Serving, Seldon Core, and KServe for AI model serving with performance benchmarks, A/B testing, auto-scaling, multi-model serving, and production deployment strategies."
more_link: "yes"
url: "/ai-model-serving-tensorflow-seldon-kserve-comparison/"
---

Choosing the right model serving platform is crucial for deploying AI models at scale in production environments. This comprehensive guide compares TensorFlow Serving, Seldon Core, and KServe across multiple dimensions including performance, features, scalability, and operational complexity. We'll explore real-world scenarios with practical implementations, benchmarks, and deployment strategies for each platform.

<!--more-->

# [AI Model Serving: TensorFlow Serving vs Seldon vs KServe](#ai-model-serving-tensorflow-seldon-kserve-comparison)

## Section 1: Model Serving Architecture Comparison

### TensorFlow Serving Architecture

TensorFlow Serving is designed specifically for TensorFlow models with high-performance inference capabilities and production-ready features.

```yaml
# tensorflow-serving-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tensorflow-serving
  namespace: model-serving
  labels:
    app: tensorflow-serving
    version: stable
spec:
  replicas: 3
  selector:
    matchLabels:
      app: tensorflow-serving
  template:
    metadata:
      labels:
        app: tensorflow-serving
        version: stable
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8501"
        prometheus.io/path: "/monitoring/prometheus/metrics"
    spec:
      containers:
      - name: tensorflow-serving
        image: tensorflow/serving:2.14.0
        ports:
        - containerPort: 8500
          name: grpc
        - containerPort: 8501
          name: rest
        args:
        - "--model_config_file=/models/models.config"
        - "--model_config_file_poll_wait_seconds=60"
        - "--allow_version_labels_for_unavailable_models=true"
        - "--enable_batching=true"
        - "--batching_parameters_file=/models/batching_config.txt"
        - "--monitoring_config_file=/models/monitoring_config.txt"
        - "--rest_api_port=8501"
        - "--rest_api_num_threads=32"
        - "--rest_api_timeout_in_ms=30000"
        - "--enable_model_warmup=true"
        env:
        - name: MODEL_NAME
          value: "production_model"
        - name: TF_CPP_MIN_LOG_LEVEL
          value: "1"
        - name: TF_ENABLE_ONEDNN_OPTS
          value: "1"
        resources:
          requests:
            cpu: "2"
            memory: "4Gi"
          limits:
            cpu: "8"
            memory: "16Gi"
        volumeMounts:
        - name: models
          mountPath: /models
          readOnly: true
        - name: config
          mountPath: /models/models.config
          subPath: models.config
        - name: batching-config
          mountPath: /models/batching_config.txt
          subPath: batching_config.txt
        - name: monitoring-config
          mountPath: /models/monitoring_config.txt
          subPath: monitoring_config.txt
        livenessProbe:
          httpGet:
            path: /v1/models/production_model
            port: 8501
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /v1/models/production_model
            port: 8501
          initialDelaySeconds: 15
          periodSeconds: 5
      volumes:
      - name: models
        persistentVolumeClaim:
          claimName: model-storage-pvc
      - name: config
        configMap:
          name: tensorflow-serving-config
      - name: batching-config
        configMap:
          name: batching-config
      - name: monitoring-config
        configMap:
          name: monitoring-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: tensorflow-serving-config
  namespace: model-serving
data:
  models.config: |
    model_config_list {
      config {
        name: 'production_model'
        base_path: '/models/production_model'
        model_platform: 'tensorflow'
        model_version_policy {
          specific {
            versions: 1
            versions: 2
          }
        }
        version_labels {
          key: 'stable'
          value: 1
        }
        version_labels {
          key: 'canary'
          value: 2
        }
        logging_config {
          log_requests: true
          log_responses: true
          sampling_config {
            sampling_rate: 0.1
          }
        }
      }
      config {
        name: 'preprocessing_model'
        base_path: '/models/preprocessing_model'
        model_platform: 'tensorflow'
        model_version_policy {
          latest {
            num_versions: 1
          }
        }
      }
      config {
        name: 'ensemble_model'
        base_path: '/models/ensemble_model'
        model_platform: 'tensorflow'
        model_version_policy {
          latest {
            num_versions: 2
          }
        }
      }
    }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: batching-config
  namespace: model-serving
data:
  batching_config.txt: |
    max_batch_size { value: 32 }
    batch_timeout_micros { value: 5000 }
    max_enqueued_batches { value: 1000 }
    num_batch_threads { value: 8 }
    allowed_batch_sizes: 1
    allowed_batch_sizes: 2
    allowed_batch_sizes: 4
    allowed_batch_sizes: 8
    allowed_batch_sizes: 16
    allowed_batch_sizes: 32
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: monitoring-config
  namespace: model-serving
data:
  monitoring_config.txt: |
    prometheus_config {
      enable: true
      path: "/monitoring/prometheus/metrics"
    }
---
apiVersion: v1
kind: Service
metadata:
  name: tensorflow-serving-service
  namespace: model-serving
  labels:
    app: tensorflow-serving
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8501"
spec:
  selector:
    app: tensorflow-serving
  ports:
  - name: grpc
    port: 8500
    targetPort: 8500
  - name: rest
    port: 8501
    targetPort: 8501
  type: ClusterIP
```

### Seldon Core Architecture

Seldon Core provides a more flexible, language-agnostic approach with advanced features like multi-armed bandits and complex inference graphs.

```yaml
# seldon-deployment.yaml
apiVersion: machinelearning.seldon.io/v1
kind: SeldonDeployment
metadata:
  name: production-model-seldon
  namespace: model-serving
spec:
  name: production-model
  protocol: tensorflow
  transport: rest
  replicas: 3
  annotations:
    seldon.io/ambassador-config: |
      ---
      apiVersion: ambassador/v1
      kind: Mapping
      name: production-model-mapping
      prefix: /seldon/model-serving/production-model/
      service: production-model-seldon-production-model:8000
      timeout_ms: 30000
  predictors:
  - name: default
    replicas: 3
    traffic: 90
    annotations:
      predictor_version: v1
    graph:
      name: classifier
      implementation: TENSORFLOW_SERVER
      modelUri: gs://my-bucket/models/production-model/1
      envSecretRefName: gcs-credentials
      parameters:
      - name: signature_name
        value: serving_default
      - name: model_name
        value: production_model
      children: []
    componentSpecs:
    - spec:
        containers:
        - name: classifier
          image: tensorflow/serving:2.14.0
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
              nvidia.com/gpu: "1"
            limits:
              cpu: "4"
              memory: "8Gi"
              nvidia.com/gpu: "1"
          env:
          - name: SELDON_LOG_LEVEL
            value: INFO
          - name: TF_CPP_MIN_LOG_LEVEL
            value: "1"
          volumeMounts:
          - name: model-storage
            mountPath: /mnt/models
            readOnly: true
        volumes:
        - name: model-storage
          persistentVolumeClaim:
            claimName: model-storage-pvc
        terminationGracePeriodSeconds: 60
  - name: canary
    replicas: 1
    traffic: 10
    annotations:
      predictor_version: v2
    graph:
      name: classifier-v2
      implementation: TENSORFLOW_SERVER
      modelUri: gs://my-bucket/models/production-model/2
      envSecretRefName: gcs-credentials
      parameters:
      - name: signature_name
        value: serving_default
      - name: model_name
        value: production_model_v2
      children: []
    componentSpecs:
    - spec:
        containers:
        - name: classifier-v2
          image: tensorflow/serving:2.14.0
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
              nvidia.com/gpu: "1"
            limits:
              cpu: "4"
              memory: "8Gi"
              nvidia.com/gpu: "1"
          env:
          - name: SELDON_LOG_LEVEL
            value: INFO
          - name: TF_CPP_MIN_LOG_LEVEL
            value: "1"
---
apiVersion: machinelearning.seldon.io/v1
kind: SeldonDeployment
metadata:
  name: ensemble-model-seldon
  namespace: model-serving
spec:
  name: ensemble-model
  protocol: tensorflow
  transport: rest
  annotations:
    seldon.io/engine-separate-pod: "true"
  predictors:
  - name: ensemble
    annotations:
      predictor_version: ensemble-v1
    graph:
      name: ensemble-combiner
      implementation: RANDOM_ABTEST
      parameters:
      - name: ratioA
        value: "0.7"
      - name: ratioB
        value: "0.3"
      children:
      - name: model-a
        implementation: TENSORFLOW_SERVER
        modelUri: gs://my-bucket/models/model-a/1
        envSecretRefName: gcs-credentials
        children: []
      - name: model-b
        implementation: TENSORFLOW_SERVER
        modelUri: gs://my-bucket/models/model-b/1
        envSecretRefName: gcs-credentials
        children: []
    componentSpecs:
    - spec:
        containers:
        - name: model-a
          image: tensorflow/serving:2.14.0
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
        - name: model-b
          image: tensorflow/serving:2.14.0
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
        - name: ensemble-combiner
          image: seldonio/seldon-core-s2i-python3:1.18.0
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "1"
              memory: "2Gi"
---
# Advanced Seldon Analytics Configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: seldon-analytics-config
  namespace: model-serving
data:
  values.yaml: |
    analytics:
      enabled: true
      persistence:
        enabled: true
        storageClass: fast-ssd
        size: 100Gi
      prometheus:
        enabled: true
        seldon_http_requests_total: true
        seldon_api_executor_client_requests_seconds: true
        seldon_api_executor_server_requests_seconds: true
      grafana:
        enabled: true
        adminPassword: admin123
      elasticsearch:
        enabled: true
        image:
          tag: 7.17.0
        persistence:
          enabled: true
          size: 50Gi
```

### KServe Architecture

KServe (formerly KFServing) provides Kubernetes-native model serving with advanced features like auto-scaling, traffic splitting, and model explainability.

```yaml
# kserve-deployment.yaml
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: production-model-kserve
  namespace: model-serving
  annotations:
    serving.kserve.io/autoscaling.knative.dev: "kpa.autoscaling.knative.dev"
    serving.kserve.io/metric: "concurrency"
    serving.kserve.io/target: "10"
    serving.kserve.io/scaleToZero: "true"
    serving.kserve.io/scaleToZeroPodRetentionPeriod: "300s"
spec:
  predictor:
    serviceAccountName: kserve-sa
    minReplicas: 1
    maxReplicas: 20
    scaleTarget: 80
    scaleMetric: concurrency
    tensorflow:
      storageUri: "gs://my-bucket/models/production-model"
      runtimeVersion: "2.14.0"
      resources:
        requests:
          cpu: "2"
          memory: "4Gi"
          nvidia.com/gpu: "1"
        limits:
          cpu: "4"
          memory: "8Gi"
          nvidia.com/gpu: "1"
      env:
      - name: TF_CPP_MIN_LOG_LEVEL
        value: "1"
      - name: TF_ENABLE_ONEDNN_OPTS
        value: "1"
      ports:
      - containerPort: 8080
        name: h2c
        protocol: TCP
      args:
      - --model_name=production_model
      - --port=8080
      - --rest_api_port=8080
      - --model_config_file=/mnt/models/models.config
      - --enable_batching=true
      - --batching_parameters_file=/mnt/models/batching_config.txt
      - --enable_model_warmup=true
      volumeMounts:
      - name: model-config
        mountPath: /mnt/models
        readOnly: true
    volumes:
    - name: model-config
      configMap:
        name: tensorflow-serving-config
  transformer:
    containers:
    - name: kserve-container
      image: kserve/transformer:v0.11.0
      env:
      - name: STORAGE_URI
        value: "gs://my-bucket/transformers/preprocessing"
      - name: TRANSFORMER_TYPE
        value: "sklearn"
      resources:
        requests:
          cpu: "500m"
          memory: "1Gi"
        limits:
          cpu: "1"
          memory: "2Gi"
  explainer:
    alibi:
      type: AnchorTabular
      storageUri: "gs://my-bucket/explainers/anchor-tabular"
      resources:
        requests:
          cpu: "500m"
          memory: "2Gi"
        limits:
          cpu: "1"
          memory: "4Gi"
---
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: multi-model-kserve
  namespace: model-serving
  annotations:
    serving.kserve.io/autoscaling.knative.dev: "kpa.autoscaling.knative.dev"
    serving.kserve.io/targetUtilizationPercentage: "70"
spec:
  predictor:
    model:
      modelFormat:
        name: sklearn
      storageUri: "gs://my-bucket/models/multi-model"
      resources:
        requests:
          cpu: "1"
          memory: "2Gi"
        limits:
          cpu: "4"
          memory: "8Gi"
      env:
      - name: STORAGE_URI
        value: "gs://my-bucket/models"
      runtime: kserve-sklearnserver
---
# Traffic splitting configuration
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: canary-deployment-kserve
  namespace: model-serving
spec:
  predictor:
    canaryTrafficPercent: 20
    tensorflow:
      storageUri: "gs://my-bucket/models/production-model/v2"
      runtimeVersion: "2.14.0"
      resources:
        requests:
          cpu: "2"
          memory: "4Gi"
        limits:
          cpu: "4"
          memory: "8Gi"
  canary:
    tensorflow:
      storageUri: "gs://my-bucket/models/production-model/v1"
      runtimeVersion: "2.14.0"
      resources:
        requests:
          cpu: "2"
          memory: "4Gi"
        limits:
          cpu: "4"
          memory: "8Gi"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kserve-sa
  namespace: model-serving
  annotations:
    iam.gke.io/gcp-service-account: kserve-workload-identity@my-project.iam.gserviceaccount.com
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kserve-role
rules:
- apiGroups: [""]
  resources: ["pods", "services", "endpoints", "events"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["serving.kserve.io"]
  resources: ["inferenceservices"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["networking.istio.io"]
  resources: ["virtualservices", "destinationrules"]
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
  namespace: model-serving
```

## Section 2: Performance Benchmarks and Analysis

### Comprehensive Benchmarking Framework

```python
# model_serving_benchmark.py
import asyncio
import aiohttp
import time
import statistics
import json
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass, asdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
import logging

@dataclass
class BenchmarkConfig:
    """Configuration for benchmarking tests."""
    endpoint_url: str
    model_name: str
    platform: str  # tensorflow, seldon, kserve
    concurrent_requests: int = 10
    total_requests: int = 1000
    warmup_requests: int = 50
    timeout_seconds: int = 30
    payload_size: str = "small"  # small, medium, large
    test_duration_minutes: Optional[int] = None

@dataclass
class BenchmarkResult:
    """Results from a single benchmark run."""
    platform: str
    endpoint_url: str
    concurrent_requests: int
    total_requests: int
    successful_requests: int
    failed_requests: int
    total_time_seconds: float
    avg_latency_ms: float
    p50_latency_ms: float
    p95_latency_ms: float
    p99_latency_ms: float
    min_latency_ms: float
    max_latency_ms: float
    throughput_rps: float
    error_rate: float
    cpu_usage_avg: float
    memory_usage_avg: float
    gpu_usage_avg: float

class ModelServingBenchmark:
    """Comprehensive benchmarking suite for model serving platforms."""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        logging.basicConfig(level=logging.INFO)
        
        # Test payloads of different sizes
        self.payloads = {
            "small": self._generate_payload(10),
            "medium": self._generate_payload(100),
            "large": self._generate_payload(1000)
        }
    
    def _generate_payload(self, size: int) -> Dict:
        """Generate test payload of specified size."""
        return {
            "instances": [
                {
                    "input_data": np.random.randn(size).tolist(),
                    "features": {
                        f"feature_{i}": np.random.randn() for i in range(min(size // 10, 50))
                    }
                }
            ]
        }
    
    async def _make_request(self, 
                          session: aiohttp.ClientSession, 
                          url: str, 
                          payload: Dict,
                          platform: str) -> Tuple[float, bool, Optional[str]]:
        """Make a single inference request."""
        start_time = time.time()
        
        try:
            # Adjust URL based on platform
            if platform == "tensorflow":
                endpoint = f"{url}/v1/models/{payload.get('model_name', 'production_model')}:predict"
            elif platform == "seldon":
                endpoint = f"{url}/api/v1.0/predictions"
            elif platform == "kserve":
                endpoint = f"{url}/v1/models/{payload.get('model_name', 'production-model-kserve')}:predict"
            else:
                endpoint = url
            
            async with session.post(endpoint, json=payload, timeout=30) as response:
                await response.json()
                latency = (time.time() - start_time) * 1000  # Convert to ms
                return latency, response.status == 200, None
                
        except asyncio.TimeoutError:
            latency = (time.time() - start_time) * 1000
            return latency, False, "timeout"
        except Exception as e:
            latency = (time.time() - start_time) * 1000
            return latency, False, str(e)
    
    async def _run_load_test(self, config: BenchmarkConfig) -> List[Tuple[float, bool, Optional[str]]]:
        """Run load test with specified configuration."""
        payload = self.payloads[config.payload_size].copy()
        payload["model_name"] = config.model_name
        
        connector = aiohttp.TCPConnector(limit=config.concurrent_requests * 2)
        timeout = aiohttp.ClientTimeout(total=config.timeout_seconds)
        
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            # Warmup requests
            self.logger.info(f"Running {config.warmup_requests} warmup requests...")
            warmup_tasks = [
                self._make_request(session, config.endpoint_url, payload, config.platform)
                for _ in range(config.warmup_requests)
            ]
            await asyncio.gather(*warmup_tasks, return_exceptions=True)
            
            # Main test
            self.logger.info(f"Running {config.total_requests} test requests with {config.concurrent_requests} concurrent connections...")
            
            # Create semaphore to limit concurrent requests
            semaphore = asyncio.Semaphore(config.concurrent_requests)
            
            async def bounded_request():
                async with semaphore:
                    return await self._make_request(session, config.endpoint_url, payload, config.platform)
            
            start_time = time.time()
            
            if config.test_duration_minutes:
                # Time-based test
                results = []
                end_time = start_time + (config.test_duration_minutes * 60)
                
                while time.time() < end_time:
                    batch_size = min(config.concurrent_requests, 
                                   int((end_time - time.time()) * config.concurrent_requests / 10))
                    if batch_size <= 0:
                        break
                    
                    batch_tasks = [bounded_request() for _ in range(batch_size)]
                    batch_results = await asyncio.gather(*batch_tasks, return_exceptions=True)
                    results.extend([r for r in batch_results if not isinstance(r, Exception)])
                    
                    await asyncio.sleep(0.1)  # Small delay between batches
            else:
                # Request count-based test
                tasks = [bounded_request() for _ in range(config.total_requests)]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                results = [r for r in results if not isinstance(r, Exception)]
            
            return results
    
    def _calculate_metrics(self, 
                         results: List[Tuple[float, bool, Optional[str]]], 
                         total_time: float,
                         config: BenchmarkConfig) -> BenchmarkResult:
        """Calculate performance metrics from test results."""
        
        latencies = [r[0] for r in results if r[1]]  # Only successful requests
        successful = sum(1 for r in results if r[1])
        failed = len(results) - successful
        
        if not latencies:
            return BenchmarkResult(
                platform=config.platform,
                endpoint_url=config.endpoint_url,
                concurrent_requests=config.concurrent_requests,
                total_requests=len(results),
                successful_requests=0,
                failed_requests=len(results),
                total_time_seconds=total_time,
                avg_latency_ms=0,
                p50_latency_ms=0,
                p95_latency_ms=0,
                p99_latency_ms=0,
                min_latency_ms=0,
                max_latency_ms=0,
                throughput_rps=0,
                error_rate=100.0,
                cpu_usage_avg=0,
                memory_usage_avg=0,
                gpu_usage_avg=0
            )
        
        return BenchmarkResult(
            platform=config.platform,
            endpoint_url=config.endpoint_url,
            concurrent_requests=config.concurrent_requests,
            total_requests=len(results),
            successful_requests=successful,
            failed_requests=failed,
            total_time_seconds=total_time,
            avg_latency_ms=statistics.mean(latencies),
            p50_latency_ms=np.percentile(latencies, 50),
            p95_latency_ms=np.percentile(latencies, 95),
            p99_latency_ms=np.percentile(latencies, 99),
            min_latency_ms=min(latencies),
            max_latency_ms=max(latencies),
            throughput_rps=successful / total_time,
            error_rate=(failed / len(results)) * 100,
            cpu_usage_avg=0,  # TODO: Integrate with monitoring
            memory_usage_avg=0,
            gpu_usage_avg=0
        )
    
    async def run_benchmark(self, config: BenchmarkConfig) -> BenchmarkResult:
        """Run complete benchmark with specified configuration."""
        self.logger.info(f"Starting benchmark for {config.platform} at {config.endpoint_url}")
        
        start_time = time.time()
        results = await self._run_load_test(config)
        total_time = time.time() - start_time
        
        benchmark_result = self._calculate_metrics(results, total_time, config)
        
        self.logger.info(f"Benchmark completed:")
        self.logger.info(f"  Throughput: {benchmark_result.throughput_rps:.2f} RPS")
        self.logger.info(f"  Average latency: {benchmark_result.avg_latency_ms:.2f} ms")
        self.logger.info(f"  P95 latency: {benchmark_result.p95_latency_ms:.2f} ms")
        self.logger.info(f"  Error rate: {benchmark_result.error_rate:.2f}%")
        
        return benchmark_result
    
    def run_comparative_benchmark(self, configs: List[BenchmarkConfig]) -> pd.DataFrame:
        """Run benchmarks across multiple platforms and compare results."""
        results = []
        
        async def run_all_benchmarks():
            tasks = [self.run_benchmark(config) for config in configs]
            return await asyncio.gather(*tasks)
        
        benchmark_results = asyncio.run(run_all_benchmarks())
        
        # Convert to DataFrame for analysis
        df_data = []
        for result in benchmark_results:
            df_data.append(asdict(result))
        
        df = pd.DataFrame(df_data)
        return df
    
    def visualize_results(self, df: pd.DataFrame, output_path: str = "benchmark_results.png"):
        """Create visualization of benchmark results."""
        fig, axes = plt.subplots(2, 3, figsize=(18, 12))
        fig.suptitle('Model Serving Platform Comparison', fontsize=16)
        
        # Throughput comparison
        axes[0, 0].bar(df['platform'], df['throughput_rps'])
        axes[0, 0].set_title('Throughput (RPS)')
        axes[0, 0].set_ylabel('Requests per Second')
        
        # Latency comparison
        latency_metrics = ['avg_latency_ms', 'p50_latency_ms', 'p95_latency_ms', 'p99_latency_ms']
        df_latency = df[['platform'] + latency_metrics].set_index('platform')
        df_latency.plot(kind='bar', ax=axes[0, 1])
        axes[0, 1].set_title('Latency Comparison')
        axes[0, 1].set_ylabel('Latency (ms)')
        axes[0, 1].legend(bbox_to_anchor=(1.05, 1), loc='upper left')
        
        # Error rate comparison
        axes[0, 2].bar(df['platform'], df['error_rate'])
        axes[0, 2].set_title('Error Rate')
        axes[0, 2].set_ylabel('Error Rate (%)')
        
        # Latency vs Throughput scatter
        for platform in df['platform'].unique():
            platform_data = df[df['platform'] == platform]
            axes[1, 0].scatter(platform_data['throughput_rps'], 
                             platform_data['avg_latency_ms'], 
                             label=platform, s=100)
        axes[1, 0].set_xlabel('Throughput (RPS)')
        axes[1, 0].set_ylabel('Average Latency (ms)')
        axes[1, 0].set_title('Latency vs Throughput')
        axes[1, 0].legend()
        
        # Concurrency impact
        if len(df['concurrent_requests'].unique()) > 1:
            for platform in df['platform'].unique():
                platform_data = df[df['platform'] == platform]
                axes[1, 1].plot(platform_data['concurrent_requests'], 
                              platform_data['throughput_rps'], 
                              marker='o', label=platform)
            axes[1, 1].set_xlabel('Concurrent Requests')
            axes[1, 1].set_ylabel('Throughput (RPS)')
            axes[1, 1].set_title('Concurrency Impact')
            axes[1, 1].legend()
        
        # Latency distribution
        latency_data = []
        platforms = []
        for _, row in df.iterrows():
            latency_data.extend([row['min_latency_ms'], row['p50_latency_ms'], 
                               row['p95_latency_ms'], row['max_latency_ms']])
            platforms.extend([row['platform']] * 4)
        
        latency_df = pd.DataFrame({
            'latency': latency_data,
            'platform': platforms
        })
        
        sns.boxplot(data=latency_df, x='platform', y='latency', ax=axes[1, 2])
        axes[1, 2].set_title('Latency Distribution')
        axes[1, 2].set_ylabel('Latency (ms)')
        
        plt.tight_layout()
        plt.savefig(output_path, dpi=300, bbox_inches='tight')
        plt.show()
    
    def generate_report(self, df: pd.DataFrame, output_path: str = "benchmark_report.html"):
        """Generate detailed HTML report of benchmark results."""
        
        html_template = """
        <!DOCTYPE html>
        <html>
        <head>
            <title>Model Serving Platform Benchmark Report</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; }
                .header { background-color: #f0f0f0; padding: 20px; border-radius: 5px; }
                .metric { display: inline-block; margin: 10px; padding: 15px; 
                         background-color: #e8f4fd; border-radius: 5px; min-width: 150px; }
                .platform-section { margin: 30px 0; padding: 20px; 
                                  border: 1px solid #ddd; border-radius: 5px; }
                table { border-collapse: collapse; width: 100%; margin: 20px 0; }
                th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
                th { background-color: #f2f2f2; }
                .best { background-color: #d4edda; }
                .worst { background-color: #f8d7da; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>Model Serving Platform Benchmark Report</h1>
                <p>Generated on: {timestamp}</p>
                <p>Platforms tested: {platforms}</p>
            </div>
            
            <h2>Executive Summary</h2>
            <div class="metric">
                <h3>Best Throughput</h3>
                <p>{best_throughput_platform}: {best_throughput:.2f} RPS</p>
            </div>
            <div class="metric">
                <h3>Best Latency</h3>
                <p>{best_latency_platform}: {best_latency:.2f} ms</p>
            </div>
            <div class="metric">
                <h3>Most Reliable</h3>
                <p>{most_reliable_platform}: {best_error_rate:.2f}% error rate</p>
            </div>
            
            <h2>Detailed Results</h2>
            {detailed_table}
            
            <h2>Platform Analysis</h2>
            {platform_analysis}
            
            <h2>Recommendations</h2>
            {recommendations}
        </body>
        </html>
        """
        
        # Calculate summary metrics
        best_throughput_idx = df['throughput_rps'].idxmax()
        best_latency_idx = df['avg_latency_ms'].idxmin()
        most_reliable_idx = df['error_rate'].idxmin()
        
        # Generate detailed table
        df_display = df.copy()
        numeric_columns = ['throughput_rps', 'avg_latency_ms', 'p95_latency_ms', 'error_rate']
        for col in numeric_columns:
            df_display[col] = df_display[col].round(2)
        
        detailed_table = df_display.to_html(classes='table', escape=False, index=False)
        
        # Generate platform analysis
        platform_analysis = ""
        for platform in df['platform'].unique():
            platform_data = df[df['platform'] == platform].iloc[0]
            platform_analysis += f"""
            <div class="platform-section">
                <h3>{platform}</h3>
                <p><strong>Throughput:</strong> {platform_data['throughput_rps']:.2f} RPS</p>
                <p><strong>Average Latency:</strong> {platform_data['avg_latency_ms']:.2f} ms</p>
                <p><strong>P95 Latency:</strong> {platform_data['p95_latency_ms']:.2f} ms</p>
                <p><strong>Error Rate:</strong> {platform_data['error_rate']:.2f}%</p>
            </div>
            """
        
        # Generate recommendations
        recommendations = """
        <ul>
            <li><strong>For highest throughput:</strong> Use {best_throughput_platform}</li>
            <li><strong>For lowest latency:</strong> Use {best_latency_platform}</li>
            <li><strong>For highest reliability:</strong> Use {most_reliable_platform}</li>
            <li><strong>For production workloads:</strong> Consider balancing throughput, latency, and operational complexity</li>
        </ul>
        """.format(
            best_throughput_platform=df.iloc[best_throughput_idx]['platform'],
            best_latency_platform=df.iloc[best_latency_idx]['platform'],
            most_reliable_platform=df.iloc[most_reliable_idx]['platform']
        )
        
        # Fill template
        html_content = html_template.format(
            timestamp=time.strftime("%Y-%m-%d %H:%M:%S"),
            platforms=", ".join(df['platform'].unique()),
            best_throughput_platform=df.iloc[best_throughput_idx]['platform'],
            best_throughput=df.iloc[best_throughput_idx]['throughput_rps'],
            best_latency_platform=df.iloc[best_latency_idx]['platform'],
            best_latency=df.iloc[best_latency_idx]['avg_latency_ms'],
            most_reliable_platform=df.iloc[most_reliable_idx]['platform'],
            best_error_rate=df.iloc[most_reliable_idx]['error_rate'],
            detailed_table=detailed_table,
            platform_analysis=platform_analysis,
            recommendations=recommendations
        )
        
        with open(output_path, 'w') as f:
            f.write(html_content)
        
        print(f"Report generated: {output_path}")

# Example usage and CLI
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Model Serving Platform Benchmark')
    parser.add_argument('--tensorflow-url', help='TensorFlow Serving endpoint URL')
    parser.add_argument('--seldon-url', help='Seldon Core endpoint URL')
    parser.add_argument('--kserve-url', help='KServe endpoint URL')
    parser.add_argument('--model-name', default='production_model', help='Model name')
    parser.add_argument('--concurrent-requests', type=int, default=10, help='Concurrent requests')
    parser.add_argument('--total-requests', type=int, default=1000, help='Total requests')
    parser.add_argument('--payload-size', choices=['small', 'medium', 'large'], 
                       default='medium', help='Payload size')
    parser.add_argument('--output-dir', default='.', help='Output directory for results')
    
    args = parser.parse_args()
    
    benchmark = ModelServingBenchmark()
    configs = []
    
    if args.tensorflow_url:
        configs.append(BenchmarkConfig(
            endpoint_url=args.tensorflow_url,
            model_name=args.model_name,
            platform="tensorflow",
            concurrent_requests=args.concurrent_requests,
            total_requests=args.total_requests,
            payload_size=args.payload_size
        ))
    
    if args.seldon_url:
        configs.append(BenchmarkConfig(
            endpoint_url=args.seldon_url,
            model_name=args.model_name,
            platform="seldon",
            concurrent_requests=args.concurrent_requests,
            total_requests=args.total_requests,
            payload_size=args.payload_size
        ))
    
    if args.kserve_url:
        configs.append(BenchmarkConfig(
            endpoint_url=args.kserve_url,
            model_name=args.model_name,
            platform="kserve",
            concurrent_requests=args.concurrent_requests,
            total_requests=args.total_requests,
            payload_size=args.payload_size
        ))
    
    if not configs:
        print("Please provide at least one endpoint URL")
        exit(1)
    
    # Run benchmarks
    results_df = benchmark.run_comparative_benchmark(configs)
    
    # Generate outputs
    results_df.to_csv(f"{args.output_dir}/benchmark_results.csv", index=False)
    benchmark.visualize_results(results_df, f"{args.output_dir}/benchmark_visualization.png")
    benchmark.generate_report(results_df, f"{args.output_dir}/benchmark_report.html")
    
    print("Benchmark completed! Check output files for detailed results.")
```

## Section 3: A/B Testing and Canary Deployments

### Advanced A/B Testing Framework

```python
# ab_testing_framework.py
import asyncio
import aiohttp
import json
import time
import numpy as np
import pandas as pd
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from kubernetes import client, config
import logging
from scipy import stats

@dataclass
class ABTestConfig:
    """Configuration for A/B testing experiments."""
    experiment_name: str
    control_endpoint: str
    treatment_endpoint: str
    traffic_split: float  # Percentage to treatment (0.0 to 1.0)
    success_metric: str  # 'accuracy', 'latency', 'custom'
    minimum_sample_size: int = 1000
    significance_level: float = 0.05
    test_duration_hours: int = 24
    ramping_strategy: str = "linear"  # linear, exponential, step

@dataclass
class ABTestResult:
    """Results from A/B test."""
    experiment_name: str
    control_samples: int
    treatment_samples: int
    control_mean: float
    treatment_mean: float
    control_std: float
    treatment_std: float
    p_value: float
    confidence_interval: Tuple[float, float]
    is_significant: bool
    effect_size: float
    statistical_power: float
    recommendation: str

class ABTestingFramework:
    """Advanced A/B testing framework for model serving platforms."""
    
    def __init__(self):
        try:
            config.load_incluster_config()
        except:
            config.load_kube_config()
        
        self.v1 = client.CoreV1Api()
        self.apps_v1 = client.AppsV1Api()
        self.custom_api = client.CustomObjectsApi()
        self.logger = logging.getLogger(__name__)
        
    async def setup_traffic_split(self, 
                                test_config: ABTestConfig,
                                platform: str) -> bool:
        """Setup traffic splitting for A/B test."""
        
        if platform == "seldon":
            return await self._setup_seldon_traffic_split(test_config)
        elif platform == "kserve":
            return await self._setup_kserve_traffic_split(test_config)
        elif platform == "istio":
            return await self._setup_istio_traffic_split(test_config)
        else:
            self.logger.error(f"Unsupported platform for traffic splitting: {platform}")
            return False
    
    async def _setup_seldon_traffic_split(self, test_config: ABTestConfig) -> bool:
        """Setup Seldon traffic split configuration."""
        
        try:
            # Update Seldon deployment with traffic split
            seldon_deployment = {
                "apiVersion": "machinelearning.seldon.io/v1",
                "kind": "SeldonDeployment",
                "metadata": {
                    "name": f"ab-test-{test_config.experiment_name}",
                    "namespace": "model-serving"
                },
                "spec": {
                    "name": test_config.experiment_name,
                    "predictors": [
                        {
                            "name": "control",
                            "traffic": int((1 - test_config.traffic_split) * 100),
                            "graph": {
                                "name": "control-model",
                                "endpoint": {"type": "REST"},
                                "type": "MODEL",
                                "children": []
                            }
                        },
                        {
                            "name": "treatment",
                            "traffic": int(test_config.traffic_split * 100),
                            "graph": {
                                "name": "treatment-model",
                                "endpoint": {"type": "REST"},
                                "type": "MODEL",
                                "children": []
                            }
                        }
                    ]
                }
            }
            
            # Apply configuration
            self.custom_api.create_namespaced_custom_object(
                group="machinelearning.seldon.io",
                version="v1",
                namespace="model-serving",
                plural="seldondeployments",
                body=seldon_deployment
            )
            
            self.logger.info(f"Seldon traffic split configured: {(1-test_config.traffic_split)*100:.1f}% control, {test_config.traffic_split*100:.1f}% treatment")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to setup Seldon traffic split: {e}")
            return False
    
    async def _setup_kserve_traffic_split(self, test_config: ABTestConfig) -> bool:
        """Setup KServe traffic split configuration."""
        
        try:
            # Update InferenceService with canary traffic
            inference_service = {
                "apiVersion": "serving.kserve.io/v1beta1",
                "kind": "InferenceService",
                "metadata": {
                    "name": f"ab-test-{test_config.experiment_name}",
                    "namespace": "model-serving"
                },
                "spec": {
                    "predictor": {
                        "canaryTrafficPercent": int(test_config.traffic_split * 100),
                        "tensorflow": {
                            "storageUri": test_config.treatment_endpoint
                        }
                    },
                    "canary": {
                        "tensorflow": {
                            "storageUri": test_config.control_endpoint
                        }
                    }
                }
            }
            
            # Apply configuration
            self.custom_api.create_namespaced_custom_object(
                group="serving.kserve.io",
                version="v1beta1",
                namespace="model-serving",
                plural="inferenceservices",
                body=inference_service
            )
            
            self.logger.info(f"KServe traffic split configured: {(1-test_config.traffic_split)*100:.1f}% control, {test_config.traffic_split*100:.1f}% treatment")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to setup KServe traffic split: {e}")
            return False
    
    async def _setup_istio_traffic_split(self, test_config: ABTestConfig) -> bool:
        """Setup Istio-based traffic split configuration."""
        
        try:
            # Create VirtualService for traffic splitting
            virtual_service = {
                "apiVersion": "networking.istio.io/v1beta1",
                "kind": "VirtualService",
                "metadata": {
                    "name": f"ab-test-{test_config.experiment_name}",
                    "namespace": "model-serving"
                },
                "spec": {
                    "hosts": [f"ab-test-{test_config.experiment_name}"],
                    "http": [
                        {
                            "match": [{"headers": {"x-experiment": {"exact": test_config.experiment_name}}}],
                            "route": [
                                {
                                    "destination": {"host": "control-service"},
                                    "weight": int((1 - test_config.traffic_split) * 100)
                                },
                                {
                                    "destination": {"host": "treatment-service"},
                                    "weight": int(test_config.traffic_split * 100)
                                }
                            ]
                        }
                    ]
                }
            }
            
            # Apply configuration
            self.custom_api.create_namespaced_custom_object(
                group="networking.istio.io",
                version="v1beta1",
                namespace="model-serving",
                plural="virtualservices",
                body=virtual_service
            )
            
            self.logger.info(f"Istio traffic split configured: {(1-test_config.traffic_split)*100:.1f}% control, {test_config.traffic_split*100:.1f}% treatment")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to setup Istio traffic split: {e}")
            return False
    
    async def collect_metrics(self, 
                            test_config: ABTestConfig,
                            duration_hours: float) -> Tuple[List[float], List[float]]:
        """Collect metrics from both control and treatment groups."""
        
        control_metrics = []
        treatment_metrics = []
        
        end_time = time.time() + (duration_hours * 3600)
        
        async with aiohttp.ClientSession() as session:
            while time.time() < end_time:
                # Collect control metrics
                try:
                    async with session.get(f"{test_config.control_endpoint}/metrics") as response:
                        if response.status == 200:
                            data = await response.json()
                            metric_value = self._extract_metric(data, test_config.success_metric)
                            if metric_value is not None:
                                control_metrics.append(metric_value)
                except Exception as e:
                    self.logger.warning(f"Failed to collect control metrics: {e}")
                
                # Collect treatment metrics
                try:
                    async with session.get(f"{test_config.treatment_endpoint}/metrics") as response:
                        if response.status == 200:
                            data = await response.json()
                            metric_value = self._extract_metric(data, test_config.success_metric)
                            if metric_value is not None:
                                treatment_metrics.append(metric_value)
                except Exception as e:
                    self.logger.warning(f"Failed to collect treatment metrics: {e}")
                
                # Wait before next collection
                await asyncio.sleep(60)  # Collect every minute
                
                # Early stopping if minimum sample size reached
                if (len(control_metrics) >= test_config.minimum_sample_size and 
                    len(treatment_metrics) >= test_config.minimum_sample_size):
                    
                    # Perform interim analysis
                    interim_result = self._analyze_results(
                        control_metrics, treatment_metrics, test_config
                    )
                    
                    if interim_result.is_significant:
                        self.logger.info("Early stopping: Significant result detected")
                        break
        
        return control_metrics, treatment_metrics
    
    def _extract_metric(self, data: Dict, metric_name: str) -> Optional[float]:
        """Extract specific metric from response data."""
        
        if metric_name == "accuracy":
            return data.get("accuracy", data.get("precision", None))
        elif metric_name == "latency":
            return data.get("response_time_ms", data.get("latency_ms", None))
        elif metric_name == "throughput":
            return data.get("requests_per_second", data.get("rps", None))
        else:
            return data.get(metric_name, None)
    
    def _analyze_results(self, 
                       control_data: List[float], 
                       treatment_data: List[float],
                       test_config: ABTestConfig) -> ABTestResult:
        """Perform statistical analysis of A/B test results."""
        
        if len(control_data) == 0 or len(treatment_data) == 0:
            return ABTestResult(
                experiment_name=test_config.experiment_name,
                control_samples=len(control_data),
                treatment_samples=len(treatment_data),
                control_mean=0,
                treatment_mean=0,
                control_std=0,
                treatment_std=0,
                p_value=1.0,
                confidence_interval=(0, 0),
                is_significant=False,
                effect_size=0,
                statistical_power=0,
                recommendation="Insufficient data"
            )
        
        # Basic statistics
        control_mean = np.mean(control_data)
        treatment_mean = np.mean(treatment_data)
        control_std = np.std(control_data, ddof=1)
        treatment_std = np.std(treatment_data, ddof=1)
        
        # Perform t-test
        t_statistic, p_value = stats.ttest_ind(treatment_data, control_data)
        
        # Calculate effect size (Cohen's d)
        pooled_std = np.sqrt(((len(control_data) - 1) * control_std**2 + 
                             (len(treatment_data) - 1) * treatment_std**2) / 
                            (len(control_data) + len(treatment_data) - 2))
        
        effect_size = (treatment_mean - control_mean) / pooled_std if pooled_std > 0 else 0
        
        # Calculate confidence interval
        se_diff = pooled_std * np.sqrt(1/len(control_data) + 1/len(treatment_data))
        df = len(control_data) + len(treatment_data) - 2
        t_critical = stats.t.ppf(1 - test_config.significance_level/2, df)
        diff = treatment_mean - control_mean
        margin_error = t_critical * se_diff
        confidence_interval = (diff - margin_error, diff + margin_error)
        
        # Calculate statistical power
        statistical_power = self._calculate_power(
            effect_size, len(control_data), len(treatment_data), test_config.significance_level
        )
        
        # Determine significance
        is_significant = p_value < test_config.significance_level
        
        # Generate recommendation
        recommendation = self._generate_recommendation(
            is_significant, effect_size, statistical_power, p_value
        )
        
        return ABTestResult(
            experiment_name=test_config.experiment_name,
            control_samples=len(control_data),
            treatment_samples=len(treatment_data),
            control_mean=control_mean,
            treatment_mean=treatment_mean,
            control_std=control_std,
            treatment_std=treatment_std,
            p_value=p_value,
            confidence_interval=confidence_interval,
            is_significant=is_significant,
            effect_size=effect_size,
            statistical_power=statistical_power,
            recommendation=recommendation
        )
    
    def _calculate_power(self, effect_size: float, n1: int, n2: int, alpha: float) -> float:
        """Calculate statistical power of the test."""
        
        # Simplified power calculation
        se = np.sqrt(1/n1 + 1/n2)
        critical_value = stats.norm.ppf(1 - alpha/2)
        beta = stats.norm.cdf(critical_value - effect_size/se)
        power = 1 - beta
        
        return max(0, min(1, power))
    
    def _generate_recommendation(self, 
                               is_significant: bool, 
                               effect_size: float, 
                               power: float, 
                               p_value: float) -> str:
        """Generate recommendation based on test results."""
        
        if not is_significant:
            if power < 0.8:
                return "Inconclusive: Increase sample size for adequate statistical power"
            else:
                return "No significant difference detected with adequate power"
        
        if abs(effect_size) < 0.2:
            return "Statistically significant but small practical effect"
        elif abs(effect_size) < 0.5:
            return "Statistically significant with medium practical effect"
        else:
            return "Statistically significant with large practical effect"
    
    async def run_ab_test(self, test_config: ABTestConfig, platform: str) -> ABTestResult:
        """Run complete A/B test experiment."""
        
        self.logger.info(f"Starting A/B test: {test_config.experiment_name}")
        
        # Setup traffic splitting
        if not await self.setup_traffic_split(test_config, platform):
            raise Exception("Failed to setup traffic splitting")
        
        # Wait for traffic split to take effect
        await asyncio.sleep(30)
        
        # Collect metrics
        control_data, treatment_data = await self.collect_metrics(
            test_config, test_config.test_duration_hours
        )
        
        # Analyze results
        result = self._analyze_results(control_data, treatment_data, test_config)
        
        self.logger.info(f"A/B test completed: {result.recommendation}")
        return result
    
    def generate_ab_test_report(self, result: ABTestResult, output_path: str):
        """Generate detailed A/B test report."""
        
        html_template = """
        <!DOCTYPE html>
        <html>
        <head>
            <title>A/B Test Report: {experiment_name}</title>
            <style>
                body {{ font-family: Arial, sans-serif; margin: 40px; }}
                .header {{ background-color: #f0f0f0; padding: 20px; border-radius: 5px; }}
                .metric {{ display: inline-block; margin: 10px; padding: 15px; 
                         background-color: #e8f4fd; border-radius: 5px; min-width: 150px; }}
                .significant {{ background-color: #d4edda; }}
                .not-significant {{ background-color: #f8d7da; }}
                table {{ border-collapse: collapse; width: 100%; margin: 20px 0; }}
                th, td {{ border: 1px solid #ddd; padding: 12px; text-align: left; }}
                th {{ background-color: #f2f2f2; }}
            </style>
        </head>
        <body>
            <div class="header">
                <h1>A/B Test Report: {experiment_name}</h1>
                <p>Test Status: <span class="{significance_class}">{significance_text}</span></p>
                <p>Recommendation: {recommendation}</p>
            </div>
            
            <h2>Test Summary</h2>
            <table>
                <tr><th>Metric</th><th>Control</th><th>Treatment</th><th>Difference</th></tr>
                <tr>
                    <td>Sample Size</td>
                    <td>{control_samples}</td>
                    <td>{treatment_samples}</td>
                    <td>-</td>
                </tr>
                <tr>
                    <td>Mean</td>
                    <td>{control_mean:.4f}</td>
                    <td>{treatment_mean:.4f}</td>
                    <td>{mean_diff:.4f}</td>
                </tr>
                <tr>
                    <td>Standard Deviation</td>
                    <td>{control_std:.4f}</td>
                    <td>{treatment_std:.4f}</td>
                    <td>-</td>
                </tr>
            </table>
            
            <h2>Statistical Analysis</h2>
            <div class="metric">
                <h3>P-Value</h3>
                <p>{p_value:.6f}</p>
            </div>
            <div class="metric">
                <h3>Effect Size</h3>
                <p>{effect_size:.4f}</p>
            </div>
            <div class="metric">
                <h3>Statistical Power</h3>
                <p>{statistical_power:.4f}</p>
            </div>
            <div class="metric">
                <h3>Confidence Interval</h3>
                <p>[{ci_lower:.4f}, {ci_upper:.4f}]</p>
            </div>
            
            <h2>Interpretation</h2>
            <p>{interpretation}</p>
            
        </body>
        </html>
        """
        
        significance_class = "significant" if result.is_significant else "not-significant"
        significance_text = "Statistically Significant" if result.is_significant else "Not Statistically Significant"
        
        interpretation = f"""
        The A/B test comparing the control and treatment groups shows:
        
        - {'Statistically significant' if result.is_significant else 'No statistically significant'} difference (p-value: {result.p_value:.6f})
        - Effect size: {abs(result.effect_size):.4f} ({'Small' if abs(result.effect_size) < 0.2 else 'Medium' if abs(result.effect_size) < 0.5 else 'Large'})
        - Statistical power: {result.statistical_power:.4f} ({'Adequate' if result.statistical_power >= 0.8 else 'Insufficient'})
        
        Based on these results: {result.recommendation}
        """
        
        html_content = html_template.format(
            experiment_name=result.experiment_name,
            significance_class=significance_class,
            significance_text=significance_text,
            recommendation=result.recommendation,
            control_samples=result.control_samples,
            treatment_samples=result.treatment_samples,
            control_mean=result.control_mean,
            treatment_mean=result.treatment_mean,
            mean_diff=result.treatment_mean - result.control_mean,
            control_std=result.control_std,
            treatment_std=result.treatment_std,
            p_value=result.p_value,
            effect_size=result.effect_size,
            statistical_power=result.statistical_power,
            ci_lower=result.confidence_interval[0],
            ci_upper=result.confidence_interval[1],
            interpretation=interpretation
        )
        
        with open(output_path, 'w') as f:
            f.write(html_content)
        
        print(f"A/B test report generated: {output_path}")

# Example usage
if __name__ == "__main__":
    # Configure A/B test
    test_config = ABTestConfig(
        experiment_name="model-v2-latency-test",
        control_endpoint="http://tensorflow-serving:8501",
        treatment_endpoint="http://kserve-predictor:8080",
        traffic_split=0.1,  # 10% to treatment
        success_metric="latency",
        minimum_sample_size=1000,
        test_duration_hours=24
    )
    
    # Run A/B test
    framework = ABTestingFramework()
    
    async def main():
        result = await framework.run_ab_test(test_config, "kserve")
        framework.generate_ab_test_report(result, "ab_test_report.html")
        return result
    
    result = asyncio.run(main())
    print(f"A/B test completed: {result.recommendation}")
```

## Section 4: Auto-scaling Strategies and Implementation

### Advanced Auto-scaling Configuration

```yaml
# advanced-autoscaling.yaml
# TensorFlow Serving HPA with custom metrics
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: tensorflow-serving-hpa
  namespace: model-serving
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: tensorflow-serving
  minReplicas: 2
  maxReplicas: 50
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
        name: requests_per_second
      target:
        type: AverageValue
        averageValue: "100"
  - type: Object
    object:
      metric:
        name: average_response_time_ms
      target:
        type: Value
        value: "50"
      describedObject:
        apiVersion: v1
        kind: Service
        name: tensorflow-serving-service
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
      - type: Pods
        value: 2
        periodSeconds: 60
      selectPolicy: Min
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 50
        periodSeconds: 30
      - type: Pods
        value: 5
        periodSeconds: 30
      selectPolicy: Max
---
# Seldon Core HPA with predictive scaling
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: seldon-model-hpa
  namespace: model-serving
  annotations:
    autoscaling.alpha.kubernetes.io/behavior: |
      scaleUp:
        stabilizationWindowSeconds: 60
        policies:
        - type: Percent
          value: 100
          periodSeconds: 15
        - type: Pods
          value: 4
          periodSeconds: 15
        selectPolicy: Max
      scaleDown:
        stabilizationWindowSeconds: 300
        policies:
        - type: Percent
          value: 20
          periodSeconds: 60
spec:
  scaleTargetRef:
    apiVersion: machinelearning.seldon.io/v1
    kind: SeldonDeployment
    name: production-model-seldon
  minReplicas: 1
  maxReplicas: 30
  metrics:
  - type: External
    external:
      metric:
        name: seldon_api_executor_client_requests_seconds
        selector:
          matchLabels:
            deployment_name: production-model-seldon
      target:
        type: AverageValue
        averageValue: "0.1"  # Target 100ms average response time
  - type: External
    external:
      metric:
        name: predicted_load
        selector:
          matchLabels:
            model: production-model
      target:
        type: Value
        value: "1000"  # Predicted requests per minute
---
# KServe with Knative autoscaling
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-autoscaler
  namespace: knative-serving
data:
  # Knative autoscaling configuration
  container-concurrency-target-default: "10"
  container-concurrency-target-percentage: "0.7"
  enable-scale-to-zero: "true"
  scale-to-zero-grace-period: "30s"
  scale-to-zero-pod-retention-period: "0s"
  stable-window: "60s"
  panic-window-percentage: "10.0"
  panic-threshold-percentage: "200.0"
  max-scale-up-rate: "1000.0"
  max-scale-down-rate: "2.0"
  target-burst-capacity: "211"
  requests-per-second-target-default: "200"
---
# KEDA ScaledObject for advanced metrics
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: tensorflow-serving-keda
  namespace: model-serving
spec:
  scaleTargetRef:
    name: tensorflow-serving
  pollingInterval: 15
  cooldownPeriod: 300
  idleReplicaCount: 1
  minReplicaCount: 2
  maxReplicaCount: 100
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      metricName: tensorflow_serving_request_latency_p99
      threshold: '100'
      query: histogram_quantile(0.99, rate(tensorflow_serving_request_duration_seconds_bucket[5m])) * 1000
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      metricName: tensorflow_serving_queue_depth
      threshold: '10'
      query: tensorflow_serving_request_queue_length
  - type: kafka
    metadata:
      bootstrapServers: kafka.kafka.svc.cluster.local:9092
      consumerGroup: tensorflow-serving-consumer
      topic: model-requests
      lagThreshold: '100'
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 8 * * 1-5"  # Scale up at 8 AM on weekdays
      end: "0 20 * * 1-5"   # Scale down at 8 PM on weekdays
      desiredReplicas: "10"
---
# Custom metrics API configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: adapter-config
  namespace: custom-metrics
data:
  config.yaml: |
    rules:
    - seriesQuery: 'tensorflow_serving_request_duration_seconds_count{namespace!="",service!=""}'
      seriesFilters: []
      resources:
        overrides:
          namespace:
            resource: namespace
          service:
            resource: service
      name:
        matches: "^tensorflow_serving_request_duration_seconds_count"
        as: "requests_per_second"
      metricsQuery: 'rate(<<.Series>>{<<.LabelMatchers>>}[2m])'
    
    - seriesQuery: 'tensorflow_serving_request_duration_seconds{namespace!="",service!=""}'
      seriesFilters: []
      resources:
        overrides:
          namespace:
            resource: namespace
          service:
            resource: service
      name:
        matches: "^tensorflow_serving_request_duration_seconds"
        as: "average_response_time_ms"
      metricsQuery: 'rate(tensorflow_serving_request_duration_seconds_sum{<<.LabelMatchers>>}[2m]) / rate(tensorflow_serving_request_duration_seconds_count{<<.LabelMatchers>>}[2m]) * 1000'
```

### Predictive Auto-scaling Implementation

```python
# predictive_autoscaling.py
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.preprocessing import StandardScaler
import joblib
import asyncio
import aiohttp
from datetime import datetime, timedelta
from typing import Dict, List, Tuple, Optional
from kubernetes import client, config
import logging
import json

class PredictiveAutoscaler:
    """Predictive autoscaling for model serving workloads."""
    
    def __init__(self, prometheus_url: str = "http://prometheus:9090"):
        self.prometheus_url = prometheus_url
        self.model = RandomForestRegressor(n_estimators=100, random_state=42)
        self.scaler = StandardScaler()
        self.is_trained = False
        
        try:
            config.load_incluster_config()
        except:
            config.load_kube_config()
        
        self.v1 = client.CoreV1Api()
        self.apps_v1 = client.AppsV1Api()
        self.autoscaling_v2 = client.AutoscalingV2Api()
        self.logger = logging.getLogger(__name__)
        
    async def collect_historical_data(self, 
                                    service_name: str,
                                    namespace: str,
                                    days_back: int = 30) -> pd.DataFrame:
        """Collect historical metrics for training."""
        
        end_time = datetime.now()
        start_time = end_time - timedelta(days=days_back)
        
        queries = {
            'requests_per_second': f'rate(http_requests_total{{service="{service_name}",namespace="{namespace}"}}[5m])',
            'response_time_p95': f'histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{{service="{service_name}",namespace="{namespace}"}}[5m]))',
            'cpu_usage': f'rate(container_cpu_usage_seconds_total{{pod=~"{service_name}.*",namespace="{namespace}"}}[5m])',
            'memory_usage': f'container_memory_usage_bytes{{pod=~"{service_name}.*",namespace="{namespace}"}}',
            'active_connections': f'http_connections_active{{service="{service_name}",namespace="{namespace}"}}',
            'queue_depth': f'http_request_queue_length{{service="{service_name}",namespace="{namespace}"}}',
            'replica_count': f'kube_deployment_status_replicas{{deployment="{service_name}",namespace="{namespace}"}}'
        }
        
        data = []
        current_time = start_time
        
        async with aiohttp.ClientSession() as session:
            while current_time < end_time:
                timestamp = int(current_time.timestamp())
                row = {'timestamp': timestamp}
                
                for metric_name, query in queries.items():
                    try:
                        url = f"{self.prometheus_url}/api/v1/query"
                        params = {
                            'query': query,
                            'time': timestamp
                        }
                        
                        async with session.get(url, params=params) as response:
                            if response.status == 200:
                                result = await response.json()
                                if result['data']['result']:
                                    value = float(result['data']['result'][0]['value'][1])
                                    row[metric_name] = value
                                else:
                                    row[metric_name] = 0
                            else:
                                row[metric_name] = 0
                                
                    except Exception as e:
                        self.logger.warning(f"Failed to collect {metric_name}: {e}")
                        row[metric_name] = 0
                
                # Add time-based features
                dt = current_time
                row['hour'] = dt.hour
                row['day_of_week'] = dt.weekday()
                row['day_of_month'] = dt.day
                row['month'] = dt.month
                row['is_weekend'] = 1 if dt.weekday() >= 5 else 0
                row['is_business_hours'] = 1 if 9 <= dt.hour <= 17 and dt.weekday() < 5 else 0
                
                data.append(row)
                current_time += timedelta(minutes=5)  # 5-minute intervals
        
        df = pd.DataFrame(data)
        
        # Add lag features
        lag_features = ['requests_per_second', 'response_time_p95', 'cpu_usage']
        for feature in lag_features:
            if feature in df.columns:
                for lag in [1, 2, 6, 12]:  # 5min, 10min, 30min, 1hour lags
                    df[f'{feature}_lag_{lag}'] = df[feature].shift(lag)
        
        # Add rolling statistics
        window_sizes = [6, 12, 24]  # 30min, 1hour, 2hour windows
        for feature in lag_features:
            if feature in df.columns:
                for window in window_sizes:
                    df[f'{feature}_rolling_mean_{window}'] = df[feature].rolling(window).mean()
                    df[f'{feature}_rolling_std_{window}'] = df[feature].rolling(window).std()
        
        # Remove rows with NaN values
        df = df.dropna()
        
        self.logger.info(f"Collected {len(df)} historical data points")
        return df
    
    def train_model(self, df: pd.DataFrame, target_column: str = 'replica_count'):
        """Train predictive model."""
        
        # Prepare features
        feature_columns = [col for col in df.columns if col not in ['timestamp', target_column]]
        X = df[feature_columns]
        y = df[target_column]
        
        # Scale features
        X_scaled = self.scaler.fit_transform(X)
        
        # Train model
        self.model.fit(X_scaled, y)
        self.is_trained = True
        
        # Calculate training metrics
        y_pred = self.model.predict(X_scaled)
        mae = mean_absolute_error(y, y_pred)
        mse = mean_squared_error(y, y_pred)
        rmse = np.sqrt(mse)
        
        self.logger.info(f"Model trained - MAE: {mae:.2f}, RMSE: {rmse:.2f}")
        
        # Feature importance
        importance = pd.DataFrame({
            'feature': feature_columns,
            'importance': self.model.feature_importances_
        }).sort_values('importance', ascending=False)
        
        self.logger.info("Top 10 most important features:")
        for _, row in importance.head(10).iterrows():
            self.logger.info(f"  {row['feature']}: {row['importance']:.4f}")
        
        return {
            'mae': mae,
            'rmse': rmse,
            'feature_importance': importance.to_dict('records')
        }
    
    async def predict_future_load(self, 
                                service_name: str,
                                namespace: str,
                                hours_ahead: int = 2) -> List[Tuple[datetime, int]]:
        """Predict future resource requirements."""
        
        if not self.is_trained:
            raise ValueError("Model must be trained before making predictions")
        
        # Get current metrics
        current_data = await self._get_current_metrics(service_name, namespace)
        
        predictions = []
        current_time = datetime.now()
        
        for i in range(hours_ahead * 12):  # 5-minute intervals
            future_time = current_time + timedelta(minutes=5 * (i + 1))
            
            # Prepare features for prediction
            features = current_data.copy()
            features['hour'] = future_time.hour
            features['day_of_week'] = future_time.weekday()
            features['day_of_month'] = future_time.day
            features['month'] = future_time.month
            features['is_weekend'] = 1 if future_time.weekday() >= 5 else 0
            features['is_business_hours'] = 1 if 9 <= future_time.hour <= 17 and future_time.weekday() < 5 else 0
            
            # Convert to array and scale
            feature_array = np.array(list(features.values())).reshape(1, -1)
            feature_array_scaled = self.scaler.transform(feature_array)
            
            # Make prediction
            predicted_replicas = self.model.predict(feature_array_scaled)[0]
            predicted_replicas = max(1, int(round(predicted_replicas)))
            
            predictions.append((future_time, predicted_replicas))
        
        return predictions
    
    async def _get_current_metrics(self, service_name: str, namespace: str) -> Dict:
        """Get current metrics for prediction."""
        
        queries = {
            'requests_per_second': f'rate(http_requests_total{{service="{service_name}",namespace="{namespace}"}}[5m])',
            'response_time_p95': f'histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{{service="{service_name}",namespace="{namespace}"}}[5m]))',
            'cpu_usage': f'rate(container_cpu_usage_seconds_total{{pod=~"{service_name}.*",namespace="{namespace}"}}[5m])',
            'memory_usage': f'container_memory_usage_bytes{{pod=~"{service_name}.*",namespace="{namespace}"}}',
            'active_connections': f'http_connections_active{{service="{service_name}",namespace="{namespace}"}}',
            'queue_depth': f'http_request_queue_length{{service="{service_name}",namespace="{namespace}"}}'
        }
        
        metrics = {}
        
        async with aiohttp.ClientSession() as session:
            for metric_name, query in queries.items():
                try:
                    url = f"{self.prometheus_url}/api/v1/query"
                    params = {'query': query}
                    
                    async with session.get(url, params=params) as response:
                        if response.status == 200:
                            result = await response.json()
                            if result['data']['result']:
                                value = float(result['data']['result'][0]['value'][1])
                                metrics[metric_name] = value
                            else:
                                metrics[metric_name] = 0
                        else:
                            metrics[metric_name] = 0
                            
                except Exception as e:
                    self.logger.warning(f"Failed to get current {metric_name}: {e}")
                    metrics[metric_name] = 0
        
        return metrics
    
    async def apply_scaling_decision(self, 
                                   service_name: str,
                                   namespace: str,
                                   target_replicas: int,
                                   scaling_reason: str):
        """Apply scaling decision to deployment."""
        
        try:
            # Get current deployment
            deployment = self.apps_v1.read_namespaced_deployment(
                name=service_name,
                namespace=namespace
            )
            
            current_replicas = deployment.spec.replicas
            
            if current_replicas != target_replicas:
                # Update deployment
                deployment.spec.replicas = target_replicas
                
                self.apps_v1.patch_namespaced_deployment(
                    name=service_name,
                    namespace=namespace,
                    body=deployment
                )
                
                self.logger.info(f"Scaled {service_name} from {current_replicas} to {target_replicas} replicas. Reason: {scaling_reason}")
                
                # Record scaling event
                await self._record_scaling_event(
                    service_name, namespace, current_replicas, target_replicas, scaling_reason
                )
            
        except Exception as e:
            self.logger.error(f"Failed to apply scaling decision: {e}")
    
    async def _record_scaling_event(self, 
                                  service_name: str,
                                  namespace: str,
                                  old_replicas: int,
                                  new_replicas: int,
                                  reason: str):
        """Record scaling event for audit and analysis."""
        
        event = {
            'timestamp': datetime.now().isoformat(),
            'service': service_name,
            'namespace': namespace,
            'old_replicas': old_replicas,
            'new_replicas': new_replicas,
            'reason': reason,
            'scaling_direction': 'up' if new_replicas > old_replicas else 'down',
            'magnitude': abs(new_replicas - old_replicas)
        }
        
        # Store in ConfigMap for audit trail
        try:
            # Try to get existing audit log
            try:
                cm = self.v1.read_namespaced_config_map(
                    name="autoscaling-audit-log",
                    namespace=namespace
                )
                existing_events = json.loads(cm.data.get('events', '[]'))
            except:
                existing_events = []
            
            existing_events.append(event)
            
            # Keep only last 1000 events
            if len(existing_events) > 1000:
                existing_events = existing_events[-1000:]
            
            # Update ConfigMap
            cm_body = client.V1ConfigMap(
                metadata=client.V1ObjectMeta(name="autoscaling-audit-log"),
                data={'events': json.dumps(existing_events, indent=2)}
            )
            
            try:
                self.v1.replace_namespaced_config_map(
                    name="autoscaling-audit-log",
                    namespace=namespace,
                    body=cm_body
                )
            except:
                self.v1.create_namespaced_config_map(
                    namespace=namespace,
                    body=cm_body
                )
                
        except Exception as e:
            self.logger.warning(f"Failed to record scaling event: {e}")
    
    async def run_predictive_autoscaling(self, 
                                       service_name: str,
                                       namespace: str,
                                       check_interval_minutes: int = 5):
        """Run continuous predictive autoscaling."""
        
        self.logger.info(f"Starting predictive autoscaling for {service_name}")
        
        while True:
            try:
                # Get predictions
                predictions = await self.predict_future_load(service_name, namespace)
                
                # Find maximum predicted load in next hour
                next_hour_predictions = [p[1] for p in predictions[:12]]  # Next 12 intervals (1 hour)
                max_predicted_replicas = max(next_hour_predictions)
                
                # Get current replicas
                deployment = self.apps_v1.read_namespaced_deployment(
                    name=service_name,
                    namespace=namespace
                )
                current_replicas = deployment.spec.replicas
                
                # Determine if scaling is needed
                if max_predicted_replicas > current_replicas * 1.2:  # Scale up if 20% more needed
                    await self.apply_scaling_decision(
                        service_name, namespace, max_predicted_replicas,
                        f"Predictive scale-up: predicted load {max_predicted_replicas} replicas"
                    )
                elif max_predicted_replicas < current_replicas * 0.7:  # Scale down if 30% less needed
                    target_replicas = max(1, max_predicted_replicas)
                    await self.apply_scaling_decision(
                        service_name, namespace, target_replicas,
                        f"Predictive scale-down: predicted load {max_predicted_replicas} replicas"
                    )
                
                await asyncio.sleep(check_interval_minutes * 60)
                
            except Exception as e:
                self.logger.error(f"Error in predictive autoscaling loop: {e}")
                await asyncio.sleep(60)  # Wait 1 minute before retrying
    
    def save_model(self, filepath: str):
        """Save trained model and scaler."""
        
        model_data = {
            'model': self.model,
            'scaler': self.scaler,
            'is_trained': self.is_trained
        }
        
        joblib.dump(model_data, filepath)
        self.logger.info(f"Model saved to {filepath}")
    
    def load_model(self, filepath: str):
        """Load trained model and scaler."""
        
        model_data = joblib.load(filepath)
        self.model = model_data['model']
        self.scaler = model_data['scaler']
        self.is_trained = model_data['is_trained']
        
        self.logger.info(f"Model loaded from {filepath}")

# Example usage
async def main():
    autoscaler = PredictiveAutoscaler()
    
    # Collect training data
    df = await autoscaler.collect_historical_data("tensorflow-serving", "model-serving")
    
    # Train model
    metrics = autoscaler.train_model(df)
    print(f"Training metrics: {metrics}")
    
    # Save model
    autoscaler.save_model("predictive_autoscaling_model.pkl")
    
    # Run predictive autoscaling
    await autoscaler.run_predictive_autoscaling("tensorflow-serving", "model-serving")

if __name__ == "__main__":
    asyncio.run(main())
```

This comprehensive comparison provides practical implementations and benchmarks for TensorFlow Serving, Seldon Core, and KServe. The guide includes advanced features like A/B testing frameworks, predictive autoscaling, and performance benchmarking tools that enable organizations to make informed decisions about their model serving infrastructure based on specific requirements for throughput, latency, operational complexity, and feature requirements.