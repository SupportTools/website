---
title: "Go Testing Best Practices: Mocks, Test Doubles, and Integration Test Strategies"
date: 2028-04-18T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Mocks", "Integration Testing", "testify"]
categories: ["Go", "Quality Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go testing patterns including table-driven tests, hand-written mocks, testify, gomock, test containers for integration testing, and structuring test suites for large services."
more_link: "yes"
url: "/go-testing-best-practices-mocks-guide/"
---

Testing in Go rewards simplicity. The standard library's `testing` package, combined with a handful of focused external libraries, is sufficient to build a high-confidence test suite for any production service. This guide covers every layer: unit tests with hand-crafted mocks, generated mocks with gomock, integration tests against real infrastructure via testcontainers, and the organizational patterns that keep large test suites maintainable.

<!--more-->

# Go Testing Best Practices

## Test Organization

### Package Layout

Go tests live alongside the code they test. Use two conventions:

- `package foo` (white-box): tests in the same package, access unexported symbols.
- `package foo_test` (black-box): tests in a separate package, test the public API only.

Most unit tests should be black-box. White-box tests are reserved for testing unexported helpers that are hard to reach through the public API.

```
service/
├── user.go             # package service
├── user_test.go        # package service_test  (black-box)
├── user_internal_test.go  # package service   (white-box, unexported)
└── user_integration_test.go  # package service_test, build tag: integration
```

### Build Tags for Slow Tests

```go
//go:build integration
// +build integration

package service_test

// This file only compiles when running: go test -tags integration
```

Run fast tests normally, slow tests on CI:

```bash
# Unit tests only (fast)
go test ./...

# Including integration tests
go test -tags integration ./...
```

## Table-Driven Tests

Table-driven tests are the idiomatic Go pattern. They reduce repetition and make it easy to add new cases.

```go
package validator_test

import (
    "testing"

    "yourorg/validator"
)

func TestValidateEmail(t *testing.T) {
    t.Parallel()

    tests := []struct {
        name    string
        input   string
        wantErr bool
    }{
        {
            name:    "valid simple email",
            input:   "user@example.com",
            wantErr: false,
        },
        {
            name:    "valid with subdomain",
            input:   "user@mail.example.co.uk",
            wantErr: false,
        },
        {
            name:    "missing @ symbol",
            input:   "userexample.com",
            wantErr: true,
        },
        {
            name:    "empty string",
            input:   "",
            wantErr: true,
        },
        {
            name:    "only @",
            input:   "@",
            wantErr: true,
        },
        {
            name:    "trailing dot in domain",
            input:   "user@example.",
            wantErr: true,
        },
        {
            name:    "international domain",
            input:   "user@例え.jp",
            wantErr: false,
        },
    }

    for _, tc := range tests {
        tc := tc // capture for parallel sub-test
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()
            err := validator.ValidateEmail(tc.input)
            if (err != nil) != tc.wantErr {
                t.Errorf("ValidateEmail(%q) error = %v, wantErr = %v",
                    tc.input, err, tc.wantErr)
            }
        })
    }
}
```

## Interfaces Enable Testing

The single most important design decision for testability in Go is to depend on interfaces, not concrete types.

```go
// Before: concrete dependency — impossible to test without a real database
type UserService struct {
    db *sql.DB
}

// After: interface dependency — can be replaced with a fake in tests
type UserRepository interface {
    FindByID(ctx context.Context, id string) (*User, error)
    Save(ctx context.Context, u *User) error
    Delete(ctx context.Context, id string) error
}

type UserService struct {
    repo UserRepository
    log  *slog.Logger
}
```

## Hand-Written Fakes

For simple cases, hand-written fakes are faster to write and easier to understand than generated mocks.

```go
// internal/testutil/fakes.go
package testutil

import (
    "context"
    "fmt"
    "sync"

    "yourorg/service"
)

// FakeUserRepository is an in-memory implementation for testing.
type FakeUserRepository struct {
    mu    sync.RWMutex
    users map[string]*service.User

    // CallCounts tracks how many times each method was called
    CallCounts struct {
        FindByID int
        Save     int
        Delete   int
    }

    // Errors lets tests inject specific errors
    Errors struct {
        FindByID error
        Save     error
        Delete   error
    }
}

func NewFakeUserRepository() *FakeUserRepository {
    return &FakeUserRepository{
        users: make(map[string]*service.User),
    }
}

func (r *FakeUserRepository) FindByID(ctx context.Context, id string) (*service.User, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    r.CallCounts.FindByID++

    if r.Errors.FindByID != nil {
        return nil, r.Errors.FindByID
    }
    u, ok := r.users[id]
    if !ok {
        return nil, service.ErrNotFound
    }
    // Return a copy to prevent test interference
    copy := *u
    return &copy, nil
}

func (r *FakeUserRepository) Save(ctx context.Context, u *service.User) error {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.CallCounts.Save++

    if r.Errors.Save != nil {
        return r.Errors.Save
    }
    copy := *u
    r.users[u.ID] = &copy
    return nil
}

func (r *FakeUserRepository) Delete(ctx context.Context, id string) error {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.CallCounts.Delete++

    if r.Errors.Delete != nil {
        return r.Errors.Delete
    }
    if _, ok := r.users[id]; !ok {
        return service.ErrNotFound
    }
    delete(r.users, id)
    return nil
}

// Seed adds users directly to the repository without going through Save.
func (r *FakeUserRepository) Seed(users ...*service.User) {
    r.mu.Lock()
    defer r.mu.Unlock()
    for _, u := range users {
        copy := *u
        r.users[u.ID] = &copy
    }
}

// All returns all stored users, useful for post-test assertions.
func (r *FakeUserRepository) All() []*service.User {
    r.mu.RLock()
    defer r.mu.RUnlock()
    result := make([]*service.User, 0, len(r.users))
    for _, u := range r.users {
        copy := *u
        result = append(result, &copy)
    }
    return result
}
```

### Using the Fake in Tests

```go
func TestUserService_CreateUser(t *testing.T) {
    t.Parallel()

    repo := testutil.NewFakeUserRepository()
    svc := service.NewUserService(repo, slog.Default())

    user, err := svc.CreateUser(context.Background(), service.CreateUserInput{
        Email: "alice@example.com",
        Name:  "Alice Smith",
    })
    require.NoError(t, err)
    require.NotEmpty(t, user.ID)
    assert.Equal(t, "alice@example.com", user.Email)

    // Verify it was persisted
    assert.Equal(t, 1, repo.CallCounts.Save)
    all := repo.All()
    require.Len(t, all, 1)
    assert.Equal(t, user.ID, all[0].ID)
}

func TestUserService_CreateUser_RepositoryError(t *testing.T) {
    t.Parallel()

    repo := testutil.NewFakeUserRepository()
    repo.Errors.Save = errors.New("database unavailable")
    svc := service.NewUserService(repo, slog.Default())

    _, err := svc.CreateUser(context.Background(), service.CreateUserInput{
        Email: "alice@example.com",
        Name:  "Alice Smith",
    })
    require.Error(t, err)
    assert.Contains(t, err.Error(), "database unavailable")
}
```

## gomock: Generated Mocks

For complex interfaces with many methods or when you need precise call verification, use `gomock`.

```bash
go install go.uber.org/mock/mockgen@latest

# Generate mocks for an interface
mockgen \
  -source=pkg/service/interfaces.go \
  -destination=pkg/service/mocks/mock_interfaces.go \
  -package=mocks
```

### Using gomock

```go
package service_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "go.uber.org/mock/gomock"

    "yourorg/service"
    "yourorg/service/mocks"
)

func TestUserService_GetUser_WithMock(t *testing.T) {
    ctrl := gomock.NewController(t)
    // ctrl.Finish() is called automatically in Go 1.14+ via t.Cleanup

    mockRepo := mocks.NewMockUserRepository(ctrl)
    svc := service.NewUserService(mockRepo, slog.Default())

    expectedUser := &service.User{
        ID:    "user-123",
        Email: "alice@example.com",
        Name:  "Alice Smith",
    }

    // Expect exactly one call with specific arguments
    mockRepo.EXPECT().
        FindByID(gomock.Any(), "user-123").
        Return(expectedUser, nil).
        Times(1)

    got, err := svc.GetUser(context.Background(), "user-123")
    assert.NoError(t, err)
    assert.Equal(t, expectedUser.Email, got.Email)
}

func TestUserService_GetUser_CachesResult(t *testing.T) {
    ctrl := gomock.NewController(t)
    mockRepo := mocks.NewMockUserRepository(ctrl)
    svc := service.NewUserService(mockRepo, slog.Default())

    expectedUser := &service.User{ID: "user-123", Email: "alice@example.com"}

    // Repository should only be called ONCE even though we call GetUser twice
    mockRepo.EXPECT().
        FindByID(gomock.Any(), "user-123").
        Return(expectedUser, nil).
        Times(1)

    _, err := svc.GetUser(context.Background(), "user-123")
    require.NoError(t, err)

    _, err = svc.GetUser(context.Background(), "user-123")
    require.NoError(t, err)
}

func TestUserService_DeleteUser_CallsRepository(t *testing.T) {
    ctrl := gomock.NewController(t)
    mockRepo := mocks.NewMockUserRepository(ctrl)
    svc := service.NewUserService(mockRepo, slog.Default())

    // Use InOrder to verify call sequence
    gomock.InOrder(
        mockRepo.EXPECT().FindByID(gomock.Any(), "user-123").
            Return(&service.User{ID: "user-123"}, nil),
        mockRepo.EXPECT().Delete(gomock.Any(), "user-123").
            Return(nil),
    )

    err := svc.DeleteUser(context.Background(), "user-123")
    assert.NoError(t, err)
}
```

### Custom Matchers

```go
// Match arguments by predicate
type emailMatcher struct {
    domain string
}

func (m emailMatcher) Matches(x interface{}) bool {
    input, ok := x.(service.CreateUserInput)
    if !ok {
        return false
    }
    return strings.HasSuffix(input.Email, "@"+m.domain)
}

func (m emailMatcher) String() string {
    return fmt.Sprintf("email ending with @%s", m.domain)
}

func HasEmailDomain(domain string) gomock.Matcher {
    return emailMatcher{domain: domain}
}

// Usage:
mockRepo.EXPECT().
    Save(gomock.Any(), HasEmailDomain("example.com")).
    Return(nil)
```

## testify: Assertions and Test Suites

```go
import (
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/stretchr/testify/suite"
)

// assert: test continues even after failure
// require: test stops immediately on failure (like Fatal)

func TestSomething(t *testing.T) {
    got, err := doSomething()
    require.NoError(t, err)          // Stop if error
    assert.Equal(t, "expected", got) // Continue checking

    assert.ElementsMatch(t, []int{1, 2, 3}, []int{3, 1, 2}) // Order-insensitive
    assert.JSONEq(t, `{"a":1}`, `{"a": 1}`)                 // JSON semantics
    assert.ErrorIs(t, err, ErrNotFound)                       // Error chain
    assert.ErrorAs(t, err, &target)                           // Error type
    assert.Eventually(t, condition, timeout, pollInterval)    // Polling
    assert.Never(t, condition, timeout, pollInterval)         // Never true
}
```

### Test Suite

Use `suite.Suite` for test cases that share setup/teardown:

```go
package service_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/suite"
)

type UserServiceSuite struct {
    suite.Suite
    repo *testutil.FakeUserRepository
    svc  *service.UserService
}

// SetupTest runs before each test in the suite.
func (s *UserServiceSuite) SetupTest() {
    s.repo = testutil.NewFakeUserRepository()
    s.svc = service.NewUserService(s.repo, slog.Default())
}

// Seed some baseline data before every test.
func (s *UserServiceSuite) SetupSubTest() {
    s.repo.Seed(
        &service.User{ID: "user-1", Email: "alice@example.com"},
        &service.User{ID: "user-2", Email: "bob@example.com"},
    )
}

func (s *UserServiceSuite) TestGetUser_Found() {
    u, err := s.svc.GetUser(context.Background(), "user-1")
    s.Require().NoError(err)
    s.Equal("alice@example.com", u.Email)
}

func (s *UserServiceSuite) TestGetUser_NotFound() {
    _, err := s.svc.GetUser(context.Background(), "nonexistent")
    s.ErrorIs(err, service.ErrNotFound)
}

func (s *UserServiceSuite) TestCreateUser_DuplicateEmail() {
    _, err := s.svc.CreateUser(context.Background(), service.CreateUserInput{
        Email: "alice@example.com", // Already exists
        Name:  "Another Alice",
    })
    s.ErrorIs(err, service.ErrDuplicateEmail)
}

// TestUserServiceSuite is the single entry point for the suite.
func TestUserServiceSuite(t *testing.T) {
    suite.Run(t, new(UserServiceSuite))
}
```

## Integration Tests with testcontainers-go

Real infrastructure tests catch bugs that mocks miss (SQL query errors, transaction semantics, network behavior).

```bash
go get github.com/testcontainers/testcontainers-go
go get github.com/testcontainers/testcontainers-go/modules/postgres
go get github.com/testcontainers/testcontainers-go/modules/redis
```

### PostgreSQL Integration Test

```go
//go:build integration

package repository_test

import (
    "context"
    "testing"

    "github.com/stretchr/testify/require"
    "github.com/stretchr/testify/suite"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"

    "yourorg/repository"
)

type PostgresRepoSuite struct {
    suite.Suite
    container *postgres.PostgresContainer
    repo      *repository.PostgresUserRepository
    ctx       context.Context
    cancel    context.CancelFunc
}

func (s *PostgresRepoSuite) SetupSuite() {
    s.ctx, s.cancel = context.WithCancel(context.Background())

    var err error
    s.container, err = postgres.RunContainer(s.ctx,
        testcontainers.WithImage("postgres:16-alpine"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("testpassword"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(60*time.Second),
        ),
    )
    s.Require().NoError(err)

    connStr, err := s.container.ConnectionString(s.ctx, "sslmode=disable")
    s.Require().NoError(err)

    s.repo, err = repository.NewPostgresUserRepository(s.ctx, connStr)
    s.Require().NoError(err)

    // Run migrations
    s.Require().NoError(s.repo.Migrate(s.ctx))
}

func (s *PostgresRepoSuite) TearDownSuite() {
    s.repo.Close()
    s.container.Terminate(s.ctx)
    s.cancel()
}

func (s *PostgresRepoSuite) SetupTest() {
    // Truncate tables between tests for isolation
    s.Require().NoError(s.repo.Truncate(s.ctx))
}

func (s *PostgresRepoSuite) TestSave_AndFindByID() {
    user := &service.User{
        ID:    "user-abc",
        Email: "alice@example.com",
        Name:  "Alice Smith",
    }

    err := s.repo.Save(s.ctx, user)
    s.Require().NoError(err)

    found, err := s.repo.FindByID(s.ctx, "user-abc")
    s.Require().NoError(err)
    s.Equal(user.Email, found.Email)
    s.Equal(user.Name, found.Name)
}

func (s *PostgresRepoSuite) TestFindByID_NotFound() {
    _, err := s.repo.FindByID(s.ctx, "nonexistent")
    s.ErrorIs(err, service.ErrNotFound)
}

func (s *PostgresRepoSuite) TestSave_DuplicateID_Updates() {
    user := &service.User{ID: "user-1", Email: "alice@example.com"}
    s.Require().NoError(s.repo.Save(s.ctx, user))

    // Update email
    updated := &service.User{ID: "user-1", Email: "alice-new@example.com"}
    s.Require().NoError(s.repo.Save(s.ctx, updated))

    found, err := s.repo.FindByID(s.ctx, "user-1")
    s.Require().NoError(err)
    s.Equal("alice-new@example.com", found.Email)
}

func (s *PostgresRepoSuite) TestConcurrentWrites() {
    const numWorkers = 20
    errCh := make(chan error, numWorkers)

    var wg sync.WaitGroup
    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func(i int) {
            defer wg.Done()
            user := &service.User{
                ID:    fmt.Sprintf("user-%d", i),
                Email: fmt.Sprintf("user%d@example.com", i),
            }
            errCh <- s.repo.Save(s.ctx, user)
        }(i)
    }
    wg.Wait()
    close(errCh)

    for err := range errCh {
        s.Require().NoError(err)
    }

    // Verify all were written
    count, err := s.repo.Count(s.ctx)
    s.Require().NoError(err)
    s.Equal(numWorkers, count)
}

func TestPostgresRepoSuite(t *testing.T) {
    suite.Run(t, new(PostgresRepoSuite))
}
```

### Redis Integration Test

```go
//go:build integration

func TestRedisCache_SetAndGet(t *testing.T) {
    ctx := context.Background()

    redisC, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: testcontainers.ContainerRequest{
            Image:        "redis:7-alpine",
            ExposedPorts: []string{"6379/tcp"},
            WaitingFor:   wait.ForLog("Ready to accept connections"),
        },
        Started: true,
    })
    require.NoError(t, err)
    defer redisC.Terminate(ctx)

    host, _ := redisC.Host(ctx)
    port, _ := redisC.MappedPort(ctx, "6379")

    cache, err := cache.NewRedisCache(fmt.Sprintf("redis://%s:%s", host, port.Port()))
    require.NoError(t, err)

    err = cache.Set(ctx, "key1", "value1", 5*time.Minute)
    require.NoError(t, err)

    got, err := cache.Get(ctx, "key1")
    require.NoError(t, err)
    assert.Equal(t, "value1", got)

    _, err = cache.Get(ctx, "nonexistent")
    assert.ErrorIs(t, err, cache.ErrCacheMiss)
}
```

## HTTP Handler Tests

Test HTTP handlers using `httptest`:

```go
func TestUsersHandler_GET(t *testing.T) {
    t.Parallel()

    repo := testutil.NewFakeUserRepository()
    repo.Seed(
        &service.User{ID: "1", Email: "alice@example.com", Name: "Alice"},
        &service.User{ID: "2", Email: "bob@example.com", Name: "Bob"},
    )

    svc := service.NewUserService(repo, slog.Default())
    handler := api.NewUsersHandler(svc)

    req := httptest.NewRequest(http.MethodGet, "/users", nil)
    req.Header.Set("Authorization", "Bearer "+generateTestJWT(t))
    rr := httptest.NewRecorder()

    handler.ServeHTTP(rr, req)

    assert.Equal(t, http.StatusOK, rr.Code)
    assert.Equal(t, "application/json", rr.Header().Get("Content-Type"))

    var response struct {
        Users []service.User `json:"users"`
        Total int            `json:"total"`
    }
    err := json.Unmarshal(rr.Body.Bytes(), &response)
    require.NoError(t, err)
    assert.Equal(t, 2, response.Total)
    assert.Len(t, response.Users, 2)
}

func TestUsersHandler_POST_Validation(t *testing.T) {
    tests := []struct {
        name       string
        body       string
        wantStatus int
        wantErrKey string
    }{
        {
            name:       "missing email",
            body:       `{"name":"Alice"}`,
            wantStatus: http.StatusBadRequest,
            wantErrKey: "email",
        },
        {
            name:       "invalid email",
            body:       `{"name":"Alice","email":"not-an-email"}`,
            wantStatus: http.StatusBadRequest,
            wantErrKey: "email",
        },
        {
            name:       "valid",
            body:       `{"name":"Alice","email":"alice@example.com"}`,
            wantStatus: http.StatusCreated,
        },
    }

    for _, tc := range tests {
        tc := tc
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()
            repo := testutil.NewFakeUserRepository()
            svc := service.NewUserService(repo, slog.Default())
            handler := api.NewUsersHandler(svc)

            req := httptest.NewRequest(http.MethodPost, "/users",
                strings.NewReader(tc.body))
            req.Header.Set("Content-Type", "application/json")
            rr := httptest.NewRecorder()

            handler.ServeHTTP(rr, req)
            assert.Equal(t, tc.wantStatus, rr.Code)

            if tc.wantErrKey != "" {
                assert.Contains(t, rr.Body.String(), tc.wantErrKey)
            }
        })
    }
}
```

## Benchmark Tests

```go
func BenchmarkUserService_GetUser_Cached(b *testing.B) {
    repo := testutil.NewFakeUserRepository()
    repo.Seed(&service.User{ID: "user-1", Email: "alice@example.com"})
    svc := service.NewUserService(repo, slog.Default())

    // Warm the cache
    _, _ = svc.GetUser(context.Background(), "user-1")

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            _, _ = svc.GetUser(context.Background(), "user-1")
        }
    })
}

func BenchmarkUserService_GetUser_NoCache(b *testing.B) {
    repo := testutil.NewFakeUserRepository()
    svc := service.NewUserService(repo, slog.Default()) // No cache

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        id := fmt.Sprintf("user-%d", i%100)
        repo.Seed(&service.User{ID: id, Email: id + "@example.com"})
        _, _ = svc.GetUser(context.Background(), id)
    }
}
```

Run benchmarks:

```bash
go test -bench=. -benchmem -benchtime=10s ./...
```

## Test Helpers and Golden Files

### Golden Files for Complex Output

```go
// testutil/golden.go
package testutil

import (
    "os"
    "path/filepath"
    "testing"
)

// AssertGolden compares got against a golden file.
// Run with -update to regenerate golden files.
var update = flag.Bool("update", false, "update golden files")

func AssertGolden(t *testing.T, name string, got []byte) {
    t.Helper()
    path := filepath.Join("testdata", name+".golden")

    if *update {
        os.MkdirAll(filepath.Dir(path), 0755)
        os.WriteFile(path, got, 0644)
        return
    }

    want, err := os.ReadFile(path)
    if err != nil {
        t.Fatalf("golden file %s not found; run with -update to create", path)
    }
    if !bytes.Equal(want, got) {
        t.Errorf("output mismatch for %s\ngot:\n%s\nwant:\n%s",
            name, got, want)
    }
}
```

Usage:

```go
func TestGenerateReport(t *testing.T) {
    svc := service.NewReportService(...)
    report, err := svc.Generate(ctx, reportInput)
    require.NoError(t, err)
    testutil.AssertGolden(t, "report-quarterly", report)
}

// First run: go test -run TestGenerateReport -update
// Subsequent: go test -run TestGenerateReport
```

## Test Coverage

```bash
# Run tests with coverage
go test -coverprofile=coverage.out ./...

# View coverage report in browser
go tool cover -html=coverage.out

# Coverage by function
go tool cover -func=coverage.out | sort -k3 -rn | head -20

# Fail if coverage drops below threshold (useful in CI)
go test -coverprofile=coverage.out ./...
COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | tr -d %)
if (( $(echo "$COVERAGE < 80" | bc -l) )); then
    echo "Coverage $COVERAGE% is below threshold 80%"
    exit 1
fi
```

## CI Configuration

```yaml
# .github/workflows/test.yaml
name: Test
on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
      - name: Unit tests
        run: go test -race -count=1 -coverprofile=coverage.out ./...
      - name: Coverage check
        run: |
          coverage=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | tr -d %)
          echo "Coverage: ${coverage}%"
          if (( $(echo "$coverage < 75" | bc -l) )); then exit 1; fi

  integration:
    runs-on: ubuntu-latest
    services:
      docker:
        image: docker:dind
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
      - name: Integration tests
        run: go test -tags integration -race -count=1 ./...
```

## Common Anti-Patterns to Avoid

**Testing implementation details**: Test behavior, not internals. If you need to change the mock expectation every time you refactor, your tests are coupled to implementation.

**Shared mutable state between tests**: Each test should set up its own fakes or use `t.Cleanup` to restore global state. Parallel tests sharing mutable state cause flaky failures.

**Ignoring -race**: Always run `go test -race` in CI. Data races that pass in sequential tests will eventually cause production incidents.

**Over-mocking**: If a test requires 15 mock expectations to exercise one code path, the code under test has too many dependencies. Refactor first, then test.

**Not testing error paths**: Error injection is the primary reason to use fakes over real databases in unit tests. Cover every `if err != nil` branch.

## Summary

A high-quality Go test suite follows a clear hierarchy:

1. **Unit tests** with hand-written fakes cover business logic quickly and in isolation.
2. **gomock** handles complex interfaces where call-order and argument verification matter.
3. **testify suites** organize related tests with shared setup.
4. **testcontainers integration tests** validate real database and network behavior.
5. **Benchmarks** guard against performance regressions.

The `testing` package plus testify and gomock cover the vast majority of Go testing needs without the complexity of larger test frameworks.
