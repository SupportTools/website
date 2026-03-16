---
title: "Monolith to Microservices Migration: Real-World Go Architecture"
date: 2026-09-26T00:00:00-05:00
draft: false
tags: ["Microservices", "Go", "Architecture", "Migration", "gRPC", "Domain-Driven Design"]
categories: ["Software Architecture", "Go", "Microservices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to migrating from monolithic to microservices architecture using Go, including domain-driven design principles, service communication patterns, data separation strategies, and production deployment patterns based on a real-world migration project."
more_link: "yes"
url: "/monolith-to-microservices-migration-go-architecture/"
---

"We need to scale the task management system, but the monolith is holding us back." This statement kicked off a nine-month migration project that transformed a 150,000-line Go monolith into a distributed microservices architecture. The journey was challenging, filled with architectural decisions, technical challenges, and valuable lessons about when (and when not) to break apart a monolith.

This post chronicles that migration, from initial assessment through production deployment, including the architectural patterns, code examples, and hard-won lessons that made the difference between success and failure. If you're considering a similar migration, this is the comprehensive guide I wish we'd had at the start.

<!--more-->

## The Starting Point: Taskman Monolith

### Application Overview

Taskman was a task management and workflow automation platform serving 50,000+ users across 200+ enterprise customers. The monolithic application handled:

- User authentication and authorization
- Task creation, assignment, and tracking
- Workflow definition and execution
- Notification delivery (email, SMS, webhooks)
- Reporting and analytics
- File storage and processing
- API integrations with external systems

### The Monolith Architecture

```
taskman/
├── cmd/
│   └── server/
│       └── main.go           # 500 lines
├── internal/
│   ├── auth/                 # 15,000 lines
│   ├── tasks/                # 35,000 lines
│   ├── workflows/            # 25,000 lines
│   ├── notifications/        # 12,000 lines
│   ├── reports/              # 20,000 lines
│   ├── storage/              # 8,000 lines
│   ├── integrations/         # 18,000 lines
│   └── database/             # 7,000 lines
├── pkg/
│   ├── models/               # 10,000 lines
│   └── utils/                # 5,000 lines
└── vendor/                   # Dependencies

Total: ~150,000 lines of Go code
Single PostgreSQL database: 143 tables
Deployment: Single binary, 6 instances behind ALB
```

### The Problems

#### 1. Scaling Limitations

Different components had vastly different resource requirements:

```
Component          CPU Usage    Memory Usage    Scale Needs
-----------------------------------------------------------------
Auth               Low (5%)     Low (200MB)     Rarely
Task Management    Medium (30%) Medium (800MB)  Moderate
Workflow Engine    High (70%)   High (2GB)      Frequent
Notifications      Low (10%)    Low (300MB)     Spiky
Reports            Very High    Very High       Scheduled
Integrations       Medium       Medium          Per-customer
```

When workflow execution spiked, we had to scale the entire application, wasting resources on components that didn't need scaling.

#### 2. Deployment Risk

Every deployment was high-risk:
- 15-20 minute deployment window
- Required coordination across teams
- Small changes to notifications required full application deployment
- Rollback meant reverting everything, not just the problematic component
- Database migrations blocked all deployments

#### 3. Development Velocity

- Build time: 8 minutes for full binary
- Test suite: 45 minutes for complete run
- Tight coupling made changes risky
- Multiple teams blocking each other
- Difficult to onboard new developers

#### 4. Database Bottleneck

All components shared a single PostgreSQL instance:

```sql
-- Query from task service
SELECT * FROM tasks WHERE user_id = $1;

-- Simultaneously, workflow engine running
SELECT * FROM workflow_executions
WHERE status = 'running'
ORDER BY created_at
LIMIT 1000;

-- And reporting service executing
SELECT date_trunc('day', created_at), count(*)
FROM tasks
WHERE created_at > now() - interval '90 days'
GROUP BY 1;
```

Result: Lock contention, slow queries, connection pool exhaustion.

## Migration Strategy

### Phase 1: Assessment and Planning

We used the Strangler Fig pattern, gradually extracting services while maintaining the monolith. The extraction order was based on:

1. **Business value**: Which services provide immediate ROI?
2. **Independence**: Which components have minimal dependencies?
3. **Resource needs**: Which components have distinct scaling requirements?
4. **Change frequency**: Which components change most often?

Our extraction order:

```
Phase 1 (Months 1-3):
  1. Notifications Service    (Low coupling, clear boundaries)
  2. Reports Service           (High resource usage, scheduled)

Phase 2 (Months 4-6):
  3. Integrations Service      (Per-customer scaling)
  4. Storage Service           (Distinct infrastructure needs)

Phase 3 (Months 7-9):
  5. Workflow Service          (Core business logic, complex)
  6. Task Service              (Central to application)
  7. Auth Service              (Critical, extract last)
```

### Phase 2: Service Boundaries

We applied Domain-Driven Design to define service boundaries:

```go
// Before: All in monolith
package models

type Task struct {
    ID              string
    UserID          string
    Title           string
    Description     string
    Status          string
    AssignedTo      string
    CreatedAt       time.Time
    UpdatedAt       time.Time
    // 30+ more fields mixing concerns
    NotificationsSent   []Notification
    WorkflowExecutionID string
    FileAttachments     []File
    IntegrationData     map[string]interface{}
}

// After: Clear boundaries
// Task Service
package task

type Task struct {
    ID          string
    UserID      string
    Title       string
    Description string
    Status      TaskStatus
    AssignedTo  string
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

// Notification Service
package notification

type TaskNotification struct {
    TaskID      string  // Reference, not embedded
    RecipientID string
    Type        NotificationType
    SentAt      time.Time
}

// Workflow Service
package workflow

type WorkflowExecution struct {
    ID          string
    WorkflowID  string
    TaskID      string  // Reference
    Status      ExecutionStatus
    StartedAt   time.Time
    CompletedAt *time.Time
}
```

## Implementation: Service Extraction

### Example 1: Notifications Service

The notifications service was our first extraction - relatively independent with clear boundaries.

#### Service Structure

```
notifications-service/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── api/
│   │   ├── grpc/
│   │   │   ├── server.go
│   │   │   └── handlers.go
│   │   └── rest/
│   │       ├── server.go
│   │       └── handlers.go
│   ├── domain/
│   │   ├── notification.go
│   │   ├── repository.go
│   │   └── service.go
│   ├── providers/
│   │   ├── email/
│   │   │   ├── smtp.go
│   │   │   └── sendgrid.go
│   │   ├── sms/
│   │   │   └── twilio.go
│   │   └── webhook/
│   │       └── client.go
│   └── storage/
│       └── postgres/
│           └── repository.go
├── pkg/
│   └── pb/
│       └── notifications.pb.go
├── deployments/
│   └── kubernetes/
│       ├── deployment.yaml
│       └── service.yaml
└── proto/
    └── notifications.proto
```

#### gRPC Service Definition

```protobuf
// proto/notifications.proto
syntax = "proto3";

package notifications.v1;

option go_package = "github.com/taskman/notifications-service/pkg/pb";

service NotificationService {
  // Send a notification
  rpc SendNotification(SendNotificationRequest) returns (SendNotificationResponse);

  // Get notification status
  rpc GetNotification(GetNotificationRequest) returns (Notification);

  // List notifications for a user
  rpc ListNotifications(ListNotificationsRequest) returns (ListNotificationsResponse);

  // Mark notification as read
  rpc MarkAsRead(MarkAsReadRequest) returns (MarkAsReadResponse);

  // Stream notification events
  rpc StreamNotifications(StreamNotificationsRequest) returns (stream NotificationEvent);
}

message SendNotificationRequest {
  string user_id = 1;
  NotificationType type = 2;
  string subject = 3;
  string body = 4;
  map<string, string> metadata = 5;
  Priority priority = 6;
}

message SendNotificationResponse {
  string notification_id = 1;
  NotificationStatus status = 2;
}

message Notification {
  string id = 1;
  string user_id = 2;
  NotificationType type = 3;
  string subject = 4;
  string body = 5;
  NotificationStatus status = 6;
  int64 created_at = 7;
  int64 sent_at = 8;
  int64 read_at = 9;
  map<string, string> metadata = 10;
}

enum NotificationType {
  EMAIL = 0;
  SMS = 1;
  WEBHOOK = 2;
  IN_APP = 3;
}

enum NotificationStatus {
  PENDING = 0;
  SENT = 1;
  DELIVERED = 2;
  FAILED = 3;
  READ = 4;
}

enum Priority {
  LOW = 0;
  NORMAL = 1;
  HIGH = 2;
  URGENT = 3;
}

message GetNotificationRequest {
  string notification_id = 1;
}

message ListNotificationsRequest {
  string user_id = 1;
  int32 page_size = 2;
  string page_token = 3;
  NotificationStatus status = 4;
  NotificationType type = 5;
}

message ListNotificationsResponse {
  repeated Notification notifications = 1;
  string next_page_token = 2;
  int32 total_count = 3;
}

message MarkAsReadRequest {
  string notification_id = 1;
  string user_id = 2;
}

message MarkAsReadResponse {
  bool success = 1;
}

message StreamNotificationsRequest {
  string user_id = 1;
}

message NotificationEvent {
  string event_type = 1;
  Notification notification = 2;
  int64 timestamp = 3;
}
```

#### Domain Service Implementation

```go
// internal/domain/service.go
package domain

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
    "go.uber.org/zap"
)

type NotificationService struct {
    repo      Repository
    providers map[NotificationType]NotificationProvider
    logger    *zap.Logger
}

func NewNotificationService(
    repo Repository,
    providers map[NotificationType]NotificationProvider,
    logger *zap.Logger,
) *NotificationService {
    return &NotificationService{
        repo:      repo,
        providers: providers,
        logger:    logger,
    }
}

func (s *NotificationService) SendNotification(
    ctx context.Context,
    req *SendNotificationRequest,
) (*Notification, error) {
    // Create notification entity
    notification := &Notification{
        ID:        uuid.New().String(),
        UserID:    req.UserID,
        Type:      req.Type,
        Subject:   req.Subject,
        Body:      req.Body,
        Priority:  req.Priority,
        Status:    NotificationStatusPending,
        Metadata:  req.Metadata,
        CreatedAt: time.Now(),
    }

    // Persist notification
    if err := s.repo.Create(ctx, notification); err != nil {
        s.logger.Error("Failed to create notification",
            zap.Error(err),
            zap.String("user_id", req.UserID),
        )
        return nil, fmt.Errorf("failed to create notification: %w", err)
    }

    // Send asynchronously based on priority
    if notification.Priority == PriorityUrgent {
        // Send immediately
        go s.sendNotification(context.Background(), notification)
    } else {
        // Queue for batch processing
        if err := s.queueNotification(ctx, notification); err != nil {
            s.logger.Warn("Failed to queue notification",
                zap.Error(err),
                zap.String("notification_id", notification.ID),
            )
        }
    }

    return notification, nil
}

func (s *NotificationService) sendNotification(ctx context.Context, notification *Notification) {
    provider, exists := s.providers[notification.Type]
    if !exists {
        s.logger.Error("No provider for notification type",
            zap.String("type", string(notification.Type)),
        )
        s.updateStatus(ctx, notification.ID, NotificationStatusFailed)
        return
    }

    // Attempt to send with retries
    maxRetries := 3
    var lastErr error

    for attempt := 0; attempt < maxRetries; attempt++ {
        if attempt > 0 {
            // Exponential backoff
            backoff := time.Duration(1<<uint(attempt)) * time.Second
            time.Sleep(backoff)
        }

        err := provider.Send(ctx, notification)
        if err == nil {
            // Success
            notification.SentAt = time.Now()
            notification.Status = NotificationStatusSent
            s.repo.Update(ctx, notification)

            s.logger.Info("Notification sent successfully",
                zap.String("notification_id", notification.ID),
                zap.String("type", string(notification.Type)),
                zap.Int("attempt", attempt+1),
            )
            return
        }

        lastErr = err
        s.logger.Warn("Failed to send notification",
            zap.Error(err),
            zap.String("notification_id", notification.ID),
            zap.Int("attempt", attempt+1),
        )
    }

    // All retries failed
    notification.Status = NotificationStatusFailed
    s.repo.Update(ctx, notification)

    s.logger.Error("Notification failed after retries",
        zap.Error(lastErr),
        zap.String("notification_id", notification.ID),
        zap.Int("max_retries", maxRetries),
    )
}

func (s *NotificationService) GetNotification(
    ctx context.Context,
    notificationID string,
) (*Notification, error) {
    return s.repo.GetByID(ctx, notificationID)
}

func (s *NotificationService) ListNotifications(
    ctx context.Context,
    req *ListNotificationsRequest,
) ([]*Notification, string, error) {
    notifications, err := s.repo.List(ctx, &RepositoryListOptions{
        UserID:    req.UserID,
        Status:    req.Status,
        Type:      req.Type,
        PageSize:  req.PageSize,
        PageToken: req.PageToken,
    })
    if err != nil {
        return nil, "", err
    }

    // Generate next page token
    var nextToken string
    if len(notifications) == req.PageSize {
        nextToken = notifications[len(notifications)-1].ID
    }

    return notifications, nextToken, nil
}

func (s *NotificationService) MarkAsRead(
    ctx context.Context,
    notificationID, userID string,
) error {
    notification, err := s.repo.GetByID(ctx, notificationID)
    if err != nil {
        return err
    }

    // Verify ownership
    if notification.UserID != userID {
        return ErrUnauthorized
    }

    now := time.Now()
    notification.ReadAt = &now
    notification.Status = NotificationStatusRead

    return s.repo.Update(ctx, notification)
}

func (s *NotificationService) queueNotification(ctx context.Context, notification *Notification) error {
    // Implementation depends on message queue (NATS, Kafka, RabbitMQ, etc.)
    // For now, simplified version
    return nil
}

func (s *NotificationService) updateStatus(ctx context.Context, id string, status NotificationStatus) {
    notification, err := s.repo.GetByID(ctx, id)
    if err != nil {
        s.logger.Error("Failed to get notification for status update",
            zap.Error(err),
            zap.String("notification_id", id),
        )
        return
    }

    notification.Status = status
    if err := s.repo.Update(ctx, notification); err != nil {
        s.logger.Error("Failed to update notification status",
            zap.Error(err),
            zap.String("notification_id", id),
        )
    }
}
```

#### gRPC Server Implementation

```go
// internal/api/grpc/server.go
package grpc

import (
    "context"

    "github.com/taskman/notifications-service/internal/domain"
    pb "github.com/taskman/notifications-service/pkg/pb"
    "go.uber.org/zap"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type Server struct {
    pb.UnimplementedNotificationServiceServer
    service *domain.NotificationService
    logger  *zap.Logger
}

func NewServer(service *domain.NotificationService, logger *zap.Logger) *Server {
    return &Server{
        service: service,
        logger:  logger,
    }
}

func (s *Server) SendNotification(
    ctx context.Context,
    req *pb.SendNotificationRequest,
) (*pb.SendNotificationResponse, error) {
    // Validate request
    if err := validateSendRequest(req); err != nil {
        return nil, status.Errorf(codes.InvalidArgument, "invalid request: %v", err)
    }

    // Convert to domain model
    domainReq := &domain.SendNotificationRequest{
        UserID:   req.UserId,
        Type:     domain.NotificationType(req.Type),
        Subject:  req.Subject,
        Body:     req.Body,
        Priority: domain.Priority(req.Priority),
        Metadata: req.Metadata,
    }

    // Send notification
    notification, err := s.service.SendNotification(ctx, domainReq)
    if err != nil {
        s.logger.Error("Failed to send notification",
            zap.Error(err),
            zap.String("user_id", req.UserId),
        )
        return nil, status.Errorf(codes.Internal, "failed to send notification: %v", err)
    }

    // Convert to protobuf response
    return &pb.SendNotificationResponse{
        NotificationId: notification.ID,
        Status:         pb.NotificationStatus(notification.Status),
    }, nil
}

func (s *Server) GetNotification(
    ctx context.Context,
    req *pb.GetNotificationRequest,
) (*pb.Notification, error) {
    notification, err := s.service.GetNotification(ctx, req.NotificationId)
    if err != nil {
        if err == domain.ErrNotFound {
            return nil, status.Errorf(codes.NotFound, "notification not found")
        }
        return nil, status.Errorf(codes.Internal, "failed to get notification: %v", err)
    }

    return convertToPBNotification(notification), nil
}

func (s *Server) ListNotifications(
    ctx context.Context,
    req *pb.ListNotificationsRequest,
) (*pb.ListNotificationsResponse, error) {
    domainReq := &domain.ListNotificationsRequest{
        UserID:    req.UserId,
        PageSize:  int(req.PageSize),
        PageToken: req.PageToken,
        Status:    domain.NotificationStatus(req.Status),
        Type:      domain.NotificationType(req.Type),
    }

    notifications, nextToken, err := s.service.ListNotifications(ctx, domainReq)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "failed to list notifications: %v", err)
    }

    pbNotifications := make([]*pb.Notification, len(notifications))
    for i, n := range notifications {
        pbNotifications[i] = convertToPBNotification(n)
    }

    return &pb.ListNotificationsResponse{
        Notifications:  pbNotifications,
        NextPageToken:  nextToken,
        TotalCount:     int32(len(notifications)),
    }, nil
}

func (s *Server) MarkAsRead(
    ctx context.Context,
    req *pb.MarkAsReadRequest,
) (*pb.MarkAsReadResponse, error) {
    err := s.service.MarkAsRead(ctx, req.NotificationId, req.UserId)
    if err != nil {
        if err == domain.ErrNotFound {
            return nil, status.Errorf(codes.NotFound, "notification not found")
        }
        if err == domain.ErrUnauthorized {
            return nil, status.Errorf(codes.PermissionDenied, "unauthorized")
        }
        return nil, status.Errorf(codes.Internal, "failed to mark as read: %v", err)
    }

    return &pb.MarkAsReadResponse{Success: true}, nil
}

func (s *Server) StreamNotifications(
    req *pb.StreamNotificationsRequest,
    stream pb.NotificationService_StreamNotificationsServer,
) error {
    // Implementation for streaming notifications
    // This would typically involve a message queue or pub/sub system
    // Simplified for example
    return status.Errorf(codes.Unimplemented, "streaming not yet implemented")
}

func convertToPBNotification(n *domain.Notification) *pb.Notification {
    pbNotif := &pb.Notification{
        Id:        n.ID,
        UserId:    n.UserID,
        Type:      pb.NotificationType(n.Type),
        Subject:   n.Subject,
        Body:      n.Body,
        Status:    pb.NotificationStatus(n.Status),
        CreatedAt: n.CreatedAt.Unix(),
        Metadata:  n.Metadata,
    }

    if !n.SentAt.IsZero() {
        pbNotif.SentAt = n.SentAt.Unix()
    }

    if n.ReadAt != nil {
        pbNotif.ReadAt = n.ReadAt.Unix()
    }

    return pbNotif
}

func validateSendRequest(req *pb.SendNotificationRequest) error {
    if req.UserId == "" {
        return fmt.Errorf("user_id is required")
    }
    if req.Subject == "" {
        return fmt.Errorf("subject is required")
    }
    if req.Body == "" {
        return fmt.Errorf("body is required")
    }
    return nil
}
```

### Example 2: Service Communication

Services communicate via multiple patterns:

#### 1. Synchronous gRPC for Request/Response

```go
// Task service calling notification service
package task

import (
    "context"
    "time"

    notificationpb "github.com/taskman/notifications-service/pkg/pb"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

type NotificationClient struct {
    client notificationpb.NotificationServiceClient
}

func NewNotificationClient(address string) (*NotificationClient, error) {
    conn, err := grpc.Dial(
        address,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithTimeout(5*time.Second),
    )
    if err != nil {
        return nil, err
    }

    return &NotificationClient{
        client: notificationpb.NewNotificationServiceClient(conn),
    }, nil
}

func (nc *NotificationClient) NotifyTaskAssignment(ctx context.Context, task *Task, assigneeID string) error {
    req := &notificationpb.SendNotificationRequest{
        UserId:   assigneeID,
        Type:     notificationpb.NotificationType_EMAIL,
        Subject:  fmt.Sprintf("Task Assigned: %s", task.Title),
        Body:     fmt.Sprintf("You have been assigned task: %s", task.Description),
        Priority: notificationpb.Priority_NORMAL,
        Metadata: map[string]string{
            "task_id":    task.ID,
            "task_title": task.Title,
        },
    }

    _, err := nc.client.SendNotification(ctx, req)
    return err
}
```

#### 2. Asynchronous Events via NATS

```go
// Event publishing from task service
package task

import (
    "encoding/json"
    "time"

    "github.com/nats-io/nats.go"
    "go.uber.org/zap"
)

type EventPublisher struct {
    nc     *nats.Conn
    logger *zap.Logger
}

func NewEventPublisher(natsURL string, logger *zap.Logger) (*EventPublisher, error) {
    nc, err := nats.Connect(natsURL)
    if err != nil {
        return nil, err
    }

    return &EventPublisher{
        nc:     nc,
        logger: logger,
    }, nil
}

type TaskCreatedEvent struct {
    TaskID      string    `json:"task_id"`
    UserID      string    `json:"user_id"`
    Title       string    `json:"title"`
    AssignedTo  string    `json:"assigned_to"`
    CreatedAt   time.Time `json:"created_at"`
    EventType   string    `json:"event_type"`
    EventTime   time.Time `json:"event_time"`
}

func (ep *EventPublisher) PublishTaskCreated(task *Task) error {
    event := TaskCreatedEvent{
        TaskID:     task.ID,
        UserID:     task.UserID,
        Title:      task.Title,
        AssignedTo: task.AssignedTo,
        CreatedAt:  task.CreatedAt,
        EventType:  "task.created",
        EventTime:  time.Now(),
    }

    data, err := json.Marshal(event)
    if err != nil {
        ep.logger.Error("Failed to marshal event", zap.Error(err))
        return err
    }

    // Publish to NATS subject
    if err := ep.nc.Publish("tasks.events.created", data); err != nil {
        ep.logger.Error("Failed to publish event", zap.Error(err))
        return err
    }

    ep.logger.Info("Published task created event",
        zap.String("task_id", task.ID),
        zap.String("event_type", event.EventType),
    )

    return nil
}

// Event subscription in notification service
package notification

import (
    "encoding/json"

    "github.com/nats-io/nats.go"
    "go.uber.org/zap"
)

type EventSubscriber struct {
    nc      *nats.Conn
    service *NotificationService
    logger  *zap.Logger
}

func NewEventSubscriber(natsURL string, service *NotificationService, logger *zap.Logger) (*EventSubscriber, error) {
    nc, err := nats.Connect(natsURL)
    if err != nil {
        return nil, err
    }

    es := &EventSubscriber{
        nc:      nc,
        service: service,
        logger:  logger,
    }

    // Subscribe to task events
    if _, err := nc.Subscribe("tasks.events.>", es.handleTaskEvent); err != nil {
        return nil, err
    }

    logger.Info("Subscribed to task events")
    return es, nil
}

func (es *EventSubscriber) handleTaskEvent(msg *nats.Msg) {
    var event map[string]interface{}
    if err := json.Unmarshal(msg.Data, &event); err != nil {
        es.logger.Error("Failed to unmarshal event", zap.Error(err))
        return
    }

    eventType, ok := event["event_type"].(string)
    if !ok {
        es.logger.Error("Event missing event_type")
        return
    }

    switch eventType {
    case "task.created":
        es.handleTaskCreated(event)
    case "task.assigned":
        es.handleTaskAssigned(event)
    case "task.completed":
        es.handleTaskCompleted(event)
    default:
        es.logger.Warn("Unknown event type", zap.String("event_type", eventType))
    }
}

func (es *EventSubscriber) handleTaskCreated(event map[string]interface{}) {
    // Extract event data and send notification
    taskID, _ := event["task_id"].(string)
    userID, _ := event["user_id"].(string)
    title, _ := event["title"].(string)

    es.logger.Info("Handling task created event",
        zap.String("task_id", taskID),
        zap.String("user_id", userID),
    )

    // Send notification
    // Implementation details...
}
```

## Data Management

### Database Per Service

Each service has its own database:

```yaml
# PostgreSQL databases
- taskman_tasks          # Task service
- taskman_workflows      # Workflow service
- taskman_notifications  # Notification service
- taskman_auth           # Auth service
- taskman_reports        # Reports service (read replica)
```

### Data Migration Strategy

Migrating data from monolith to microservices:

```go
// Data migration script
package main

import (
    "context"
    "database/sql"
    "log"
    "time"

    _ "github.com/lib/pq"
)

func migrateNotificationData() error {
    // Source: Monolith database
    srcDB, err := sql.Open("postgres", "postgresql://monolith-db:5432/taskman")
    if err != nil {
        return err
    }
    defer srcDB.Close()

    // Destination: Notifications service database
    dstDB, err := sql.Open("postgres", "postgresql://notifications-db:5432/taskman_notifications")
    if err != nil {
        return err
    }
    defer dstDB.Close()

    // Migrate in batches
    batchSize := 1000
    offset := 0

    for {
        // Read batch from monolith
        rows, err := srcDB.Query(`
            SELECT id, user_id, type, subject, body, status,
                   created_at, sent_at, read_at, metadata
            FROM notifications
            ORDER BY id
            LIMIT $1 OFFSET $2
        `, batchSize, offset)
        if err != nil {
            return err
        }

        notifications := make([]Notification, 0, batchSize)
        for rows.Next() {
            var n Notification
            var metadata sql.NullString
            var sentAt, readAt sql.NullTime

            err := rows.Scan(
                &n.ID, &n.UserID, &n.Type, &n.Subject, &n.Body, &n.Status,
                &n.CreatedAt, &sentAt, &readAt, &metadata,
            )
            if err != nil {
                rows.Close()
                return err
            }

            if sentAt.Valid {
                n.SentAt = sentAt.Time
            }
            if readAt.Valid {
                n.ReadAt = &readAt.Time
            }
            if metadata.Valid {
                // Parse JSON metadata
                // ...
            }

            notifications = append(notifications, n)
        }
        rows.Close()

        if len(notifications) == 0 {
            break // Migration complete
        }

        // Write batch to notifications service DB
        tx, err := dstDB.Begin()
        if err != nil {
            return err
        }

        stmt, err := tx.Prepare(`
            INSERT INTO notifications
            (id, user_id, type, subject, body, status, created_at, sent_at, read_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO NOTHING
        `)
        if err != nil {
            tx.Rollback()
            return err
        }

        for _, n := range notifications {
            _, err := stmt.Exec(
                n.ID, n.UserID, n.Type, n.Subject, n.Body, n.Status,
                n.CreatedAt, n.SentAt, n.ReadAt, n.Metadata,
            )
            if err != nil {
                stmt.Close()
                tx.Rollback()
                return err
            }
        }

        stmt.Close()
        if err := tx.Commit(); err != nil {
            return err
        }

        log.Printf("Migrated %d notifications (offset: %d)", len(notifications), offset)
        offset += batchSize
        time.Sleep(100 * time.Millisecond) // Rate limiting
    }

    log.Println("Notification data migration complete")
    return nil
}
```

### Handling Distributed Transactions

Using the Saga pattern for distributed transactions:

```go
// Saga coordinator for task creation workflow
package saga

import (
    "context"
    "fmt"

    "go.uber.org/zap"
)

type CreateTaskSaga struct {
    taskService         *task.Service
    notificationService *notification.Client
    workflowService     *workflow.Client
    logger              *zap.Logger
}

type CreateTaskRequest struct {
    UserID      string
    Title       string
    Description string
    AssignedTo  string
}

func (s *CreateTaskSaga) Execute(ctx context.Context, req *CreateTaskRequest) error {
    // Step 1: Create task
    task, err := s.taskService.CreateTask(ctx, &task.CreateRequest{
        UserID:      req.UserID,
        Title:       req.Title,
        Description: req.Description,
        AssignedTo:  req.AssignedTo,
    })
    if err != nil {
        s.logger.Error("Failed to create task", zap.Error(err))
        return err
    }

    // Step 2: Notify assignee
    if err := s.notificationService.NotifyTaskAssignment(ctx, task.ID, req.AssignedTo); err != nil {
        // Compensating action: Delete task
        s.logger.Error("Failed to send notification, rolling back", zap.Error(err))
        if deleteErr := s.taskService.DeleteTask(ctx, task.ID); deleteErr != nil {
            s.logger.Error("Failed to delete task during rollback", zap.Error(deleteErr))
        }
        return fmt.Errorf("saga failed at notification step: %w", err)
    }

    // Step 3: Start workflow if applicable
    if task.WorkflowID != "" {
        if err := s.workflowService.StartExecution(ctx, task.WorkflowID, task.ID); err != nil {
            // Compensating actions: Delete notification and task
            s.logger.Error("Failed to start workflow, rolling back", zap.Error(err))

            // Best effort cleanup
            go func() {
                // Cancel notification
                // Delete task
                // Log failures
            }()

            return fmt.Errorf("saga failed at workflow step: %w", err)
        }
    }

    s.logger.Info("Task creation saga completed successfully",
        zap.String("task_id", task.ID),
    )

    return nil
}
```

## Deployment and Operations

### Kubernetes Deployment

```yaml
# notifications-service/deployments/kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notifications-service
  namespace: taskman
  labels:
    app: notifications-service
    version: v1.2.0
spec:
  replicas: 3
  selector:
    matchLabels:
      app: notifications-service
  template:
    metadata:
      labels:
        app: notifications-service
        version: v1.2.0
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: notifications-service

      containers:
      - name: notifications-service
        image: taskman/notifications-service:v1.2.0
        ports:
        - containerPort: 8080
          name: grpc
          protocol: TCP
        - containerPort: 8081
          name: http
          protocol: TCP
        - containerPort: 9090
          name: metrics
          protocol: TCP

        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: notifications-db-credentials
              key: url
        - name: NATS_URL
          value: "nats://nats.taskman.svc.cluster.local:4222"
        - name: SMTP_HOST
          valueFrom:
            configMapKeyRef:
              name: notifications-config
              key: smtp-host
        - name: LOG_LEVEL
          value: "info"

        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"

        livenessProbe:
          httpGet:
            path: /health
            port: 8081
          initialDelaySeconds: 10
          periodSeconds: 10

        readinessProbe:
          httpGet:
            path: /ready
            port: 8081
          initialDelaySeconds: 5
          periodSeconds: 5

      - name: cloudsql-proxy
        image: gcr.io/cloudsql-docker/gce-proxy:latest
        command:
          - "/cloud_sql_proxy"
          - "-instances=project:region:taskman-notifications-db=tcp:5432"
        resources:
          requests:
            cpu: "50m"
            memory: "64Mi"

---
apiVersion: v1
kind: Service
metadata:
  name: notifications-service
  namespace: taskman
spec:
  selector:
    app: notifications-service
  ports:
  - name: grpc
    port: 8080
    targetPort: 8080
  - name: http
    port: 8081
    targetPort: 8081
  type: ClusterIP

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: notifications-service-hpa
  namespace: taskman
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: notifications-service
  minReplicas: 3
  maxReplicas: 20
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
        name: grpc_requests_per_second
      target:
        type: AverageValue
        averageValue: "1000"
```

### Service Mesh with Istio

```yaml
# Istio VirtualService for traffic management
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: notifications-service
  namespace: taskman
spec:
  hosts:
  - notifications-service
  http:
  - match:
    - headers:
        version:
          exact: canary
    route:
    - destination:
        host: notifications-service
        subset: v1-2-0
      weight: 10
    - destination:
        host: notifications-service
        subset: v1-1-0
      weight: 90
  - route:
    - destination:
        host: notifications-service
        subset: v1-1-0

---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: notifications-service
  namespace: taskman
spec:
  host: notifications-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
        maxRequestsPerConnection: 2
    loadBalancer:
      simple: LEAST_REQUEST
    outlierDetection:
      consecutiveErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 50
  subsets:
  - name: v1-1-0
    labels:
      version: v1.1.0
  - name: v1-2-0
    labels:
      version: v1.2.0
```

## Monitoring and Observability

### Distributed Tracing

```go
// Implementing OpenTelemetry tracing
package main

import (
    "context"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/jaeger"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.4.0"
    "go.opentelemetry.io/otel/trace"
)

func initTracer(serviceName string) (func(), error) {
    exporter, err := jaeger.New(jaeger.WithCollectorEndpoint(jaeger.WithEndpoint("http://jaeger:14268/api/traces")))
    if err != nil {
        return nil, err
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceNameKey.String(serviceName),
            attribute.String("environment", "production"),
        )),
    )

    otel.SetTracerProvider(tp)

    return func() {
        if err := tp.Shutdown(context.Background()); err != nil {
            log.Printf("Error shutting down tracer provider: %v", err)
        }
    }, nil
}

// Using tracing in service methods
func (s *NotificationService) SendNotification(
    ctx context.Context,
    req *SendNotificationRequest,
) (*Notification, error) {
    tracer := otel.Tracer("notifications-service")
    ctx, span := tracer.Start(ctx, "SendNotification")
    defer span.End()

    span.SetAttributes(
        attribute.String("user_id", req.UserID),
        attribute.String("notification_type", string(req.Type)),
        attribute.String("priority", string(req.Priority)),
    )

    // Create notification
    notification, err := s.createNotification(ctx, req)
    if err != nil {
        span.RecordError(err)
        return nil, err
    }

    span.AddEvent("Notification created", trace.WithAttributes(
        attribute.String("notification_id", notification.ID),
    ))

    // Send notification
    if err := s.sendNotification(ctx, notification); err != nil {
        span.RecordError(err)
        return nil, err
    }

    span.SetAttributes(attribute.String("notification_id", notification.ID))
    return notification, nil
}
```

## Results and Metrics

After 9 months of migration:

### Performance Improvements

```
Metric                    Before (Monolith)    After (Microservices)
------------------------------------------------------------------------
Deployment Time           15-20 minutes        2-5 minutes
Build Time                8 minutes            1-2 minutes per service
Test Suite Duration       45 minutes           5-10 minutes per service
P95 API Latency           850ms                320ms
Database Connections      500 (single pool)    ~100 per service
Scaling Time              10 minutes           30 seconds
```

### Operational Improvements

- **Independent deployments**: Each service deploys independently
- **Selective scaling**: Scale only the services that need it
- **Faster development**: Teams work independently on separate services
- **Better resource utilization**: 40% reduction in infrastructure costs
- **Improved reliability**: Failures isolated to single services

### Challenges Faced

1. **Increased operational complexity**: 7 services vs 1 monolith
2. **Distributed debugging**: Tracing across services required new tools
3. **Data consistency**: Eventual consistency required application changes
4. **Network overhead**: Inter-service communication added latency
5. **DevOps burden**: More deployment pipelines, more monitoring

## Lessons Learned

### 1. Start with the Right Service

Our first extraction (notifications) was perfect - low coupling, clear boundaries. Starting with a complex, highly-coupled service would have been disastrous.

### 2. Data Separation is Hard

Migrating data from a shared database to service-specific databases was our biggest challenge. Plan for:
- Dual writes during transition
- Data reconciliation
- Rollback strategies

### 3. Invest in Observability Early

Distributed tracing, centralized logging, and comprehensive metrics are not optional. Implement before you need them.

### 4. Communication Patterns Matter

Choose the right pattern for each use case:
- **gRPC**: Request/response, low latency required
- **Events**: Async, eventual consistency acceptable
- **REST**: External APIs, third-party integrations

### 5. Not Everything Should be a Microservice

We kept the auth service in the monolith until the end because it was stable, low-change, and deeply integrated. Sometimes the monolith is the right answer.

## Conclusion

The migration from monolith to microservices was a significant undertaking that fundamentally changed how we build and deploy software. The benefits - independent scaling, faster deployments, team autonomy - were worth the investment, but the journey required careful planning, robust tooling, and organizational commitment.

Key takeaways:

1. **Start small**: Extract one service, learn, iterate
2. **Define clear boundaries**: Use DDD principles
3. **Invest in infrastructure**: Service mesh, observability, automation
4. **Plan data migration carefully**: This is the hardest part
5. **Don't rush**: Nine months was appropriate for our scale

For teams considering a similar migration, the most important question is: *Why?* If you can't articulate specific problems that microservices will solve, don't migrate. But if you're hitting scaling, deployment, or organizational bottlenecks, microservices can be transformative.

## Additional Resources

- [Domain-Driven Design](https://www.domainlanguagecom/ddd/)
- [gRPC Documentation](https://grpc.io/)
- [NATS Messaging](https://nats.io/)
- [Istio Service Mesh](https://istio.io/)
- [OpenTelemetry](https://opentelemetry.io/)

For consultation on microservices architecture and Go development, contact mmattox@support.tools.