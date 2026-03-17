---
title: "Go GraphQL Server with gqlgen: Schema-First Development, Dataloaders, Subscriptions, and Complexity Limits"
date: 2032-02-24T00:00:00-05:00
draft: false
tags: ["Go", "GraphQL", "gqlgen", "API", "Backend", "Performance"]
categories:
- Go
- API Development
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to building GraphQL servers in Go with gqlgen, covering schema-first design, N+1 elimination with dataloaders, real-time subscriptions over WebSocket, and query complexity enforcement."
more_link: "yes"
url: "/go-graphql-server-gqlgen-dataloaders-subscriptions/"
---

GraphQL adoption in enterprise Go backends accelerated significantly once gqlgen made schema-first development the default workflow. Unlike runtime reflection-based libraries, gqlgen generates type-safe Go code from your GraphQL schema, catching schema-to-resolver mismatches at compile time rather than at runtime. This guide walks through building a production-ready GraphQL server: from schema design through N+1 query elimination with dataloaders, real-time subscriptions, and the query complexity analysis that prevents expensive queries from reaching your database.

<!--more-->

# Go GraphQL Server with gqlgen

## Project Setup

### Initialize the Module

```bash
mkdir graphql-api && cd graphql-api
go mod init github.com/example/graphql-api

# Install gqlgen
go get github.com/99designs/gqlgen@v0.17.45
go get github.com/vektah/gqlparser/v2@v2.5.14

# Initialize gqlgen project
go run github.com/99designs/gqlgen@v0.17.45 init
```

This creates the project scaffold:

```
graphql-api/
├── gqlgen.yml
├── graph/
│   ├── generated/
│   │   └── generated.go    (auto-generated, do not edit)
│   ├── model/
│   │   └── models_gen.go   (auto-generated)
│   ├── resolver.go
│   ├── schema.graphqls
│   └── schema.resolvers.go
└── server.go
```

### gqlgen.yml Configuration

```yaml
# gqlgen.yml
schema:
  - graph/*.graphqls

exec:
  filename: graph/generated/generated.go
  package: generated

model:
  filename: graph/model/models_gen.go
  package: model

resolver:
  layout: follow-schema
  dir: graph
  package: graph
  filename_template: "{name}.resolvers.go"

autobind:
  - "github.com/example/graphql-api/internal/domain"

models:
  ID:
    model:
      - github.com/99designs/gqlgen/graphql/introspection.Schema
  Upload:
    model:
      - github.com/99designs/gqlgen/graphql.Upload

# Omit types that should use custom models
omit_getters: true
```

## Section 1: Schema-First Design

### Domain Schema

```graphql
# graph/schema.graphqls

scalar Time
scalar Upload
scalar JSON

directive @auth(requires: Role = USER) on FIELD_DEFINITION
directive @rateLimit(limit: Int!, window: Int!) on FIELD_DEFINITION

enum Role {
  ADMIN
  USER
  READONLY
}

enum OrderStatus {
  PENDING
  PROCESSING
  SHIPPED
  DELIVERED
  CANCELLED
}

interface Node {
  id: ID!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

# ─── User Domain ─────────────────────────────────────────────────────────────

type User implements Node {
  id: ID!
  email: String!
  name: String!
  role: Role!
  createdAt: Time!
  updatedAt: Time!
  orders(
    first: Int
    after: String
    status: OrderStatus
  ): OrderConnection!
  profile: UserProfile
}

type UserProfile {
  bio: String
  avatarURL: String
  preferences: JSON
}

type UserEdge {
  node: User!
  cursor: String!
}

type UserConnection {
  edges: [UserEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

# ─── Order Domain ─────────────────────────────────────────────────────────────

type Order implements Node {
  id: ID!
  status: OrderStatus!
  totalCents: Int!
  createdAt: Time!
  updatedAt: Time!
  user: User!
  items: [OrderItem!]!
  shippingAddress: Address
}

type OrderItem {
  id: ID!
  quantity: Int!
  unitPriceCents: Int!
  product: Product!
}

type Address {
  street: String!
  city: String!
  country: String!
  postalCode: String!
}

type OrderEdge {
  node: Order!
  cursor: String!
}

type OrderConnection {
  edges: [OrderEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

# ─── Product Domain ───────────────────────────────────────────────────────────

type Product implements Node {
  id: ID!
  name: String!
  description: String
  priceCents: Int!
  inventoryCount: Int!
  categories: [Category!]!
}

type Category implements Node {
  id: ID!
  name: String!
  slug: String!
  products(first: Int, after: String): ProductConnection!
}

type ProductEdge {
  node: Product!
  cursor: String!
}

type ProductConnection {
  edges: [ProductEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

# ─── Queries ──────────────────────────────────────────────────────────────────

type Query {
  node(id: ID!): Node
  me: User! @auth
  user(id: ID!): User @auth(requires: ADMIN)
  users(
    first: Int
    after: String
    search: String
  ): UserConnection! @auth(requires: ADMIN)
  order(id: ID!): Order @auth
  orders(
    first: Int
    after: String
    status: OrderStatus
  ): OrderConnection! @auth
  product(id: ID!): Product
  products(
    first: Int
    after: String
    categorySlug: String
    search: String
  ): ProductConnection!
}

# ─── Mutations ────────────────────────────────────────────────────────────────

type Mutation {
  createOrder(input: CreateOrderInput!): CreateOrderPayload! @auth
  updateOrderStatus(id: ID!, status: OrderStatus!): UpdateOrderStatusPayload! @auth(requires: ADMIN)
  updateProfile(input: UpdateProfileInput!): UpdateProfilePayload! @auth
  uploadAvatar(file: Upload!): UploadAvatarPayload! @auth
}

input CreateOrderInput {
  items: [OrderItemInput!]!
  shippingAddressId: ID!
}

input OrderItemInput {
  productId: ID!
  quantity: Int!
}

input UpdateProfileInput {
  name: String
  bio: String
}

type CreateOrderPayload {
  order: Order
  errors: [UserError!]!
}

type UpdateOrderStatusPayload {
  order: Order
  errors: [UserError!]!
}

type UpdateProfilePayload {
  user: User
  errors: [UserError!]!
}

type UploadAvatarPayload {
  url: String
  errors: [UserError!]!
}

type UserError {
  field: String
  message: String!
  code: String!
}

# ─── Subscriptions ────────────────────────────────────────────────────────────

type Subscription {
  orderStatusChanged(orderId: ID!): Order! @auth
  newOrderForAdmin: Order! @auth(requires: ADMIN)
  inventoryAlert(productId: ID!): InventoryAlert! @auth(requires: ADMIN)
}

type InventoryAlert {
  product: Product!
  previousCount: Int!
  currentCount: Int!
  alertType: String!
}
```

### Regenerate Code After Schema Changes

```bash
go generate ./...
# or
go run github.com/99designs/gqlgen@v0.17.45 generate
```

## Section 2: Resolver Implementation

### Server Setup with Middleware

```go
// server.go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/extension"
	"github.com/99designs/gqlgen/graphql/handler/lru"
	"github.com/99designs/gqlgen/graphql/handler/transport"
	"github.com/99designs/gqlgen/graphql/playground"
	"github.com/gorilla/websocket"
	"github.com/vektah/gqlparser/v2/gqlerror"

	"github.com/example/graphql-api/graph"
	"github.com/example/graphql-api/graph/generated"
	"github.com/example/graphql-api/internal/auth"
	"github.com/example/graphql-api/internal/dataloader"
	"github.com/example/graphql-api/internal/database"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	db, err := database.New(os.Getenv("DATABASE_URL"))
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}

	resolver := graph.NewResolver(db, logger)
	schema := generated.NewExecutableSchema(generated.Config{
		Resolvers: resolver,
		Directives: generated.DirectiveRoot{
			Auth:      auth.DirectiveHandler(db),
			RateLimit: rateLimitDirective,
		},
		Complexity: buildComplexityRoot(),
	})

	srv := handler.New(schema)

	// Transports
	srv.AddTransport(transport.OPTIONS{})
	srv.AddTransport(transport.GET{})
	srv.AddTransport(transport.POST{})
	srv.AddTransport(transport.MultipartForm{
		MaxMemory:     32 * 1024 * 1024, // 32 MiB
		MaxUploadSize: 10 * 1024 * 1024, // 10 MiB
	})
	srv.AddTransport(transport.Websocket{
		KeepAlivePingInterval: 10 * time.Second,
		Upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				return isAllowedOrigin(origin)
			},
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
		},
		InitFunc: auth.WebSocketInitFunc(db),
	})

	// Caching
	srv.SetQueryCache(lru.New[*ast.QueryDocument](1000))

	// Extensions
	srv.Use(extension.Introspection{})
	srv.Use(extension.AutomaticPersistedQuery{
		Cache: lru.New[string](100),
	})
	srv.Use(extension.FixedComplexityLimit(1000))

	// Middleware chain
	mux := http.NewServeMux()

	handler := dataloader.Middleware(db)(
		auth.Middleware(db)(
			loggingMiddleware(logger)(
				srv,
			),
		),
	)

	mux.Handle("/query", handler)
	mux.Handle("/playground", playground.Handler("GraphQL", "/query"))
	mux.Handle("/health", http.HandlerFunc(healthHandler))

	addr := ":" + getEnv("PORT", "8080")
	logger.Info("starting GraphQL server", "addr", addr)

	httpServer := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

### Resolver Structure

```go
// graph/resolver.go
package graph

import (
	"log/slog"

	"github.com/example/graphql-api/internal/database"
	"github.com/example/graphql-api/internal/service"
)

type Resolver struct {
	db            *database.DB
	logger        *slog.Logger
	orderService  *service.OrderService
	userService   *service.UserService
	productService *service.ProductService
	events        *EventBus
}

func NewResolver(db *database.DB, logger *slog.Logger) *Resolver {
	return &Resolver{
		db:             db,
		logger:         logger,
		orderService:   service.NewOrderService(db),
		userService:    service.NewUserService(db),
		productService: service.NewProductService(db),
		events:         NewEventBus(),
	}
}
```

### Query Resolvers

```go
// graph/query.resolvers.go
package graph

import (
	"context"
	"fmt"

	"github.com/example/graphql-api/graph/model"
	"github.com/example/graphql-api/internal/auth"
	"github.com/example/graphql-api/internal/cursor"
)

func (r *queryResolver) Me(ctx context.Context) (*model.User, error) {
	userID := auth.UserIDFromContext(ctx)
	if userID == "" {
		return nil, fmt.Errorf("not authenticated")
	}
	return r.userService.GetByID(ctx, userID)
}

func (r *queryResolver) Users(
	ctx context.Context,
	first *int,
	after *string,
	search *string,
) (*model.UserConnection, error) {
	limit := 20
	if first != nil && *first > 0 && *first <= 100 {
		limit = *first
	}

	var afterID string
	if after != nil {
		var err error
		afterID, err = cursor.Decode(*after)
		if err != nil {
			return nil, fmt.Errorf("invalid cursor: %w", err)
		}
	}

	users, total, err := r.userService.List(ctx, service.ListUsersParams{
		Limit:   limit,
		AfterID: afterID,
		Search:  deref(search),
	})
	if err != nil {
		return nil, fmt.Errorf("listing users: %w", err)
	}

	edges := make([]*model.UserEdge, len(users))
	for i, u := range users {
		edges[i] = &model.UserEdge{
			Node:   u,
			Cursor: cursor.Encode(u.ID),
		}
	}

	conn := &model.UserConnection{
		Edges:      edges,
		TotalCount: total,
		PageInfo: &model.PageInfo{
			HasNextPage:     len(users) == limit,
			HasPreviousPage: afterID != "",
		},
	}

	if len(edges) > 0 {
		start := edges[0].Cursor
		end := edges[len(edges)-1].Cursor
		conn.PageInfo.StartCursor = &start
		conn.PageInfo.EndCursor = &end
	}

	return conn, nil
}

func (r *queryResolver) Products(
	ctx context.Context,
	first *int,
	after *string,
	categorySlug *string,
	search *string,
) (*model.ProductConnection, error) {
	limit := 20
	if first != nil && *first > 0 && *first <= 100 {
		limit = *first
	}

	var afterID string
	if after != nil {
		var err error
		afterID, err = cursor.Decode(*after)
		if err != nil {
			return nil, fmt.Errorf("invalid cursor: %w", err)
		}
	}

	products, total, err := r.productService.List(ctx, service.ListProductsParams{
		Limit:        limit,
		AfterID:      afterID,
		CategorySlug: deref(categorySlug),
		Search:       deref(search),
	})
	if err != nil {
		return nil, err
	}

	edges := make([]*model.ProductEdge, len(products))
	for i, p := range products {
		edges[i] = &model.ProductEdge{
			Node:   p,
			Cursor: cursor.Encode(p.ID),
		}
	}

	conn := &model.ProductConnection{
		Edges:      edges,
		TotalCount: total,
		PageInfo: &model.PageInfo{
			HasNextPage:     len(products) == limit,
			HasPreviousPage: afterID != "",
		},
	}
	return conn, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
```

## Section 3: Dataloaders for N+1 Elimination

The N+1 problem is the most common performance issue in GraphQL. A query for 100 orders that each need their user loaded results in 101 database queries without dataloaders. Dataloaders batch these into a single query.

### Dataloader Implementation

```go
// internal/dataloader/dataloader.go
package dataloader

import (
	"context"
	"net/http"
	"time"

	"github.com/example/graphql-api/graph/model"
	"github.com/example/graphql-api/internal/database"
)

type contextKey string

const loadersKey contextKey = "dataloaders"

// Loaders holds all dataloader instances for a single request.
type Loaders struct {
	UserByID    *UserLoader
	ProductByID *ProductLoader
	OrdersByUserID *OrdersLoader
	CategoriesByProductID *CategoriesLoader
}

func newLoaders(db *database.DB) *Loaders {
	return &Loaders{
		UserByID:    newUserLoader(db),
		ProductByID: newProductLoader(db),
		OrdersByUserID: newOrdersLoader(db),
		CategoriesByProductID: newCategoriesLoader(db),
	}
}

// Middleware attaches dataloaders to each request context.
func Middleware(db *database.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			loaders := newLoaders(db)
			ctx := context.WithValue(r.Context(), loadersKey, loaders)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// For extracts the loaders from context.
func For(ctx context.Context) *Loaders {
	return ctx.Value(loadersKey).(*Loaders)
}
```

### User Dataloader

```go
// internal/dataloader/user_loader.go
package dataloader

import (
	"context"
	"fmt"
	"time"

	"github.com/example/graphql-api/graph/model"
	"github.com/example/graphql-api/internal/database"
)

// UserLoader batches and caches User lookups by ID.
type UserLoader struct {
	db     *database.DB
	batch  chan userLoadRequest
	cache  map[string]*userResult
}

type userLoadRequest struct {
	id     string
	result chan *userResult
}

type userResult struct {
	user *model.User
	err  error
}

func newUserLoader(db *database.DB) *UserLoader {
	l := &UserLoader{
		db:    db,
		batch: make(chan userLoadRequest, 100),
		cache: make(map[string]*userResult),
	}
	go l.run()
	return l
}

// Load returns a User by ID, batching concurrent requests.
func (l *UserLoader) Load(ctx context.Context, id string) (*model.User, error) {
	// Check cache first
	if r, ok := l.cache[id]; ok {
		return r.user, r.err
	}

	result := make(chan *userResult, 1)
	select {
	case l.batch <- userLoadRequest{id: id, result: result}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	select {
	case r := <-result:
		return r.user, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// LoadMany returns multiple Users by IDs in order.
func (l *UserLoader) LoadMany(ctx context.Context, ids []string) ([]*model.User, []error) {
	results := make([]*model.User, len(ids))
	errs := make([]error, len(ids))

	type indexedResult struct {
		index int
		user  *model.User
		err   error
	}

	ch := make(chan indexedResult, len(ids))
	for i, id := range ids {
		go func(index int, userID string) {
			u, err := l.Load(ctx, userID)
			ch <- indexedResult{index: index, user: u, err: err}
		}(i, id)
	}

	for range ids {
		r := <-ch
		results[r.index] = r.user
		errs[r.index] = r.err
	}
	return results, errs
}

func (l *UserLoader) run() {
	ticker := time.NewTicker(2 * time.Millisecond) // batch window
	defer ticker.Stop()

	pending := make(map[string][]chan *userResult)

	flush := func() {
		if len(pending) == 0 {
			return
		}

		ids := make([]string, 0, len(pending))
		for id := range pending {
			ids = append(ids, id)
		}

		users, err := l.db.GetUsersByIDs(context.Background(), ids)
		userMap := make(map[string]*model.User, len(users))
		for _, u := range users {
			userMap[u.ID] = u
		}

		for id, waiters := range pending {
			var r *userResult
			if err != nil {
				r = &userResult{err: fmt.Errorf("batch load: %w", err)}
			} else if u, ok := userMap[id]; ok {
				r = &userResult{user: u}
			} else {
				r = &userResult{err: fmt.Errorf("user %s not found", id)}
			}

			l.cache[id] = r
			for _, ch := range waiters {
				ch <- r
			}
		}

		pending = make(map[string][]chan *userResult)
	}

	for {
		select {
		case req := <-l.batch:
			pending[req.id] = append(pending[req.id], req.result)
			// Flush if batch is large enough
			if len(pending) >= 100 {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}
```

### Using Dataloaders in Resolvers

```go
// graph/order.resolvers.go
package graph

import (
	"context"
	"fmt"

	"github.com/example/graphql-api/graph/model"
	"github.com/example/graphql-api/internal/dataloader"
)

// User resolves the user field on an Order using the dataloader.
// Without this, fetching 50 orders would issue 50 user SELECT queries.
// With dataloaders, all user IDs are batched into a single IN() query.
func (r *orderResolver) User(ctx context.Context, obj *model.Order) (*model.User, error) {
	return dataloader.For(ctx).UserByID.Load(ctx, obj.UserID)
}

// Items resolves order items with their products loaded via dataloader.
func (r *orderResolver) Items(ctx context.Context, obj *model.Order) ([]*model.OrderItem, error) {
	items, err := r.orderService.GetItemsByOrderID(ctx, obj.ID)
	if err != nil {
		return nil, fmt.Errorf("fetching order items: %w", err)
	}
	return items, nil
}

// Product resolves the product on an OrderItem via dataloader.
func (r *orderItemResolver) Product(ctx context.Context, obj *model.OrderItem) (*model.Product, error) {
	return dataloader.For(ctx).ProductByID.Load(ctx, obj.ProductID)
}

// Categories resolves product categories via dataloader.
func (r *productResolver) Categories(ctx context.Context, obj *model.Product) ([]*model.Category, error) {
	return dataloader.For(ctx).CategoriesByProductID.Load(ctx, obj.ID)
}
```

## Section 4: Real-Time Subscriptions

### Event Bus

```go
// graph/eventbus.go
package graph

import (
	"sync"

	"github.com/example/graphql-api/graph/model"
)

type EventBus struct {
	mu          sync.RWMutex
	orderSubs   map[string][]chan *model.Order
	adminSubs   []chan *model.Order
	inventorySubs map[string][]chan *model.InventoryAlert
}

func NewEventBus() *EventBus {
	return &EventBus{
		orderSubs:     make(map[string][]chan *model.Order),
		inventorySubs: make(map[string][]chan *model.InventoryAlert),
	}
}

func (b *EventBus) SubscribeOrderStatus(orderID string) (<-chan *model.Order, func()) {
	ch := make(chan *model.Order, 1)
	b.mu.Lock()
	b.orderSubs[orderID] = append(b.orderSubs[orderID], ch)
	b.mu.Unlock()

	cancel := func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		subs := b.orderSubs[orderID]
		for i, sub := range subs {
			if sub == ch {
				b.orderSubs[orderID] = append(subs[:i], subs[i+1:]...)
				close(ch)
				break
			}
		}
	}
	return ch, cancel
}

func (b *EventBus) PublishOrderStatus(order *model.Order) {
	b.mu.RLock()
	subs := make([]chan *model.Order, len(b.orderSubs[order.ID]))
	copy(subs, b.orderSubs[order.ID])

	adminSubs := make([]chan *model.Order, len(b.adminSubs))
	copy(adminSubs, b.adminSubs)
	b.mu.RUnlock()

	for _, ch := range subs {
		select {
		case ch <- order:
		default:
			// Drop if subscriber is slow; could log here
		}
	}
	for _, ch := range adminSubs {
		select {
		case ch <- order:
		default:
		}
	}
}

func (b *EventBus) SubscribeAdminOrders() (<-chan *model.Order, func()) {
	ch := make(chan *model.Order, 10)
	b.mu.Lock()
	b.adminSubs = append(b.adminSubs, ch)
	b.mu.Unlock()

	cancel := func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		for i, sub := range b.adminSubs {
			if sub == ch {
				b.adminSubs = append(b.adminSubs[:i], b.adminSubs[i+1:]...)
				close(ch)
				break
			}
		}
	}
	return ch, cancel
}
```

### Subscription Resolvers

```go
// graph/subscription.resolvers.go
package graph

import (
	"context"
	"fmt"

	"github.com/example/graphql-api/graph/model"
	"github.com/example/graphql-api/internal/auth"
)

func (r *subscriptionResolver) OrderStatusChanged(
	ctx context.Context,
	orderID string,
) (<-chan *model.Order, error) {
	userID := auth.UserIDFromContext(ctx)

	// Verify user owns this order or is admin
	order, err := r.orderService.GetByID(ctx, orderID)
	if err != nil {
		return nil, fmt.Errorf("order not found: %w", err)
	}
	if order.UserID != userID && !auth.IsAdmin(ctx) {
		return nil, fmt.Errorf("access denied")
	}

	ch, cancel := r.events.SubscribeOrderStatus(orderID)

	// Cancel subscription when client disconnects
	go func() {
		<-ctx.Done()
		cancel()
	}()

	return ch, nil
}

func (r *subscriptionResolver) NewOrderForAdmin(
	ctx context.Context,
) (<-chan *model.Order, error) {
	ch, cancel := r.events.SubscribeAdminOrders()
	go func() {
		<-ctx.Done()
		cancel()
	}()
	return ch, nil
}

func (r *subscriptionResolver) InventoryAlert(
	ctx context.Context,
	productID string,
) (<-chan *model.InventoryAlert, error) {
	ch := make(chan *model.InventoryAlert, 5)

	go func() {
		defer close(ch)
		// Subscribe to inventory changes from your message broker or Redis pub/sub
		sub := r.productService.SubscribeInventory(productID)
		defer sub.Close()

		for {
			select {
			case <-ctx.Done():
				return
			case alert, ok := <-sub.Chan():
				if !ok {
					return
				}
				select {
				case ch <- alert:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	return ch, nil
}
```

## Section 5: Query Complexity Limits

### Complexity Rules

```go
// graph/complexity.go
package graph

import "github.com/99designs/gqlgen/graphql"

func buildComplexityRoot() generated.ComplexityRoot {
	var c generated.ComplexityRoot

	// Base costs for simple fields
	c.User.ID = func(childComplexity int) int { return 1 }
	c.User.Email = func(childComplexity int) int { return 1 }
	c.User.Name = func(childComplexity int) int { return 1 }

	// Paginated connections: cost = (first * childComplexity) + overhead
	c.User.Orders = func(childComplexity int, first *int, after *string, status *model.OrderStatus) int {
		n := 20
		if first != nil {
			n = *first
		}
		return n*childComplexity + 10
	}

	c.Query.Users = func(childComplexity int, first *int, after *string, search *string) int {
		n := 20
		if first != nil {
			n = *first
		}
		return n*childComplexity + 10
	}

	c.Query.Products = func(childComplexity int, first *int, after *string, categorySlug *string, search *string) int {
		n := 20
		if first != nil {
			n = *first
		}
		return n*childComplexity + 5
	}

	c.Order.Items = func(childComplexity int) int {
		return 10 * childComplexity
	}

	c.Category.Products = func(childComplexity int, first *int, after *string) int {
		n := 20
		if first != nil {
			n = *first
		}
		return n*childComplexity + 5
	}

	// Mutations have fixed costs
	c.Mutation.CreateOrder = func(childComplexity int, input model.CreateOrderInput) int {
		return 50 + childComplexity
	}

	// Subscriptions are always expensive
	c.Subscription.OrderStatusChanged = func(childComplexity int, orderID string) int {
		return 100 + childComplexity
	}

	return c
}
```

### Custom Complexity Validator

For more sophisticated analysis, implement the `graphql.OperationMiddleware` interface:

```go
// internal/complexity/validator.go
package complexity

import (
	"context"
	"fmt"

	"github.com/99designs/gqlgen/graphql"
	"github.com/vektah/gqlparser/v2/gqlerror"
)

const (
	DefaultMaxComplexity = 1000
	// Individual field limits
	MaxPaginationFirst = 100
)

type Validator struct {
	maxComplexity int
}

func New(max int) *Validator {
	return &Validator{maxComplexity: max}
}

func (v *Validator) ExtensionName() string {
	return "ComplexityValidator"
}

func (v *Validator) Validate(schema graphql.ExecutableSchema) error {
	return nil
}

func (v *Validator) InterceptOperation(
	ctx context.Context,
	next graphql.OperationHandler,
) graphql.ResponseHandler {
	oc := graphql.GetOperationContext(ctx)

	// Allow introspection queries to bypass limits
	if oc.Operation != nil && oc.Operation.Name == "IntrospectionQuery" {
		return next(ctx)
	}

	// Validate pagination arguments
	for _, sel := range oc.Operation.SelectionSet {
		if err := validatePaginationArgs(sel); err != nil {
			return func(ctx context.Context) *graphql.Response {
				return graphql.ErrorResponse(ctx, err.Error())
			}
		}
	}

	return next(ctx)
}

func validatePaginationArgs(sel ast.Selection) error {
	// Walk the selection set looking for `first` arguments exceeding limits
	// Implementation depends on gqlparser AST traversal
	return nil
}
```

## Section 6: Authentication Directive

```go
// internal/auth/directive.go
package auth

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/99designs/gqlgen/graphql"
	"github.com/example/graphql-api/graph/model"
	"github.com/example/graphql-api/internal/database"
	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const (
	userContextKey contextKey = "user"
	tokenSecret               = "" // set via environment
)

type Claims struct {
	UserID string     `json:"sub"`
	Role   model.Role `json:"role"`
	jwt.RegisteredClaims
}

func Middleware(db *database.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := extractToken(r)
			if token == "" {
				next.ServeHTTP(w, r)
				return
			}

			claims, err := validateToken(token)
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}

			ctx := context.WithValue(r.Context(), userContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func DirectiveHandler(db *database.DB) func(
	ctx context.Context,
	obj interface{},
	next graphql.Resolver,
	requires model.Role,
) (interface{}, error) {
	return func(
		ctx context.Context,
		obj interface{},
		next graphql.Resolver,
		requires model.Role,
	) (interface{}, error) {
		claims := claimsFromContext(ctx)
		if claims == nil {
			return nil, fmt.Errorf("authentication required")
		}

		switch requires {
		case model.RoleAdmin:
			if claims.Role != model.RoleAdmin {
				return nil, fmt.Errorf("admin access required")
			}
		case model.RoleUser:
			if claims.Role != model.RoleUser && claims.Role != model.RoleAdmin {
				return nil, fmt.Errorf("user access required")
			}
		}

		return next(ctx)
	}
}

func extractToken(r *http.Request) string {
	bearer := r.Header.Get("Authorization")
	if strings.HasPrefix(bearer, "Bearer ") {
		return strings.TrimPrefix(bearer, "Bearer ")
	}
	return r.URL.Query().Get("token")
}

func validateToken(tokenStr string) (*Claims, error) {
	secret := []byte(os.Getenv("JWT_SECRET"))
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{},
		func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return secret, nil
		})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}

func UserIDFromContext(ctx context.Context) string {
	claims := claimsFromContext(ctx)
	if claims == nil {
		return ""
	}
	return claims.UserID
}

func IsAdmin(ctx context.Context) bool {
	claims := claimsFromContext(ctx)
	return claims != nil && claims.Role == model.RoleAdmin
}

func claimsFromContext(ctx context.Context) *Claims {
	c, _ := ctx.Value(userContextKey).(*Claims)
	return c
}

func WebSocketInitFunc(db *database.DB) transport.WebsocketInitFunc {
	return func(ctx context.Context, initPayload transport.InitPayload) (context.Context, *transport.InitPayload, error) {
		token, ok := initPayload["authToken"].(string)
		if !ok || token == "" {
			return ctx, &initPayload, nil
		}
		claims, err := validateToken(token)
		if err != nil {
			return ctx, nil, fmt.Errorf("invalid auth token")
		}
		ctx = context.WithValue(ctx, userContextKey, claims)
		return ctx, &initPayload, nil
	}
}
```

## Section 7: Error Handling

### Structured Error Responses

```go
// internal/gqlerr/errors.go
package gqlerr

import (
	"context"
	"fmt"

	"github.com/99designs/gqlgen/graphql"
	"github.com/vektah/gqlparser/v2/gqlerror"
)

type Code string

const (
	CodeNotFound       Code = "NOT_FOUND"
	CodeUnauthorized   Code = "UNAUTHORIZED"
	CodeForbidden      Code = "FORBIDDEN"
	CodeValidation     Code = "VALIDATION_ERROR"
	CodeInternal       Code = "INTERNAL_ERROR"
	CodeRateLimit      Code = "RATE_LIMIT_EXCEEDED"
)

func New(ctx context.Context, code Code, msg string) *gqlerror.Error {
	return &gqlerror.Error{
		Message: msg,
		Path:    graphql.GetPath(ctx),
		Extensions: map[string]interface{}{
			"code": string(code),
		},
	}
}

func NotFound(ctx context.Context, resource, id string) *gqlerror.Error {
	return New(ctx, CodeNotFound, fmt.Sprintf("%s with ID %q not found", resource, id))
}

func Unauthorized(ctx context.Context) *gqlerror.Error {
	return New(ctx, CodeUnauthorized, "authentication required")
}

func Forbidden(ctx context.Context) *gqlerror.Error {
	return New(ctx, CodeForbidden, "insufficient permissions")
}

func ValidationError(ctx context.Context, field, msg string) *gqlerror.Error {
	err := New(ctx, CodeValidation, msg)
	err.Extensions["field"] = field
	return err
}

// Wrap turns a service-layer error into a user-facing payload error.
func ToPayloadErrors(errs ...error) []*model.UserError {
	result := make([]*model.UserError, 0, len(errs))
	for _, err := range errs {
		if err == nil {
			continue
		}
		var code string
		var field *string

		switch {
		case errors.Is(err, service.ErrNotFound):
			code = string(CodeNotFound)
		case errors.Is(err, service.ErrValidation):
			code = string(CodeValidation)
		default:
			code = string(CodeInternal)
		}

		result = append(result, &model.UserError{
			Message: err.Error(),
			Code:    code,
			Field:   field,
		})
	}
	return result
}
```

## Section 8: Testing GraphQL Resolvers

```go
// graph/resolver_test.go
package graph_test

import (
	"testing"

	"github.com/99designs/gqlgen/client"
	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/example/graphql-api/graph"
	"github.com/example/graphql-api/graph/generated"
	"github.com/example/graphql-api/internal/database"
)

func setupTestServer(t *testing.T) *client.Client {
	t.Helper()
	db := database.NewTestDB(t)
	resolver := graph.NewResolver(db, slog.Default())
	schema := generated.NewExecutableSchema(generated.Config{
		Resolvers: resolver,
		Complexity: graph.BuildComplexityRoot(),
	})
	srv := handler.NewDefaultServer(schema)
	return client.New(srv)
}

func TestQueryProducts(t *testing.T) {
	c := setupTestServer(t)

	var resp struct {
		Products struct {
			Edges []struct {
				Node struct {
					ID   string
					Name string
				}
				Cursor string
			}
			PageInfo struct {
				HasNextPage bool
			}
			TotalCount int
		}
	}

	err := c.Post(`
		query {
			products(first: 5) {
				edges {
					node { id name }
					cursor
				}
				pageInfo { hasNextPage }
				totalCount
			}
		}
	`, &resp)

	require.NoError(t, err)
	assert.GreaterOrEqual(t, resp.Products.TotalCount, 0)
}

func TestComplexityLimit(t *testing.T) {
	c := setupTestServer(t)

	var resp struct{}
	// This deeply nested query should exceed the complexity limit
	err := c.Post(`
		query {
			users(first: 100) {
				edges {
					node {
						orders(first: 100) {
							edges {
								node {
									items {
										product {
											categories {
												products(first: 100) {
													edges { node { id } }
												}
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
	`, &resp)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "complexity")
}
```

## Conclusion

A production gqlgen GraphQL server requires attention across multiple layers: schema design that enables efficient cursor-based pagination, dataloaders that eliminate the N+1 problem at the resolver boundary, complexity analysis that prevents expensive queries from reaching the database, and typed error payloads that clients can act on. The schema-first approach enforced by gqlgen means your GraphQL contract is the source of truth, with compile-time verification that resolvers implement every field correctly. Combined with WebSocket subscriptions for real-time events, this architecture handles the full spectrum of enterprise API requirements.
