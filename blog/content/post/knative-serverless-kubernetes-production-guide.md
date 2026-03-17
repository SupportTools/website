---
title: "Knative Serving and Eventing: Serverless Workloads on Kubernetes"
date: 2027-12-27T00:00:00-05:00
draft: false
tags: ["Knative", "Serverless", "Kubernetes", "Eventing", "CloudEvents", "Istio", "Kafka"]
categories: ["Kubernetes", "Serverless"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Knative Serving and Eventing on Kubernetes covering Revision management, scale-to-zero, Broker/Trigger patterns, Kafka integration, traffic splitting, custom domains, and mTLS with Istio."
more_link: "yes"
url: "/knative-serverless-kubernetes-production-guide/"
---

Knative brings serverless semantics to Kubernetes without surrendering operational control. Knative Serving manages stateless workloads with scale-to-zero and traffic splitting, while Knative Eventing provides CloudEvents-based event routing through Brokers, Triggers, and Channels. Together, they enable event-driven architectures that scale from zero to peak load without cluster operator intervention.

This guide covers the complete production deployment: installing Knative with Istio as the networking layer, managing Revisions and Routes, implementing CloudEvents pipelines with Kafka, and securing workloads with mTLS. All configurations target enterprise environments where reliability, observability, and security are non-negotiable.

<!--more-->

# Knative Serving and Eventing: Serverless Workloads on Kubernetes

## Section 1: Architecture Overview

Knative Serving and Eventing are independent subsystems that can be deployed separately or together.

### Knative Serving Components

```
Knative Serving
├── controller          - Reconciles Service, Route, Configuration, Revision
├── webhook             - Validates and mutates Knative resources
├── activator           - Buffers requests during scale-from-zero
├── autoscaler          - Manages pod scaling (KPA/HPA)
└── queue-proxy         - Sidecar for metrics collection and request queuing
```

### Knative Eventing Components

```
Knative Eventing
├── eventing-controller  - Reconciles Broker, Trigger, Channel, Subscription
├── eventing-webhook     - Validates eventing resources
├── mt-broker-ingress    - Multi-tenant broker HTTP ingress
├── mt-broker-filter     - Multi-tenant broker trigger filtering
└── imc-controller       - InMemoryChannel implementation
```

### Resource Hierarchy in Knative Serving

```
Service (ksvc)
├── Configuration        - Manages template for Revisions
│   └── Revision         - Immutable snapshot of app version
└── Route                - Maps traffic percentages to Revisions
```

## Section 2: Installation

### Prerequisites

```bash
# Verify cluster version and resources
kubectl version --short
kubectl get nodes -o custom-columns="NAME:.metadata.name,CPU:.status.capacity.cpu,MEM:.status.capacity.memory"

# Minimum: 3 nodes, 4 CPU each, 8GB RAM each
```

### Install Knative Serving

```bash
# Install serving CRDs
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.13.1/serving-crds.yaml

# Install serving core components
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.13.1/serving-core.yaml

# Verify serving pods
kubectl get pods -n knative-serving

# Expected pods:
# activator, autoscaler, controller, webhook
```

### Install Istio as Networking Layer

```bash
# Install Istio using istioctl
istioctl install --set profile=default -y \
  --set meshConfig.enableTracing=true \
  --set meshConfig.defaultConfig.tracing.zipkin.address=jaeger-collector.observability:9411

# Install Knative Istio integration
kubectl apply -f https://github.com/knative/net-istio/releases/download/knative-v1.13.1/net-istio.yaml

# Configure DNS (using Magic DNS for non-production / real DNS for production)
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.13.1/serving-default-domain.yaml
```

### Production DNS Configuration

```yaml
# knative-domain-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-domain
  namespace: knative-serving
data:
  # Production domain — all services get <service>.<namespace>.<domain>
  apps.corp.example.com: ""
  # Staging domain for specific namespace
  staging.example.com: |
    selector:
      app.kubernetes.io/environment: staging
```

### Install Knative Eventing

```bash
# Install eventing CRDs
kubectl apply -f https://github.com/knative/eventing/releases/download/knative-v1.13.1/eventing-crds.yaml

# Install eventing core
kubectl apply -f https://github.com/knative/eventing/releases/download/knative-v1.13.1/eventing-core.yaml

# Install multi-tenant channel-based broker
kubectl apply -f https://github.com/knative/eventing/releases/download/knative-v1.13.1/mt-channel-broker.yaml

# Verify eventing pods
kubectl get pods -n knative-eventing
```

## Section 3: Knative Serving — Services, Routes, and Revisions

### Basic Knative Service

```yaml
# hello-world-ksvc.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: hello-world
  namespace: production
  labels:
    app: hello-world
    app.kubernetes.io/part-of: demo-app
spec:
  template:
    metadata:
      annotations:
        # Scale-to-zero configuration
        autoscaling.knative.dev/minScale: "0"
        autoscaling.knative.dev/maxScale: "50"
        autoscaling.knative.dev/target: "100"        # concurrent requests per pod
        autoscaling.knative.dev/targetUtilization: "70"
        autoscaling.knative.dev/scaleDownDelay: "60s"
        autoscaling.knative.dev/window: "60s"
        # Revision naming
        serving.knative.dev/rolloutDuration: "120s"
    spec:
      containerConcurrency: 100
      timeoutSeconds: 300
      containers:
        - image: gcr.io/corp-registry/hello-world:v1.2.0
          ports:
            - containerPort: 8080
              protocol: TCP
          env:
            - name: TARGET
              value: "Knative Production"
            - name: LOG_LEVEL
              value: "info"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 1000m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
```

### Traffic Splitting Between Revisions

```yaml
# traffic-split-ksvc.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: payment-service
  namespace: production
spec:
  template:
    metadata:
      name: payment-service-v3  # Named revision
      annotations:
        autoscaling.knative.dev/minScale: "2"
        autoscaling.knative.dev/maxScale: "100"
        autoscaling.knative.dev/target: "50"
    spec:
      containers:
        - image: gcr.io/corp-registry/payment-service:v3.0.0
          ports:
            - containerPort: 8080
  traffic:
    - revisionName: payment-service-v3
      percent: 20
      tag: candidate
    - revisionName: payment-service-v2
      percent: 80
      tag: stable
    - latestRevision: false
      revisionName: payment-service-v1
      percent: 0
      tag: rollback  # Zero traffic but accessible via tag URL
```

```bash
# Manage traffic splits imperatively
kn service update payment-service \
  --traffic payment-service-v3=50 \
  --traffic payment-service-v2=50

# Promote v3 to 100%
kn service update payment-service \
  --traffic payment-service-v3=100

# Access specific revisions via tag URLs
# https://candidate-payment-service.production.apps.corp.example.com
# https://stable-payment-service.production.apps.corp.example.com
# https://rollback-payment-service.production.apps.corp.example.com
```

### Advanced Autoscaling Configuration

```yaml
# hpa-based-ksvc.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: data-processor
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Use Kubernetes HPA instead of Knative Pod Autoscaler
        autoscaling.knative.dev/class: "hpa.autoscaling.knative.dev"
        autoscaling.knative.dev/metric: "cpu"
        autoscaling.knative.dev/target: "70"       # 70% CPU utilization
        autoscaling.knative.dev/minScale: "2"       # Never scale to zero (cold start unacceptable)
        autoscaling.knative.dev/maxScale: "30"
        autoscaling.knative.dev/scaleTargetRef: |
          apiVersion: apps/v1
          kind: Deployment
    spec:
      containers:
        - image: gcr.io/corp-registry/data-processor:v2.1.0
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
```

### Global Autoscaler Configuration

```yaml
# config-autoscaler.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-autoscaler
  namespace: knative-serving
data:
  # Pod autoscaler class default
  pod-autoscaler-class: "kpa.autoscaling.knative.dev"
  # Default target concurrency
  container-concurrency-target-default: "100"
  # Target utilization percentage
  container-concurrency-target-percentage: "0.7"
  # Scale window duration
  stable-window: "60s"
  # Panic mode window (burst scaling)
  panic-window: "6s"
  panic-window-percentage: "10.0"
  panic-threshold-percentage: "200.0"
  # Minimum and maximum scale bounds
  max-scale-up-rate: "1000.0"
  max-scale-down-rate: "2.0"
  # Allow scale to zero
  allow-zero-initial-scale: "true"
  initial-scale: "1"
  # Scale to zero grace period
  scale-to-zero-grace-period: "30s"
  scale-to-zero-pod-retention-period: "0s"
```

## Section 4: Knative Eventing — CloudEvents Architecture

### CloudEvent Standard

CloudEvents provides a specification for event data. Every Knative Eventing message must conform to the CloudEvents spec:

```
Required Attributes:
  specversion: "1.0"
  type:        "com.corp.order.placed"
  source:      "/order-service/api/v2"
  id:          "3d6a8d90-2e4f-4b9c-8c3a-7f3e8b2c1d0a"

Optional Attributes:
  time:        "2027-12-27T10:30:00Z"
  datacontenttype: "application/json"
  subject:     "order/12345"
  data:        { "orderId": "12345", "amount": 99.99 }
```

### Broker and Trigger Pattern

```yaml
# production-broker.yaml
apiVersion: eventing.knative.dev/v1
kind: Broker
metadata:
  name: production-broker
  namespace: production
  annotations:
    eventing.knative.dev/broker.class: MTChannelBasedBroker
spec:
  config:
    apiVersion: v1
    kind: ConfigMap
    name: broker-config
    namespace: knative-eventing
  delivery:
    backoffDelay: PT2S
    backoffPolicy: exponential
    retry: 5
    timeout: PT30S
    deadLetterSink:
      ref:
        apiVersion: v1
        kind: Service
        name: dead-letter-service
        namespace: production
---
# Trigger: route order.placed events to order-processor
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: order-processor-trigger
  namespace: production
spec:
  broker: production-broker
  filter:
    attributes:
      type: com.corp.order.placed
      source: /order-service/api/v2
  subscriber:
    ref:
      apiVersion: serving.knative.dev/v1
      kind: Service
      name: order-processor
    uri: /events/orders
  delivery:
    backoffDelay: PT1S
    backoffPolicy: linear
    retry: 3
    deadLetterSink:
      ref:
        apiVersion: v1
        kind: Service
        name: order-dlq-processor
---
# Trigger: route payment events to payment-processor
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: payment-processor-trigger
  namespace: production
spec:
  broker: production-broker
  filter:
    attributes:
      type: com.corp.payment.processed
  subscriber:
    ref:
      apiVersion: serving.knative.dev/v1
      kind: Service
      name: payment-processor
```

### Sending CloudEvents to a Broker

```bash
# Send a CloudEvent using curl
BROKER_URL=$(kubectl get broker production-broker -n production \
  -o jsonpath='{.status.address.url}')

curl -v -X POST "$BROKER_URL" \
  -H "Content-Type: application/json" \
  -H "Ce-Specversion: 1.0" \
  -H "Ce-Type: com.corp.order.placed" \
  -H "Ce-Source: /order-service/api/v2" \
  -H "Ce-Id: $(uuidgen)" \
  -H "Ce-Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -d '{"orderId":"12345","amount":99.99,"customerId":"cust-789"}'
```

## Section 5: Kafka Source and Sink

### KafkaSource — Consuming from Kafka

```yaml
# kafka-source.yaml
apiVersion: sources.knative.dev/v1beta1
kind: KafkaSource
metadata:
  name: order-events-source
  namespace: production
spec:
  bootstrapServers:
    - kafka-broker-0.kafka.kafka-cluster.svc.cluster.local:9092
    - kafka-broker-1.kafka.kafka-cluster.svc.cluster.local:9092
    - kafka-broker-2.kafka.kafka-cluster.svc.cluster.local:9092
  topics:
    - orders.placed
    - orders.updated
  consumerGroup: knative-order-processor
  net:
    sasl:
      enable: true
      user:
        secretKeyRef:
          name: kafka-sasl-credentials
          key: username
      password:
        secretKeyRef:
          name: kafka-sasl-credentials
          key: password
      type:
        secretKeyRef:
          name: kafka-sasl-credentials
          key: saslType      # PLAIN, SCRAM-SHA-256, SCRAM-SHA-512
    tls:
      enable: true
      caCert:
        secretKeyRef:
          name: kafka-tls-secret
          key: tls.crt
  delivery:
    backoffDelay: PT2S
    backoffPolicy: exponential
    retry: 10
    timeout: PT60S
  sink:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: production-broker
      namespace: production
```

### KafkaSink — Producing to Kafka

```yaml
# kafka-sink.yaml
apiVersion: eventing.knative.dev/v1alpha1
kind: KafkaSink
metadata:
  name: order-events-sink
  namespace: production
spec:
  topic: orders.processed
  numPartitions: 10
  replicationFactor: 3
  bootstrapServers:
    - kafka-broker-0.kafka.kafka-cluster.svc.cluster.local:9092
    - kafka-broker-1.kafka.kafka-cluster.svc.cluster.local:9092
  auth:
    secret:
      ref:
        name: kafka-sasl-credentials
  contentMode: binary  # binary or structured
```

### Kafka Channel for Durable Eventing

```yaml
# kafka-channel-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-channel
  namespace: knative-eventing
data:
  channel-template-spec: |
    apiVersion: messaging.knative.dev/v1beta1
    kind: KafkaChannel
    spec:
      numPartitions: 10
      replicationFactor: 3
---
# Broker using Kafka channel
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-broker-config
  namespace: knative-eventing
data:
  default-br-config: |
    clusterDefault:
      brokerClass: Kafka
      apiVersion: v1
      kind: ConfigMap
      name: kafka-broker-config
      namespace: knative-eventing
    namespaceDefaults:
      production:
        brokerClass: Kafka
```

## Section 6: Sequence and Parallel Eventing Patterns

### Sequence — Event Processing Pipeline

```yaml
# order-processing-sequence.yaml
apiVersion: flows.knative.dev/v1
kind: Sequence
metadata:
  name: order-fulfillment-sequence
  namespace: production
spec:
  channelTemplate:
    apiVersion: messaging.knative.dev/v1beta1
    kind: KafkaChannel
    spec:
      numPartitions: 5
      replicationFactor: 3
  steps:
    - ref:
        apiVersion: serving.knative.dev/v1
        kind: Service
        name: order-validator
        namespace: production
      uri: /validate
    - ref:
        apiVersion: serving.knative.dev/v1
        kind: Service
        name: inventory-checker
        namespace: production
      uri: /check
    - ref:
        apiVersion: serving.knative.dev/v1
        kind: Service
        name: payment-processor
        namespace: production
      uri: /charge
    - ref:
        apiVersion: serving.knative.dev/v1
        kind: Service
        name: notification-service
        namespace: production
      uri: /notify
  reply:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: production-broker
      namespace: production
  delivery:
    deadLetterSink:
      ref:
        apiVersion: v1
        kind: Service
        name: sequence-dlq
        namespace: production
    retry: 3
    backoffPolicy: exponential
    backoffDelay: PT2S
```

### Parallel — Fan-Out Event Processing

```yaml
# notification-parallel.yaml
apiVersion: flows.knative.dev/v1
kind: Parallel
metadata:
  name: order-notification-parallel
  namespace: production
spec:
  channelTemplate:
    apiVersion: messaging.knative.dev/v1beta1
    kind: KafkaChannel
  branches:
    - filter:
        ref:
          apiVersion: serving.knative.dev/v1
          kind: Service
          name: email-filter
      subscriber:
        ref:
          apiVersion: serving.knative.dev/v1
          kind: Service
          name: email-notifier
    - filter:
        ref:
          apiVersion: serving.knative.dev/v1
          kind: Service
          name: sms-filter
      subscriber:
        ref:
          apiVersion: serving.knative.dev/v1
          kind: Service
          name: sms-notifier
    - subscriber:
        ref:
          apiVersion: serving.knative.dev/v1
          kind: Service
          name: audit-logger
  reply:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: production-broker
```

## Section 7: mTLS with Istio

### Enable Istio mTLS for Knative Namespaces

```yaml
# peer-authentication.yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: knative-serving-mtls
  namespace: knative-serving
spec:
  mtls:
    mode: STRICT
---
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: production-mtls
  namespace: production
spec:
  mtls:
    mode: STRICT
---
# Allow activator to reach services (activator is in knative-serving namespace)
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-activator
  namespace: production
spec:
  action: ALLOW
  rules:
    - from:
        - source:
            principals:
              - "cluster.local/ns/knative-serving/sa/controller"
              - "cluster.local/ns/knative-serving/sa/activator"
```

### Knative Serving Istio Configuration

```yaml
# config-istio.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-istio
  namespace: knative-serving
data:
  # Enable Istio sidecar injection
  enable-virtualservice-status: "true"
  # Local gateway for cluster-internal routing
  local-gateway-service: "knative-local-gateway.istio-system.svc.cluster.local"
  local-gateways: |
    - name: knative-local-gateway
      namespace: istio-system
```

### TLS Configuration for Public Routes

```yaml
# tls-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: wildcard-tls
  namespace: istio-system
type: kubernetes.io/tls
data:
  tls.crt: <base64-encoded-cert>
  tls.key: <base64-encoded-key>
---
# config-network.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-network
  namespace: knative-serving
data:
  ingress.class: "istio.ingress.networking.knative.dev"
  auto-tls: Enabled
  http-protocol: Redirected
  certificate-class: "cert-manager.certificate.networking.knative.dev"
  # Domain mapping for TLS
  domain-template: "{{.Name}}.{{.Namespace}}.{{.Domain}}"
```

## Section 8: Custom Domain Mapping

### DomainMapping Resource

```yaml
# domain-mapping.yaml
apiVersion: serving.knative.dev/v1beta1
kind: DomainMapping
metadata:
  name: api.corp.example.com
  namespace: production
spec:
  ref:
    name: api-gateway-service
    kind: Service
    apiVersion: serving.knative.dev/v1
  tls:
    secretName: api-corp-example-com-tls
---
# Map to a specific revision
apiVersion: serving.knative.dev/v1beta1
kind: DomainMapping
metadata:
  name: v2-api.corp.example.com
  namespace: production
spec:
  ref:
    name: payment-service-v2
    kind: Revision
    apiVersion: serving.knative.dev/v1
```

## Section 9: Observability

### Prometheus Metrics

```yaml
# knative-monitoring-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-observability
  namespace: knative-serving
data:
  metrics.backend-destination: prometheus
  profiling.enable: "false"
  # Prometheus scraping annotations are automatically added to pods
---
# ServiceMonitor for Knative Serving
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: knative-serving
  namespace: knative-serving
spec:
  selector:
    matchLabels:
      app: activator
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Knative Metrics

```bash
# Request count per revision
kubectl exec -n monitoring prometheus-0 -- \
  curl -s 'http://localhost:9090/api/v1/query?query=revision_request_count' | jq .

# Pod count for autoscaling decisions
# revision_app_request_count — incoming requests to app container
# knative_revision_request_latencies_bucket — latency histogram
# activator_request_count — requests through activator (during cold start)

# Check scale-to-zero behavior
kubectl get pods -n production -l serving.knative.dev/service=hello-world -w

# Current desired scale
kubectl get kpa -n production
kubectl describe kpa hello-world-xxxxx -n production
```

### Distributed Tracing

```yaml
# config-tracing.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-tracing
  namespace: knative-serving
data:
  backend: zipkin
  zipkin-endpoint: http://jaeger-collector.observability.svc.cluster.local:9411/api/v2/spans
  sample-rate: "0.1"  # 10% sampling in production
  debug: "false"
```

## Section 10: Production Operations

### Health Checks and Debugging

```bash
# List all Knative services across namespaces
kubectl get ksvc -A

# Check service status
kn service list -n production

# Describe service with traffic and revision details
kn service describe payment-service -n production

# View revision history
kn revision list -n production --service payment-service

# Delete old revisions (keep last 5)
kn revision list -n production --service payment-service \
  -o name | tail -n +6 | xargs kubectl delete -n production

# Check activator readiness
kubectl rollout status deployment/activator -n knative-serving

# View autoscaler logs for scaling decisions
kubectl logs -n knative-serving deployment/autoscaler -f | \
  grep -E "(scale|panic|stable)"
```

### Performance Tuning

```yaml
# config-gc.yaml — Garbage collect old revisions
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-gc
  namespace: knative-serving
data:
  # Minimum revisions retained per service
  min-non-active-revisions: "2"
  # Maximum revisions retained per service
  max-non-active-revisions: "5"
  # Retain revisions for at least this duration
  retain-since-create-time: "48h"
  retain-since-last-active-time: "15h"
```

```yaml
# config-features.yaml — Feature gates
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-features
  namespace: knative-serving
data:
  # Enable multi-container support
  multi-container: enabled
  # Enable init containers
  kubernetes-container-spec-fields: enabled
  # Enable tag header-based routing
  tag-header-based-routing: enabled
  # Enable queue-proxy resource defaults
  queue-proxy-resource-defaults: enabled
  # Responsive revision garbage collection
  responsive-revision-gc: enabled
```

### Eventing Dead Letter Queue Processing

```yaml
# dlq-processor-ksvc.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: dead-letter-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/maxScale: "5"
    spec:
      containers:
        - image: gcr.io/corp-registry/dlq-processor:v1.0.0
          env:
            - name: ALERT_WEBHOOK
              valueFrom:
                secretKeyRef:
                  name: alerting-secrets
                  key: pagerduty-url
          ports:
            - containerPort: 8080
```

### Namespace-Level Broker Default

```yaml
# namespace-broker-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-br-defaults
  namespace: knative-eventing
data:
  default-br-config: |
    clusterDefault:
      brokerClass: MTChannelBasedBroker
      apiVersion: v1
      kind: ConfigMap
      name: config-br-default-channel
      namespace: knative-eventing
      delivery:
        backoffDelay: PT2S
        backoffPolicy: exponential
        retry: 5
    namespaceDefaults:
      production:
        brokerClass: Kafka
        apiVersion: v1
        kind: ConfigMap
        name: kafka-channel
        namespace: knative-eventing
```

This guide provides the operational foundation for running Knative in production. The combination of Serving's scale-to-zero autoscaling and Eventing's CloudEvents routing enables event-driven, cost-efficient architectures that integrate naturally with existing Kafka infrastructure and Istio service mesh deployments.
