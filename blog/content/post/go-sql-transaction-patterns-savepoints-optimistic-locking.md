---
title: "Go SQL Transaction Patterns: Savepoints, Nested Transactions, and Optimistic Locking"
date: 2031-04-27T00:00:00-05:00
draft: false
tags: ["Go", "SQL", "PostgreSQL", "Transactions", "Database", "Golang"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go database transaction patterns for production systems: database/sql transaction lifecycle, savepoints for nested operations, optimistic locking with version columns, SELECT FOR UPDATE pessimistic locking, serialization failure retries, and pgx advanced transaction options."
more_link: "yes"
url: "/go-sql-transaction-patterns-savepoints-optimistic-locking/"
---

Transaction management is where production database systems fail in subtle ways. A transaction that spans too much work creates contention and deadlocks. A transaction with insufficient isolation loses data when concurrent writes occur. An optimistic locking implementation that does not retry on conflict fails silently under load. These failure modes don't appear in development with single-user test data — they emerge only in production under real concurrent load.

This guide covers the complete spectrum of Go database transaction patterns: the standard `database/sql` lifecycle with proper error handling, savepoints for nested operations within a transaction, optimistic locking with version columns for high-throughput concurrent updates, pessimistic locking with `SELECT FOR UPDATE` for critical sections, automatic retry on PostgreSQL serialization failures, and the advanced transaction options available through the `pgx` driver.

<!--more-->

# Go SQL Transaction Patterns: Savepoints, Nested Transactions, and Optimistic Locking

## Section 1: The database/sql Transaction Lifecycle

### Basic Transaction Pattern

The fundamental pattern for `database/sql` transactions uses `defer` with a named return value to ensure rollback on any error path:

```go
package db

import (
    "context"
    "database/sql"
    "fmt"
)

// withTx executes fn within a database transaction, committing on success
// and rolling back on any error.
func withTx(ctx context.Context, db *sql.DB, fn func(tx *sql.Tx) error) (err error) {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    // Deferred rollback: runs if err is non-nil when the function returns.
    // If commit succeeds, tx.Rollback() returns an error (tx already committed)
    // which we ignore. This pattern ensures rollback always happens on error.
    defer func() {
        if err != nil {
            if rbErr := tx.Rollback(); rbErr != nil {
                err = fmt.Errorf("transaction error: %w; rollback error: %v", err, rbErr)
            }
        }
    }()

    if err = fn(tx); err != nil {
        return err // defer will rollback
    }

    if err = tx.Commit(); err != nil {
        return fmt.Errorf("committing transaction: %w", err)
    }

    return nil
}

// withTxOptions begins a transaction with specific isolation level options.
func withTxOptions(ctx context.Context, db *sql.DB, opts *sql.TxOptions, fn func(tx *sql.Tx) error) (err error) {
    tx, err := db.BeginTx(ctx, opts)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }

    defer func() {
        if err != nil {
            _ = tx.Rollback()
        }
    }()

    if err = fn(tx); err != nil {
        return err
    }

    return tx.Commit()
}
```

### Transaction Isolation Levels

```go
// Read Committed (default for most databases)
opts := &sql.TxOptions{
    Isolation: sql.LevelReadCommitted,
    ReadOnly:  false,
}

// Repeatable Read — prevents non-repeatable reads
opts := &sql.TxOptions{
    Isolation: sql.LevelRepeatableRead,
}

// Serializable — highest isolation, may require retries on conflict
opts := &sql.TxOptions{
    Isolation: sql.LevelSerializable,
}

// Read-only transaction — allows database optimizations
opts := &sql.TxOptions{
    ReadOnly: true,
}
```

### Complete Order Processing Example

```go
// store/order_store.go
package store

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "time"
)

type Order struct {
    ID         int64
    CustomerID string
    Status     string
    TotalCents int64
    Version    int64
    CreatedAt  time.Time
    UpdatedAt  time.Time
}

type OrderItem struct {
    ProductID  string
    Quantity   int32
    PriceCents int64
}

type OrderStore struct {
    db *sql.DB
}

// CreateOrder creates an order with items and decrements inventory atomically.
func (s *OrderStore) CreateOrder(ctx context.Context, customerID string, items []OrderItem) (*Order, error) {
    var order Order

    err := withTx(ctx, s.db, func(tx *sql.Tx) error {
        // 1. Create the order record
        totalCents := int64(0)
        for _, item := range items {
            totalCents += item.PriceCents * int64(item.Quantity)
        }

        err := tx.QueryRowContext(ctx, `
            INSERT INTO orders (customer_id, status, total_cents, version, created_at, updated_at)
            VALUES ($1, 'pending', $2, 1, NOW(), NOW())
            RETURNING id, customer_id, status, total_cents, version, created_at, updated_at
        `, customerID, totalCents).Scan(
            &order.ID, &order.CustomerID, &order.Status,
            &order.TotalCents, &order.Version, &order.CreatedAt, &order.UpdatedAt,
        )
        if err != nil {
            return fmt.Errorf("inserting order: %w", err)
        }

        // 2. Insert order items
        for _, item := range items {
            _, err := tx.ExecContext(ctx, `
                INSERT INTO order_items (order_id, product_id, quantity, price_cents)
                VALUES ($1, $2, $3, $4)
            `, order.ID, item.ProductID, item.Quantity, item.PriceCents)
            if err != nil {
                return fmt.Errorf("inserting order item %s: %w", item.ProductID, err)
            }
        }

        // 3. Decrement inventory for each item
        for _, item := range items {
            result, err := tx.ExecContext(ctx, `
                UPDATE inventory
                SET available_quantity = available_quantity - $1,
                    reserved_quantity  = reserved_quantity  + $1,
                    updated_at = NOW()
                WHERE product_id = $2
                  AND available_quantity >= $1
            `, item.Quantity, item.ProductID)
            if err != nil {
                return fmt.Errorf("decrementing inventory for %s: %w", item.ProductID, err)
            }

            rowsAffected, _ := result.RowsAffected()
            if rowsAffected == 0 {
                // Insufficient inventory — the transaction will be rolled back
                return fmt.Errorf("insufficient inventory for product %s: %w",
                    item.ProductID, ErrInsufficientInventory)
            }
        }

        // 4. Create audit log entry
        _, err = tx.ExecContext(ctx, `
            INSERT INTO audit_log (entity_type, entity_id, action, actor_id, created_at)
            VALUES ('order', $1, 'created', $2, NOW())
        `, order.ID, customerID)
        if err != nil {
            return fmt.Errorf("inserting audit log: %w", err)
        }

        return nil
    })

    if err != nil {
        return nil, err
    }

    return &order, nil
}

var ErrInsufficientInventory = errors.New("insufficient inventory")
```

## Section 2: Savepoints for Nested Operations

Savepoints allow partial rollback within a transaction — you can undo a portion of work without rolling back the entire transaction. This is invaluable for "try this, fall back if it fails" patterns within a single database transaction.

### Savepoint Implementation

```go
// savepoint.go
package db

import (
    "context"
    "database/sql"
    "fmt"
    "sync/atomic"
)

// savepointCounter generates unique savepoint names.
var savepointCounter int64

// savepointName generates a unique savepoint name.
func savepointName() string {
    n := atomic.AddInt64(&savepointCounter, 1)
    return fmt.Sprintf("sp_%d", n)
}

// withSavepoint executes fn within a savepoint. If fn returns an error,
// the savepoint is rolled back (partial rollback within the transaction).
// If fn succeeds, the savepoint is released.
func withSavepoint(ctx context.Context, tx *sql.Tx, fn func() error) error {
    sp := savepointName()

    if _, err := tx.ExecContext(ctx, fmt.Sprintf("SAVEPOINT %s", sp)); err != nil {
        return fmt.Errorf("creating savepoint %s: %w", sp, err)
    }

    if err := fn(); err != nil {
        // Roll back to the savepoint — the outer transaction continues
        if _, rbErr := tx.ExecContext(ctx, fmt.Sprintf("ROLLBACK TO SAVEPOINT %s", sp)); rbErr != nil {
            return fmt.Errorf("savepoint error: %w; rollback error: %v", err, rbErr)
        }
        return err
    }

    // Release the savepoint (makes it permanent within the outer transaction)
    if _, err := tx.ExecContext(ctx, fmt.Sprintf("RELEASE SAVEPOINT %s", sp)); err != nil {
        return fmt.Errorf("releasing savepoint %s: %w", sp, err)
    }

    return nil
}
```

### Using Savepoints for "Try with Fallback" Logic

```go
// ProcessPaymentWithFallback processes a payment using the primary gateway,
// falling back to the secondary gateway if the primary fails, all within
// a single database transaction.
func (s *PaymentStore) ProcessPaymentWithFallback(
    ctx context.Context,
    orderID int64,
    amountCents int64,
    primaryGateway string,
    fallbackGateway string,
) error {
    return withTx(ctx, s.db, func(tx *sql.Tx) error {
        var paymentID int64

        // Try the primary gateway within a savepoint
        primaryErr := withSavepoint(ctx, tx, func() error {
            // Record the payment attempt
            err := tx.QueryRowContext(ctx, `
                INSERT INTO payment_attempts (order_id, gateway, amount_cents, status, created_at)
                VALUES ($1, $2, $3, 'processing', NOW())
                RETURNING id
            `, orderID, primaryGateway, amountCents).Scan(&paymentID)
            if err != nil {
                return fmt.Errorf("recording payment attempt: %w", err)
            }

            // Attempt the actual payment (may return error if gateway fails)
            txID, err := s.primaryGateway.Charge(ctx, amountCents)
            if err != nil {
                // This error causes the savepoint to roll back (only this INSERT)
                return fmt.Errorf("primary gateway charge: %w", err)
            }

            // Update the payment attempt as succeeded
            _, err = tx.ExecContext(ctx, `
                UPDATE payment_attempts
                SET status = 'succeeded', gateway_tx_id = $1, completed_at = NOW()
                WHERE id = $2
            `, txID, paymentID)
            return err
        })

        if primaryErr == nil {
            // Primary succeeded — nothing more to do
            return nil
        }

        // Primary failed — log the failure and try fallback
        // The savepoint rollback undid the INSERT above, so we can insert again
        s.logger.Warn("Primary payment gateway failed, trying fallback",
            zap.Int64("order_id", orderID),
            zap.Error(primaryErr))

        // Record the failure (outside savepoint — this will commit with the transaction)
        _, err := tx.ExecContext(ctx, `
            INSERT INTO payment_gateway_failures (order_id, gateway, error, created_at)
            VALUES ($1, $2, $3, NOW())
        `, orderID, primaryGateway, primaryErr.Error())
        if err != nil {
            return fmt.Errorf("recording gateway failure: %w", err)
        }

        // Try fallback gateway within a new savepoint
        fallbackErr := withSavepoint(ctx, tx, func() error {
            err := tx.QueryRowContext(ctx, `
                INSERT INTO payment_attempts (order_id, gateway, amount_cents, status, created_at)
                VALUES ($1, $2, $3, 'processing', NOW())
                RETURNING id
            `, orderID, fallbackGateway, amountCents).Scan(&paymentID)
            if err != nil {
                return fmt.Errorf("recording fallback payment attempt: %w", err)
            }

            txID, err := s.fallbackGateway.Charge(ctx, amountCents)
            if err != nil {
                return fmt.Errorf("fallback gateway charge: %w", err)
            }

            _, err = tx.ExecContext(ctx, `
                UPDATE payment_attempts
                SET status = 'succeeded', gateway_tx_id = $1, completed_at = NOW()
                WHERE id = $2
            `, txID, paymentID)
            return err
        })

        if fallbackErr != nil {
            return fmt.Errorf("all payment gateways failed: primary=%v, fallback=%v",
                primaryErr, fallbackErr)
        }

        return nil
    })
}
```

### Nested Savepoints for Recursive Operations

```go
// ProcessCategoryTree processes a category hierarchy, using savepoints
// to allow partial failures (a failed subcategory doesn't abort the whole tree).
func (s *CategoryStore) ProcessCategoryTree(ctx context.Context, tx *sql.Tx, categories []Category) error {
    for _, cat := range categories {
        catErr := withSavepoint(ctx, tx, func() error {
            // Insert this category
            var catID int64
            if err := tx.QueryRowContext(ctx, `
                INSERT INTO categories (name, parent_id, created_at)
                VALUES ($1, $2, NOW())
                RETURNING id
            `, cat.Name, cat.ParentID).Scan(&catID); err != nil {
                return fmt.Errorf("inserting category %s: %w", cat.Name, err)
            }

            // Recursively process children (each in their own savepoint)
            for i := range cat.Children {
                cat.Children[i].ParentID = &catID
            }
            return s.ProcessCategoryTree(ctx, tx, cat.Children)
        })

        if catErr != nil {
            // Log the failure but continue with other categories
            s.logger.Warn("Failed to process category",
                zap.String("category", cat.Name),
                zap.Error(catErr))
            // The savepoint was rolled back; this category and its children were not inserted
        }
    }
    return nil
}
```

## Section 3: Optimistic Locking with Version Columns

Optimistic locking assumes concurrent writes are rare. Each row has a version number; an update only succeeds if the version matches what was read. No locks are held between read and write.

### Schema Design

```sql
-- Products table with version column for optimistic locking
CREATE TABLE products (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    price_cents  BIGINT NOT NULL,
    stock_count  INTEGER NOT NULL DEFAULT 0,
    description  TEXT,
    version      BIGINT NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on version for efficient conflict detection
CREATE INDEX idx_products_version ON products(id, version);
```

### Optimistic Locking Implementation

```go
// ErrOptimisticLockConflict is returned when an optimistic lock conflict occurs.
var ErrOptimisticLockConflict = errors.New("optimistic lock conflict: record was modified by another transaction")

// Product represents a product with its optimistic lock version.
type Product struct {
    ID          int64
    Name        string
    PriceCents  int64
    StockCount  int32
    Description string
    Version     int64
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

// GetProduct retrieves a product by ID.
func (s *ProductStore) GetProduct(ctx context.Context, id int64) (*Product, error) {
    p := &Product{}
    err := s.db.QueryRowContext(ctx, `
        SELECT id, name, price_cents, stock_count, description, version, created_at, updated_at
        FROM products
        WHERE id = $1
    `, id).Scan(&p.ID, &p.Name, &p.PriceCents, &p.StockCount,
        &p.Description, &p.Version, &p.CreatedAt, &p.UpdatedAt)
    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("product %d: not found", id)
    }
    if err != nil {
        return nil, fmt.Errorf("getting product %d: %w", id, err)
    }
    return p, nil
}

// UpdateProduct updates a product using optimistic locking.
// Returns ErrOptimisticLockConflict if the product was modified since it was read.
func (s *ProductStore) UpdateProduct(ctx context.Context, p *Product) (*Product, error) {
    var updated Product

    result, err := s.db.QueryRowContext(ctx, `
        UPDATE products
        SET name        = $1,
            price_cents = $2,
            stock_count = $3,
            description = $4,
            version     = version + 1,
            updated_at  = NOW()
        WHERE id      = $5
          AND version = $6  -- Optimistic lock check
        RETURNING id, name, price_cents, stock_count, description, version, created_at, updated_at
    `, p.Name, p.PriceCents, p.StockCount, p.Description, p.ID, p.Version).Scan(
        &updated.ID, &updated.Name, &updated.PriceCents, &updated.StockCount,
        &updated.Description, &updated.Version, &updated.CreatedAt, &updated.UpdatedAt,
    )
    if err == sql.ErrNoRows {
        return nil, ErrOptimisticLockConflict
    }
    if err != nil {
        return nil, fmt.Errorf("updating product %d: %w", p.ID, err)
    }
    _ = result

    return &updated, nil
}
```

### Retry Loop for Optimistic Lock Conflicts

```go
// UpdateProductWithRetry reads and updates a product, retrying on optimistic lock conflicts.
func (s *ProductStore) UpdateProductWithRetry(
    ctx context.Context,
    productID int64,
    fn func(p *Product) error, // Caller applies changes to the product
) (*Product, error) {
    const maxAttempts = 5
    const retryDelay = 50 * time.Millisecond

    for attempt := 1; attempt <= maxAttempts; attempt++ {
        // Read the current version
        product, err := s.GetProduct(ctx, productID)
        if err != nil {
            return nil, fmt.Errorf("reading product: %w", err)
        }

        // Apply the caller's changes
        if err := fn(product); err != nil {
            return nil, fmt.Errorf("applying changes: %w", err)
        }

        // Attempt the update
        updated, err := s.UpdateProduct(ctx, product)
        if err == nil {
            if attempt > 1 {
                s.logger.Info("Optimistic lock conflict resolved",
                    zap.Int64("product_id", productID),
                    zap.Int("attempts", attempt))
            }
            return updated, nil
        }

        if !errors.Is(err, ErrOptimisticLockConflict) {
            // Non-conflict error — don't retry
            return nil, err
        }

        if attempt == maxAttempts {
            return nil, fmt.Errorf("product %d: %w after %d attempts",
                productID, ErrOptimisticLockConflict, maxAttempts)
        }

        // Exponential backoff with jitter
        delay := retryDelay * time.Duration(1<<uint(attempt-1))
        delay += time.Duration(rand.Int63n(int64(delay / 2)))

        s.logger.Debug("Optimistic lock conflict, retrying",
            zap.Int64("product_id", productID),
            zap.Int("attempt", attempt),
            zap.Duration("delay", delay))

        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(delay):
        }
    }

    return nil, fmt.Errorf("unreachable")
}

// Example usage: decrement stock with optimistic locking
func (s *ProductStore) DecrementStock(ctx context.Context, productID int64, quantity int32) error {
    _, err := s.UpdateProductWithRetry(ctx, productID, func(p *Product) error {
        if p.StockCount < quantity {
            return fmt.Errorf("insufficient stock: have %d, want %d",
                p.StockCount, quantity)
        }
        p.StockCount -= quantity
        return nil
    })
    return err
}
```

### Batch Optimistic Locking

For updating multiple records:

```go
// BulkUpdatePrices updates prices for multiple products with optimistic locking.
// Returns a map of productID → error for any failed updates.
func (s *ProductStore) BulkUpdatePrices(
    ctx context.Context,
    updates map[int64]int64, // productID → new price in cents
) map[int64]error {
    type versionedProduct struct {
        id      int64
        version int64
    }

    // Read all products in a single query
    ids := make([]int64, 0, len(updates))
    for id := range updates {
        ids = append(ids, id)
    }

    rows, err := s.db.QueryContext(ctx, `
        SELECT id, version FROM products WHERE id = ANY($1)
    `, pq.Array(ids))
    if err != nil {
        return map[int64]error{0: fmt.Errorf("reading versions: %w", err)}
    }
    defer rows.Close()

    versions := make(map[int64]int64)
    for rows.Next() {
        var id, version int64
        if err := rows.Scan(&id, &version); err != nil {
            return map[int64]error{0: err}
        }
        versions[id] = version
    }

    // Update each product within a transaction
    errors := make(map[int64]error)

    err = withTx(ctx, s.db, func(tx *sql.Tx) error {
        for productID, newPrice := range updates {
            version, ok := versions[productID]
            if !ok {
                errors[productID] = fmt.Errorf("product not found")
                continue
            }

            result, err := tx.ExecContext(ctx, `
                UPDATE products
                SET price_cents = $1, version = version + 1, updated_at = NOW()
                WHERE id = $2 AND version = $3
            `, newPrice, productID, version)
            if err != nil {
                errors[productID] = fmt.Errorf("updating: %w", err)
                continue
            }

            rowsAffected, _ := result.RowsAffected()
            if rowsAffected == 0 {
                errors[productID] = ErrOptimisticLockConflict
            }
        }
        return nil
    })
    if err != nil {
        return map[int64]error{0: err}
    }

    return errors
}
```

## Section 4: Pessimistic Locking with SELECT FOR UPDATE

Pessimistic locking acquires a row lock at read time, preventing other transactions from modifying the row until the lock is released (on commit or rollback).

### SELECT FOR UPDATE Pattern

```go
// ReserveInventory uses SELECT FOR UPDATE to prevent race conditions
// when reserving inventory items.
func (s *InventoryStore) ReserveInventory(
    ctx context.Context,
    productID string,
    quantity int32,
) error {
    return withTx(ctx, s.db, func(tx *sql.Tx) error {
        // Lock the inventory row for this product
        var available int32
        err := tx.QueryRowContext(ctx, `
            SELECT available_quantity
            FROM inventory
            WHERE product_id = $1
            FOR UPDATE  -- Acquires exclusive row lock
        `, productID).Scan(&available)
        if err == sql.ErrNoRows {
            return fmt.Errorf("product %s: inventory not found", productID)
        }
        if err != nil {
            return fmt.Errorf("locking inventory: %w", err)
        }

        // Now we hold the lock — no concurrent transaction can read
        // or modify this row until we commit or rollback
        if available < quantity {
            return fmt.Errorf("insufficient inventory: have %d, want %d",
                available, quantity)
        }

        _, err = tx.ExecContext(ctx, `
            UPDATE inventory
            SET available_quantity = available_quantity - $1,
                reserved_quantity  = reserved_quantity  + $1,
                updated_at = NOW()
            WHERE product_id = $2
        `, quantity, productID)
        if err != nil {
            return fmt.Errorf("updating inventory: %w", err)
        }

        return nil
    })
}
```

### SELECT FOR UPDATE SKIP LOCKED

`SKIP LOCKED` is a PostgreSQL extension that skips rows that are already locked, enabling queue-like patterns:

```go
// DequeueJob retrieves and locks the next available job from the queue.
// SKIP LOCKED prevents multiple workers from picking the same job.
func (s *JobStore) DequeueJob(ctx context.Context, workerID string) (*Job, error) {
    var job Job

    err := withTx(ctx, s.db, func(tx *sql.Tx) error {
        err := tx.QueryRowContext(ctx, `
            SELECT id, type, payload, created_at
            FROM jobs
            WHERE status = 'pending'
              AND (run_after IS NULL OR run_after <= NOW())
            ORDER BY priority DESC, created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED  -- Skip rows locked by other workers
        `).Scan(&job.ID, &job.Type, &job.Payload, &job.CreatedAt)
        if err == sql.ErrNoRows {
            return ErrNoJobAvailable
        }
        if err != nil {
            return fmt.Errorf("dequeuing job: %w", err)
        }

        // Mark job as in-progress (while still holding the lock)
        _, err = tx.ExecContext(ctx, `
            UPDATE jobs
            SET status = 'in_progress',
                worker_id = $1,
                started_at = NOW()
            WHERE id = $2
        `, workerID, job.ID)
        if err != nil {
            return fmt.Errorf("claiming job: %w", err)
        }

        return nil
    })

    if err != nil {
        return nil, err
    }
    return &job, nil
}

var ErrNoJobAvailable = errors.New("no job available")
```

### SELECT FOR UPDATE NOWAIT

`NOWAIT` returns an error immediately instead of waiting if the row is locked:

```go
// TryLockAccount attempts to acquire an exclusive lock on an account.
// Returns ErrLockNotAcquired if the account is currently locked.
func (s *AccountStore) TryLockAccount(ctx context.Context, tx *sql.Tx, accountID int64) (*Account, error) {
    var account Account

    err := tx.QueryRowContext(ctx, `
        SELECT id, balance_cents, version
        FROM accounts
        WHERE id = $1
        FOR UPDATE NOWAIT  -- Fail immediately if row is locked
    `, accountID).Scan(&account.ID, &account.BalanceCents, &account.Version)

    if err != nil {
        // PostgreSQL error code 55P03 is "lock_not_available"
        var pgErr *pgconn.PgError
        if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
            return nil, ErrLockNotAcquired
        }
        if err == sql.ErrNoRows {
            return nil, fmt.Errorf("account %d: not found", accountID)
        }
        return nil, fmt.Errorf("locking account: %w", err)
    }

    return &account, nil
}

var ErrLockNotAcquired = errors.New("lock not acquired: row is locked by another transaction")
```

## Section 5: Serialization Failure Retries

PostgreSQL's `SERIALIZABLE` isolation level provides the strongest consistency guarantees but may reject transactions with a "serialization failure" error (`40001`). These must be retried.

### Detecting and Retrying Serialization Failures

```go
// isSerializationFailure returns true if err is a PostgreSQL serialization failure.
// These must be retried from the beginning of the transaction.
func isSerializationFailure(err error) bool {
    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        // 40001: serialization_failure
        // 40P01: deadlock_detected
        return pgErr.Code == "40001" || pgErr.Code == "40P01"
    }
    return false
}

// withSerializableTx executes fn in a SERIALIZABLE transaction,
// automatically retrying on serialization failures.
func withSerializableTx(
    ctx context.Context,
    db *sql.DB,
    maxRetries int,
    fn func(tx *sql.Tx) error,
) error {
    opts := &sql.TxOptions{
        Isolation: sql.LevelSerializable,
    }

    for attempt := 1; attempt <= maxRetries; attempt++ {
        err := withTxOptions(ctx, db, opts, fn)
        if err == nil {
            return nil
        }

        if !isSerializationFailure(err) {
            return err // Non-retryable error
        }

        if attempt == maxRetries {
            return fmt.Errorf("transaction failed after %d attempts due to serialization conflict: %w",
                maxRetries, err)
        }

        // Exponential backoff
        delay := time.Duration(attempt) * 10 * time.Millisecond
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(delay):
        }
    }

    return fmt.Errorf("unreachable")
}

// Example: Transfer funds with serializable isolation
func (s *BankStore) TransferFunds(
    ctx context.Context,
    fromAccountID, toAccountID int64,
    amountCents int64,
) error {
    return withSerializableTx(ctx, s.db, 5, func(tx *sql.Tx) error {
        // Read both accounts (serializable snapshot)
        var fromBalance, toBalance int64

        if err := tx.QueryRowContext(ctx,
            "SELECT balance_cents FROM accounts WHERE id = $1",
            fromAccountID).Scan(&fromBalance); err != nil {
            return fmt.Errorf("reading from account: %w", err)
        }

        if err := tx.QueryRowContext(ctx,
            "SELECT balance_cents FROM accounts WHERE id = $1",
            toAccountID).Scan(&toBalance); err != nil {
            return fmt.Errorf("reading to account: %w", err)
        }

        if fromBalance < amountCents {
            return fmt.Errorf("insufficient funds: balance %d, required %d",
                fromBalance, amountCents)
        }

        // Debit source
        if _, err := tx.ExecContext(ctx, `
            UPDATE accounts
            SET balance_cents = balance_cents - $1, updated_at = NOW()
            WHERE id = $2
        `, amountCents, fromAccountID); err != nil {
            return fmt.Errorf("debiting from account: %w", err)
        }

        // Credit destination
        if _, err := tx.ExecContext(ctx, `
            UPDATE accounts
            SET balance_cents = balance_cents + $1, updated_at = NOW()
            WHERE id = $2
        `, amountCents, toAccountID); err != nil {
            return fmt.Errorf("crediting to account: %w", err)
        }

        // Record the transfer
        if _, err := tx.ExecContext(ctx, `
            INSERT INTO transfers (from_account_id, to_account_id, amount_cents, created_at)
            VALUES ($1, $2, $3, NOW())
        `, fromAccountID, toAccountID, amountCents); err != nil {
            return fmt.Errorf("recording transfer: %w", err)
        }

        return nil
    })
}
```

## Section 6: pgx Advanced Transaction Options

The `pgx` PostgreSQL driver provides additional transaction features beyond the standard `database/sql` interface.

### pgx Transaction with Access Mode and Deferral

```go
// pkg/db/pgx_transactions.go
package db

import (
    "context"
    "fmt"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

// WithPgxTx executes fn in a pgx transaction with the given options.
func WithPgxTx(ctx context.Context, pool *pgxpool.Pool, opts pgx.TxOptions, fn func(tx pgx.Tx) error) (err error) {
    tx, err := pool.BeginTx(ctx, opts)
    if err != nil {
        return fmt.Errorf("beginning pgx transaction: %w", err)
    }

    defer func() {
        if err != nil {
            _ = tx.Rollback(ctx)
        }
    }()

    if err = fn(tx); err != nil {
        return err
    }

    return tx.Commit(ctx)
}

// WithReadOnlyDeferrableTx creates a read-only DEFERRABLE transaction.
// DEFERRABLE read-only serializable transactions in PostgreSQL wait until
// they can be guaranteed to complete without interference — ideal for
// consistent long-running reports.
func WithReadOnlyDeferrableTx(ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) error) error {
    return WithPgxTx(ctx, pool, pgx.TxOptions{
        IsoLevel:   pgx.Serializable,
        AccessMode: pgx.ReadOnly,
        DeferrableMode: pgx.Deferrable,
    }, fn)
}

// WithRepeatableReadTx creates a REPEATABLE READ transaction.
func WithRepeatableReadTx(ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) error) error {
    return WithPgxTx(ctx, pool, pgx.TxOptions{
        IsoLevel:   pgx.RepeatableRead,
        AccessMode: pgx.ReadWrite,
    }, fn)
}
```

### Batch Queries in a Transaction

pgx supports batching multiple queries into a single round-trip:

```go
// CreateOrderBatch uses pgx batch to insert an order and all its items in one round-trip.
func (s *OrderStore) CreateOrderBatch(ctx context.Context, pool *pgxpool.Pool, order *Order, items []OrderItem) error {
    return WithPgxTx(ctx, pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
        batch := &pgx.Batch{}

        // Queue the order insert
        batch.Queue(`
            INSERT INTO orders (customer_id, status, total_cents, version, created_at, updated_at)
            VALUES ($1, 'pending', $2, 1, NOW(), NOW())
            RETURNING id
        `, order.CustomerID, order.TotalCents)

        // Queue each item insert — we'll set the order_id after the first query
        for _, item := range items {
            batch.Queue(`
                INSERT INTO order_items (order_id, product_id, quantity, price_cents)
                VALUES (currval('orders_id_seq'), $1, $2, $3)
            `, item.ProductID, item.Quantity, item.PriceCents)
        }

        // Send all queries in one network round-trip
        results := tx.SendBatch(ctx, batch)
        defer results.Close()

        // Process order ID result
        var orderID int64
        if err := results.QueryRow().Scan(&orderID); err != nil {
            return fmt.Errorf("inserting order: %w", err)
        }
        order.ID = orderID

        // Process item insert results
        for i := range items {
            if _, err := results.Exec(); err != nil {
                return fmt.Errorf("inserting item %d: %w", i, err)
            }
        }

        return nil
    })
}
```

### pgx COPY Protocol for Bulk Inserts in Transactions

```go
// BulkInsertOrderItems uses PostgreSQL COPY protocol for high-throughput bulk inserts.
func (s *OrderStore) BulkInsertOrderItems(
    ctx context.Context,
    pool *pgxpool.Pool,
    orderID int64,
    items []OrderItem,
) error {
    return WithPgxTx(ctx, pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
        // pgx COPY is the fastest way to insert large amounts of data
        copyCount, err := tx.CopyFrom(
            ctx,
            pgx.Identifier{"order_items"},
            []string{"order_id", "product_id", "quantity", "price_cents"},
            pgx.CopyFromSlice(len(items), func(i int) ([]interface{}, error) {
                return []interface{}{
                    orderID,
                    items[i].ProductID,
                    items[i].Quantity,
                    items[i].PriceCents,
                }, nil
            }),
        )
        if err != nil {
            return fmt.Errorf("COPY insert: %w", err)
        }

        if int(copyCount) != len(items) {
            return fmt.Errorf("expected to insert %d items, got %d",
                len(items), copyCount)
        }

        return nil
    })
}
```

## Section 7: Production Patterns and Anti-Patterns

### Connection Pool Sizing for Transaction-Heavy Workloads

```go
// ConfigurePool configures the pgx connection pool for transaction-heavy workloads.
func ConfigurePool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
    config, err := pgxpool.ParseConfig(databaseURL)
    if err != nil {
        return nil, fmt.Errorf("parsing database URL: %w", err)
    }

    // Pool size: too small causes connection starvation under load
    // too large overwhelms PostgreSQL max_connections
    config.MaxConns = 25  // Adjust based on PostgreSQL max_connections
    config.MinConns = 5   // Keep warm connections

    // Transaction timeout — prevents long-running transactions from
    // holding locks indefinitely
    config.MaxConnLifetime = 30 * time.Minute
    config.MaxConnIdleTime = 10 * time.Minute

    // Health check on acquire
    config.HealthCheckPeriod = 30 * time.Second

    // Statement cache size — for prepared statement benefits
    config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe

    pool, err := pgxpool.NewWithConfig(ctx, config)
    if err != nil {
        return nil, fmt.Errorf("creating pool: %w", err)
    }

    return pool, nil
}
```

### Transaction Timeout via Context

Always set a deadline on transactions to prevent runaway transactions from holding locks:

```go
func (s *OrderStore) ProcessOrderWithTimeout(ctx context.Context, orderID int64) error {
    // Set a 10-second timeout for the entire transaction
    txCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    return withTx(txCtx, s.db, func(tx *sql.Tx) error {
        // ... operations ...
        // If any operation takes longer than the remaining timeout,
        // it will be cancelled with context.DeadlineExceeded
        return nil
    })
}
```

### Common Anti-Patterns to Avoid

```go
// ANTI-PATTERN 1: Holding a transaction open while making external API calls
func badExample(ctx context.Context, db *sql.DB) error {
    return withTx(ctx, db, func(tx *sql.Tx) error {
        order := fetchOrderFromDB(tx, ctx)

        // BAD: This HTTP call may take seconds or minutes.
        // The transaction holds locks on the order row during this entire call.
        result, err := http.Post("https://payment-gateway.example.com/charge", ...)

        // While waiting, other transactions cannot update this order.
        return updateOrderWithResult(tx, ctx, order, result)
    })
}

// BETTER: Load data, make external calls, then update in a short transaction
func goodExample(ctx context.Context, db *sql.DB) error {
    // Short transaction to read
    order, err := getOrder(ctx, db, orderID)
    if err != nil {
        return err
    }

    // External call outside any transaction
    result, err := http.Post("https://payment-gateway.example.com/charge", ...)
    if err != nil {
        return err
    }

    // Short transaction to update
    return withTx(ctx, db, func(tx *sql.Tx) error {
        return updateOrderWithResult(tx, ctx, order, result)
    })
}

// ANTI-PATTERN 2: Ignoring tx.Rollback() errors (usually fine, but log them)
defer tx.Rollback() // Swallows rollback errors silently

// BETTER: Handle rollback errors appropriately
defer func() {
    if err := tx.Rollback(); err != nil && err != sql.ErrTxDone {
        logger.Warn("rollback failed", zap.Error(err))
    }
}()
```

Proper transaction management — using the right isolation level for each operation, employing savepoints for partial rollback patterns, choosing optimistic locking for high-throughput updates with rare conflicts, and pessimistic locking for critical sections where contention is expected — is what separates production-grade database code from code that works in testing but fails silently under load.
