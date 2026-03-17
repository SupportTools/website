---
title: "KEDA: Event-Driven Autoscaling for Kubernetes Workloads"
date: 2027-10-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "Autoscaling", "Kafka", "Event-Driven"]
categories:
- Kubernetes
- Autoscaling
author: "Matthew Mattox - mmattox@support.tools"
description: "KEDA ScaledObjects and ScaledJobs, scalers for Kafka, RabbitMQ, Prometheus, Azure Service Bus, and AWS SQS, external triggers, cooldown periods, scaling from zero, and production deployment patterns."
more_link: "yes"
url: /keda-advanced-event-driven-scaling-guide/
---

Kubernetes Horizontal Pod Autoscaler works well for CPU and memory-based scaling, but many production workloads need to scale based on external signals: queue depth, stream lag, database connection pool saturation, or custom business metrics. KEDA (Kubernetes Event-Driven Autoscaling) fills this gap by extending the HPA with support for dozens of external event sources and enabling scale-to-zero for workloads with no active events.

<!--more-->

# KEDA: Event-Driven Autoscaling for Kubernetes Workloads

## The Limitations of Standard HPA

The standard Kubernetes HPA scales based on CPU utilization, memory utilization, and custom metrics exposed through the Custom Metrics API. For many event-driven architectures, these metrics are poor predictors of required capacity:

- A Kafka consumer at 5% CPU might have a lag of 10 million messages
- A queue processor at low memory might have 50,000 messages waiting to be processed
- A cron-triggered batch job needs exactly 1 replica at scheduled times and 0 at all other times

KEDA addresses these gaps by acting as both a metrics adapter (making external metrics available to HPA) and as a controller that can scale deployments directly, including to zero replicas.

## KEDA Architecture

KEDA consists of four main components:

**KEDA Operator** watches ScaledObject and ScaledJob resources and manages the lifecycle of HPA objects. When you create a ScaledObject, KEDA creates a corresponding HPA resource and keeps it synchronized.

**Metrics Adapter** implements the External Metrics API, allowing HPA to query KEDA for external metric values (Kafka lag, queue depth, etc.).

**Admission Webhooks** validate ScaledObject and ScaledJob configurations before they are accepted.

**Scalers** are plugins that know how to query specific external systems. KEDA ships with 50+ built-in scalers covering messaging systems, databases, cloud services, and custom HTTP endpoints.

## Installation

### Helm Installation

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.13.0 \
  --set watchNamespace="" \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.metricServer.podMonitor.enabled=true \
  --set prometheus.operator.enabled=true \
  --set prometheus.operator.podMonitor.enabled=true
```

### Verify Installation

```bash
kubectl get pods -n keda
# Expected output:
# NAME                                               READY   STATUS    RESTARTS   AGE
# keda-admission-webhooks-7d4f9b6c8f-xk2p9          1/1     Running   0          2m
# keda-operator-7b8d5f9c64-p2mnq                    1/1     Running   0          2m
# keda-operator-metrics-apiserver-6b7c8d9f5-vt4lx   1/1     Running   0          2m

# Verify the External Metrics API is registered
kubectl get apiservices | grep external.metrics
# v1beta1.external.metrics.k8s.io   keda/keda-operator-metrics-apiserver   True    2m
```

## ScaledObject: Scaling Deployments

A `ScaledObject` links a deployment to one or more external triggers. KEDA creates and manages an HPA resource based on the ScaledObject specification.

### Kafka Consumer Scaling

The Kafka scaler reads consumer group lag and scales based on the number of messages waiting to be processed:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaledobject
  namespace: production
spec:
  # Target deployment to scale
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor

  # Scaling bounds
  minReplicaCount: 1
  maxReplicaCount: 50

  # Scale down to 1 (not 0) because this is a long-running consumer
  # Set to 0 for true scale-to-zero behavior
  minReplicaCount: 1

  # Cooldown period after scale-down event
  cooldownPeriod: 300

  # Polling interval for checking triggers
  pollingInterval: 15

  # Advanced HPA configuration
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
          - type: Percent
            value: 10
            periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
          - type: Percent
            value: 100
            periodSeconds: 30

  triggers:
  - type: kafka
    metadata:
      # Kafka bootstrap servers
      bootstrapServers: kafka-0.kafka-headless.messaging.svc.cluster.local:9092,kafka-1.kafka-headless.messaging.svc.cluster.local:9092
      # Consumer group to monitor
      consumerGroup: order-processor-group
      # Topic to monitor
      topic: orders
      # Scale by 1 replica per N messages of lag
      lagThreshold: "100"
      # Scale up when lag exceeds this value (scale down when lag <= lagThreshold)
      activationLagThreshold: "10"
      # SASL authentication
      saslType: plaintext
      # TLS
      tls: enable
      # Use topic partition count as maximum scaling factor
      allowIdleConsumers: "false"
    authenticationRef:
      name: kafka-trigger-auth
---
apiVersion: v1
kind: Secret
metadata:
  name: kafka-secret
  namespace: production
type: Opaque
stringData:
  sasl: plaintext
  username: keda-kafka-user
  password: kafka-password-here
  ca: |
    -----BEGIN CERTIFICATE-----
    MIIBkTCB+wIJAJFTIs2aBnCpMA0GCSqGSIb3DQEBCwUAMCExHzAdBgNVBAMTFmt1
    YmVybmV0ZXMtY2EtY2VydGlmaWNhdGUwHhcNMjMwMTAxMDAwMDAwWhcNMjQwMTAx
    MDAwMDAwWjAhMR8wHQYDVQQDExZrdWJlcm5ldGVzLWNhLWNlcnRpZmljYXRlMFww
    DQYJKoZIhvcNAQEBBQADSwAwSAJBALRPRVPwfSjGxlpgCdF0RCQJ0TlxmXzX4A2i
    -----END CERTIFICATE-----
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: sasl
    name: kafka-secret
    key: sasl
  - parameter: username
    name: kafka-secret
    key: username
  - parameter: password
    name: kafka-secret
    key: password
  - parameter: ca
    name: kafka-secret
    key: ca
```

### RabbitMQ Queue-Based Scaling

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: rabbitmq-worker-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: notification-worker

  minReplicaCount: 0
  maxReplicaCount: 30
  cooldownPeriod: 120
  pollingInterval: 10

  triggers:
  - type: rabbitmq
    metadata:
      # RabbitMQ management API URL
      host: amqp://rabbitmq.messaging.svc.cluster.local:5672/production-vhost
      # Queue name to monitor
      queueName: notifications
      # Scale 1 replica per N messages
      queueLength: "50"
      # Minimum messages before scaling from 0 to 1
      activationQueueLength: "5"
      # Use messages-ready metric (not messages-unacknowledged)
      mode: QueueLength
      protocol: amqp
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
  - parameter: host
    name: rabbitmq-secret
    key: connection-string
```

### AWS SQS Queue Scaling

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-processor-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sqs-message-processor

  minReplicaCount: 0
  maxReplicaCount: 100
  cooldownPeriod: 60
  pollingInterval: 30

  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/production-jobs
      queueLength: "10"
      activationQueueLength: "1"
      awsRegion: us-east-1
      # Use IRSA (IAM Roles for Service Accounts) for authentication
      identityOwner: operator
```

For IRSA-based authentication, annotate the KEDA service account with the IAM role ARN:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: keda-operator
  namespace: keda
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/keda-sqs-role
```

The corresponding IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ListQueues",
        "sqs:ReceiveMessage"
      ],
      "Resource": "arn:aws:sqs:us-east-1:123456789012:production-*"
    }
  ]
}
```

### Prometheus Metric-Based Scaling

The Prometheus scaler allows you to scale based on any metric available in your Prometheus instance:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: prometheus-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway

  minReplicaCount: 2
  maxReplicaCount: 50
  cooldownPeriod: 180
  pollingInterval: 30

  triggers:
  - type: prometheus
    metadata:
      # Prometheus server URL
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      # PromQL query - must return a scalar value
      query: |
        sum(rate(http_requests_total{service="api-gateway"}[2m]))
      # Scale 1 replica per N requests per second
      threshold: "100"
      # Start scaling from 0 when requests exceed this value
      activationThreshold: "10"
      # Namespace label for Prometheus queries
      namespace: production
    authenticationRef:
      name: prometheus-trigger-auth
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: prometheus-trigger-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: bearerToken
    name: prometheus-secret
    key: bearer-token
  - parameter: ca
    name: prometheus-secret
    key: ca-cert
```

### Azure Service Bus Scaling

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: azure-servicebus-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: azure-message-processor

  minReplicaCount: 0
  maxReplicaCount: 20
  cooldownPeriod: 300
  pollingInterval: 30

  triggers:
  - type: azure-servicebus
    metadata:
      queueName: production-orders
      messageCount: "25"
      activationMessageCount: "5"
      namespace: mycompany-servicebus
      cloud: AzurePublicCloud
    authenticationRef:
      name: azure-servicebus-auth
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: azure-servicebus-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: connection
    name: azure-servicebus-secret
    key: connection-string
```

## ScaledJob: Scaling Kubernetes Jobs

`ScaledJob` differs from `ScaledObject` in that it creates Kubernetes Jobs rather than scaling a Deployment. Each unit of work becomes an individual Job. This is appropriate for batch workloads where each message should be processed by a completely fresh Job execution.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: image-processing-scaledjob
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
        - name: image-processor
          image: registry.company.com/image-processor:v2.1.0
          env:
          - name: SQS_QUEUE_URL
            value: https://sqs.us-east-1.amazonaws.com/123456789012/image-processing
          - name: AWS_REGION
            value: us-east-1
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi

  # Scaling parameters
  minReplicaCount: 0
  maxReplicaCount: 50
  pollingInterval: 10

  # When to rollout: Gradual, or Immediate
  rollout:
    strategy: gradual
    propagationPolicy: foreground

  # How to handle successful and failed jobs
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 3

  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/image-processing
      queueLength: "1"
      activationQueueLength: "1"
      awsRegion: us-east-1
      identityOwner: operator
```

## Scale-to-Zero Patterns

One of KEDA's most powerful features is the ability to scale deployments to zero replicas when there are no events to process. This is essential for cost optimization in environments with sporadic workloads.

### Configuring Scale-to-Zero

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: scheduled-report-processor
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: report-generator

  # Set minReplicaCount to 0 for scale-to-zero
  minReplicaCount: 0
  maxReplicaCount: 10

  # How long to wait after the last event before scaling to 0
  cooldownPeriod: 120

  # Activation threshold: scale from 0 to 1 when queue depth exceeds this
  # (separate from the main threshold for scale-up beyond 1)
  triggers:
  - type: rabbitmq
    metadata:
      host: amqp://rabbitmq.messaging.svc.cluster.local:5672/
      queueName: report-generation-requests
      queueLength: "5"
      # Scale from 0 to 1 when there is at least 1 message
      activationQueueLength: "1"
      mode: QueueLength
      protocol: amqp
    authenticationRef:
      name: rabbitmq-trigger-auth
```

### Scale-to-Zero Considerations

Scale-to-zero introduces a cold-start latency: when the first event arrives after a period of no activity, KEDA must:
1. Detect the event (up to `pollingInterval` seconds)
2. Create the pod
3. Pull the container image (if not cached)
4. Start the application and complete its initialization

For high-availability requirements, pre-warm strategies include:

1. **Keep minimum 1 replica during business hours**: Use a cron-based scaler to set `minReplicaCount: 1` during peak hours

```yaml
triggers:
- type: rabbitmq
  metadata:
    queueName: payments
    queueLength: "10"
    activationQueueLength: "1"
    # ... other config
- type: cron
  metadata:
    timezone: America/New_York
    # Keep at least 1 replica during business hours
    start: "0 8 * * 1-5"
    end: "0 18 * * 1-5"
    desiredReplicas: "1"
```

2. **Pre-pull images**: Use a DaemonSet to pre-pull container images on all nodes

3. **Use container lifecycle hooks**: Implement fast startup with lazy initialization

## Multiple Triggers

KEDA supports multiple triggers on a single ScaledObject. The scaling decision uses the maximum value across all triggers:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: multi-trigger-processor
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: versatile-worker

  minReplicaCount: 1
  maxReplicaCount: 100

  triggers:
  # Scale based on Kafka lag
  - type: kafka
    metadata:
      bootstrapServers: kafka.messaging.svc.cluster.local:9092
      consumerGroup: versatile-worker-group
      topic: primary-events
      lagThreshold: "100"

  # Also scale based on RabbitMQ queue
  - type: rabbitmq
    metadata:
      host: amqp://rabbitmq.messaging.svc.cluster.local:5672/
      queueName: secondary-queue
      queueLength: "50"
      mode: QueueLength
      protocol: amqp
    authenticationRef:
      name: rabbitmq-trigger-auth

  # And CPU to handle bursty processing
  - type: cpu
    metricType: Utilization
    metadata:
      value: "70"
```

KEDA takes the maximum replica count suggested by any trigger. If Kafka says 5 replicas and RabbitMQ says 20 replicas and CPU says 3 replicas, KEDA will scale to 20.

## TriggerAuthentication and ClusterTriggerAuthentication

For secrets shared across namespaces, use `ClusterTriggerAuthentication` instead of namespace-scoped `TriggerAuthentication`:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: kafka-cluster-auth
spec:
  secretTargetRef:
  - parameter: sasl
    name: kafka-global-secret
    key: sasl
  - parameter: username
    name: kafka-global-secret
    key: username
  - parameter: password
    name: kafka-global-secret
    key: password
```

Reference from any namespace:

```yaml
triggers:
- type: kafka
  metadata:
    bootstrapServers: kafka.messaging.svc.cluster.local:9092
    consumerGroup: my-group
    topic: my-topic
    lagThreshold: "100"
  authenticationRef:
    name: kafka-cluster-auth
    kind: ClusterTriggerAuthentication
```

## KEDA with IRSA and Workload Identity

For cloud-native deployments, KEDA supports AWS IRSA, GCP Workload Identity, and Azure Workload Identity without requiring secrets:

```yaml
# GCP Workload Identity example
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: gcp-pubsub-auth
  namespace: production
spec:
  podIdentity:
    provider: gcp
    identityId: keda-scaler@my-project.iam.gserviceaccount.com
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: pubsub-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pubsub-consumer

  minReplicaCount: 0
  maxReplicaCount: 20

  triggers:
  - type: gcp-pubsub
    metadata:
      subscriptionName: projects/my-project/subscriptions/my-subscription
      mode: SubscriptionSize
      value: "20"
      activationValue: "5"
    authenticationRef:
      name: gcp-pubsub-auth
```

## Monitoring KEDA

### Prometheus Metrics

KEDA exposes comprehensive metrics for monitoring scaling behavior:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: keda-operator
  namespace: keda
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: keda-operator
  podMetricsEndpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

Key KEDA metrics:

| Metric | Description |
|--------|-------------|
| `keda_scaler_metrics_value` | Current value returned by each scaler |
| `keda_scaler_active` | Whether the scaler has active scaling |
| `keda_scaled_object_paused` | Whether a ScaledObject is paused |
| `keda_scaler_errors_total` | Error count per scaler |
| `keda_resource_totals` | Number of ScaledObjects and ScaledJobs |

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: keda-alerts
  namespace: monitoring
spec:
  groups:
  - name: keda
    rules:
    - alert: KEDAScalerError
      expr: rate(keda_scaler_errors_total[5m]) > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "KEDA scaler {{ $labels.scaler }} experiencing errors"
        description: "KEDA scaler {{ $labels.scaler }} in namespace {{ $labels.namespace }} has {{ $value }} errors per second."

    - alert: KEDAScaledObjectAtMaxReplicas
      expr: |
        keda_scaler_metrics_value / on(scaledObject, namespace)
        kube_horizontalpodautoscaler_spec_max_replicas > 0.9
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "ScaledObject {{ $labels.scaledObject }} near max replicas"
        description: "ScaledObject {{ $labels.scaledObject }} has been at 90%+ of max replicas for 10 minutes. Consider raising maxReplicaCount."

    - alert: KEDAOperatorNotRunning
      expr: absent(up{app="keda-operator"}) or up{app="keda-operator"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "KEDA operator is not running"
        description: "KEDA operator is down. Event-driven autoscaling is not functioning."
```

## Production Tuning

### Scaling Behavior Configuration

Use the `advanced.horizontalPodAutoscalerConfig` section to control scaling responsiveness:

```yaml
advanced:
  horizontalPodAutoscalerConfig:
    name: custom-hpa-name
    behavior:
      scaleDown:
        # Wait 5 minutes of sustained low load before scaling down
        stabilizationWindowSeconds: 300
        policies:
        # Scale down by at most 10% of current replicas per minute
        - type: Percent
          value: 10
          periodSeconds: 60
        # Or by at most 2 pods per minute
        - type: Pods
          value: 2
          periodSeconds: 60
        # Use the less disruptive policy (Min)
        selectPolicy: Min
      scaleUp:
        # React immediately to traffic spikes
        stabilizationWindowSeconds: 0
        policies:
        # Scale up by 100% of current replicas every 30 seconds
        - type: Percent
          value: 100
          periodSeconds: 30
        # Or by at most 10 pods every 30 seconds
        - type: Pods
          value: 10
          periodSeconds: 30
        # Use the more aggressive policy (Max)
        selectPolicy: Max
```

### Pausing ScaledObjects

During maintenance or deployment, pause scaling to prevent unintended scale events:

```bash
# Pause a ScaledObject
kubectl patch scaledobject kafka-consumer-scaledobject \
  -n production \
  --type=merge \
  -p '{"metadata":{"annotations":{"autoscaling.keda.sh/paused-replicas":"3"}}}'

# Resume (remove the annotation)
kubectl annotate scaledobject kafka-consumer-scaledobject \
  -n production \
  autoscaling.keda.sh/paused-replicas-
```

### Fallback Behavior

Configure what KEDA should do if it cannot reach the external metrics source:

```yaml
spec:
  fallback:
    # If the scaler fails this many consecutive times
    failureThreshold: 3
    # Use this replica count as a fallback
    replicas: 5
```

This ensures that even if Kafka or RabbitMQ is temporarily unreachable, your consumers continue running at a safe replica count.

## Troubleshooting

### Checking ScaledObject Status

```bash
# Get ScaledObject status
kubectl describe scaledobject kafka-consumer-scaledobject -n production

# Check the generated HPA
kubectl get hpa -n production

# Check KEDA operator logs for scaling decisions
kubectl logs -n keda deployment/keda-operator --tail=100 | grep kafka-consumer

# Check metrics adapter logs for trigger query results
kubectl logs -n keda deployment/keda-operator-metrics-apiserver --tail=100
```

### Common Issues

**ScaledObject stuck at 0 replicas despite events in queue**: Check `activationQueueLength` or `activationLagThreshold` values. If these are higher than the current queue depth, KEDA will not activate.

**Rapid scale-up and scale-down oscillation**: Increase `cooldownPeriod` and add `stabilizationWindowSeconds` to the scale-down behavior.

**Metrics adapter returning "no value" errors**: Verify the trigger authentication credentials are correct and the external system is reachable from the KEDA operator pod.

```bash
# Test connectivity from KEDA operator
kubectl exec -n keda deployment/keda-operator -- nc -zv kafka.messaging.svc.cluster.local 9092

# Check for authentication errors in trigger auth
kubectl get triggerauthentication -n production kafka-trigger-auth -o yaml
kubectl get secret kafka-secret -n production -o jsonpath='{.data.username}' | base64 -d
```

## Conclusion

KEDA transforms Kubernetes autoscaling from a CPU/memory-centric model to a true event-driven scaling system. By scaling based on queue depth, stream lag, and custom metrics, KEDA enables workloads to match capacity precisely to incoming work, eliminating both over-provisioning and under-provisioning.

The scale-to-zero capability is transformative for batch workloads and scheduled jobs, eliminating idle resource consumption while maintaining the ability to scale rapidly when work arrives. Combined with proper cooldown configuration and fallback policies, KEDA provides robust, production-safe event-driven scaling for the most demanding Kubernetes workloads.
