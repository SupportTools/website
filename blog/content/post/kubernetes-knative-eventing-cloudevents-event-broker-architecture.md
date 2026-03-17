---
title: "Kubernetes Knative Eventing: CloudEvents-Based Event Broker Architecture"
date: 2031-05-05T00:00:00-05:00
draft: false
tags: ["Knative", "Kubernetes", "CloudEvents", "Event-Driven", "Kafka", "Eventing", "Serverless"]
categories: ["Kubernetes", "Event-Driven Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Build event-driven architectures on Kubernetes with Knative Eventing: broker/trigger/channel architecture, CloudEvents specification, KafkaChannel, source connectors, event filtering, and dead letter sinks."
more_link: "yes"
url: "/kubernetes-knative-eventing-cloudevents-event-broker-architecture/"
---

Knative Eventing provides a Kubernetes-native event mesh that implements the CloudEvents specification for interoperability. It decouples event producers from consumers through a broker/trigger model, enabling complex event routing, filtering, and retry semantics without tight service coupling. This guide covers the complete Knative Eventing architecture with production configurations for enterprise deployments.

<!--more-->

# Kubernetes Knative Eventing: CloudEvents-Based Event Broker Architecture

## Section 1: Knative Eventing Architecture

Knative Eventing has three primary abstractions:

**Sources** - Adapters that convert external events (GitHub webhooks, Kafka messages, GCP PubSub) into CloudEvents and forward them to a sink.

**Broker** - An event mesh that receives CloudEvents and routes them to subscribers based on filter criteria. The InMemoryChannel broker is for development; KafkaChannel broker is for production.

**Trigger** - A subscription to a Broker that filters events by attribute values (type, source, extension attributes) and delivers matching events to a Kubernetes Service.

```
External Events (GitHub, Kafka, GCP, custom)
          │
          ▼
    Source (adapter)
          │
          │ CloudEvents over HTTP
          ▼
       Broker
      /    |    \
     T1    T2    T3    (Triggers with filters)
     │     │     │
     ▼     ▼     ▼
  Svc-A  Svc-B  Svc-C  (Kubernetes Services / Knative Services)
```

The CloudEvents specification defines a common envelope for event data:

```
POST /events HTTP/1.1
Content-Type: application/cloudevents+json
ce-specversion: 1.0
ce-type: com.example.payment.created
ce-source: /payment-service/payments
ce-id: 550e8400-e29b-41d4-a716-446655440000
ce-time: 2031-05-05T10:00:00Z
ce-datacontenttype: application/json

{
  "payment_id": "pay_123",
  "amount": 9999,
  "currency": "USD",
  "order_id": "ord_456"
}
```

## Section 2: Installation

```bash
# Install Knative Eventing CRDs
kubectl apply -f https://github.com/knative/eventing/releases/download/knative-v1.14.0/eventing-crds.yaml

# Install Knative Eventing core
kubectl apply -f https://github.com/knative/eventing/releases/download/knative-v1.14.0/eventing-core.yaml

# Verify installation
kubectl wait --for=condition=Available \
  deployment/eventing-controller \
  deployment/eventing-webhook \
  -n knative-eventing \
  --timeout=300s

# Install InMemoryChannel (development/testing only)
kubectl apply -f https://github.com/knative/eventing/releases/download/knative-v1.14.0/in-memory-channel.yaml

# Install MT Channel Based Broker (used with InMemoryChannel for dev)
kubectl apply -f https://github.com/knative/eventing/releases/download/knative-v1.14.0/mt-channel-broker.yaml

# Verify CRDs
kubectl get crds | grep knative.dev
```

## Section 3: InMemoryChannel Broker (Development)

For development and testing, the InMemoryChannel broker requires no external dependencies:

```yaml
# development-broker.yaml
apiVersion: eventing.knative.dev/v1
kind: Broker
metadata:
  name: default
  namespace: dev
  annotations:
    eventing.knative.dev/broker.class: MTChannelBasedBroker
  labels:
    app.kubernetes.io/name: default-broker
    environment: dev
spec:
  config:
    apiVersion: v1
    kind: ConfigMap
    name: config-br-default-channel
    namespace: knative-eventing
  delivery:
    # Retry failed deliveries
    retry: 10
    backoffPolicy: exponential
    backoffDelay: PT2S  # ISO 8601 duration: 2 seconds
    timeout: PT10S
    # Dead letter sink for permanently failed events
    deadLetterSink:
      ref:
        apiVersion: v1
        kind: Service
        name: dead-letter-sink
        namespace: dev
```

## Section 4: KafkaChannel Broker (Production)

The KafkaChannel broker stores events in Kafka topics, providing durability and replay capability:

```bash
# Install Knative Kafka eventing
kubectl apply -f https://github.com/knative-extensions/eventing-kafka-broker/releases/download/knative-v1.14.0/eventing-kafka-controller.yaml
kubectl apply -f https://github.com/knative-extensions/eventing-kafka-broker/releases/download/knative-v1.14.0/eventing-kafka-broker.yaml

# Configure Kafka connection
kubectl create secret generic kafka-broker-config \
  --namespace knative-eventing \
  --from-literal=default.topic.replication.factor=3 \
  --from-literal=default.topic.bootstrap.servers=kafka-bootstrap.kafka.svc.cluster.local:9092 \
  --from-literal=default.topic.partitions=10
```

```yaml
# kafka-broker.yaml
apiVersion: eventing.knative.dev/v1
kind: Broker
metadata:
  name: kafka-broker
  namespace: production
  annotations:
    eventing.knative.dev/broker.class: Kafka
  labels:
    app.kubernetes.io/name: kafka-broker
    environment: production
spec:
  config:
    apiVersion: v1
    kind: ConfigMap
    name: kafka-broker-config
    namespace: knative-eventing
  delivery:
    retry: 5
    backoffPolicy: exponential
    backoffDelay: PT1S
    timeout: PT30S
    deadLetterSink:
      ref:
        apiVersion: v1
        kind: Service
        name: dead-letter-sink
```

```yaml
# kafka-broker-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-broker-config
  namespace: knative-eventing
data:
  default.topic.partitions: "10"
  default.topic.replication.factor: "3"
  default.topic.bootstrap.servers: "kafka-bootstrap.kafka.svc.cluster.local:9092"

  # Retention settings
  default.topic.retention.ms: "604800000"  # 7 days

  # Authentication (if Kafka requires SASL)
  # auth.secret.ref.name: kafka-broker-sasl-secret
```

## Section 5: Event Sources

### GitHub Source

```yaml
# github-source.yaml
apiVersion: sources.knative.dev/v1alpha1
kind: GitHubSource
metadata:
  name: github-payment-service
  namespace: production
spec:
  eventTypes:
    - push
    - pull_request
    - issues
    - release
  ownerAndRepository: myorg/payment-service
  accessToken:
    secretKeyRef:
      name: github-source-secret
      key: accessToken
  secretToken:
    secretKeyRef:
      name: github-source-secret
      key: secretToken
  sink:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: kafka-broker
      namespace: production
```

### Kafka Source

```yaml
# kafka-source.yaml
apiVersion: sources.knative.dev/v1beta1
kind: KafkaSource
metadata:
  name: payment-events-kafka-source
  namespace: production
spec:
  bootstrapServers:
    - kafka-bootstrap.kafka.svc.cluster.local:9092
  topics:
    - payments.events.v1
    - orders.events.v1
  consumerGroup: knative-payment-consumer
  sink:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: kafka-broker
      namespace: production

  # CloudEvents overrides for messages that aren't CloudEvents
  cloudevents:
    overrides:
      extensions:
        kafka-partition: "0"

  # SASL/TLS configuration
  # net:
  #   sasl:
  #     enable: true
  #     user:
  #       secretKeyRef:
  #         name: kafka-source-credentials
  #         key: username
  #     password:
  #       secretKeyRef:
  #         name: kafka-source-credentials
  #         key: password
  #     type:
  #       secretKeyRef:
  #         name: kafka-source-credentials
  #         key: saslType  # SCRAM-SHA-256 or SCRAM-SHA-512
  #   tls:
  #     enable: true
  #     caCert:
  #       secretKeyRef:
  #         name: kafka-source-credentials
  #         key: tls.crt
```

### SinkBinding (Injecting Event Destination into Pods)

```yaml
# sinkbinding.yaml
# SinkBinding injects the broker URL into the SOURCE_URL env var of a Deployment
apiVersion: sources.knative.dev/v1
kind: SinkBinding
metadata:
  name: payment-service-binding
  namespace: production
spec:
  subject:
    apiVersion: apps/v1
    kind: Deployment
    selector:
      matchLabels:
        app: payment-service
  sink:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: kafka-broker
      namespace: production
  # The K_SINK environment variable will be injected automatically
  # pointing to the Broker's URL
  # Your application uses os.Getenv("K_SINK") to find where to send events
```

In the payment service, publish CloudEvents using the injected sink:

```go
// internal/events/publisher.go
package events

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	cloudevents "github.com/cloudevents/sdk-go/v2"
	"github.com/google/uuid"
)

// Publisher publishes CloudEvents to the configured sink.
type Publisher struct {
	client cloudevents.Client
}

// NewPublisher creates a new CloudEvents publisher using K_SINK environment variable.
func NewPublisher() (*Publisher, error) {
	sink := os.Getenv("K_SINK")
	if sink == "" {
		return nil, fmt.Errorf("K_SINK environment variable not set")
	}

	c, err := cloudevents.NewClientHTTP(
		cloudevents.WithTarget(sink),
		cloudevents.WithMiddleware(func(next http.Handler) http.Handler {
			return http.TimeoutHandler(next, 10*time.Second, "CloudEvent send timeout")
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("creating CloudEvents client: %w", err)
	}

	return &Publisher{client: c}, nil
}

// PaymentCreatedEvent is the data for a payment.created CloudEvent.
type PaymentCreatedEvent struct {
	PaymentID  string            `json:"payment_id"`
	OrderID    string            `json:"order_id"`
	Amount     int64             `json:"amount"`
	Currency   string            `json:"currency"`
	CustomerID string            `json:"customer_id"`
	Metadata   map[string]string `json:"metadata,omitempty"`
}

// PublishPaymentCreated publishes a payment.created CloudEvent.
func (p *Publisher) PublishPaymentCreated(ctx context.Context, data *PaymentCreatedEvent) error {
	event := cloudevents.NewEvent()
	event.SetID(uuid.New().String())
	event.SetType("com.mycompany.payment.created")
	event.SetSource("/payment-service/payments")
	event.SetTime(time.Now())
	event.SetDataContentType("application/json")

	// Custom extensions (can be used in Trigger filters)
	event.SetExtension("paymentid", data.PaymentID)
	event.SetExtension("customerid", data.CustomerID)
	event.SetExtension("currency", data.Currency)

	if err := event.SetData("application/json", data); err != nil {
		return fmt.Errorf("setting event data: %w", err)
	}

	result := p.client.Send(ctx, event)
	if cloudevents.IsUndelivered(result) {
		return fmt.Errorf("failed to deliver CloudEvent: %w", result)
	}

	return nil
}

// PublishPaymentStatusChanged publishes a payment.status.changed event.
func (p *Publisher) PublishPaymentStatusChanged(
	ctx context.Context,
	paymentID string,
	previousStatus string,
	newStatus string,
) error {
	type StatusChangedData struct {
		PaymentID      string `json:"payment_id"`
		PreviousStatus string `json:"previous_status"`
		NewStatus      string `json:"new_status"`
	}

	event := cloudevents.NewEvent()
	event.SetID(uuid.New().String())
	event.SetType("com.mycompany.payment.status.changed")
	event.SetSource("/payment-service/payments/" + paymentID)
	event.SetTime(time.Now())
	event.SetExtension("paymentid", paymentID)
	event.SetExtension("previousstatus", previousStatus)
	event.SetExtension("newstatus", newStatus)

	if err := event.SetData("application/json", &StatusChangedData{
		PaymentID:      paymentID,
		PreviousStatus: previousStatus,
		NewStatus:      newStatus,
	}); err != nil {
		return fmt.Errorf("setting event data: %w", err)
	}

	result := p.client.Send(ctx, event)
	if cloudevents.IsUndelivered(result) {
		return fmt.Errorf("failed to deliver event: %w", result)
	}

	return nil
}
```

## Section 6: Triggers with Event Filtering

Triggers subscribe to events from a Broker with optional filter criteria:

```yaml
# triggers.yaml

# Trigger 1: Notification service receives ALL payment events
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: payment-notification-trigger
  namespace: production
  labels:
    app.kubernetes.io/name: payment-notification-trigger
spec:
  broker: kafka-broker
  filter:
    attributes:
      # Filter by CloudEvent type prefix
      type: com.mycompany.payment.created
  delivery:
    retry: 5
    backoffPolicy: exponential
    backoffDelay: PT2S
    timeout: PT30S
    deadLetterSink:
      ref:
        apiVersion: v1
        kind: Service
        name: dead-letter-sink
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: notification-service
      namespace: production
    # Optional URI override (if different from service port)
    uri: /api/v1/events/payment-created

---
# Trigger 2: Analytics service receives completed payments
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: payment-analytics-trigger
  namespace: production
spec:
  broker: kafka-broker
  filter:
    attributes:
      type: com.mycompany.payment.status.changed
      # Filter by extension attribute
      newstatus: "COMPLETED"
  delivery:
    retry: 3
    backoffPolicy: linear
    backoffDelay: PT5S
    deadLetterSink:
      ref:
        apiVersion: v1
        kind: Service
        name: dead-letter-sink
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: analytics-service
      namespace: production

---
# Trigger 3: Fraud detection for all payment events
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: fraud-detection-trigger
  namespace: production
spec:
  broker: kafka-broker
  filter:
    # CESQL filter (more expressive than attribute matching)
    cesql: >
      type LIKE 'com.mycompany.payment.%'
      AND currency IN ('USD', 'EUR', 'GBP')
  delivery:
    retry: 2
    backoffPolicy: exponential
    backoffDelay: PT1S
    timeout: PT5S
    deadLetterSink:
      uri: http://fraud-dead-letter.production.svc.cluster.local/events
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: fraud-detection-service
      namespace: production

---
# Trigger 4: Multi-attribute filtering
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: vip-customer-trigger
  namespace: production
spec:
  broker: kafka-broker
  filter:
    attributes:
      type: com.mycompany.payment.created
      # Filter by customer tier (custom extension)
      customertier: "VIP"
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: vip-processing-service
      namespace: production
```

## Section 7: CloudEvent Receiver - Kubernetes Service

The subscriber service receives CloudEvents via HTTP POST:

```go
// internal/handler/payment_event_handler.go
package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	cloudevents "github.com/cloudevents/sdk-go/v2"
)

// PaymentEventHandler handles incoming CloudEvents.
type PaymentEventHandler struct {
	logger         *slog.Logger
	notificationSvc NotificationService
}

// PaymentCreatedEvent is the CloudEvent data payload.
type PaymentCreatedEvent struct {
	PaymentID  string            `json:"payment_id"`
	OrderID    string            `json:"order_id"`
	Amount     int64             `json:"amount"`
	Currency   string            `json:"currency"`
	CustomerID string            `json:"customer_id"`
	Metadata   map[string]string `json:"metadata,omitempty"`
}

// ServeHTTP handles incoming CloudEvents.
func (h *PaymentEventHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Parse the CloudEvent
	event, err := cloudevents.NewEventFromHTTPRequest(r)
	if err != nil {
		h.logger.Error("failed to parse CloudEvent", "error", err)
		http.Error(w, "invalid CloudEvent", http.StatusBadRequest)
		return
	}

	// Log the event
	h.logger.Info("received CloudEvent",
		"id", event.ID(),
		"type", event.Type(),
		"source", event.Source(),
		"subject", event.Subject(),
	)

	// Route by event type
	switch event.Type() {
	case "com.mycompany.payment.created":
		if err := h.handlePaymentCreated(ctx, event); err != nil {
			h.logger.Error("failed to handle payment.created", "error", err, "event_id", event.ID())
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

	case "com.mycompany.payment.status.changed":
		if err := h.handlePaymentStatusChanged(ctx, event); err != nil {
			h.logger.Error("failed to handle payment.status.changed", "error", err, "event_id", event.ID())
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

	default:
		h.logger.Warn("unknown event type", "type", event.Type())
		// Return 200 to prevent Knative from retrying unknown events
		w.WriteHeader(http.StatusOK)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (h *PaymentEventHandler) handlePaymentCreated(ctx context.Context, event cloudevents.Event) error {
	var data PaymentCreatedEvent
	if err := event.DataAs(&data); err != nil {
		return fmt.Errorf("parsing payment.created data: %w", err)
	}

	// Send notification
	return h.notificationSvc.SendPaymentConfirmation(ctx, data.CustomerID, data.PaymentID, data.Amount)
}

func (h *PaymentEventHandler) handlePaymentStatusChanged(ctx context.Context, event cloudevents.Event) error {
	type StatusChangedData struct {
		PaymentID      string `json:"payment_id"`
		PreviousStatus string `json:"previous_status"`
		NewStatus      string `json:"new_status"`
	}

	var data StatusChangedData
	if err := event.DataAs(&data); err != nil {
		return fmt.Errorf("parsing status.changed data: %w", err)
	}

	if data.NewStatus == "COMPLETED" {
		return h.notificationSvc.SendPaymentSuccessNotification(ctx, data.PaymentID)
	}

	if data.NewStatus == "FAILED" {
		return h.notificationSvc.SendPaymentFailureNotification(ctx, data.PaymentID)
	}

	return nil
}

// StartHTTPServer starts the CloudEvent receiver HTTP server.
func StartHTTPServer(handler *PaymentEventHandler, port string) error {
	mux := http.NewServeMux()
	mux.Handle("/api/v1/events/payment-created", handler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	return srv.ListenAndServe()
}
```

## Section 8: Channels for Ordered Event Processing

Channels provide ordering guarantees for events that need to be processed sequentially:

```yaml
# kafka-channel.yaml
apiVersion: messaging.knative.dev/v1
kind: Channel
metadata:
  name: payment-processing-channel
  namespace: production
  annotations:
    # Use KafkaChannel for durable, ordered delivery
    messaging.knative.dev/subscribable: "true"
spec:
  channelTemplate:
    apiVersion: messaging.knative.dev/v1beta1
    kind: KafkaChannel
    spec:
      numPartitions: 10
      replicationFactor: 3
      retention:
        duration: 168h  # 7 days

---
# Subscription routes Channel events to subscribers
apiVersion: messaging.knative.dev/v1
kind: Subscription
metadata:
  name: payment-processor-subscription
  namespace: production
spec:
  channel:
    apiVersion: messaging.knative.dev/v1
    kind: Channel
    name: payment-processing-channel
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: payment-processor
      namespace: production
  reply:
    # Events returned by the subscriber go to the reply channel
    ref:
      apiVersion: messaging.knative.dev/v1
      kind: Channel
      name: payment-replies-channel
  delivery:
    retry: 5
    backoffPolicy: exponential
    backoffDelay: PT2S
    deadLetterSink:
      ref:
        apiVersion: v1
        kind: Service
        name: dead-letter-sink
```

## Section 9: Event Filtering with CESQL

CESQL (CloudEvents Subscriptions Query Language) provides SQL-like filtering:

```yaml
# Advanced CESQL filtering examples

# Filter 1: Complex business logic filter
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: high-value-payment-trigger
  namespace: production
spec:
  broker: kafka-broker
  filter:
    cesql: >
      type = 'com.mycompany.payment.created'
      AND (
        currency = 'USD' AND amount >= 100000
        OR currency = 'EUR' AND amount >= 90000
        OR currency = 'GBP' AND amount >= 80000
      )
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: high-value-payment-service

---
# Filter 2: Time-based processing (using extensions)
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: business-hours-trigger
  namespace: production
spec:
  broker: kafka-broker
  filter:
    cesql: >
      type LIKE 'com.mycompany.payment.%'
      AND (
        source LIKE '/payment-service/%'
        OR source LIKE '/order-service/%'
      )
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: payment-audit-service

---
# Filter 3: Exclude specific sources
apiVersion: eventing.knative.dev/v1
kind: Trigger
metadata:
  name: external-payment-trigger
  namespace: production
spec:
  broker: kafka-broker
  filter:
    cesql: >
      type = 'com.mycompany.payment.created'
      AND NOT source LIKE '/internal/%'
  subscriber:
    ref:
      apiVersion: v1
      kind: Service
      name: external-payment-processor
```

## Section 10: Dead Letter Sinks

Configure robust dead letter handling for failed event deliveries:

```go
// cmd/dead-letter-sink/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	cloudevents "github.com/cloudevents/sdk-go/v2"
)

// DeadLetterRecord stores information about a failed event delivery.
type DeadLetterRecord struct {
	Event        cloudevents.Event `json:"event"`
	DeadLetterAt time.Time         `json:"dead_letter_at"`
	ErrorMessage string            `json:"error_message,omitempty"`
	RetryCount   int               `json:"retry_count,omitempty"`
	TriggerName  string            `json:"trigger_name,omitempty"`
}

type deadLetterSink struct {
	logger  *slog.Logger
	storage DeadLetterStorage
	alerter Alerter
}

func (s *deadLetterSink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	event, err := cloudevents.NewEventFromHTTPRequest(r)
	if err != nil {
		s.logger.Error("failed to parse dead letter event", "error", err)
		http.Error(w, "invalid CloudEvent", http.StatusBadRequest)
		return
	}

	// Extract dead letter metadata from Knative extensions
	// Knative adds knativeerrorcode, knativeerrordata when routing to DLS
	errorCode := r.Header.Get("Ce-Knativeerrorcode")
	errorData := r.Header.Get("Ce-Knativeerrordata")

	record := DeadLetterRecord{
		Event:        *event,
		DeadLetterAt: time.Now(),
		ErrorMessage: fmt.Sprintf("code=%s data=%s", errorCode, errorData),
	}

	// Persist to storage (database, S3, etc.)
	if err := s.storage.Save(r.Context(), record); err != nil {
		s.logger.Error("failed to save dead letter event",
			"event_id", event.ID(),
			"error", err,
		)
	}

	// Alert for critical event types
	if isCritical(event.Type()) {
		s.alerter.Alert(r.Context(), fmt.Sprintf(
			"Critical event %s (id=%s) reached dead letter sink: %s",
			event.Type(), event.ID(), errorCode,
		))
	}

	s.logger.Error("event reached dead letter sink",
		"event_id", event.ID(),
		"event_type", event.Type(),
		"event_source", event.Source(),
		"error_code", errorCode,
		"error_data", errorData,
	)

	w.WriteHeader(http.StatusOK)
}

func isCritical(eventType string) bool {
	critical := []string{
		"com.mycompany.payment.created",
		"com.mycompany.order.fulfilled",
	}
	for _, c := range critical {
		if eventType == c {
			return true
		}
	}
	return false
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	sink := &deadLetterSink{
		logger: logger,
		// Initialize storage and alerter
	}

	mux := http.NewServeMux()
	mux.Handle("/events", sink)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	logger.Info("Dead letter sink starting", "addr", ":8080")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}
}
```

```yaml
# dead-letter-sink-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dead-letter-sink
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: dead-letter-sink
  template:
    metadata:
      labels:
        app: dead-letter-sink
    spec:
      containers:
        - name: dead-letter-sink
          image: ghcr.io/myorg/dead-letter-sink:latest
          ports:
            - containerPort: 8080
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: dead-letter-db-secret
                  key: url
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10

---
apiVersion: v1
kind: Service
metadata:
  name: dead-letter-sink
  namespace: production
spec:
  selector:
    app: dead-letter-sink
  ports:
    - port: 80
      targetPort: 8080
```

## Section 11: Event Sequence and Parallel Flow

Knative Eventing's Sequence resource chains events through multiple services:

```yaml
# event-sequence.yaml
apiVersion: flows.knative.dev/v1
kind: Sequence
metadata:
  name: payment-processing-sequence
  namespace: production
spec:
  channelTemplate:
    apiVersion: messaging.knative.dev/v1beta1
    kind: KafkaChannel
    spec:
      numPartitions: 10
      replicationFactor: 3

  steps:
    # Step 1: Validate payment
    - ref:
        apiVersion: v1
        kind: Service
        name: payment-validator
      delivery:
        retry: 3
        deadLetterSink:
          ref:
            apiVersion: v1
            kind: Service
            name: dead-letter-sink

    # Step 2: Fraud check (only executed if validator succeeds)
    - ref:
        apiVersion: v1
        kind: Service
        name: fraud-detector
      delivery:
        retry: 2
        backoffDelay: PT1S

    # Step 3: Process payment
    - ref:
        apiVersion: v1
        kind: Service
        name: payment-processor
      delivery:
        retry: 5
        backoffPolicy: exponential
        backoffDelay: PT2S

    # Step 4: Send confirmation
    - ref:
        apiVersion: v1
        kind: Service
        name: notification-service

  reply:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: kafka-broker

---
# Parallel executes multiple steps concurrently
apiVersion: flows.knative.dev/v1
kind: Parallel
metadata:
  name: payment-notification-parallel
  namespace: production
spec:
  channelTemplate:
    apiVersion: messaging.knative.dev/v1beta1
    kind: KafkaChannel
    spec:
      numPartitions: 3
      replicationFactor: 3

  branches:
    # Branch 1: Email notification
    - filter:
        ref:
          apiVersion: v1
          kind: Service
          name: email-filter-service
      subscriber:
        ref:
          apiVersion: v1
          kind: Service
          name: email-notification-service

    # Branch 2: SMS notification
    - filter:
        ref:
          apiVersion: v1
          kind: Service
          name: sms-filter-service
      subscriber:
        ref:
          apiVersion: v1
          kind: Service
          name: sms-notification-service

    # Branch 3: Push notification
    - subscriber:
        ref:
          apiVersion: v1
          kind: Service
          name: push-notification-service

  reply:
    ref:
      apiVersion: eventing.knative.dev/v1
      kind: Broker
      name: kafka-broker
```

## Section 12: Observability and Debugging

```bash
# Check broker status
kubectl get broker -n production
kubectl describe broker kafka-broker -n production

# Check trigger status
kubectl get trigger -n production
kubectl describe trigger payment-notification-trigger -n production

# Check source status
kubectl get kafkasource -n production

# View event flow logs
kubectl logs -n knative-eventing deployment/kafka-broker-receiver -f
kubectl logs -n knative-eventing deployment/kafka-broker-dispatcher -f

# Monitor KafkaChannel topics
kubectl exec -it -n kafka kafka-0 -- \
  kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --describe \
    --group knative-trigger-payment-notification-trigger-default

# Count events in dead letter topic
kubectl exec -it -n kafka kafka-0 -- \
  kafka-console-consumer.sh \
    --bootstrap-server localhost:9092 \
    --topic knative-trigger-payment-notification-trigger-default-dead-letter \
    --from-beginning \
    --max-messages 100

# Send a test CloudEvent to the broker
BROKER_URL=$(kubectl get broker kafka-broker -n production -o jsonpath='{.status.address.url}')

kubectl run cloudevents-tester \
  --image=curlimages/curl \
  --restart=Never \
  --rm \
  -it \
  -- curl -v "$BROKER_URL" \
    -H "Content-Type: application/cloudevents+json" \
    -H "Ce-Specversion: 1.0" \
    -H "Ce-Type: com.mycompany.payment.created" \
    -H "Ce-Source: /test/manual" \
    -H "Ce-Id: test-event-001" \
    -H "Ce-Currency: USD" \
    -d '{"payment_id": "test-123", "amount": 9999, "currency": "USD"}'

# Install kn CLI for managing Knative resources
curl -L https://github.com/knative/client/releases/download/knative-v1.14.0/kn-linux-amd64 \
  -o /usr/local/bin/kn
chmod +x /usr/local/bin/kn

# List sources and triggers
kn source list -n production
kn trigger list -n production

# Describe trigger with filter details
kn trigger describe payment-notification-trigger -n production
```

## Summary

Knative Eventing provides enterprise-grade event-driven architecture on Kubernetes through:

1. **Broker/Trigger model** decouples producers from consumers - adding a new consumer never requires changing the producer
2. **KafkaChannel broker** provides durable, ordered, and replayable event storage for production
3. **CloudEvents specification** ensures interoperability with any language or platform that implements the spec
4. **CESQL filters** enable complex routing logic without custom code
5. **Sequences** chain event processing steps with automatic retry and dead-letter routing
6. **Parallel** executes multiple processing branches concurrently from a single event
7. **Dead letter sinks** capture all failed deliveries for audit and manual reprocessing
8. **SinkBinding** injects event destination URLs into pods for zero-configuration event publishing

Start with InMemoryChannel for development to iterate quickly on event schemas and routing logic. Migrate to KafkaChannel for production once the event flow is validated, as it provides the durability and ordering guarantees required for payment and order processing systems.
