---
title: "Dapr: Distributed Application Runtime for Kubernetes Microservices"
date: 2027-02-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Dapr", "Microservices", "Service Mesh", "Distributed Systems"]
categories: ["Kubernetes", "Microservices", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying and operating Dapr on Kubernetes, covering the sidecar architecture, all building blocks, Component CRDs, resiliency policies, observability, and production sizing for enterprise microservices."
more_link: "yes"
url: "/dapr-distributed-application-runtime-kubernetes-guide/"
---

**Dapr** (Distributed Application Runtime) abstracts away the complexity of distributed-systems concerns—service discovery, state management, pub/sub messaging, secret retrieval, and more—behind a stable HTTP/gRPC API that any language or framework can consume. By injecting a lightweight sidecar into each pod, Dapr decouples applications from the infrastructure they run on, letting teams swap Redis for Cassandra, Kafka for RabbitMQ, or Azure Service Bus for AWS SNS with a single YAML change and zero code modification. This guide walks through every aspect of running Dapr on Kubernetes, from initial installation through workflow authoring, resiliency policies, and production sizing.

<!--more-->

## Dapr Architecture on Kubernetes

### Control Plane and Sidecar Model

Dapr's Kubernetes integration consists of a small control plane in the `dapr-system` namespace and a `daprd` sidecar that Dapr's mutating admission webhook injects into annotated pods.

```
┌───────────────────────────────────────────────────────────────┐
│                       dapr-system namespace                   │
│  ┌─────────────────┐  ┌───────────────┐  ┌────────────────┐  │
│  │  dapr-operator  │  │ dapr-sidecar  │  │  dapr-dashboard│  │
│  │  (CRD watching) │  │  -injector    │  │  (port 8080)   │  │
│  └─────────────────┘  └───────────────┘  └────────────────┘  │
│  ┌─────────────────┐  ┌───────────────┐                       │
│  │  dapr-placement │  │  dapr-sentry  │                       │
│  │  (Actor hashing)│  │  (mTLS CA)    │                       │
│  └─────────────────┘  └───────────────┘                       │
└───────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                Application Pod                      │
│  ┌──────────────────┐    ┌───────────────────────┐  │
│  │  App Container   │◄──►│  daprd sidecar        │  │
│  │  (any language)  │    │  :3500  HTTP API       │  │
│  │                  │    │  :50001 gRPC API       │  │
│  └──────────────────┘    │  :9090  Metrics        │  │
│                           └───────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

Control-plane components:

- **dapr-operator** — watches `Component`, `Subscription`, `Resiliency`, and `Configuration` CRDs and pushes changes to sidecars
- **dapr-sidecar-injector** — mutating webhook that injects `daprd` based on pod annotations
- **dapr-placement** — consistent-hash ring for the Actors building block
- **dapr-sentry** — SPIFFE-compatible CA that issues mTLS certificates to every sidecar
- **dapr-dashboard** — web UI for browsing components, applications, and metrics

### Installing Dapr with Helm

```bash
#!/bin/bash
set -euo pipefail

DAPR_VERSION="1.13.0"

# Add the Dapr Helm chart repository
helm repo add dapr https://dapr.github.io/helm-charts/
helm repo update

# Create the control-plane namespace
kubectl create namespace dapr-system --dry-run=client -o yaml | kubectl apply -f -

# Install the Dapr control plane
helm upgrade --install dapr dapr/dapr \
  --version "${DAPR_VERSION}" \
  --namespace dapr-system \
  --set global.ha.enabled=true \
  --set dapr_operator.replicaCount=3 \
  --set dapr_placement.replicaCount=3 \
  --set dapr_sentry.replicaCount=3 \
  --set dapr_sidecar_injector.replicaCount=3 \
  --set global.logLevel=info \
  --set global.prometheus.enabled=true \
  --set global.prometheus.port=9090 \
  --set global.metrics.enabled=true \
  --set dapr_dashboard.enabled=true \
  --wait

echo "Dapr control plane installed"
kubectl get pods -n dapr-system
```

For a complete values file with resource limits suitable for production:

```yaml
# dapr-values.yaml
global:
  ha:
    enabled: true
  logLevel: info
  logAsJson: true
  prometheus:
    enabled: true
    port: 9090
  metrics:
    enabled: true
  imagePullPolicy: IfNotPresent
  mtls:
    enabled: true
    workloadCertTTL: 24h
    allowedClockSkew: 15m

dapr_operator:
  replicaCount: 3
  resources:
    limits:
      cpu: 1000m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 128Mi
  podDisruptionBudget:
    minAvailable: 2

dapr_sidecar_injector:
  replicaCount: 3
  resources:
    limits:
      cpu: 1000m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 128Mi
  podDisruptionBudget:
    minAvailable: 2
  webhookFailurePolicy: Ignore

dapr_sentry:
  replicaCount: 3
  resources:
    limits:
      cpu: 500m
      memory: 256Mi
    requests:
      cpu: 50m
      memory: 64Mi
  podDisruptionBudget:
    minAvailable: 2

dapr_placement:
  replicaCount: 3
  resources:
    limits:
      cpu: 500m
      memory: 256Mi
    requests:
      cpu: 50m
      memory: 64Mi
  podDisruptionBudget:
    minAvailable: 2

dapr_dashboard:
  enabled: true
  replicaCount: 1
  resources:
    limits:
      cpu: 200m
      memory: 128Mi
    requests:
      cpu: 50m
      memory: 32Mi
```

### Dapr CLI Installation and Basic Usage

```bash
# Install the Dapr CLI
wget -q https://raw.githubusercontent.com/dapr/cli/master/install/install.sh -O - | /bin/bash

# Initialize on an existing Kubernetes cluster (no control plane install)
dapr init -k --wait

# List all Dapr-enabled applications
dapr list -k

# Check the status of the control plane
dapr status -k

# View logs from a specific application's sidecar
dapr logs -k -a order-service -n production

# Open the Dapr Dashboard
dapr dashboard -k -p 8080
```

## Building Blocks in Depth

### Service Invocation

The **service invocation** building block provides name-resolution, retries, mTLS, and distributed tracing for synchronous service-to-service calls without any service discovery code in the application.

```bash
# HTTP call from app-a to app-b using the Dapr HTTP API
# The sidecar resolves "order-service" via the Dapr name registry
curl http://localhost:3500/v1.0/invoke/order-service/method/orders \
  -H "Content-Type: application/json" \
  -d '{"customerId": "c-123", "items": [{"sku": "A100", "qty": 2}]}'

# Using the gRPC API from Go
```

```go
// main.go — gRPC service invocation from Go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	dapr "github.com/dapr/go-sdk/client"
)

type Order struct {
	CustomerID string `json:"customerId"`
	Amount     float64 `json:"amount"`
}

func invokeOrderService(ctx context.Context) error {
	client, err := dapr.NewClient()
	if err != nil {
		return fmt.Errorf("failed to create Dapr client: %w", err)
	}
	defer client.Close()

	order := Order{CustomerID: "c-123", Amount: 49.99}
	data, err := json.Marshal(order)
	if err != nil {
		return err
	}

	resp, err := client.InvokeMethod(ctx, "order-service", "orders", "post")
	if err != nil {
		return fmt.Errorf("invocation failed: %w", err)
	}
	_ = data
	log.Printf("Response: %s", resp)
	return nil
}
```

### State Management

The **state management** building block provides a key-value API backed by configurable stores (Redis, PostgreSQL, Cosmos DB, DynamoDB, Cassandra, and more).

```yaml
# Component CRD — Redis state store
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
  namespace: production
spec:
  type: state.redis
  version: v1
  metadata:
    - name: redisHost
      value: "redis-master.redis.svc.cluster.local:6379"
    - name: redisPassword
      secretKeyRef:
        name: redis-secret
        key: redis-password
    - name: actorStateStore
      value: "true"
    - name: enableTLS
      value: "false"
    - name: maxRetries
      value: "3"
    - name: maxRetryBackoff
      value: "2s"
    - name: ttlInSeconds
      value: "3600"
    - name: keyPrefix
      value: "name"
auth:
  secretStore: kubernetes
```

```yaml
# Component CRD — PostgreSQL state store (alternative)
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore-pg
  namespace: production
spec:
  type: state.postgresql
  version: v1
  metadata:
    - name: connectionString
      secretKeyRef:
        name: postgres-secret
        key: connection-string
    - name: tableName
      value: dapr_state
    - name: schemaName
      value: public
    - name: cleanupIntervalInSeconds
      value: "300"
    - name: maxConns
      value: "20"
    - name: connMaxIdleTime
      value: "5m"
auth:
  secretStore: kubernetes
```

```go
// State management operations in Go
package main

import (
	"context"
	"fmt"
	"log"

	dapr "github.com/dapr/go-sdk/client"
)

const storeName = "statestore"

type CartItem struct {
	SKU      string  `json:"sku"`
	Quantity int     `json:"quantity"`
	Price    float64 `json:"price"`
}

func stateOperations(ctx context.Context) {
	client, err := dapr.NewClient()
	if err != nil {
		log.Fatalf("failed to create client: %v", err)
	}
	defer client.Close()

	// Save state
	item := &CartItem{SKU: "A100", Quantity: 2, Price: 9.99}
	if err := client.SaveState(ctx, storeName, "cart:user-456", item, nil); err != nil {
		log.Fatalf("save state: %v", err)
	}

	// Get state
	result, err := client.GetState(ctx, storeName, "cart:user-456", nil)
	if err != nil {
		log.Fatalf("get state: %v", err)
	}
	fmt.Printf("State: %s\n", result.Value)

	// Transactional state (multi-operation)
	ops := []*dapr.StateOperation{
		{
			Type: dapr.StateOperationTypeUpsert,
			Item: &dapr.SetStateItem{
				Key:   "cart:user-456",
				Value: []byte(`{"sku":"A100","quantity":3,"price":9.99}`),
			},
		},
		{
			Type: dapr.StateOperationTypeDelete,
			Item: &dapr.SetStateItem{
				Key: "cart:user-old",
			},
		},
	}
	if err := client.ExecuteStateTransaction(ctx, storeName, nil, ops); err != nil {
		log.Fatalf("transaction: %v", err)
	}

	// Query state (with supported stores)
	queryStr := `{"filter":{"EQ":{"sku":"A100"}},"sort":[{"key":"quantity","order":"DESC"}],"page":{"limit":10}}`
	queryResult, err := client.QueryStateAlpha1(ctx, storeName, queryStr, nil)
	if err != nil {
		log.Fatalf("query: %v", err)
	}
	fmt.Printf("Query results: %d items\n", len(queryResult.Results))
}
```

### Publish and Subscribe

The **pub/sub** building block decouples producers from consumers using a message broker component. Kafka, Redis Streams, Azure Service Bus, AWS SNS/SQS, GCP Pub/Sub, and NATS JetStream are all supported.

```yaml
# Component CRD — Kafka pub/sub
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: kafka-pubsub
  namespace: production
spec:
  type: pubsub.kafka
  version: v1
  metadata:
    - name: brokers
      value: "kafka-broker-0.kafka-headless.kafka.svc.cluster.local:9092,kafka-broker-1.kafka-headless.kafka.svc.cluster.local:9092,kafka-broker-2.kafka-headless.kafka.svc.cluster.local:9092"
    - name: consumerGroup
      value: order-processing
    - name: authType
      value: "none"
    - name: initialOffset
      value: "newest"
    - name: maxMessageBytes
      value: "1048576"
    - name: ackWaitTime
      value: "30s"
    - name: replicationFactor
      value: "3"
```

```yaml
# Subscription CRD — declarative subscription
apiVersion: dapr.io/v2alpha1
kind: Subscription
metadata:
  name: orders-subscription
  namespace: production
spec:
  topic: orders
  routes:
    rules:
      - match: event.type == "order.created"
        path: /orders/created
      - match: event.type == "order.cancelled"
        path: /orders/cancelled
    default: /orders/unknown
  pubsubname: kafka-pubsub
  deadLetterTopic: orders-dlq
  bulkSubscribe:
    enabled: true
    maxMessagesCount: 100
    maxAwaitDurationMs: 1000
scopes:
  - order-processor
  - audit-service
```

```go
// HTTP handler registering pub/sub subscriptions programmatically
package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/dapr/go-sdk/service/common"
	daprd "github.com/dapr/go-sdk/service/http"
)

type OrderEvent struct {
	OrderID    string  `json:"orderId"`
	CustomerID string  `json:"customerId"`
	Amount     float64 `json:"amount"`
}

func main() {
	s := daprd.NewService(":6001")

	sub := &common.Subscription{
		PubsubName: "kafka-pubsub",
		Topic:      "orders",
		Route:      "/orders",
		Metadata:   map[string]string{"rawPayload": "false"},
	}

	if err := s.AddTopicEventHandler(sub, handleOrder); err != nil {
		log.Fatalf("add topic handler: %v", err)
	}

	if err := s.Start(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("start service: %v", err)
	}
}

func handleOrder(ctx interface{}, e *common.TopicEvent) (retry bool, err error) {
	var order OrderEvent
	if err := json.Unmarshal(e.RawData, &order); err != nil {
		log.Printf("unmarshal error: %v — not retrying", err)
		return false, nil
	}
	log.Printf("Processing order %s for customer %s: $%.2f", order.OrderID, order.CustomerID, order.Amount)
	// business logic here
	return false, nil
}
```

### Input and Output Bindings

**Bindings** allow applications to trigger on external events (input) or invoke external systems (output) without SDK coupling.

```yaml
# Output binding — write to PostgreSQL
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: postgres-binding
  namespace: production
spec:
  type: bindings.postgresql
  version: v1
  metadata:
    - name: url
      secretKeyRef:
        name: postgres-secret
        key: url
    - name: maxConns
      value: "10"
auth:
  secretStore: kubernetes
---
# Input binding — cron schedule trigger
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: every-5-minutes
  namespace: production
spec:
  type: bindings.cron
  version: v1
  metadata:
    - name: schedule
      value: "@every 5m"
---
# Input binding — Kafka topic as a binding
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: payment-events-binding
  namespace: production
spec:
  type: bindings.kafka
  version: v1
  metadata:
    - name: topics
      value: "payment-events"
    - name: brokers
      value: "kafka-broker-0.kafka-headless.kafka.svc.cluster.local:9092"
    - name: consumerGroup
      value: payment-processor
    - name: authType
      value: "none"
```

## Actors Building Block

The **Actors** building block implements the virtual actor pattern. An actor is a unit of compute and state that executes sequentially, eliminating concurrency concerns within a single actor instance.

```go
// actor.go — order actor with timer and reminder
package actors

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/dapr/go-sdk/actor"
	"github.com/dapr/go-sdk/actor/config"
)

type OrderState struct {
	OrderID    string    `json:"orderId"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type OrderActor struct {
	actor.ServerImplBase
}

func (a *OrderActor) Type() string {
	return "OrderActor"
}

func (a *OrderActor) Init() config.Config {
	return config.Config{
		ReentrancyConfig: config.ReentrancyConfig{
			Enabled: true,
		},
	}
}

func (a *OrderActor) GetState(ctx context.Context) (*OrderState, error) {
	var state OrderState
	data, err := a.GetStateManager().Get(ctx, "orderState", &state)
	if err != nil {
		return nil, fmt.Errorf("get state: %w", err)
	}
	_ = data
	return &state, nil
}

func (a *OrderActor) UpdateStatus(ctx context.Context, newStatus string) error {
	state, err := a.GetState(ctx)
	if err != nil {
		return err
	}
	state.Status = newStatus
	state.UpdatedAt = time.Now()

	if err := a.GetStateManager().Set(ctx, "orderState", state); err != nil {
		return fmt.Errorf("set state: %w", err)
	}
	return nil
}

func (a *OrderActor) ProcessPayment(ctx context.Context, req json.RawMessage) (json.RawMessage, error) {
	// Payment processing logic
	if err := a.UpdateStatus(ctx, "payment_processing"); err != nil {
		return nil, err
	}

	// Register a reminder so the payment is checked even if the actor deactivates
	if err := a.RegisterActorReminder(ctx, "payment-timeout", nil, 30*time.Minute, 0); err != nil {
		return nil, fmt.Errorf("register reminder: %w", err)
	}

	resp, _ := json.Marshal(map[string]string{"status": "accepted"})
	return resp, nil
}

func (a *OrderActor) ReminderCall(reminderName string, state []byte, dueTime string, period string) {
	ctx := context.Background()
	if reminderName == "payment-timeout" {
		_ = a.UpdateStatus(ctx, "payment_timeout")
	}
}
```

## Workflow Building Block

The **Workflow** building block (GA in Dapr 1.11+) provides durable, resumable workflow execution using an activity-function model similar to Azure Durable Functions.

```go
// workflow.go — order fulfillment workflow in Go
package workflow

import (
	"context"
	"fmt"
	"time"

	"github.com/dapr/durabletask-go/task"
	"github.com/dapr/go-sdk/workflow"
)

type OrderInput struct {
	OrderID    string   `json:"orderId"`
	CustomerID string   `json:"customerId"`
	Items      []Item   `json:"items"`
	TotalAmount float64 `json:"totalAmount"`
}

type Item struct {
	SKU string `json:"sku"`
	Qty int    `json:"qty"`
}

// OrderFulfillmentWorkflow orchestrates the order lifecycle
func OrderFulfillmentWorkflow(ctx *workflow.WorkflowContext) (any, error) {
	var input OrderInput
	if err := ctx.GetInput(&input); err != nil {
		return nil, err
	}

	// Step 1: Reserve inventory with retry on failure
	var inventoryResult bool
	if err := ctx.CallActivity(ReserveInventory, workflow.ActivityInput(input.Items)).
		Await(&inventoryResult); err != nil {
		return nil, fmt.Errorf("inventory reservation failed: %w", err)
	}
	if !inventoryResult {
		return nil, fmt.Errorf("insufficient inventory for order %s", input.OrderID)
	}

	// Step 2: Process payment (fan-out)
	paymentCtx := ctx.CreateTimer(5 * time.Minute)
	paymentTask := ctx.CallActivity(ProcessPayment, workflow.ActivityInput(map[string]any{
		"orderId": input.OrderID,
		"amount":  input.TotalAmount,
	}))

	if idx, err := workflow.WhenAny(ctx, paymentTask, paymentCtx); err != nil {
		return nil, err
	} else if idx == 1 {
		// Timer fired — payment timed out
		_ = ctx.CallActivity(ReleaseInventory, workflow.ActivityInput(input.Items))
		return nil, fmt.Errorf("payment timeout for order %s", input.OrderID)
	}

	// Step 3: Dispatch shipping
	if err := ctx.CallActivity(DispatchShipping, workflow.ActivityInput(input)).
		Await(nil); err != nil {
		return nil, fmt.Errorf("shipping dispatch failed: %w", err)
	}

	// Step 4: Send confirmation
	if err := ctx.CallActivity(SendConfirmation, workflow.ActivityInput(input)).
		Await(nil); err != nil {
		// Non-critical: log but do not fail
		fmt.Printf("confirmation email failed for order %s: %v\n", input.OrderID, err)
	}

	return map[string]string{"status": "fulfilled", "orderId": input.OrderID}, nil
}

func ReserveInventory(ctx task.ActivityContext) (any, error) {
	var items []Item
	if err := ctx.GetInput(&items); err != nil {
		return false, err
	}
	// Inventory system call
	return true, nil
}

func ProcessPayment(ctx task.ActivityContext) (any, error) {
	var req map[string]any
	if err := ctx.GetInput(&req); err != nil {
		return nil, err
	}
	// Payment gateway call
	return map[string]string{"transactionId": "txn-abc"}, nil
}

func DispatchShipping(ctx task.ActivityContext) (any, error) {
	return nil, nil
}

func ReleaseInventory(ctx task.ActivityContext) (any, error) {
	return nil, nil
}

func SendConfirmation(ctx task.ActivityContext) (any, error) {
	return nil, nil
}

// WorkflowMain registers and starts the workflow worker
func WorkflowMain() error {
	w, err := workflow.NewWorker()
	if err != nil {
		return fmt.Errorf("create worker: %w", err)
	}
	if err := w.RegisterWorkflow(OrderFulfillmentWorkflow); err != nil {
		return err
	}
	if err := w.RegisterActivity(ReserveInventory); err != nil {
		return err
	}
	if err := w.RegisterActivity(ProcessPayment); err != nil {
		return err
	}
	if err := w.RegisterActivity(DispatchShipping); err != nil {
		return err
	}
	if err := w.RegisterActivity(ReleaseInventory); err != nil {
		return err
	}
	if err := w.RegisterActivity(SendConfirmation); err != nil {
		return err
	}
	return w.Start()
}
```

## Secrets Management

```yaml
# Component CRD — Kubernetes secrets store
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: kubernetes
  namespace: production
spec:
  type: secretstores.kubernetes
  version: v1
---
# Component CRD — HashiCorp Vault secrets store
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: vault
  namespace: production
spec:
  type: secretstores.hashicorp.vault
  version: v1
  metadata:
    - name: vaultAddr
      value: "https://vault.vault.svc.cluster.local:8200"
    - name: skipVerify
      value: "false"
    - name: tlsServerName
      value: "vault.vault.svc.cluster.local"
    - name: vaultKVPrefix
      value: "dapr"
    - name: vaultKVUsePrefix
      value: "true"
    - name: enginePath
      value: "secret"
    - name: vaultValueType
      value: "map"
    - name: vaultTokenMountPath
      value: "/var/run/secrets/vault/token"
    - name: vaultCACertPath
      value: "/var/run/secrets/vault/ca.crt"
```

```go
// Reading secrets from the Dapr secrets API
package main

import (
	"context"
	"fmt"
	"log"

	dapr "github.com/dapr/go-sdk/client"
)

func getDBCredentials(ctx context.Context) (string, string, error) {
	client, err := dapr.NewClient()
	if err != nil {
		return "", "", err
	}
	defer client.Close()

	// Retrieve the entire secret
	secret, err := client.GetSecret(ctx, "kubernetes", "db-credentials", nil)
	if err != nil {
		return "", "", fmt.Errorf("get secret: %w", err)
	}

	username := secret["username"]
	password := secret["password"]
	return username, password, nil
}

func getBulkSecrets(ctx context.Context) error {
	client, err := dapr.NewClient()
	if err != nil {
		return err
	}
	defer client.Close()

	secrets, err := client.GetBulkSecret(ctx, "vault", nil)
	if err != nil {
		return err
	}
	for name, values := range secrets {
		log.Printf("Secret %s has %d keys", name, len(values))
	}
	return nil
}
```

## Configuration API

The **Configuration** building block provides a watch-capable API on top of configuration stores (Redis, Azure App Configuration, GCP Runtime Config).

```yaml
# Component CRD — Redis configuration store
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: configstore
  namespace: production
spec:
  type: configuration.redis
  version: v1
  metadata:
    - name: redisHost
      value: "redis-master.redis.svc.cluster.local:6379"
    - name: redisPassword
      secretKeyRef:
        name: redis-secret
        key: redis-password
    - name: enableTLS
      value: "false"
```

```go
// Watch for configuration changes
package main

import (
	"context"
	"fmt"
	"log"

	dapr "github.com/dapr/go-sdk/client"
)

func watchConfig(ctx context.Context) {
	client, err := dapr.NewClient()
	if err != nil {
		log.Fatalf("create client: %v", err)
	}
	defer client.Close()

	keys := []string{"featureFlags.newCheckout", "rateLimits.requestsPerSecond", "circuit.threshold"}
	subscriptionID, err := client.SubscribeConfigurationItems(ctx, "configstore", keys,
		func(id string, items map[string]*dapr.ConfigurationItem) {
			for k, v := range items {
				fmt.Printf("Config changed — key=%s value=%s version=%s\n", k, v.Value, v.Version)
			}
		},
	)
	if err != nil {
		log.Fatalf("subscribe config: %v", err)
	}
	defer func() {
		_ = client.UnsubscribeConfigurationItems(ctx, "configstore", subscriptionID)
	}()

	// Block until context is cancelled
	<-ctx.Done()
}
```

## Resiliency Policies

**Resiliency** CRDs define retry, circuit breaker, and timeout policies that the sidecar applies to all outbound calls from a given app.

```yaml
# Resiliency CRD — comprehensive policy
apiVersion: dapr.io/v1alpha1
kind: Resiliency
metadata:
  name: order-service-resiliency
  namespace: production
spec:
  policies:
    # Retry policies
    retries:
      standard-retry:
        policy: constant
        duration: 2s
        maxRetries: 3
      exponential-retry:
        policy: exponential
        initialInterval: 100ms
        maxInterval: 10s
        maxRetries: 5
        retryableStatusCodes:
          - "429"
          - "500"
          - "502"
          - "503"
          - "504"
      no-retry:
        policy: constant
        duration: 0s
        maxRetries: 0

    # Timeout policies
    timeouts:
      fast: 500ms
      default: 5s
      slow: 30s
      async: 60s

    # Circuit breaker policies
    circuitBreakers:
      shared-cb:
        maxRequests: 1
        interval: 30s
        timeout: 60s
        trip: consecutiveFailures >= 5
      strict-cb:
        maxRequests: 1
        interval: 10s
        timeout: 30s
        trip: consecutiveFailures >= 3

  targets:
    # Apply policies to specific app invocations
    apps:
      payment-service:
        timeout: slow
        retry: exponential-retry
        circuitBreaker: shared-cb

      inventory-service:
        timeout: default
        retry: standard-retry
        circuitBreaker: shared-cb

      notification-service:
        timeout: fast
        retry: no-retry

    # Apply policies to components
    components:
      statestore:
        outbound:
          timeout: default
          retry: exponential-retry
          circuitBreaker: strict-cb

      kafka-pubsub:
        outbound:
          timeout: slow
          retry: standard-retry
```

## Namespace Isolation and Multi-App Environments

```yaml
# Dapr Configuration CRD — app-level settings per namespace
apiVersion: dapr.io/v1alpha1
kind: Configuration
metadata:
  name: app-config
  namespace: production
spec:
  tracing:
    samplingRate: "1"
    zipkin:
      endpointAddress: "http://jaeger-collector.observability.svc.cluster.local:9411/api/v2/spans"
  metric:
    enabled: true
    rules:
      - labels:
          - name: app_id
        regex:
          - "order-.*"
  api:
    allowed:
      - name: state
        version: v1
        protocol: http
      - name: invoke
        version: v1
        protocol: grpc
      - name: pubsub
        version: v1
        protocol: http
      - name: secrets
        version: v1
        protocol: http
  accessControl:
    defaultAction: deny
    trustDomain: "production.dapr.example.com"
    policies:
      - appId: inventory-service
        defaultAction: allow
        namespace: production
        operations:
          - name: /inventory/reserve
            httpVerb: ["POST"]
            action: allow
      - appId: payment-service
        defaultAction: deny
        namespace: production
        operations:
          - name: /payments/process
            httpVerb: ["POST"]
            action: allow
```

Annotate pods to enroll them in Dapr:

```yaml
# Deployment with Dapr annotations
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
      annotations:
        dapr.io/enabled: "true"
        dapr.io/app-id: "order-service"
        dapr.io/app-port: "6001"
        dapr.io/app-protocol: "http"
        dapr.io/config: "app-config"
        dapr.io/log-level: "info"
        dapr.io/enable-metrics: "true"
        dapr.io/metrics-port: "9090"
        dapr.io/sidecar-cpu-request: "50m"
        dapr.io/sidecar-memory-request: "64Mi"
        dapr.io/sidecar-cpu-limit: "500m"
        dapr.io/sidecar-memory-limit: "256Mi"
        dapr.io/app-max-concurrency: "50"
        dapr.io/http-max-request-size: "16"
        dapr.io/graceful-shutdown-seconds: "30"
    spec:
      containers:
        - name: order-service
          image: registry.example.com/order-service:2.3.1
          ports:
            - containerPort: 6001
          env:
            - name: DAPR_HTTP_PORT
              value: "3500"
            - name: DAPR_GRPC_PORT
              value: "50001"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 1000m
              memory: 512Mi
```

## Observability with OpenTelemetry

```yaml
# Dapr Configuration — OpenTelemetry collector integration
apiVersion: dapr.io/v1alpha1
kind: Configuration
metadata:
  name: otel-config
  namespace: production
spec:
  tracing:
    samplingRate: "0.1"
    otel:
      endpointAddress: "otel-collector.observability.svc.cluster.local:4317"
      isSecure: false
      protocol: grpc
  metric:
    enabled: true
    latencyDistributionBuckets: [1, 2, 3, 4, 5, 6, 8, 10, 13, 16, 20, 25, 30, 40, 50, 65, 80, 100, 130, 160, 200, 250, 300, 400, 500, 650, 800, 1000, 2000, 5000, 10000, 100000, 1000000]
---
# ServiceMonitor for Prometheus scraping of Dapr sidecars
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: dapr-sidecar-metrics
  namespace: monitoring
  labels:
    release: kube-prometheus
spec:
  namespaceSelector:
    any: true
  selector:
    matchLabels:
      dapr.io/metrics: "true"
  endpoints:
    - port: dapr-metrics
      path: /metrics
      interval: 15s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_annotation_dapr_io_app_id]
          targetLabel: dapr_app_id
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
```

Grafana dashboard queries for Dapr metrics:

```promql
# Service invocation latency p99
histogram_quantile(0.99,
  sum(rate(dapr_http_server_request_latency_ms_bucket{namespace="production"}[5m]))
  by (app_id, method, le)
)

# Actor activation rate
sum(rate(dapr_actor_activations_total{namespace="production"}[5m])) by (actor_type)

# State store operation errors
sum(rate(dapr_component_operation_duration_ms_count{success="false",component_type=~"state.*"}[5m]))
by (app_id, component, operation)

# Pub/sub message processing rate
sum(rate(dapr_pubsub_incoming_messages_total{namespace="production"}[5m])) by (app_id, topic)
```

## Dapr vs Service Mesh Comparison

| Capability | Dapr | Istio/Linkerd |
|---|---|---|
| Service-to-service calls | Building block API | Transparent proxy |
| mTLS | Built-in via Sentry | Built-in |
| Observability | Sidecar metrics + OTel | Sidecar metrics |
| State management | Yes (Redis, PG, Cosmos) | No |
| Pub/sub messaging | Yes (Kafka, Redis, etc.) | No |
| Secret management | Yes (K8s, Vault, etc.) | No |
| Actors / Workflow | Yes | No |
| Traffic splitting | Limited (via bindings) | Full (VirtualService) |
| L7 routing | Limited | Full |
| Protocol support | HTTP, gRPC | HTTP, gRPC, TCP |
| Language requirement | Any (HTTP/gRPC) | Transparent |

Dapr and a service mesh are **complementary** rather than competing. Run Istio or Cilium for L7 traffic management and network policies, and layer Dapr on top for application-level building blocks.

## Production Sizing Guidelines

```yaml
# Resource sizing by cluster scale

# Small cluster (< 50 Dapr-enabled pods)
# daprd sidecar per pod:
#   CPU request: 50m  CPU limit: 200m
#   Memory request: 64Mi  Memory limit: 128Mi
# Control plane:
#   dapr-operator: 1 replica, 100m/128Mi
#   dapr-sentry:   1 replica, 50m/64Mi
#   dapr-placement: 1 replica, 50m/64Mi

# Medium cluster (50–500 pods)
# daprd sidecar per pod:
#   CPU request: 100m  CPU limit: 500m
#   Memory request: 128Mi  Memory limit: 256Mi
# Control plane (HA):
#   dapr-operator: 3 replicas, 200m/256Mi each
#   dapr-sentry:   3 replicas, 100m/128Mi each
#   dapr-placement: 3 replicas, 100m/128Mi each

# Large cluster (500+ pods)
# daprd sidecar per pod:
#   CPU request: 200m  CPU limit: 1000m
#   Memory request: 256Mi  Memory limit: 512Mi
# Control plane (HA):
#   dapr-operator: 3 replicas, 500m/512Mi each
#   dapr-sentry:   3 replicas, 200m/256Mi each
#   dapr-placement: 5 replicas, 200m/256Mi each
#   (placement requires odd count for Raft quorum)
```

### Horizontal Scaling Considerations

```bash
# Enable HPA for Dapr control plane components
kubectl autoscale deployment dapr-operator \
  --namespace dapr-system \
  --min=3 --max=10 \
  --cpu-percent=70

kubectl autoscale deployment dapr-sidecar-injector \
  --namespace dapr-system \
  --min=3 --max=10 \
  --cpu-percent=70

# Check sidecar injection webhook configuration
kubectl get mutatingwebhookconfigurations dapr-sidecar-injector \
  -o jsonpath='{.webhooks[0].failurePolicy}'
```

## Troubleshooting Common Issues

```bash
#!/bin/bash
# Dapr diagnostics script

# List all Dapr-enabled apps in a namespace
dapr list -k -n production

# Check a specific app's sidecar logs
dapr logs -k -a order-service -n production --tail 200

# Verify component health
dapr components -k -n production

# Check configuration CRDs
kubectl get configurations.dapr.io -n production
kubectl get resiliency.dapr.io -n production
kubectl get subscriptions.dapr.io -n production

# Inspect a component status
kubectl get component statestore -n production -o yaml

# Diagnose sidecar injection
kubectl describe pod order-service-abc123 -n production | grep -A 20 "Annotations:"

# Port-forward to a specific app's Dapr sidecar for direct API inspection
kubectl port-forward pod/order-service-abc123 3500:3500 -n production &
curl http://localhost:3500/v1.0/healthz
curl http://localhost:3500/v1.0/metadata

# Check placement service for actor distribution
kubectl logs -n dapr-system deployment/dapr-placement --tail 100 | grep -i "host\|table"

# Verify mTLS certificate chain
kubectl logs -n dapr-system deployment/dapr-sentry --tail 100 | grep -i "cert\|sign\|error"
```

## Summary

Dapr provides a comprehensive, portable platform for building distributed applications on Kubernetes. The building-block model—service invocation, state management, pub/sub, bindings, actors, workflows, secrets, and configuration—eliminates the need for each microservice to implement its own distributed-systems boilerplate. Resiliency policies enforce consistent retry and circuit-breaker behavior across the entire fleet from a single CRD, while OpenTelemetry integration surfaces sidecar telemetry into existing observability stacks. For enterprise environments, Dapr and a service mesh form a complementary stack where the mesh handles network-level concerns and Dapr handles application-level concerns, together providing full-stack reliability, observability, and portability.
