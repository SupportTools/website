---
title: "Building Modern APIs with Go and GraphQL: A Practical Guide"
date: 2026-06-02T09:00:00-05:00
draft: false
tags: ["go", "golang", "graphql", "api", "gqlgen", "web-development"]
categories: ["Programming", "Go", "API Design"]
---

GraphQL has revolutionized API development by enabling clients to request exactly the data they need, nothing more and nothing less. When combined with Go's performance characteristics and strong typing, it creates a powerful foundation for building efficient, maintainable, and type-safe APIs. This guide walks through the entire process of building a GraphQL API with Go, from basic setup to production-ready implementation.

## Why Combine Go and GraphQL?

Before diving into implementation details, let's understand why this combination is particularly effective:

1. **Type Safety**: GraphQL schemas and Go's type system complement each other well, reducing runtime errors.
2. **Performance**: Go's efficient execution and low memory footprint make it ideal for high-throughput API servers.
3. **Concurrency Model**: Go's goroutines are perfect for handling multiple resolver operations in parallel.
4. **Flexible Data Fetching**: GraphQL eliminates over-fetching and under-fetching problems common in REST APIs.
5. **Developer Experience**: Code generation tools create type-safe resolvers from GraphQL schemas.

## Getting Started with gqlgen

We'll use [gqlgen](https://github.com/99designs/gqlgen), a Go library that generates code from your GraphQL schema. This gives you type-safe GraphQL servers without writing boilerplate code.

### Setting Up the Project

Start by creating a new Go module:

```bash
mkdir go-graphql-library
cd go-graphql-library
go mod init github.com/yourusername/go-graphql-library
```

Next, install gqlgen:

```bash
go get github.com/99designs/gqlgen
```

Initialize a new GraphQL server:

```bash
go run github.com/99designs/gqlgen init
```

This command creates several files:

- `gqlgen.yml`: Configuration for code generation
- `graph/schema.graphqls`: GraphQL schema definition
- `graph/generated/generated.go`: Auto-generated GraphQL server code
- `graph/model/models_gen.go`: Go types generated from schema
- `graph/resolver.go`: Resolver implementation stubs
- `server.go`: Entry point for the GraphQL server

### Defining Your Schema

Let's create a library management API. Replace the contents of `graph/schema.graphqls` with:

```graphql
type Book {
  id: ID!
  title: String!
  author: Author!
  publishedYear: Int
  genres: [String!]
}

type Author {
  id: ID!
  name: String!
  books: [Book!]!
}

input NewBook {
  title: String!
  authorID: ID!
  publishedYear: Int
  genres: [String!]
}

input NewAuthor {
  name: String!
}

type Query {
  books: [Book!]!
  book(id: ID!): Book
  authors: [Author!]!
  author(id: ID!): Author
}

type Mutation {
  createBook(input: NewBook!): Book!
  createAuthor(input: NewAuthor!): Author!
}
```

### Generating Code

After defining your schema, regenerate the code:

```bash
go run github.com/99designs/gqlgen generate
```

This creates or updates several files, including:

- Go types based on your schema
- Resolver interfaces that you need to implement
- Server code to handle GraphQL requests

### Setting Up the Resolvers

Now you'll need to implement the resolver functions. For simplicity, we'll use in-memory storage, but in a real application, you'd typically connect to a database.

First, let's modify the `graph/resolver.go` file to include our data stores:

```go
package graph

import (
	"github.com/yourusername/go-graphql-library/graph/model"
	"sync"
)

// Resolver is the resolver root.
type Resolver struct {
	books       map[string]*model.Book
	authors     map[string]*model.Author
	bookCounter int
	authorCounter int
	mutex      sync.RWMutex
}

// NewResolver creates a new resolver with initial data.
func NewResolver() *Resolver {
	r := &Resolver{
		books:       make(map[string]*model.Book),
		authors:     make(map[string]*model.Author),
		bookCounter: 0,
		authorCounter: 0,
	}
	
	// Add some initial data
	authorID := r.createAuthorInternal(&model.NewAuthor{Name: "George Orwell"})
	r.createBookInternal(&model.NewBook{
		Title:        "1984",
		AuthorID:     authorID,
		PublishedYear: 1949,
		Genres:       []string{"Dystopian", "Science Fiction"},
	})
	
	r.createBookInternal(&model.NewBook{
		Title:        "Animal Farm",
		AuthorID:     authorID,
		PublishedYear: 1945,
		Genres:       []string{"Political Satire", "Allegory"},
	})
	
	return r
}

// Helper methods for creating entities
func (r *Resolver) createAuthorInternal(input *model.NewAuthor) string {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	
	r.authorCounter++
	id := fmt.Sprintf("A%d", r.authorCounter)
	
	author := &model.Author{
		ID:   id,
		Name: input.Name,
	}
	
	r.authors[id] = author
	return id
}

func (r *Resolver) createBookInternal(input *model.NewBook) string {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	
	r.bookCounter++
	id := fmt.Sprintf("B%d", r.bookCounter)
	
	book := &model.Book{
		ID:           id,
		Title:        input.Title,
		PublishedYear: input.PublishedYear,
		Genres:       input.Genres,
	}
	
	r.books[id] = book
	return id
}
```

### Implementing the Query Resolvers

Now let's implement the query resolvers in `graph/schema.resolvers.go`. The file should already contain stub functions that were generated. Let's update them:

```go
func (r *queryResolver) Books(ctx context.Context) ([]*model.Book, error) {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	
	books := make([]*model.Book, 0, len(r.books))
	for _, book := range r.books {
		books = append(books, book)
	}
	return books, nil
}

func (r *queryResolver) Book(ctx context.Context, id string) (*model.Book, error) {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	
	book, exists := r.books[id]
	if !exists {
		return nil, nil
	}
	return book, nil
}

func (r *queryResolver) Authors(ctx context.Context) ([]*model.Author, error) {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	
	authors := make([]*model.Author, 0, len(r.authors))
	for _, author := range r.authors {
		authors = append(authors, author)
	}
	return authors, nil
}

func (r *queryResolver) Author(ctx context.Context, id string) (*model.Author, error) {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	
	author, exists := r.authors[id]
	if !exists {
		return nil, nil
	}
	return author, nil
}
```

### Implementing the Mutation Resolvers

Next, let's implement the mutation resolvers in the same file:

```go
func (r *mutationResolver) CreateBook(ctx context.Context, input model.NewBook) (*model.Book, error) {
	// Verify that the author exists
	r.mutex.RLock()
	_, authorExists := r.authors[input.AuthorID]
	r.mutex.RUnlock()
	
	if !authorExists {
		return nil, fmt.Errorf("author with ID %s does not exist", input.AuthorID)
	}
	
	id := r.createBookInternal(&input)
	
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	return r.books[id], nil
}

func (r *mutationResolver) CreateAuthor(ctx context.Context, input model.NewAuthor) (*model.Author, error) {
	id := r.createAuthorInternal(&input)
	
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	return r.authors[id], nil
}
```

### Implementing Type Resolvers

We also need to implement resolvers for the nested fields in our types. The `Author` field in `Book` and the `Books` field in `Author` need resolvers:

```go
func (r *bookResolver) Author(ctx context.Context, obj *model.Book) (*model.Author, error) {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	
	// In our current model, books don't store the author ID directly
	// In a real application, you would have a proper relationship
	// For now, we'll search through all books
	for _, author := range r.authors {
		for _, book := range r.books {
			if book.ID == obj.ID {
				return author, nil
			}
		}
	}
	
	return nil, fmt.Errorf("author not found for book %s", obj.ID)
}

func (r *authorResolver) Books(ctx context.Context, obj *model.Author) ([]*model.Book, error) {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	
	var result []*model.Book
	
	// Find all books by this author
	for _, book := range r.books {
		author, err := r.bookResolver.Author(ctx, book)
		if err != nil {
			continue
		}
		
		if author.ID == obj.ID {
			result = append(result, book)
		}
	}
	
	return result, nil
}
```

### Setting Up the Server

Now let's update `server.go` to use our custom resolver:

```go
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/playground"
	"github.com/yourusername/go-graphql-library/graph"
	"github.com/yourusername/go-graphql-library/graph/generated"
)

const defaultPort = "8080"

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	resolver := graph.NewResolver()
	srv := handler.NewDefaultServer(generated.NewExecutableSchema(generated.Config{Resolvers: resolver}))

	http.Handle("/", playground.Handler("GraphQL playground", "/query"))
	http.Handle("/query", srv)

	log.Printf("connect to http://localhost:%s/ for GraphQL playground", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

### Running the Server

With everything in place, you can run the server:

```bash
go run server.go
```

Visit http://localhost:8080 to access the GraphQL playground. You can now execute queries like:

```graphql
{
  authors {
    id
    name
    books {
      title
      publishedYear
      genres
    }
  }
}
```

And mutations like:

```graphql
mutation {
  createAuthor(input: {name: "J.K. Rowling"}) {
    id
    name
  }
}
```

## Advanced Features

Let's enhance our GraphQL API with more advanced features commonly needed in production applications.

### Adding Authentication and Authorization

First, let's add a simple authentication middleware:

```go
// middleware/auth.go
package middleware

import (
	"context"
	"net/http"
	"strings"
)

type contextKey string

const UserIDKey contextKey = "userID"

func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		
		// Simple auth scheme that checks for "Bearer <token>"
		if authHeader != "" && strings.HasPrefix(authHeader, "Bearer ") {
			token := strings.TrimPrefix(authHeader, "Bearer ")
			
			// In a real application, you would validate the token 
			// and extract the user ID. For this example, we'll just use
			// the token directly as the user ID if it's not empty
			if token != "" {
				ctx := context.WithValue(r.Context(), UserIDKey, token)
				r = r.WithContext(ctx)
			}
		}
		
		next.ServeHTTP(w, r)
	})
}

// Helper to get the user ID from context
func GetUserID(ctx context.Context) (string, bool) {
	userID, ok := ctx.Value(UserIDKey).(string)
	return userID, ok
}
```

Update the server to use this middleware:

```go
func main() {
	// ... existing code ...

	// Apply middleware
	handler := middleware.AuthMiddleware(srv)
	
	http.Handle("/", playground.Handler("GraphQL playground", "/query"))
	http.Handle("/query", handler)

	// ... rest of the code ...
}
```

Now let's update a resolver to check for authorization:

```go
func (r *mutationResolver) CreateBook(ctx context.Context, input model.NewBook) (*model.Book, error) {
	// Check if user is authenticated
	userID, ok := middleware.GetUserID(ctx)
	if !ok {
		return nil, fmt.Errorf("access denied: not authenticated")
	}
	
	// In a real app, you would check if this user has permission to create books
	log.Printf("User %s is creating a book", userID)
	
	// ... rest of the implementation ...
}
```

### Implementing Dataloader for Batching

One common performance issue in GraphQL is the "N+1 query problem". To address this, we can use the [dataloader](https://github.com/graph-gophers/dataloader) pattern:

```bash
go get github.com/graph-gophers/dataloader
```

Create a new file for our dataloaders:

```go
// dataloader/dataloader.go
package dataloader

import (
	"context"
	"time"

	"github.com/graph-gophers/dataloader"
	"github.com/yourusername/go-graphql-library/graph/model"
)

type contextKey string

const (
	loadersKey = contextKey("dataloaders")
)

// Loaders contains all dataloaders
type Loaders struct {
	AuthorByID      dataloader.Interface
	BooksByAuthorID dataloader.Interface
}

// NewLoaders creates a new set of loaders with the given resolver
func NewLoaders(resolver interface{}) *Loaders {
	// Cast the resolver to access our methods
	r := resolver.(*graph.Resolver)
	
	return &Loaders{
		AuthorByID:      newAuthorLoader(r),
		BooksByAuthorID: newBooksByAuthorLoader(r),
	}
}

func newAuthorLoader(r *graph.Resolver) dataloader.Interface {
	return dataloader.NewBatchedLoader(func(ctx context.Context, keys dataloader.Keys) []*dataloader.Result {
		// Get all requested author IDs
		var authorIDs []string
		for _, key := range keys {
			authorIDs = append(authorIDs, key.String())
		}

		// Fetch authors in one batch
		authors, err := r.BatchGetAuthorsByID(ctx, authorIDs)
		
		// Convert to dataloader results
		var results []*dataloader.Result
		for _, key := range keys {
			author, ok := authors[key.String()]
			if !ok {
				results = append(results, &dataloader.Result{
					Error: fmt.Errorf("author not found: %s", key.String()),
				})
				continue
			}
			results = append(results, &dataloader.Result{
				Data: author,
			})
		}
		
		return results
	}, dataloader.WithClearCacheOnBatch())
}

// Similar implementation for booksByAuthorLoader...

// Middleware to add loaders to the request context
func Middleware(resolver interface{}) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			loaders := NewLoaders(resolver)
			ctx := context.WithValue(r.Context(), loadersKey, loaders)
			r = r.WithContext(ctx)
			next.ServeHTTP(w, r)
		})
	}
}

// For returns the dataloader for a given context
func For(ctx context.Context) *Loaders {
	return ctx.Value(loadersKey).(*Loaders)
}
```

Now update the resolver to include batch methods:

```go
// Add to graph/resolver.go

func (r *Resolver) BatchGetAuthorsByID(ctx context.Context, ids []string) (map[string]*model.Author, error) {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	
	result := make(map[string]*model.Author)
	for _, id := range ids {
		if author, ok := r.authors[id]; ok {
			result[id] = author
		}
	}
	
	return result, nil
}

// ... similar methods for other batch operations ...
```

And update the `Book.Author` resolver to use the dataloader:

```go
func (r *bookResolver) Author(ctx context.Context, obj *model.Book) (*model.Author, error) {
	// Get authorID from the book
	authorID := obj.AuthorID
	
	// Use dataloader
	loaders := dataloader.For(ctx)
	thunk := loaders.AuthorByID.Load(ctx, dataloader.StringKey(authorID))
	
	// Wait for the batch function to execute
	result, err := thunk()
	if err != nil {
		return nil, err
	}
	
	return result.(*model.Author), nil
}
```

### Adding Pagination

Let's add pagination to our book queries:

```graphql
# Add to schema.graphqls
type BookConnection {
  edges: [BookEdge!]!
  pageInfo: PageInfo!
}

type BookEdge {
  cursor: String!
  node: Book!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

# Update Query type
type Query {
  # ... existing queries ...
  bookConnection(first: Int, after: String): BookConnection!
}
```

Regenerate the code with `go run github.com/99designs/gqlgen generate`, then implement the resolver:

```go
func (r *queryResolver) BookConnection(ctx context.Context, first *int, after *string) (*model.BookConnection, error) {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	
	// Convert map to slice for easier sorting and pagination
	books := make([]*model.Book, 0, len(r.books))
	for _, book := range r.books {
		books = append(books, book)
	}
	
	// Sort books by ID (in a real app you might want a different sort)
	sort.Slice(books, func(i, j int) bool {
		return books[i].ID < books[j].ID
	})
	
	// Find the starting point if 'after' is provided
	startIndex := 0
	if after != nil {
		for i, book := range books {
			if encodeCursor(book.ID) == *after {
				startIndex = i + 1
				break
			}
		}
	}
	
	// Apply the 'first' limit
	endIndex := len(books)
	if first != nil && startIndex+*first < endIndex {
		endIndex = startIndex + *first
	}
	
	// Handle empty result
	if startIndex >= endIndex {
		return &model.BookConnection{
			Edges:    []*model.BookEdge{},
			PageInfo: &model.PageInfo{
				HasNextPage:     false,
				HasPreviousPage: startIndex > 0,
			},
		}, nil
	}
	
	// Build the edges
	edges := make([]*model.BookEdge, 0, endIndex-startIndex)
	for i := startIndex; i < endIndex; i++ {
		edges = append(edges, &model.BookEdge{
			Cursor: encodeCursor(books[i].ID),
			Node:   books[i],
		})
	}
	
	// Build the page info
	pageInfo := &model.PageInfo{
		HasNextPage:     endIndex < len(books),
		HasPreviousPage: startIndex > 0,
	}
	
	if len(edges) > 0 {
		pageInfo.StartCursor = &edges[0].Cursor
		pageInfo.EndCursor = &edges[len(edges)-1].Cursor
	}
	
	return &model.BookConnection{
		Edges:    edges,
		PageInfo: pageInfo,
	}, nil
}

// Helper to encode a cursor (in a real app, you'd base64 encode this)
func encodeCursor(id string) string {
	return id
}
```

### Adding Field-Level Permissions

To control access at the field level:

```go
// Add to schema.graphqls
directive @hasRole(role: String!) on FIELD_DEFINITION

// Apply to a field
type Book {
  # ...existing fields...
  internalNotes: String @hasRole(role: "ADMIN")
}
```

Implement the directive in `gqlgen.yml`:

```yaml
directives:
  hasRole:
    locations: [FIELD_DEFINITION]
    args:
      role:
        type: String!
```

Then create a directive implementation:

```go
// directive/directives.go
package directive

import (
	"context"
	"fmt"

	"github.com/99designs/gqlgen/graphql"
	"github.com/yourusername/go-graphql-library/middleware"
)

func HasRole(ctx context.Context, obj interface{}, next graphql.Resolver, role string) (interface{}, error) {
	// Get user from context
	userID, ok := middleware.GetUserID(ctx)
	if !ok {
		return nil, fmt.Errorf("access denied: not authenticated")
	}
	
	// In a real app, you would check if this user has the required role
	// For this example, we'll just check a hardcoded "admin" user
	if role == "ADMIN" && userID != "admin" {
		return nil, fmt.Errorf("access denied: requires role %s", role)
	}
	
	return next(ctx)
}
```

Register the directive in the server setup:

```go
func main() {
	// ... existing code ...

	config := generated.Config{
		Resolvers: resolver,
		Directives: generated.DirectiveRoot{
			HasRole: directive.HasRole,
		},
	}
	srv := handler.NewDefaultServer(generated.NewExecutableSchema(config))

	// ... rest of the code ...
}
```

## Production-Ready Enhancements

### Error Handling

Improve error handling with custom error types:

```go
// errors/errors.go
package errors

import (
	"fmt"
	"github.com/vektah/gqlparser/v2/gqlerror"
	"context"
)

// ErrorCode represents an error code
type ErrorCode string

const (
	NotFound      ErrorCode = "NOT_FOUND"
	Unauthorized  ErrorCode = "UNAUTHORIZED"
	BadInput      ErrorCode = "BAD_INPUT"
	Internal      ErrorCode = "INTERNAL"
)

// Error is a custom error type with GraphQL error code
type Error struct {
	Code    ErrorCode
	Message string
	Err     error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Err)
	}
	return e.Message
}

// ToGraphQLError converts the error to a GraphQL error
func (e *Error) ToGraphQLError(ctx context.Context) *gqlerror.Error {
	err := &gqlerror.Error{
		Message: e.Message,
		Path:    graphql.GetPath(ctx),
		Extensions: map[string]interface{}{
			"code": e.Code,
		},
	}
	
	return err
}

// NewNotFound creates a not found error
func NewNotFound(entity string, id string) *Error {
	return &Error{
		Code:    NotFound,
		Message: fmt.Sprintf("%s with ID %s not found", entity, id),
	}
}

// ... additional helper methods for other error types ...
```

### Configuring the Server with Environment Variables

Create a configuration package:

```go
// config/config.go
package config

import (
	"os"
	"strconv"
	"time"
)

// Config holds application configuration
type Config struct {
	Port             string
	DatabaseURL      string
	AuthSecret       string
	AllowedOrigins   []string
	ReadTimeout      time.Duration
	WriteTimeout     time.Duration
	GracefulTimeout  time.Duration
	EnablePlayground bool
}

// Load loads configuration from environment variables
func Load() *Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgresql://postgres:postgres@localhost:5432/library?sslmode=disable"
	}
	
	authSecret := os.Getenv("AUTH_SECRET")
	if authSecret == "" {
		authSecret = "development-secret-key"
	}
	
	origins := os.Getenv("ALLOWED_ORIGINS")
	var allowedOrigins []string
	if origins == "" {
		allowedOrigins = []string{"*"}
	} else {
		// Parse comma-separated list
		// ... implementation ...
	}
	
	readTimeout := getEnvDuration("READ_TIMEOUT", 5*time.Second)
	writeTimeout := getEnvDuration("WRITE_TIMEOUT", 10*time.Second)
	gracefulTimeout := getEnvDuration("GRACEFUL_TIMEOUT", 15*time.Second)
	
	enablePlayground := getEnvBool("ENABLE_PLAYGROUND", true)
	
	return &Config{
		Port:             port,
		DatabaseURL:      dbURL,
		AuthSecret:       authSecret,
		AllowedOrigins:   allowedOrigins,
		ReadTimeout:      readTimeout,
		WriteTimeout:     writeTimeout,
		GracefulTimeout:  gracefulTimeout,
		EnablePlayground: enablePlayground,
	}
}

// Helper for parsing duration from env var
func getEnvDuration(key string, defaultVal time.Duration) time.Duration {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}
	
	// Try to parse as seconds first
	if seconds, err := strconv.Atoi(val); err == nil {
		return time.Duration(seconds) * time.Second
	}
	
	// Try to parse as a duration string
	if duration, err := time.ParseDuration(val); err == nil {
		return duration
	}
	
	return defaultVal
}

// Helper for parsing boolean from env var
func getEnvBool(key string, defaultVal bool) bool {
	val := os.Getenv(key)
	if val == "" {
		return defaultVal
	}
	
	b, err := strconv.ParseBool(val)
	if err != nil {
		return defaultVal
	}
	
	return b
}
```

### Structured Logging

Implement structured logging:

```go
// logger/logger.go
package logger

import (
	"context"
	"os"
	
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var log *zap.Logger

// Initialize sets up the logger
func Initialize(environment string) {
	var config zap.Config
	
	if environment == "production" {
		config = zap.NewProductionConfig()
	} else {
		config = zap.NewDevelopmentConfig()
		config.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
	}
	
	var err error
	log, err = config.Build()
	if err != nil {
		panic(err)
	}
}

// Get returns the global logger
func Get() *zap.Logger {
	if log == nil {
		// Fallback to a development logger if Initialize was not called
		log, _ = zap.NewDevelopment()
	}
	return log
}

// FromContext extracts a logger from the context, or returns the default logger
func FromContext(ctx context.Context) *zap.Logger {
	// You could store a request-specific logger in the context
	// For now, just return the global logger
	return Get()
}

// WithField adds a field to the logger
func WithField(key string, value interface{}) *zap.Logger {
	return Get().With(zap.Any(key, value))
}

// Sync flushes any buffered log entries
func Sync() error {
	if log != nil {
		return log.Sync()
	}
	return nil
}
```

### Graceful Shutdown

Implement graceful shutdown:

```go
// Update server.go
func main() {
	cfg := config.Load()
	logger.Initialize(os.Getenv("ENVIRONMENT"))
	defer logger.Sync()
	
	log := logger.Get()
	
	resolver := graph.NewResolver()
	
	// Create GraphQL server
	config := generated.Config{
		Resolvers: resolver,
		Directives: generated.DirectiveRoot{
			HasRole: directive.HasRole,
		},
	}
	srv := handler.NewDefaultServer(generated.NewExecutableSchema(config))
	
	// Set up middleware chain
	var handler http.Handler = srv
	handler = middleware.AuthMiddleware(handler)
	handler = dataloader.Middleware(resolver)(handler)
	
	// Create router
	router := http.NewServeMux()
	
	// Add GraphQL endpoint
	router.Handle("/query", handler)
	
	// Add GraphQL playground in non-production
	if cfg.EnablePlayground {
		router.Handle("/", playground.Handler("GraphQL playground", "/query"))
	}
	
	// Create server with timeouts
	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      router,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
	}
	
	// Start server in a goroutine
	go func() {
		log.Info("Starting server", zap.String("port", cfg.Port))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal("Server failed to start", zap.Error(err))
		}
	}()
	
	// Set up graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	
	// Block until a signal is received
	sig := <-quit
	log.Info("Shutting down server", zap.String("signal", sig.String()))
	
	// Create context with timeout for shutdown
	ctx, cancel := context.WithTimeout(context.Background(), cfg.GracefulTimeout)
	defer cancel()
	
	// Attempt graceful shutdown
	if err := server.Shutdown(ctx); err != nil {
		log.Error("Server forced to shutdown", zap.Error(err))
	}
	
	log.Info("Server exited")
}
```

## Best Practices and Tips

### Schema Design Guidelines

1. **Design for the Consumer**: Structure your schema around how clients will use it, not how your data is stored.
2. **Use Clear Naming**: Choose descriptive, consistent field and type names.
3. **Prefer Connections**: For lists that might grow large, use pagination with connections.
4. **Mutations with Inputs**: Group related input fields into input types.
5. **Return Created/Updated Objects**: Mutation responses should include the affected objects.

### Performance Optimization

1. **Use Dataloaders**: For efficient batch loading of related objects.
2. **Implement Query Complexity Analysis**: To prevent expensive queries.
3. **Consider Query Caching**: For frequently executed queries.
4. **Monitor Resolver Performance**: Profile and optimize slow resolvers.
5. **Pagination**: Always paginate lists that might contain many items.

### Security Considerations

1. **Rate Limiting**: Protect your API from abuse.
2. **Input Validation**: Always validate incoming data.
3. **Authentication & Authorization**: Implement granular permission checks.
4. **Prevent Introspection in Production**: Consider disabling introspection for sensitive APIs.
5. **Set Appropriate Timeouts**: For all external service calls.

## Conclusion

Combining Go and GraphQL creates a powerful foundation for building modern APIs. Go's performance, strong typing, and concurrency model pair perfectly with GraphQL's flexible query language and client-driven approach.

In this guide, we've explored how to set up a basic GraphQL server with gqlgen, implement resolvers, and add advanced features like authentication, dataloaders, and pagination. We've also covered best practices for making your GraphQL API production-ready with error handling, configuration, and graceful shutdown.

By following these patterns, you can build GraphQL APIs that are efficient, maintainable, and ready to scale.