---
title: "Temporal: Durable Workflow Orchestration on Kubernetes"
date: 2027-01-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Temporal", "Workflow", "Microservices", "Reliability"]
categories: ["Kubernetes", "DevOps", "Microservices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for deploying Temporal workflow orchestration on Kubernetes. Covers architecture (frontend, history, matching, worker), Go SDK workflow patterns, retry policies, signals, child workflows, namespace isolation, PostgreSQL persistence, monitoring, and operational runbooks."
more_link: "yes"
url: "/temporal-workflow-orchestration-kubernetes-production-guide/"
---

Distributed microservice architectures expose a fundamental reliability problem: multi-step business processes that span multiple services have no reliable way to handle partial failures, retries, and long-running state without building complex, bespoke state machines. **Temporal** solves this by making workflow execution durable — if a worker crashes mid-execution, Temporal replays the workflow from the event history and resumes exactly where it left off, with no data loss and no code changes required in the application. This guide covers deploying Temporal on Kubernetes, writing production-grade Go workflows, and operating the cluster reliably.

<!--more-->

## Executive Summary

**Temporal** is an open-source durable workflow orchestration platform that persists every workflow event to a relational database (PostgreSQL or Cassandra). Application code runs in **Workers** — plain Go (or Java/Python/TypeScript) processes that execute workflow functions and **Activity** functions. The Temporal server itself never executes business logic; it only manages task queues, event history, timers, and scheduling. This separation means business logic is version-controlled in application code while durability guarantees come from the server infrastructure. This guide builds a production cluster on Kubernetes with PostgreSQL persistence, mutual TLS, namespace isolation, and a complete Go SDK example.

## Temporal Architecture

### Server Components

```
                    ┌─────────────────────────────────────────────┐
                    │              Temporal Server                  │
                    │                                              │
  SDK Workers ─────►│  ┌──────────────┐  ┌──────────────────────┐ │
  tctl/UI           │  │   Frontend   │  │   History Service    │ │
  ─────────────────►│  │  (gRPC/HTTP) │  │  (event sourcing)    │ │
                    │  └──────┬───────┘  └──────────┬───────────┘ │
                    │         │                      │             │
                    │  ┌──────▼───────┐  ┌──────────▼───────────┐ │
                    │  │   Matching   │  │     Worker Service    │ │
                    │  │  (task Q)    │  │    (internal tasks)   │ │
                    │  └──────────────┘  └──────────────────────┘ │
                    └─────────────────────────────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────────┐
                    │              PostgreSQL                       │
                    │   executions, history_events, task_queues    │
                    └─────────────────────────────────────────────┘
```

### Component Responsibilities

| Service | Role |
|---|---|
| **Frontend** | gRPC API gateway; routes requests to internal services; rate limiting |
| **History** | Owns workflow execution state; persists event history; manages timers |
| **Matching** | Routes tasks to available workers via task queues (long-polling) |
| **Worker** | Internal background tasks: archival, replication, cross-cluster transfers |

### Workflow Concepts

- **Workflow**: A durable function that orchestrates activities. Workflow code must be **deterministic** — no direct I/O, random numbers, or time calls.
- **Activity**: A function that performs side effects (HTTP calls, DB writes, file operations). Activities can fail and are retried by Temporal.
- **Task Queue**: The named queue through which the server dispatches workflow/activity tasks to workers.
- **Namespace**: Logical isolation unit — each namespace has its own task queues, workflows, and retention policy.
- **Signal**: An external event delivered asynchronously to a running workflow.
- **Query**: A synchronous read of workflow state without side effects.
- **Child Workflow**: A workflow started by a parent workflow — runs independently with its own history.

## Deploying Temporal on Kubernetes

### Prerequisites

```bash
#!/bin/bash
# deploy-temporal-prereqs.sh

# Create namespace
kubectl create namespace temporal

# Create PostgreSQL database (using existing PostgreSQL cluster or operator)
# Assuming an existing PostgreSQL instance; create the temporal database
kubectl exec -n postgres postgresql-0 -- \
  psql -U postgres -c "CREATE USER temporal WITH PASSWORD 'EXAMPLE_TEMPORAL_DB_PASSWORD';"
kubectl exec -n postgres postgresql-0 -- \
  psql -U postgres -c "CREATE DATABASE temporal OWNER temporal;"
kubectl exec -n postgres postgresql-0 -- \
  psql -U postgres -c "CREATE DATABASE temporal_visibility OWNER temporal;"

# Create DB credentials secret
kubectl create secret generic temporal-db-credentials \
  --namespace temporal \
  --from-literal=username=temporal \
  --from-literal=password="EXAMPLE_TEMPORAL_DB_PASSWORD"
```

### Helm Deployment

```bash
#!/bin/bash
# install-temporal.sh

helm repo add temporal https://go.temporal.io/helm-charts
helm repo update

helm upgrade --install temporal temporal/temporal \
  --namespace temporal \
  --version 0.54.0 \
  --values temporal-values.yaml \
  --wait \
  --timeout 10m
```

### Production Helm Values

```yaml
# temporal-values.yaml
server:
  image:
    repository: temporalio/server
    tag: 1.24.2
    pullPolicy: IfNotPresent

  # Frontend service
  frontend:
    replicas: 2
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi
    service:
      type: ClusterIP
      port: 7233
    affinity:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: frontend
          topologyKey: kubernetes.io/hostname

  # History service
  history:
    replicas: 3
    resources:
      requests:
        cpu: 1000m
        memory: 1Gi
      limits:
        cpu: 4000m
        memory: 4Gi
    # numHistoryShards: must match the value in the DB schema (cannot change after init)
    config:
      numHistoryShards: 512

  # Matching service
  matching:
    replicas: 2
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi

  # Worker service (internal)
  worker:
    replicas: 1
    resources:
      requests:
        cpu: 250m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 1Gi

  config:
    logLevel: info
    numHistoryShards: 512
    persistence:
      defaultStore: postgres
      visibilityStore: postgres-visibility
      numHistoryShards: 512
      datastores:
        postgres:
          sql:
            pluginName: postgres12
            databaseName: temporal
            connectAddr: postgres.postgres.svc.cluster.local:5432
            connectProtocol: tcp
            user: temporal
            existingSecret: temporal-db-credentials
            maxConns: 20
            maxIdleConns: 20
            maxConnLifetime: 1h
            tls:
              enabled: true
              caFile: /etc/ssl/certs/ca-bundle.crt
              enableHostVerification: true
        postgres-visibility:
          sql:
            pluginName: postgres12
            databaseName: temporal_visibility
            connectAddr: postgres.postgres.svc.cluster.local:5432
            connectProtocol: tcp
            user: temporal
            existingSecret: temporal-db-credentials
            maxConns: 10
            maxIdleConns: 10
            maxConnLifetime: 1h

# Web UI
web:
  enabled: true
  image:
    repository: temporalio/ui
    tag: 2.26.2
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi
  ingress:
    enabled: true
    className: nginx
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
    hosts:
    - host: temporal.example.com
      paths:
      - path: /
        pathType: Prefix
    tls:
    - secretName: temporal-ui-tls
      hosts:
      - temporal.example.com

# Admin tools (tctl, temporal CLI)
admintools:
  enabled: true
  image:
    repository: temporalio/admin-tools
    tag: 1.24.2

# Prometheus ServiceMonitor
prometheus:
  serviceMonitor:
    enabled: true
    namespace: monitoring
    labels:
      release: kube-prometheus-stack
    interval: 30s
```

### Schema Migration Job

```yaml
# temporal-schema-migration.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: temporal-schema-setup
  namespace: temporal
spec:
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
      - name: wait-for-postgres
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          until nc -z postgres.postgres.svc.cluster.local 5432; do
            echo "Waiting for PostgreSQL..."
            sleep 5
          done
      containers:
      - name: schema-setup
        image: temporalio/admin-tools:1.24.2
        command:
        - sh
        - -c
        - |
          set -ex
          # Setup main schema
          temporal-sql-tool \
            --plugin postgres12 \
            --ep postgres.postgres.svc.cluster.local \
            --p 5432 \
            --db temporal \
            --u temporal \
            --pw "${DB_PASSWORD}" \
            create-database

          temporal-sql-tool \
            --plugin postgres12 \
            --ep postgres.postgres.svc.cluster.local \
            --p 5432 \
            --db temporal \
            --u temporal \
            --pw "${DB_PASSWORD}" \
            setup-schema --version 0.0

          temporal-sql-tool \
            --plugin postgres12 \
            --ep postgres.postgres.svc.cluster.local \
            --p 5432 \
            --db temporal \
            --u temporal \
            --pw "${DB_PASSWORD}" \
            update-schema \
            --schema-dir /etc/temporal/schema/postgresql/v12/temporal/versioned

          # Setup visibility schema
          temporal-sql-tool \
            --plugin postgres12 \
            --ep postgres.postgres.svc.cluster.local \
            --p 5432 \
            --db temporal_visibility \
            --u temporal \
            --pw "${DB_PASSWORD}" \
            create-database

          temporal-sql-tool \
            --plugin postgres12 \
            --ep postgres.postgres.svc.cluster.local \
            --p 5432 \
            --db temporal_visibility \
            --u temporal \
            --pw "${DB_PASSWORD}" \
            setup-schema --version 0.0

          temporal-sql-tool \
            --plugin postgres12 \
            --ep postgres.postgres.svc.cluster.local \
            --p 5432 \
            --db temporal_visibility \
            --u temporal \
            --pw "${DB_PASSWORD}" \
            update-schema \
            --schema-dir /etc/temporal/schema/postgresql/v12/visibility/versioned

          echo "Schema setup complete."
        env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: temporal-db-credentials
              key: password
```

## Namespace Isolation

Temporal namespaces provide logical isolation for workflows:

```bash
#!/bin/bash
# configure-namespaces.sh

# Register namespaces via tctl or temporal CLI
kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator namespace create \
    --namespace production \
    --retention 30d \
    --description "Production workflows"

kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator namespace create \
    --namespace staging \
    --retention 7d \
    --description "Staging workflows"

kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator namespace create \
    --namespace development \
    --retention 3d \
    --description "Development workflows"

# Update namespace retention
kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator namespace update \
    --namespace production \
    --retention 90d

# Describe namespace
kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator namespace describe --namespace production
```

## Go SDK — Workflow Implementation

### Project Structure

```
workflow-service/
├── go.mod
├── go.sum
├── main.go               # Worker startup
├── workflows/
│   ├── order.go          # Order processing workflow
│   └── order_test.go     # Workflow unit tests
├── activities/
│   ├── payment.go        # Payment activity
│   ├── inventory.go      # Inventory activity
│   └── notification.go   # Notification activity
└── shared/
    └── types.go          # Shared types
```

### Workflow Definition

```go
// workflows/order.go
package workflows

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/example/workflow-service/activities"
	"github.com/example/workflow-service/shared"
)

// OrderWorkflow orchestrates the complete order processing pipeline.
// It is deterministic — no direct I/O, no time.Now(), no rand calls.
func OrderWorkflow(ctx workflow.Context, order shared.Order) (shared.OrderResult, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("OrderWorkflow started", "orderID", order.ID)

	// Activity options — retry policy applies to all activities in this context
	activityOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    time.Minute,
			MaximumAttempts:    5,
			NonRetryableErrorTypes: []string{
				"InsufficientFundsError",
				"OrderAlreadyProcessedError",
			},
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOpts)

	var result shared.OrderResult

	// Step 1: Reserve inventory — idempotent, safe to retry
	var inventoryResult shared.InventoryReservation
	err := workflow.ExecuteActivity(ctx,
		activities.ReserveInventory,
		order,
	).Get(ctx, &inventoryResult)
	if err != nil {
		return result, temporal.NewApplicationError("inventory reservation failed", "InventoryError", err)
	}

	// Step 2: Process payment
	// Use a separate context with a shorter timeout for payment
	payCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			MaximumAttempts:    3,
			MaximumInterval:    30 * time.Second,
			NonRetryableErrorTypes: []string{"InsufficientFundsError"},
		},
	})

	var paymentResult shared.PaymentResult
	err = workflow.ExecuteActivity(payCtx,
		activities.ProcessPayment,
		order,
		inventoryResult,
	).Get(ctx, &paymentResult)
	if err != nil {
		// Compensate: release inventory if payment fails
		compensationCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: 5 * time.Minute,
			RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 10},
		})
		_ = workflow.ExecuteActivity(compensationCtx,
			activities.ReleaseInventory,
			inventoryResult.ReservationID,
		).Get(ctx, nil)
		return result, err
	}

	// Step 3: Fulfill order — start a child workflow for fulfillment
	// Child workflows run independently; the parent can wait or fire-and-forget
	childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
		WorkflowID:            "fulfillment-" + order.ID,
		WorkflowRunTimeout:    24 * time.Hour,
		WorkflowTaskTimeout:   10 * time.Second,
		ParentClosePolicy:     temporal.ParentClosePolicyTerminateChildWorkflows,
	})

	var fulfillmentResult shared.FulfillmentResult
	err = workflow.ExecuteChildWorkflow(childCtx,
		FulfillmentWorkflow,
		order,
		paymentResult,
	).Get(ctx, &fulfillmentResult)
	if err != nil {
		return result, temporal.NewApplicationError("fulfillment failed", "FulfillmentError", err)
	}

	// Step 4: Send notification (best-effort, not retried excessively)
	notifyCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 2},
	})
	_ = workflow.ExecuteActivity(notifyCtx,
		activities.SendOrderConfirmation,
		order,
		fulfillmentResult,
	).Get(ctx, nil)
	// Ignore notification errors — don't fail the workflow

	result = shared.OrderResult{
		OrderID:       order.ID,
		Status:        "completed",
		PaymentID:     paymentResult.PaymentID,
		FulfillmentID: fulfillmentResult.FulfillmentID,
	}

	logger.Info("OrderWorkflow completed successfully", "orderID", order.ID)
	return result, nil
}
```

### Signals and Queries

```go
// workflows/approval.go
package workflows

import (
	"time"

	"go.temporal.io/sdk/workflow"
	"github.com/example/workflow-service/shared"
)

const (
	ApprovalSignalName = "approval-signal"
	StatusQueryName    = "status-query"
)

// ApprovalWorkflow waits for a human approval signal before proceeding.
// It handles both approval and rejection via signals.
func ApprovalWorkflow(ctx workflow.Context, request shared.ApprovalRequest) (string, error) {
	logger := workflow.GetLogger(ctx)

	// Internal state tracked for Query handler
	var currentStatus = "pending"

	// Register Query handler — synchronous, read-only
	err := workflow.SetQueryHandler(ctx, StatusQueryName, func() (string, error) {
		return currentStatus, nil
	})
	if err != nil {
		return "", err
	}

	// Register Signal channel
	approvalCh := workflow.GetSignalChannel(ctx, ApprovalSignalName)

	// Wait for signal with a timeout
	var approvalDecision shared.ApprovalDecision

	timerFired := false
	timerCtx, cancelTimer := workflow.WithCancel(ctx)

	selector := workflow.NewSelector(ctx)

	// Add signal handler to selector
	selector.AddReceive(approvalCh, func(c workflow.ReceiveChannel, more bool) {
		c.Receive(ctx, &approvalDecision)
		cancelTimer()
	})

	// Add timer (auto-reject after 72 hours)
	selector.AddFuture(workflow.NewTimer(timerCtx, 72*time.Hour), func(f workflow.Future) {
		timerFired = true
	})

	selector.Select(ctx)

	if timerFired {
		currentStatus = "auto-rejected"
		logger.Info("Approval timed out", "requestID", request.ID)
		return "auto-rejected", nil
	}

	if approvalDecision.Approved {
		currentStatus = "approved"
		// Continue with the activity that requires approval
		actOpts := workflow.ActivityOptions{
			StartToCloseTimeout: 10 * time.Minute,
		}
		ctx = workflow.WithActivityOptions(ctx, actOpts)
		err = workflow.ExecuteActivity(ctx,
			ApprovedAction,
			request,
			approvalDecision,
		).Get(ctx, nil)
		if err != nil {
			return "", err
		}
		return "approved", nil
	}

	currentStatus = "rejected"
	logger.Info("Request rejected", "requestID", request.ID, "reason", approvalDecision.Reason)
	return "rejected", nil
}
```

### Activity Implementation

```go
// activities/payment.go
package activities

import (
	"context"
	"fmt"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"github.com/example/workflow-service/shared"
)

// PaymentActivities holds dependencies for payment activities.
// Activities are methods on a struct to allow dependency injection.
type PaymentActivities struct {
	PaymentGateway PaymentGatewayClient
	DB             DatabaseClient
}

// ProcessPayment charges the customer and records the transaction.
// Idempotency key ensures safe retries.
func (a *PaymentActivities) ProcessPayment(
	ctx context.Context,
	order shared.Order,
	reservation shared.InventoryReservation,
) (shared.PaymentResult, error) {
	logger := activity.GetLogger(ctx)
	info := activity.GetInfo(ctx)

	// Use the workflow ID + activity ID as idempotency key
	idempotencyKey := fmt.Sprintf("%s-%s-%d",
		info.WorkflowExecution.ID,
		info.ActivityID,
		info.Attempt,
	)

	logger.Info("Processing payment", "orderID", order.ID, "idempotencyKey", idempotencyKey)

	// Heartbeat to prevent timeout during long-running operations
	activity.RecordHeartbeat(ctx, "contacting payment gateway")

	// Check if this payment was already processed (idempotency)
	existing, err := a.DB.GetPaymentByIdempotencyKey(ctx, idempotencyKey)
	if err == nil && existing != nil {
		logger.Info("Payment already processed, returning existing result", "paymentID", existing.ID)
		return shared.PaymentResult{PaymentID: existing.ID, Status: "already_processed"}, nil
	}

	// Call payment gateway
	charge, err := a.PaymentGateway.Charge(ctx, shared.ChargeRequest{
		Amount:         order.TotalAmount,
		Currency:       order.Currency,
		CustomerID:     order.CustomerID,
		IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		// Translate gateway errors to Temporal error types
		if isInsufficientFunds(err) {
			// Non-retryable: return application error with type matching NonRetryableErrorTypes
			return shared.PaymentResult{}, temporal.NewApplicationError(
				"insufficient funds",
				"InsufficientFundsError",
				err,
			)
		}
		// All other errors are retryable (gateway timeout, network error)
		return shared.PaymentResult{}, fmt.Errorf("payment gateway error: %w", err)
	}

	return shared.PaymentResult{
		PaymentID: charge.ID,
		Status:    charge.Status,
		Amount:    charge.Amount,
	}, nil
}

func isInsufficientFunds(err error) bool {
	if err == nil {
		return false
	}
	return err.Error() == "insufficient_funds"
}
```

### Worker Startup

```go
// main.go
package main

import (
	"log"
	"os"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"

	"github.com/example/workflow-service/activities"
	"github.com/example/workflow-service/workflows"
)

func main() {
	temporalHost := getEnv("TEMPORAL_HOST", "temporal-frontend.temporal.svc.cluster.local:7233")
	namespace := getEnv("TEMPORAL_NAMESPACE", "production")
	taskQueue := getEnv("TEMPORAL_TASK_QUEUE", "order-processing")

	c, err := client.Dial(client.Options{
		HostPort:  temporalHost,
		Namespace: namespace,
		// TLS config for mTLS
		// ConnectionOptions: client.ConnectionOptions{
		//   TLS: tlsConfig,
		// },
	})
	if err != nil {
		log.Fatalf("Unable to create Temporal client: %v", err)
	}
	defer c.Close()

	// Create worker options tuned for production
	workerOpts := worker.Options{
		MaxConcurrentActivityExecutionSize:      50,
		MaxConcurrentWorkflowTaskExecutionSize:  100,
		MaxConcurrentLocalActivityExecutionSize: 20,
		// Limit poll rate to avoid overwhelming the server
		WorkerActivitiesPerSecond: 100,
		TaskQueueActivitiesPerSecond: 1000,
	}

	w := worker.New(c, taskQueue, workerOpts)

	// Register workflows
	w.RegisterWorkflow(workflows.OrderWorkflow)
	w.RegisterWorkflow(workflows.FulfillmentWorkflow)
	w.RegisterWorkflow(workflows.ApprovalWorkflow)

	// Register activities with injected dependencies
	paymentActivities := &activities.PaymentActivities{
		PaymentGateway: newPaymentGatewayClient(),
		DB:             newDatabaseClient(),
	}
	w.RegisterActivity(paymentActivities)

	inventoryActivities := &activities.InventoryActivities{
		InventoryService: newInventoryClient(),
	}
	w.RegisterActivity(inventoryActivities)

	log.Printf("Starting worker: namespace=%s taskQueue=%s", namespace, taskQueue)
	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatalf("Worker error: %v", err)
	}
}

func getEnv(key, defaultValue string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultValue
}
```

### Worker Kubernetes Deployment

```yaml
# worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-workflow-worker
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-workflow-worker
  template:
    metadata:
      labels:
        app: order-workflow-worker
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      terminationGracePeriodSeconds: 300   # Allow in-flight activities to complete
      containers:
      - name: worker
        image: harbor.example.com/applications/order-workflow-worker:v1.5.0
        env:
        - name: TEMPORAL_HOST
          value: "temporal-frontend.temporal.svc.cluster.local:7233"
        - name: TEMPORAL_NAMESPACE
          value: "production"
        - name: TEMPORAL_TASK_QUEUE
          value: "order-processing"
        - name: DB_HOST
          value: "postgres.postgres.svc.cluster.local"
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: order-service-db-credentials
              key: password
        - name: PAYMENT_GATEWAY_API_KEY
          valueFrom:
            secretKeyRef:
              name: payment-gateway-credentials
              key: api-key
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: order-workflow-worker
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-workflow-worker
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: order-workflow-worker
```

## Search Attributes

Search attributes allow filtering and searching workflow executions by custom fields:

```bash
#!/bin/bash
# configure-search-attributes.sh

# Register custom search attributes
kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator search-attribute create \
    --name OrderStatus \
    --type Keyword

kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator search-attribute create \
    --name CustomerID \
    --type Keyword

kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator search-attribute create \
    --name OrderAmount \
    --type Double

kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator search-attribute create \
    --name IsHighValue \
    --type Bool

# List search attributes
kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal operator search-attribute list
```

Use search attributes in Go code:

```go
// Set search attributes during workflow execution
workflow.UpsertTypedSearchAttributes(ctx,
    temporal.NewSearchAttributeKeyKeyword("OrderStatus").ValueSet("pending"),
    temporal.NewSearchAttributeKeyKeyword("CustomerID").ValueSet(order.CustomerID),
    temporal.NewSearchAttributeKeyFloat64("OrderAmount").ValueSet(order.TotalAmount),
)

// Query via tctl
// temporal workflow list --query 'OrderStatus="pending" AND OrderAmount > 1000'
```

## Determinism Constraints

Temporal replays workflow history on worker restarts. Workflows must be deterministic:

```go
// WRONG — direct time.Now() breaks determinism on replay
func BadWorkflow(ctx workflow.Context) error {
    now := time.Now()    // Different value on replay!
    _ = now
    return nil
}

// CORRECT — use workflow.Now() which replays the original timestamp
func GoodWorkflow(ctx workflow.Context) error {
    now := workflow.Now(ctx)    // Returns the original execution time on replay
    _ = now
    return nil
}

// WRONG — non-deterministic map iteration
func BadWorkflowMap(ctx workflow.Context, items map[string]int) error {
    for k, v := range items {    // Map iteration order is random!
        _ = k
        _ = v
    }
    return nil
}

// CORRECT — sort keys first
func GoodWorkflowMap(ctx workflow.Context, items map[string]int) error {
    keys := make([]string, 0, len(items))
    for k := range items {
        keys = append(keys, k)
    }
    sort.Strings(keys)
    for _, k := range keys {
        _ = items[k]
    }
    return nil
}
```

## Monitoring with Prometheus

### Alerts

```yaml
# temporal-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: temporal-alerts
  namespace: monitoring
spec:
  groups:
  - name: temporal.server
    interval: 30s
    rules:
    - alert: TemporalFrontendDown
      expr: up{job="temporal-frontend"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Temporal frontend service is unreachable"

    - alert: TemporalWorkflowTaskScheduleToStartHigh
      expr: |
        histogram_quantile(0.99,
          rate(temporal_task_schedule_to_start_latency_seconds_bucket{task_type="workflow"}[5m])
        ) > 10
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Temporal workflow task schedule-to-start P99 > 10s"
        description: "Workers may be overwhelmed or task queue backlogged."

    - alert: TemporalActivityTaskScheduleToStartHigh
      expr: |
        histogram_quantile(0.99,
          rate(temporal_task_schedule_to_start_latency_seconds_bucket{task_type="activity"}[5m])
        ) > 30
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Temporal activity task schedule-to-start P99 > 30s"

    - alert: TemporalPersistenceLatencyHigh
      expr: |
        histogram_quantile(0.99,
          rate(temporal_persistence_latency_seconds_bucket[5m])
        ) > 0.5
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Temporal DB persistence P99 latency > 500ms"
        description: "PostgreSQL may be under-provisioned or have lock contention."

    - alert: TemporalWorkflowsStuck
      expr: |
        sum(rate(temporal_workflow_failed_total[30m])) /
        sum(rate(temporal_workflow_completed_total[30m])) > 0.05
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Temporal workflow failure rate above 5%"

    - alert: TemporalHistoryShardImbalance
      expr: |
        max(temporal_history_shard_ownership_total) /
        min(temporal_history_shard_ownership_total) > 2
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Temporal history shard distribution is imbalanced"
```

## Operational Runbook

### History Shard Balancing

History shards are distributed across History service pods. Imbalance causes uneven load:

```bash
#!/bin/bash
# check-shard-distribution.sh

echo "=== History Service Pods ==="
kubectl get pods -n temporal -l app.kubernetes.io/component=history -o wide

echo ""
echo "=== Shard Ownership Distribution ==="
for pod in $(kubectl get pods -n temporal -l app.kubernetes.io/component=history -o name); do
  echo -n "${pod}: "
  kubectl exec -n temporal ${pod} -- \
    curl -s http://localhost:7936/metrics | \
    grep "temporal_history_shard_ownership_total" | \
    awk '{print $2}'
done

echo ""
echo "=== Rebalance by rolling restart ==="
echo "kubectl rollout restart deployment/temporal-history -n temporal"
```

### Finding Stuck Workflows

```bash
#!/bin/bash
# find-stuck-workflows.sh

NAMESPACE="production"

echo "=== Long-running workflows (> 24 hours) ==="
kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal workflow list \
    --namespace "${NAMESPACE}" \
    --query 'ExecutionStatus="Running" AND StartTime < now() - 86400s' \
    --fields WorkflowId,RunId,WorkflowType,StartTime

echo ""
echo "=== Timed-out workflows ==="
kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal workflow list \
    --namespace "${NAMESPACE}" \
    --query 'ExecutionStatus="TimedOut"' \
    --fields WorkflowId,RunId,WorkflowType,StartTime,CloseTime

echo ""
echo "=== Workflow failure summary ==="
kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal workflow list \
    --namespace "${NAMESPACE}" \
    --query 'ExecutionStatus="Failed"' \
    --fields WorkflowId,WorkflowType,StartTime,CloseTime

echo ""
echo "=== Terminate a stuck workflow ==="
echo "temporal workflow terminate --namespace ${NAMESPACE} --workflow-id <id> --reason 'stuck'"
```

### Workflow Reset (Replay from Earlier Point)

```bash
#!/bin/bash
# reset-workflow.sh
# Reset a workflow to a specific event ID to recover from bad state

NAMESPACE="production"
WORKFLOW_ID="order-wf-12345"
RESET_POINT="LastWorkflowTask"  # or: LastDecisionCompleted, BadBinary, FirstWorkflowTask

kubectl exec -n temporal deployment/temporal-admintools -- \
  temporal workflow reset \
    --namespace "${NAMESPACE}" \
    --workflow-id "${WORKFLOW_ID}" \
    --type "${RESET_POINT}" \
    --reason "Resetting to recover from activity bug in v1.4.0"
```

## Temporal Cloud vs Self-Hosted Decision Matrix

| Factor | Self-Hosted (K8s) | Temporal Cloud |
|---|---|---|
| Ops burden | High (schema, upgrades, HA) | None |
| Cost at scale | Lower (infra cost only) | Higher (per action pricing) |
| Data residency | Full control | Region-scoped |
| Customization | Full (plugins, namespace config) | Limited |
| SLA | Self-managed | 99.9% uptime SLA |
| Compliance | Full control | SOC2, HIPAA BAA available |

Self-hosted is recommended when: the team can operate a database HA cluster, workflows exceed 50M actions/month, or data residency requirements preclude SaaS.

## Conclusion

Temporal fundamentally changes how distributed systems handle failure: rather than building ad-hoc retry logic, compensation tables, and state machines in application code, the execution model shifts to durable, event-sourced workflows that survive any process failure. Key production recommendations:

- Set `numHistoryShards` to at least 512 for production workloads — this value cannot be changed without re-seeding the database
- Configure `terminationGracePeriodSeconds: 300` on worker pods so in-flight activities complete before pod eviction
- Register all workflow and activity types in workers before starting — Temporal routes tasks by type name, and unknown types result in task timeouts
- Use `NonRetryableErrorTypes` to prevent infinite retries on business logic errors (insufficient funds, validation failures)
- Monitor `temporal_task_schedule_to_start_latency_seconds` — values above 10 seconds indicate workers are undersized or the task queue has a backlog
- Implement search attributes for key business fields (`CustomerID`, `Status`, `OrderID`) to enable operational dashboards without querying the application DB
- Run workflow unit tests with `testsuite.TestWorkflowEnvironment` to catch non-determinism bugs before deployment
