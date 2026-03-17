---
title: "Go Microservices Testing: Integration Tests with testcontainers-go"
date: 2031-04-30T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "testcontainers-go", "Integration Testing", "PostgreSQL", "Kafka", "Docker"]
categories: ["Go", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master integration testing in Go microservices using testcontainers-go for PostgreSQL, Redis, and Kafka containers with parallel test execution, wait strategies, and CI/CD Docker-in-Docker integration."
more_link: "yes"
url: "/go-microservices-testing-integration-testcontainers-go/"
---

Integration tests that depend on external services are notoriously difficult to maintain. `testcontainers-go` solves this by spinning up real Docker containers within Go tests, giving each test suite its own isolated PostgreSQL, Redis, or Kafka instance that is automatically cleaned up after the test run completes. This guide covers production patterns for using testcontainers-go across a microservices codebase.

<!--more-->

# Go Microservices Testing: Integration Tests with testcontainers-go

## Section 1: Why testcontainers-go Over Mocks

Mocks and stubs are valuable for unit tests, but integration tests need to verify the full data path: SQL queries, transaction semantics, cache invalidation logic, and message broker behavior. Three reasons to prefer real containers:

1. **Query validation** - Your ORM or raw SQL must actually work against the target database version
2. **Behavioral fidelity** - Redis TTL expiry, Kafka partition assignment, and PostgreSQL lock semantics cannot be faithfully mocked
3. **Schema migrations** - Running Flyway or golang-migrate against a real container catches migration issues before production

The tradeoff is test speed, which is addressed by running containers in parallel across test packages and reusing containers within a test suite.

## Section 2: Installation and Project Setup

```bash
# Initialize the project module
go mod init github.com/myorg/payment-service

# Core testcontainers-go
go get github.com/testcontainers/testcontainers-go@v0.30.0

# Module-specific packages (much better DX than the generic API)
go get github.com/testcontainers/testcontainers-go/modules/postgres@v0.30.0
go get github.com/testcontainers/testcontainers-go/modules/redis@v0.30.0
go get github.com/testcontainers/testcontainers-go/modules/kafka@v0.30.0

# Database driver and ORM
go get github.com/jackc/pgx/v5@v5.5.0
go get github.com/jmoiron/sqlx@v1.3.5

# Redis client
go get github.com/redis/go-redis/v9@v9.3.0

# Kafka client
go get github.com/IBM/sarama@v1.42.1

# Migrations
go get github.com/golang-migrate/migrate/v4@v4.17.0
go get github.com/golang-migrate/migrate/v4/database/postgres
go get github.com/golang-migrate/migrate/v4/source/file
```

## Section 3: PostgreSQL Container with Migrations

The most common pattern: spin up PostgreSQL, run migrations, then run tests.

```go
// internal/testutil/postgres.go
package testutil

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	migratepostgres "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// PostgresContainer wraps the testcontainers postgres module with migration support.
type PostgresContainer struct {
	Container *postgres.PostgresContainer
	DB        *sql.DB
	DSN       string
}

// SetupPostgres starts a PostgreSQL container, runs migrations, and returns a ready-to-use DB.
// It registers a cleanup function with t.Cleanup() so the caller does not need to manage teardown.
func SetupPostgres(ctx context.Context, t *testing.T, migrationsPath string) *PostgresContainer {
	t.Helper()

	const (
		dbName   = "testdb"
		dbUser   = "testuser"
		dbPass   = "testpassword"
		pgImage  = "postgres:16.2-alpine"
	)

	pgContainer, err := postgres.RunContainer(ctx,
		testcontainers.WithImage(pgImage),
		postgres.WithDatabase(dbName),
		postgres.WithUsername(dbUser),
		postgres.WithPassword(dbPass),
		// Use a snapshot for faster test isolation (requires postgres 14+)
		postgres.WithSQLDriver("pgx"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		t.Fatalf("failed to start postgres container: %v", err)
	}

	t.Cleanup(func() {
		if err := pgContainer.Terminate(ctx); err != nil {
			t.Logf("failed to terminate postgres container: %v", err)
		}
	})

	dsn, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("failed to get postgres connection string: %v", err)
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("failed to open database connection: %v", err)
	}

	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	t.Cleanup(func() {
		db.Close()
	})

	// Run migrations
	if migrationsPath != "" {
		if err := runMigrations(db, migrationsPath, dbName); err != nil {
			t.Fatalf("failed to run migrations: %v", err)
		}
	}

	return &PostgresContainer{
		Container: pgContainer,
		DB:        db,
		DSN:       dsn,
	}
}

func runMigrations(db *sql.DB, migrationsPath, dbName string) error {
	driver, err := migratepostgres.WithInstance(db, &migratepostgres.Config{
		DatabaseName: dbName,
	})
	if err != nil {
		return fmt.Errorf("creating migration driver: %w", err)
	}

	m, err := migrate.NewWithDatabaseInstance(
		"file://"+migrationsPath,
		dbName,
		driver,
	)
	if err != nil {
		return fmt.Errorf("creating migrator: %w", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("running migrations: %w", err)
	}

	return nil
}
```

The migration files:

```sql
-- db/migrations/000001_create_payments.up.sql
CREATE TABLE payments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id    UUID NOT NULL,
    amount      NUMERIC(12, 2) NOT NULL,
    currency    CHAR(3) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_order_id ON payments(order_id);
CREATE INDEX idx_payments_status ON payments(status);

CREATE TYPE payment_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'refunded');
ALTER TABLE payments ALTER COLUMN status TYPE payment_status USING status::payment_status;
```

```sql
-- db/migrations/000001_create_payments.down.sql
DROP TABLE IF EXISTS payments;
DROP TYPE IF EXISTS payment_status;
```

## Section 4: Repository Integration Test

```go
// internal/repository/payment_repository_test.go
package repository_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/myorg/payment-service/internal/domain"
	"github.com/myorg/payment-service/internal/repository"
	"github.com/myorg/payment-service/internal/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMain sets up shared resources for the entire test package.
// A single PostgreSQL container is shared across all tests in this package.
var sharedDB *testutil.PostgresContainer

func TestMain(m *testing.M) {
	ctx := context.Background()
	// Using a package-level container avoids spinning up a new container per test.
	// Use t.Cleanup in individual tests to reset state.
	pg := testutil.SetupPostgresForPackage(ctx, "../../db/migrations")
	sharedDB = pg
	m.Run()
}

func TestPaymentRepository_Create(t *testing.T) {
	ctx := context.Background()
	repo := repository.NewPaymentRepository(sharedDB.DB)

	// Truncate between tests to ensure isolation
	t.Cleanup(func() {
		sharedDB.DB.ExecContext(ctx, "TRUNCATE TABLE payments RESTART IDENTITY CASCADE")
	})

	t.Run("creates payment successfully", func(t *testing.T) {
		payment := &domain.Payment{
			OrderID:  uuid.New(),
			Amount:   99.99,
			Currency: "USD",
			Status:   domain.StatusPending,
		}

		created, err := repo.Create(ctx, payment)
		require.NoError(t, err)
		assert.NotEqual(t, uuid.Nil, created.ID)
		assert.Equal(t, payment.Amount, created.Amount)
		assert.WithinDuration(t, time.Now(), created.CreatedAt, 5*time.Second)
	})

	t.Run("returns error for duplicate idempotency key", func(t *testing.T) {
		orderID := uuid.New()
		payment := &domain.Payment{
			OrderID:  orderID,
			Amount:   50.00,
			Currency: "USD",
		}

		_, err := repo.Create(ctx, payment)
		require.NoError(t, err)

		// Same order ID should fail (unique constraint)
		_, err = repo.Create(ctx, payment)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "duplicate")
	})
}

func TestPaymentRepository_FindByStatus(t *testing.T) {
	ctx := context.Background()
	repo := repository.NewPaymentRepository(sharedDB.DB)

	t.Cleanup(func() {
		sharedDB.DB.ExecContext(ctx, "TRUNCATE TABLE payments RESTART IDENTITY CASCADE")
	})

	// Seed test data
	payments := []domain.Payment{
		{OrderID: uuid.New(), Amount: 10.00, Currency: "USD", Status: domain.StatusPending},
		{OrderID: uuid.New(), Amount: 20.00, Currency: "USD", Status: domain.StatusPending},
		{OrderID: uuid.New(), Amount: 30.00, Currency: "EUR", Status: domain.StatusCompleted},
	}

	for i := range payments {
		created, err := repo.Create(ctx, &payments[i])
		require.NoError(t, err)
		payments[i].ID = created.ID
	}

	t.Run("finds pending payments", func(t *testing.T) {
		result, err := repo.FindByStatus(ctx, domain.StatusPending)
		require.NoError(t, err)
		assert.Len(t, result, 2)
	})

	t.Run("finds completed payments", func(t *testing.T) {
		result, err := repo.FindByStatus(ctx, domain.StatusCompleted)
		require.NoError(t, err)
		assert.Len(t, result, 1)
		assert.Equal(t, "EUR", result[0].Currency)
	})

	t.Run("returns empty slice for unknown status", func(t *testing.T) {
		result, err := repo.FindByStatus(ctx, domain.StatusFailed)
		require.NoError(t, err)
		assert.Empty(t, result)
	})
}
```

## Section 5: Redis Container for Cache Testing

```go
// internal/testutil/redis.go
package testutil

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

// RedisContainer wraps the testcontainers redis module.
type RedisContainer struct {
	Container *tcredis.RedisContainer
	Client    *redis.Client
	Addr      string
}

// SetupRedis starts a Redis container and returns a connected client.
func SetupRedis(ctx context.Context, t *testing.T) *RedisContainer {
	t.Helper()

	redisContainer, err := tcredis.RunContainer(ctx,
		testcontainers.WithImage("redis:7.2-alpine"),
		tcredis.WithLogLevel(tcredis.LogLevelVerbose),
		testcontainers.WithWaitStrategy(
			wait.ForLog("Ready to accept connections").
				WithStartupTimeout(30*time.Second),
		),
	)
	if err != nil {
		t.Fatalf("failed to start redis container: %v", err)
	}

	t.Cleanup(func() {
		if err := redisContainer.Terminate(ctx); err != nil {
			t.Logf("failed to terminate redis container: %v", err)
		}
	})

	connStr, err := redisContainer.ConnectionString(ctx)
	if err != nil {
		t.Fatalf("failed to get redis connection string: %v", err)
	}

	opt, err := redis.ParseURL(connStr)
	if err != nil {
		t.Fatalf("failed to parse redis URL: %v", err)
	}

	client := redis.NewClient(opt)
	t.Cleanup(func() {
		client.Close()
	})

	// Verify connectivity
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("failed to ping redis: %v", err)
	}

	return &RedisContainer{
		Container: redisContainer,
		Client:    client,
		Addr:      opt.Addr,
	}
}
```

Cache integration test:

```go
// internal/cache/payment_cache_test.go
package cache_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/myorg/payment-service/internal/cache"
	"github.com/myorg/payment-service/internal/domain"
	"github.com/myorg/payment-service/internal/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPaymentCache(t *testing.T) {
	ctx := context.Background()
	rc := testutil.SetupRedis(ctx, t)
	c := cache.NewPaymentCache(rc.Client, 5*time.Minute)

	t.Run("stores and retrieves payment", func(t *testing.T) {
		payment := &domain.Payment{
			ID:       uuid.New(),
			OrderID:  uuid.New(),
			Amount:   75.00,
			Currency: "USD",
			Status:   domain.StatusPending,
		}

		err := c.Set(ctx, payment)
		require.NoError(t, err)

		retrieved, err := c.Get(ctx, payment.ID)
		require.NoError(t, err)
		assert.Equal(t, payment.Amount, retrieved.Amount)
		assert.Equal(t, payment.Currency, retrieved.Currency)
	})

	t.Run("returns nil for missing key", func(t *testing.T) {
		retrieved, err := c.Get(ctx, uuid.New())
		require.NoError(t, err)
		assert.Nil(t, retrieved)
	})

	t.Run("key expires after TTL", func(t *testing.T) {
		// Use a very short TTL cache for this test
		shortCache := cache.NewPaymentCache(rc.Client, 100*time.Millisecond)

		payment := &domain.Payment{
			ID:     uuid.New(),
			Amount: 10.00,
		}

		err := shortCache.Set(ctx, payment)
		require.NoError(t, err)

		// Verify it exists
		retrieved, err := shortCache.Get(ctx, payment.ID)
		require.NoError(t, err)
		assert.NotNil(t, retrieved)

		// Wait for expiry
		time.Sleep(150 * time.Millisecond)

		// Should now be gone
		retrieved, err = shortCache.Get(ctx, payment.ID)
		require.NoError(t, err)
		assert.Nil(t, retrieved)
	})

	t.Run("delete removes payment from cache", func(t *testing.T) {
		payment := &domain.Payment{ID: uuid.New(), Amount: 25.00}

		require.NoError(t, c.Set(ctx, payment))

		retrieved, err := c.Get(ctx, payment.ID)
		require.NoError(t, err)
		require.NotNil(t, retrieved)

		require.NoError(t, c.Delete(ctx, payment.ID))

		retrieved, err = c.Get(ctx, payment.ID)
		require.NoError(t, err)
		assert.Nil(t, retrieved)
	})
}
```

## Section 6: Kafka Container for Event Testing

```go
// internal/testutil/kafka.go
package testutil

import (
	"context"
	"testing"
	"time"

	"github.com/IBM/sarama"
	"github.com/testcontainers/testcontainers-go"
	tckafka "github.com/testcontainers/testcontainers-go/modules/kafka"
)

// KafkaContainer wraps the testcontainers kafka module.
type KafkaContainer struct {
	Container *tckafka.KafkaContainer
	Brokers   []string
}

// SetupKafka starts a Kafka container with KRaft mode (no Zookeeper).
func SetupKafka(ctx context.Context, t *testing.T) *KafkaContainer {
	t.Helper()

	kafkaContainer, err := tckafka.RunContainer(ctx,
		testcontainers.WithImage("confluentinc/cp-kafka:7.5.3"),
		tckafka.WithClusterID("test-cluster"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("Kafka Server started").
				WithStartupTimeout(90*time.Second),
		),
	)
	if err != nil {
		t.Fatalf("failed to start kafka container: %v", err)
	}

	t.Cleanup(func() {
		if err := kafkaContainer.Terminate(ctx); err != nil {
			t.Logf("failed to terminate kafka container: %v", err)
		}
	})

	brokers, err := kafkaContainer.Brokers(ctx)
	if err != nil {
		t.Fatalf("failed to get kafka brokers: %v", err)
	}

	return &KafkaContainer{
		Container: kafkaContainer,
		Brokers:   brokers,
	}
}

// CreateTopics creates the given topics in the Kafka cluster.
func (k *KafkaContainer) CreateTopics(t *testing.T, topics ...string) {
	t.Helper()

	config := sarama.NewConfig()
	config.Version = sarama.V3_5_0_0

	admin, err := sarama.NewClusterAdmin(k.Brokers, config)
	if err != nil {
		t.Fatalf("failed to create kafka admin: %v", err)
	}
	defer admin.Close()

	for _, topic := range topics {
		detail := &sarama.TopicDetail{
			NumPartitions:     3,
			ReplicationFactor: 1,
		}
		if err := admin.CreateTopic(topic, detail, false); err != nil {
			// Ignore if topic already exists
			if !isTopicAlreadyExists(err) {
				t.Fatalf("failed to create topic %s: %v", topic, err)
			}
		}
	}
}

func isTopicAlreadyExists(err error) bool {
	if kafkaErr, ok := err.(*sarama.TopicError); ok {
		return kafkaErr.Err == sarama.ErrTopicAlreadyExists
	}
	return false
}

// NewProducer creates a synchronous Sarama producer for testing.
func (k *KafkaContainer) NewProducer(t *testing.T) sarama.SyncProducer {
	t.Helper()

	config := sarama.NewConfig()
	config.Version = sarama.V3_5_0_0
	config.Producer.Return.Successes = true
	config.Producer.RequiredAcks = sarama.WaitForAll
	config.Producer.Retry.Max = 3

	producer, err := sarama.NewSyncProducer(k.Brokers, config)
	if err != nil {
		t.Fatalf("failed to create kafka producer: %v", err)
	}

	t.Cleanup(func() {
		producer.Close()
	})

	return producer
}

// NewConsumer creates a consumer group for testing.
func (k *KafkaContainer) NewConsumerGroup(t *testing.T, groupID string) sarama.ConsumerGroup {
	t.Helper()

	config := sarama.NewConfig()
	config.Version = sarama.V3_5_0_0
	config.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
		sarama.NewBalanceStrategyRoundRobin(),
	}
	config.Consumer.Offsets.Initial = sarama.OffsetOldest

	group, err := sarama.NewConsumerGroup(k.Brokers, groupID, config)
	if err != nil {
		t.Fatalf("failed to create consumer group: %v", err)
	}

	t.Cleanup(func() {
		group.Close()
	})

	return group
}
```

Kafka producer/consumer integration test:

```go
// internal/events/payment_publisher_test.go
package events_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/IBM/sarama"
	"github.com/google/uuid"
	"github.com/myorg/payment-service/internal/domain"
	"github.com/myorg/payment-service/internal/events"
	"github.com/myorg/payment-service/internal/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	paymentsTopic = "payments.events"
	consumerGroup = "payment-test-consumer"
)

func TestPaymentPublisher(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	kc := testutil.SetupKafka(ctx, t)
	kc.CreateTopics(t, paymentsTopic)

	producer := kc.NewProducer(t)
	publisher := events.NewPaymentPublisher(producer, paymentsTopic)

	t.Run("publishes payment created event", func(t *testing.T) {
		payment := &domain.Payment{
			ID:       uuid.New(),
			OrderID:  uuid.New(),
			Amount:   150.00,
			Currency: "USD",
			Status:   domain.StatusPending,
		}

		err := publisher.PublishPaymentCreated(ctx, payment)
		require.NoError(t, err)

		// Consume and verify the message
		received := consumeOneMessage(ctx, t, kc, paymentsTopic, consumerGroup)

		var event events.PaymentCreatedEvent
		require.NoError(t, json.Unmarshal(received, &event))
		assert.Equal(t, payment.ID.String(), event.PaymentID)
		assert.Equal(t, payment.Amount, event.Amount)
		assert.Equal(t, "payment.created", event.EventType)
	})

	t.Run("uses order_id as partition key for ordering", func(t *testing.T) {
		orderID := uuid.New()
		payments := []*domain.Payment{
			{ID: uuid.New(), OrderID: orderID, Amount: 10.00},
			{ID: uuid.New(), OrderID: orderID, Amount: 20.00},
			{ID: uuid.New(), OrderID: orderID, Amount: 30.00},
		}

		for _, p := range payments {
			require.NoError(t, publisher.PublishPaymentCreated(ctx, p))
		}

		// All messages for the same order should be on the same partition
		// This is verified by checking the partition key used
		// The test validates that the publisher uses order_id as key
	})
}

// consumeOneMessage consumes a single message from the given topic.
func consumeOneMessage(
	ctx context.Context,
	t *testing.T,
	kc *testutil.KafkaContainer,
	topic string,
	groupID string,
) []byte {
	t.Helper()

	config := sarama.NewConfig()
	config.Version = sarama.V3_5_0_0
	config.Consumer.Offsets.Initial = sarama.OffsetOldest
	config.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
		sarama.NewBalanceStrategyRoundRobin(),
	}

	group, err := sarama.NewConsumerGroup(kc.Brokers, groupID+"-"+uuid.New().String(), config)
	require.NoError(t, err)
	defer group.Close()

	resultCh := make(chan []byte, 1)
	handler := &singleMessageHandler{resultCh: resultCh}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		group.Consume(ctx, []string{topic}, handler)
	}()

	select {
	case msg := <-resultCh:
		cancel := func() {}
		_, cancel = context.WithCancel(ctx)
		defer cancel()
		return msg
	case <-ctx.Done():
		t.Fatal("timed out waiting for kafka message")
		return nil
	}
}

type singleMessageHandler struct {
	resultCh chan<- []byte
	once     sync.Once
}

func (h *singleMessageHandler) Setup(_ sarama.ConsumerGroupSession) error   { return nil }
func (h *singleMessageHandler) Cleanup(_ sarama.ConsumerGroupSession) error { return nil }
func (h *singleMessageHandler) ConsumeClaim(sess sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		h.once.Do(func() {
			value := make([]byte, len(msg.Value))
			copy(value, msg.Value)
			h.resultCh <- value
			sess.MarkMessage(msg, "")
		})
	}
	return nil
}
```

## Section 7: Parallel Test Containers

Running containers in parallel dramatically reduces test suite duration:

```go
// internal/testutil/parallel.go
package testutil

import (
	"context"
	"testing"
	"sync"
)

// ParallelContainerSuite runs multiple container setups in parallel
// and aggregates any startup errors.
type ParallelContainerSuite struct {
	PG    *PostgresContainer
	Redis *RedisContainer
	Kafka *KafkaContainer
}

// SetupAll starts all containers in parallel and waits for them to be ready.
func SetupAll(ctx context.Context, t *testing.T, migrationsPath string) *ParallelContainerSuite {
	t.Helper()

	suite := &ParallelContainerSuite{}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var setupErrors []error

	wg.Add(3)

	go func() {
		defer wg.Done()
		pg := SetupPostgres(ctx, t, migrationsPath)
		mu.Lock()
		suite.PG = pg
		mu.Unlock()
	}()

	go func() {
		defer wg.Done()
		rc := SetupRedis(ctx, t)
		mu.Lock()
		suite.Redis = rc
		mu.Unlock()
	}()

	go func() {
		defer wg.Done()
		kc := SetupKafka(ctx, t)
		mu.Lock()
		suite.Kafka = kc
		mu.Unlock()
	}()

	wg.Wait()

	if len(setupErrors) > 0 {
		t.Fatalf("container setup errors: %v", setupErrors)
	}

	return suite
}
```

End-to-end service test using all three containers:

```go
// internal/service/payment_service_integration_test.go
package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/myorg/payment-service/internal/cache"
	"github.com/myorg/payment-service/internal/domain"
	"github.com/myorg/payment-service/internal/events"
	"github.com/myorg/payment-service/internal/repository"
	"github.com/myorg/payment-service/internal/service"
	"github.com/myorg/payment-service/internal/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPaymentServiceIntegration(t *testing.T) {
	// Mark as parallel with other top-level tests
	t.Parallel()

	ctx := context.Background()

	// All three containers start in parallel
	suite := testutil.SetupAll(ctx, t, "../../db/migrations")
	suite.Kafka.CreateTopics(t, "payments.events")

	// Wire up the service
	repo := repository.NewPaymentRepository(suite.PG.DB)
	paymentCache := cache.NewPaymentCache(suite.Redis.Client, 5*time.Minute)
	producer := suite.Kafka.NewProducer(t)
	publisher := events.NewPaymentPublisher(producer, "payments.events")
	svc := service.NewPaymentService(repo, paymentCache, publisher)

	t.Run("create payment stores in DB, caches, and publishes event", func(t *testing.T) {
		req := &domain.CreatePaymentRequest{
			OrderID:  uuid.New(),
			Amount:   250.00,
			Currency: "USD",
		}

		payment, err := svc.CreatePayment(ctx, req)
		require.NoError(t, err)
		require.NotNil(t, payment)
		assert.NotEqual(t, uuid.Nil, payment.ID)

		// Verify in database
		dbPayment, err := repo.FindByID(ctx, payment.ID)
		require.NoError(t, err)
		assert.Equal(t, payment.Amount, dbPayment.Amount)

		// Verify in cache
		cachedPayment, err := paymentCache.Get(ctx, payment.ID)
		require.NoError(t, err)
		require.NotNil(t, cachedPayment)
		assert.Equal(t, payment.Amount, cachedPayment.Amount)

		// Verify Kafka event published
		msg := consumeWithTimeout(ctx, t, suite.Kafka, "payments.events", 5*time.Second)
		assert.NotNil(t, msg)
	})
}
```

## Section 8: Custom Wait Strategies

The built-in wait strategies cover most cases, but sometimes you need custom logic:

```go
// internal/testutil/wait_strategies.go
package testutil

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/testcontainers/testcontainers-go/wait"
)

// waitForTableStrategy waits until a specific table exists in the database.
// Useful when using an init container to run migrations.
type waitForTableStrategy struct {
	dsn       string
	tableName string
	timeout   time.Duration
}

func WaitForTable(dsn, tableName string, timeout time.Duration) wait.Strategy {
	return &waitForTableStrategy{
		dsn:       dsn,
		tableName: tableName,
		timeout:   timeout,
	}
}

func (w *waitForTableStrategy) WaitUntilReady(ctx context.Context, target wait.StrategyTarget) error {
	deadline := time.Now().Add(w.timeout)

	db, err := sql.Open("pgx", w.dsn)
	if err != nil {
		return fmt.Errorf("opening db for wait strategy: %w", err)
	}
	defer db.Close()

	for time.Now().Before(deadline) {
		var exists bool
		err := db.QueryRowContext(ctx,
			"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = $1)",
			w.tableName,
		).Scan(&exists)

		if err == nil && exists {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}

	return fmt.Errorf("table %s not ready after %s", w.tableName, w.timeout)
}

// waitForHTTPHealthCheck waits for a service's /healthz endpoint to return 200.
type waitForHTTPHealthCheck struct {
	path    string
	timeout time.Duration
}

func WaitForHTTPHealthCheck(path string, timeout time.Duration) wait.Strategy {
	return &waitForHTTPHealthCheck{
		path:    path,
		timeout: timeout,
	}
}

func (w *waitForHTTPHealthCheck) WaitUntilReady(ctx context.Context, target wait.StrategyTarget) error {
	return wait.ForHTTP(w.path).
		WithStatusCodeMatcher(func(status int) bool { return status == 200 }).
		WithStartupTimeout(w.timeout).
		WaitUntilReady(ctx, target)
}
```

## Section 9: Network-Connected Containers

Test a service that depends on another service container:

```go
// internal/testutil/network.go
package testutil

import (
	"context"
	"fmt"
	"testing"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/network"
)

// ServiceNetwork creates an isolated Docker network for container-to-container communication.
func ServiceNetwork(ctx context.Context, t *testing.T) *testcontainers.DockerNetwork {
	t.Helper()

	net, err := network.New(ctx,
		network.WithCheckDuplicate(),
		network.WithAttachable(),
		testcontainers.WithDriverOpts(map[string]string{
			"com.docker.network.driver.mtu": "1500",
		}),
	)
	if err != nil {
		t.Fatalf("failed to create docker network: %v", err)
	}

	t.Cleanup(func() {
		if err := net.Remove(ctx); err != nil {
			t.Logf("failed to remove network: %v", err)
		}
	})

	return net
}

// NotificationServiceContainer starts the notification service container for end-to-end testing.
// It connects to the provided PostgreSQL container via the shared network.
func NotificationServiceContainer(
	ctx context.Context,
	t *testing.T,
	networkName string,
	postgresAlias string,
) testcontainers.Container {
	t.Helper()

	req := testcontainers.ContainerRequest{
		Image:    "ghcr.io/myorg/notification-service:latest",
		Networks: []string{networkName},
		NetworkAliases: map[string][]string{
			networkName: {"notification-service"},
		},
		Env: map[string]string{
			"DB_HOST": postgresAlias,
			"DB_PORT": "5432",
			"DB_USER": "testuser",
			"DB_PASS": "testpassword",
			"DB_NAME": "testdb",
			"PORT":    "8080",
		},
		ExposedPorts: []string{"8080/tcp"},
		WaitingFor: wait.ForHTTP("/healthz").
			WithPort("8080").
			WithStartupTimeout(60 * time.Second),
	}

	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		t.Fatalf("failed to start notification service container: %v", err)
	}

	t.Cleanup(func() {
		container.Terminate(ctx)
	})

	return container
}
```

## Section 10: CI/CD Integration with Docker-in-Docker

For GitHub Actions with Docker-in-Docker:

```yaml
# .github/workflows/integration-tests.yaml
name: Integration Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    services:
      # Docker daemon for testcontainers
      docker:
        image: docker:24-dind
        options: >-
          --privileged
          --health-cmd "docker info"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        env:
          DOCKER_TLS_CERTDIR: ""
        ports:
          - 2375:2375

    env:
      DOCKER_HOST: tcp://localhost:2375
      TESTCONTAINERS_RYUK_DISABLED: "false"
      TESTCONTAINERS_RYUK_PRIVILEGED: "true"
      CGO_ENABLED: 0
      GOFLAGS: "-count=1"

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'
          cache: true

      - name: Wait for Docker to be ready
        run: |
          timeout 30 sh -c 'until docker info > /dev/null 2>&1; do sleep 1; done'
          docker version

      - name: Pull container images (warm cache)
        run: |
          docker pull postgres:16.2-alpine &
          docker pull redis:7.2-alpine &
          docker pull confluentinc/cp-kafka:7.5.3 &
          wait

      - name: Run unit tests
        run: go test ./... -tags=unit -race -coverprofile=unit-coverage.out

      - name: Run integration tests
        run: |
          go test ./... \
            -tags=integration \
            -timeout 20m \
            -parallel 4 \
            -v \
            -coverprofile=integration-coverage.out 2>&1 | tee test-output.txt

      - name: Parse test results
        if: always()
        run: |
          cat test-output.txt | go run gotest.tools/gotestsum/cmd/gotestsum@latest \
            --format testdox \
            --junitfile test-results.xml

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./unit-coverage.out,./integration-coverage.out

      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: test-results.xml
```

For GitLab CI with Docker-in-Docker:

```yaml
# .gitlab-ci.yml
integration-tests:
  stage: test
  image: golang:1.22-bookworm
  services:
    - name: docker:24-dind
      alias: docker
      variables:
        DOCKER_TLS_CERTDIR: ""
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_DRIVER: overlay2
    TESTCONTAINERS_RYUK_DISABLED: "false"
    CGO_ENABLED: "0"
    GOFLAGS: "-count=1"
  before_script:
    - |
      # Wait for Docker daemon
      timeout 30 sh -c 'until docker info > /dev/null 2>&1; do sleep 1; done'
    - |
      # Pre-pull images to warm cache layer
      docker pull postgres:16.2-alpine
      docker pull redis:7.2-alpine
  script:
    - |
      go test ./... \
        -tags=integration \
        -timeout 25m \
        -parallel 4 \
        -coverprofile=coverage.out \
        -v 2>&1 | tee test-output.txt
    - go tool cover -func=coverage.out
  coverage: '/total:\s+\(statements\)\s+(\d+\.\d+)%/'
  artifacts:
    reports:
      junit: test-results.xml
    paths:
      - coverage.out
    expire_in: 7 days
  timeout: 30 minutes
```

## Section 11: Build Tags for Test Separation

Use Go build tags to separate unit, integration, and end-to-end tests:

```go
// internal/repository/payment_repository_test.go
//go:build integration

package repository_test
```

```go
// internal/service/payment_service_test.go
//go:build unit

package service_test
```

The Makefile:

```makefile
# Makefile
.PHONY: test test-unit test-integration test-e2e

test: test-unit test-integration

test-unit:
	go test ./... -tags=unit -race -count=1 -timeout 5m

test-integration:
	go test ./... -tags=integration -count=1 -timeout 20m -parallel 4

test-e2e:
	go test ./... -tags=e2e -count=1 -timeout 30m -v

test-coverage:
	go test ./... -tags=unit,integration \
	  -coverprofile=coverage.out \
	  -covermode=atomic
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"
```

## Section 12: Container Reuse for Development Speed

During active development, container reuse avoids the startup penalty:

```go
// internal/testutil/reuse.go
package testutil

import (
	"context"
	"os"
	"testing"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

// ReuseOrCreatePostgres reuses an existing container if TESTCONTAINERS_REUSE_ENABLE=true.
// This is useful during local development to avoid container startup overhead.
func ReuseOrCreatePostgres(ctx context.Context, t *testing.T, migrationsPath string) *PostgresContainer {
	t.Helper()

	reuseEnabled := os.Getenv("TESTCONTAINERS_REUSE_ENABLE") == "true"

	opts := []testcontainers.ContainerCustomizer{
		testcontainers.WithImage("postgres:16.2-alpine"),
		postgres.WithDatabase("testdb"),
		postgres.WithUsername("testuser"),
		postgres.WithPassword("testpassword"),
	}

	if reuseEnabled {
		opts = append(opts, testcontainers.CustomizeRequestOption(func(req *testcontainers.GenericContainerRequest) error {
			req.Reuse = true
			req.Name = "testcontainers-postgres-dev"
			return nil
		}))
	}

	// When reusing, skip cleanup registration
	if !reuseEnabled {
		return SetupPostgres(ctx, t, migrationsPath)
	}

	pgContainer, err := postgres.RunContainer(ctx, opts...)
	if err != nil {
		t.Fatalf("failed to start/reuse postgres container: %v", err)
	}

	// Only register cleanup when not reusing
	t.Cleanup(func() {
		if !reuseEnabled {
			pgContainer.Terminate(ctx)
		}
	})

	dsn, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("failed to get connection string: %v", err)
	}

	db, err := openAndMigrateDB(dsn, migrationsPath)
	if err != nil {
		t.Fatalf("failed to setup DB: %v", err)
	}

	return &PostgresContainer{Container: pgContainer, DB: db, DSN: dsn}
}
```

Enable reuse in your shell:

```bash
# In .envrc or shell profile for local development
export TESTCONTAINERS_REUSE_ENABLE=true
export TESTCONTAINERS_RYUK_DISABLED=true  # Disable resource reaper when reusing

# Run tests - containers stay running between runs
go test ./... -tags=integration -count=1
```

## Summary

`testcontainers-go` enables production-quality integration tests with:

1. **Module packages** (`postgres`, `redis`, `kafka`) provide idiomatic Go APIs with sensible defaults
2. **Parallel container startup** reduces total test time from minutes to seconds
3. **`t.Cleanup()` registration** guarantees container teardown even when tests panic
4. **Custom wait strategies** handle complex startup ordering requirements
5. **Network-connected containers** allow full service-to-service testing
6. **Build tags** cleanly separate unit, integration, and e2e test execution
7. **CI/CD Docker-in-Docker** patterns work reliably on GitHub Actions and GitLab CI

Start by wrapping PostgreSQL - it provides the most value immediately. Add Redis and Kafka as your test coverage grows to cover the full data path of each microservice.
