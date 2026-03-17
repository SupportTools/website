---
title: "Kubernetes Autoscaling Deep Dive: KEDA, HPA, VPA, and Predictive Scaling"
date: 2030-10-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "HPA", "VPA", "Autoscaling", "Predictive Scaling"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes autoscaling: KEDA ScaledObject configuration for queue-based scaling, HPA and KEDA coexistence, VPA integration, KEDA HTTP Add-on, predictive scaling with ML-based metrics, and choosing the right autoscaler for each workload type."
more_link: "yes"
url: "/kubernetes-autoscaling-deep-dive-keda-hpa-vpa-predictive-scaling/"
---

Kubernetes ships with two native autoscalers—the Horizontal Pod Autoscaler and the Vertical Pod Autoscaler—but most production workloads eventually outgrow what CPU and memory metrics alone can express. Event-driven autoscaling with KEDA, predictive scaling through custom metric providers, and the careful integration of all four mechanisms is what separates elastic, cost-efficient clusters from over-provisioned ones.

<!--more-->

This guide covers every layer of the Kubernetes autoscaling stack from first principles to production-hardened configuration patterns. Each section includes working manifests and the operational reasoning behind them.

## The Autoscaling Landscape

Before writing a single manifest it is worth understanding what problem each tool solves.

| Tool | Scaling Axis | Trigger Source | Scales to Zero |
|------|-------------|----------------|----------------|
| HPA  | Pod replicas | CPU, memory, custom metrics | No (min=1) |
| VPA  | Container resources | CPU, memory history | No |
| KEDA | Pod replicas | 40+ event sources | Yes |
| KEDA HTTP Add-on | Pod replicas | HTTP request queue | Yes |

The four tools are complementary rather than competing. A typical production setup runs KEDA for event-driven workloads, HPA for stateless HTTP services with custom Prometheus metrics, and VPA in recommendation-only mode to right-size container requests.

## Section 1: Horizontal Pod Autoscaler Fundamentals and Advanced Configuration

### HPA v2 API and Scale Behavior

The `autoscaling/v2` API introduced fine-grained control over scale-up and scale-down velocity. Always use v2 in any cluster running Kubernetes 1.23 or later.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 3
  maxReplicas: 50
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65
    - type: Resource
      resource:
        name: memory
        target:
          type: AverageValue
          averageValue: 512Mi
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "200"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 4
          periodSeconds: 60
        - type: Percent
          value: 50
          periodSeconds: 60
      selectPolicy: Max
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 2
          periodSeconds: 120
      selectPolicy: Min
```

Key points in the above manifest:

- `stabilizationWindowSeconds` on scale-down prevents flapping by requiring the metric to remain below target for five minutes before removing pods.
- `selectPolicy: Max` for scale-up chooses the more aggressive of the two policies—useful when a traffic spike arrives faster than a per-minute cap can respond.
- `selectPolicy: Min` for scale-down is conservative, removing at most two pods every two minutes.

### Custom Metrics via Prometheus Adapter

The Prometheus Adapter bridges Prometheus metrics into the Kubernetes `custom.metrics.k8s.io` API that HPA queries. Install it via Helm:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm upgrade --install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --set prometheus.url=http://prometheus-operated.monitoring.svc.cluster.local \
  --set prometheus.port=9090
```

Configure rules in the adapter ConfigMap to expose application metrics:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-adapter
  namespace: monitoring
data:
  config.yaml: |
    rules:
      - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
        resources:
          overrides:
            namespace: {resource: "namespace"}
            pod: {resource: "pod"}
        name:
          matches: "^(.*)_total$"
          as: "${1}_per_second"
        metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'
      - seriesQuery: 'queue_depth{namespace!="",deployment!=""}'
        resources:
          overrides:
            namespace: {resource: "namespace"}
            deployment: {resource: "deployment"}
        name:
          as: "queue_depth"
        metricsQuery: 'avg(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'
```

Verify the metric is visible to the API server:

```bash
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" | jq .
```

## Section 2: KEDA — Event-Driven Autoscaling

### KEDA Architecture

KEDA runs as two components in the cluster: the KEDA Operator (which manages ScaledObject and ScaledJob lifecycle) and the Metrics Adapter (which serves external metrics to HPA). When KEDA is installed, it creates a HPA on your behalf; you manage ScaledObjects rather than HPAs directly.

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0 \
  --set metricsServer.replicaCount=2 \
  --set operator.replicaCount=2 \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=100Mi
```

### ScaledObject Configuration for Queue-Based Scaling

The following ScaledObject scales a worker Deployment based on the depth of a RabbitMQ queue. The `minReplicaCount: 0` field enables scale-to-zero, which is the primary cost-saving mechanism for batch workloads.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: rabbitmq-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: message-processor
  pollingInterval: 15
  cooldownPeriod: 60
  minReplicaCount: 0
  maxReplicaCount: 30
  advanced:
    restoreToOriginalReplicaCount: true
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 120
          policies:
            - type: Percent
              value: 25
              periodSeconds: 60
  triggers:
    - type: rabbitmq
      metadata:
        protocol: amqp
        queueName: order-processing
        mode: QueueLength
        value: "5"
        host: "amqp://rabbitmq.production.svc.cluster.local:5672/"
      authenticationRef:
        name: rabbitmq-trigger-auth
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: rabbitmq-trigger-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: username
      name: rabbitmq-credentials
      key: username
    - parameter: password
      name: rabbitmq-credentials
      key: password
```

The `value: "5"` in the trigger means KEDA targets five messages per replica. With 50 messages in the queue, it will scale to 10 replicas.

### Multi-Trigger ScaledObjects

A single ScaledObject can combine triggers with different semantics. KEDA uses the maximum replica count across all triggers.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: multi-trigger-worker
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: event-processor
  minReplicaCount: 1
  maxReplicaCount: 40
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka-brokers.kafka.svc.cluster.local:9092
        consumerGroup: event-processor-group
        topic: user-events
        lagThreshold: "100"
        offsetResetPolicy: latest
      authenticationRef:
        name: kafka-trigger-auth
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: event_processing_latency_p99
        threshold: "500"
        query: histogram_quantile(0.99, sum(rate(event_processing_duration_seconds_bucket[5m])) by (le))
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 8 * * 1-5"
        end: "0 18 * * 1-5"
        desiredReplicas: "5"
```

The cron trigger acts as a floor: during business hours the deployment runs at least 5 replicas regardless of queue depth.

### Kafka Scaler with TLS Authentication

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: sasl
      name: kafka-sasl-secret
      key: sasl
    - parameter: username
      name: kafka-sasl-secret
      key: username
    - parameter: password
      name: kafka-sasl-secret
      key: password
    - parameter: tls
      name: kafka-tls-secret
      key: tls
    - parameter: ca
      name: kafka-tls-secret
      key: ca
    - parameter: cert
      name: kafka-tls-secret
      key: cert
    - parameter: key
      name: kafka-tls-secret
      key: key
```

Create the secrets using base64-encoded certificate data stored in your secrets manager:

```bash
kubectl create secret generic kafka-sasl-secret \
  --from-literal=sasl=plaintext \
  --from-literal=username=keda-consumer \
  --from-literal=password=<kafka-consumer-password> \
  --namespace production
```

### ScaledJob for Batch Workloads

ScaledJob is preferable to ScaledObject when each unit of work should run to completion in a dedicated Job pod, rather than being processed by a long-running worker.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: image-resize-job
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    activeDeadlineSeconds: 600
    backoffLimit: 2
    template:
      spec:
        restartPolicy: Never
        containers:
          - name: image-resizer
            image: registry.example.com/image-resizer:v2.1.0
            resources:
              requests:
                cpu: "500m"
                memory: "512Mi"
              limits:
                cpu: "2"
                memory: "2Gi"
            envFrom:
              - secretRef:
                  name: image-resizer-config
  pollingInterval: 10
  maxReplicaCount: 20
  scalingStrategy:
    strategy: accurate
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "1.0"
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/image-resize-queue
        queueLength: "1"
        awsRegion: us-east-1
        identityOwner: operator
```

`identityOwner: operator` delegates credential resolution to the KEDA operator's IAM role via IRSA, removing the need to store AWS credentials in secrets.

## Section 3: KEDA HTTP Add-on

The KEDA HTTP Add-on scales Deployments based on HTTP request volume by inserting a proxy in front of the target service. It is particularly useful for workloads that receive bursty HTTP traffic and need to scale to zero during idle periods.

### Installation

```bash
helm upgrade --install http-add-on kedacore/keda-add-ons-http \
  --namespace keda \
  --set interceptor.replicas.min=2 \
  --set interceptor.replicas.max=10 \
  --set scaler.replicas=2
```

### HTTPScaledObject

```yaml
apiVersion: http.keda.sh/v1alpha1
kind: HTTPScaledObject
metadata:
  name: api-gateway-http-scaler
  namespace: production
spec:
  hosts:
    - api.example.com
    - api-internal.example.com
  pathPrefixes:
    - /api/v1
    - /api/v2
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
    service: api-gateway-svc
    port: 8080
  replicas:
    min: 0
    max: 25
  scalingMetric:
    requestRate:
      granularity: 1s
      targetValue: 100
      window: 1m
  targetPendingRequests: 200
```

When `min: 0` is set, the HTTP Add-on holds incoming requests in the interceptor queue while scaling the target Deployment from zero. The first request incurs a cold-start delay; subsequent requests are routed normally.

## Section 4: Vertical Pod Autoscaler

### VPA Deployment and Modes

VPA operates in three modes: `Off` (recommendations only), `Initial` (sets resources at pod creation), and `Auto` (updates running pods by eviction). In production, start with `Off` to collect recommendations without disrupting workloads.

```bash
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler
./hack/vpa-install.sh
```

Or via Helm:

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm upgrade --install vpa fairwinds-stable/vpa \
  --namespace kube-system \
  --set recommender.enabled=true \
  --set updater.enabled=true \
  --set admissionController.enabled=true
```

### VPA in Recommendation Mode

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: api-server
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 4
          memory: 4Gi
        controlledResources:
          - cpu
          - memory
        controlledValues: RequestsAndLimits
```

Read recommendations after 24 hours of traffic:

```bash
kubectl describe vpa api-server-vpa -n production
```

The output includes `Target`, `Lower Bound`, and `Upper Bound` recommendations. Apply the `Target` value to the Deployment requests as a baseline.

### VPA in Auto Mode with Pod Disruption Budget

When switching to `Auto` mode, combine VPA with a PodDisruptionBudget to prevent simultaneous eviction of too many pods:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: "50%"
  selector:
    matchLabels:
      app: api-server
---
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa-auto
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Auto"
    evictionRequirements:
      - resources: ["cpu", "memory"]
        changeRequirement: TargetHigherThanRequests
  resourcePolicy:
    containerPolicies:
      - containerName: api-server
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 2
          memory: 2Gi
```

`changeRequirement: TargetHigherThanRequests` tells VPA to only evict a pod when its current resources are under-provisioned, not when the target is lower than current. This makes VPA non-destructive in auto mode.

## Section 5: HPA and KEDA Coexistence

KEDA creates and manages an HPA on behalf of your ScaledObject. Running a separate manually-created HPA targeting the same Deployment creates a conflict where both controllers fight over the replica count.

The correct pattern is to let KEDA own the HPA and configure HPA behavior through `advanced.horizontalPodAutoscalerConfig` in the ScaledObject:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-scaler
  namespace: production
  annotations:
    # Prevents accidental manual HPA creation from conflicting
    scaledobject.keda.sh/transfer-hpa-ownership: "true"
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: worker
  minReplicaCount: 2
  maxReplicaCount: 50
  advanced:
    horizontalPodAutoscalerConfig:
      name: worker-keda-hpa
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 30
          policies:
            - type: Percent
              value: 100
              periodSeconds: 30
        scaleDown:
          stabilizationWindowSeconds: 180
          policies:
            - type: Percent
              value: 20
              periodSeconds: 60
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: worker_queue_depth
        threshold: "10"
        query: sum(worker_queue_depth{namespace="production"})
```

If migrating an existing HPA to KEDA ownership, use the transfer annotation to avoid the HPA being deleted and recreated (which causes a brief scaling disruption).

## Section 6: Predictive Scaling with ML-Based Metrics

Predictive scaling extends reactive autoscaling by provisioning capacity before demand arrives. Two approaches are commonly used in production: time-series forecasting exported as Prometheus metrics, and using Kubernetes KEDA's cron trigger as a simpler heuristic.

### Forecasting with Prophet and Prometheus

Deploy a forecasting service that reads historical Prometheus metrics, runs Facebook Prophet forecasts, and writes predictions back to Prometheus as gauge metrics:

```python
# forecast_server.py (simplified)
from prophet import Prophet
from prometheus_client import Gauge, start_http_server
import pandas as pd
import requests
import time

PREDICTED_REPLICAS = Gauge(
    'predicted_required_replicas',
    'ML-forecasted replica count for next 15 minutes',
    ['deployment', 'namespace']
)

def fetch_historical_metrics(query: str, hours: int = 168) -> pd.DataFrame:
    end = time.time()
    start = end - hours * 3600
    response = requests.get(
        'http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/query_range',
        params={
            'query': query,
            'start': start,
            'end': end,
            'step': '300'
        }
    )
    data = response.json()['data']['result']
    if not data:
        return pd.DataFrame()
    values = data[0]['values']
    df = pd.DataFrame(values, columns=['ds', 'y'])
    df['ds'] = pd.to_datetime(df['ds'], unit='s')
    df['y'] = df['y'].astype(float)
    return df

def forecast_replicas(deployment: str, namespace: str):
    df = fetch_historical_metrics(
        f'sum(rate(http_requests_total{{deployment="{deployment}",namespace="{namespace}"}}[5m]))'
    )
    if df.empty or len(df) < 100:
        return
    model = Prophet(
        changepoint_prior_scale=0.1,
        seasonality_mode='multiplicative',
        weekly_seasonality=True,
        daily_seasonality=True
    )
    model.fit(df)
    future = model.make_future_dataframe(periods=3, freq='5min')
    forecast = model.predict(future)
    # Convert predicted RPS to replica count (target: 200 RPS per replica)
    max_predicted_rps = forecast.tail(3)['yhat_upper'].max()
    predicted_replicas = max(1, int(max_predicted_rps / 200) + 1)
    PREDICTED_REPLICAS.labels(deployment=deployment, namespace=namespace).set(predicted_replicas)

if __name__ == '__main__':
    start_http_server(8000)
    while True:
        for deployment, namespace in [('api-server', 'production'), ('worker', 'production')]:
            forecast_replicas(deployment, namespace)
        time.sleep(300)
```

Then consume the predicted metric in a KEDA ScaledObject:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-predictive-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 50
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: predicted_required_replicas
        threshold: "1"
        query: predicted_required_replicas{deployment="api-server",namespace="production"}
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: current_rps
        threshold: "200"
        query: sum(rate(http_requests_total{deployment="api-server",namespace="production"}[2m]))
```

The second trigger (current RPS) acts as a reactive safety net. The first trigger (predicted replicas) acts as a proactive floor. KEDA takes the maximum of both.

## Section 7: Cluster Autoscaler and Node-Level Considerations

Pod-level autoscaling only works when nodes have available capacity. The Cluster Autoscaler (CA) provisions nodes when pods are Pending due to resource constraints.

### Cluster Autoscaler Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    metadata:
      labels:
        app: cluster-autoscaler
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
    spec:
      serviceAccountName: cluster-autoscaler
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0
          command:
            - ./cluster-autoscaler
            - --v=4
            - --stderrthreshold=info
            - --cloud-provider=aws
            - --skip-nodes-with-local-storage=false
            - --expander=least-waste
            - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/production-cluster
            - --balance-similar-node-groups=true
            - --skip-nodes-with-system-pods=false
            - --scale-down-enabled=true
            - --scale-down-delay-after-add=10m
            - --scale-down-unneeded-time=10m
            - --scale-down-utilization-threshold=0.7
            - --max-graceful-termination-sec=600
```

Annotate critical pods to prevent the CA from evicting them during scale-down:

```bash
kubectl annotate pod <pod-name> \
  cluster-autoscaler.kubernetes.io/safe-to-evict=false \
  -n production
```

### Karpenter as a CA Replacement

Karpenter provides faster, more flexible node provisioning than the Cluster Autoscaler, particularly for heterogeneous instance type selection:

```yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: general-purpose
spec:
  template:
    metadata:
      labels:
        node-type: general-purpose
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: node.kubernetes.io/instance-type
          operator: In
          values:
            - m6i.large
            - m6i.xlarge
            - m6i.2xlarge
            - m6a.large
            - m6a.xlarge
            - m6a.2xlarge
            - m7i.large
            - m7i.xlarge
      taints: []
  limits:
    cpu: 1000
    memory: 4000Gi
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    expireAfter: 720h
```

## Section 8: Choosing the Right Autoscaler

Use the following decision framework when selecting autoscaling mechanisms:

### Workload Classification

**CPU-bound stateless services** (web servers, API gateways):
- Use HPA with CPU utilization targeting 60-70%
- Add memory metric as secondary signal
- Set conservative scale-down stabilization (5+ minutes)

**Queue consumers** (message processors, batch workers):
- Use KEDA with queue-depth trigger
- Set `minReplicaCount: 0` for cost savings during off-hours
- Use ScaledJob if each message requires an isolated execution environment

**Event-driven microservices** (Kafka consumers, SQS processors):
- Use KEDA with appropriate event source scaler
- Combine with cron trigger for predictable daily patterns

**HTTP services with variable traffic** (e-commerce, SaaS APIs):
- Use KEDA HTTP Add-on for scale-to-zero capability
- Or use HPA with custom RPS metric via Prometheus Adapter

**Resource-hungry batch jobs** (ML inference, data processing):
- Use VPA in `Initial` mode for right-sized resource requests
- Use KEDA ScaledJob for on-demand provisioning

### Anti-Patterns to Avoid

Do not set HPA `minReplicas` to 1 for services that require high availability. Use 2 or 3 to survive a pod eviction or node failure.

Do not combine VPA in `Auto` mode with HPA using CPU metrics on the same Deployment. VPA changing CPU requests invalidates the HPA's CPU utilization baseline. If both are needed, configure VPA to only manage memory and HPA to use a non-resource metric.

Do not set KEDA `cooldownPeriod` below 60 seconds for queue-based workloads. Premature scale-down during message burst causes oscillation.

## Section 9: Observability for Autoscaling

### Prometheus Metrics

Key metrics to alert on:

```yaml
# Alerting rules for autoscaling health
groups:
  - name: autoscaling
    rules:
      - alert: HPAMaxReplicasReached
        expr: |
          kube_horizontalpodautoscaler_status_current_replicas
          >= kube_horizontalpodautoscaler_spec_max_replicas
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} at max replicas"
          description: "Workload may need max replica count increase or performance optimization."

      - alert: KEDAScalerError
        expr: keda_scaler_errors_total > 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "KEDA scaler error for {{ $labels.scaler }}"

      - alert: VPARecommendationDrift
        expr: |
          abs(
            kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target
            - kube_pod_container_resource_requests
          ) / kube_pod_container_resource_requests > 0.5
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "VPA recommendation diverged significantly from current requests"
```

### Grafana Dashboard Queries

```promql
# Current vs desired replicas trend
kube_horizontalpodautoscaler_status_current_replicas{namespace="production"}

# KEDA scaling events per ScaledObject
increase(keda_scaled_object_events_total[1h])

# Time at max replicas (saturation indicator)
sum_over_time(
  (kube_horizontalpodautoscaler_status_current_replicas
   == kube_horizontalpodautoscaler_spec_max_replicas)[24h:5m]
) / (24 * 12) * 100
```

## Section 10: Production Checklist

Before enabling autoscaling on a production workload, verify each item:

```bash
# 1. Verify readiness probes are configured (pods must pass before receiving traffic)
kubectl get deployment api-server -n production -o jsonpath='{.spec.template.spec.containers[*].readinessProbe}'

# 2. Verify resource requests are set (required for HPA CPU/memory metrics)
kubectl get deployment api-server -n production -o jsonpath='{.spec.template.spec.containers[*].resources.requests}'

# 3. Verify PodDisruptionBudget exists
kubectl get pdb -n production

# 4. Test scale-up manually
kubectl scale deployment api-server --replicas=10 -n production
kubectl rollout status deployment api-server -n production

# 5. Verify metrics are visible to HPA
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/deployments/api-server/http_requests_per_second"

# 6. Check KEDA ScaledObject status
kubectl describe scaledobject -n production

# 7. Verify HPA is managed by KEDA (not manually created)
kubectl get hpa -n production -o yaml | grep -A2 ownerReferences
```

A well-configured autoscaling stack reduces both operational overhead and infrastructure cost. Start with HPA for established workloads, add KEDA for event-driven components, and graduate to predictive scaling once baseline traffic patterns are understood.
