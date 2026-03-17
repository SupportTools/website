---
title: "Go Structured Testing: TestContainers, Docker Compose in Tests, and Integration Test Patterns"
date: 2030-02-26T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "TestContainers", "Integration Testing", "PostgreSQL", "Redis", "Kafka"]
categories: ["Go", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Use testcontainers-go for realistic integration tests with PostgreSQL, Redis, and Kafka containers. Master test isolation strategies, parallel execution, and production-accurate test environments."
more_link: "yes"
url: "/go-testcontainers-integration-testing-patterns/"
---

The gap between unit tests and production behavior is where most bugs live. Unit tests with mocks verify that your code calls the right methods with the right arguments, but they cannot catch the query that works on SQLite and fails on PostgreSQL, the cache invalidation race condition that only appears under real Redis replication lag, or the Kafka consumer offset commit that gets lost during a partition rebalance. TestContainers bridges that gap by spinning up real infrastructure in Docker containers for each test run.

This guide covers the patterns that make testcontainers-go practical in real projects: fast container reuse, proper isolation between parallel tests, schema migration management, and structuring integration tests that are maintainable as the codebase grows.

<!--more-->

## Why TestContainers Over Mocks

The argument for TestContainers is not that mocks are bad — unit tests with mocks are fast and precise. The argument is that some bugs require real infrastructure to surface:

- **Type coercion differences**: SQLite accepts almost anything; PostgreSQL enforces types strictly. JSON stored in a TEXT column via a mock will serialize/deserialize differently than via JSONB.
- **Transaction isolation**: Testing SERIALIZABLE isolation levels requires real database transaction support.
- **Kafka ordering guarantees**: Partition assignment, offset commits, and consumer group rebalancing only happen with real Kafka.
- **Redis Lua scripts**: Script atomicity guarantees require real Redis.
- **Network behavior**: Connection pooling, connection drops, and reconnection logic need real network I/O.

TestContainers gives you all of this with containers that start in seconds, are isolated per test suite, and clean up automatically.

## Setting Up TestContainers

```bash
go get github.com/testcontainers/testcontainers-go@v0.30.0
go get github.com/testcontainers/testcontainers-go/modules/postgres@v0.30.0
go get github.com/testcontainers/testcontainers-go/modules/redis@v0.30.0
go get github.com/testcontainers/testcontainers-go/modules/kafka@v0.30.0
```

Requirements:
- Docker running locally (or in CI with Docker-in-Docker)
- The test binary needs network access to Docker socket (`/var/run/docker.sock`)

## PostgreSQL Integration Tests

### TestMain Pattern for Container Lifecycle

```go
// internal/storage/postgres_test.go
package storage_test

import (
    "context"
    "database/sql"
    "fmt"
    "os"
    "testing"
    "time"

    "github.com/golang-migrate/migrate/v4"
    migratepostgres "github.com/golang-migrate/migrate/v4/database/postgres"
    _ "github.com/golang-migrate/migrate/v4/source/file"
    _ "github.com/lib/pq"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"
)

var (
    testDB  *sql.DB
    testDSN string
)

func TestMain(m *testing.M) {
    ctx := context.Background()

    // Start PostgreSQL container once for all tests in this package
    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:16.2-alpine"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("testpass"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(30*time.Second),
        ),
    )
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to start postgres container: %v\n", err)
        os.Exit(1)
    }

    defer func() {
        if err := pgContainer.Terminate(ctx); err != nil {
            fmt.Fprintf(os.Stderr, "Failed to terminate postgres container: %v\n", err)
        }
    }()

    // Get connection string
    dsn, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to get connection string: %v\n", err)
        os.Exit(1)
    }
    testDSN = dsn

    // Open database connection
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to open database: %v\n", err)
        os.Exit(1)
    }
    defer db.Close()

    // Configure connection pool
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)

    testDB = db

    // Run migrations
    if err := runMigrations(db, dsn); err != nil {
        fmt.Fprintf(os.Stderr, "Failed to run migrations: %v\n", err)
        os.Exit(1)
    }

    // Run tests
    code := m.Run()
    os.Exit(code)
}

func runMigrations(db *sql.DB, dsn string) error {
    driver, err := migratepostgres.WithInstance(db, &migratepostgres.Config{})
    if err != nil {
        return fmt.Errorf("create migration driver: %w", err)
    }

    m, err := migrate.NewWithDatabaseInstance(
        "file://../../migrations",
        "postgres",
        driver,
    )
    if err != nil {
        return fmt.Errorf("create migrator: %w", err)
    }

    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        return fmt.Errorf("run migrations: %w", err)
    }

    return nil
}
```

### Test Isolation with Schema-per-Test

The key pattern for parallel database tests: each test gets its own schema, preventing data interference:

```go
// internal/storage/testhelpers_test.go
package storage_test

import (
    "context"
    "database/sql"
    "fmt"
    "testing"
)

// TestDB provides an isolated database schema for each test.
type TestDB struct {
    DB         *sql.DB
    SchemaName string
}

// NewTestDB creates a new isolated schema and returns a database handle scoped to it.
func NewTestDB(t *testing.T) *TestDB {
    t.Helper()

    // Create unique schema name per test
    // Use t.Name() but sanitize for SQL identifier validity
    schemaName := sanitizeSchemaName(t.Name())

    ctx := context.Background()

    // Create schema
    _, err := testDB.ExecContext(ctx, fmt.Sprintf("CREATE SCHEMA IF NOT EXISTS %q", schemaName))
    if err != nil {
        t.Fatalf("Failed to create test schema %q: %v", schemaName, err)
    }

    // Copy tables from public schema into test schema
    // This gives each test a fresh copy of the schema with no data
    tables := []string{"users", "orders", "products", "audit_logs"}
    for _, table := range tables {
        _, err := testDB.ExecContext(ctx, fmt.Sprintf(
            "CREATE TABLE %q.%q (LIKE public.%q INCLUDING ALL)",
            schemaName, table, table,
        ))
        if err != nil {
            t.Fatalf("Failed to copy table %s to schema %q: %v", table, schemaName, err)
        }
    }

    // Cleanup on test completion
    t.Cleanup(func() {
        _, err := testDB.ExecContext(context.Background(),
            fmt.Sprintf("DROP SCHEMA IF EXISTS %q CASCADE", schemaName),
        )
        if err != nil {
            t.Errorf("Failed to drop test schema %q: %v", schemaName, err)
        }
    })

    // Create connection scoped to this schema
    db, err := sql.Open("postgres",
        fmt.Sprintf("%s&search_path=%s,public", testDSN, schemaName),
    )
    if err != nil {
        t.Fatalf("Failed to open schema-scoped database: %v", err)
    }
    t.Cleanup(func() { db.Close() })

    return &TestDB{
        DB:         db,
        SchemaName: schemaName,
    }
}

func sanitizeSchemaName(name string) string {
    // Replace special characters with underscores
    result := make([]byte, len(name))
    for i, c := range []byte(name) {
        if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
            result[i] = c
        } else {
            result[i] = '_'
        }
    }
    // Truncate to PostgreSQL identifier limit (63 chars)
    if len(result) > 63 {
        result = result[:63]
    }
    return "test_" + string(result)
}
```

### Using the Isolated Database in Tests

```go
// internal/storage/user_repository_test.go
package storage_test

import (
    "context"
    "testing"
    "time"

    "github.com/myorg/myapp/internal/storage"
)

func TestUserRepository_Create(t *testing.T) {
    t.Parallel()

    db := NewTestDB(t)
    repo := storage.NewUserRepository(db.DB)

    t.Run("creates user successfully", func(t *testing.T) {
        t.Parallel()

        ctx := context.Background()
        user, err := repo.Create(ctx, storage.CreateUserInput{
            Email:     "alice@example.com",
            Name:      "Alice",
            CreatedAt: time.Now(),
        })

        if err != nil {
            t.Fatalf("unexpected error: %v", err)
        }
        if user.ID == 0 {
            t.Error("expected non-zero user ID")
        }
        if user.Email != "alice@example.com" {
            t.Errorf("expected email %q, got %q", "alice@example.com", user.Email)
        }
    })

    t.Run("rejects duplicate email", func(t *testing.T) {
        t.Parallel()

        ctx := context.Background()
        input := storage.CreateUserInput{
            Email: "bob@example.com",
            Name:  "Bob",
        }

        if _, err := repo.Create(ctx, input); err != nil {
            t.Fatalf("first create failed: %v", err)
        }

        _, err := repo.Create(ctx, input)
        if err == nil {
            t.Fatal("expected error for duplicate email, got nil")
        }
        if !storage.IsUniqueViolation(err) {
            t.Errorf("expected unique violation error, got: %v", err)
        }
    })

    t.Run("handles concurrent writes correctly", func(t *testing.T) {
        t.Parallel()

        ctx := context.Background()
        errors := make(chan error, 10)

        // Attempt 10 concurrent creates with unique emails
        for i := 0; i < 10; i++ {
            i := i // capture loop variable
            go func() {
                _, err := repo.Create(ctx, storage.CreateUserInput{
                    Email: fmt.Sprintf("concurrent-%d@example.com", i),
                    Name:  fmt.Sprintf("User %d", i),
                })
                errors <- err
            }()
        }

        for i := 0; i < 10; i++ {
            if err := <-errors; err != nil {
                t.Errorf("concurrent create %d failed: %v", i, err)
            }
        }
    })
}

func TestUserRepository_UpdateWithOptimisticLocking(t *testing.T) {
    t.Parallel()

    db := NewTestDB(t)
    repo := storage.NewUserRepository(db.DB)
    ctx := context.Background()

    // Create a user
    user, err := repo.Create(ctx, storage.CreateUserInput{
        Email: "locking-test@example.com",
        Name:  "Lock Test User",
    })
    if err != nil {
        t.Fatalf("setup failed: %v", err)
    }

    t.Run("concurrent update loses with stale version", func(t *testing.T) {
        // First update succeeds
        updated, err := repo.Update(ctx, storage.UpdateUserInput{
            ID:      user.ID,
            Name:    "Updated Name",
            Version: user.Version,
        })
        if err != nil {
            t.Fatalf("first update failed: %v", err)
        }

        // Second update with old version should fail
        _, err = repo.Update(ctx, storage.UpdateUserInput{
            ID:      user.ID,
            Name:    "Conflicting Update",
            Version: user.Version,  // stale version
        })
        if err == nil {
            t.Fatal("expected optimistic lock error, got nil")
        }
        if !storage.IsOptimisticLockError(err) {
            t.Errorf("expected optimistic lock error, got: %T %v", err, err)
        }
        _ = updated
    })
}
```

## Redis Integration Tests

```go
// internal/cache/redis_test.go
package cache_test

import (
    "context"
    "os"
    "testing"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/testcontainers/testcontainers-go"
    tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

var testRedisClient *redis.Client

func TestMain(m *testing.M) {
    ctx := context.Background()

    redisContainer, err := tcredis.RunContainer(ctx,
        testcontainers.WithImage("redis:7.2-alpine"),
        tcredis.WithSnapshotting(10, 1),
        tcredis.WithLogLevel(tcredis.LogLevelVerbose),
    )
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to start redis container: %v\n", err)
        os.Exit(1)
    }

    defer func() {
        if err := redisContainer.Terminate(ctx); err != nil {
            fmt.Fprintf(os.Stderr, "Failed to terminate redis: %v\n", err)
        }
    }()

    addr, err := redisContainer.Endpoint(ctx, "")
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to get redis endpoint: %v\n", err)
        os.Exit(1)
    }

    testRedisClient = redis.NewClient(&redis.Options{
        Addr: addr,
    })

    if err := testRedisClient.Ping(ctx).Err(); err != nil {
        fmt.Fprintf(os.Stderr, "Redis ping failed: %v\n", err)
        os.Exit(1)
    }

    code := m.Run()
    os.Exit(code)
}

// RedisTestHelper provides isolation between parallel Redis tests
type RedisTestHelper struct {
    Client *redis.Client
    Prefix string
}

func NewRedisHelper(t *testing.T) *RedisTestHelper {
    t.Helper()

    prefix := fmt.Sprintf("test:%s:", sanitizeKeyPrefix(t.Name()))

    t.Cleanup(func() {
        ctx := context.Background()
        // Delete all keys with this test's prefix
        var cursor uint64
        for {
            keys, nextCursor, err := testRedisClient.Scan(ctx, cursor, prefix+"*", 100).Result()
            if err != nil {
                t.Logf("Warning: failed to scan Redis keys for cleanup: %v", err)
                break
            }
            if len(keys) > 0 {
                if err := testRedisClient.Del(ctx, keys...).Err(); err != nil {
                    t.Logf("Warning: failed to delete Redis keys: %v", err)
                }
            }
            cursor = nextCursor
            if cursor == 0 {
                break
            }
        }
    })

    return &RedisTestHelper{
        Client: testRedisClient,
        Prefix: prefix,
    }
}

func (h *RedisTestHelper) Key(k string) string {
    return h.Prefix + k
}

func TestCacheService_SetAndGet(t *testing.T) {
    t.Parallel()

    rh := NewRedisHelper(t)
    svc := cache.NewService(rh.Client, rh.Prefix)

    t.Run("sets and retrieves value", func(t *testing.T) {
        t.Parallel()

        ctx := context.Background()
        key := "user:123"
        value := map[string]interface{}{
            "id":    123,
            "email": "test@example.com",
        }

        if err := svc.Set(ctx, key, value, 5*time.Minute); err != nil {
            t.Fatalf("Set failed: %v", err)
        }

        var retrieved map[string]interface{}
        if err := svc.Get(ctx, key, &retrieved); err != nil {
            t.Fatalf("Get failed: %v", err)
        }

        if retrieved["email"] != "test@example.com" {
            t.Errorf("got email %v, want test@example.com", retrieved["email"])
        }
    })

    t.Run("returns not found for missing key", func(t *testing.T) {
        t.Parallel()

        ctx := context.Background()
        var result interface{}
        err := svc.Get(ctx, "nonexistent", &result)

        if !cache.IsNotFound(err) {
            t.Errorf("expected not found error, got: %v", err)
        }
    })

    t.Run("expires after TTL", func(t *testing.T) {
        t.Parallel()

        ctx := context.Background()

        if err := svc.Set(ctx, "expiring-key", "value", 100*time.Millisecond); err != nil {
            t.Fatalf("Set failed: %v", err)
        }

        time.Sleep(200 * time.Millisecond)

        var result string
        err := svc.Get(ctx, "expiring-key", &result)
        if !cache.IsNotFound(err) {
            t.Errorf("expected not found after TTL, got: %v (result: %v)", err, result)
        }
    })
}

func TestCacheService_LuaScript(t *testing.T) {
    t.Parallel()

    rh := NewRedisHelper(t)
    svc := cache.NewService(rh.Client, rh.Prefix)
    ctx := context.Background()

    t.Run("atomic increment with max", func(t *testing.T) {
        t.Parallel()

        key := "rate-limit:user:456"
        max := int64(5)

        // Increment 5 times, should all succeed
        for i := 0; i < 5; i++ {
            allowed, err := svc.IncrementWithMax(ctx, key, max, time.Minute)
            if err != nil {
                t.Fatalf("increment %d failed: %v", i, err)
            }
            if !allowed {
                t.Errorf("increment %d should be allowed but was denied", i)
            }
        }

        // 6th increment should be denied
        allowed, err := svc.IncrementWithMax(ctx, key, max, time.Minute)
        if err != nil {
            t.Fatalf("6th increment failed: %v", err)
        }
        if allowed {
            t.Error("6th increment should be denied by rate limit")
        }
    })
}
```

## Kafka Integration Tests

```go
// internal/messaging/kafka_test.go
package messaging_test

import (
    "context"
    "encoding/json"
    "os"
    "sync"
    "testing"
    "time"

    "github.com/segmentio/kafka-go"
    "github.com/testcontainers/testcontainers-go"
    tckafka "github.com/testcontainers/testcontainers-go/modules/kafka"
)

var testKafkaBroker string

func TestMain(m *testing.M) {
    ctx := context.Background()

    kafkaContainer, err := tckafka.RunContainer(ctx,
        testcontainers.WithImage("confluentinc/cp-kafka:7.5.3"),
        tckafka.WithClusterID("test-cluster"),
    )
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to start Kafka container: %v\n", err)
        os.Exit(1)
    }

    defer func() {
        if err := kafkaContainer.Terminate(ctx); err != nil {
            fmt.Fprintf(os.Stderr, "Failed to terminate Kafka: %v\n", err)
        }
    }()

    broker, err := kafkaContainer.Brokers(ctx)
    if err != nil || len(broker) == 0 {
        fmt.Fprintf(os.Stderr, "Failed to get Kafka broker address: %v\n", err)
        os.Exit(1)
    }
    testKafkaBroker = broker[0]

    code := m.Run()
    os.Exit(code)
}

// KafkaTopicHelper creates a unique topic per test
type KafkaTopicHelper struct {
    TopicName string
    Broker    string
}

func NewKafkaTopic(t *testing.T, partitions int) *KafkaTopicHelper {
    t.Helper()

    topicName := fmt.Sprintf("test-%s-%d",
        sanitizeTopicName(t.Name()),
        time.Now().UnixNano(),
    )

    conn, err := kafka.DialLeader(context.Background(), "tcp", testKafkaBroker, topicName, 0)
    if err != nil {
        t.Fatalf("Failed to create Kafka topic %s: %v", topicName, err)
    }

    err = conn.CreateTopics(kafka.TopicConfig{
        Topic:             topicName,
        NumPartitions:     partitions,
        ReplicationFactor: 1,
    })
    if err != nil {
        t.Fatalf("Failed to create topic: %v", err)
    }
    conn.Close()

    t.Cleanup(func() {
        conn, err := kafka.DialLeader(context.Background(), "tcp", testKafkaBroker, topicName, 0)
        if err != nil {
            t.Logf("Warning: could not connect to delete topic %s: %v", topicName, err)
            return
        }
        defer conn.Close()

        conn.DeleteTopics(topicName)
    })

    return &KafkaTopicHelper{
        TopicName: topicName,
        Broker:    testKafkaBroker,
    }
}

func (h *KafkaTopicHelper) NewWriter() *kafka.Writer {
    return &kafka.Writer{
        Addr:         kafka.TCP(h.Broker),
        Topic:        h.TopicName,
        Balancer:     &kafka.Hash{},
        BatchTimeout: 10 * time.Millisecond,
        RequiredAcks: kafka.RequireAll,
    }
}

func (h *KafkaTopicHelper) NewReader(groupID string) *kafka.Reader {
    return kafka.NewReader(kafka.ReaderConfig{
        Brokers:     []string{h.Broker},
        Topic:       h.TopicName,
        GroupID:     groupID,
        MinBytes:    1,
        MaxBytes:    10 * 1024 * 1024,
        MaxWait:     100 * time.Millisecond,
        StartOffset: kafka.FirstOffset,
    })
}

func TestEventProducer_Publish(t *testing.T) {
    t.Parallel()

    topic := NewKafkaTopic(t, 3)
    writer := topic.NewWriter()
    defer writer.Close()

    producer := messaging.NewProducer(writer)

    t.Run("publishes event successfully", func(t *testing.T) {
        t.Parallel()

        ctx := context.Background()
        event := messaging.UserCreatedEvent{
            UserID:    "user-123",
            Email:     "test@example.com",
            CreatedAt: time.Now(),
        }

        if err := producer.Publish(ctx, event); err != nil {
            t.Fatalf("Publish failed: %v", err)
        }

        // Read it back
        reader := topic.NewReader("test-consumer-" + t.Name())
        defer reader.Close()

        readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
        defer cancel()

        msg, err := reader.ReadMessage(readCtx)
        if err != nil {
            t.Fatalf("ReadMessage failed: %v", err)
        }

        var receivedEvent messaging.UserCreatedEvent
        if err := json.Unmarshal(msg.Value, &receivedEvent); err != nil {
            t.Fatalf("Failed to unmarshal event: %v", err)
        }

        if receivedEvent.UserID != event.UserID {
            t.Errorf("got UserID %s, want %s", receivedEvent.UserID, event.UserID)
        }
    })
}

func TestEventConsumer_ProcessesMessages(t *testing.T) {
    t.Parallel()

    topic := NewKafkaTopic(t, 1)

    // Pre-populate the topic with test messages
    writer := topic.NewWriter()
    ctx := context.Background()

    testEvents := []messaging.UserCreatedEvent{
        {UserID: "user-1", Email: "user1@example.com"},
        {UserID: "user-2", Email: "user2@example.com"},
        {UserID: "user-3", Email: "user3@example.com"},
    }

    for _, event := range testEvents {
        data, _ := json.Marshal(event)
        if err := writer.WriteMessages(ctx, kafka.Message{
            Key:   []byte(event.UserID),
            Value: data,
        }); err != nil {
            t.Fatalf("Failed to write test message: %v", err)
        }
    }
    writer.Close()

    // Create consumer and track processed events
    reader := topic.NewReader("test-consumer-group-1")
    defer reader.Close()

    processed := make(chan messaging.UserCreatedEvent, len(testEvents))
    var wg sync.WaitGroup
    wg.Add(len(testEvents))

    consumer := messaging.NewConsumer(reader, func(ctx context.Context, event messaging.UserCreatedEvent) error {
        processed <- event
        wg.Done()
        return nil
    })

    consumerCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    go consumer.Start(consumerCtx)

    // Wait for all messages to be processed
    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        // All messages processed
    case <-time.After(10 * time.Second):
        t.Fatal("Timed out waiting for messages to be processed")
    }

    close(processed)
    var receivedIDs []string
    for event := range processed {
        receivedIDs = append(receivedIDs, event.UserID)
    }

    if len(receivedIDs) != len(testEvents) {
        t.Errorf("processed %d events, want %d", len(receivedIDs), len(testEvents))
    }
}

func TestEventConsumer_HandlesProcessingFailure(t *testing.T) {
    t.Parallel()

    topic := NewKafkaTopic(t, 1)
    writer := topic.NewWriter()
    ctx := context.Background()

    // Write a message
    if err := writer.WriteMessages(ctx, kafka.Message{
        Value: []byte(`{"user_id": "fail-user"}`),
    }); err != nil {
        t.Fatalf("Write failed: %v", err)
    }
    writer.Close()

    reader := topic.NewReader("test-failure-group")
    defer reader.Close()

    callCount := 0
    consumer := messaging.NewConsumer(reader, func(ctx context.Context, event messaging.UserCreatedEvent) error {
        callCount++
        if callCount <= 3 {
            return fmt.Errorf("simulated transient failure (attempt %d)", callCount)
        }
        return nil
    })

    consumerCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
    defer cancel()

    go consumer.Start(consumerCtx)

    // Wait for successful processing
    time.Sleep(5 * time.Second)
    cancel()

    if callCount < 4 {
        t.Errorf("expected at least 4 calls (3 failures + 1 success), got %d", callCount)
    }
}
```

## Docker Compose for Multi-Service Tests

When your service depends on multiple infrastructure components together, Docker Compose in tests is more ergonomic than managing individual containers:

```go
// internal/integration/compose_test.go
package integration_test

import (
    "context"
    "path/filepath"
    "runtime"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go/modules/compose"
    "github.com/testcontainers/testcontainers-go/wait"
)

// dockerComposeFile returns the path to the test docker-compose file
func dockerComposeFile() string {
    _, filename, _, _ := runtime.Caller(0)
    return filepath.Join(filepath.Dir(filename), "testdata", "docker-compose.yml")
}

func TestOrderService_FullFlow(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test in short mode")
    }

    ctx := context.Background()

    // Start all services defined in compose file
    c, err := compose.NewDockerCompose(dockerComposeFile())
    if err != nil {
        t.Fatalf("Failed to create compose: %v", err)
    }

    t.Cleanup(func() {
        if err := c.Down(ctx, compose.RemoveOrphans(true), compose.RemoveVolumes(true)); err != nil {
            t.Logf("Warning: compose down failed: %v", err)
        }
    })

    err = c.
        WaitForService("postgres", wait.ForLog("database system is ready").
            WithStartupTimeout(30*time.Second)).
        WaitForService("redis", wait.ForLog("Ready to accept connections").
            WithStartupTimeout(30*time.Second)).
        WaitForService("kafka", wait.ForLog("started (kafka.server.KafkaServer)").
            WithStartupTimeout(60*time.Second)).
        Up(ctx, compose.Wait(true))
    if err != nil {
        t.Fatalf("Failed to start services: %v", err)
    }

    // Get service endpoints
    pgContainer, err := c.ServiceContainer(ctx, "postgres")
    if err != nil {
        t.Fatalf("Failed to get postgres container: %v", err)
    }
    pgPort, err := pgContainer.MappedPort(ctx, "5432")
    if err != nil {
        t.Fatalf("Failed to get postgres port: %v", err)
    }

    // Build and test the service with real infrastructure
    cfg := Config{
        PostgresDSN: fmt.Sprintf("postgres://user:pass@localhost:%s/testdb?sslmode=disable", pgPort.Port()),
        // ... other config
    }

    svc := NewOrderService(cfg)

    // Run end-to-end flow test
    orderID, err := svc.CreateOrder(ctx, CreateOrderRequest{
        CustomerID: "cust-123",
        Items: []OrderItem{
            {ProductID: "prod-1", Quantity: 2, UnitPrice: 9.99},
        },
    })
    if err != nil {
        t.Fatalf("CreateOrder failed: %v", err)
    }

    // Verify order in database
    order, err := svc.GetOrder(ctx, orderID)
    if err != nil {
        t.Fatalf("GetOrder failed: %v", err)
    }
    if order.Status != OrderStatusPending {
        t.Errorf("expected status Pending, got %s", order.Status)
    }

    // Process payment (publishes Kafka event)
    if err := svc.ProcessPayment(ctx, orderID, PaymentInfo{
        Amount:   19.98,
        Currency: "USD",
    }); err != nil {
        t.Fatalf("ProcessPayment failed: %v", err)
    }

    // Wait for event processing
    time.Sleep(2 * time.Second)

    // Verify order status updated via event handler
    order, err = svc.GetOrder(ctx, orderID)
    if err != nil {
        t.Fatalf("GetOrder after payment failed: %v", err)
    }
    if order.Status != OrderStatusPaid {
        t.Errorf("expected status Paid after payment, got %s", order.Status)
    }
}
```

```yaml
# internal/integration/testdata/docker-compose.yml
version: '3.8'
services:
  postgres:
    image: postgres:16.2-alpine
    environment:
      POSTGRES_DB: testdb
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
    tmpfs:
      - /var/lib/postgresql/data  # Use tmpfs for faster tests

  redis:
    image: redis:7.2-alpine
    command: redis-server --save "" --appendonly no  # Disable persistence for tests

  kafka:
    image: confluentinc/cp-kafka:7.5.3
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
    depends_on:
      - zookeeper

  zookeeper:
    image: confluentinc/cp-zookeeper:7.5.3
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
```

## Reusable Container Pattern (Ryuk + Reuse)

For faster local development iteration, TestContainers supports container reuse:

```go
// pkg/testinfra/containers.go
package testinfra

import (
    "context"
    "sync"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
)

var (
    sharedPG     *postgres.PostgresContainer
    sharedPGOnce sync.Once
    sharedPGErr  error
)

// SharedPostgres returns a shared PostgreSQL container instance.
// The container is reused across test runs when TESTCONTAINERS_RYUK_DISABLED=true
// and testcontainers.WithReuseOption is enabled.
func SharedPostgres(ctx context.Context) (*postgres.PostgresContainer, error) {
    sharedPGOnce.Do(func() {
        sharedPG, sharedPGErr = postgres.RunContainer(ctx,
            testcontainers.WithImage("postgres:16.2-alpine"),
            postgres.WithDatabase("testdb"),
            postgres.WithUsername("test"),
            postgres.WithPassword("test"),
            testcontainers.CustomizeRequest(testcontainers.GenericContainerRequest{
                ContainerRequest: testcontainers.ContainerRequest{
                    Name:  "shared-test-postgres",
                    Reuse: true,  // Reuse existing container if it exists
                },
            }),
        )
    })
    return sharedPG, sharedPGErr
}
```

Enable reuse in your environment:

```bash
# Allow container reuse (don't auto-remove containers)
export TESTCONTAINERS_RYUK_DISABLED=true
```

## CI Pipeline Configuration

```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"

      - name: Run unit tests
        run: go test -short ./...

      - name: Run integration tests
        run: |
          go test -v -count=1 -timeout=10m \
            -run 'TestIntegration|TestE2E' \
            ./...
        env:
          TESTCONTAINERS_RYUK_DISABLED: "false"
          DOCKER_HOST: unix:///var/run/docker.sock

      - name: Run tests with race detector
        run: |
          go test -race -short -count=1 -timeout=5m ./...
```

## Key Takeaways

TestContainers in Go enables a testing style where integration tests are:

1. **Hermetic**: Each test run gets fresh containers with known state — no shared state between CI runs.
2. **Isolated at the test level**: Schema-per-test for PostgreSQL and prefix-per-test for Redis eliminate inter-test interference in parallel runs.
3. **Production-accurate**: Bugs that require real PostgreSQL transaction semantics, real Redis Lua atomicity, or real Kafka partition assignment cannot hide behind mock implementations.
4. **Maintainable**: Helper patterns like `NewTestDB` and `NewKafkaTopic` encapsulate container lifecycle management, keeping individual test functions focused on behavior rather than setup.
5. **Fast enough**: Container startup (2-5 seconds for PostgreSQL, 5-15 seconds for Kafka) amortizes across a full test suite. With TestMain and container reuse, the per-test overhead is near zero.
6. **CI-compatible**: Docker-in-Docker or Docker socket mounting makes TestContainers work in GitHub Actions, GitLab CI, and most other CI systems without special configuration.

The pattern shift is straightforward: replace mock implementations with TestContainers helpers in TestMain, add schema/prefix isolation helpers, and write tests that use real queries and real commands. The result is a test suite you can actually trust.
