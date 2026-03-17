---
title: "GraphQL Server Patterns in Go: gqlgen, DataLoaders, and Production Hardening"
date: 2028-04-01T00:00:00-05:00
draft: false
tags: ["Go", "GraphQL", "gqlgen", "DataLoader", "Production", "API", "Federation"]
categories: ["Go", "API Design"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade GraphQL server patterns in Go using gqlgen including schema-first development, DataLoader pattern for N+1 prevention, query complexity analysis, persisted queries, WebSocket subscriptions, Apollo Federation subgraphs, per-field rate limiting, and production hardening."
more_link: "yes"
url: "/go-graphql-server-patterns-guide/"
---

GraphQL servers in Go face a distinct set of production challenges compared to REST APIs. The flexible query model that makes GraphQL attractive to clients also enables dangerous queries that can overwhelm backends. N+1 query problems, deeply nested queries, and unbounded field expansion require deliberate mitigation. This guide covers production-hardened gqlgen patterns that address these concerns while maintaining the developer experience that makes GraphQL worthwhile.

<!--more-->

## Schema-First Development with gqlgen

gqlgen generates type-safe Go code from a GraphQL schema, ensuring that resolver implementations match the schema contract at compile time.

### Schema Definition

```graphql
# schema.graphql

type Query {
  user(id: ID!): User
  users(filter: UserFilter, page: PageInput): UserConnection!
  order(id: ID!): Order
  orders(userId: ID!, status: OrderStatus): [Order!]!
}

type Mutation {
  createOrder(input: CreateOrderInput!): CreateOrderPayload!
  updateOrderStatus(id: ID!, status: OrderStatus!): Order!
  cancelOrder(id: ID!, reason: String): CancelOrderPayload!
}

type Subscription {
  orderStatusChanged(orderId: ID!): OrderStatusEvent!
  userNotifications(userId: ID!): Notification!
}

type User {
  id: ID!
  email: String!
  name: String!
  orders(status: OrderStatus, limit: Int = 10): [Order!]!
  createdAt: Time!
}

type Order {
  id: ID!
  user: User!
  items: [OrderItem!]!
  totalAmount: Float!
  status: OrderStatus!
  createdAt: Time!
  updatedAt: Time!
}

type OrderItem {
  id: ID!
  product: Product!
  quantity: Int!
  unitPrice: Float!
}

type Product {
  id: ID!
  name: String!
  description: String
  price: Float!
  inventory: Int!
}

enum OrderStatus {
  PENDING
  CONFIRMED
  SHIPPED
  DELIVERED
  CANCELLED
}

input CreateOrderInput {
  items: [OrderItemInput!]!
  shippingAddress: AddressInput!
}

input OrderItemInput {
  productId: ID!
  quantity: Int!
}

type CreateOrderPayload {
  order: Order
  userErrors: [UserError!]!
}

type UserError {
  field: [String!]!
  message: String!
}

input UserFilter {
  email: String
  createdAfter: Time
  createdBefore: Time
}

input PageInput {
  first: Int
  after: String
  last: Int
  before: String
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

scalar Time
```

### gqlgen Configuration

```yaml
# gqlgen.yml
schema:
  - schema.graphql
  - schema/*.graphql

exec:
  filename: graph/generated.go
  package: graph

model:
  filename: graph/model/models_gen.go
  package: model

resolver:
  layout: follow-schema
  dir: graph/resolver
  package: resolver

autobind:
  - github.com/example/api/internal/domain

models:
  Time:
    model: github.com/99designs/gqlgen/graphql/introspection.Time
  ID:
    model:
      - github.com/99designs/gqlgen/graphql/introspection.ID
      - github.com/google/uuid.UUID
```

```bash
# Generate code from schema
go run github.com/99designs/gqlgen generate
```

## Resolver Context Propagation

Every resolver receives a context. Production resolvers use that context to carry authentication, request tracing, and DataLoader state:

```go
package resolver

import (
    "context"
    "fmt"

    "github.com/google/uuid"
    "github.com/example/api/graph/model"
    "github.com/example/api/internal/auth"
    "github.com/example/api/internal/dataloader"
)

// Resolver is the root resolver type.
type Resolver struct {
    db          *database.DB
    cache       *redis.Client
    loaders     *dataloader.Loaders
    rateLimiter *ratelimit.Limiter
}

// QueryResolver implements the GraphQL Query type.
type queryResolver struct{ *Resolver }

func (r *queryResolver) User(ctx context.Context, id string) (*model.User, error) {
    // 1. Verify authentication from context
    principal, err := auth.FromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("authentication required")
    }

    // 2. Authorization check
    userID, err := uuid.Parse(id)
    if err != nil {
        return nil, fmt.Errorf("invalid user ID format")
    }

    if !principal.CanViewUser(userID) {
        return nil, fmt.Errorf("access denied")
    }

    // 3. Use DataLoader for batched loading
    user, err := r.loaders.UserByID.Load(ctx, userID)
    if err != nil {
        if database.IsNotFound(err) {
            return nil, nil  // GraphQL convention: null for not found
        }
        return nil, fmt.Errorf("load user: %w", err)
    }

    return user, nil
}

// Orders is a field resolver on the User type — called for each User in the response.
// Without DataLoader, this causes N+1 queries.
func (r *userResolver) Orders(ctx context.Context, user *model.User,
    status *model.OrderStatus, limit *int) ([]*model.Order, error) {

    // DataLoader batches all order requests for a set of users into one query
    orders, err := r.loaders.OrdersByUserID.Load(ctx, user.ID)
    if err != nil {
        return nil, fmt.Errorf("load orders for user %s: %w", user.ID, err)
    }

    // Apply filters in-memory after loading
    if status != nil {
        filtered := make([]*model.Order, 0, len(orders))
        for _, o := range orders {
            if o.Status == *status {
                filtered = append(filtered, o)
            }
        }
        orders = filtered
    }

    maxResults := 10
    if limit != nil && *limit > 0 {
        maxResults = *limit
    }

    if len(orders) > maxResults {
        orders = orders[:maxResults]
    }

    return orders, nil
}
```

## DataLoader Pattern: N+1 Prevention

The N+1 query problem is the most common performance issue in GraphQL APIs. When loading a list of 100 users, each with an `orders` field, a naive implementation issues 101 database queries (1 for users + 100 for their orders). DataLoader batches these into 2 queries.

```go
package dataloader

import (
    "context"
    "time"

    "github.com/vikstrous/dataloadgen"
    "github.com/google/uuid"
    "github.com/example/api/graph/model"
    "github.com/example/api/internal/database"
)

// Loaders holds all DataLoaders for a request.
// A new Loaders is created per request to ensure cache isolation.
type Loaders struct {
    UserByID       *dataloadgen.Loader[uuid.UUID, *model.User]
    OrdersByUserID *dataloadgen.Loader[uuid.UUID, []*model.Order]
    ProductByID    *dataloadgen.Loader[uuid.UUID, *model.Product]
}

func NewLoaders(db *database.DB) *Loaders {
    return &Loaders{
        UserByID: dataloadgen.NewLoader(
            newUserLoader(db),
            dataloadgen.WithBatchCapacity(100),
            dataloadgen.WithWait(2*time.Millisecond),
        ),
        OrdersByUserID: dataloadgen.NewLoader(
            newOrdersByUserLoader(db),
            dataloadgen.WithBatchCapacity(100),
            dataloadgen.WithWait(2*time.Millisecond),
        ),
        ProductByID: dataloadgen.NewLoader(
            newProductLoader(db),
            dataloadgen.WithBatchCapacity(200),
            dataloadgen.WithWait(1*time.Millisecond),
        ),
    }
}

// newUserLoader returns a batch function that loads users by IDs.
func newUserLoader(db *database.DB) func(ctx context.Context, ids []uuid.UUID) ([]*model.User, []error) {
    return func(ctx context.Context, ids []uuid.UUID) ([]*model.User, []error) {
        // Single query for all IDs in the batch
        users, err := db.GetUsersByIDs(ctx, ids)
        if err != nil {
            // Return the error for all keys in the batch
            errs := make([]error, len(ids))
            for i := range errs {
                errs[i] = err
            }
            return nil, errs
        }

        // Build a map for O(1) lookup
        userMap := make(map[uuid.UUID]*model.User, len(users))
        for _, u := range users {
            userMap[u.ID] = u
        }

        // Return results in the same order as input IDs
        results := make([]*model.User, len(ids))
        errs := make([]error, len(ids))
        for i, id := range ids {
            if u, ok := userMap[id]; ok {
                results[i] = u
            } else {
                errs[i] = database.ErrNotFound
            }
        }

        return results, errs
    }
}

// Middleware injects DataLoaders into the request context.
func Middleware(db *database.DB) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            loaders := NewLoaders(db)
            ctx := context.WithValue(r.Context(), loadersKey{}, loaders)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

type loadersKey struct{}

func FromContext(ctx context.Context) *Loaders {
    loaders, _ := ctx.Value(loadersKey{}).(*Loaders)
    return loaders
}
```

## Query Complexity Analysis

GraphQL queries can be arbitrarily nested, enabling denial-of-service attacks through deeply nested queries:

```graphql
# Potentially expensive: products → orders → user → orders → products → ...
query {
  users {
    orders {
      items {
        product {
          orders {
            items {
              product {
                orders { id }
              }
            }
          }
        }
      }
    }
  }
}
```

gqlgen integrates with the `complexity` package:

```go
package server

import (
    "github.com/99designs/gqlgen/graphql/handler"
    "github.com/99designs/gqlgen/graphql/handler/extension"
    "github.com/example/api/graph"
    "github.com/example/api/graph/generated"
)

func NewGraphQLServer(resolvers *graph.Resolver) *handler.Server {
    schema := generated.NewExecutableSchema(generated.Config{
        Resolvers: resolvers,
        // Custom complexity calculations per field
        Complexity: generated.ComplexityRoot{
            Query: generated.QueryComplexity{
                Users: func(childComplexity int, filter *model.UserFilter, page *model.PageInput) int {
                    // Base cost 10 + children
                    return 10 + childComplexity
                },
                Orders: func(childComplexity int, userID string, status *model.OrderStatus) int {
                    return 5 + childComplexity
                },
            },
            User: generated.UserComplexity{
                Orders: func(childComplexity int, status *model.OrderStatus, limit *int) int {
                    maxLimit := 10
                    if limit != nil {
                        maxLimit = *limit
                    }
                    // Each order requested multiplies children cost
                    return maxLimit * childComplexity
                },
            },
        },
    })

    srv := handler.NewDefaultServer(schema)

    // Reject queries exceeding complexity threshold
    srv.Use(extension.FixedComplexityLimit(1000))

    // Depth limiting
    srv.Use(extension.Introspection{})

    return srv
}
```

### Custom Depth Limiter

```go
package middleware

import (
    "context"
    "fmt"

    "github.com/99designs/gqlgen/graphql"
    "github.com/vektah/gqlparser/v2/gqlerror"
)

// DepthLimit rejects queries exceeding the specified depth.
type DepthLimit struct {
    MaxDepth int
}

var _ interface {
    graphql.OperationInterceptor
} = DepthLimit{}

func (d DepthLimit) InterceptOperation(ctx context.Context, next graphql.OperationHandler) graphql.ResponseHandler {
    op := graphql.GetOperationContext(ctx)

    for _, def := range op.Doc.Operations {
        depth := calcSelectionDepth(def.SelectionSet, 0)
        if depth > d.MaxDepth {
            return func(ctx context.Context) *graphql.Response {
                return graphql.ErrorResponse(ctx, &gqlerror.Error{
                    Message: fmt.Sprintf("query depth %d exceeds maximum allowed depth %d", depth, d.MaxDepth),
                    Extensions: map[string]interface{}{
                        "code": "QUERY_DEPTH_EXCEEDED",
                    },
                })
            }
        }
    }

    return next(ctx)
}

func calcSelectionDepth(ss ast.SelectionSet, depth int) int {
    maxDepth := depth
    for _, s := range ss {
        switch field := s.(type) {
        case *ast.Field:
            if field.SelectionSet != nil {
                childDepth := calcSelectionDepth(field.SelectionSet, depth+1)
                if childDepth > maxDepth {
                    maxDepth = childDepth
                }
            }
        case *ast.InlineFragment:
            childDepth := calcSelectionDepth(field.SelectionSet, depth)
            if childDepth > maxDepth {
                maxDepth = childDepth
            }
        }
    }
    return maxDepth
}
```

## Persisted Queries

Persisted queries replace full query text with a hash, reducing bandwidth and preventing arbitrary query execution in production:

```go
package cache

import (
    "context"
    "fmt"
    "sync"

    "github.com/99designs/gqlgen/graphql/handler/apollotracing"
    "github.com/99designs/gqlgen/graphql/handler/lru"
)

// PersistedQueryCache implements automatic persisted queries (APQ).
// Clients send a hash first; if not found, they send the full query.
type PersistedQueryCache struct {
    cache *lru.LRU
    mu    sync.RWMutex
}

func NewPersistedQueryCache(size int) *PersistedQueryCache {
    return &PersistedQueryCache{
        cache: lru.New(size),
    }
}

func (c *PersistedQueryCache) Add(ctx context.Context, hash string, query string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.cache.Set(hash, query)
}

func (c *PersistedQueryCache) Get(ctx context.Context, hash string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    value, ok := c.cache.Get(hash)
    if !ok {
        return "", false
    }
    return value.(string), true
}

// AllowlistEnforcer rejects queries not in the allowlist in production.
type AllowlistEnforcer struct {
    allowlist map[string]string  // hash -> query
    enforce   bool
}

func NewAllowlistEnforcer(queries map[string]string, enforce bool) *AllowlistEnforcer {
    return &AllowlistEnforcer{allowlist: queries, enforce: enforce}
}

func (a *AllowlistEnforcer) Add(ctx context.Context, hash string, query string) {
    // In enforced mode, only pre-approved queries are accepted
    if a.enforce {
        return
    }
    a.allowlist[hash] = query
}

func (a *AllowlistEnforcer) Get(ctx context.Context, hash string) (string, bool) {
    query, ok := a.allowlist[hash]
    return query, ok
}
```

## GraphQL Subscriptions over WebSocket

```go
package resolver

import (
    "context"
    "fmt"
)

type subscriptionResolver struct{ *Resolver }

// OrderStatusChanged streams order status updates to the subscriber.
func (r *subscriptionResolver) OrderStatusChanged(
    ctx context.Context, orderID string,
) (<-chan *model.OrderStatusEvent, error) {

    // Authenticate subscription
    principal, err := auth.FromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("authentication required for subscription")
    }

    // Authorization: can this user receive updates for this order?
    if !principal.CanViewOrder(orderID) {
        return nil, fmt.Errorf("access denied")
    }

    events := make(chan *model.OrderStatusEvent, 1)

    // Subscribe to Redis pub/sub for this order
    sub, err := r.cache.Subscribe(ctx, fmt.Sprintf("order:status:%s", orderID))
    if err != nil {
        return nil, fmt.Errorf("subscribe to order events: %w", err)
    }

    go func() {
        defer close(events)
        defer sub.Close()

        for {
            select {
            case <-ctx.Done():
                return
            case msg, ok := <-sub.Channel():
                if !ok {
                    return
                }

                var event model.OrderStatusEvent
                if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
                    continue
                }

                select {
                case events <- &event:
                case <-ctx.Done():
                    return
                }
            }
        }
    }()

    return events, nil
}
```

### Subscription Server Configuration

```go
func NewGraphQLServer(resolvers *graph.Resolver) http.Handler {
    schema := generated.NewExecutableSchema(generated.Config{
        Resolvers: resolvers,
    })

    srv := handler.New(schema)

    // HTTP transport for queries and mutations
    srv.AddTransport(transport.GET{})
    srv.AddTransport(transport.POST{})
    srv.AddTransport(transport.MultipartForm{})

    // WebSocket transport for subscriptions
    srv.AddTransport(transport.Websocket{
        KeepAlivePingInterval: 10 * time.Second,
        InitFunc: func(ctx context.Context, initPayload transport.InitPayload) (context.Context, *transport.InitPayload, error) {
            // Authenticate from WebSocket connection init payload
            tokenStr, _ := initPayload["Authorization"].(string)
            tokenStr = strings.TrimPrefix(tokenStr, "Bearer ")

            principal, err := auth.ValidateToken(tokenStr)
            if err != nil {
                return nil, nil, fmt.Errorf("unauthorized: %w", err)
            }

            return auth.WithContext(ctx, principal), &initPayload, nil
        },
    })

    // Extensions
    srv.Use(extension.Introspection{})

    // Complexity limit
    srv.Use(extension.FixedComplexityLimit(500))

    // Custom depth limit
    srv.Use(middleware.DepthLimit{MaxDepth: 10})

    // Persisted queries
    srv.Use(apolloapq.AutomaticPersistedQuery{
        Cache: cache.NewPersistedQueryCache(1000),
    })

    return srv
}
```

## Apollo Federation with Go Subgraphs

Apollo Federation allows splitting a GraphQL API across multiple services. Each service owns its subset of the schema:

```graphql
# User service schema (orders-service.graphql)
extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.3",
        import: ["@key", "@external", "@extends"])

type Order @key(fields: "id") {
  id: ID!
  status: OrderStatus!
  items: [OrderItem!]!
  totalAmount: Float!
}

# Extend the User type from the users service
extend type User @key(fields: "id") {
  id: ID! @external
  orders(status: OrderStatus): [Order!]!
}

type Query {
  order(id: ID!): Order
}
```

```go
// Entity resolver for Federation
func (r *entityResolver) FindOrderByID(ctx context.Context, id string) (*model.Order, error) {
    return r.loaders.OrderByID.Load(ctx, uuid.MustParse(id))
}

func (r *entityResolver) FindUserByID(ctx context.Context, id string) (*model.User, error) {
    // Users service is the source of truth; this service extends it
    return &model.User{ID: uuid.MustParse(id)}, nil
}
```

## Disabling Introspection in Production

```go
// IntrospectionBlocker prevents introspection queries in production.
type IntrospectionBlocker struct {
    enabled bool
}

func (b IntrospectionBlocker) ExtensionName() string {
    return "IntrospectionBlocker"
}

func (b IntrospectionBlocker) Validate(schema graphql.ExecutableSchema) error {
    return nil
}

func (b IntrospectionBlocker) InterceptOperation(ctx context.Context, next graphql.OperationHandler) graphql.ResponseHandler {
    if !b.enabled {
        return next(ctx)
    }

    op := graphql.GetOperationContext(ctx)
    for _, def := range op.Doc.Operations {
        for _, sel := range def.SelectionSet {
            if field, ok := sel.(*ast.Field); ok {
                if field.Name == "__schema" || field.Name == "__type" || field.Name == "__typename" {
                    return func(ctx context.Context) *graphql.Response {
                        return graphql.ErrorResponse(ctx, &gqlerror.Error{
                            Message: "introspection disabled in production",
                            Extensions: map[string]interface{}{
                                "code": "INTROSPECTION_DISABLED",
                            },
                        })
                    }
                }
            }
        }
    }

    return next(ctx)
}

// Usage:
srv.Use(IntrospectionBlocker{enabled: cfg.Production})
```

## Per-Field Rate Limiting

```go
package middleware

import (
    "context"
    "fmt"

    "github.com/99designs/gqlgen/graphql"
    "golang.org/x/time/rate"
)

// FieldRateLimiter applies per-user, per-field rate limits.
type FieldRateLimiter struct {
    limits  map[string]rate.Limit  // fieldPath -> requests per second
    limiters sync.Map              // "userID:fieldPath" -> *rate.Limiter
}

func NewFieldRateLimiter(limits map[string]rate.Limit) *FieldRateLimiter {
    return &FieldRateLimiter{limits: limits}
}

func (r *FieldRateLimiter) ExtensionName() string { return "FieldRateLimiter" }
func (r *FieldRateLimiter) Validate(_ graphql.ExecutableSchema) error { return nil }

func (r *FieldRateLimiter) InterceptField(ctx context.Context, next graphql.Resolver) (interface{}, error) {
    fc := graphql.GetFieldContext(ctx)
    fieldPath := fc.Path().String()

    limit, ok := r.limits[fieldPath]
    if !ok {
        return next(ctx)
    }

    principal, err := auth.FromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("authentication required")
    }

    key := fmt.Sprintf("%s:%s", principal.UserID, fieldPath)
    limiterIface, _ := r.limiters.LoadOrStore(key, rate.NewLimiter(limit, int(limit)*2))
    limiter := limiterIface.(*rate.Limiter)

    if !limiter.Allow() {
        return nil, &gqlerror.Error{
            Message: fmt.Sprintf("rate limit exceeded for field %s", fieldPath),
            Extensions: map[string]interface{}{
                "code":       "RATE_LIMIT_EXCEEDED",
                "field":      fieldPath,
                "retryAfter": 1.0 / float64(limit),
            },
        }
    }

    return next(ctx)
}

// Register expensive field limits
var ExpensiveFieldLimits = map[string]rate.Limit{
    "Query.users":              rate.Limit(10),   // 10 req/s
    "Query.orders":             rate.Limit(20),
    "User.orders":              rate.Limit(50),
    "Query.searchProducts":     rate.Limit(5),
}
```

## Error Handling and User Errors

```go
// UserError represents a domain validation error, not a system error.
// System errors should use Go's error wrapping; user errors use this type.
type UserError struct {
    Field   []string `json:"field"`
    Message string   `json:"message"`
}

// createOrderResolver with proper error categorization
func (r *mutationResolver) CreateOrder(ctx context.Context, input model.CreateOrderInput) (*model.CreateOrderPayload, error) {
    var userErrors []model.UserError

    // Validate input
    if len(input.Items) == 0 {
        userErrors = append(userErrors, model.UserError{
            Field:   []string{"items"},
            Message: "at least one item is required",
        })
    }

    for i, item := range input.Items {
        if item.Quantity <= 0 {
            userErrors = append(userErrors, model.UserError{
                Field:   []string{"items", fmt.Sprint(i), "quantity"},
                Message: "quantity must be positive",
            })
        }
    }

    if len(userErrors) > 0 {
        // Return user errors in payload, not as a top-level error
        return &model.CreateOrderPayload{UserErrors: userErrors}, nil
    }

    // Create order (system errors bubble up as GraphQL errors)
    order, err := r.db.CreateOrder(ctx, input)
    if err != nil {
        // Log the internal error, return a sanitized message
        r.logger.Error("create order failed", "error", err)
        return nil, fmt.Errorf("failed to create order: internal error")
    }

    return &model.CreateOrderPayload{Order: order}, nil
}
```

## Summary

gqlgen's schema-first approach ensures compile-time correctness between schema and resolvers. The DataLoader pattern is non-negotiable for any GraphQL API serving related data — without it, N+1 queries will degrade performance under load regardless of other optimizations.

Query complexity limits and depth limits protect the server from malicious or accidentally expensive queries. Persisted queries, when combined with introspection disabling in production, significantly reduce the attack surface. Per-field rate limiting enables fine-grained control over which operations expensive clients can call.

Apollo Federation enables progressive decomposition of a monolithic GraphQL schema into service-owned subgraphs, allowing teams to evolve their sections independently while presenting a unified API to clients.
