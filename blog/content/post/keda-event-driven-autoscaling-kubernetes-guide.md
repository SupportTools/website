---
title: "KEDA: Event-Driven Autoscaling for Kubernetes Workloads"
date: 2027-04-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "Autoscaling", "Event-Driven", "HPA"]
categories: ["Kubernetes", "Autoscaling", "Event-Driven"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to KEDA event-driven autoscaling on Kubernetes covering ScaledObject and ScaledJob CRDs, scaler integrations (Kafka, Prometheus, RabbitMQ, Redis, AWS SQS, Cron), scale-to-zero patterns, HPA coexistence, pausing autoscaling for deployments, and Prometheus metrics."
more_link: "yes"
url: "/keda-event-driven-autoscaling-kubernetes-guide/"
---

Kubernetes Horizontal Pod Autoscaler scales workloads based on CPU and memory utilization — metrics that are lagging indicators of actual load. A queue-based worker pool sitting idle does not consume CPU until messages arrive, at which point CPU spikes and HPA reacts seconds to minutes later, during which the queue backlog grows. KEDA (Kubernetes Event-Driven Autoscaling) inverts this model: it scales workloads based on the actual source of truth for load — queue depth, consumer lag, Prometheus metric values, and dozens of other event sources — rather than derived resource metrics.

This guide covers KEDA's architecture, the ScaledObject and ScaledJob CRDs, all major scaler integrations, TriggerAuthentication for secret management, scale-to-zero patterns, HPA coexistence, and Prometheus monitoring for KEDA itself.

<!--more-->

## KEDA Architecture

KEDA consists of three components that extend the Kubernetes autoscaling machinery.

**keda-operator**: A controller that watches `ScaledObject` and `ScaledJob` resources. For each `ScaledObject`, the operator creates and manages a corresponding `HorizontalPodAutoscaler` targeting the same deployment. The operator polls the configured external metrics sources at the `pollingInterval` and updates the HPA's external metric targets accordingly.

**keda-metrics-apiserver**: An implementation of the Kubernetes External Metrics API. The HPA controller calls this API server to retrieve the current metric values published by KEDA's scalers. This component acts as the bridge between KEDA's scaler integrations and the standard HPA control loop.

**keda-admission-webhooks**: Validating and mutating admission webhooks that validate `ScaledObject` and `ScaledJob` resources on creation and update, preventing misconfigured resources from entering the cluster.

### How KEDA Scales to Zero

Standard HPA has a minimum replica floor of 1 — it cannot scale a deployment to zero. KEDA bypasses this by taking ownership of the deployment's replica count when scaling to zero: when all scaler triggers report zero events, KEDA sets the deployment's `spec.replicas` to 0 directly, bypassing the HPA minimum. When events return, KEDA restores replicas to 1, the HPA resumes control, and normal scaling proceeds.

## Installing KEDA

```bash
# Add the KEDA Helm repository
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

# Install KEDA into its own namespace
helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0 \
  --set watchNamespace="" \
  --set operator.replicaCount=2 \
  --set metricsServer.replicaCount=2 \
  --wait
```

### Production Helm Values

```yaml
# keda-values.yaml
# Production KEDA deployment configuration
operator:
  replicaCount: 2
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: keda-operator
          topologyKey: kubernetes.io/hostname

  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 1000m
      memory: 512Mi

  # Log level: debug, info, error
  logLevel: info
  logEncoder: json

metricsServer:
  replicaCount: 2
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: keda-metrics-apiserver
            topologyKey: kubernetes.io/hostname

  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 1000m
      memory: 512Mi

webhooks:
  enabled: true
  replicaCount: 2
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 128Mi

# Prometheus metrics for KEDA itself
prometheus:
  operator:
    enabled: true
    serviceMonitor:
      enabled: true
      namespace: monitoring
      additionalLabels:
        release: prometheus
    podMonitor:
      enabled: false
  metricServer:
    enabled: true
    serviceMonitor:
      enabled: true
      namespace: monitoring
      additionalLabels:
        release: prometheus
```

## ScaledObject CRD: Core Fields

The `ScaledObject` resource is the primary declaration of event-driven scaling behavior for a Deployment, StatefulSet, or custom workload.

```yaml
# scaledobject-reference.yaml
# ScaledObject with all commonly used fields annotated
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: orders-worker-scaledobject
  namespace: orders
spec:
  # Target workload — must be in the same namespace
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: orders-worker

  # Minimum replica count when there is load (cannot be less than 1 unless
  # scale-to-zero is desired — use minReplicaCount: 0 for that)
  minReplicaCount: 2

  # Maximum replica count
  maxReplicaCount: 50

  # How often KEDA polls the external metric source (seconds)
  pollingInterval: 15

  # How long to wait after all triggers report 0 before scaling to minReplicaCount
  # If minReplicaCount is 0, this is the wait before scaling to zero
  cooldownPeriod: 300

  # Scale-to-zero idle period: how long at zero events before scaling to 0
  # Only applies when minReplicaCount is 0
  idleReplicaCount: 0

  # Number of replicas to scale to when activating from zero
  # Default is 1
  initialCooldownPeriod: 0

  # Fallback behavior when a scaler fails to retrieve metrics
  fallback:
    failureThreshold: 3         # Fail 3 consecutive times before activating fallback
    replicas: 5                 # Scale to 5 replicas as a safe fallback

  # Autoscaling behavior (inherits from HPA v2)
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0   # Scale up immediately
          policies:
            - type: Percent
              value: 100
              periodSeconds: 15
        scaleDown:
          stabilizationWindowSeconds: 300  # Wait 5 minutes before scaling down
          policies:
            - type: Percent
              value: 25                    # Scale down at most 25% per period
              periodSeconds: 60

  # Scaling triggers — multiple triggers use the maximum value across all triggers
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka-brokers.messaging.svc.cluster.local:9092
        consumerGroup: orders-worker-group
        topic: orders.created
        lagThreshold: "100"        # Scale when lag exceeds 100 messages
        offsetResetPolicy: latest
      authenticationRef:
        name: kafka-trigger-auth   # Reference to TriggerAuthentication
```

## Scaler Integrations

### Kafka Consumer Lag Scaler

The Kafka scaler monitors consumer group lag and scales workers proportionally to keep up with the message backlog.

```yaml
# kafka-scaledobject.yaml
# Scale workers based on Kafka consumer group lag
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: orders-kafka-worker
  namespace: orders
spec:
  scaleTargetRef:
    name: orders-kafka-consumer
  minReplicaCount: 1
  maxReplicaCount: 30
  pollingInterval: 10
  cooldownPeriod: 120
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka-brokers.messaging.svc.cluster.local:9092
        consumerGroup: orders-processor-v2
        topic: orders.created
        # Target lag per replica — each replica handles 200 unprocessed messages
        lagThreshold: "200"
        # Activate scaling when lag first exceeds this value (prevents micro-scaling)
        activationLagThreshold: "50"
        # Use sarama for SASL/TLS connections
        saslType: scram_sha512
        tls: enable
      authenticationRef:
        name: kafka-sasl-auth
---
# TriggerAuthentication for Kafka SASL credentials
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-sasl-auth
  namespace: orders
spec:
  secretTargetRef:
    - parameter: username
      name: kafka-sasl-credentials
      key: username
    - parameter: password
      name: kafka-sasl-credentials
      key: password
    - parameter: tls
      name: kafka-tls-secret
      key: tls.crt
    - parameter: ca
      name: kafka-tls-secret
      key: ca.crt
    - parameter: key
      name: kafka-tls-secret
      key: tls.key
```

### Prometheus Custom Metrics Scaler

The Prometheus scaler queries a PromQL expression and scales based on the returned value. This is the most flexible scaler for workloads with custom business metrics.

```yaml
# prometheus-scaledobject.yaml
# Scale API servers based on active request queue depth (custom Prometheus metric)
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-prometheus-scaler
  namespace: api
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 3
  maxReplicaCount: 100
  pollingInterval: 30
  cooldownPeriod: 180
  triggers:
    - type: prometheus
      metadata:
        # Prometheus server URL
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        # PromQL query returning a scalar value
        # This query returns the 95th percentile queue depth across all API server pods
        query: |
          avg(
            rate(http_requests_queued_total{namespace="api", job="api-server"}[2m])
          )
        # Scale when the metric exceeds this threshold per replica
        threshold: "100"
        # Activate scaling when the metric first exceeds this value
        activationThreshold: "10"
        # Optional: namespace selector for the Prometheus scrape target
        namespace: api
```

### RabbitMQ Queue Depth Scaler

```yaml
# rabbitmq-scaledobject.yaml
# Scale workers based on RabbitMQ queue depth
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: notification-worker-rabbitmq
  namespace: notifications
spec:
  scaleTargetRef:
    name: notification-worker
  minReplicaCount: 0    # Scale to zero when queue is empty
  maxReplicaCount: 20
  pollingInterval: 15
  cooldownPeriod: 300
  triggers:
    - type: rabbitmq
      metadata:
        # RabbitMQ management API URL
        host: amqps://rabbitmq-main.messaging.svc.cluster.local:5671/
        vhostName: /notifications
        queueName: notifications.email
        # Scale when queue depth exceeds 50 messages per replica
        queueLength: "50"
        # Activate when queue first gets any messages
        activationQueueLength: "1"
        # Use HTTP management API (alternative to amqp protocol)
        protocol: http
        mode: QueueLength
      authenticationRef:
        name: rabbitmq-trigger-auth
---
# TriggerAuthentication for RabbitMQ credentials
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: rabbitmq-trigger-auth
  namespace: notifications
spec:
  secretTargetRef:
    - parameter: host
      name: rabbitmq-keda-credentials
      key: connection_string
```

### Redis List Length Scaler

```yaml
# redis-scaledobject.yaml
# Scale workers based on Redis list length (task queue)
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: image-processor-redis
  namespace: media
spec:
  scaleTargetRef:
    name: image-processor
  minReplicaCount: 0    # Scale to zero when queue is empty
  maxReplicaCount: 15
  pollingInterval: 10
  cooldownPeriod: 120
  triggers:
    - type: redis
      metadata:
        address: redis-master.cache.svc.cluster.local:6379
        listName: image_processing_queue
        # Scale when the list has more than 10 items per replica
        listLength: "10"
        # Only activate when there are at least 5 items
        activationListLength: "5"
        # Redis database index
        databaseIndex: "0"
      authenticationRef:
        name: redis-trigger-auth
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-trigger-auth
  namespace: media
spec:
  secretTargetRef:
    - parameter: password
      name: redis-auth-secret
      key: redis-password
```

### AWS SQS Queue Length Scaler

```yaml
# sqs-scaledobject.yaml
# Scale workers based on AWS SQS queue depth
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: report-generator-sqs
  namespace: reports
spec:
  scaleTargetRef:
    name: report-generator
  minReplicaCount: 0
  maxReplicaCount: 25
  pollingInterval: 20
  cooldownPeriod: 240
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/report-generation-queue
        queueLength: "5"         # Target 5 messages per replica
        activationQueueLength: "1"
        awsRegion: us-east-1
        # Use IAM roles for service accounts (IRSA) — no static credentials
        identityOwner: operator
      authenticationRef:
        name: aws-sqs-trigger-auth
---
# TriggerAuthentication using AWS pod identity (IRSA or EKS Pod Identity)
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-sqs-trigger-auth
  namespace: reports
spec:
  podIdentity:
    # Use the KEDA operator's AWS pod identity
    provider: aws
```

For IRSA-based authentication, annotate the KEDA operator's service account with the IAM role ARN:

```bash
# Annotate KEDA operator service account for IRSA
kubectl annotate serviceaccount -n keda keda-operator \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/keda-sqs-reader
```

### Cron-Based Scaling

The Cron scaler provides scheduled scaling — scaling up before anticipated load and down during off-peak hours. It complements reactive scalers by providing a floor for business-hours workloads.

```yaml
# cron-scaledobject.yaml
# Scale API servers based on business hours and known peak windows
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-cron
  namespace: api
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 2    # Minimum during off-hours
  maxReplicaCount: 50   # Ceiling for reactive scaling
  pollingInterval: 30
  triggers:
    # Business hours baseline: 09:00 - 18:00 Monday-Friday (US Eastern, UTC-5)
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 9 * * 1-5"    # 9:00 AM Monday-Friday
        end: "0 18 * * 1-5"     # 6:00 PM Monday-Friday
        desiredReplicas: "10"   # Maintain 10 replicas during business hours

    # Pre-market peak: 08:30 - 09:15 Monday-Friday (high trading activity)
    - type: cron
      metadata:
        timezone: America/New_York
        start: "30 8 * * 1-5"
        end: "15 9 * * 1-5"
        desiredReplicas: "20"

    # End-of-day batch peak: 17:30 - 18:30 Monday-Friday
    - type: cron
      metadata:
        timezone: America/New_York
        start: "30 17 * * 1-5"
        end: "30 18 * * 1-5"
        desiredReplicas: "15"
```

## ScaledJob CRD for Batch Workloads

`ScaledJob` manages Kubernetes Jobs rather than Deployments. Each trigger event creates a new Job rather than scaling a long-running Deployment. This pattern is appropriate for stateful batch processing where each unit of work should run in isolation.

```yaml
# scaledjob.yaml
# ScaledJob: create a Job for each batch of SQS messages
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: report-batch-processor
  namespace: reports
spec:
  jobTargetRef:
    # Template for the Job that will be created
    template:
      spec:
        restartPolicy: Never
        activeDeadlineSeconds: 3600   # Kill jobs running longer than 1 hour
        containers:
          - name: report-processor
            image: registry.support.tools/report-processor:v3.2.1
            resources:
              requests:
                cpu: 500m
                memory: 512Mi
              limits:
                cpu: 2000m
                memory: 2Gi
            env:
              - name: BATCH_SIZE
                value: "10"
              - name: AWS_REGION
                value: us-east-1
            envFrom:
              - secretRef:
                  name: report-processor-secrets
        backoffLimit: 2

  # Maximum number of Jobs running concurrently
  maxReplicaCount: 10

  # Minimum number of Jobs to always keep running (0 = scale to zero)
  minReplicaCount: 0

  # Polling interval for the trigger source
  pollingInterval: 30

  # How to handle successful Jobs (use RemoveAfterDeadline to clean up)
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5

  # Scaling strategy for Jobs
  scalingStrategy:
    strategy: default   # default, custom, or accurate
    # For accurate mode, create exactly one job per trigger unit
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "1.0"

  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/report-batch-queue
        queueLength: "10"    # Create one Job per 10 SQS messages
        awsRegion: us-east-1
        identityOwner: operator
      authenticationRef:
        name: aws-sqs-trigger-auth
```

## TriggerAuthentication and ClusterTriggerAuthentication

`TriggerAuthentication` is namespace-scoped and referenced by `ScaledObject` resources in the same namespace. `ClusterTriggerAuthentication` is cluster-scoped and can be referenced from any namespace.

```yaml
# cluster-trigger-auth.yaml
# ClusterTriggerAuthentication for shared Kafka credentials
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: kafka-cluster-auth
spec:
  secretTargetRef:
    # Reference a secret in the keda namespace (operator's namespace)
    - parameter: username
      name: kafka-shared-credentials
      key: username
    - parameter: password
      name: kafka-shared-credentials
      key: password
---
# Using the ClusterTriggerAuthentication in a ScaledObject
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: payments-kafka-consumer
  namespace: payments
spec:
  scaleTargetRef:
    name: payments-consumer
  minReplicaCount: 2
  maxReplicaCount: 20
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka-brokers.messaging.svc.cluster.local:9092
        consumerGroup: payments-processor
        topic: payments.events
        lagThreshold: "100"
      authenticationRef:
        name: kafka-cluster-auth
        # Indicate that this is a ClusterTriggerAuthentication
        kind: ClusterTriggerAuthentication
```

### Using External Secrets Operator with TriggerAuthentication

For Vault or AWS Secrets Manager integration, use the External Secrets Operator to sync secrets into Kubernetes, then reference them in TriggerAuthentication.

```yaml
# external-secret-for-keda.yaml
# ExternalSecret pulling Kafka credentials from AWS Secrets Manager
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: kafka-keda-credentials
  namespace: orders
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: kafka-sasl-credentials
    creationPolicy: Owner
  data:
    - secretKey: username
      remoteRef:
        key: prod/kafka/keda-credentials
        property: username
    - secretKey: password
      remoteRef:
        key: prod/kafka/keda-credentials
        property: password
```

## Pausing Autoscaling

KEDA supports pausing autoscaling on a `ScaledObject` without deleting it. This is useful during deployments, maintenance windows, or debugging sessions where manual replica control is required.

```bash
# Pause autoscaling by adding the paused annotation
kubectl annotate scaledobject orders-kafka-worker \
  -n orders \
  autoscaling.keda.sh/paused=true

# Verify the ScaledObject is paused
kubectl get scaledobject orders-kafka-worker -n orders -o jsonpath='{.status.conditions}' | jq .

# While paused, manually set replicas
kubectl scale deployment orders-kafka-consumer -n orders --replicas=5

# Resume autoscaling
kubectl annotate scaledobject orders-kafka-worker \
  -n orders \
  autoscaling.keda.sh/paused-

# Alternative: pause at a specific replica count
kubectl annotate scaledobject orders-kafka-worker \
  -n orders \
  autoscaling.keda.sh/paused-replicas="3"
```

## KEDA with Argo Workflows for ML Pipelines

Combining KEDA ScaledJobs with Argo Workflows enables event-driven ML training pipelines that scale worker nodes from zero based on workflow queue depth.

```yaml
# keda-argo-workflow-trigger.yaml
# ScaledJob that creates Argo Workflow executor pods based on queue depth
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ml-training-workflow-trigger
  namespace: mlops
spec:
  scaleTargetRef:
    apiVersion: argoproj.io/v1alpha1
    kind: Workflow
    name: model-training-workflow
  minReplicaCount: 0
  maxReplicaCount: 5
  pollingInterval: 30
  cooldownPeriod: 600
  triggers:
    # Scale based on the number of pending Argo workflow nodes
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        query: |
          argo_workflows_gauge{namespace="mlops", status="Pending"}
        threshold: "1"
        activationThreshold: "1"
```

## Prometheus Monitoring for KEDA

KEDA exposes its own Prometheus metrics covering scaler health, scaling decisions, and error rates.

```yaml
# keda-alerts.yaml
# PrometheusRule for KEDA operational alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: keda-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: keda.operator
      interval: 1m
      rules:
        - alert: KEDAScalerError
          expr: keda_scaler_errors_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA scaler is reporting errors"
            description: "ScaledObject {{ $labels.scaledObject }} scaler {{ $labels.scaler }} has {{ $value }} errors in the last 5 minutes."

        - alert: KEDAScaledObjectNotReady
          expr: keda_scaledobject_errors > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA ScaledObject is not ready"
            description: "ScaledObject {{ $labels.namespace }}/{{ $labels.scaledObject }} has errors and may not be scaling correctly."

        - alert: KEDAMetricsAPIServerDown
          expr: up{job="keda-metrics-apiserver"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "KEDA Metrics API Server is down"
            description: "The KEDA metrics API server has been unreachable for 2 minutes. HPA scaling for event-driven workloads is suspended."

        - alert: KEDAHPAScaledObjectMismatch
          expr: keda_scaledobject_errors{reason="target_not_found"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA ScaledObject target deployment not found"
            description: "ScaledObject {{ $labels.namespace }}/{{ $labels.scaledObject }} references a deployment that does not exist."
```

### Key KEDA Prometheus Metrics

```promql
# Number of times a scaler has scaled a workload up
increase(keda_scaler_active[1h])

# Error rate per scaler type
rate(keda_scaler_errors_total[5m])

# Current value reported by each scaler (the metric being evaluated)
keda_scaler_metrics_value

# Number of ScaledObjects with errors
sum(keda_scaledobject_errors)

# Scaling decisions made per ScaledObject
increase(keda_scaled_object_paused[1h])

# HPA replica count managed by KEDA
keda_hpa_spec_replicas_max
keda_hpa_spec_replicas_min
```

## KEDA vs HPA with Custom Metrics: Architecture Comparison

| Aspect | KEDA | HPA + custom-metrics-adapter |
|---|---|---|
| Scale-to-zero | Yes (native) | No (floor of 1) |
| Scaler integrations | 50+ built-in | Custom adapter per source |
| Secret management | TriggerAuthentication CRD | Custom adapter config |
| ScaledJob (batch) | Yes | No |
| Pause autoscaling | Yes (annotation) | No standard mechanism |
| Multiple triggers | Yes (max of all triggers) | Yes (multiple metrics) |
| Fallback behavior | Yes (configurable replicas) | No |
| Activation threshold | Yes | No |
| Deployment complexity | Single Helm chart | Adapter per source + HPA |

KEDA subsumes the need for custom metrics adapters in most scenarios. The primary reason to prefer raw HPA + custom-metrics-adapter is when the target scaling metric is a standard Kubernetes resource metric (CPU, memory) that KEDA's Prometheus scaler would add latency to, or when KEDA's polling-based model introduces unacceptable lag compared to the adapter's push model.

## Operational Runbooks

### Diagnosing Scaling Failures

```bash
# Check ScaledObject status for error conditions
kubectl describe scaledobject orders-kafka-worker -n orders

# Check events associated with the ScaledObject
kubectl get events -n orders --field-selector involvedObject.name=orders-kafka-worker

# Check KEDA operator logs for scaling decisions
kubectl logs -n keda -l app=keda-operator --tail=100 | grep "orders-kafka-worker"

# Check that the HPA managed by KEDA is healthy
kubectl describe hpa -n orders keda-hpa-orders-kafka-worker

# Verify the metrics adapter is returning values
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/orders/s0-kafka-orders.created" | jq .

# Check TriggerAuthentication is correctly configured
kubectl describe triggerauthentication kafka-sasl-auth -n orders
```

### Manually Testing a Scaler

```bash
# Temporarily override the replica count while KEDA is active
# Note: KEDA will reconcile the count back to its calculated value within one pollingInterval

# For Kafka: check current consumer lag directly
kubectl exec -n messaging kafka-brokers-0 -- \
  kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --group orders-processor-v2

# For RabbitMQ: check queue depth via management API
curl -s -u monitoring:EXAMPLE_RABBITMQ_MONITORING_PASSWORD_REPLACE_ME \
  "http://rabbitmq-main.messaging.svc.cluster.local:15672/api/queues/%2Fnotifications/notifications.email" \
  | jq '.messages'

# For AWS SQS: check approximate message count
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/report-generation-queue \
  --attribute-names ApproximateNumberOfMessages
```

### Cleaning Up Stale ScaledObjects

```bash
# List all ScaledObjects with their current status
kubectl get scaledobjects -A -o custom-columns="NAMESPACE:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[?(@.type=='Ready')].status,REPLICAS:.status.replicas"

# Delete a ScaledObject (returns the deployment to unmanaged HPA or manual scaling)
kubectl delete scaledobject orders-kafka-worker -n orders

# After deletion, the HPA created by KEDA is also deleted
# Verify no lingering HPA
kubectl get hpa -n orders
```

## Summary

KEDA extends Kubernetes autoscaling from resource-metric-based HPA to event-driven scaling across 50+ external sources. The ScaledObject CRD provides a unified interface to Kafka consumer lag, Prometheus custom metrics, RabbitMQ queue depth, Redis list length, AWS SQS queue depth, and time-based cron schedules — all with configurable activation thresholds, cooldown periods, fallback replica counts, and scale-to-zero behavior. ScaledJob handles batch workloads where each unit of work should run as an isolated Kubernetes Job. TriggerAuthentication and ClusterTriggerAuthentication decouple credential management from trigger configuration, integrating naturally with External Secrets Operator for Vault and cloud-native secret stores. Pausing autoscaling via annotation enables safe deployment windows and debugging sessions without disrupting the ScaledObject configuration. Prometheus metrics and PrometheusRule alerts give platform teams the observability needed to detect and respond to scaler errors and metric API failures before they affect workload availability.
