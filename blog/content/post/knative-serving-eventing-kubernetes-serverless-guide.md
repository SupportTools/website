---
title: "Knative: Serverless Workloads and Event-Driven Architecture on Kubernetes"
date: 2027-02-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Knative", "Serverless", "Event-Driven", "Scale to Zero"]
categories: ["Kubernetes", "Serverless", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to running serverless workloads and event-driven pipelines on Kubernetes with Knative Serving and Eventing, covering scale-to-zero, traffic splitting, CloudEvents, Kafka Broker, autoscaling, and production monitoring."
more_link: "yes"
url: "/knative-serving-eventing-kubernetes-serverless-guide/"
---

**Knative** extends Kubernetes with two orthogonal but composable layers: **Knative Serving** for request-driven, auto-scaling workloads including scale-to-zero, and **Knative Eventing** for declarative, CloudEvents-based event pipelines. Together they allow platform teams to offer a serverless developer experience on any Kubernetes cluster without coupling teams to a specific cloud provider's FaaS offering. This guide covers both layers in depth, from installation through Kafka-backed eventing, autoscaler tuning, and production observability.

<!--more-->

## Architecture Overview

### Knative Serving Resource Model

```
Knative Service
  └── Configuration  (desired state: image, env, resources)
        └── Revision  (immutable snapshot of Configuration)
  └── Route           (traffic split across Revisions)
        └── Ingress   (Gateway/Kourier rule)
```

A **Service** is the top-level object most users interact with. Every update to a Service creates a new immutable **Revision**. The **Route** distributes traffic across Revisions using percentage weights, enabling blue/green and canary deployments without external tooling.

### Knative Eventing Resource Model

```
EventSource  ──►  Channel / Broker  ──►  Trigger  ──►  Subscriber (Knative Service)
                                     └──►  Trigger  ──►  Subscriber (any HTTP endpoint)
```

The **Broker/Trigger** model decouples producers from consumers. Producers send CloudEvents to a Broker endpoint; consumers declare Triggers with attribute filters to receive only the events they care about.

## Installation

### Installing Knative Serving

```bash
#!/bin/bash
set -euo pipefail

KNATIVE_VERSION="v1.13.0"

# Install Serving CRDs
kubectl apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-crds.yaml"

# Install Serving core
kubectl apply -f "https://github.com/knative/serving/releases/download/knative-${KNATIVE_VERSION}/serving-core.yaml"

# Install Kourier as the networking layer (lightweight alternative to Istio)
kubectl apply -f "https://github.com/knative/net-kourier/releases/download/knative-${KNATIVE_VERSION}/kourier.yaml"

# Configure Knative to use Kourier
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# Verify the Kourier LoadBalancer is provisioned
kubectl get svc kourier -n kourier-system

# Configure domain (replace with your actual domain)
kubectl patch configmap/config-domain \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"knative.example.com":""}}'

echo "Knative Serving installed"
kubectl get pods -n knative-serving
```

For environments that already run Istio, replace Kourier with the Istio gateway integration:

```bash
# Install net-istio instead of Kourier
kubectl apply -f "https://github.com/knative/net-istio/releases/download/knative-${KNATIVE_VERSION}/net-istio.yaml"

kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"istio.ingress.networking.knative.dev"}}'
```

### Installing Knative Eventing

```bash
#!/bin/bash
set -euo pipefail

KNATIVE_VERSION="v1.13.0"

# Install Eventing CRDs
kubectl apply -f "https://github.com/knative/eventing/releases/download/knative-${KNATIVE_VERSION}/eventing-crds.yaml"

# Install Eventing core
kubectl apply -f "https://github.com/knative/eventing/releases/download/knative-${KNATIVE_VERSION}/eventing-core.yaml"

# Install the in-memory channel (development only)
kubectl apply -f "https://github.com/knative/eventing/releases/download/knative-${KNATIVE_VERSION}/in-memory-channel.yaml"

# Install the MT (multi-tenant) Channel-Based Broker
kubectl apply -f "https://github.com/knative/eventing/releases/download/knative-${KNATIVE_VERSION}/mt-channel-broker.yaml"

# Install the Kafka Broker and Channel for production use
KAFKA_BROKER_VERSION="v1.13.0"
kubectl apply -f "https://github.com/knative-extensions/eventing-kafka-broker/releases/download/knative-${KAFKA_BROKER_VERSION}/eventing-kafka-controller.yaml"
kubectl apply -f "https://github.com/knative-extensions/eventing-kafka-broker/releases/download/knative-${KAFKA_BROKER_VERSION}/eventing-kafka-broker.yaml"
kubectl apply -f "https://github.com/knative-extensions/eventing-kafka-broker/releases/download/knative-${KAFKA_BROKER_VERSION}/eventing-kafka-source.yaml"

echo "Knative Eventing installed"
kubectl get pods -n knative-eventing
```

### Global Configuration

```yaml
# config-autoscaler — global autoscaling defaults
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-autoscaler
  namespace: knative-serving
data:
  # Scale-to-zero settings
  enable-scale-to-zero: "true"
  scale-to-zero-grace-period: "30s"
  scale-to-zero-pod-retention-period: "0s"

  # Initial scale when a revision receives its first request
  initial-scale: "1"
  allow-zero-initial-scale: "true"

  # Scale-up aggressiveness
  max-scale-up-rate: "1000"
  max-scale-down-rate: "2"

  # Target concurrency (requests in-flight per pod)
  container-concurrency-target-default: "100"
  container-concurrency-target-percentage: "0.7"

  # Requests-per-second target (alternative to concurrency)
  requests-per-second-target-default: "200"

  # Autoscaler window
  stable-window: "60s"
  panic-window-percentage: "10.0"
  panic-threshold-percentage: "200.0"

  # Tick interval
  tick-interval: "2s"

  # Scale bounds
  min-scale: "0"
  max-scale: "100"

  # Activator capacity: how many requests the activator buffers while pods scale up
  activator-capacity: "100"
---
# config-features — feature flags
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-features
  namespace: knative-serving
data:
  kubernetes.podspec-affinity: enabled
  kubernetes.podspec-topologyspreadconstraints: enabled
  kubernetes.podspec-hostnamefromsubdomain: disabled
  kubernetes.containerspec-addcapabilities: disabled
  kubernetes.podspec-init-containers: enabled
  kubernetes.podspec-securitycontext: enabled
  tag-header-based-routing: enabled
  multi-container: enabled
  kubernetes.podspec-persistent-volume-claim: disabled
```

## Knative Serving: Services, Revisions, and Traffic Splitting

### Creating and Updating a Knative Service

```yaml
# Basic Knative Service
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: order-api
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Autoscaling annotations at the Revision level
        autoscaling.knative.dev/class: "kpa.autoscaling.knative.dev"
        autoscaling.knative.dev/metric: "concurrency"
        autoscaling.knative.dev/target: "80"
        autoscaling.knative.dev/min-scale: "1"
        autoscaling.knative.dev/max-scale: "50"
        autoscaling.knative.dev/initial-scale: "2"
        autoscaling.knative.dev/scale-to-zero-pod-retention-period: "60s"
        # Stable window for this revision
        autoscaling.knative.dev/window: "90s"
        autoscaling.knative.dev/panic-window-percentage: "15.0"
        # Give pods time to finish in-flight requests
        serving.knative.dev/progress-deadline: "600s"
    spec:
      # How many concurrent requests each container can handle
      containerConcurrency: 100
      # Knative Serving manages this timeout
      timeoutSeconds: 300
      containers:
        - name: order-api
          image: registry.example.com/order-api:3.1.0
          ports:
            - name: http1
              containerPort: 8080
          env:
            - name: LOG_LEVEL
              value: "info"
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: host
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 2000m
              memory: 1Gi
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 3
            periodSeconds: 5
      # Node affinity and topology spread
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    serving.knative.dev/service: order-api
                topologyKey: kubernetes.io/hostname
```

### Traffic Splitting Between Revisions

```yaml
# Traffic split: 90% to stable, 10% canary
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: order-api
  namespace: production
spec:
  template:
    metadata:
      name: order-api-canary
      annotations:
        autoscaling.knative.dev/min-scale: "1"
        autoscaling.knative.dev/max-scale: "20"
    spec:
      containerConcurrency: 100
      containers:
        - name: order-api
          image: registry.example.com/order-api:3.2.0-rc1
          ports:
            - name: http1
              containerPort: 8080
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 2000m
              memory: 1Gi
  traffic:
    - revisionName: order-api-stable
      percent: 90
      tag: stable
    - revisionName: order-api-canary
      percent: 10
      tag: canary
    - latestRevision: false
      percent: 0
      tag: latest
```

```bash
# kn CLI — traffic management
kn service update order-api \
  --traffic order-api-stable=80 \
  --traffic order-api-canary=20 \
  -n production

# Promote canary to 100% once validated
kn service update order-api \
  --traffic order-api-canary=100 \
  -n production

# List all revisions
kn revision list -n production

# Describe a service to see current traffic
kn service describe order-api -n production

# Watch autoscaling events
kn revision list -n production --watch
```

### HPA Integration for CPU-Based Autoscaling

```yaml
# Use Kubernetes HPA instead of KPA for CPU/memory-driven scaling
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: batch-processor
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Switch to HPA class
        autoscaling.knative.dev/class: "hpa.autoscaling.knative.dev"
        autoscaling.knative.dev/metric: "cpu"
        autoscaling.knative.dev/target: "70"
        autoscaling.knative.dev/min-scale: "2"
        autoscaling.knative.dev/max-scale: "30"
        # HPA does not support scale-to-zero
    spec:
      containerConcurrency: 0
      containers:
        - name: batch-processor
          image: registry.example.com/batch-processor:1.4.2
          ports:
            - name: http1
              containerPort: 8080
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 4000m
              memory: 2Gi
```

## Knative Eventing: Brokers, Triggers, and Sources

### Kafka Broker for Durable Eventing

```yaml
# KafkaBroker — durable, high-throughput broker backed by Kafka
apiVersion: eventing.knative.dev/v1
kind: Broker
metadata:
  name: default
  namespace: production
  annotations:
    eventing.knative.dev/broker.class: KafkaNamespacedBroker
spec:
  config:
    apiVersion: v1
    kind: ConfigMap
    name: kafka-broker-config
    namespace: knative-eventing
  delivery:
    deadLetterSink:
      ref:
        apiVersion: serving.knative.dev/v1
        kind: Service
        name: event-dlq-handler
        namespace: production
    backoffDelay: "PT2S"
    backoffPolicy: exponential
    retry: 5
    timeout: "PT10S"
---
# ConfigMap for KafkaBroker configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-broker-config
  namespace: knative-eventing
data:
  default.topic.partitions: "10"
  default.topic.replication.factor: "3"
  bootstrap.servers: "kafka-broker-0.kafka-headless.kafka.svc.cluster.local:9092,kafka-broker-1.kafka-headless.kafka.svc.cluster.local:9092,kafka-broker-2.kafka-headless.kafka.svc.cluster.local:9092"
```

### Triggers with CloudEvent Filters

```yaml
# Trigger — route order.created events to the order-processor service
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: order-created-trigger
  namespace: production
spec:
  broker: default
  filter:
    attributes:
      type: "com.example.orders.order.created"
      source: "https://orders.example.com/v1"
  subscriber:
    ref:
      apiVersion: serving.knative.dev/v1
      kind: Service
      name: order-processor
    uri: /events/orders
  delivery:
    deadLetterSink:
      ref:
        apiVersion: serving.knative.dev/v1
        kind: Service
        name: event-dlq-handler
    backoffDelay: "PT5S"
    backoffPolicy: exponential
    retry: 3
    timeout: "PT30S"
---
# Trigger — payment events to the fraud-detector (any payment type)
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: payment-trigger
  namespace: production
spec:
  broker: default
  filter:
    attributes:
      source: "https://payments.example.com/v1"
  subscriber:
    ref:
      apiVersion: serving.knative.dev/v1
      kind: Service
      name: fraud-detector
    uri: /analyze
  delivery:
    retry: 5
    backoffPolicy: exponential
    backoffDelay: "PT2S"
```

### Event Sources

```yaml
# KafkaSource — consume from a Kafka topic and forward to a Broker
apiVersion: sources.knative.dev/v1beta1
kind: KafkaSource
metadata:
  name: payment-kafka-source
  namespace: production
spec:
  bootstrapServers:
    - "kafka-broker-0.kafka-headless.kafka.svc.cluster.local:9092"
    - "kafka-broker-1.kafka-headless.kafka.svc.cluster.local:9092"
  topics:
    - payment-raw
  consumerGroup: knative-payment-consumer
  net:
    tls:
      enable: false
    sasl:
      enable: false
  sink:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: default
      namespace: production
  delivery:
    backoffDelay: "PT2S"
    backoffPolicy: exponential
    retry: 5
---
# ApiServerSource — forward Kubernetes API events to a service
apiVersion: sources.knative.dev/v1
kind: ApiServerSource
metadata:
  name: k8s-pod-events
  namespace: production
spec:
  serviceAccountName: apiserversource-sa
  mode: Reference
  resources:
    - apiVersion: v1
      kind: Pod
      eventMode: Resource
  sink:
    ref:
      apiVersion: serving.knative.dev/v1
      kind: Service
      name: audit-logger
---
# PingSource — emit CloudEvents on a schedule
apiVersion: sources.knative.dev/v1
kind: PingSource
metadata:
  name: hourly-report-trigger
  namespace: production
spec:
  schedule: "0 * * * *"
  contentType: application/json
  data: '{"report":"hourly-summary","version":"1"}'
  timezone: "America/New_York"
  sink:
    ref:
      apiVersion: serving.knative.dev/v1
      kind: Service
      name: report-generator
```

### Sequences for Event Pipelines

A **Sequence** chains multiple subscribers, passing the output of each step as the CloudEvent input to the next step.

```yaml
# Sequence — enrich → validate → store
apiVersion: flows.knative.dev/v1
kind: Sequence
metadata:
  name: order-enrichment-pipeline
  namespace: production
spec:
  channelTemplate:
    apiVersion: messaging.knative.dev/v1
    kind: InMemoryChannel
  steps:
    - ref:
        apiVersion: serving.knative.dev/v1
        kind: Service
        name: order-enricher
      delivery:
        retry: 3
        backoffPolicy: exponential
        backoffDelay: "PT1S"
    - ref:
        apiVersion: serving.knative.dev/v1
        kind: Service
        name: order-validator
      delivery:
        retry: 3
        backoffPolicy: exponential
        backoffDelay: "PT1S"
    - ref:
        apiVersion: serving.knative.dev/v1
        kind: Service
        name: order-storer
  reply:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: default
      namespace: production
```

### Parallel for Fan-Out Processing

```yaml
# Parallel — send to multiple branches simultaneously
apiVersion: flows.knative.dev/v1
kind: Parallel
metadata:
  name: notification-fanout
  namespace: production
spec:
  channelTemplate:
    apiVersion: messaging.knative.dev/v1
    kind: InMemoryChannel
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
      name: default
      namespace: production
```

## Writing CloudEvents-Compatible Services

Knative Eventing delivers events to subscriber endpoints as HTTP POST requests following the [CloudEvents specification](https://cloudevents.io/).

```go
// main.go — CloudEvents subscriber in Go
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"

	cloudevents "github.com/cloudevents/sdk-go/v2"
)

type OrderCreatedEvent struct {
	OrderID    string  `json:"orderId"`
	CustomerID string  `json:"customerId"`
	Amount     float64 `json:"amount"`
	Currency   string  `json:"currency"`
}

func handleOrderCreated(ctx context.Context, event cloudevents.Event) (*cloudevents.Event, cloudevents.Result) {
	var order OrderCreatedEvent
	if err := event.DataAs(&order); err != nil {
		log.Printf("failed to parse event data: %v", err)
		return nil, cloudevents.NewHTTPResult(http.StatusBadRequest, "invalid event data")
	}

	log.Printf("Processing order %s for customer %s: $%.2f %s",
		order.OrderID, order.CustomerID, order.Amount, order.Currency)

	// Business logic here...

	// Emit a reply event downstream (picked up by the Sequence reply config)
	reply := cloudevents.NewEvent()
	reply.SetSource("https://order-processor.example.com/v1")
	reply.SetType("com.example.orders.order.processed")
	reply.SetExtension("orderid", order.OrderID)
	if err := reply.SetData(cloudevents.ApplicationJSON, map[string]string{
		"orderId": order.OrderID,
		"status":  "processed",
	}); err != nil {
		return nil, cloudevents.NewHTTPResult(http.StatusInternalServerError, "failed to set reply data")
	}

	return &reply, cloudevents.ResultACK
}

func main() {
	c, err := cloudevents.NewClientHTTP()
	if err != nil {
		log.Fatalf("failed to create CloudEvents client: %v", err)
	}

	fmt.Println("Starting CloudEvents receiver on :8080")
	if err := c.StartReceiver(context.Background(), handleOrderCreated); err != nil {
		log.Fatalf("start receiver: %v", err)
	}
}
```

## Monitoring with Prometheus and Grafana

```yaml
# ServiceMonitor for Knative Serving components
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: knative-serving
  namespace: monitoring
  labels:
    release: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - knative-serving
  selector:
    matchLabels:
      app: controller
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
---
# ServiceMonitor for Knative Eventing
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: knative-eventing
  namespace: monitoring
  labels:
    release: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - knative-eventing
  selector:
    matchLabels:
      app: eventing-controller
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
```

Key PromQL queries for Knative Serving:

```promql
# Requests per second by service and revision
sum(rate(revision_request_count{namespace="production"}[1m]))
by (service_name, revision_name, response_code_class)

# p99 request latency per revision
histogram_quantile(0.99,
  sum(rate(revision_request_latencies_bucket{namespace="production"}[5m]))
  by (service_name, revision_name, le)
)

# Current pod count per revision
knative_serving_autoscaler_desired_pods{namespace="production"}

# Scale-to-zero activation count (pods woken from zero)
sum(increase(activator_request_count{namespace="production"}[1h]))
by (service_name, revision_name)

# Event delivery success rate
sum(rate(event_count{namespace="production",response_code="202"}[5m])) /
sum(rate(event_count{namespace="production"}[5m]))

# Dead letter sink deliveries (failed events)
sum(rate(event_count{namespace="production",response_code!~"2.."}[5m]))
by (trigger_name, broker_name)
```

## Production Hardening

### Multi-Revision Rollout Strategy

```bash
#!/bin/bash
# Safe rollout script with automatic traffic shifting
set -euo pipefail

SERVICE="order-api"
NAMESPACE="production"
NEW_IMAGE="registry.example.com/order-api:3.3.0"
CANARY_PCT=10

# Deploy the new revision with 0% traffic
kn service update "${SERVICE}" \
  --image "${NEW_IMAGE}" \
  --traffic @latest=0,@prev=100 \
  --annotation autoscaling.knative.dev/min-scale=1 \
  -n "${NAMESPACE}"

# Get the new revision name
NEW_REV=$(kn revision list -n "${NAMESPACE}" -s "${SERVICE}" --limit 1 -o name | head -1)
echo "New revision: ${NEW_REV}"

# Route canary traffic
kn service update "${SERVICE}" \
  --traffic "${NEW_REV}=${CANARY_PCT}" \
  --traffic "@prev=$((100 - CANARY_PCT))" \
  -n "${NAMESPACE}"

echo "Canary deployed at ${CANARY_PCT}%. Monitor metrics for 5 minutes before promoting."
echo "Promote with:"
echo "  kn service update ${SERVICE} --traffic ${NEW_REV}=100 -n ${NAMESPACE}"
echo "Rollback with:"
echo "  kn service update ${SERVICE} --traffic @prev=100 -n ${NAMESPACE}"
```

### Resource Quotas and Limits for Serving Namespaces

```yaml
# Limit ranges to ensure all revisions have resource boundaries
apiVersion: v1
kind: LimitRange
metadata:
  name: knative-limits
  namespace: production
spec:
  limits:
    - type: Container
      default:
        cpu: 1000m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      max:
        cpu: 8000m
        memory: 8Gi
      min:
        cpu: 50m
        memory: 64Mi
---
# ResourceQuota for the namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: knative-quota
  namespace: production
spec:
  hard:
    requests.cpu: "100"
    requests.memory: "100Gi"
    limits.cpu: "500"
    limits.memory: "500Gi"
    count/services.serving.knative.dev: "200"
    count/revisions.serving.knative.dev: "1000"
```

### Network Policy for Knative

```yaml
# Allow Knative activator to reach application pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-knative-activator
  namespace: production
spec:
  podSelector: {}
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: knative-serving
          podSelector:
            matchLabels:
              app: activator
      ports:
        - port: 8080
          protocol: TCP
        - port: 8443
          protocol: TCP
  policyTypes:
    - Ingress
```

## Troubleshooting

```bash
# kn diagnostics
kn service describe order-api -n production
kn revision list -n production --service order-api
kn route describe order-api -n production

# Check autoscaler decisions
kubectl logs -n knative-serving deployment/autoscaler --tail 100 | grep order-api

# Check activator logs for cold-start issues
kubectl logs -n knative-serving deployment/activator --tail 200 | grep -i "throttle\|timeout\|error"

# Inspect a revision's status conditions
kubectl get revision order-api-00003 -n production -o jsonpath='{.status.conditions}' | python3 -m json.tool

# Debug eventing delivery failures
kubectl get broker default -n production -o yaml | grep -A 10 "status:"
kubectl get trigger order-created-trigger -n production -o yaml | grep -A 20 "status:"

# Check Kafka Broker data plane pods
kubectl get pods -n knative-eventing -l app=knative-kafka-broker-data-plane

# Tail event delivery logs
kubectl logs -n knative-eventing -l app=knative-kafka-broker-data-plane --tail 200 | grep -i "error\|failed\|dlq"

# Examine DLQ events
kubectl port-forward svc/event-dlq-handler 8080:80 -n production &
# Events arriving at the DLQ handler indicate delivery failures
```

## Summary

Knative delivers a cloud-agnostic serverless experience on Kubernetes by combining automatic scale-to-zero with a rich, CloudEvents-native eventing system. **Knative Serving** handles the per-revision immutability model, KPA-driven autoscaling, and percentage-based traffic splits that enable safe canary releases. **Knative Eventing** provides a loosely coupled broker-trigger architecture backed by Kafka for durability, with Sequences and Parallels enabling multi-step event pipelines without custom orchestration code. Combined with Prometheus metrics, standard Go CloudEvents SDKs, and the `kn` CLI, the platform offers a cohesive developer and operator experience for event-driven microservices on any Kubernetes distribution.
