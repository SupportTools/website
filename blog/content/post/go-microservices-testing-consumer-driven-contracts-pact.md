---
title: "Go Microservices Testing: Consumer-Driven Contracts with Pact"
date: 2029-08-23T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Pact", "Contract Testing", "Microservices", "CI/CD", "API Testing"]
categories: ["Go", "Testing", "Microservices"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to consumer-driven contract testing in Go microservices using the Pact framework: consumer test setup with pact-go, provider verification, Pact Broker integration, CI/CD pipeline configuration, and contract versioning strategies."
more_link: "yes"
url: "/go-microservices-testing-consumer-driven-contracts-pact/"
---

Contract testing solves the integration testing problem in microservices: how do you verify that a service change won't break its consumers without deploying everything to a shared environment and running expensive end-to-end tests? Consumer-driven contract testing with Pact lets each consumer define what it expects from a provider, publish those contracts to a broker, and have the provider verify against them automatically — decoupling deployment pipelines while maintaining integration confidence. This guide covers the full Pact workflow in Go.

<!--more-->

# Go Microservices Testing: Consumer-Driven Contracts with Pact

## Why Contract Testing

Integration tests in microservices suffer from a fundamental tension:
- **Scope**: testing N services together creates O(N²) interaction points
- **Stability**: a shared integration environment is flaky by nature
- **Feedback speed**: end-to-end tests take minutes to hours
- **Deployment coupling**: all services must be compatible before any can deploy

Contract testing changes the model:
1. The **consumer** (caller) writes a test that captures exactly what it sends and what it needs back
2. That test generates a **contract** (Pact file) describing the interaction
3. The **provider** (callee) verifies that contract against its actual implementation
4. Consumer and provider pipelines run independently — no shared environment needed

This is fundamentally different from provider-defined API contracts (like OpenAPI specs): the consumer defines what it actually uses, catching the common case where a provider removes a field used by only one consumer.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     Consumer CI Pipeline                         │
│                                                                  │
│  ┌─────────────┐   generates   ┌──────────────────────────────┐  │
│  │  Consumer   │ ──────────►   │  pact/consumer-provider.json │  │
│  │  Test       │               │  (the contract)              │  │
│  └─────────────┘               └──────────┬───────────────────┘  │
│                                           │ publishes            │
└───────────────────────────────────────────┼──────────────────────┘
                                            │
                               ┌────────────▼───────────────────────┐
                               │  Pact Broker                       │
                               │  (pactflow.io or self-hosted)      │
                               │  - stores contracts by version     │
                               │  - tracks verification results     │
                               │  - can-i-deploy checks             │
                               └────────────┬───────────────────────┘
                                            │ retrieves
┌───────────────────────────────────────────┼──────────────────────┐
│                     Provider CI Pipeline  │                      │
│                                           ▼                      │
│  ┌─────────────┐  verifies  ┌─────────────────────────────────┐  │
│  │  Provider   │ ─────────► │  Pact verification results      │  │
│  │  Test       │            │  published back to broker        │  │
│  └─────────────┘            └─────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Setting Up Pact Go

### Installation

```bash
# Install pact-go and the Pact FFI library
go get github.com/pact-foundation/pact-go/v2@latest

# Download the Pact FFI library (required for pact-go v2)
go install github.com/pact-foundation/pact-go/v2@latest
$(go env GOPATH)/bin/pact-go -l DEBUG install

# This installs the native Pact FFI library to:
# ~/.pact/bin/libpact_ffi.so (Linux)
# ~/.pact/bin/libpact_ffi.dylib (macOS)
```

## Consumer Test Setup

### The Consumer: Order Service calling User Service

```go
// services/orderservice/client/user_client.go
package client

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "time"
)

// User represents the data the order service needs from the user service
// NOTE: this is intentionally a subset of what the user service returns
// This is the contract: only the fields the consumer cares about
type User struct {
    ID       int    `json:"id"`
    Email    string `json:"email"`
    Name     string `json:"name"`
    Tier     string `json:"tier"`      // "standard" or "premium"
    Active   bool   `json:"active"`
}

type UserClient struct {
    baseURL    string
    httpClient *http.Client
}

func NewUserClient(baseURL string) *UserClient {
    return &UserClient{
        baseURL: baseURL,
        httpClient: &http.Client{
            Timeout: 10 * time.Second,
        },
    }
}

func (c *UserClient) GetUser(ctx context.Context, userID int) (*User, error) {
    url := fmt.Sprintf("%s/users/%d", c.baseURL, userID)
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
    if err != nil {
        return nil, fmt.Errorf("creating request: %w", err)
    }
    req.Header.Set("Accept", "application/json")

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return nil, fmt.Errorf("executing request: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode == http.StatusNotFound {
        return nil, fmt.Errorf("user %d not found", userID)
    }
    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
    }

    var user User
    if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
        return nil, fmt.Errorf("decoding response: %w", err)
    }

    return &user, nil
}
```

### Consumer Pact Test

```go
// services/orderservice/client/user_client_pact_test.go
package client_test

import (
    "context"
    "fmt"
    "testing"

    "github.com/pact-foundation/pact-go/v2/consumer"
    "github.com/pact-foundation/pact-go/v2/matchers"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "myapp/services/orderservice/client"
)

func TestUserClient_GetUser_Pact(t *testing.T) {
    // Set up the mock provider
    mockProvider, err := consumer.NewV4Pact(consumer.MockHTTPProviderConfig{
        Consumer: "OrderService",
        Provider: "UserService",
        PactDir:  "./pacts",
        LogDir:   "./logs",
        LogLevel: "INFO",
    })
    require.NoError(t, err)

    t.Run("get existing user returns user details", func(t *testing.T) {
        // Define the expected interaction
        err := mockProvider.
            AddInteraction().
            Given("User 123 exists and is active").
            UponReceiving("a request for user 123").
            WithRequest("GET", "/users/123").
            WithHeaders(map[string]matchers.Matcher{
                "Accept": matchers.String("application/json"),
            }).
            WillRespondWith(200).
            WithHeaders(map[string]matchers.Matcher{
                "Content-Type": matchers.Regex("application/json", "application/json.*"),
            }).
            WithBodyMatch(&client.User{
                // Use matchers to allow for flexible matching
                // This makes the contract less brittle
            }, map[string]matchers.Matcher{
                "id":     matchers.Integer(123),
                "email":  matchers.Regex("user@example.com", `^[^@]+@[^@]+\.[^@]+$`),
                "name":   matchers.String("John Doe"),
                "tier":   matchers.OneOf("standard", "premium"),
                "active": matchers.Boolean(true),
            }).
            ExecuteTest(t, func(config consumer.MockServerConfig) error {
                // The test runs against the Pact mock server
                userClient := client.NewUserClient(
                    fmt.Sprintf("http://localhost:%d", config.Port),
                )

                user, err := userClient.GetUser(context.Background(), 123)
                require.NoError(t, err)

                assert.Equal(t, 123, user.ID)
                assert.NotEmpty(t, user.Email)
                assert.NotEmpty(t, user.Name)
                assert.Contains(t, []string{"standard", "premium"}, user.Tier)
                assert.True(t, user.Active)

                return nil
            })

        require.NoError(t, err)
    })

    t.Run("get non-existent user returns 404", func(t *testing.T) {
        err := mockProvider.
            AddInteraction().
            Given("User 999 does not exist").
            UponReceiving("a request for non-existent user 999").
            WithRequest("GET", "/users/999").
            WillRespondWith(404).
            WithBody(map[string]matchers.Matcher{
                "error":   matchers.String("user not found"),
                "user_id": matchers.Integer(999),
            }).
            ExecuteTest(t, func(config consumer.MockServerConfig) error {
                userClient := client.NewUserClient(
                    fmt.Sprintf("http://localhost:%d", config.Port),
                )

                _, err := userClient.GetUser(context.Background(), 999)
                require.Error(t, err)
                assert.Contains(t, err.Error(), "not found")

                return nil
            })

        require.NoError(t, err)
    })

    t.Run("premium user has correct tier", func(t *testing.T) {
        err := mockProvider.
            AddInteraction().
            Given("User 456 is a premium tier user").
            UponReceiving("a request for premium user 456").
            WithRequest("GET", "/users/456").
            WillRespondWith(200).
            WithBody(map[string]matchers.Matcher{
                "id":     matchers.Integer(456),
                "email":  matchers.Regex("premium@example.com", `^[^@]+@[^@]+\.[^@]+$`),
                "name":   matchers.String("Jane Smith"),
                "tier":   matchers.String("premium"),
                "active": matchers.Boolean(true),
            }).
            ExecuteTest(t, func(config consumer.MockServerConfig) error {
                userClient := client.NewUserClient(
                    fmt.Sprintf("http://localhost:%d", config.Port),
                )

                user, err := userClient.GetUser(context.Background(), 456)
                require.NoError(t, err)
                assert.Equal(t, "premium", user.Tier)

                return nil
            })

        require.NoError(t, err)
    })
}
```

### Publishing Contracts to Pact Broker

```go
// scripts/publish_pacts.go
package main

import (
    "fmt"
    "os"

    "github.com/pact-foundation/pact-go/v2/publisher"
)

func main() {
    brokerURL := os.Getenv("PACT_BROKER_URL")
    brokerToken := os.Getenv("PACT_BROKER_TOKEN")
    consumerVersion := os.Getenv("GIT_COMMIT")  // Use Git SHA as version
    branch := os.Getenv("GIT_BRANCH")

    if brokerURL == "" || consumerVersion == "" {
        fmt.Fprintln(os.Stderr, "PACT_BROKER_URL and GIT_COMMIT are required")
        os.Exit(1)
    }

    p := publisher.New()
    err := p.
        WithConsumerVersion(consumerVersion).
        WithBranch(branch).
        WithPactFilesOrDirs("./services/orderservice/client/pacts").
        WithBrokerURL(brokerURL).
        WithBrokerToken(brokerToken).
        Publish()

    if err != nil {
        fmt.Fprintf(os.Stderr, "Error publishing pacts: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("Pacts published successfully (version: %s, branch: %s)\n",
        consumerVersion, branch)
}
```

```bash
# Or use the pact CLI directly
pact-broker publish \
  --pact-files-or-dirs ./services/orderservice/client/pacts \
  --consumer-app-version $(git rev-parse HEAD) \
  --branch $(git rev-parse --abbrev-ref HEAD) \
  --broker-base-url https://mycompany.pactflow.io \
  --broker-token $PACT_BROKER_TOKEN \
  --tag production  # Tag contracts that match deployed versions
```

## Provider Verification

### Provider Test Setup

```go
// services/userservice/pact_test.go
package userservice_test

import (
    "fmt"
    "log"
    "net/http"
    "os"
    "testing"

    "github.com/pact-foundation/pact-go/v2/provider"
    "github.com/stretchr/testify/assert"

    "myapp/services/userservice"
    "myapp/services/userservice/testhelpers"
)

// TestUserServicePactVerification verifies all consumer contracts
// against the actual UserService implementation
func TestUserServicePactVerification(t *testing.T) {
    // Start the real UserService server with a test database
    testDB := testhelpers.NewTestDatabase(t)
    server := userservice.NewServer(testDB.DB)

    // Start the HTTP server on a random port
    httpServer := &http.Server{Handler: server.Handler()}
    lis, err := net.Listen("tcp", "127.0.0.1:0")
    if err != nil {
        t.Fatalf("failed to listen: %v", err)
    }
    go httpServer.Serve(lis)
    defer httpServer.Close()

    port := lis.Addr().(*net.TCPAddr).Port

    // Configure the Pact verifier
    verifier := provider.NewVerifier()

    err = verifier.VerifyProvider(t, provider.VerifyRequest{
        ProviderBaseURL: fmt.Sprintf("http://localhost:%d", port),

        // Fetch pacts from broker
        BrokerURL:   os.Getenv("PACT_BROKER_URL"),
        BrokerToken: os.Getenv("PACT_BROKER_TOKEN"),

        // Only verify pacts from consumers that we know about
        ConsumerVersionSelectors: []provider.ConsumerVersionSelector{
            // Verify the latest pact from each consumer's main branch
            {MainBranch: true},
            // Verify pacts currently deployed to production
            {DeployedOrReleased: true},
        },

        Provider:        "UserService",
        ProviderVersion: os.Getenv("GIT_COMMIT"),
        ProviderBranch:  os.Getenv("GIT_BRANCH"),

        // State handlers: set up the database state for each interaction
        StateHandlers: provider.StateHandlers{
            "User 123 exists and is active": func(setup bool, s provider.ProviderState) (provider.ProviderStateResponse, error) {
                if setup {
                    testDB.InsertUser(testhelpers.User{
                        ID:     123,
                        Email:  "user123@example.com",
                        Name:   "John Doe",
                        Tier:   "standard",
                        Active: true,
                    })
                } else {
                    testDB.DeleteUser(123)
                }
                return nil, nil
            },

            "User 999 does not exist": func(setup bool, s provider.ProviderState) (provider.ProviderStateResponse, error) {
                if setup {
                    testDB.DeleteUser(999) // Ensure it doesn't exist
                }
                return nil, nil
            },

            "User 456 is a premium tier user": func(setup bool, s provider.ProviderState) (provider.ProviderStateResponse, error) {
                if setup {
                    testDB.InsertUser(testhelpers.User{
                        ID:     456,
                        Email:  "premium456@example.com",
                        Name:   "Jane Smith",
                        Tier:   "premium",
                        Active: true,
                    })
                } else {
                    testDB.DeleteUser(456)
                }
                return nil, nil
            },
        },

        // Publish verification results back to the broker
        PublishVerificationResults: os.Getenv("CI") == "true",

        FailIfNoPactsFound: false,
    })

    assert.NoError(t, err)
}
```

### Local Provider Verification (without broker)

```go
// For local development: verify against local pact files
func TestUserServicePactVerification_Local(t *testing.T) {
    // ... server setup same as above ...

    verifier := provider.NewVerifier()

    err = verifier.VerifyProvider(t, provider.VerifyRequest{
        ProviderBaseURL: fmt.Sprintf("http://localhost:%d", port),

        // Use local pact files instead of broker
        PactURLs: []string{
            "./pacts/OrderService-UserService.json",
            "./pacts/InventoryService-UserService.json",
        },

        Provider: "UserService",

        StateHandlers: provider.StateHandlers{
            // ... same state handlers
        },
    })

    assert.NoError(t, err)
}
```

### Test Helpers

```go
// services/userservice/testhelpers/database.go
package testhelpers

import (
    "database/sql"
    "fmt"
    "testing"

    _ "github.com/lib/pq"
    "github.com/ory/dockertest/v3"
    "github.com/ory/dockertest/v3/docker"
)

type TestDatabase struct {
    DB       *sql.DB
    pool     *dockertest.Pool
    resource *dockertest.Resource
    t        *testing.T
}

type User struct {
    ID     int
    Email  string
    Name   string
    Tier   string
    Active bool
}

func NewTestDatabase(t *testing.T) *TestDatabase {
    t.Helper()

    pool, err := dockertest.NewPool("")
    if err != nil {
        t.Fatalf("could not connect to docker: %v", err)
    }

    resource, err := pool.RunWithOptions(&dockertest.RunOptions{
        Repository: "postgres",
        Tag:        "15-alpine",
        Env: []string{
            "POSTGRES_PASSWORD=test",
            "POSTGRES_USER=test",
            "POSTGRES_DB=userservice_test",
        },
    }, func(config *docker.HostConfig) {
        config.AutoRemove = true
        config.RestartPolicy = docker.RestartPolicy{Name: "no"}
    })
    if err != nil {
        t.Fatalf("could not start postgres: %v", err)
    }

    var db *sql.DB
    if err := pool.Retry(func() error {
        var err error
        db, err = sql.Open("postgres", fmt.Sprintf(
            "host=localhost port=%s user=test password=test dbname=userservice_test sslmode=disable",
            resource.GetPort("5432/tcp"),
        ))
        if err != nil {
            return err
        }
        return db.Ping()
    }); err != nil {
        t.Fatalf("could not connect to postgres: %v", err)
    }

    // Run migrations
    _, err = db.Exec(`
        CREATE TABLE IF NOT EXISTS users (
            id     SERIAL PRIMARY KEY,
            email  TEXT UNIQUE NOT NULL,
            name   TEXT NOT NULL,
            tier   TEXT NOT NULL DEFAULT 'standard',
            active BOOLEAN NOT NULL DEFAULT true
        )
    `)
    if err != nil {
        t.Fatalf("running migrations: %v", err)
    }

    td := &TestDatabase{DB: db, pool: pool, resource: resource, t: t}

    t.Cleanup(func() {
        db.Close()
        pool.Purge(resource)
    })

    return td
}

func (td *TestDatabase) InsertUser(u User) {
    td.t.Helper()
    _, err := td.DB.Exec(
        "INSERT INTO users (id, email, name, tier, active) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET email=$2, name=$3, tier=$4, active=$5",
        u.ID, u.Email, u.Name, u.Tier, u.Active,
    )
    if err != nil {
        td.t.Fatalf("inserting user: %v", err)
    }
}

func (td *TestDatabase) DeleteUser(id int) {
    td.t.Helper()
    td.DB.Exec("DELETE FROM users WHERE id = $1", id)
}
```

## Pact Broker Setup

### Self-Hosted Pact Broker

```yaml
# pact-broker-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pact-broker
  namespace: testing
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pact-broker
  template:
    metadata:
      labels:
        app: pact-broker
    spec:
      containers:
        - name: pact-broker
          image: pactfoundation/pact-broker:2.107
          env:
            - name: PACT_BROKER_DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: pact-broker-db
                  key: database-url
            - name: PACT_BROKER_BASIC_AUTH_USERNAME
              value: "admin"
            - name: PACT_BROKER_BASIC_AUTH_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: pact-broker-credentials
                  key: password
            - name: PACT_BROKER_ALLOW_PUBLIC_READ
              value: "false"
            - name: PACT_BROKER_PUBLIC_HEARTBEAT
              value: "true"
          ports:
            - containerPort: 9292
          readinessProbe:
            httpGet:
              path: /diagnostic/status/heartbeat
              port: 9292
            initialDelaySeconds: 10
            periodSeconds: 10

---
apiVersion: v1
kind: Service
metadata:
  name: pact-broker
  namespace: testing
spec:
  selector:
    app: pact-broker
  ports:
    - port: 9292
      targetPort: 9292
```

### Pact Broker Database Setup

```bash
# Create PostgreSQL database for Pact Broker
kubectl -n testing apply -f - << 'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: pact-broker-db
  namespace: testing
type: Opaque
stringData:
  database-url: "postgresql://pact:pact_password@postgres.testing.svc.cluster.local/pact_broker"
EOF

# Initialize the database
kubectl -n testing run pact-db-init \
  --image=pactfoundation/pact-broker:2.107 \
  --rm -it \
  --env="PACT_BROKER_DATABASE_URL=postgresql://pact:pact_password@postgres.testing/pact_broker" \
  -- bundle exec rake db:migrate
```

## CI/CD Integration

### GitHub Actions: Consumer Pipeline

```yaml
# .github/workflows/consumer-ci.yaml
name: OrderService CI

on:
  push:
    paths:
      - 'services/orderservice/**'

env:
  PACT_BROKER_URL: https://pact-broker.mycompany.com
  SERVICE_NAME: OrderService

jobs:
  test-and-publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      - name: Install Pact FFI
        run: |
          go install github.com/pact-foundation/pact-go/v2@latest
          $(go env GOPATH)/bin/pact-go -l DEBUG install

      - name: Run consumer contract tests
        working-directory: services/orderservice
        run: go test ./client/... -run TestUserClient_GetUser_Pact -v
        env:
          LOG_LEVEL: INFO

      - name: Publish contracts to Pact Broker
        run: |
          pact-broker publish \
            --pact-files-or-dirs ./services/orderservice/client/pacts \
            --consumer-app-version ${{ github.sha }} \
            --branch ${{ github.ref_name }} \
            --broker-base-url ${{ env.PACT_BROKER_URL }} \
            --broker-token ${{ secrets.PACT_BROKER_TOKEN }}

      - name: Can I Deploy?
        run: |
          pact-broker can-i-deploy \
            --pacticipant OrderService \
            --version ${{ github.sha }} \
            --to-environment production \
            --broker-base-url ${{ env.PACT_BROKER_URL }} \
            --broker-token ${{ secrets.PACT_BROKER_TOKEN }}

  deploy:
    needs: test-and-publish
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - name: Deploy OrderService
        run: |
          # Your deployment steps here
          echo "Deploying OrderService ${{ github.sha }}"

      - name: Record deployment in Pact Broker
        run: |
          pact-broker record-deployment \
            --pacticipant OrderService \
            --version ${{ github.sha }} \
            --environment production \
            --broker-base-url ${{ env.PACT_BROKER_URL }} \
            --broker-token ${{ secrets.PACT_BROKER_TOKEN }}
```

### GitHub Actions: Provider Pipeline

```yaml
# .github/workflows/provider-ci.yaml
name: UserService CI

on:
  push:
    paths:
      - 'services/userservice/**'
  # Also run when a new consumer pact is published
  repository_dispatch:
    types: [pact_changed]

jobs:
  verify-contracts:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_USER: test
          POSTGRES_DB: userservice_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      - name: Install Pact FFI
        run: |
          go install github.com/pact-foundation/pact-go/v2@latest
          $(go env GOPATH)/bin/pact-go -l DEBUG install

      - name: Verify consumer contracts
        working-directory: services/userservice
        run: go test ./... -run TestUserServicePactVerification -v -timeout 300s
        env:
          CI: "true"
          GIT_COMMIT: ${{ github.sha }}
          GIT_BRANCH: ${{ github.ref_name }}
          PACT_BROKER_URL: ${{ vars.PACT_BROKER_URL }}
          PACT_BROKER_TOKEN: ${{ secrets.PACT_BROKER_TOKEN }}
          DATABASE_URL: "postgresql://test:test@localhost/userservice_test?sslmode=disable"

      - name: Can I Deploy?
        run: |
          pact-broker can-i-deploy \
            --pacticipant UserService \
            --version ${{ github.sha }} \
            --to-environment production \
            --broker-base-url ${{ vars.PACT_BROKER_URL }} \
            --broker-token ${{ secrets.PACT_BROKER_TOKEN }}
```

## Contract Versioning

### Tagging Strategies

```bash
# Tag strategies with pact-broker

# 1. Branch-based (recommended with Pact Broker 2.x+)
# Use --branch flag when publishing — no manual tagging needed

# 2. Environment-based tags for older workflows
pact-broker publish \
  --consumer-app-version $GIT_SHA \
  --tag main \          # Current branch
  --tag production \    # After successful deploy
  --broker-base-url $PACT_BROKER_URL \
  --broker-token $PACT_BROKER_TOKEN

# 3. Consumer version selectors — what provider tests verify
# In provider test code:
# provider.ConsumerVersionSelector{MainBranch: true}   — latest from main
# provider.ConsumerVersionSelector{DeployedOrReleased: true}  — what's in production
# provider.ConsumerVersionSelector{Branch: "feature-x"}  — specific branch
```

### Breaking Change Detection

```bash
# Before merging a consumer change, verify no provider breaking changes
pact-broker can-i-deploy \
  --pacticipant OrderService \
  --version $NEW_VERSION \
  --to-environment production \
  --broker-base-url $PACT_BROKER_URL \
  --broker-token $PACT_BROKER_TOKEN

# Output when safe to deploy:
# Computer says yes \o/
# CONSUMER       | C.VERSION | PROVIDER    | P.VERSION | SUCCESS?
# OrderService   | abc123    | UserService | def456    | true

# Output when not safe:
# Computer says no ¯\_(ツ)_/¯
# CONSUMER       | C.VERSION | PROVIDER    | P.VERSION | SUCCESS?
# OrderService   | abc123    | UserService | def456    | false
# (verification not found for this combination)
```

## Troubleshooting Common Issues

### Issue 1: Pact Verification Mismatch

```bash
# Run verification with verbose output
go test ./... -run TestUserServicePactVerification -v -pact-log-level=DEBUG

# Common causes:
# - Provider returns extra fields not in contract (fine — additive changes are OK)
# - Provider returns wrong type (int vs string)
# - Provider returns wrong HTTP status code
# - State handler not setting up correct test data

# Inspect the pact file directly
cat pacts/OrderService-UserService.json | python3 -m json.tool
```

### Issue 2: Consumer Test Fails with Unexpected Body

```go
// Use matchers to make contracts less brittle
// BAD: exact match — breaks when non-critical fields change
WillRespondWith(200).
WithBody(map[string]interface{}{
    "id":       123,
    "email":    "user@example.com",
    "name":     "John",
    // provider adds "created_at" field later = consumer contract test breaks
})

// GOOD: use matchers — only assert what the consumer actually uses
WithBodyMatch(&client.User{}, map[string]matchers.Matcher{
    "id":    matchers.Integer(123),
    "email": matchers.Regex("user@example.com", `^[^@]+@[^@]+\.[^@]+$`),
    "name":  matchers.String("John"),
    // Don't mention "created_at" — consumer doesn't use it
})
```

### Issue 3: State Handler Not Running

```bash
# Enable state handler debugging
PACT_LOG_LEVEL=DEBUG go test ./... -run TestUserServicePactVerification

# Verify state handler names match exactly between consumer and provider
# Consumer: .Given("User 123 exists and is active")
# Provider: StateHandlers{"User 123 exists and is active": func...}
# Any difference = state handler not called
```

Contract testing with Pact enables independent deployment of microservices while maintaining integration confidence. The investment in consumer and provider tests pays dividends at scale: deploy-time integration failures become pre-merge failures, and the blast radius of breaking changes is contained before they reach production.
