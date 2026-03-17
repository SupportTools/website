---
title: "Go SQL Query Builder Patterns: squirrel, sq, and Raw Query Safety"
date: 2029-01-23T00:00:00-05:00
draft: false
tags: ["Go", "SQL", "Database", "Security", "squirrel", "PostgreSQL", "Query Builder"]
categories:
- Go
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to building safe, composable SQL queries in Go using squirrel and sq, covering injection prevention, dynamic query composition, pagination, and transaction management patterns."
more_link: "yes"
url: "/go-sql-query-builder-patterns-squirrel-sq/"
---

Raw string concatenation for SQL queries is a well-understood anti-pattern that leads to injection vulnerabilities and unmaintainable code. Query builders sit between raw SQL strings and full ORMs, providing composable, type-safe query construction while preserving access to the full expressiveness of SQL. In Go, `squirrel` and `sq` are the two most widely used query builders, each with distinct design philosophies.

This post covers query builder fundamentals, injection prevention mechanics, dynamic query composition patterns, pagination, joins, subqueries, transaction management, and testing strategies—grounded in production PostgreSQL and MySQL workloads.

<!--more-->

## Why Query Builders Over Raw SQL

Consider a search endpoint that accepts multiple optional filters:

```go
// DANGEROUS: raw string concatenation — SQL injection risk
func buildSearchQuery(name, status string, minAge int) string {
    q := "SELECT id, name, email FROM users WHERE 1=1"
    if name != "" {
        q += " AND name LIKE '%" + name + "%'"  // Injection point
    }
    if status != "" {
        q += " AND status = '" + status + "'"   // Injection point
    }
    if minAge > 0 {
        q += fmt.Sprintf(" AND age >= %d", minAge)  // Integer, but bad practice
    }
    return q
}
```

A user can pass `name = "'; DROP TABLE users; --"` to destroy the database. Even with integer parameters, the pattern makes it trivially easy to accidentally introduce injection by adding a future string parameter.

Query builders force parameterization:

```go
// SAFE: squirrel query builder — all values are parameterized
import sq "github.com/Masterminds/squirrel"

func buildSearchQuery(name, status string, minAge int) sq.SelectBuilder {
    q := sq.Select("id", "name", "email").From("users")
    if name != "" {
        q = q.Where(sq.Like{"name": "%" + name + "%"})
    }
    if status != "" {
        q = q.Where(sq.Eq{"status": status})
    }
    if minAge > 0 {
        q = q.Where(sq.GtOrEq{"age": minAge})
    }
    return q
}
```

All values pass through the `?` (MySQL) or `$1` (PostgreSQL) placeholder mechanism, making injection structurally impossible for values managed by the builder.

## squirrel: Production Setup

### Installation and Database Configuration

```go
// db/conn.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	sq "github.com/Masterminds/squirrel"
	_ "github.com/lib/pq"
)

// Config holds database connection configuration.
type Config struct {
	Host            string
	Port            int
	User            string
	Password        string
	DBName          string
	SSLMode         string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
}

// DB wraps sql.DB with a configured squirrel StatementBuilder.
type DB struct {
	*sql.DB
	// Builder is pre-configured for the correct placeholder format.
	// Use Builder for all query construction to avoid placeholder mismatch.
	Builder sq.StatementBuilderType
}

// New opens a PostgreSQL connection and configures the query builder.
func New(cfg Config) (*DB, error) {
	dsn := fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.DBName, cfg.SSLMode,
	)

	sqlDB, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("sql.Open: %w", err)
	}

	sqlDB.SetMaxOpenConns(cfg.MaxOpenConns)
	sqlDB.SetMaxIdleConns(cfg.MaxIdleConns)
	sqlDB.SetConnMaxLifetime(cfg.ConnMaxLifetime)
	sqlDB.SetConnMaxIdleTime(cfg.ConnMaxIdleTime)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := sqlDB.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}

	return &DB{
		DB: sqlDB,
		// Dollar placeholder for PostgreSQL ($1, $2, ...)
		// Use sq.Question for MySQL (?, ?, ...)
		Builder: sq.StatementBuilder.PlaceholderFormat(sq.Dollar),
	}, nil
}
```

### Basic CRUD Operations

```go
// repository/user_repository.go
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	sq "github.com/Masterminds/squirrel"
	"github.com/example/myservice/db"
)

// User represents a row from the users table.
type User struct {
	ID        int64
	Name      string
	Email     string
	Status    string
	Age       int
	CreatedAt time.Time
	UpdatedAt time.Time
}

// UserRepository handles database operations for the users table.
type UserRepository struct {
	db *db.DB
}

func NewUserRepository(database *db.DB) *UserRepository {
	return &UserRepository{db: database}
}

// Create inserts a new user and returns the assigned ID.
func (r *UserRepository) Create(ctx context.Context, u *User) (int64, error) {
	var id int64
	err := r.db.Builder.
		Insert("users").
		Columns("name", "email", "status", "age", "created_at", "updated_at").
		Values(u.Name, u.Email, u.Status, u.Age, time.Now(), time.Now()).
		Suffix("RETURNING id").
		RunWith(r.db).
		QueryRowContext(ctx).
		Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("UserRepository.Create: %w", err)
	}
	return id, nil
}

// GetByID retrieves a user by primary key.
func (r *UserRepository) GetByID(ctx context.Context, id int64) (*User, error) {
	u := &User{}
	err := r.db.Builder.
		Select("id", "name", "email", "status", "age", "created_at", "updated_at").
		From("users").
		Where(sq.Eq{"id": id, "deleted_at": nil}).
		RunWith(r.db).
		QueryRowContext(ctx).
		Scan(&u.ID, &u.Name, &u.Email, &u.Status, &u.Age, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("UserRepository.GetByID: %w", err)
	}
	return u, nil
}

// Update applies a partial update — only non-zero fields are updated.
func (r *UserRepository) Update(ctx context.Context, id int64, fields map[string]interface{}) error {
	if len(fields) == 0 {
		return nil
	}
	fields["updated_at"] = time.Now()

	result, err := r.db.Builder.
		Update("users").
		SetMap(fields).
		Where(sq.Eq{"id": id, "deleted_at": nil}).
		RunWith(r.db).
		ExecContext(ctx)
	if err != nil {
		return fmt.Errorf("UserRepository.Update: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

// SoftDelete marks a user as deleted without removing the row.
func (r *UserRepository) SoftDelete(ctx context.Context, id int64) error {
	result, err := r.db.Builder.
		Update("users").
		Set("deleted_at", time.Now()).
		Where(sq.Eq{"id": id, "deleted_at": nil}).
		RunWith(r.db).
		ExecContext(ctx)
	if err != nil {
		return fmt.Errorf("UserRepository.SoftDelete: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

var ErrNotFound = errors.New("record not found")
```

## Dynamic Query Composition

The most powerful feature of query builders is composable, conditional query construction:

```go
// repository/user_search.go
package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	sq "github.com/Masterminds/squirrel"
)

// SearchParams defines the parameters for a user search query.
type SearchParams struct {
	Name      string
	Email     string
	Statuses  []string
	MinAge    int
	MaxAge    int
	CreatedAfter  *time.Time
	CreatedBefore *time.Time
	OrderBy   string
	OrderDir  string // "ASC" or "DESC"
	Page      int
	PageSize  int
}

// SearchResult holds paginated search results.
type SearchResult struct {
	Users      []*User
	TotalCount int64
	Page       int
	PageSize   int
	TotalPages int
}

// Search executes a dynamic search query with pagination.
// Only non-zero filter fields are included in the WHERE clause.
func (r *UserRepository) Search(ctx context.Context, params SearchParams) (*SearchResult, error) {
	// Validate and sanitize sort parameters to prevent ORDER BY injection.
	// (squirrel does NOT parameterize ORDER BY clauses)
	orderBy := r.sanitizeOrderBy(params.OrderBy)
	orderDir := "ASC"
	if strings.ToUpper(params.OrderDir) == "DESC" {
		orderDir = "DESC"
	}

	page := params.Page
	if page < 1 {
		page = 1
	}
	pageSize := params.PageSize
	if pageSize < 1 || pageSize > 1000 {
		pageSize = 20
	}
	offset := uint64((page - 1) * pageSize)

	// Build the base WHERE conditions
	conds := sq.And{sq.Eq{"deleted_at": nil}}

	if params.Name != "" {
		conds = append(conds, sq.ILike{"name": "%" + params.Name + "%"})
	}
	if params.Email != "" {
		conds = append(conds, sq.ILike{"email": "%" + params.Email + "%"})
	}
	if len(params.Statuses) > 0 {
		conds = append(conds, sq.Eq{"status": params.Statuses})
	}
	if params.MinAge > 0 {
		conds = append(conds, sq.GtOrEq{"age": params.MinAge})
	}
	if params.MaxAge > 0 {
		conds = append(conds, sq.LtOrEq{"age": params.MaxAge})
	}
	if params.CreatedAfter != nil {
		conds = append(conds, sq.Gt{"created_at": params.CreatedAfter})
	}
	if params.CreatedBefore != nil {
		conds = append(conds, sq.Lt{"created_at": params.CreatedBefore})
	}

	// Count query — reuses the same conditions
	var totalCount int64
	err := r.db.Builder.
		Select("COUNT(*)").
		From("users").
		Where(conds).
		RunWith(r.db).
		QueryRowContext(ctx).
		Scan(&totalCount)
	if err != nil {
		return nil, fmt.Errorf("UserRepository.Search count: %w", err)
	}

	// Data query
	rows, err := r.db.Builder.
		Select("id", "name", "email", "status", "age", "created_at", "updated_at").
		From("users").
		Where(conds).
		OrderBy(fmt.Sprintf("%s %s", orderBy, orderDir)).
		Limit(uint64(pageSize)).
		Offset(offset).
		RunWith(r.db).
		QueryContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("UserRepository.Search query: %w", err)
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		u := &User{}
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.Status, &u.Age, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, fmt.Errorf("UserRepository.Search scan: %w", err)
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("UserRepository.Search rows: %w", err)
	}

	totalPages := int((totalCount + int64(pageSize) - 1) / int64(pageSize))

	return &SearchResult{
		Users:      users,
		TotalCount: totalCount,
		Page:       page,
		PageSize:   pageSize,
		TotalPages: totalPages,
	}, nil
}

// sanitizeOrderBy validates the ORDER BY column against an allowlist.
// ORDER BY clauses are NOT parameterized by squirrel, so manual validation is required.
var allowedOrderColumns = map[string]string{
	"id":         "id",
	"name":       "name",
	"email":      "email",
	"age":        "age",
	"created_at": "created_at",
	"updated_at": "updated_at",
}

func (r *UserRepository) sanitizeOrderBy(col string) string {
	if safe, ok := allowedOrderColumns[strings.ToLower(col)]; ok {
		return safe
	}
	return "id" // Default sort column
}
```

## Joins and Subqueries

```go
// repository/order_repository.go
package repository

import (
	"context"
	"fmt"
	"time"

	sq "github.com/Masterminds/squirrel"
)

type OrderWithUser struct {
	OrderID     int64
	UserID      int64
	UserName    string
	UserEmail   string
	TotalAmount float64
	Status      string
	CreatedAt   time.Time
}

// GetOrdersWithUsers demonstrates JOIN queries with squirrel.
func (r *OrderRepository) GetOrdersWithUsers(ctx context.Context, status string, limit int) ([]*OrderWithUser, error) {
	q := r.db.Builder.
		Select(
			"o.id AS order_id",
			"o.user_id",
			"u.name AS user_name",
			"u.email AS user_email",
			"o.total_amount",
			"o.status",
			"o.created_at",
		).
		From("orders o").
		Join("users u ON u.id = o.user_id AND u.deleted_at IS NULL").
		Where(sq.Eq{"o.deleted_at": nil})

	if status != "" {
		q = q.Where(sq.Eq{"o.status": status})
	}

	if limit > 0 {
		q = q.Limit(uint64(limit))
	}

	q = q.OrderBy("o.created_at DESC")

	rows, err := q.RunWith(r.db).QueryContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("GetOrdersWithUsers: %w", err)
	}
	defer rows.Close()

	var results []*OrderWithUser
	for rows.Next() {
		row := &OrderWithUser{}
		if err := rows.Scan(
			&row.OrderID, &row.UserID, &row.UserName, &row.UserEmail,
			&row.TotalAmount, &row.Status, &row.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("GetOrdersWithUsers scan: %w", err)
		}
		results = append(results, row)
	}
	return results, rows.Err()
}

// GetUsersWithRecentOrders uses a subquery to filter users.
func (r *OrderRepository) GetUsersWithRecentOrders(ctx context.Context, since time.Time) ([]*User, error) {
	// Subquery: user IDs with orders since the given timestamp
	subquery, args, err := r.db.Builder.
		Select("DISTINCT user_id").
		From("orders").
		Where(sq.Gt{"created_at": since}).
		Where(sq.Eq{"deleted_at": nil}).
		ToSql()
	if err != nil {
		return nil, fmt.Errorf("GetUsersWithRecentOrders subquery: %w", err)
	}

	// Main query using IN (subquery)
	rows, err := r.db.Builder.
		Select("id", "name", "email", "status", "age", "created_at", "updated_at").
		From("users").
		Where(fmt.Sprintf("id IN (%s)", subquery), args...).
		Where(sq.Eq{"deleted_at": nil}).
		OrderBy("name ASC").
		RunWith(r.db).
		QueryContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("GetUsersWithRecentOrders: %w", err)
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		u := &User{}
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.Status, &u.Age, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, fmt.Errorf("GetUsersWithRecentOrders scan: %w", err)
		}
		users = append(users, u)
	}
	return users, rows.Err()
}
```

## Transaction Management

```go
// repository/transaction.go
package repository

import (
	"context"
	"database/sql"
	"fmt"

	sq "github.com/Masterminds/squirrel"
)

// WithTransaction executes fn within a database transaction.
// The transaction is rolled back if fn returns an error or panics.
func (r *UserRepository) WithTransaction(ctx context.Context, fn func(tx sq.BaseRunner) error) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelReadCommitted,
	})
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p) // Re-panic after rollback
		}
	}()

	if err := fn(tx); err != nil {
		if rbErr := tx.Rollback(); rbErr != nil {
			return fmt.Errorf("transaction failed: %w (rollback error: %v)", err, rbErr)
		}
		return err
	}

	return tx.Commit()
}

// TransferBalance transfers amount from one user's balance to another,
// demonstrating transactional integrity with squirrel.
func (r *UserRepository) TransferBalance(ctx context.Context, fromUserID, toUserID int64, amount float64) error {
	return r.WithTransaction(ctx, func(tx sq.BaseRunner) error {
		builder := r.db.Builder.RunWith(tx)

		// Check source balance
		var sourceBalance float64
		err := builder.
			Select("balance").
			From("user_accounts").
			Where(sq.Eq{"user_id": fromUserID}).
			Suffix("FOR UPDATE").  // Row-level lock to prevent concurrent transfers
			QueryRowContext(ctx).
			Scan(&sourceBalance)
		if err != nil {
			return fmt.Errorf("check source balance: %w", err)
		}
		if sourceBalance < amount {
			return fmt.Errorf("insufficient balance: have %.2f, need %.2f", sourceBalance, amount)
		}

		// Debit source
		_, err = builder.
			Update("user_accounts").
			Set("balance", sq.Expr("balance - ?", amount)).
			Set("updated_at", sq.Expr("NOW()")).
			Where(sq.Eq{"user_id": fromUserID}).
			ExecContext(ctx)
		if err != nil {
			return fmt.Errorf("debit source: %w", err)
		}

		// Credit destination
		_, err = builder.
			Update("user_accounts").
			Set("balance", sq.Expr("balance + ?", amount)).
			Set("updated_at", sq.Expr("NOW()")).
			Where(sq.Eq{"user_id": toUserID}).
			ExecContext(ctx)
		if err != nil {
			return fmt.Errorf("credit destination: %w", err)
		}

		// Insert transaction record
		_, err = builder.
			Insert("balance_transfers").
			Columns("from_user_id", "to_user_id", "amount", "created_at").
			Values(fromUserID, toUserID, amount, sq.Expr("NOW()")).
			ExecContext(ctx)
		if err != nil {
			return fmt.Errorf("record transfer: %w", err)
		}

		return nil
	})
}
```

## Bulk Operations

```go
// repository/bulk_operations.go
package repository

import (
	"context"
	"fmt"
	"time"

	sq "github.com/Masterminds/squirrel"
)

// BulkCreateUsers inserts multiple users in a single statement.
// PostgreSQL handles up to ~65,000 parameters per query; chunk accordingly.
func (r *UserRepository) BulkCreateUsers(ctx context.Context, users []*User) error {
	if len(users) == 0 {
		return nil
	}

	const chunkSize = 500 // Stay well within PostgreSQL's parameter limit
	for i := 0; i < len(users); i += chunkSize {
		end := i + chunkSize
		if end > len(users) {
			end = len(users)
		}
		chunk := users[i:end]

		q := r.db.Builder.
			Insert("users").
			Columns("name", "email", "status", "age", "created_at", "updated_at")

		now := time.Now()
		for _, u := range chunk {
			q = q.Values(u.Name, u.Email, u.Status, u.Age, now, now)
		}

		// ON CONFLICT DO NOTHING for idempotent bulk imports
		q = q.Suffix("ON CONFLICT (email) DO NOTHING")

		if _, err := q.RunWith(r.db).ExecContext(ctx); err != nil {
			return fmt.Errorf("BulkCreateUsers chunk %d-%d: %w", i, end, err)
		}
	}
	return nil
}

// BulkUpsertUsers uses INSERT ... ON CONFLICT DO UPDATE for idempotent bulk operations.
func (r *UserRepository) BulkUpsertUsers(ctx context.Context, users []*User) error {
	if len(users) == 0 {
		return nil
	}

	const chunkSize = 200
	for i := 0; i < len(users); i += chunkSize {
		end := i + chunkSize
		if end > len(users) {
			end = len(users)
		}
		chunk := users[i:end]

		q := r.db.Builder.
			Insert("users").
			Columns("name", "email", "status", "age", "created_at", "updated_at")

		now := time.Now()
		for _, u := range chunk {
			q = q.Values(u.Name, u.Email, u.Status, u.Age, now, now)
		}

		q = q.Suffix(`
			ON CONFLICT (email) DO UPDATE SET
				name       = EXCLUDED.name,
				status     = EXCLUDED.status,
				age        = EXCLUDED.age,
				updated_at = EXCLUDED.updated_at
		`)

		if _, err := q.RunWith(r.db).ExecContext(ctx); err != nil {
			return fmt.Errorf("BulkUpsertUsers chunk %d-%d: %w", i, end, err)
		}
	}
	return nil
}
```

## Testing with sqlmock

```go
// repository/user_repository_test.go
package repository_test

import (
	"context"
	"database/sql"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	sq "github.com/Masterminds/squirrel"
	"github.com/example/myservice/db"
	"github.com/example/myservice/repository"
)

func setupMockDB(t *testing.T) (*db.DB, sqlmock.Sqlmock, func()) {
	t.Helper()
	sqlDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}

	mockDB := &db.DB{
		DB:      sqlDB,
		Builder: sq.StatementBuilder.PlaceholderFormat(sq.Dollar),
	}

	return mockDB, mock, func() { sqlDB.Close() }
}

func TestUserRepository_GetByID(t *testing.T) {
	mockDB, mock, cleanup := setupMockDB(t)
	defer cleanup()

	repo := repository.NewUserRepository(mockDB)
	ctx := context.Background()

	expectedUser := &repository.User{
		ID:        42,
		Name:      "Alice Smith",
		Email:     "alice@example.com",
		Status:    "active",
		Age:       30,
		CreatedAt: time.Date(2024, 1, 15, 9, 0, 0, 0, time.UTC),
		UpdatedAt: time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC),
	}

	// The query squirrel generates for this call
	mock.ExpectQuery(regexp.QuoteMeta(
		`SELECT id, name, email, status, age, created_at, updated_at FROM users WHERE deleted_at IS NULL AND id = $1`,
	)).
		WithArgs(int64(42)).
		WillReturnRows(sqlmock.NewRows([]string{
			"id", "name", "email", "status", "age", "created_at", "updated_at",
		}).AddRow(
			expectedUser.ID, expectedUser.Name, expectedUser.Email,
			expectedUser.Status, expectedUser.Age,
			expectedUser.CreatedAt, expectedUser.UpdatedAt,
		))

	user, err := repo.GetByID(ctx, 42)
	if err != nil {
		t.Fatalf("GetByID returned error: %v", err)
	}
	if user.Name != expectedUser.Name {
		t.Errorf("got Name=%q, want %q", user.Name, expectedUser.Name)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet SQL expectations: %v", err)
	}
}

func TestUserRepository_GetByID_NotFound(t *testing.T) {
	mockDB, mock, cleanup := setupMockDB(t)
	defer cleanup()

	repo := repository.NewUserRepository(mockDB)

	mock.ExpectQuery(regexp.QuoteMeta(
		`SELECT id, name, email, status, age, created_at, updated_at FROM users WHERE deleted_at IS NULL AND id = $1`,
	)).
		WithArgs(int64(999)).
		WillReturnRows(sqlmock.NewRows(nil))

	_, err := repo.GetByID(context.Background(), 999)
	if !errors.Is(err, repository.ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}
```

## Common Pitfalls and Their Solutions

### Pitfall 1: ORDER BY Injection

squirrel does not parameterize ORDER BY columns. Always validate against an allowlist:

```go
// DANGEROUS: user-controlled column name
q := q.OrderBy(req.SortColumn + " " + req.SortDir)

// SAFE: allowlist validation
func validateSortColumn(col string) string {
    allowed := map[string]bool{
        "id": true, "name": true, "created_at": true,
    }
    if allowed[col] {
        return col
    }
    return "id"
}
q := q.OrderBy(validateSortColumn(req.SortColumn) + " ASC")
```

### Pitfall 2: sq.Eq with Nil Values

`sq.Eq{"deleted_at": nil}` generates `WHERE deleted_at IS NULL` (correct PostgreSQL syntax). Do not use `sq.Eq{"deleted_at": "NULL"}` (generates `= 'NULL'`, a string comparison).

### Pitfall 3: Missing LIMIT on Search Queries

Always enforce a maximum page size to prevent accidentally fetching millions of rows:

```go
const maxPageSize = 1000

func (r *UserRepository) List(ctx context.Context, limit, offset int) ([]*User, error) {
    if limit <= 0 || limit > maxPageSize {
        limit = 20
    }
    // ...
}
```

### Pitfall 4: N+1 Query Problem

Query builders do not prevent N+1 queries. Use JOINs or batch queries explicitly:

```go
// N+1 PROBLEM: fetches one order per user in a loop
for _, user := range users {
    orders, _ := repo.GetOrdersByUserID(ctx, user.ID)  // N separate queries
    // ...
}

// CORRECT: single JOIN query
ordersWithUsers, _ := repo.GetOrdersWithUsers(ctx, "completed", 100)
```

## Summary

Query builders occupy the right level of abstraction for most Go database code: they prevent SQL injection by enforcing parameterization, enable clean conditional query composition, and avoid the "magic" of full ORMs while being significantly safer and more maintainable than raw string concatenation.

The critical rules for production use:

1. **Always use parameterized values** for any user-supplied data—squirrel handles this automatically for WHERE clauses, but not for ORDER BY, table names, or column names.
2. **Validate ORDER BY columns against an allowlist**—squirrel passes these through to SQL verbatim.
3. **Always set a maximum page size** on search and list queries.
4. **Use `RETURNING id`** for PostgreSQL inserts to avoid a separate SELECT.
5. **Use `FOR UPDATE`** in transaction SELECT queries that precede a conditional UPDATE.
6. **Chunk bulk operations** to stay within PostgreSQL's 65,535 parameter limit.
