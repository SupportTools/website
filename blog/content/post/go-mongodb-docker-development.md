---
title: "Building a Go Microservice with MongoDB and Docker: A Developer's Guide"
date: 2026-06-23T09:00:00-05:00
draft: false
tags: ["Golang", "Go", "MongoDB", "Docker", "Microservices", "Docker Compose"]
categories:
- Golang
- MongoDB
- Docker
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to setting up and developing a Go microservice with MongoDB using Docker for seamless local development."
more_link: "yes"
url: "/go-mongodb-docker-development/"
---

Developing microservices locally can be challenging, especially when dealing with databases and their dependencies. This guide demonstrates how to create a robust Go microservice that interacts with MongoDB, all containerized with Docker for a consistent development experience.

<!--more-->

# Building a Go Microservice with MongoDB and Docker

Modern application development often involves building microservices that interact with various databases. MongoDB has become a popular choice for many Go developers due to its flexibility, performance, and JSON-like document model. In this guide, we'll walk through setting up a complete development environment for a Go microservice with MongoDB using Docker.

## Section 1: Setting Up the Development Environment

Let's start by creating a robust development environment that uses Docker Compose to manage our services.

### Project Structure

First, let's establish our project structure:

```
my-go-mongodb-service/
├── api/
│   └── handlers.go
├── config/
│   └── config.go
├── models/
│   └── user.go
├── repository/
│   └── mongodb.go
├── docker/
│   ├── Dockerfile.dev
│   └── Dockerfile.prod
├── docker-compose.yml
├── go.mod
├── go.sum
└── main.go
```

### Docker Compose Configuration

Create a `docker-compose.yml` file to orchestrate our MongoDB, Mongo Express, and Go service:

```yaml
version: '3.8'

services:
  # MongoDB Service
  mongodb:
    image: mongodb/mongodb-community-server:latest
    container_name: mongodb
    ports:
      - "27017:27017"
    volumes:
      - mongodb_data:/data/db
    environment:
      - MONGO_INITDB_ROOT_USERNAME=admin
      - MONGO_INITDB_ROOT_PASSWORD=password
      - MONGO_INITDB_DATABASE=myapp
    networks:
      - app_network
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 3

  # Mongo Express Service
  mongo-express:
    image: mongo-express:latest
    container_name: mongo-express
    restart: unless-stopped
    ports:
      - "8081:8081"
    environment:
      ME_CONFIG_MONGODB_SERVER: mongodb
      ME_CONFIG_MONGODB_ADMINUSERNAME: admin
      ME_CONFIG_MONGODB_ADMINPASSWORD: password
      ME_CONFIG_BASICAUTH_USERNAME: dev
      ME_CONFIG_BASICAUTH_PASSWORD: dev
    depends_on:
      mongodb:
        condition: service_healthy
    networks:
      - app_network

  # Go API Service
  api:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
    container_name: go_api
    volumes:
      - .:/app
      - go_modules:/go/pkg/mod
    ports:
      - "8080:8080"
    environment:
      - MONGODB_URI=mongodb://admin:password@mongodb:27017/myapp?authSource=admin
      - PORT=8080
      - ENV=development
    depends_on:
      mongodb:
        condition: service_healthy
    networks:
      - app_network

networks:
  app_network:
    driver: bridge

volumes:
  mongodb_data:
    driver: local
  go_modules:
    driver: local
```

### Development Dockerfile

Create a `docker/Dockerfile.dev` for local development:

```dockerfile
FROM golang:1.22-alpine

WORKDIR /app

RUN go install github.com/cosmtrek/air@latest

COPY go.mod go.sum ./
RUN go mod download

COPY . .

CMD ["air", "-c", ".air.toml"]
```

### Hot Reload Configuration

Create a `.air.toml` file in the root directory for hot reloading:

```toml
root = "."
tmp_dir = "tmp"

[build]
  cmd = "go build -o ./tmp/main ."
  bin = "./tmp/main"
  delay = 1000
  exclude_dir = ["assets", "tmp", "vendor"]
  exclude_file = []
  exclude_regex = ["_test.go"]
  exclude_unchanged = true
  follow_symlink = false
  full_bin = ""
  include_dir = []
  include_ext = ["go", "tpl", "tmpl", "html"]
  kill_delay = "0s"
  log = "build-errors.log"
  send_interrupt = false
  stop_on_error = true

[color]
  app = ""
  build = "yellow"
  main = "magenta"
  runner = "green"
  watcher = "cyan"

[log]
  time = false

[misc]
  clean_on_exit = false
```

## Section 2: Implementing the Go Microservice

Now, let's build our Go microservice components.

### Go Module Setup

Initialize your Go module:

```go
// go.mod
module github.com/yourusername/my-go-mongodb-service

go 1.22

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/joho/godotenv v1.5.1
	go.mongodb.org/mongo-driver v1.13.1
)

// Additional dependencies will be added as needed
```

### Configuration Management

Create a simple configuration manager:

```go
// config/config.go
package config

import (
	"log"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Port            string
	MongoURI        string
	DatabaseName    string
	Env             string
	RequestTimeout  time.Duration
	ShutdownTimeout time.Duration
}

// Load loads the environment variables from .env file if present
func Load() *Config {
	// Load .env file if it exists
	godotenv.Load()

	// Get MongoDB connection string
	mongoURI := os.Getenv("MONGODB_URI")
	if mongoURI == "" {
		log.Fatal("MONGODB_URI environment variable is required")
	}

	// Get port or use default
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Get database name or use default
	dbName := os.Getenv("DB_NAME")
	if dbName == "" {
		dbName = "myapp"
	}

	// Get environment or use default
	env := os.Getenv("ENV")
	if env == "" {
		env = "development"
	}

	// Parse timeout values
	requestTimeout := 30 * time.Second
	if val, err := strconv.Atoi(os.Getenv("REQUEST_TIMEOUT")); err == nil {
		requestTimeout = time.Duration(val) * time.Second
	}

	shutdownTimeout := 10 * time.Second
	if val, err := strconv.Atoi(os.Getenv("SHUTDOWN_TIMEOUT")); err == nil {
		shutdownTimeout = time.Duration(val) * time.Second
	}

	return &Config{
		Port:            port,
		MongoURI:        mongoURI,
		DatabaseName:    dbName,
		Env:             env,
		RequestTimeout:  requestTimeout,
		ShutdownTimeout: shutdownTimeout,
	}
}
```

### MongoDB Repository Implementation

Let's implement a MongoDB repository pattern:

```go
// repository/mongodb.go
package repository

import (
	"context"
	"fmt"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
)

// MongoRepository represents a MongoDB client
type MongoRepository struct {
	client   *mongo.Client
	database *mongo.Database
}

// NewMongoRepository creates a new MongoDB repository
func NewMongoRepository(uri, dbName string) (*MongoRepository, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Create a new client and connect to the server
	clientOptions := options.Client().ApplyURI(uri)
	client, err := mongo.Connect(ctx, clientOptions)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to MongoDB: %w", err)
	}

	// Ping the primary to verify that the client can connect
	if err := client.Ping(ctx, readpref.Primary()); err != nil {
		return nil, fmt.Errorf("failed to ping MongoDB: %w", err)
	}

	log.Println("Successfully connected to MongoDB")
	
	// Get a handle to the specified database
	database := client.Database(dbName)

	return &MongoRepository{
		client:   client,
		database: database,
	}, nil
}

// Close closes the MongoDB connection
func (r *MongoRepository) Close(ctx context.Context) error {
	return r.client.Disconnect(ctx)
}

// GetCollection returns a handle to the specified collection
func (r *MongoRepository) GetCollection(name string) *mongo.Collection {
	return r.database.Collection(name)
}
```

### User Model

Let's define a simple User model:

```go
// models/user.go
package models

import (
	"time"

	"go.mongodb.org/mongo-driver/bson/primitive"
)

// User represents a user in the system
type User struct {
	ID        primitive.ObjectID `bson:"_id,omitempty" json:"id"`
	Name      string             `bson:"name" json:"name"`
	Email     string             `bson:"email" json:"email"`
	Password  string             `bson:"password" json:"-"` // Password is never returned in JSON
	CreatedAt time.Time          `bson:"created_at" json:"created_at"`
	UpdatedAt time.Time          `bson:"updated_at" json:"updated_at"`
}

// UserRepository defines the interface for user data operations
type UserRepository interface {
	Create(user User) (User, error)
	FindByID(id string) (User, error)
	FindByEmail(email string) (User, error)
	Update(user User) error
	Delete(id string) error
	List(limit, offset int) ([]User, error)
}
```

### User Repository Implementation

Now implement the actual MongoDB repository for the User model:

```go
// repository/user_repository.go
package repository

import (
	"context"
	"errors"
	"time"

	"github.com/yourusername/my-go-mongodb-service/models"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// UserMongoRepository implements UserRepository interface for MongoDB
type UserMongoRepository struct {
	collection *mongo.Collection
}

// NewUserMongoRepository creates a new user repository
func NewUserMongoRepository(mongoRepo *MongoRepository) *UserMongoRepository {
	return &UserMongoRepository{
		collection: mongoRepo.GetCollection("users"),
	}
}

// Create adds a new user to the database
func (r *UserMongoRepository) Create(user models.User) (models.User, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Set creation and update timestamps
	now := time.Now()
	user.CreatedAt = now
	user.UpdatedAt = now

	// Insert the user
	result, err := r.collection.InsertOne(ctx, user)
	if err != nil {
		return models.User{}, err
	}

	// Set the ID field to the generated ObjectID
	user.ID = result.InsertedID.(primitive.ObjectID)
	return user, nil
}

// FindByID finds a user by ID
func (r *UserMongoRepository) FindByID(id string) (models.User, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Convert string ID to ObjectID
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		return models.User{}, errors.New("invalid ID format")
	}

	// Find the user
	var user models.User
	err = r.collection.FindOne(ctx, bson.M{"_id": objID}).Decode(&user)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return models.User{}, errors.New("user not found")
		}
		return models.User{}, err
	}
	return user, nil
}

// FindByEmail finds a user by email
func (r *UserMongoRepository) FindByEmail(email string) (models.User, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Find the user
	var user models.User
	err := r.collection.FindOne(ctx, bson.M{"email": email}).Decode(&user)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return models.User{}, errors.New("user not found")
		}
		return models.User{}, err
	}
	return user, nil
}

// Update updates an existing user
func (r *UserMongoRepository) Update(user models.User) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Set update timestamp
	user.UpdatedAt = time.Now()

	// Update the user
	filter := bson.M{"_id": user.ID}
	update := bson.M{"$set": user}
	_, err := r.collection.UpdateOne(ctx, filter, update)
	return err
}

// Delete removes a user
func (r *UserMongoRepository) Delete(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Convert string ID to ObjectID
	objID, err := primitive.ObjectIDFromHex(id)
	if err != nil {
		return errors.New("invalid ID format")
	}

	// Delete the user
	_, err = r.collection.DeleteOne(ctx, bson.M{"_id": objID})
	return err
}

// List returns a paginated list of users
func (r *UserMongoRepository) List(limit, offset int) ([]models.User, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Set pagination options
	opts := options.Find()
	opts.SetLimit(int64(limit))
	opts.SetSkip(int64(offset))
	opts.SetSort(bson.M{"created_at": -1}) // Sort by creation date, newest first

	// Find users
	cursor, err := r.collection.Find(ctx, bson.M{}, opts)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	// Decode results
	var users []models.User
	if err = cursor.All(ctx, &users); err != nil {
		return nil, err
	}

	return users, nil
}
```

### API Handlers

Now let's implement the API handlers using Gin:

```go
// api/handlers.go
package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/yourusername/my-go-mongodb-service/models"
)

// UserHandler handles HTTP requests for users
type UserHandler struct {
	userRepo models.UserRepository
}

// NewUserHandler creates a new user handler
func NewUserHandler(userRepo models.UserRepository) *UserHandler {
	return &UserHandler{
		userRepo: userRepo,
	}
}

// RegisterRoutes registers the user routes
func (h *UserHandler) RegisterRoutes(router *gin.Engine) {
	users := router.Group("/api/users")
	{
		users.POST("/", h.CreateUser)
		users.GET("/", h.ListUsers)
		users.GET("/:id", h.GetUser)
		users.PUT("/:id", h.UpdateUser)
		users.DELETE("/:id", h.DeleteUser)
	}
}

// CreateUser creates a new user
func (h *UserHandler) CreateUser(c *gin.Context) {
	var user models.User
	if err := c.ShouldBindJSON(&user); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// TODO: Add validation and password hashing in a real app

	createdUser, err := h.userRepo.Create(user)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create user"})
		return
	}

	c.JSON(http.StatusCreated, createdUser)
}

// GetUser gets a user by ID
func (h *UserHandler) GetUser(c *gin.Context) {
	id := c.Param("id")
	user, err := h.userRepo.FindByID(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	c.JSON(http.StatusOK, user)
}

// UpdateUser updates a user
func (h *UserHandler) UpdateUser(c *gin.Context) {
	id := c.Param("id")
	
	// First, find the existing user
	existingUser, err := h.userRepo.FindByID(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	
	// Bind the update data
	var updatedData models.User
	if err := c.ShouldBindJSON(&updatedData); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	
	// Update fields but preserve the ID
	updatedData.ID = existingUser.ID
	
	// Update the user
	if err := h.userRepo.Update(updatedData); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update user"})
		return
	}
	
	c.JSON(http.StatusOK, gin.H{"message": "User updated successfully"})
}

// DeleteUser deletes a user
func (h *UserHandler) DeleteUser(c *gin.Context) {
	id := c.Param("id")
	
	if err := h.userRepo.Delete(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete user"})
		return
	}
	
	c.JSON(http.StatusOK, gin.H{"message": "User deleted successfully"})
}

// ListUsers lists users with pagination
func (h *UserHandler) ListUsers(c *gin.Context) {
	// Parse pagination parameters
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "10"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	
	// Get users
	users, err := h.userRepo.List(limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to retrieve users"})
		return
	}
	
	c.JSON(http.StatusOK, gin.H{
		"data": users,
		"pagination": gin.H{
			"limit":  limit,
			"offset": offset,
			"count":  len(users),
		},
	})
}
```

### Main Application

Now, let's wire everything together in our main.go file:

```go
// main.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yourusername/my-go-mongodb-service/api"
	"github.com/yourusername/my-go-mongodb-service/config"
	"github.com/yourusername/my-go-mongodb-service/repository"
)

func main() {
	// Load configuration
	cfg := config.Load()

	// Set Gin mode based on environment
	if cfg.Env == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	// Create a new Gin router
	router := gin.Default()

	// Set up middleware
	router.Use(gin.Recovery())
	
	// Connect to MongoDB
	mongoRepo, err := repository.NewMongoRepository(cfg.MongoURI, cfg.DatabaseName)
	if err != nil {
		log.Fatalf("Failed to connect to MongoDB: %v", err)
	}
	
	// Setup repositories
	userRepo := repository.NewUserMongoRepository(mongoRepo)
	
	// Setup handlers
	userHandler := api.NewUserHandler(userRepo)
	userHandler.RegisterRoutes(router)
	
	// Add health check endpoint
	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	
	// Create HTTP server
	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: router,
	}
	
	// Start the server in a goroutine
	go func() {
		log.Printf("Starting server on port %s", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start server: %v", err)
		}
	}()
	
	// Wait for interrupt signal to gracefully shut down the server
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down server...")
	
	// Create a deadline to wait for current operations to complete
	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	
	// Shutdown the server
	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}
	
	// Close MongoDB connection
	if err := mongoRepo.Close(ctx); err != nil {
		log.Fatalf("Error closing MongoDB connection: %v", err)
	}
	
	log.Println("Server exited properly")
}
```

## Section 3: Running and Testing the Application

Now let's run and test our application.

### Starting the Services

Use Docker Compose to start all of the services:

```bash
docker-compose up -d
```

This will start:
1. MongoDB database
2. Mongo Express admin interface (available at http://localhost:8081)
3. Our Go API service (available at http://localhost:8080)

### Testing the API with curl

Let's test our API endpoints:

1. Create a user:

```bash
curl -X POST http://localhost:8080/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"John Doe","email":"john@example.com","password":"secure123"}'
```

Expected response:
```json
{
  "id":"60f1a5c86e614c006892a123",
  "name":"John Doe",
  "email":"john@example.com",
  "created_at":"2025-05-20T19:23:45.123Z",
  "updated_at":"2025-05-20T19:23:45.123Z"
}
```

2. List users:

```bash
curl http://localhost:8080/api/users
```

3. Get a specific user:

```bash
curl http://localhost:8080/api/users/60f1a5c86e614c006892a123
```

4. Update a user:

```bash
curl -X PUT http://localhost:8080/api/users/60f1a5c86e614c006892a123 \
  -H "Content-Type: application/json" \
  -d '{"name":"John Updated","email":"john.updated@example.com"}'
```

5. Delete a user:

```bash
curl -X DELETE http://localhost:8080/api/users/60f1a5c86e614c006892a123
```

### Accessing Mongo Express

The Mongo Express UI is accessible at http://localhost:8081. You can use it to:

1. View databases and collections
2. Create, read, update, and delete documents
3. Execute MongoDB queries
4. Manage indexes

## Section 4: Production Considerations

For production deployments, several additional considerations are needed.

### Production Dockerfile

Create a `docker/Dockerfile.prod` for production use:

```dockerfile
FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -o app .

FROM alpine:3.19

RUN apk --no-cache add ca-certificates tzdata

WORKDIR /root/

COPY --from=builder /app/app .

CMD ["./app"]
```

### Security Enhancements

Add these security enhancements for production:

1. Password Hashing:

```go
// Add to your user repository
import "golang.org/x/crypto/bcrypt"

// HashPassword hashes a password
func HashPassword(password string) (string, error) {
    bytes, err := bcrypt.GenerateFromPassword([]byte(password), 14)
    return string(bytes), err
}

// CheckPasswordHash compares a password with a hash
func CheckPasswordHash(password, hash string) bool {
    err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
    return err == nil
}
```

2. Environment Configuration:
   - Use a separate MongoDB instance for production
   - Use secrets management for credentials
   - Implement proper TLS/SSL for all connections

3. Authentication:
   - Add JWT-based authentication
   - Implement proper authorization middleware
   - Use HTTPS in production

### Kubernetes Deployment

For production deployment on Kubernetes, create the following manifests:

```yaml
# kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-api
  labels:
    app: go-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: go-api
  template:
    metadata:
      labels:
        app: go-api
    spec:
      containers:
      - name: api
        image: your-registry/go-api:latest
        ports:
        - containerPort: 8080
        env:
        - name: MONGODB_URI
          valueFrom:
            secretKeyRef:
              name: mongodb-secret
              key: connection-string
        - name: PORT
          value: "8080"
        - name: ENV
          value: "production"
        resources:
          limits:
            cpu: 500m
            memory: 512Mi
          requests:
            cpu: 100m
            memory: 128Mi
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
```

```yaml
# kubernetes/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: go-api
spec:
  selector:
    app: go-api
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP
```

```yaml
# kubernetes/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: go-api-ingress
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  rules:
  - host: api.yourservice.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: go-api
            port:
              number: 80
  tls:
  - hosts:
    - api.yourservice.com
    secretName: api-tls-secret
```

## Section 5: Advanced MongoDB Patterns

Let's explore some advanced MongoDB patterns for Go applications.

### Implementing Transactions

MongoDB supports multi-document transactions. Here's how to implement them:

```go
// repository/transaction.go
package repository

import (
	"context"
	"fmt"

	"go.mongodb.org/mongo-driver/mongo"
)

// WithTransaction executes a function within a MongoDB transaction
func (r *MongoRepository) WithTransaction(ctx context.Context, fn func(sessCtx mongo.SessionContext) error) error {
	session, err := r.client.StartSession()
	if err != nil {
		return fmt.Errorf("failed to start session: %w", err)
	}
	defer session.EndSession(ctx)

	// Execute the transaction
	err = session.WithTransaction(ctx, fn)
	if err != nil {
		return fmt.Errorf("transaction failed: %w", err)
	}

	return nil
}
```

Usage example:

```go
// Transferring money between accounts
err := repo.WithTransaction(ctx, func(sessCtx mongo.SessionContext) error {
	// Deduct from first account
	_, err := accountsCollection.UpdateOne(
		sessCtx,
		bson.M{"_id": sourceAccountID},
		bson.M{"$inc": bson.M{"balance": -amount}},
	)
	if err != nil {
		return err
	}

	// Add to second account
	_, err = accountsCollection.UpdateOne(
		sessCtx,
		bson.M{"_id": destinationAccountID},
		bson.M{"$inc": bson.M{"balance": amount}},
	)
	return err
})
```

### Creating Indexes for Performance

Proper indexes can dramatically improve query performance:

```go
// repository/mongodb.go
// Add to the NewMongoRepository function

// Create indexes
func (r *MongoRepository) CreateIndexes(ctx context.Context) error {
	// Create unique index on email field for users collection
	userCollection := r.GetCollection("users")
	_, err := userCollection.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "email", Value: 1}},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		return fmt.Errorf("failed to create email index: %w", err)
	}

	// Create compound index on created_at and name
	_, err = userCollection.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{
			{Key: "created_at", Value: 1},
			{Key: "name", Value: 1},
		},
	})
	if err != nil {
		return fmt.Errorf("failed to create compound index: %w", err)
	}

	return nil
}
```

### Implementing Data Pagination with Cursors

For large datasets, cursor-based pagination is more efficient:

```go
// repository/user_repository.go
// Add cursor-based pagination method

// ListWithCursor returns users using cursor-based pagination
func (r *UserMongoRepository) ListWithCursor(limit int, cursor string) ([]models.User, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Prepare query
	filter := bson.M{}
	
	// If cursor is provided, get records after this cursor
	if cursor != "" {
		cursorID, err := primitive.ObjectIDFromHex(cursor)
		if err != nil {
			return nil, "", errors.New("invalid cursor format")
		}
		filter["_id"] = bson.M{"$gt": cursorID}
	}

	// Set options
	opts := options.Find()
	opts.SetLimit(int64(limit + 1)) // Fetch one extra to determine next cursor
	opts.SetSort(bson.M{"_id": 1})  // Sort by _id for consistent ordering

	// Execute query
	cursor, err := r.collection.Find(ctx, filter, opts)
	if err != nil {
		return nil, "", err
	}
	defer cursor.Close(ctx)

	// Decode results
	var users []models.User
	if err = cursor.All(ctx, &users); err != nil {
		return nil, "", err
	}

	// Determine if there are more results and extract next cursor
	var nextCursor string
	if len(users) > limit {
		nextCursor = users[limit].ID.Hex()
		users = users[:limit] // Remove the extra item from the results
	}

	return users, nextCursor, nil
}
```

Add the corresponding handler:

```go
// api/handlers.go
// Add to UserHandler

// ListUsersCursor handles cursor-based pagination
func (h *UserHandler) ListUsersCursor(c *gin.Context) {
	// Parse parameters
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "10"))
	cursor := c.Query("cursor")
	
	// Get users with cursor
	users, nextCursor, err := h.userRepo.ListWithCursor(limit, cursor)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to retrieve users"})
		return
	}
	
	c.JSON(http.StatusOK, gin.H{
		"data": users,
		"pagination": gin.H{
			"next_cursor": nextCursor,
			"limit":       limit,
			"count":       len(users),
		},
	})
}
```

### Implementing Aggregation Pipeline for Advanced Queries

MongoDB's aggregation pipeline is powerful for complex queries:

```go
// Example: Get user statistics by creation date
func (r *UserMongoRepository) GetUserStatsByDate(ctx context.Context) ([]bson.M, error) {
	pipeline := mongo.Pipeline{
		{{"$group", bson.D{
			{"_id", bson.D{
				{"year", bson.D{{"$year", "$created_at"}}},
				{"month", bson.D{{"$month", "$created_at"}}},
				{"day", bson.D{{"$dayOfMonth", "$created_at"}}},
			}},
			{"count", bson.D{{"$sum", 1}}},
		}}},
		{{"$sort", bson.D{
			{"_id.year", 1},
			{"_id.month", 1},
			{"_id.day", 1},
		}}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err = cursor.All(ctx, &results); err != nil {
		return nil, err
	}

	return results, nil
}
```

## Conclusion

This guide covered setting up a complete local development environment for a Go microservice with MongoDB using Docker. We implemented:

1. A clean project structure using modern Go patterns
2. MongoDB integration with robust repository patterns
3. RESTful API endpoints using Gin
4. Docker-based development environment with hot reloading
5. Production considerations for deployment
6. Advanced MongoDB patterns for real-world applications

This architecture provides a solid foundation for building scalable, maintainable microservices that can be deployed in various environments while maintaining consistency across development, testing, and production.

By adopting container-based development with Docker, you eliminate the "it works on my machine" problem and ensure that all team members have an identical development experience, regardless of their operating system. This approach also makes it easy to onboard new team members and simplifies CI/CD pipeline integration.