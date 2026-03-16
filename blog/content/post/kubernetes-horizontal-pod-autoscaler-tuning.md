---
title: "Kubernetes Horizontal Pod Autoscaler Tuning: Advanced Scaling Strategies for Production"
date: 2026-08-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "Autoscaling", "Performance", "Optimization", "Metrics"]
categories: ["Kubernetes", "DevOps", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to tuning Kubernetes Horizontal Pod Autoscaler for production workloads, including custom metrics, advanced algorithms, and optimization strategies."
more_link: "yes"
url: "/kubernetes-horizontal-pod-autoscaler-tuning/"
---

The Horizontal Pod Autoscaler (HPA) automatically scales workloads based on observed metrics. Effective HPA tuning requires understanding scaling algorithms, metric collection, and workload characteristics. This guide covers advanced HPA configurations, custom metrics integration, and production optimization strategies.

<!--more-->

## Executive Summary

Kubernetes HPA provides automatic horizontal scaling for Deployments, ReplicaSets, StatefulSets, and other scalable resources. While basic CPU-based autoscaling is straightforward, production environments require sophisticated configurations using custom metrics, external metrics, and tuned scaling behaviors to handle real-world traffic patterns effectively.

## HPA Architecture and Components

### HPA Controller Deep Dive

**HPA Control Loop:**

```yaml
# Understanding HPA decision-making
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-app-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  minReplicas: 3
  maxReplicas: 100
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # 5 minutes
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
      - type: Pods
        value: 2
        periodSeconds: 60
      selectPolicy: Min  # Most conservative
    scaleUp:
      stabilizationWindowSeconds: 0  # Immediate
      policies:
      - type: Percent
        value: 100  # Double pods
        periodSeconds: 15
      - type: Pods
        value: 4
        periodSeconds: 15
      selectPolicy: Max  # Most aggressive
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
---
# HPA calculation formula explained
# desiredReplicas = ceil[currentReplicas * (currentMetricValue / targetMetricValue)]
#
# Example:
# - Current replicas: 10
# - Current CPU: 140%
# - Target CPU: 70%
# - Calculation: ceil[10 * (140 / 70)] = ceil[20] = 20 replicas
```

### Metrics Server Configuration

**Optimized Metrics Server Deployment:**

```yaml
# metrics-server-config.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: metrics-server
  namespace: kube-system
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: metrics-server
  namespace: kube-system
  labels:
    k8s-app: metrics-server
spec:
  replicas: 3
  selector:
    matchLabels:
      k8s-app: metrics-server
  template:
    metadata:
      labels:
        k8s-app: metrics-server
    spec:
      serviceAccountName: metrics-server
      priorityClassName: system-cluster-critical
      containers:
      - name: metrics-server
        image: registry.k8s.io/metrics-server/metrics-server:v0.7.0
        imagePullPolicy: IfNotPresent
        args:
        - --cert-dir=/tmp
        - --secure-port=10250
        - --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
        - --kubelet-use-node-status-port
        - --metric-resolution=15s  # Default: 60s, faster response
        - --kubelet-insecure-tls=false
        - --requestheader-client-ca-file=/etc/kubernetes/pki/front-proxy-ca.crt
        - --requestheader-username-headers=X-Remote-User
        - --requestheader-group-headers=X-Remote-Group
        - --requestheader-extra-headers-prefix=X-Remote-Extra-
        resources:
          requests:
            cpu: 100m
            memory: 200Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        ports:
        - containerPort: 10250
          name: https
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /livez
            port: https
            scheme: HTTPS
          periodSeconds: 10
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /readyz
            port: https
            scheme: HTTPS
          periodSeconds: 10
          failureThreshold: 3
        securityContext:
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1000
        volumeMounts:
        - name: tmp-dir
          mountPath: /tmp
      volumes:
      - name: tmp-dir
        emptyDir: {}
      nodeSelector:
        kubernetes.io/os: linux
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: k8s-app
                  operator: In
                  values:
                  - metrics-server
              topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: metrics-server
  namespace: kube-system
  labels:
    kubernetes.io/name: "Metrics-server"
    kubernetes.io/cluster-service: "true"
spec:
  selector:
    k8s-app: metrics-server
  ports:
  - port: 443
    protocol: TCP
    targetPort: https
---
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1beta1.metrics.k8s.io
spec:
  service:
    name: metrics-server
    namespace: kube-system
  group: metrics.k8s.io
  version: v1beta1
  insecureSkipTLSVerify: false
  groupPriorityMinimum: 100
  versionPriority: 100
```

## Resource-Based Autoscaling

### CPU and Memory Scaling

**Basic Resource Metrics:**

```yaml
# basic-resource-hpa.yaml
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
  minReplicas: 5
  maxReplicas: 50
  metrics:
  # CPU-based scaling
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  # Memory-based scaling
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 20
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 50
        periodSeconds: 30
      - type: Pods
        value: 5
        periodSeconds: 30
      selectPolicy: Max
---
# Deployment with proper resource requests
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
      - name: api
        image: api-server:v2.0.0
        resources:
          requests:
            cpu: 500m      # Required for CPU-based HPA
            memory: 512Mi  # Required for memory-based HPA
          limits:
            cpu: 1000m
            memory: 1Gi
        ports:
        - containerPort: 8080
```

**Advanced Resource Targeting:**

```yaml
# advanced-resource-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ml-worker-hpa
  namespace: ml-workloads
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ml-worker
  minReplicas: 2
  maxReplicas: 20
  metrics:
  # Target absolute CPU value instead of percentage
  - type: Resource
    resource:
      name: cpu
      target:
        type: AverageValue
        averageValue: "2"  # 2 CPU cores
  # Target absolute memory value
  - type: Resource
    resource:
      name: memory
      target:
        type: AverageValue
        averageValue: "4Gi"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 600  # 10 minutes for ML workloads
      policies:
      - type: Pods
        value: 1
        periodSeconds: 180  # One pod every 3 minutes
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Pods
        value: 2
        periodSeconds: 60
```

## Custom Metrics Autoscaling

### Prometheus Adapter Configuration

**Deploy Prometheus Adapter:**

```yaml
# prometheus-adapter.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: adapter-config
  namespace: monitoring
data:
  config.yaml: |
    rules:
    # HTTP request rate per pod
    - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        matches: "^(.*)_total"
        as: "${1}_per_second"
      metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'

    # HTTP request latency p99
    - seriesQuery: 'http_request_duration_seconds{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        matches: "^(.*)_seconds"
        as: "${1}_p99"
      metricsQuery: 'histogram_quantile(0.99, sum(rate(<<.Series>>_bucket{<<.LabelMatchers>>}[5m])) by (le, <<.GroupBy>>))'

    # Queue depth
    - seriesQuery: 'queue_depth{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        as: "queue_depth"
      metricsQuery: 'avg(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'

    # Connection count
    - seriesQuery: 'active_connections{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        as: "active_connections"
      metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'

    # Custom business metrics
    - seriesQuery: 'orders_processing{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        as: "orders_processing"
      metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'

    # Error rate percentage
    - seriesQuery: 'http_requests_total{namespace!="",pod!="",status=~"5.."}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        as: "error_rate_percent"
      metricsQuery: '(sum(rate(http_requests_total{status=~"5..",<<.LabelMatchers>>}[5m])) by (<<.GroupBy>>) / sum(rate(http_requests_total{<<.LabelMatchers>>}[5m])) by (<<.GroupBy>>)) * 100'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus-adapter
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: prometheus-adapter
  template:
    metadata:
      labels:
        app: prometheus-adapter
    spec:
      serviceAccountName: prometheus-adapter
      containers:
      - name: prometheus-adapter
        image: directxman12/k8s-prometheus-adapter:v0.11.0
        args:
        - --secure-port=6443
        - --tls-cert-file=/var/run/serving-cert/tls.crt
        - --tls-private-key-file=/var/run/serving-cert/tls.key
        - --logtostderr=true
        - --prometheus-url=http://prometheus.monitoring.svc:9090/
        - --metrics-relist-interval=1m
        - --v=4
        - --config=/etc/adapter/config.yaml
        ports:
        - containerPort: 6443
        volumeMounts:
        - name: config
          mountPath: /etc/adapter
        - name: tmp
          mountPath: /tmp
        - name: serving-cert
          mountPath: /var/run/serving-cert
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: config
        configMap:
          name: adapter-config
      - name: tmp
        emptyDir: {}
      - name: serving-cert
        secret:
          secretName: prometheus-adapter-tls
---
apiVersion: v1
kind: Service
metadata:
  name: prometheus-adapter
  namespace: monitoring
spec:
  ports:
  - port: 443
    targetPort: 6443
  selector:
    app: prometheus-adapter
---
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1beta1.custom.metrics.k8s.io
spec:
  service:
    name: prometheus-adapter
    namespace: monitoring
  group: custom.metrics.k8s.io
  version: v1beta1
  insecureSkipTLSVerify: true
  groupPriorityMinimum: 100
  versionPriority: 100
```

### Custom Metrics HPA

**Request Rate Based Scaling:**

```yaml
# request-rate-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-frontend-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-frontend
  minReplicas: 10
  maxReplicas: 200
  metrics:
  # Scale based on requests per second
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"  # 100 req/s per pod
  # Scale based on p99 latency
  - type: Pods
    pods:
      metric:
        name: http_request_duration_p99
      target:
        type: AverageValue
        averageValue: "200m"  # 200ms p99 latency
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 180
      policies:
      - type: Percent
        value: 25
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 10
        periodSeconds: 15
      selectPolicy: Max
```

**Queue-Based Scaling:**

```yaml
# queue-based-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: worker-queue-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: queue-worker
  minReplicas: 5
  maxReplicas: 100
  metrics:
  # Scale based on queue depth per worker
  - type: Pods
    pods:
      metric:
        name: queue_depth
      target:
        type: AverageValue
        averageValue: "10"  # 10 messages per worker
  # Scale based on message processing time
  - type: Pods
    pods:
      metric:
        name: message_processing_duration_seconds
      target:
        type: AverageValue
        averageValue: "5"  # 5 seconds average
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 120  # Conservative scale down
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
      - type: Percent
        value: 200  # Triple capacity quickly
        periodSeconds: 30
      selectPolicy: Max
```

## External Metrics Integration

### Cloud Provider Metrics

**AWS CloudWatch Metrics:**

```yaml
# cloudwatch-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: alb-based-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  minReplicas: 5
  maxReplicas: 50
  metrics:
  # Scale based on ALB request count
  - type: External
    external:
      metric:
        name: aws_alb_request_count_sum
        selector:
          matchLabels:
            load_balancer: "app/production-alb/1234567890"
      target:
        type: AverageValue
        averageValue: "1000"  # 1000 requests per pod
  # Scale based on ALB target response time
  - type: External
    external:
      metric:
        name: aws_alb_target_response_time_average
        selector:
          matchLabels:
            load_balancer: "app/production-alb/1234567890"
      target:
        type: Value
        value: "100m"  # 100ms average
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Pods
        value: 2
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 50
        periodSeconds: 30
---
# External metrics adapter configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: cloudwatch-adapter-config
  namespace: monitoring
data:
  config.yaml: |
    externalMetrics:
    - name: aws_alb_request_count_sum
      resource:
        resource: "deployment"
      queries:
      - id: alb_requests
        metricStat:
          metric:
            namespace: AWS/ApplicationELB
            metricName: RequestCount
            dimensions:
            - name: LoadBalancer
              value: app/production-alb/1234567890
          period: 60
          stat: Sum
        returnData: true
```

**Google Cloud Monitoring:**

```yaml
# gcp-metrics-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: pubsub-based-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pubsub-worker
  minReplicas: 3
  maxReplicas: 50
  metrics:
  # Scale based on Pub/Sub unacked messages
  - type: External
    external:
      metric:
        name: pubsub.googleapis.com|subscription|num_undelivered_messages
        selector:
          matchLabels:
            resource.labels.subscription_id: "production-subscription"
      target:
        type: AverageValue
        averageValue: "30"  # 30 messages per pod
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 180
      policies:
      - type: Pods
        value: 1
        periodSeconds: 90
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
```

## Multi-Metric Scaling Strategies

### Composite Scaling Policies

**Multi-Criteria HPA:**

```yaml
# multi-criteria-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ecommerce-api-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ecommerce-api
  minReplicas: 20
  maxReplicas: 300
  metrics:
  # Resource metrics
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
  # Custom application metrics
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "50"
  - type: Pods
    pods:
      metric:
        name: active_connections
      target:
        type: AverageValue
        averageValue: "100"
  - type: Pods
    pods:
      metric:
        name: orders_processing
      target:
        type: AverageValue
        averageValue: "5"
  # External load balancer metrics
  - type: External
    external:
      metric:
        name: lb_active_connections
        selector:
          matchLabels:
            lb_name: "ecommerce-lb"
      target:
        type: AverageValue
        averageValue: "100"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
      - type: Pods
        value: 5
        periodSeconds: 60
      selectPolicy: Min  # Most conservative
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 20
        periodSeconds: 15
      selectPolicy: Max  # Most aggressive
```

**Time-Based Scaling with HPA:**

```yaml
# scheduled-scaling.yaml
# Use CronHPA for time-based baseline adjustments
apiVersion: autoscaling.alibabacloud.com/v1beta1
kind: CronHorizontalPodAutoscaler
metadata:
  name: business-hours-scaling
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ecommerce-api
  jobs:
  # Scale up for business hours (9 AM)
  - name: scale-up-morning
    schedule: "0 9 * * 1-5"  # Mon-Fri at 9 AM
    targetSize: 50
    timezone: "America/New_York"
  # Scale up for peak hours (12 PM)
  - name: scale-up-lunch
    schedule: "0 12 * * 1-5"  # Mon-Fri at 12 PM
    targetSize: 100
    timezone: "America/New_York"
  # Scale down after peak (2 PM)
  - name: scale-down-afternoon
    schedule: "0 14 * * 1-5"  # Mon-Fri at 2 PM
    targetSize: 50
    timezone: "America/New_York"
  # Scale down for evening (6 PM)
  - name: scale-down-evening
    schedule: "0 18 * * 1-5"  # Mon-Fri at 6 PM
    targetSize: 20
    timezone: "America/New_York"
  # Minimal weekend scaling
  - name: scale-down-weekend
    schedule: "0 0 * * 6,0"  # Sat-Sun at midnight
    targetSize: 10
    timezone: "America/New_York"
---
# Regular HPA still handles real-time scaling
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ecommerce-api-realtime-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ecommerce-api
  minReplicas: 10  # Minimum baseline
  maxReplicas: 300  # Maximum ceiling
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "50"
```

## Advanced Scaling Behaviors

### Aggressive Scale-Up, Conservative Scale-Down

**Production-Ready Behavior Configuration:**

```yaml
# production-scaling-behavior.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: critical-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: critical-service
  minReplicas: 10
  maxReplicas: 100
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
  behavior:
    scaleDown:
      # Wait 5 minutes before scaling down
      stabilizationWindowSeconds: 300
      policies:
      # Remove maximum 10% of pods every minute
      - type: Percent
        value: 10
        periodSeconds: 60
      # OR remove maximum 2 pods every minute
      - type: Pods
        value: 2
        periodSeconds: 60
      # Choose the policy that removes fewer pods
      selectPolicy: Min
    scaleUp:
      # Scale up immediately
      stabilizationWindowSeconds: 0
      policies:
      # Add up to 100% more pods every 15 seconds
      - type: Percent
        value: 100
        periodSeconds: 15
      # OR add 10 pods every 15 seconds
      - type: Pods
        value: 10
        periodSeconds: 15
      # Choose the policy that adds more pods
      selectPolicy: Max
```

### Disabled Scale-Down

**Scale-Up Only HPA:**

```yaml
# scale-up-only-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: event-driven-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: event-processor
  minReplicas: 5
  maxReplicas: 50
  metrics:
  - type: Pods
    pods:
      metric:
        name: events_queued
      target:
        type: AverageValue
        averageValue: "10"
  behavior:
    scaleDown:
      # Effectively disable scale-down
      stabilizationWindowSeconds: 3600  # 1 hour
      policies:
      - type: Pods
        value: 1
        periodSeconds: 600  # 10 minutes per pod
      selectPolicy: Min
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 50
        periodSeconds: 30
```

## Monitoring and Observability

### HPA Metrics Collection

**Prometheus ServiceMonitor:**

```yaml
# hpa-monitoring.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: hpa-controller
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: kube-controller-manager
  namespaceSelector:
    matchNames:
    - kube-system
  endpoints:
  - port: https-metrics
    scheme: https
    tlsConfig:
      insecureSkipVerify: true
    bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
---
# PrometheusRule for HPA alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hpa-alerts
  namespace: monitoring
spec:
  groups:
  - name: hpa
    interval: 30s
    rules:
    - alert: HPAMaxedOut
      expr: |
        kube_horizontalpodautoscaler_status_current_replicas
          >= kube_horizontalpodautoscaler_spec_max_replicas
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} has reached max replicas"
        description: "HPA has been at maximum capacity for 15 minutes"

    - alert: HPAScalingDisabled
      expr: |
        kube_horizontalpodautoscaler_status_condition{condition="ScalingActive",status="false"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} scaling is disabled"
        description: "HPA scaling has been disabled for 10 minutes"

    - alert: HPAMetricsUnavailable
      expr: |
        kube_horizontalpodautoscaler_status_condition{condition="AbleToScale",status="false",reason="FailedGetResourceMetric"} == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} cannot get metrics"
        description: "HPA unable to retrieve metrics for scaling decisions"

    - alert: HPAHighScalingFrequency
      expr: |
        rate(kube_horizontalpodautoscaler_status_desired_replicas[5m]) > 0.5
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} scaling too frequently"
        description: "HPA is changing desired replicas more than 0.5 times per second"
```

### Grafana Dashboard

**HPA Dashboard JSON:**

```json
{
  "dashboard": {
    "title": "Kubernetes HPA Metrics",
    "panels": [
      {
        "title": "Current vs Desired Replicas",
        "targets": [
          {
            "expr": "kube_horizontalpodautoscaler_status_current_replicas{namespace=\"production\"}",
            "legendFormat": "{{ horizontalpodautoscaler }} - Current"
          },
          {
            "expr": "kube_horizontalpodautoscaler_status_desired_replicas{namespace=\"production\"}",
            "legendFormat": "{{ horizontalpodautoscaler }} - Desired"
          },
          {
            "expr": "kube_horizontalpodautoscaler_spec_max_replicas{namespace=\"production\"}",
            "legendFormat": "{{ horizontalpodautoscaler }} - Max"
          },
          {
            "expr": "kube_horizontalpodautoscaler_spec_min_replicas{namespace=\"production\"}",
            "legendFormat": "{{ horizontalpodautoscaler }} - Min"
          }
        ]
      },
      {
        "title": "HPA Scaling Activity",
        "targets": [
          {
            "expr": "rate(kube_horizontalpodautoscaler_status_desired_replicas[5m])",
            "legendFormat": "{{ horizontalpodautoscaler }} - Change Rate"
          }
        ]
      },
      {
        "title": "Resource Utilization vs Target",
        "targets": [
          {
            "expr": "kube_horizontalpodautoscaler_status_current_metrics_value{metric_name=\"cpu\"}",
            "legendFormat": "{{ horizontalpodautoscaler }} - Current CPU"
          },
          {
            "expr": "kube_horizontalpodautoscaler_spec_target_metric{metric_name=\"cpu\"}",
            "legendFormat": "{{ horizontalpodautoscaler }} - Target CPU"
          }
        ]
      }
    ]
  }
}
```

## Troubleshooting and Debugging

### HPA Diagnosis Script

```bash
#!/bin/bash
# hpa-debug.sh

NAMESPACE=${1:-production}
HPA_NAME=${2}

echo "=== HPA Diagnostics ==="

if [ -z "$HPA_NAME" ]; then
  echo "All HPAs in namespace ${NAMESPACE}:"
  kubectl get hpa -n ${NAMESPACE}
  echo ""
  read -p "Enter HPA name to debug: " HPA_NAME
fi

echo "=== HPA Details ==="
kubectl describe hpa ${HPA_NAME} -n ${NAMESPACE}

echo ""
echo "=== HPA YAML ==="
kubectl get hpa ${HPA_NAME} -n ${NAMESPACE} -o yaml

echo ""
echo "=== Current Metrics ==="
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods" | jq '.items[] | select(.metadata.labels."app"=="'${HPA_NAME}'") | {name: .metadata.name, cpu: .containers[0].usage.cpu, memory: .containers[0].usage.memory}'

echo ""
echo "=== Custom Metrics (if available) ==="
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods/*/http_requests_per_second" 2>/dev/null | jq '.'

echo ""
echo "=== Pod Resource Requests ==="
kubectl get deployment $(kubectl get hpa ${HPA_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.scaleTargetRef.name}') -n ${NAMESPACE} -o jsonpath='{.spec.template.spec.containers[0].resources}'

echo ""
echo "=== Recent HPA Events ==="
kubectl get events -n ${NAMESPACE} --field-selector involvedObject.name=${HPA_NAME} --sort-by='.lastTimestamp' | tail -20

echo ""
echo "=== HPA Controller Logs ==="
kubectl logs -n kube-system -l component=kube-controller-manager --tail=50 | grep -i "horizontalpodautoscaler\|hpa" | tail -20

echo ""
echo "=== Metrics Server Health ==="
kubectl get apiservice v1beta1.metrics.k8s.io -o yaml

echo ""
echo "=== Check if pods have resource requests ==="
TARGET_DEPLOYMENT=$(kubectl get hpa ${HPA_NAME} -n ${NAMESPACE} -o jsonpath='{.spec.scaleTargetRef.name}')
kubectl get deployment ${TARGET_DEPLOYMENT} -n ${NAMESPACE} -o json | jq '.spec.template.spec.containers[].resources.requests'
```

## Best Practices and Recommendations

### Production Checklist

**Essential HPA Configuration:**

```yaml
# production-hpa-template.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: production-app
  namespace: production
  labels:
    app: production-app
    team: platform
  annotations:
    description: "Production HPA with best practices"
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: production-app
  # Always set reasonable min/max
  minReplicas: 10  # High enough for availability
  maxReplicas: 100  # Capacity planned ceiling
  # Use multiple metrics
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70  # Below saturation
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"
  # Fine-tuned scaling behavior
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # 5 min observation
      policies:
      - type: Percent
        value: 10  # Max 10% down
        periodSeconds: 60
      selectPolicy: Min
    scaleUp:
      stabilizationWindowSeconds: 0  # Immediate
      policies:
      - type: Percent
        value: 100  # Can double
        periodSeconds: 15
      selectPolicy: Max
```

### Anti-Patterns to Avoid

1. **No Resource Requests**: HPA requires resource requests to calculate utilization
2. **Aggressive Scale-Down**: Can cause thrashing and poor user experience
3. **Single Metric**: Multiple metrics provide better scaling decisions
4. **No Min Replicas**: Always maintain baseline capacity
5. **Unrealistic Targets**: Setting CPU target to 95% leaves no headroom
6. **Ignoring Stabilization**: Default behavior may cause oscillation

## Conclusion

Effective HPA tuning requires understanding workload characteristics, appropriate metric selection, and careful behavior configuration. Key takeaways:

- Use multiple metrics for better scaling decisions
- Implement aggressive scale-up but conservative scale-down
- Monitor HPA performance and adjust based on real traffic patterns
- Set realistic targets with headroom for spikes
- Test scaling behavior under load before production deployment
- Document scaling rationale for team knowledge sharing

Properly configured HPAs enable efficient resource utilization while maintaining application performance and availability under varying load conditions.