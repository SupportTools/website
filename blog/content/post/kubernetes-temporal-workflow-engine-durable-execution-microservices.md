---
title: "Kubernetes Temporal Workflow Engine: Durable Execution for Microservices"
date: 2031-04-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Temporal", "Workflows", "Microservices", "Go", "Distributed Systems"]
categories:
- Kubernetes
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Temporal on Kubernetes for durable workflow execution. Covers workflow and activity concepts in Go SDK, versioning, search attributes, Web UI, worker scaling, and replacing ad-hoc retry logic."
more_link: "yes"
url: "/kubernetes-temporal-workflow-engine-durable-execution-microservices/"
---

Ad-hoc retry logic scattered across microservices is a maintenance nightmare and reliability hazard. Temporal provides durable execution: workflows that automatically resume after crashes, network failures, or deployments, with full execution history preserved. This guide covers deploying Temporal on Kubernetes and building production-grade workflows in Go.

<!--more-->

# Kubernetes Temporal Workflow Engine: Durable Execution for Microservices

## The Problem with Ad-Hoc Retry Logic

Most distributed systems handle failures through scattered, inconsistent mechanisms:

```go
// The typical ad-hoc approach - fragile and inconsistent
func processOrder(orderID string) error {
    var order Order
    for i := 0; i < 3; i++ {
        var err error
        order, err = fetchOrder(orderID)
        if err == nil {
            break
        }
        if i == 2 {
            return fmt.Errorf("fetching order after 3 retries: %w", err)
        }
        time.Sleep(time.Duration(i+1) * time.Second)
    }

    // Process payment - no retry
    if err := chargePayment(order); err != nil {
        return err // If this fails after a partial operation, we're in trouble
    }

    // Ship order - no retry, and if we crash here, we've charged but not shipped
    if err := shipOrder(order); err != nil {
        return err
    }

    return notifyCustomer(order)
}
```

This code has multiple failure modes: partial execution leaves the system in an inconsistent state, retry policies are inconsistent across the codebase, and there is no visibility into in-progress operations.

Temporal solves this by making workflow execution durable. If the process crashes mid-workflow, Temporal replays the workflow from its persisted event history, skipping already-completed activities.

## Section 1: Deploying Temporal on Kubernetes

### Namespace and Prerequisites

```bash
kubectl create namespace temporal

# Temporal requires a database backend: Cassandra, MySQL, or PostgreSQL
# We'll use PostgreSQL for this guide
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: temporal-postgres-pvc
  namespace: temporal
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 50Gi
  storageClassName: fast-ssd
EOF
```

### PostgreSQL Backend

```yaml
# temporal-postgres.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: temporal-postgres
  namespace: temporal
spec:
  replicas: 1
  selector:
    matchLabels:
      app: temporal-postgres
  template:
    metadata:
      labels:
        app: temporal-postgres
    spec:
      containers:
        - name: postgres
          image: postgres:15-alpine
          env:
            - name: POSTGRES_USER
              value: temporal
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: temporal-postgres-secret
                  key: password
            - name: POSTGRES_DB
              value: temporal
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: temporal-postgres-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: temporal-postgres
  namespace: temporal
spec:
  selector:
    app: temporal-postgres
  ports:
    - port: 5432
```

```bash
kubectl create secret generic temporal-postgres-secret \
  --namespace temporal \
  --from-literal=password='<db-password-here>'

kubectl apply -f temporal-postgres.yaml
```

### Temporal Server Deployment

Temporal server consists of four services: frontend, history, matching, and worker. Use the official Helm chart for production:

```bash
# Add Temporal Helm chart repository
helm repo add temporal https://go.temporal.io/helm-charts
helm repo update

# Create values file for production deployment
cat > temporal-values.yaml <<'EOF'
server:
  replicaCount: 3

  config:
    persistence:
      defaultStore: postgres-default
      visibilityStore: postgres-visibility
      numHistoryShards: 512
      datastores:
        postgres-default:
          sql:
            pluginName: postgres12
            databaseName: temporal
            connectAddr: temporal-postgres.temporal.svc.cluster.local:5432
            connectProtocol: tcp
            user: temporal
            password: "<db-password-here>"
            maxConns: 20
            maxIdleConns: 20
            maxConnLifetime: 1h
        postgres-visibility:
          sql:
            pluginName: postgres12
            databaseName: temporal_visibility
            connectAddr: temporal-postgres.temporal.svc.cluster.local:5432
            connectProtocol: tcp
            user: temporal
            password: "<db-password-here>"
            maxConns: 10
            maxIdleConns: 10
            maxConnLifetime: 1h

  frontend:
    replicaCount: 2
    resources:
      requests:
        cpu: 200m
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 1Gi

  history:
    replicaCount: 3
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        cpu: 2000m
        memory: 2Gi

  matching:
    replicaCount: 2
    resources:
      requests:
        cpu: 200m
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 1Gi

  worker:
    replicaCount: 1
    resources:
      requests:
        cpu: 200m
        memory: 256Mi

web:
  enabled: true
  replicaCount: 1
  ingress:
    enabled: true
    className: nginx
    hosts:
      - host: temporal-ui.example.com
        paths:
          - path: /
            pathType: Prefix

admintools:
  enabled: true

elasticsearch:
  enabled: false

cassandra:
  enabled: false

mysql:
  enabled: false

postgresql:
  enabled: false
EOF

helm install temporal temporal/temporal \
  --namespace temporal \
  --values temporal-values.yaml \
  --wait --timeout 10m
```

### Verifying Temporal is Running

```bash
kubectl get pods -n temporal

# Expected output:
# temporal-admintools-xxx      1/1     Running
# temporal-frontend-xxx        1/1     Running
# temporal-history-xxx         3/3     Running (one per shard group)
# temporal-matching-xxx        1/1     Running
# temporal-worker-xxx          1/1     Running
# temporal-web-xxx             1/1     Running

# Create the default namespace in Temporal
kubectl exec -n temporal \
  $(kubectl get pods -n temporal -l app.kubernetes.io/component=admintools -o jsonpath='{.items[0].metadata.name}') \
  -- tctl --namespace default namespace register

# Verify connection
kubectl exec -n temporal \
  $(kubectl get pods -n temporal -l app.kubernetes.io/component=admintools -o jsonpath='{.items[0].metadata.name}') \
  -- tctl --namespace default namespace describe
```

## Section 2: Workflow and Activity Concepts in Go SDK

### Project Setup

```bash
mkdir order-workflow && cd order-workflow
go mod init github.com/example/order-workflow
go get go.temporal.io/sdk
go get go.temporal.io/sdk/client
go get go.temporal.io/sdk/worker
go get go.temporal.io/sdk/workflow
go get go.temporal.io/sdk/activity
go get go.temporal.io/sdk/temporal
```

### Defining Activities

Activities are units of work that can fail and be retried. Each activity is idempotent or uses idempotency keys.

```go
// activities/order.go
package activities

import (
    "context"
    "fmt"
    "time"

    "go.temporal.io/sdk/activity"
    "go.temporal.io/sdk/temporal"
)

// OrderInput is the input for order-related activities.
type OrderInput struct {
    OrderID    string
    CustomerID string
    Amount     float64
    Items      []OrderItem
}

type OrderItem struct {
    ProductID string
    Quantity  int
    Price     float64
}

type PaymentResult struct {
    TransactionID string
    ChargedAt     time.Time
}

type ShipmentResult struct {
    TrackingNumber string
    EstimatedDelivery time.Time
}

// OrderActivities groups all order-related activities.
// Using a struct allows dependency injection for testing.
type OrderActivities struct {
    paymentClient  PaymentClient
    inventoryClient InventoryClient
    shippingClient  ShippingClient
    notifClient    NotificationClient
}

func NewOrderActivities(
    payment PaymentClient,
    inventory InventoryClient,
    shipping ShippingClient,
    notif NotificationClient,
) *OrderActivities {
    return &OrderActivities{
        paymentClient:  payment,
        inventoryClient: inventory,
        shippingClient:  shipping,
        notifClient:    notif,
    }
}

// ValidateOrder checks inventory availability and order data integrity.
func (a *OrderActivities) ValidateOrder(ctx context.Context, input OrderInput) error {
    logger := activity.GetLogger(ctx)
    logger.Info("Validating order", "orderID", input.OrderID)

    for _, item := range input.Items {
        available, err := a.inventoryClient.CheckAvailability(ctx, item.ProductID, item.Quantity)
        if err != nil {
            return fmt.Errorf("checking inventory for %s: %w", item.ProductID, err)
        }
        if !available {
            // Non-retryable error - the order cannot proceed regardless of retries
            return temporal.NewNonRetryableApplicationError(
                fmt.Sprintf("product %s is out of stock", item.ProductID),
                "OUT_OF_STOCK",
                nil,
            )
        }
    }
    return nil
}

// ChargePayment charges the customer's payment method.
// The idempotency key (OrderID) ensures double-charging does not occur.
func (a *OrderActivities) ChargePayment(ctx context.Context, input OrderInput) (*PaymentResult, error) {
    logger := activity.GetLogger(ctx)
    logger.Info("Charging payment", "orderID", input.OrderID, "amount", input.Amount)

    // Use orderID as idempotency key to prevent double-charging
    result, err := a.paymentClient.Charge(ctx, PaymentRequest{
        IdempotencyKey: input.OrderID,
        CustomerID:     input.CustomerID,
        Amount:         input.Amount,
        Currency:       "USD",
    })
    if err != nil {
        // Distinguish retryable (network) from non-retryable (card declined) errors
        var payErr *PaymentError
        if errors.As(err, &payErr) && payErr.Code == "CARD_DECLINED" {
            return nil, temporal.NewNonRetryableApplicationError(
                "payment was declined",
                "PAYMENT_DECLINED",
                payErr,
            )
        }
        return nil, fmt.Errorf("payment charge: %w", err)
    }

    return &PaymentResult{
        TransactionID: result.TransactionID,
        ChargedAt:     time.Now(),
    }, nil
}

// ReserveInventory reserves items in inventory.
func (a *OrderActivities) ReserveInventory(ctx context.Context, input OrderInput) error {
    for _, item := range input.Items {
        if err := a.inventoryClient.Reserve(ctx, input.OrderID, item.ProductID, item.Quantity); err != nil {
            return fmt.Errorf("reserving inventory for %s: %w", item.ProductID, err)
        }
    }
    return nil
}

// CreateShipment creates a shipping label and schedules pickup.
func (a *OrderActivities) CreateShipment(ctx context.Context, input OrderInput) (*ShipmentResult, error) {
    result, err := a.shippingClient.CreateShipment(ctx, ShipmentRequest{
        OrderID:    input.OrderID,
        CustomerID: input.CustomerID,
        Items:      input.Items,
    })
    if err != nil {
        return nil, fmt.Errorf("creating shipment: %w", err)
    }

    return &ShipmentResult{
        TrackingNumber:    result.TrackingNumber,
        EstimatedDelivery: result.EstimatedDelivery,
    }, nil
}

// NotifyCustomer sends an order confirmation email.
func (a *OrderActivities) NotifyCustomer(ctx context.Context, input OrderInput,
    payment *PaymentResult, shipment *ShipmentResult) error {
    return a.notifClient.SendOrderConfirmation(ctx, OrderConfirmation{
        OrderID:       input.OrderID,
        CustomerID:    input.CustomerID,
        TransactionID: payment.TransactionID,
        TrackingNumber: shipment.TrackingNumber,
        EstimatedDelivery: shipment.EstimatedDelivery,
    })
}

// RefundPayment compensates a failed order by reversing the charge.
func (a *OrderActivities) RefundPayment(ctx context.Context, transactionID string) error {
    return a.paymentClient.Refund(ctx, transactionID)
}

// ReleaseInventory compensates a failed order by releasing reserved inventory.
func (a *OrderActivities) ReleaseInventory(ctx context.Context, input OrderInput) error {
    for _, item := range input.Items {
        if err := a.inventoryClient.Release(ctx, input.OrderID, item.ProductID, item.Quantity); err != nil {
            return fmt.Errorf("releasing inventory for %s: %w", item.ProductID, err)
        }
    }
    return nil
}
```

### Defining the Workflow

```go
// workflows/order.go
package workflows

import (
    "fmt"
    "time"

    "go.temporal.io/sdk/temporal"
    "go.temporal.io/sdk/workflow"

    "github.com/example/order-workflow/activities"
)

const (
    OrderWorkflowName = "OrderWorkflow"
    OrderTaskQueue    = "order-task-queue"
)

// OrderWorkflow defines the durable execution of an order.
// Workflows must be deterministic: no random numbers, no direct system clock access,
// no goroutines that outlive the workflow function.
func OrderWorkflow(ctx workflow.Context, input activities.OrderInput) error {
    logger := workflow.GetLogger(ctx)
    logger.Info("Starting order workflow", "orderID", input.OrderID)

    // Activity options define retry behavior and timeouts
    activityOptions := workflow.ActivityOptions{
        StartToCloseTimeout: 30 * time.Second,
        RetryPolicy: &temporal.RetryPolicy{
            InitialInterval:        time.Second,
            BackoffCoefficient:     2.0,
            MaximumInterval:        30 * time.Second,
            MaximumAttempts:        5,
            NonRetryableErrorTypes: []string{"OUT_OF_STOCK", "PAYMENT_DECLINED"},
        },
    }
    ctx = workflow.WithActivityOptions(ctx, activityOptions)

    // Track compensation actions for saga pattern
    var compensations []func(workflow.Context) error

    // Step 1: Validate the order
    if err := workflow.ExecuteActivity(ctx,
        activities.OrderActivitiesName+"ValidateOrder", input).Get(ctx, nil); err != nil {
        return fmt.Errorf("validating order: %w", err)
    }

    // Step 2: Reserve inventory
    if err := workflow.ExecuteActivity(ctx,
        activities.OrderActivitiesName+"ReserveInventory", input).Get(ctx, nil); err != nil {
        return fmt.Errorf("reserving inventory: %w", err)
    }
    compensations = append(compensations, func(ctx workflow.Context) error {
        return workflow.ExecuteActivity(ctx,
            activities.OrderActivitiesName+"ReleaseInventory", input).Get(ctx, nil)
    })

    // Step 3: Charge payment
    var paymentResult activities.PaymentResult
    if err := workflow.ExecuteActivity(ctx,
        activities.OrderActivitiesName+"ChargePayment", input).Get(ctx, &paymentResult); err != nil {
        // Compensate: release inventory
        runCompensations(ctx, compensations, logger)
        return fmt.Errorf("charging payment: %w", err)
    }
    compensations = append(compensations, func(ctx workflow.Context) error {
        return workflow.ExecuteActivity(ctx,
            activities.OrderActivitiesName+"RefundPayment", paymentResult.TransactionID).Get(ctx, nil)
    })

    // Step 4: Create shipment
    var shipmentResult activities.ShipmentResult
    if err := workflow.ExecuteActivity(ctx,
        activities.OrderActivitiesName+"CreateShipment", input).Get(ctx, &shipmentResult); err != nil {
        runCompensations(ctx, compensations, logger)
        return fmt.Errorf("creating shipment: %w", err)
    }

    // Step 5: Notify customer (best-effort, do not compensate on failure)
    notifyOptions := workflow.ActivityOptions{
        StartToCloseTimeout: 10 * time.Second,
        RetryPolicy: &temporal.RetryPolicy{
            MaximumAttempts: 3,
        },
    }
    notifyCtx := workflow.WithActivityOptions(ctx, notifyOptions)
    if err := workflow.ExecuteActivity(notifyCtx,
        activities.OrderActivitiesName+"NotifyCustomer",
        input, paymentResult, shipmentResult).Get(notifyCtx, nil); err != nil {
        // Log but don't fail the workflow for notification errors
        logger.Warn("Failed to notify customer", "error", err)
    }

    logger.Info("Order workflow completed successfully",
        "orderID", input.OrderID,
        "trackingNumber", shipmentResult.TrackingNumber)
    return nil
}

func runCompensations(ctx workflow.Context, compensations []func(workflow.Context) error,
    logger workflow.Logger) {
    // Run compensations in reverse order
    disconnectedCtx, _ := workflow.NewDisconnectedContext(ctx)
    compensationOptions := workflow.ActivityOptions{
        StartToCloseTimeout: 60 * time.Second,
        RetryPolicy: &temporal.RetryPolicy{
            MaximumAttempts: 10,
        },
    }
    disconnectedCtx = workflow.WithActivityOptions(disconnectedCtx, compensationOptions)

    for i := len(compensations) - 1; i >= 0; i-- {
        if err := compensations[i](disconnectedCtx); err != nil {
            logger.Error("Compensation failed", "index", i, "error", err)
        }
    }
}
```

### Activity Registration Names

```go
// activities/names.go
package activities

// OrderActivitiesName is the prefix used when registering activity functions.
// Using a const prevents typos when referring to activities in workflows.
const OrderActivitiesName = "OrderActivities_"
```

## Section 3: Worker Implementation and Registration

```go
// worker/main.go
package main

import (
    "log"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "go.temporal.io/sdk/client"
    "go.temporal.io/sdk/worker"

    "github.com/example/order-workflow/activities"
    "github.com/example/order-workflow/workflows"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Connect to Temporal server
    temporalClient, err := client.Dial(client.Options{
        HostPort:  os.Getenv("TEMPORAL_HOST_PORT"), // frontend:7233
        Namespace: "default",
        Logger:    slog.NewLogLogger(logger.Handler(), slog.LevelDebug),
    })
    if err != nil {
        log.Fatalf("connecting to Temporal: %v", err)
    }
    defer temporalClient.Close()

    // Initialize activity dependencies
    paymentClient := newPaymentClient()
    inventoryClient := newInventoryClient()
    shippingClient := newShippingClient()
    notifClient := newNotificationClient()

    orderActivities := activities.NewOrderActivities(
        paymentClient,
        inventoryClient,
        shippingClient,
        notifClient,
    )

    // Create worker
    w := worker.New(temporalClient, workflows.OrderTaskQueue, worker.Options{
        // Tune these based on activity latency and available resources
        MaxConcurrentActivityExecutionSize:      100,
        MaxConcurrentWorkflowTaskExecutionSize:  100,
        MaxConcurrentLocalActivityExecutionSize: 50,
        // Enable graceful shutdown
        DeadlockDetectionTimeout: 30,
    })

    // Register workflows
    w.RegisterWorkflow(workflows.OrderWorkflow)

    // Register activities using struct methods
    w.RegisterActivity(orderActivities)

    // Start worker in background
    if err := w.Start(); err != nil {
        log.Fatalf("starting worker: %v", err)
    }
    logger.Info("Worker started", "taskQueue", workflows.OrderTaskQueue)

    // Wait for termination signal
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    <-sigCh

    logger.Info("Shutting down worker gracefully...")
    w.Stop()
    logger.Info("Worker stopped")
}
```

### Starting Workflow Executions

```go
// starter/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "os"

    "go.temporal.io/sdk/client"

    "github.com/example/order-workflow/activities"
    "github.com/example/order-workflow/workflows"
)

func main() {
    temporalClient, err := client.Dial(client.Options{
        HostPort:  os.Getenv("TEMPORAL_HOST_PORT"),
        Namespace: "default",
    })
    if err != nil {
        log.Fatalf("connecting to Temporal: %v", err)
    }
    defer temporalClient.Close()

    orderInput := activities.OrderInput{
        OrderID:    "order-abc-123",
        CustomerID: "customer-xyz-456",
        Amount:     149.99,
        Items: []activities.OrderItem{
            {ProductID: "prod-001", Quantity: 2, Price: 49.99},
            {ProductID: "prod-002", Quantity: 1, Price: 50.01},
        },
    }

    // WorkflowID is idempotent - starting the same WorkflowID while it's running
    // returns the existing execution instead of starting a new one
    we, err := temporalClient.ExecuteWorkflow(
        context.Background(),
        client.StartWorkflowOptions{
            ID:        fmt.Sprintf("order-%s", orderInput.OrderID),
            TaskQueue: workflows.OrderTaskQueue,
            // Workflow execution can span hours/days
        },
        workflows.OrderWorkflow,
        orderInput,
    )
    if err != nil {
        log.Fatalf("starting workflow: %v", err)
    }

    log.Printf("Started workflow: ID=%s, RunID=%s", we.GetID(), we.GetRunID())

    // Optionally wait for completion
    var result interface{}
    if err := we.Get(context.Background(), &result); err != nil {
        log.Fatalf("workflow failed: %v", err)
    }
    log.Printf("Workflow completed successfully")
}
```

## Section 4: Workflow Versioning

Temporal replays workflow history to resume interrupted workflows. Introducing incompatible changes to workflow code while executions are in-flight will cause replay failures. The `GetVersion` API handles this.

```go
// workflows/order_v2.go
package workflows

import (
    "time"

    "go.temporal.io/sdk/temporal"
    "go.temporal.io/sdk/workflow"

    "github.com/example/order-workflow/activities"
)

const (
    // Version constants for workflow changes
    OrderWorkflowV1 = 1
    OrderWorkflowV2 = 2 // Added fraud check step
    OrderWorkflowV3 = 3 // Added loyalty points step
)

func OrderWorkflowVersioned(ctx workflow.Context, input activities.OrderInput) error {
    logger := workflow.GetLogger(ctx)

    // GetVersion allows introducing changes while in-flight executions
    // with old history continue to work using the old code path.
    //
    // Executions that started before the fraud check was introduced
    // will use DefaultVersion (minSupported) and skip the fraud check.
    // New executions will use version 2 and include the fraud check.
    v := workflow.GetVersion(ctx, "add-fraud-check", workflow.DefaultVersion, OrderWorkflowV2)

    activityOptions := workflow.ActivityOptions{
        StartToCloseTimeout: 30 * time.Second,
        RetryPolicy: &temporal.RetryPolicy{
            InitialInterval:    time.Second,
            BackoffCoefficient: 2.0,
            MaximumInterval:    30 * time.Second,
            MaximumAttempts:    5,
        },
    }
    ctx = workflow.WithActivityOptions(ctx, activityOptions)

    // All executions: validate order
    if err := workflow.ExecuteActivity(ctx,
        "OrderActivities_ValidateOrder", input).Get(ctx, nil); err != nil {
        return err
    }

    // Only executions using version 2+: fraud check
    if v >= OrderWorkflowV2 {
        logger.Info("Running fraud check (v2+ code path)")
        if err := workflow.ExecuteActivity(ctx,
            "OrderActivities_CheckFraud", input).Get(ctx, nil); err != nil {
            return err
        }
    }

    // Add loyalty points (version 3+)
    v3 := workflow.GetVersion(ctx, "add-loyalty-points", workflow.DefaultVersion, OrderWorkflowV3)

    // ... rest of workflow ...

    if v3 >= OrderWorkflowV3 {
        if err := workflow.ExecuteActivity(ctx,
            "OrderActivities_AwardLoyaltyPoints", input).Get(ctx, nil); err != nil {
            logger.Warn("Failed to award loyalty points", "error", err)
            // Non-critical, don't fail the workflow
        }
    }

    return nil
}
```

### Cleaning Up Old Version Branches

Once all old executions have completed, remove the old code paths and update the minSupported version:

```go
// After all v1 and v2 executions have completed:
v := workflow.GetVersion(ctx, "add-fraud-check", OrderWorkflowV2, OrderWorkflowV2)
// minSupported == maxSupported == V2
// This means: "we always expect version 2 here, reject any replays that have DefaultVersion"
_ = v // The fraud check is now always executed, no version branching needed
```

## Section 5: Search Attributes

Search attributes enable querying workflow executions via Temporal's visibility store.

### Registering Custom Search Attributes

```bash
# Register search attributes (requires admintools)
kubectl exec -n temporal \
  $(kubectl get pods -n temporal -l app.kubernetes.io/component=admintools -o jsonpath='{.items[0].metadata.name}') \
  -- tctl --namespace default admin cluster add-search-attributes \
     --name CustomerID --type Keyword \
     --name OrderAmount --type Double \
     --name OrderStatus --type Keyword \
     --name Region --type Keyword \
     --name ProcessingTimeMs --type Int
```

### Using Search Attributes in Workflows

```go
// workflows/order_with_attrs.go
package workflows

import (
    "go.temporal.io/api/common/v1"
    "go.temporal.io/sdk/converter"
    "go.temporal.io/sdk/workflow"

    "github.com/example/order-workflow/activities"
)

func OrderWorkflowWithAttributes(ctx workflow.Context, input activities.OrderInput) error {
    // Set initial search attributes
    if err := workflow.UpsertSearchAttributes(ctx, map[string]interface{}{
        "CustomerID":  input.CustomerID,
        "OrderAmount": input.Amount,
        "OrderStatus": "processing",
    }); err != nil {
        return err
    }

    activityOptions := workflow.ActivityOptions{
        StartToCloseTimeout: 30 * time.Second,
    }
    ctx = workflow.WithActivityOptions(ctx, activityOptions)

    if err := workflow.ExecuteActivity(ctx, "OrderActivities_ValidateOrder", input).Get(ctx, nil); err != nil {
        workflow.UpsertSearchAttributes(ctx, map[string]interface{}{
            "OrderStatus": "validation_failed",
        })
        return err
    }

    workflow.UpsertSearchAttributes(ctx, map[string]interface{}{
        "OrderStatus": "payment_pending",
    })

    var paymentResult activities.PaymentResult
    if err := workflow.ExecuteActivity(ctx, "OrderActivities_ChargePayment", input).Get(ctx, &paymentResult); err != nil {
        workflow.UpsertSearchAttributes(ctx, map[string]interface{}{
            "OrderStatus": "payment_failed",
        })
        return err
    }

    workflow.UpsertSearchAttributes(ctx, map[string]interface{}{
        "OrderStatus": "shipped",
    })

    return nil
}
```

### Querying Workflows by Search Attributes

```go
// query_workflows.go
package main

import (
    "context"
    "fmt"
    "log"

    "go.temporal.io/sdk/client"
)

func listWorkflowsByCustomer(temporalClient client.Client, customerID string) {
    query := fmt.Sprintf(`CustomerID = "%s" AND OrderStatus = "shipped"`, customerID)

    iter := temporalClient.ListWorkflow(context.Background(), &workflowservice.ListWorkflowExecutionsRequest{
        Namespace: "default",
        Query:     query,
        PageSize:  100,
    })

    for iter.HasNext() {
        we, err := iter.Next()
        if err != nil {
            log.Printf("Error iterating: %v", err)
            break
        }
        fmt.Printf("WorkflowID: %s, Status: %v\n",
            we.GetExecution().GetWorkflowId(),
            we.GetStatus())
    }
}
```

## Section 6: Temporal Web UI and Operations

### Accessing the Web UI

```bash
# Port-forward if not using Ingress
kubectl port-forward -n temporal svc/temporal-web 8080:8080

# Open http://localhost:8080
# Default namespace: default
```

The Web UI provides:
- Workflow execution list with search
- Event history timeline for a specific execution
- Input/output for each activity
- Pending activities and their retry counts
- Signal and query interfaces

### Workflow Signals

Signals allow external events to modify in-flight workflows:

```go
// workflow with signals
func OrderWorkflowWithSignals(ctx workflow.Context, input activities.OrderInput) error {
    // Set up signal channel for cancellation
    cancelCh := workflow.GetSignalChannel(ctx, "cancel-order")
    expediteCh := workflow.GetSignalChannel(ctx, "expedite-shipping")

    activityCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
        StartToCloseTimeout: 30 * time.Second,
    })

    // Process payment asynchronously
    paymentFuture := workflow.ExecuteActivity(activityCtx,
        "OrderActivities_ChargePayment", input)

    // Wait for payment OR cancellation signal
    selector := workflow.NewSelector(ctx)
    var cancelled bool
    var paymentResult activities.PaymentResult

    selector.AddFuture(paymentFuture, func(f workflow.Future) {
        f.Get(ctx, &paymentResult)
    })

    selector.AddReceive(cancelCh, func(c workflow.ReceiveChannel, more bool) {
        var reason string
        c.Receive(ctx, &reason)
        cancelled = true
        workflow.GetLogger(ctx).Info("Order cancellation requested", "reason", reason)
    })

    selector.Select(ctx)

    if cancelled {
        return temporal.NewCanceledError("order was cancelled by customer")
    }

    // Check for expedite signal (non-blocking)
    var expedite bool
    expediteCh.ReceiveAsync(&expedite)

    return nil
}
```

```go
// Sending a signal to a running workflow
err := temporalClient.SignalWorkflow(
    context.Background(),
    "order-abc-123",  // WorkflowID
    "",               // RunID (empty means latest)
    "cancel-order",   // Signal name
    "Customer requested cancellation via support ticket #12345",
)
```

### Workflow Queries

Queries allow reading workflow state without interrupting execution:

```go
// Register a query handler in the workflow
workflow.SetQueryHandler(ctx, "order-status", func() (string, error) {
    return currentStatus, nil
})

// Client-side query
val, err := temporalClient.QueryWorkflow(
    context.Background(),
    "order-abc-123",
    "",
    "order-status",
)
var status string
val.Get(&status)
```

## Section 7: Worker Scaling on Kubernetes

### Worker Deployment

```yaml
# worker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-workflow-worker
  namespace: order-service
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
      containers:
        - name: worker
          image: ghcr.io/myorg/order-workflow-worker:1.5.0
          env:
            - name: TEMPORAL_HOST_PORT
              value: temporal-frontend.temporal.svc.cluster.local:7233
            - name: TEMPORAL_NAMESPACE
              value: default
            - name: TEMPORAL_TASK_QUEUE
              value: order-task-queue
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 1Gi
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          # Graceful shutdown - allow in-flight activities to complete
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 30"]
          terminationGracePeriodSeconds: 60
---
# HPA based on pending workflow tasks
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-workflow-worker-hpa
  namespace: order-service
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-workflow-worker
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: External
      external:
        metric:
          name: temporal_pending_workflows
          selector:
            matchLabels:
              task_queue: order-task-queue
        target:
          type: AverageValue
          averageValue: "10"
```

### Temporal Metrics with Prometheus

```yaml
# temporal-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: temporal
  namespace: temporal
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: temporal
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
```

Key Temporal metrics to monitor:
- `temporal_worker_task_slots_available`: Available worker capacity
- `temporal_workflow_task_queue_poll_succeed_per_second`: Throughput
- `temporal_activity_task_queue_poll_succeed_per_second`: Activity throughput
- `temporal_persistence_requests`: Database pressure
- `temporal_workflow_endtoend_latency`: End-to-end workflow duration

## Conclusion

Temporal transforms complex, failure-prone distributed operations into reliable, observable workflows. The durable execution model eliminates entire classes of bugs: lost state after crashes, duplicate operations from retry storms, and difficult-to-debug partial failures. By deploying Temporal on Kubernetes and structuring business processes as explicit workflows with compensating activities, teams gain automatic retry handling, full execution history, real-time observability through the Web UI, and the ability to safely evolve workflow logic using the versioning API. The workflow-as-code approach makes complex business processes auditable, testable, and maintainable in ways that scattered retry logic never can be.
