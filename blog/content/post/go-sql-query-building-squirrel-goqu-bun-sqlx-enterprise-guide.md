---
title: "Go SQL Query Building: Squirrel, goqu, Bun ORM, sqlx, and Production Query Patterns"
date: 2032-01-25T00:00:00-05:00
draft: false
tags: ["Go", "SQL", "Database", "ORM", "sqlx", "Bun", "squirrel", "goqu", "PostgreSQL"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go SQL query building using squirrel, goqu, and Bun ORM alongside raw SQL with sqlx and named parameters. Covers query logging, connection pooling, transaction management, and production patterns for enterprise database access layers."
more_link: "yes"
url: "/go-sql-query-building-squirrel-goqu-bun-sqlx-enterprise-guide/"
---

Go's `database/sql` package provides a thin, portable interface to SQL databases, but building complex queries programmatically requires either raw string manipulation or a query builder. This guide walks through the production trade-offs between raw SQL with `sqlx`, the query builder approach with `squirrel` and `goqu`, and the full ORM path with `Bun`. It covers named parameters, query logging, connection pool tuning, and patterns for large-scale services.

<!--more-->

# Go SQL Query Building: From sqlx to Bun ORM

## Choosing the Right Abstraction Level

Before writing code, understand the trade-offs:

| Approach | Abstraction | SQL Control | Type Safety | Boilerplate |
|---|---|---|---|---|
| `database/sql` raw | None | Full | Manual scan | High |
| `sqlx` | Thin | Full | Struct scan | Medium |
| `squirrel` | Query builder | High | None | Low-Medium |
| `goqu` | Query builder | High | Dataset API | Low |
| `Bun` | ORM + builder | Medium | Full | Low |
| `gorm` | ORM | Low | Full | Lowest |

For microservices with complex reporting queries, `sqlx` or `squirrel` are often preferable to ORMs. For CRUD-heavy services, Bun reduces boilerplate without hiding SQL.

## sqlx: Struct Scanning and Named Parameters

`sqlx` wraps `database/sql` with struct scanning and named query support.

### Connection Setup with Pool Tuning

```go
package db

import (
    "context"
    "fmt"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/jackc/pgx/v5/stdlib"
)

type Config struct {
    Host            string
    Port            int
    Database        string
    User            string
    Password        string
    SSLMode         string
    MaxOpenConns    int
    MaxIdleConns    int
    ConnMaxLifetime time.Duration
    ConnMaxIdleTime time.Duration
}

func NewDB(cfg Config) (*sqlx.DB, error) {
    dsn := fmt.Sprintf(
        "host=%s port=%d dbname=%s user=%s password=%s sslmode=%s "+
            "pool_max_conns=%d pool_min_conns=%d "+
            "pool_max_conn_lifetime=%s pool_max_conn_idle_time=%s",
        cfg.Host, cfg.Port, cfg.Database, cfg.User, cfg.Password,
        cfg.SSLMode,
        cfg.MaxOpenConns, cfg.MaxIdleConns,
        cfg.ConnMaxLifetime, cfg.ConnMaxIdleTime,
    )

    db, err := sqlx.Open("pgx", dsn)
    if err != nil {
        return nil, fmt.Errorf("open db: %w", err)
    }

    // Pool configuration (separate from pgx DSN for stdlib driver)
    db.SetMaxOpenConns(cfg.MaxOpenConns)
    db.SetMaxIdleConns(cfg.MaxIdleConns)
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime)
    db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := db.PingContext(ctx); err != nil {
        return nil, fmt.Errorf("ping db: %w", err)
    }

    return db, nil
}

// Recommended pool settings for a service with 50 concurrent requests
// targeting PostgreSQL:
//   MaxOpenConns: 25     (2x expected concurrent queries)
//   MaxIdleConns: 10     (40% of MaxOpenConns)
//   ConnMaxLifetime: 30m (recycle before PgBouncer timeout)
//   ConnMaxIdleTime: 5m  (close idle connections quickly)
```

### Struct Scanning with sqlx

```go
package repository

import (
    "context"
    "database/sql"
    "errors"
    "time"

    "github.com/jmoiron/sqlx"
)

type Order struct {
    ID          int64          `db:"id"`
    CustomerID  int64          `db:"customer_id"`
    Status      string         `db:"status"`
    TotalAmount float64        `db:"total_amount"`
    CreatedAt   time.Time      `db:"created_at"`
    UpdatedAt   time.Time      `db:"updated_at"`
    DeletedAt   sql.NullTime   `db:"deleted_at"`
    Notes       sql.NullString `db:"notes"`
}

type OrderFilter struct {
    CustomerID *int64
    Status     *string
    FromDate   *time.Time
    ToDate     *time.Time
    Limit      int
    Offset     int
}

type OrderRepository struct {
    db *sqlx.DB
}

func NewOrderRepository(db *sqlx.DB) *OrderRepository {
    return &OrderRepository{db: db}
}

// GetByID demonstrates simple struct scanning
func (r *OrderRepository) GetByID(ctx context.Context, id int64) (*Order, error) {
    const q = `
        SELECT id, customer_id, status, total_amount,
               created_at, updated_at, deleted_at, notes
        FROM orders
        WHERE id = $1 AND deleted_at IS NULL
    `
    var o Order
    if err := r.db.GetContext(ctx, &o, q, id); err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, ErrNotFound
        }
        return nil, fmt.Errorf("get order %d: %w", id, err)
    }
    return &o, nil
}

// ListByCustomer demonstrates slice scanning
func (r *OrderRepository) ListByCustomer(
    ctx context.Context, customerID int64, limit, offset int,
) ([]Order, error) {
    const q = `
        SELECT id, customer_id, status, total_amount,
               created_at, updated_at, deleted_at, notes
        FROM orders
        WHERE customer_id = $1
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `
    var orders []Order
    if err := r.db.SelectContext(ctx, &orders, q, customerID, limit, offset); err != nil {
        return nil, fmt.Errorf("list orders for customer %d: %w", customerID, err)
    }
    return orders, nil
}
```

### Named Parameters with sqlx

Named parameters improve readability for queries with many arguments:

```go
type CreateOrderParams struct {
    CustomerID  int64          `db:"customer_id"`
    Status      string         `db:"status"`
    TotalAmount float64        `db:"total_amount"`
    Notes       sql.NullString `db:"notes"`
}

func (r *OrderRepository) Create(
    ctx context.Context, p CreateOrderParams,
) (*Order, error) {
    const q = `
        INSERT INTO orders (customer_id, status, total_amount, notes, created_at, updated_at)
        VALUES (:customer_id, :status, :total_amount, :notes, now(), now())
        RETURNING id, customer_id, status, total_amount, created_at, updated_at, deleted_at, notes
    `
    // NamedQueryContext expands :name placeholders
    rows, err := r.db.NamedQueryContext(ctx, q, p)
    if err != nil {
        return nil, fmt.Errorf("create order: %w", err)
    }
    defer rows.Close()

    if !rows.Next() {
        return nil, fmt.Errorf("create order: no row returned")
    }
    var o Order
    if err := rows.StructScan(&o); err != nil {
        return nil, fmt.Errorf("scan created order: %w", err)
    }
    return &o, nil
}

type UpdateOrderParams struct {
    ID     int64   `db:"id"`
    Status string  `db:"status"`
    Notes  *string `db:"notes"`
}

func (r *OrderRepository) UpdateStatus(
    ctx context.Context, p UpdateOrderParams,
) error {
    const q = `
        UPDATE orders
        SET status = :status,
            notes = COALESCE(:notes, notes),
            updated_at = now()
        WHERE id = :id AND deleted_at IS NULL
    `
    result, err := r.db.NamedExecContext(ctx, q, p)
    if err != nil {
        return fmt.Errorf("update order status: %w", err)
    }
    affected, _ := result.RowsAffected()
    if affected == 0 {
        return ErrNotFound
    }
    return nil
}
```

### Bulk Operations with sqlx

```go
// BulkCreate uses the unnest trick for PostgreSQL bulk inserts
func (r *OrderRepository) BulkCreate(
    ctx context.Context, orders []CreateOrderParams,
) ([]int64, error) {
    if len(orders) == 0 {
        return nil, nil
    }

    customerIDs := make([]int64, len(orders))
    statuses := make([]string, len(orders))
    amounts := make([]float64, len(orders))

    for i, o := range orders {
        customerIDs[i] = o.CustomerID
        statuses[i] = o.Status
        amounts[i] = o.TotalAmount
    }

    const q = `
        INSERT INTO orders (customer_id, status, total_amount, created_at, updated_at)
        SELECT
            unnest($1::bigint[]),
            unnest($2::text[]),
            unnest($3::numeric[]),
            now(),
            now()
        RETURNING id
    `
    var ids []int64
    if err := r.db.SelectContext(ctx, &ids, q,
        customerIDs, statuses, amounts,
    ); err != nil {
        return nil, fmt.Errorf("bulk create orders: %w", err)
    }
    return ids, nil
}
```

## squirrel: SQL Query Builder

`squirrel` provides a fluent interface for building SQL dynamically without string concatenation.

```go
package query

import (
    "context"

    sq "github.com/Masterminds/squirrel"
    "github.com/jmoiron/sqlx"
)

// squirrel uses positional placeholders by default ($1 for PostgreSQL)
var psql = sq.StatementBuilder.PlaceholderFormat(sq.Dollar)

type OrderQueryBuilder struct {
    db *sqlx.DB
}

func (b *OrderQueryBuilder) BuildListQuery(f OrderFilter) (string, []interface{}, error) {
    q := psql.Select(
        "o.id",
        "o.customer_id",
        "o.status",
        "o.total_amount",
        "o.created_at",
        "c.email AS customer_email",
        "c.name AS customer_name",
    ).
        From("orders o").
        Join("customers c ON c.id = o.customer_id").
        Where(sq.Eq{"o.deleted_at": nil})

    if f.CustomerID != nil {
        q = q.Where(sq.Eq{"o.customer_id": *f.CustomerID})
    }
    if f.Status != nil {
        q = q.Where(sq.Eq{"o.status": *f.Status})
    }
    if f.FromDate != nil {
        q = q.Where(sq.GtOrEq{"o.created_at": *f.FromDate})
    }
    if f.ToDate != nil {
        q = q.Where(sq.Lt{"o.created_at": *f.ToDate})
    }

    limit := f.Limit
    if limit == 0 || limit > 1000 {
        limit = 100
    }
    q = q.OrderBy("o.created_at DESC").
        Limit(uint64(limit)).
        Offset(uint64(f.Offset))

    return q.ToSql()
}

// Complex aggregation query
func (b *OrderQueryBuilder) BuildRevenueReport(
    fromDate, toDate time.Time, groupBy string,
) (string, []interface{}, error) {
    groupExpr := map[string]string{
        "day":    "date_trunc('day', o.created_at)",
        "week":   "date_trunc('week', o.created_at)",
        "month":  "date_trunc('month', o.created_at)",
    }
    truncExpr, ok := groupExpr[groupBy]
    if !ok {
        return "", nil, fmt.Errorf("invalid groupBy: %s", groupBy)
    }

    q := psql.Select(
        truncExpr+" AS period",
        "COUNT(*) AS order_count",
        "SUM(o.total_amount) AS total_revenue",
        "AVG(o.total_amount) AS avg_order_value",
        "COUNT(DISTINCT o.customer_id) AS unique_customers",
    ).
        From("orders o").
        Where(sq.And{
            sq.Eq{"o.status": "completed"},
            sq.IsNull{"o.deleted_at"},
            sq.GtOrEq{"o.created_at": fromDate},
            sq.Lt{"o.created_at": toDate},
        }).
        GroupBy("period").
        OrderBy("period ASC")

    return q.ToSql()
}

// Upsert pattern
func (b *OrderQueryBuilder) BuildUpsert(
    orders []CreateOrderParams,
) (string, []interface{}, error) {
    q := psql.Insert("orders").
        Columns("customer_id", "external_ref", "status", "total_amount", "created_at", "updated_at")

    for _, o := range orders {
        q = q.Values(o.CustomerID, o.ExternalRef, o.Status, o.TotalAmount, sq.Expr("now()"), sq.Expr("now()"))
    }

    // PostgreSQL ON CONFLICT ... DO UPDATE
    q = q.Suffix(`
        ON CONFLICT (external_ref) DO UPDATE SET
            status = EXCLUDED.status,
            total_amount = EXCLUDED.total_amount,
            updated_at = now()
        WHERE orders.status != 'completed'
        RETURNING id, external_ref, status
    `)

    return q.ToSql()
}

func (b *OrderQueryBuilder) List(
    ctx context.Context, f OrderFilter,
) ([]OrderWithCustomer, error) {
    sql, args, err := b.BuildListQuery(f)
    if err != nil {
        return nil, err
    }

    var results []OrderWithCustomer
    if err := b.db.SelectContext(ctx, &results, sql, args...); err != nil {
        return nil, fmt.Errorf("list orders: %w", err)
    }
    return results, nil
}
```

## goqu: Dataset-Based Query Building

`goqu` provides a more structured approach with explicit dialect support and expression trees:

```go
package query

import (
    "github.com/doug-martin/goqu/v9"
    _ "github.com/doug-martin/goqu/v9/dialect/postgres"
)

var dialect = goqu.Dialect("postgres")

type OrderDataset struct {
    db *sqlx.DB
}

// goqu uses a Dataset abstraction that tracks the full query state
func (d *OrderDataset) BuildComplexReport(opts ReportOptions) (string, []interface{}, error) {
    orderTable := goqu.T("orders").As("o")
    customerTable := goqu.T("customers").As("c")
    itemTable := goqu.T("order_items").As("oi")

    ds := dialect.From(orderTable).
        Select(
            goqu.I("o.id"),
            goqu.I("o.customer_id"),
            goqu.I("c.email"),
            goqu.I("c.tier"),
            goqu.SUM(goqu.I("oi.quantity")).As("total_items"),
            goqu.SUM(goqu.I("oi.unit_price").Mul(goqu.I("oi.quantity"))).As("line_total"),
            goqu.I("o.total_amount"),
            goqu.L("o.total_amount - SUM(oi.unit_price * oi.quantity)").As("discount_amount"),
        ).
        Join(
            customerTable,
            goqu.On(goqu.I("c.id").Eq(goqu.I("o.customer_id"))),
        ).
        Join(
            itemTable,
            goqu.On(goqu.I("oi.order_id").Eq(goqu.I("o.id"))),
        ).
        Where(
            goqu.I("o.deleted_at").IsNull(),
            goqu.I("o.status").Eq("completed"),
            goqu.I("o.created_at").Between(goqu.Range(opts.FromDate, opts.ToDate)),
        ).
        GroupBy(
            goqu.I("o.id"),
            goqu.I("o.customer_id"),
            goqu.I("c.email"),
            goqu.I("c.tier"),
            goqu.I("o.total_amount"),
        ).
        Having(
            goqu.SUM(goqu.I("oi.quantity")).Gt(opts.MinItems),
        ).
        Order(goqu.I("o.total_amount").Desc())

    if opts.CustomerTier != "" {
        ds = ds.Where(goqu.I("c.tier").Eq(opts.CustomerTier))
    }

    if opts.Limit > 0 {
        ds = ds.Limit(uint(opts.Limit)).Offset(uint(opts.Offset))
    }

    return ds.Prepared(true).ToSQL()
}

// CTE example with goqu
func (d *OrderDataset) BuildChurnAnalysis(lookbackDays int) (string, []interface{}, error) {
    // WITH active_customers AS (...)
    activeCTE := dialect.From("orders").
        Select(
            goqu.I("customer_id"),
            goqu.MAX(goqu.I("created_at")).As("last_order_date"),
        ).
        Where(goqu.I("deleted_at").IsNull()).
        GroupBy("customer_id")

    // WITH churned AS (SELECT ... FROM active_customers WHERE ...)
    churnedCTE := dialect.From("active_customers").
        Select(
            goqu.I("customer_id"),
            goqu.I("last_order_date"),
            goqu.L(
                "CURRENT_DATE - last_order_date::date",
            ).As("days_since_order"),
        ).
        Where(
            goqu.L("last_order_date < CURRENT_DATE - INTERVAL '? days'",
                lookbackDays),
        )

    ds := dialect.
        With("active_customers", activeCTE).
        With("churned", churnedCTE).
        From("churned").
        Select(
            goqu.COUNT("*").As("churned_count"),
            goqu.AVG(goqu.I("days_since_order")).As("avg_days_churned"),
        )

    return ds.Prepared(true).ToSQL()
}
```

## Bun ORM: Full-Featured with SQL Visibility

Bun combines ORM features with first-class raw SQL support and excellent query logging:

```go
package orm

import (
    "context"
    "database/sql"

    "github.com/uptrace/bun"
    "github.com/uptrace/bun/dialect/pgdialect"
    "github.com/uptrace/bun/driver/pgdriver"
    "github.com/uptrace/bun/extra/bundebug"
)

type Order struct {
    bun.BaseModel `bun:"table:orders,alias:o"`

    ID          int64          `bun:"id,pk,autoincrement"`
    CustomerID  int64          `bun:"customer_id,notnull"`
    Status      string         `bun:"status,notnull"`
    TotalAmount float64        `bun:"total_amount,notnull"`
    CreatedAt   time.Time      `bun:"created_at,nullzero,notnull,default:current_timestamp"`
    UpdatedAt   time.Time      `bun:"updated_at,nullzero,notnull,default:current_timestamp"`
    DeletedAt   *time.Time     `bun:"deleted_at,soft_delete,nullzero"`
    Notes       string         `bun:"notes"`

    // Associations
    Customer    *Customer      `bun:"rel:belongs-to,join:customer_id=id"`
    Items       []*OrderItem   `bun:"rel:has-many,join:id=order_id"`
}

type Customer struct {
    bun.BaseModel `bun:"table:customers,alias:c"`

    ID    int64  `bun:"id,pk,autoincrement"`
    Email string `bun:"email,notnull,unique"`
    Name  string `bun:"name,notnull"`
    Tier  string `bun:"tier,notnull,default:'standard'"`
}

func NewBunDB(dsn string, debug bool) *bun.DB {
    sqldb := sql.OpenDB(pgdriver.NewConnector(pgdriver.WithDSN(dsn)))

    db := bun.NewDB(sqldb, pgdialect.New())

    if debug {
        db.AddQueryHook(bundebug.NewQueryHook(
            bundebug.WithVerbose(true),
            bundebug.WithEnabled(true),
        ))
    }
    return db
}

type OrderService struct {
    db *bun.DB
}

// Select with relation loading
func (s *OrderService) GetWithItems(ctx context.Context, id int64) (*Order, error) {
    order := new(Order)
    err := s.db.NewSelect().
        Model(order).
        Relation("Customer").
        Relation("Items").
        Where("o.id = ?", id).
        WhereAllWithDeleted().
        Scan(ctx)
    if err != nil {
        return nil, err
    }
    return order, nil
}

// Complex filter with Bun
func (s *OrderService) List(ctx context.Context, f OrderFilter) ([]Order, int, error) {
    var orders []Order

    q := s.db.NewSelect().
        Model(&orders).
        Relation("Customer").
        Where("o.deleted_at IS NULL")

    if f.CustomerID != nil {
        q = q.Where("o.customer_id = ?", *f.CustomerID)
    }
    if f.Status != nil {
        q = q.Where("o.status = ?", *f.Status)
    }
    if f.FromDate != nil {
        q = q.Where("o.created_at >= ?", *f.FromDate)
    }
    if f.ToDate != nil {
        q = q.Where("o.created_at < ?", *f.ToDate)
    }

    count, err := q.
        OrderExpr("o.created_at DESC").
        Limit(f.Limit).
        Offset(f.Offset).
        ScanAndCount(ctx)
    if err != nil {
        return nil, 0, err
    }
    return orders, count, nil
}

// Upsert with Bun
func (s *OrderService) Upsert(ctx context.Context, orders []*Order) error {
    _, err := s.db.NewInsert().
        Model(&orders).
        On("CONFLICT (external_ref) DO UPDATE").
        Set("status = EXCLUDED.status").
        Set("total_amount = EXCLUDED.total_amount").
        Set("updated_at = now()").
        Where("o.status != 'completed'").
        Exec(ctx)
    return err
}

// Raw SQL with Bun scan
func (s *OrderService) RevenueByCustomerTier(
    ctx context.Context, from, to time.Time,
) ([]TierRevenue, error) {
    var results []TierRevenue
    err := s.db.NewRaw(`
        SELECT
            c.tier,
            COUNT(DISTINCT o.customer_id) AS customer_count,
            COUNT(o.id) AS order_count,
            SUM(o.total_amount) AS total_revenue,
            AVG(o.total_amount) AS avg_order_value,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.total_amount) AS median_order
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        WHERE o.deleted_at IS NULL
          AND o.status = 'completed'
          AND o.created_at BETWEEN ? AND ?
        GROUP BY c.tier
        ORDER BY total_revenue DESC
    `, from, to).Scan(ctx, &results)
    return results, err
}

// Schema migration with Bun
func (s *OrderService) CreateSchema(ctx context.Context) error {
    models := []interface{}{
        (*Customer)(nil),
        (*Order)(nil),
        (*OrderItem)(nil),
    }
    for _, model := range models {
        if _, err := s.db.NewCreateTable().
            Model(model).
            IfNotExists().
            WithForeignKeys().
            Exec(ctx); err != nil {
            return err
        }
    }
    return nil
}
```

## Query Logging and Observability

### Structured Query Logger

```go
package dblog

import (
    "context"
    "log/slog"
    "time"

    "github.com/uptrace/bun"
)

type SlogQueryHook struct {
    logger        *slog.Logger
    slowThreshold time.Duration
}

func NewSlogQueryHook(logger *slog.Logger, slowThreshold time.Duration) *SlogQueryHook {
    return &SlogQueryHook{
        logger:        logger,
        slowThreshold: slowThreshold,
    }
}

func (h *SlogQueryHook) BeforeQuery(
    ctx context.Context, event *bun.QueryEvent,
) context.Context {
    return ctx
}

func (h *SlogQueryHook) AfterQuery(
    ctx context.Context, event *bun.QueryEvent,
) {
    dur := time.Since(event.StartTime)
    level := slog.LevelDebug

    attrs := []slog.Attr{
        slog.Duration("duration", dur),
        slog.String("query", event.Query),
        slog.Int64("rows_affected", event.Result.RowsAffected()),
    }

    if event.Err != nil {
        attrs = append(attrs, slog.String("error", event.Err.Error()))
        level = slog.LevelError
    } else if dur > h.slowThreshold {
        level = slog.LevelWarn
        attrs = append(attrs, slog.Bool("slow_query", true))
    }

    // Extract trace ID from context if available
    if traceID, ok := ctx.Value(traceIDKey{}).(string); ok {
        attrs = append(attrs, slog.String("trace_id", traceID))
    }

    h.logger.LogAttrs(ctx, level, "sql query", attrs...)
}
```

### Prometheus Metrics Hook

```go
package dbmetrics

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/uptrace/bun"
)

type MetricsHook struct {
    queryDuration *prometheus.HistogramVec
    queryErrors   *prometheus.CounterVec
    queryTotal    *prometheus.CounterVec
}

func NewMetricsHook(reg prometheus.Registerer) *MetricsHook {
    factory := promauto.With(reg)
    return &MetricsHook{
        queryDuration: factory.NewHistogramVec(prometheus.HistogramOpts{
            Name:    "db_query_duration_seconds",
            Help:    "Database query duration in seconds",
            Buckets: []float64{.001, .005, .01, .05, .1, .25, .5, 1, 2.5, 5},
        }, []string{"operation", "table"}),
        queryErrors: factory.NewCounterVec(prometheus.CounterOpts{
            Name: "db_query_errors_total",
            Help: "Total database query errors",
        }, []string{"operation", "table"}),
        queryTotal: factory.NewCounterVec(prometheus.CounterOpts{
            Name: "db_queries_total",
            Help: "Total database queries",
        }, []string{"operation", "table"}),
    }
}

func (h *MetricsHook) BeforeQuery(
    ctx context.Context, event *bun.QueryEvent,
) context.Context {
    return ctx
}

func (h *MetricsHook) AfterQuery(
    ctx context.Context, event *bun.QueryEvent,
) {
    operation := event.QueryAppender.String()[:6] // SELECT, INSERT, UPDATE, DELETE
    table := extractTableName(event.Query)
    dur := time.Since(event.StartTime).Seconds()

    h.queryTotal.WithLabelValues(operation, table).Inc()
    h.queryDuration.WithLabelValues(operation, table).Observe(dur)

    if event.Err != nil {
        h.queryErrors.WithLabelValues(operation, table).Inc()
    }
}
```

## Transaction Management

### Transaction with Retry

```go
package tx

import (
    "context"
    "errors"
    "time"

    "github.com/jackc/pgx/v5/pgconn"
    "github.com/uptrace/bun"
)

// pgSerializationFailure is the PostgreSQL error code for serialization failures
const pgSerializationFailure = "40001"
const pgDeadlockDetected = "40P01"

func isRetryableError(err error) bool {
    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        return pgErr.Code == pgSerializationFailure ||
            pgErr.Code == pgDeadlockDetected
    }
    return false
}

type TxFunc func(ctx context.Context, tx bun.Tx) error

func RunInTx(
    ctx context.Context,
    db *bun.DB,
    opts *sql.TxOptions,
    fn TxFunc,
) error {
    return runWithRetry(ctx, 3, func() error {
        return db.RunInTx(ctx, opts, func(ctx context.Context, tx bun.Tx) error {
            return fn(ctx, tx)
        })
    })
}

func runWithRetry(ctx context.Context, maxAttempts int, fn func() error) error {
    var lastErr error
    for attempt := 1; attempt <= maxAttempts; attempt++ {
        lastErr = fn()
        if lastErr == nil {
            return nil
        }
        if !isRetryableError(lastErr) {
            return lastErr
        }
        if attempt < maxAttempts {
            // Exponential backoff: 10ms, 20ms, 40ms
            sleep := time.Duration(attempt*10) * time.Millisecond
            select {
            case <-time.After(sleep):
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    }
    return fmt.Errorf("transaction failed after %d attempts: %w", maxAttempts, lastErr)
}

// Example: transfer funds between accounts
func (s *AccountService) Transfer(
    ctx context.Context, fromID, toID int64, amount float64,
) error {
    return RunInTx(ctx, s.db,
        &sql.TxOptions{Isolation: sql.LevelSerializable},
        func(ctx context.Context, tx bun.Tx) error {
            // Lock rows in consistent order to prevent deadlock
            if fromID > toID {
                fromID, toID = toID, fromID
                amount = -amount
            }

            var from, to Account
            err := tx.NewSelect().Model(&from).
                Where("id = ?", fromID).
                For("UPDATE").
                Scan(ctx)
            if err != nil {
                return err
            }
            err = tx.NewSelect().Model(&to).
                Where("id = ?", toID).
                For("UPDATE").
                Scan(ctx)
            if err != nil {
                return err
            }

            if from.Balance < amount {
                return ErrInsufficientFunds
            }

            _, err = tx.NewUpdate().Model(&from).
                Set("balance = balance - ?", amount).
                Set("updated_at = now()").
                Where("id = ?", fromID).
                Exec(ctx)
            if err != nil {
                return err
            }
            _, err = tx.NewUpdate().Model(&to).
                Set("balance = balance + ?", amount).
                Set("updated_at = now()").
                Where("id = ?", toID).
                Exec(ctx)
            return err
        },
    )
}
```

## Prepared Statements and Statement Caching

```go
package prepared

import (
    "context"
    "sync"

    "github.com/jmoiron/sqlx"
)

// StmtCache caches prepared statements per connection (safe for use across goroutines)
type StmtCache struct {
    mu    sync.RWMutex
    stmts map[string]*sqlx.Stmt
    db    *sqlx.DB
}

func NewStmtCache(db *sqlx.DB) *StmtCache {
    return &StmtCache{
        stmts: make(map[string]*sqlx.Stmt),
        db:    db,
    }
}

func (c *StmtCache) Get(ctx context.Context, query string) (*sqlx.Stmt, error) {
    c.mu.RLock()
    stmt, ok := c.stmts[query]
    c.mu.RUnlock()
    if ok {
        return stmt, nil
    }

    c.mu.Lock()
    defer c.mu.Unlock()

    // Double-check after acquiring write lock
    if stmt, ok = c.stmts[query]; ok {
        return stmt, nil
    }

    stmt, err := c.db.PreparexContext(ctx, query)
    if err != nil {
        return nil, err
    }
    c.stmts[query] = stmt
    return stmt, nil
}

// Usage pattern for high-throughput query paths
type HighThroughputRepo struct {
    cache *StmtCache
}

func (r *HighThroughputRepo) GetOrder(ctx context.Context, id int64) (*Order, error) {
    const q = `SELECT id, customer_id, status, total_amount FROM orders WHERE id = $1`
    stmt, err := r.cache.Get(ctx, q)
    if err != nil {
        return nil, err
    }
    var o Order
    return &o, stmt.GetContext(ctx, &o, id)
}
```

## Production Patterns

### Read Replica Routing

```go
package router

import (
    "context"
    "math/rand"

    "github.com/jmoiron/sqlx"
)

type DBRouter struct {
    primary  *sqlx.DB
    replicas []*sqlx.DB
}

type queryTypeKey struct{}

type QueryType int

const (
    QueryTypeWrite QueryType = iota
    QueryTypeRead
    QueryTypeReadConsistent // forces primary
)

func WithQueryType(ctx context.Context, qt QueryType) context.Context {
    return context.WithValue(ctx, queryTypeKey{}, qt)
}

func (r *DBRouter) DB(ctx context.Context) *sqlx.DB {
    qt, ok := ctx.Value(queryTypeKey{}).(QueryType)
    if !ok || qt == QueryTypeWrite || qt == QueryTypeReadConsistent {
        return r.primary
    }
    if len(r.replicas) == 0 {
        return r.primary
    }
    // Random replica selection; use weighted selection for different replica sizes
    return r.replicas[rand.Intn(len(r.replicas))]
}
```

### Connection Health Check

```go
func MonitorDBHealth(ctx context.Context, db *sqlx.DB, metrics *DBMetrics) {
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            stats := db.Stats()
            metrics.openConnections.Set(float64(stats.OpenConnections))
            metrics.inUseConnections.Set(float64(stats.InUse))
            metrics.idleConnections.Set(float64(stats.Idle))
            metrics.waitCount.Add(float64(stats.WaitCount))
            metrics.waitDuration.Add(float64(stats.WaitDuration.Milliseconds()))
            metrics.maxIdleClosed.Add(float64(stats.MaxIdleClosed))
            metrics.maxLifetimeClosed.Add(float64(stats.MaxLifetimeClosed))

            // Ping to detect broken connections
            pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
            if err := db.PingContext(pingCtx); err != nil {
                metrics.pingErrors.Inc()
                slog.Error("database ping failed", "error", err)
            }
            cancel()
        case <-ctx.Done():
            return
        }
    }
}
```

## Choosing the Right Tool

**Use raw SQL + sqlx when:**
- You need full SQL control for complex analytics queries
- The team is SQL-proficient and prefers explicit queries
- Performance is critical and you cannot tolerate ORM overhead
- Queries differ significantly across endpoints

**Use squirrel/goqu when:**
- You build queries dynamically from user-supplied filters
- You want to avoid string concatenation and injection risk
- You need to support multiple database dialects

**Use Bun when:**
- You have standard CRUD with occasional complex queries
- You want schema migration, soft deletes, and relations without full ORM magic
- You need both raw SQL and query builder in the same codebase

The `sqlx` + `squirrel` combination covers most production requirements without introducing ORM complexity, while Bun's explicit query hooks make it an excellent choice when observability of generated SQL is required.
