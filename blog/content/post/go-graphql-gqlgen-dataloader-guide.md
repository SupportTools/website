---
title: "Go GraphQL Server: gqlgen Schema-First Development, DataLoaders, Subscriptions, and Authorization"
date: 2028-08-27T00:00:00-05:00
draft: false
tags: ["Go", "GraphQL", "gqlgen", "DataLoader", "Subscriptions", "Authorization"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to building production GraphQL servers in Go with gqlgen: schema-first development, N+1 query prevention with DataLoaders, real-time subscriptions, field-level authorization, and performance optimization."
more_link: "yes"
url: "/go-graphql-gqlgen-dataloader-guide/"
---

GraphQL is compelling for APIs that serve multiple frontend clients with different data requirements. The query language eliminates over-fetching, the type system catches contract violations early, and subscriptions handle real-time updates elegantly. gqlgen is the definitive Go GraphQL library — unlike introspection-based libraries, gqlgen generates type-safe Go code from your schema, making your resolvers compile-time safe.

This guide covers building a production GraphQL server with gqlgen: schema-first development, DataLoaders to prevent N+1 queries, WebSocket subscriptions, field-level authorization, complexity limits, and observability.

<!--more-->

# [Go GraphQL Server: gqlgen, DataLoaders, Subscriptions, and Authorization](#go-graphql-gqlgen)

## Section 1: Project Setup and Code Generation

### Installation

```bash
mkdir graphql-api && cd graphql-api
go mod init github.com/myorg/graphql-api

# Install gqlgen
go get github.com/99designs/gqlgen@latest
go run github.com/99designs/gqlgen init

# This creates:
# graph/schema.graphqls
# graph/model/models_gen.go
# graph/resolver.go
# graph/schema.resolvers.go
# server.go
# gqlgen.yml
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

autobind:
  - "github.com/myorg/graphql-api/internal/domain"

models:
  ID:
    model:
      - github.com/99designs/gqlgen/graphql/introspection.ID
  DateTime:
    model:
      - github.com/99designs/gqlgen/graphql.String
```

## Section 2: Schema Design

### graph/schema.graphqls

```graphql
scalar DateTime
scalar JSON

directive @auth(requires: Role = USER) on FIELD_DEFINITION
directive @hasRole(roles: [Role!]!) on FIELD_DEFINITION
directive @deprecated(reason: String = "No longer supported") on FIELD_DEFINITION | ENUM_VALUE

enum Role {
  ADMIN
  OPERATOR
  USER
  GUEST
}

type Query {
  # Order queries
  order(id: ID!): Order
  orders(
    filter: OrderFilter
    pagination: PaginationInput
    sort: OrderSort
  ): OrderConnection! @auth

  # User queries
  me: User @auth
  user(id: ID!): User @hasRole(roles: [ADMIN])
  users(filter: UserFilter, pagination: PaginationInput): UserConnection! @hasRole(roles: [ADMIN])

  # Product queries
  product(id: ID!): Product
  products(filter: ProductFilter, pagination: PaginationInput): ProductConnection!
}

type Mutation {
  createOrder(input: CreateOrderInput!): CreateOrderPayload! @auth
  updateOrderStatus(id: ID!, status: OrderStatus!): UpdateOrderPayload! @hasRole(roles: [ADMIN, OPERATOR])
  cancelOrder(id: ID!, reason: String): CancelOrderPayload! @auth

  createProduct(input: CreateProductInput!): CreateProductPayload! @hasRole(roles: [ADMIN])
  updateProduct(id: ID!, input: UpdateProductInput!): UpdateProductPayload! @hasRole(roles: [ADMIN])
}

type Subscription {
  orderStatusChanged(orderId: ID!): OrderStatusEvent! @auth
  newOrdersForOperator: Order! @hasRole(roles: [ADMIN, OPERATOR])
}

# --- Types ---

type Order {
  id: ID!
  status: OrderStatus!
  customer: User!
  items: [OrderItem!]!
  subtotal: Float!
  tax: Float!
  total: Float!
  createdAt: DateTime!
  updatedAt: DateTime!
  events: [OrderEvent!]!
}

type OrderItem {
  id: ID!
  product: Product!
  quantity: Int!
  unitPrice: Float!
  lineTotal: Float!
}

type OrderEvent {
  id: ID!
  status: OrderStatus!
  note: String
  createdAt: DateTime!
  createdBy: User!
}

type OrderStatusEvent {
  orderId: ID!
  status: OrderStatus!
  previousStatus: OrderStatus!
  occurredAt: DateTime!
}

type User {
  id: ID!
  email: String!
  name: String!
  role: Role!
  orders(pagination: PaginationInput): OrderConnection! @auth
  createdAt: DateTime!
}

type Product {
  id: ID!
  sku: String!
  name: String!
  description: String
  price: Float!
  inventory: Int! @hasRole(roles: [ADMIN, OPERATOR])
  category: Category!
  createdAt: DateTime!
}

type Category {
  id: ID!
  name: String!
  products(pagination: PaginationInput): ProductConnection!
}

# --- Connection types (Relay pagination) ---

type OrderConnection {
  edges: [OrderEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type OrderEdge {
  node: Order!
  cursor: String!
}

type ProductConnection {
  edges: [ProductEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type ProductEdge {
  node: Product!
  cursor: String!
}

type UserConnection {
  edges: [UserEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type UserEdge {
  node: User!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

# --- Enums ---

enum OrderStatus {
  PENDING
  CONFIRMED
  PROCESSING
  SHIPPED
  DELIVERED
  CANCELLED
  REFUNDED
}

# --- Inputs ---

input CreateOrderInput {
  items: [OrderItemInput!]!
  shippingAddressId: ID!
  paymentMethodId: ID!
  note: String
}

input OrderItemInput {
  productId: ID!
  quantity: Int!
}

input OrderFilter {
  status: [OrderStatus!]
  customerId: ID
  createdAfter: DateTime
  createdBefore: DateTime
  minTotal: Float
  maxTotal: Float
}

input OrderSort {
  field: OrderSortField!
  direction: SortDirection!
}

enum OrderSortField {
  CREATED_AT
  UPDATED_AT
  TOTAL
  STATUS
}

enum SortDirection {
  ASC
  DESC
}

input PaginationInput {
  first: Int
  after: String
  last: Int
  before: String
}

input UserFilter {
  email: String
  role: Role
  createdAfter: DateTime
}

input ProductFilter {
  categoryId: ID
  minPrice: Float
  maxPrice: Float
  inStock: Boolean
}

input CreateProductInput {
  sku: String!
  name: String!
  description: String
  price: Float!
  inventory: Int!
  categoryId: ID!
}

input UpdateProductInput {
  name: String
  description: String
  price: Float
  inventory: Int
}

# --- Payloads ---

type CreateOrderPayload {
  order: Order
  errors: [UserError!]!
}

type UpdateOrderPayload {
  order: Order
  errors: [UserError!]!
}

type CancelOrderPayload {
  order: Order
  errors: [UserError!]!
}

type CreateProductPayload {
  product: Product
  errors: [UserError!]!
}

type UpdateProductPayload {
  product: Product
  errors: [UserError!]!
}

type UserError {
  field: [String!]
  message: String!
  code: String!
}
```

```bash
# Regenerate after schema changes
go run github.com/99designs/gqlgen generate
```

## Section 3: DataLoader Implementation

Without DataLoaders, fetching a list of orders with their customers produces N+1 queries:

```
Query orders -> N orders returned
For each order -> Query user (N queries) -- N+1 problem!
```

DataLoader batches and caches these queries:

```
Query orders -> N orders returned
DataLoader batches all N userIDs -> 1 query for all users
```

### Installation

```bash
go get github.com/vikstrous/dataloadgen@latest
```

### internal/dataloader/loaders.go

```go
package dataloader

import (
	"context"
	"time"

	"github.com/vikstrous/dataloadgen"

	"github.com/myorg/graphql-api/internal/domain"
	"github.com/myorg/graphql-api/internal/store"
)

type contextKey string

const loadersKey contextKey = "dataloaders"

// Loaders holds all DataLoader instances for a request
type Loaders struct {
	UserByID    *dataloadgen.Loader[string, *domain.User]
	ProductByID *dataloadgen.Loader[string, *domain.Product]
	CategoryByID *dataloadgen.Loader[string, *domain.Category]
	OrdersByUserID *dataloadgen.Loader[string, []*domain.Order]
}

func NewLoaders(db *store.Store) *Loaders {
	return &Loaders{
		UserByID: dataloadgen.NewLoader(
			func(ctx context.Context, ids []string) ([]*domain.User, []error) {
				return batchLoadUsers(ctx, db, ids)
			},
			dataloadgen.WithWait(2*time.Millisecond),
			dataloadgen.WithBatchCapacity(100),
		),
		ProductByID: dataloadgen.NewLoader(
			func(ctx context.Context, ids []string) ([]*domain.Product, []error) {
				return batchLoadProducts(ctx, db, ids)
			},
			dataloadgen.WithWait(2*time.Millisecond),
			dataloadgen.WithBatchCapacity(100),
		),
		CategoryByID: dataloadgen.NewLoader(
			func(ctx context.Context, ids []string) ([]*domain.Category, []error) {
				return batchLoadCategories(ctx, db, ids)
			},
			dataloadgen.WithWait(2*time.Millisecond),
		),
		OrdersByUserID: dataloadgen.NewLoader(
			func(ctx context.Context, userIDs []string) ([][]*domain.Order, []error) {
				return batchLoadOrdersByUser(ctx, db, userIDs)
			},
			dataloadgen.WithWait(2*time.Millisecond),
		),
	}
}

func Middleware(db *store.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			loaders := NewLoaders(db)
			ctx := context.WithValue(r.Context(), loadersKey, loaders)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func For(ctx context.Context) *Loaders {
	return ctx.Value(loadersKey).(*Loaders)
}

// --- Batch functions ---

func batchLoadUsers(ctx context.Context, db *store.Store, ids []string) ([]*domain.User, []error) {
	users, err := db.GetUsersByIDs(ctx, ids)
	if err != nil {
		errs := make([]error, len(ids))
		for i := range errs {
			errs[i] = err
		}
		return nil, errs
	}

	// Map users by ID for ordered return
	userMap := make(map[string]*domain.User, len(users))
	for _, u := range users {
		userMap[u.ID] = u
	}

	result := make([]*domain.User, len(ids))
	errs := make([]error, len(ids))
	for i, id := range ids {
		if user, ok := userMap[id]; ok {
			result[i] = user
		} else {
			errs[i] = fmt.Errorf("user %q not found", id)
		}
	}
	return result, errs
}

func batchLoadProducts(ctx context.Context, db *store.Store, ids []string) ([]*domain.Product, []error) {
	products, err := db.GetProductsByIDs(ctx, ids)
	if err != nil {
		errs := make([]error, len(ids))
		for i := range errs {
			errs[i] = err
		}
		return nil, errs
	}

	productMap := make(map[string]*domain.Product, len(products))
	for _, p := range products {
		productMap[p.ID] = p
	}

	result := make([]*domain.Product, len(ids))
	errs := make([]error, len(ids))
	for i, id := range ids {
		if product, ok := productMap[id]; ok {
			result[i] = product
		} else {
			errs[i] = fmt.Errorf("product %q not found", id)
		}
	}
	return result, errs
}

func batchLoadOrdersByUser(
	ctx context.Context,
	db *store.Store,
	userIDs []string,
) ([][]*domain.Order, []error) {
	// Single query: SELECT * FROM orders WHERE user_id IN (...)
	ordersByUser, err := db.GetOrdersByUserIDs(ctx, userIDs)
	if err != nil {
		errs := make([]error, len(userIDs))
		for i := range errs {
			errs[i] = err
		}
		return nil, errs
	}

	result := make([][]*domain.Order, len(userIDs))
	for i, userID := range userIDs {
		result[i] = ordersByUser[userID]
		if result[i] == nil {
			result[i] = []*domain.Order{}
		}
	}
	return result, make([]error, len(userIDs))
}
```

### Using DataLoaders in Resolvers

```go
// graph/resolver.go

// OrderResolver — Order.customer field
func (r *orderResolver) Customer(ctx context.Context, obj *domain.Order) (*domain.User, error) {
	// Uses DataLoader: batches all customer lookups in a single DB query
	return dataloader.For(ctx).UserByID.Load(ctx, obj.CustomerID)
}

// OrderItemResolver — OrderItem.product field
func (r *orderItemResolver) Product(ctx context.Context, obj *domain.OrderItem) (*domain.Product, error) {
	return dataloader.For(ctx).ProductByID.Load(ctx, obj.ProductID)
}

// UserResolver — User.orders field
func (r *userResolver) Orders(
	ctx context.Context,
	obj *domain.User,
	pagination *model.PaginationInput,
) (*model.OrderConnection, error) {
	orders, err := dataloader.For(ctx).OrdersByUserID.Load(ctx, obj.ID)
	if err != nil {
		return nil, err
	}
	return toOrderConnection(orders, pagination), nil
}
```

## Section 4: Authorization Directives

### internal/directives/auth.go

```go
package directives

import (
	"context"
	"fmt"

	"github.com/99designs/gqlgen/graphql"
	"github.com/vektah/gqlparser/v2/gqlerror"

	"github.com/myorg/graphql-api/internal/auth"
)

// AuthDirective implements @auth
func Auth(ctx context.Context, obj any, next graphql.Resolver, requires model.Role) (any, error) {
	user := auth.UserFromContext(ctx)
	if user == nil {
		return nil, &gqlerror.Error{
			Message: "authentication required",
			Extensions: map[string]any{
				"code": "UNAUTHENTICATED",
			},
		}
	}

	// Check minimum role
	if !hasMinimumRole(user.Role, requires) {
		return nil, &gqlerror.Error{
			Message: fmt.Sprintf("requires %s role", requires),
			Extensions: map[string]any{
				"code": "FORBIDDEN",
			},
		}
	}

	return next(ctx)
}

// HasRoleDirective implements @hasRole
func HasRole(ctx context.Context, obj any, next graphql.Resolver, roles []model.Role) (any, error) {
	user := auth.UserFromContext(ctx)
	if user == nil {
		return nil, &gqlerror.Error{
			Message: "authentication required",
			Extensions: map[string]any{"code": "UNAUTHENTICATED"},
		}
	}

	for _, role := range roles {
		if user.Role == role {
			return next(ctx)
		}
	}

	return nil, &gqlerror.Error{
		Message: "insufficient permissions",
		Extensions: map[string]any{
			"code":           "FORBIDDEN",
			"requiredRoles":  roles,
			"currentRole":    user.Role,
		},
	}
}

func hasMinimumRole(userRole, requiredRole model.Role) bool {
	roleOrder := map[model.Role]int{
		model.RoleGuest:    0,
		model.RoleUser:     1,
		model.RoleOperator: 2,
		model.RoleAdmin:    3,
	}
	return roleOrder[userRole] >= roleOrder[requiredRole]
}
```

### JWT Middleware for Context

```go
package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const userKey contextKey = "user"

type Claims struct {
	UserID string `json:"sub"`
	Email  string `json:"email"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

type User struct {
	ID    string
	Email string
	Role  model.Role
}

func Middleware(jwtSecret []byte) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := extractBearerToken(r)
			if token == "" {
				next.ServeHTTP(w, r)
				return
			}

			claims, err := validateToken(token, jwtSecret)
			if err != nil {
				// Invalid token — proceed without user (auth directives will reject)
				next.ServeHTTP(w, r)
				return
			}

			user := &User{
				ID:    claims.UserID,
				Email: claims.Email,
				Role:  model.Role(claims.Role),
			}

			ctx := context.WithValue(r.Context(), userKey, user)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func UserFromContext(ctx context.Context) *User {
	user, _ := ctx.Value(userKey).(*User)
	return user
}

func extractBearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(auth, "Bearer ")
}

func validateToken(tokenStr string, secret []byte) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{},
		func(token *jwt.Token) (any, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			return secret, nil
		},
	)
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}
```

### Registering Directives in Server

```go
// graph/schema.resolvers.go — server setup

func NewSchema(resolvers *Resolver, db *store.Store) graphql.ExecutableSchema {
	return generated.NewExecutableSchema(generated.Config{
		Resolvers: resolvers,
		Directives: generated.DirectiveRoot{
			Auth:    directives.Auth,
			HasRole: directives.HasRole,
		},
		Complexity: generated.ComplexityRoot{
			Query: generated.QueryComplexity{
				Orders: func(childComplexity int, filter *model.OrderFilter, pagination *model.PaginationInput, sort *model.OrderSort) int {
					return childComplexity * 10  // Orders query is expensive
				},
			},
		},
	})
}
```

## Section 5: Subscriptions with WebSockets

### graph/subscriptions.go

```go
package graph

import (
	"context"
	"fmt"
	"sync"
)

// OrderStatusBus manages subscription channels for order status events
type OrderStatusBus struct {
	mu          sync.RWMutex
	subscribers map[string]map[string]chan *model.OrderStatusEvent
}

func NewOrderStatusBus() *OrderStatusBus {
	return &OrderStatusBus{
		subscribers: make(map[string]map[string]chan *model.OrderStatusEvent),
	}
}

func (b *OrderStatusBus) Subscribe(orderID string) (string, <-chan *model.OrderStatusEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()

	subID := generateID()
	ch := make(chan *model.OrderStatusEvent, 10)

	if b.subscribers[orderID] == nil {
		b.subscribers[orderID] = make(map[string]chan *model.OrderStatusEvent)
	}
	b.subscribers[orderID][subID] = ch

	return subID, ch
}

func (b *OrderStatusBus) Unsubscribe(orderID, subID string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if subs, ok := b.subscribers[orderID]; ok {
		if ch, ok := subs[subID]; ok {
			close(ch)
			delete(subs, subID)
		}
	}
}

func (b *OrderStatusBus) Publish(event *model.OrderStatusEvent) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if subs, ok := b.subscribers[event.OrderID]; ok {
		for _, ch := range subs {
			select {
			case ch <- event:
			default:
				// Subscriber is slow, drop event
			}
		}
	}
}

// OperatorBus broadcasts new orders to operator subscribers
type OperatorBus struct {
	mu          sync.RWMutex
	subscribers map[string]chan *domain.Order
}

func NewOperatorBus() *OperatorBus {
	return &OperatorBus{
		subscribers: make(map[string]chan *domain.Order),
	}
}

func (b *OperatorBus) Subscribe() (string, <-chan *domain.Order) {
	b.mu.Lock()
	defer b.mu.Unlock()

	subID := generateID()
	ch := make(chan *domain.Order, 50)
	b.subscribers[subID] = ch
	return subID, ch
}

func (b *OperatorBus) Unsubscribe(subID string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if ch, ok := b.subscribers[subID]; ok {
		close(ch)
		delete(b.subscribers, subID)
	}
}

func (b *OperatorBus) Publish(order *domain.Order) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, ch := range b.subscribers {
		select {
		case ch <- order:
		default:
		}
	}
}
```

### Subscription Resolvers

```go
// graph/schema.resolvers.go

// OrderStatusChanged subscription resolver
func (r *subscriptionResolver) OrderStatusChanged(
	ctx context.Context,
	orderID string,
) (<-chan *model.OrderStatusEvent, error) {
	// Verify the order exists and the user has access
	user := auth.UserFromContext(ctx)
	order, err := r.store.GetOrder(ctx, orderID)
	if err != nil {
		return nil, err
	}
	if order.CustomerID != user.ID && user.Role != model.RoleAdmin {
		return nil, fmt.Errorf("access denied")
	}

	subID, eventCh := r.orderBus.Subscribe(orderID)

	// Clean up subscription when client disconnects
	go func() {
		<-ctx.Done()
		r.orderBus.Unsubscribe(orderID, subID)
	}()

	// Convert domain channel to model channel
	modelCh := make(chan *model.OrderStatusEvent, 10)
	go func() {
		defer close(modelCh)
		for event := range eventCh {
			select {
			case <-ctx.Done():
				return
			case modelCh <- event:
			}
		}
	}()

	return modelCh, nil
}

// NewOrdersForOperator subscription resolver
func (r *subscriptionResolver) NewOrdersForOperator(
	ctx context.Context,
) (<-chan *domain.Order, error) {
	subID, orderCh := r.operatorBus.Subscribe()

	go func() {
		<-ctx.Done()
		r.operatorBus.Unsubscribe(subID)
	}()

	return orderCh, nil
}
```

### WebSocket Transport Setup

```go
// server.go

import (
	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/transport"
	"github.com/99designs/gqlgen/graphql/playground"
	"github.com/gorilla/websocket"
)

func main() {
	schema := graph.NewSchema(resolvers, db)

	srv := handler.New(schema)

	// Add transports
	srv.AddTransport(transport.Options{})
	srv.AddTransport(transport.GET{})
	srv.AddTransport(transport.POST{})
	srv.AddTransport(transport.MultipartForm{})
	srv.AddTransport(transport.Websocket{
		KeepAlivePingInterval: 10 * time.Second,
		Upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Validate origin for production
				origin := r.Header.Get("Origin")
				return isAllowedOrigin(origin)
			},
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
		},
		InitFunc: func(ctx context.Context, initPayload transport.InitPayload) (context.Context, *transport.InitPayload, error) {
			// Extract and validate JWT from WebSocket init payload
			token := initPayload.GetString("Authorization")
			if token != "" {
				claims, err := auth.ValidateToken(
					strings.TrimPrefix(token, "Bearer "),
					jwtSecret,
				)
				if err == nil {
					user := &auth.User{
						ID:    claims.UserID,
						Email: claims.Email,
						Role:  model.Role(claims.Role),
					}
					ctx = auth.WithUser(ctx, user)
				}
			}
			return ctx, &initPayload, nil
		},
	})

	// Cache for query planning
	srv.SetQueryCache(lru.New[*ast.QueryDocument](1000))

	// Complexity limit
	srv.Use(extension.FixedComplexityLimit(1000))

	// Introspection (disable in production)
	if os.Getenv("APP_ENV") != "production" {
		srv.Use(extension.Introspection{})
	}

	// Apollo Tracing for performance analysis
	srv.Use(extension.AutomaticPersistedQuery{
		Cache: lru.New[string](100),
	})

	mux := http.NewServeMux()
	mux.Handle("/query", dataloader.Middleware(db)(auth.Middleware(jwtSecret)(srv)))
	mux.Handle("/playground", playground.Handler("GraphQL", "/query"))

	log.Fatal(http.ListenAndServe(":8080", mux))
}
```

## Section 6: Query Complexity and Rate Limiting

### Complexity Configuration

```go
// graph/complexity.go

func ComplexityRoot() generated.ComplexityRoot {
	var c generated.ComplexityRoot

	c.Query.Orders = func(childComplexity int, _ *model.OrderFilter, pagination *model.PaginationInput, _ *model.OrderSort) int {
		n := 10  // default page size
		if pagination != nil && pagination.First != nil {
			n = *pagination.First
		}
		return n * childComplexity
	}

	c.Query.Users = func(childComplexity int, _ *model.UserFilter, pagination *model.PaginationInput) int {
		n := 10
		if pagination != nil && pagination.First != nil {
			n = *pagination.First
		}
		return n * childComplexity
	}

	c.Order.Events = func(childComplexity int) int {
		return childComplexity * 10  // Events sub-query is expensive
	}

	c.Order.Items = func(childComplexity int) int {
		return childComplexity * 5
	}

	return c
}
```

### Rate Limiting Middleware

```go
package middleware

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

type RateLimiter struct {
	rdb    *redis.Client
	limit  int
	window time.Duration
}

func NewRateLimiter(rdb *redis.Client, limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{rdb: rdb, limit: limit, window: window}
}

func (rl *RateLimiter) GraphQLMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := auth.UserFromContext(r.Context())

		var key string
		if user != nil {
			key = fmt.Sprintf("ratelimit:gql:user:%s", user.ID)
		} else {
			key = fmt.Sprintf("ratelimit:gql:ip:%s", r.RemoteAddr)
		}

		allowed, remaining, err := rl.check(r.Context(), key)
		if err != nil {
			// On Redis error, allow request (fail open)
			next.ServeHTTP(w, r)
			return
		}

		w.Header().Set("X-RateLimit-Limit", fmt.Sprintf("%d", rl.limit))
		w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", remaining))

		if !allowed {
			w.Header().Set("Retry-After", "60")
			http.Error(w, `{"errors":[{"message":"rate limit exceeded"}]}`, http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (rl *RateLimiter) check(ctx context.Context, key string) (allowed bool, remaining int, err error) {
	pipe := rl.rdb.Pipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, rl.window)

	if _, err := pipe.Exec(ctx); err != nil {
		return true, rl.limit, err
	}

	count := int(incr.Val())
	if count > rl.limit {
		return false, 0, nil
	}
	return true, rl.limit - count, nil
}
```

## Section 7: Error Handling

### Structured Error Responses

```go
package graph

import (
	"context"
	"errors"

	"github.com/99designs/gqlgen/graphql"
	"github.com/vektah/gqlparser/v2/gqlerror"

	"github.com/myorg/graphql-api/internal/domain"
)

// ErrorPresenter converts internal errors to GraphQL errors
func ErrorPresenter(ctx context.Context, err error) *gqlerror.Error {
	var notFound *domain.NotFoundError
	var validationErr *domain.ValidationError
	var conflictErr *domain.ConflictError

	switch {
	case errors.As(err, &notFound):
		return &gqlerror.Error{
			Message: err.Error(),
			Extensions: map[string]any{
				"code": "NOT_FOUND",
				"id":   notFound.ID,
				"type": notFound.Type,
			},
		}
	case errors.As(err, &validationErr):
		return &gqlerror.Error{
			Message: err.Error(),
			Extensions: map[string]any{
				"code":   "VALIDATION_ERROR",
				"fields": validationErr.Fields,
			},
		}
	case errors.As(err, &conflictErr):
		return &gqlerror.Error{
			Message: err.Error(),
			Extensions: map[string]any{
				"code": "CONFLICT",
			},
		}
	default:
		// Log internal errors but don't expose details
		slog.ErrorContext(ctx, "internal GraphQL error", "error", err)
		return &gqlerror.Error{
			Message: "internal server error",
			Extensions: map[string]any{
				"code": "INTERNAL_ERROR",
			},
		}
	}
}

// RecoverFunc handles panics in resolvers
func RecoverFunc(ctx context.Context, err any) error {
	slog.ErrorContext(ctx, "resolver panic recovered",
		"panic", fmt.Sprintf("%v", err),
		"stack", string(debug.Stack()),
	)
	return fmt.Errorf("internal server error")
}
```

## Section 8: Observability

### Tracing Resolver Execution

```go
package middleware

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"github.com/99designs/gqlgen/graphql"
)

type TracingExtension struct{}

var _ interface {
	graphql.HandlerExtension
	graphql.OperationInterceptor
	graphql.FieldInterceptor
} = TracingExtension{}

func (TracingExtension) ExtensionName() string { return "OpenTelemetryTracing" }
func (TracingExtension) Validate(schema graphql.ExecutableSchema) error { return nil }

func (t TracingExtension) InterceptOperation(
	ctx context.Context,
	next graphql.OperationHandler,
) graphql.ResponseHandler {
	oc := graphql.GetOperationContext(ctx)

	tracer := otel.Tracer("graphql")
	ctx, span := tracer.Start(ctx, "graphql."+string(oc.Operation.Operation))
	span.SetAttributes(
		attribute.String("graphql.operation.name", oc.OperationName),
		attribute.String("graphql.document", oc.RawQuery),
	)

	return func(ctx context.Context) *graphql.Response {
		resp := next(ctx)
		if resp != nil && len(resp.Errors) > 0 {
			span.SetAttributes(attribute.Bool("error", true))
		}
		span.End()
		return resp
	}
}

func (t TracingExtension) InterceptField(
	ctx context.Context,
	next graphql.Resolver,
) (any, error) {
	fc := graphql.GetFieldContext(ctx)

	tracer := otel.Tracer("graphql")
	ctx, span := tracer.Start(ctx, "graphql.field."+fc.Field.Name)
	span.SetAttributes(
		attribute.String("graphql.field.path", fc.Path().String()),
		attribute.String("graphql.field.type", fc.Field.Definition.Type.String()),
	)
	defer span.End()

	res, err := next(ctx)
	if err != nil {
		span.RecordError(err)
	}
	return res, err
}
```

## Section 9: Testing GraphQL Resolvers

```go
package graph_test

import (
	"testing"

	"github.com/99designs/gqlgen/client"
	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/myorg/graphql-api/graph"
	"github.com/myorg/graphql-api/internal/store/teststore"
)

func setupTestServer(t *testing.T) *client.Client {
	t.Helper()

	store := teststore.New()
	resolvers := &graph.Resolver{Store: store}
	schema := graph.NewSchema(resolvers, store)

	srv := handler.NewDefaultServer(schema)
	return client.New(srv)
}

func TestCreateOrder(t *testing.T) {
	c := setupTestServer(t)

	var resp struct {
		CreateOrder struct {
			Order struct {
				ID     string
				Status string
			}
			Errors []struct {
				Message string
				Code    string
			}
		}
	}

	err := c.Post(`
		mutation CreateOrder($input: CreateOrderInput!) {
			createOrder(input: $input) {
				order {
					id
					status
				}
				errors {
					message
					code
				}
			}
		}
	`, &resp,
		client.Var("input", map[string]any{
			"items": []map[string]any{
				{"productId": "prod-001", "quantity": 2},
			},
			"shippingAddressId": "addr-001",
			"paymentMethodId":   "pm-001",
		}),
		// Inject auth context
		client.AddHeader("Authorization", "Bearer "+generateTestToken("user-001", "USER")),
	)

	require.NoError(t, err)
	assert.NotEmpty(t, resp.CreateOrder.Order.ID)
	assert.Equal(t, "PENDING", resp.CreateOrder.Order.Status)
	assert.Empty(t, resp.CreateOrder.Errors)
}

func TestQueryComplexityLimit(t *testing.T) {
	c := setupTestServer(t)

	var resp any
	// This deeply nested query should exceed complexity limit
	err := c.Post(`
		query {
			orders(pagination: {first: 100}) {
				edges {
					node {
						customer {
							orders(pagination: {first: 100}) {
								edges {
									node {
										items {
											product {
												category {
													products(pagination: {first: 100}) {
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
		}
	`, &resp,
		client.AddHeader("Authorization", "Bearer "+generateTestToken("user-001", "USER")),
	)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "complexity")
}
```

## Section 10: Production Deployment

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: graphql-api
  namespace: production
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: graphql-api
        image: graphql-api:v2.3.1
        ports:
        - name: http
          containerPort: 8080
        env:
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: graphql-api-secrets
              key: jwt-secret
        - name: REDIS_ADDR
          value: "redis-cluster:6379"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: graphql-api-secrets
              key: database-url
        - name: APP_ENV
          value: "production"
        # Disable playground in production
        - name: GRAPHQL_PLAYGROUND
          value: "false"
        - name: QUERY_COMPLEXITY_LIMIT
          value: "1000"
        - name: RATE_LIMIT_PER_USER
          value: "100"
        - name: RATE_LIMIT_WINDOW_SECONDS
          value: "60"
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          periodSeconds: 5
        resources:
          requests:
            cpu: "500m"
            memory: "256Mi"
          limits:
            cpu: "2"
            memory: "1Gi"
```

### Key Production Checklist

```bash
# Verify introspection is disabled
curl -X POST http://graphql-api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "{ __schema { types { name } } }"}' | \
  jq '.errors[0].message'
# Should return: "introspection disabled"

# Verify complexity limit works
curl -X POST http://graphql-api/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ orders(pagination:{first:100}) { edges { node { customer { orders(pagination:{first:100}) { edges { node { id } } } } } } } }"}' | \
  jq '.errors[0].extensions.code'
# Should return: "COMPLEXITY_LIMIT_EXCEEDED"
```

The gqlgen schema-first approach combined with DataLoaders eliminates the N+1 problem, while field-level authorization directives keep security logic co-located with the schema definition. This architecture scales to thousands of concurrent WebSocket subscription connections with proper channel management and backpressure.
