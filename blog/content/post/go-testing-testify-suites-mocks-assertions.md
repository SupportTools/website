---
title: "Go Testing with Testify: Suites, Mocks, and Assertion Chains"
date: 2029-10-20T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Testify", "Mocks", "Unit Testing", "TDD"]
categories: ["Go", "Testing", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to the testify testing toolkit in Go: assert vs require semantics, suite lifecycle hooks, mock expectations and call chains, parallel suite execution, and clock mocking for time-dependent code."
more_link: "yes"
url: "/go-testing-testify-suites-mocks-assertions/"
---

Go's built-in testing package provides the scaffolding: `*testing.T`, table-driven tests, and benchmarks. Testify fills in everything the standard library deliberately left out: rich assertions with meaningful failure messages, struct equality with diff output, mock generation, and suite-based test organization. Used well, testify makes Go test code as expressive as any other testing framework while staying idiomatic. Used carelessly, it produces tests that are brittle, impossible to parallelize, or harder to read than the code they test. This guide covers how to use it correctly.

<!--more-->

# Go Testing with Testify: Suites, Mocks, and Assertion Chains

## Section 1: testify/assert vs testify/require

The two most-used testify packages look nearly identical but have critically different semantics.

### assert: Continues After Failure

```go
func TestUserCreation(t *testing.T) {
    user, err := CreateUser("alice@example.com", "password123")

    // assert: records failure and CONTINUES test execution
    assert.NoError(t, err, "user creation should not fail")
    assert.NotNil(t, user, "created user should not be nil")
    assert.Equal(t, "alice@example.com", user.Email)
    assert.NotEmpty(t, user.ID, "user should have been assigned an ID")
    assert.True(t, user.CreatedAt.Before(time.Now()))
}
```

If `CreateUser` returns an error and `user` is nil, all subsequent assertions still run. The assertion `assert.Equal(t, "alice@example.com", user.Email)` will panic with a nil pointer dereference — which is worse than a test failure.

### require: Stops on First Failure

```go
func TestUserCreation(t *testing.T) {
    user, err := CreateUser("alice@example.com", "password123")

    // require: calls t.FailNow() on failure, stopping the test
    require.NoError(t, err, "user creation should not fail")
    require.NotNil(t, user, "created user should not be nil")

    // These only run if the above passed — safe to dereference user
    assert.Equal(t, "alice@example.com", user.Email)
    assert.NotEmpty(t, user.ID)
    assert.True(t, user.CreatedAt.Before(time.Now()))
}
```

The rule: **use `require` for preconditions** (errors from setup calls, nil checks before dereferencing) and **use `assert` for actual assertions** that should all be checked even if some fail (so you get the full picture of what's wrong in one test run).

### Common Assertion Patterns

```go
import (
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// Equality
assert.Equal(t, expected, actual)
assert.NotEqual(t, unexpected, actual)
assert.EqualValues(t, int32(5), int64(5)) // compares value, ignores type

// Nil / zero checks
assert.Nil(t, err)
assert.NotNil(t, result)
assert.Zero(t, counter)
assert.NotZero(t, id)

// String
assert.Contains(t, body, "success")
assert.NotContains(t, body, "error")
assert.HasPrefix(t, url, "https://")   // requires testify >= 1.8.4
assert.Regexp(t, `^user-\d+$`, userID)

// Slices and maps
assert.Len(t, items, 3)
assert.Empty(t, errors)
assert.ElementsMatch(t, []int{3, 1, 2}, []int{1, 2, 3}) // order-independent

// Error types
assert.ErrorIs(t, err, ErrNotFound)
assert.ErrorAs(t, err, &validationErr)
assert.EqualError(t, err, "record not found")

// Struct comparison with detailed diff
assert.Equal(t, expectedUser, actualUser)
// On failure: prints a colored diff of the two structs

// Approximate numeric comparison
assert.InDelta(t, 100.0, 100.1, 0.5) // within 0.5 of 100.0
assert.InEpsilon(t, 100.0, 101.0, 0.02) // within 2% relative difference
```

## Section 2: testify/suite — Lifecycle Hooks

The `suite` package provides an xUnit-style test organization with setup and teardown hooks. This is particularly valuable for integration tests that require shared, expensive resources like database connections or mock servers.

### Basic Suite Structure

```go
package integration_test

import (
    "database/sql"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/stretchr/testify/suite"
    _ "github.com/lib/pq"
)

// UserRepositorySuite tests the UserRepository against a real database.
type UserRepositorySuite struct {
    suite.Suite
    db   *sql.DB
    repo *UserRepository
}

// SetupSuite runs once before any test in this suite.
// Use for expensive one-time setup: start containers, connect to DB.
func (s *UserRepositorySuite) SetupSuite() {
    db, err := sql.Open("postgres", "postgres://test:test@localhost:5432/testdb?sslmode=disable")
    s.Require().NoError(err, "failed to connect to test database")
    s.Require().NoError(db.Ping())
    s.db = db
}

// TearDownSuite runs once after all tests in this suite.
func (s *UserRepositorySuite) TearDownSuite() {
    if s.db != nil {
        s.db.Close()
    }
}

// SetupTest runs before EACH test.
// Use for per-test isolation: wrap each test in a transaction.
func (s *UserRepositorySuite) SetupTest() {
    _, err := s.db.Exec("TRUNCATE TABLE users CASCADE")
    s.Require().NoError(err, "failed to truncate users table")
    s.repo = NewUserRepository(s.db)
}

// TearDownTest runs after EACH test.
func (s *UserRepositorySuite) TearDownTest() {
    // Any per-test cleanup
}

// Test methods must start with "Test"
func (s *UserRepositorySuite) TestCreateUser() {
    user, err := s.repo.Create(context.Background(), CreateUserInput{
        Email:    "test@example.com",
        Name:     "Test User",
    })
    s.Require().NoError(err)
    s.Assert().NotEmpty(user.ID)
    s.Assert().Equal("test@example.com", user.Email)
}

func (s *UserRepositorySuite) TestFindByEmail_NotFound() {
    _, err := s.repo.FindByEmail(context.Background(), "nobody@example.com")
    s.Assert().ErrorIs(err, ErrNotFound)
}

func (s *UserRepositorySuite) TestFindByEmail_Found() {
    // Setup: create a user first
    created, err := s.repo.Create(context.Background(), CreateUserInput{
        Email: "found@example.com",
        Name:  "Found User",
    })
    s.Require().NoError(err)

    // Test: find the user by email
    found, err := s.repo.FindByEmail(context.Background(), "found@example.com")
    s.Require().NoError(err)
    s.Assert().Equal(created.ID, found.ID)
    s.Assert().Equal(created.Email, found.Email)
}

// TestUserRepositorySuite is the entry point for `go test`.
func TestUserRepositorySuite(t *testing.T) {
    suite.Run(t, new(UserRepositorySuite))
}
```

### Suite Hooks Execution Order

```
TestUserRepositorySuite(t)
  └── suite.Run(t, suite)
        ├── SetupSuite()
        ├── SetupTest()
        │     TestCreateUser()
        │     TearDownTest()
        ├── SetupTest()
        │     TestFindByEmail_NotFound()
        │     TearDownTest()
        ├── SetupTest()
        │     TestFindByEmail_Found()
        │     TearDownTest()
        └── TearDownSuite()
```

### Suite with BeforeTest and AfterTest Hooks

These hooks receive the suite name and test name, useful for targeted setup:

```go
func (s *UserRepositorySuite) BeforeTest(suiteName, testName string) {
    s.T().Logf("Starting %s/%s", suiteName, testName)
    if testName == "TestCreateUser_WithConflict" {
        // Pre-insert a conflicting user
        _, err := s.repo.Create(context.Background(), CreateUserInput{
            Email: "existing@example.com",
        })
        s.Require().NoError(err)
    }
}

func (s *UserRepositorySuite) AfterTest(suiteName, testName string) {
    s.T().Logf("Completed %s/%s", suiteName, testName)
}
```

## Section 3: testify/mock — Expectations and Call Chains

`testify/mock` generates mock implementations for interfaces. The mock records expected calls and panics if the actual calls do not match.

### Generating a Mock

```go
// Interface to mock
type EmailService interface {
    Send(ctx context.Context, to, subject, body string) error
    SendBatch(ctx context.Context, recipients []string, subject, body string) (int, error)
}

// Generated mock (typically produced by mockery tool)
type MockEmailService struct {
    mock.Mock
}

func (m *MockEmailService) Send(ctx context.Context, to, subject, body string) error {
    args := m.Called(ctx, to, subject, body)
    return args.Error(0)
}

func (m *MockEmailService) SendBatch(ctx context.Context, recipients []string, subject, body string) (int, error) {
    args := m.Called(ctx, recipients, subject, body)
    return args.Int(0), args.Error(1)
}
```

```bash
# Using mockery to auto-generate mocks
go install github.com/vektra/mockery/v2@latest
mockery --name=EmailService --dir=./internal/email --output=./internal/mocks
```

### Setting Up Expectations

```go
func TestRegistrationService_SendsWelcomeEmail(t *testing.T) {
    mockEmail := new(MockEmailService)

    // Expect exactly one call to Send with these arguments
    mockEmail.On(
        "Send",
        mock.Anything,           // context — match any value
        "alice@example.com",
        "Welcome to our service!",
        mock.MatchedBy(func(body string) bool {
            return strings.Contains(body, "alice")
        }),
    ).Return(nil).Once()

    svc := NewRegistrationService(mockEmail)
    err := svc.Register(context.Background(), "alice@example.com")

    require.NoError(t, err)
    // Verify all expectations were met
    mockEmail.AssertExpectations(t)
}
```

### Call Return Variations

```go
// Return an error on the first call, success on subsequent calls
mockEmail.On("Send", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
    Return(errors.New("smtp timeout")).Once().
    Return(nil)

// Use a function to generate the return value dynamically
mockEmail.On("Send", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
    Return(func(ctx context.Context, to, subject, body string) error {
        if to == "banned@example.com" {
            return ErrRecipientBanned
        }
        return nil
    })

// Capture arguments for later inspection
var capturedRecipient string
mockEmail.On("Send", mock.Anything, mock.AnythingOfType("string"), mock.Anything, mock.Anything).
    Run(func(args mock.Arguments) {
        capturedRecipient = args.String(1) // index 1 = the "to" argument
    }).
    Return(nil)
```

### AssertCalled and AssertNumberOfCalls

```go
// Verify a method was called at least once
mockEmail.AssertCalled(t, "Send", mock.Anything, "alice@example.com",
    mock.Anything, mock.Anything)

// Verify exact call count
mockEmail.AssertNumberOfCalls(t, "Send", 1)

// Verify a method was NOT called
mockEmail.AssertNotCalled(t, "SendBatch", mock.Anything, mock.Anything,
    mock.Anything, mock.Anything)
```

## Section 4: Advanced Mock Patterns

### Chaining Expectations for State Machine Testing

```go
func TestPaymentService_RetryOnFailure(t *testing.T) {
    mockGateway := new(MockPaymentGateway)

    // First two calls fail with a retryable error
    mockGateway.On("Charge", mock.Anything, mock.Anything).
        Return(nil, ErrGatewayTimeout).
        Times(2)

    // Third call succeeds
    mockGateway.On("Charge", mock.Anything, mock.Anything).
        Return(&ChargeResult{TransactionID: "txn_abc123"}, nil).
        Once()

    svc := NewPaymentService(mockGateway, WithMaxRetries(3))
    result, err := svc.ProcessPayment(context.Background(), PaymentRequest{
        Amount:   1999,
        Currency: "USD",
    })

    require.NoError(t, err)
    require.NotNil(t, result)
    assert.Equal(t, "txn_abc123", result.TransactionID)
    mockGateway.AssertNumberOfCalls(t, "Charge", 3)
    mockGateway.AssertExpectations(t)
}
```

### Mock with Context Deadline Verification

```go
func TestCacheService_RespectsContextDeadline(t *testing.T) {
    mockStore := new(MockStore)

    // The mock verifies that the context has a deadline set
    mockStore.On("Get", mock.MatchedBy(func(ctx context.Context) bool {
        _, hasDeadline := ctx.Deadline()
        return hasDeadline
    }), "key:123").Return(nil, ErrCacheMiss)

    svc := NewCacheService(mockStore, WithDefaultTTL(5*time.Second))
    ctx := context.Background()
    _, err := svc.Get(ctx, "key:123")

    assert.ErrorIs(t, err, ErrCacheMiss)
    mockStore.AssertExpectations(t)
}
```

## Section 5: Parallel Suite Execution

By default, testify suites run tests sequentially within the suite but the suites themselves can run in parallel with other `go test` packages. Getting parallelism within a suite requires careful management.

### Suite with Parallel Tests (Using Sub-Tests)

Testify suites do not directly support `t.Parallel()` within suite test methods because the suite's `SetupTest`/`TearDownTest` hooks use a single `*testing.T`. The workaround is to create sub-tests:

```go
func (s *UserRepositorySuite) TestConcurrentCreates() {
    // Run sub-tests within the suite test, using the suite's T()
    t := s.T()

    emails := []string{
        "user1@example.com",
        "user2@example.com",
        "user3@example.com",
        "user4@example.com",
        "user5@example.com",
    }

    results := make([]error, len(emails))
    var wg sync.WaitGroup
    for i, email := range emails {
        wg.Add(1)
        go func(idx int, e string) {
            defer wg.Done()
            _, err := s.repo.Create(context.Background(), CreateUserInput{Email: e})
            results[idx] = err
        }(i, email)
    }
    wg.Wait()

    for i, err := range results {
        assert.NoError(t, err, "concurrent create %d failed", i)
    }
}
```

### Independent Suite Parallelism

```go
// Each suite gets its own database transaction/schema to allow true parallelism
type IsolatedSuite struct {
    suite.Suite
    schema string
    db     *sql.DB
}

func (s *IsolatedSuite) SetupSuite() {
    // Create a unique schema for this parallel execution
    s.schema = fmt.Sprintf("test_%d", time.Now().UnixNano())
    db, _ := sql.Open("postgres", "postgres://test:test@localhost:5432/testdb?sslmode=disable")
    s.db = db
    _, err := db.Exec(fmt.Sprintf("CREATE SCHEMA %s", s.schema))
    s.Require().NoError(err)
    _, err = db.Exec(fmt.Sprintf("SET search_path TO %s", s.schema))
    s.Require().NoError(err)
    runMigrations(db)
}

func (s *IsolatedSuite) TearDownSuite() {
    s.db.Exec(fmt.Sprintf("DROP SCHEMA %s CASCADE", s.schema))
    s.db.Close()
}

func TestIsolatedSuite_Package1(t *testing.T) {
    t.Parallel() // This allows parallel execution with other test files
    suite.Run(t, new(IsolatedSuite))
}
```

## Section 6: Clock Mocking for Time-Dependent Code

Testing code that uses `time.Now()` directly is brittle. The standard approach is to inject a clock interface.

### Defining a Clock Interface

```go
// clock.go
package timeutil

import "time"

// Clock abstracts time operations to allow test injection.
type Clock interface {
    Now() time.Time
    Since(t time.Time) time.Duration
    After(d time.Duration) <-chan time.Time
    Sleep(d time.Duration)
}

// RealClock uses the actual system clock.
type RealClock struct{}

func (RealClock) Now() time.Time                         { return time.Now() }
func (RealClock) Since(t time.Time) time.Duration        { return time.Since(t) }
func (RealClock) After(d time.Duration) <-chan time.Time  { return time.After(d) }
func (RealClock) Sleep(d time.Duration)                  { time.Sleep(d) }
```

### Mock Clock Implementation

```go
// mock_clock.go
package timeutil_test

import (
    "sync"
    "time"
)

type MockClock struct {
    mu      sync.RWMutex
    current time.Time
    timers  []mockTimer
}

type mockTimer struct {
    at   time.Time
    ch   chan time.Time
}

func NewMockClock(initial time.Time) *MockClock {
    return &MockClock{current: initial}
}

func (m *MockClock) Now() time.Time {
    m.mu.RLock()
    defer m.mu.RUnlock()
    return m.current
}

func (m *MockClock) Since(t time.Time) time.Duration {
    return m.Now().Sub(t)
}

func (m *MockClock) After(d time.Duration) <-chan time.Time {
    m.mu.Lock()
    defer m.mu.Unlock()
    ch := make(chan time.Time, 1)
    m.timers = append(m.timers, mockTimer{
        at: m.current.Add(d),
        ch: ch,
    })
    return ch
}

func (m *MockClock) Sleep(d time.Duration) {
    m.Advance(d)
}

// Advance moves the clock forward and fires any expired timers.
func (m *MockClock) Advance(d time.Duration) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.current = m.current.Add(d)
    // Fire timers that have expired
    remaining := m.timers[:0]
    for _, timer := range m.timers {
        if !timer.at.After(m.current) {
            timer.ch <- m.current
        } else {
            remaining = append(remaining, timer)
        }
    }
    m.timers = remaining
}
```

### Using Mock Clock in Tests

```go
func TestSessionExpiry(t *testing.T) {
    fixedTime := time.Date(2029, 10, 20, 12, 0, 0, 0, time.UTC)
    clock := NewMockClock(fixedTime)

    sessionManager := NewSessionManager(SessionManagerOptions{
        Clock:      clock,
        SessionTTL: 30 * time.Minute,
    })

    // Create a session
    session, err := sessionManager.Create("user-123")
    require.NoError(t, err)
    require.NotEmpty(t, session.Token)

    // Session should be valid immediately
    valid, err := sessionManager.Validate(session.Token)
    require.NoError(t, err)
    assert.True(t, valid, "session should be valid immediately after creation")

    // Advance time by 29 minutes — session still valid
    clock.Advance(29 * time.Minute)
    valid, err = sessionManager.Validate(session.Token)
    require.NoError(t, err)
    assert.True(t, valid, "session should still be valid at 29 minutes")

    // Advance time by 2 more minutes (31 total) — session expired
    clock.Advance(2 * time.Minute)
    valid, err = sessionManager.Validate(session.Token)
    assert.ErrorIs(t, err, ErrSessionExpired)
    assert.False(t, valid)
}
```

### Using the testify-clock Package

The `github.com/benbjohnson/clock` package provides a production-quality mock clock that integrates with testify:

```go
import "github.com/benbjohnson/clock"

func TestRateLimiter(t *testing.T) {
    mock := clock.NewMock()
    limiter := NewRateLimiter(RateLimiterConfig{
        Clock:    mock,
        Rate:     10,                // 10 requests per second
        Burst:    5,
        Interval: time.Second,
    })

    // Use 5 burst capacity immediately
    for i := 0; i < 5; i++ {
        allowed := limiter.Allow()
        assert.True(t, allowed, "burst request %d should be allowed", i+1)
    }

    // 6th request should be denied (burst exhausted)
    assert.False(t, limiter.Allow(), "should be rate limited after burst")

    // Advance 500ms — refills 5 tokens
    mock.Add(500 * time.Millisecond)
    assert.True(t, limiter.Allow(), "should be allowed after token refill")
}
```

## Section 7: Table-Driven Tests with Testify

Combining table-driven tests (idiomatic Go) with testify assertions:

```go
func TestValidateEmail(t *testing.T) {
    cases := []struct {
        name      string
        input     string
        wantError bool
        wantMsg   string
    }{
        {
            name:      "valid email",
            input:     "user@example.com",
            wantError: false,
        },
        {
            name:      "missing at sign",
            input:     "userexample.com",
            wantError: true,
            wantMsg:   "missing @",
        },
        {
            name:      "empty string",
            input:     "",
            wantError: true,
            wantMsg:   "email cannot be empty",
        },
        {
            name:      "internationalized domain",
            input:     "user@münchen.de",
            wantError: false,
        },
    }

    for _, tc := range cases {
        tc := tc // capture range variable for parallel tests
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel()

            err := ValidateEmail(tc.input)

            if tc.wantError {
                require.Error(t, err)
                if tc.wantMsg != "" {
                    assert.Contains(t, err.Error(), tc.wantMsg,
                        "error message should contain %q", tc.wantMsg)
                }
            } else {
                assert.NoError(t, err)
            }
        })
    }
}
```

## Section 8: Custom Assertions

For domain-specific conditions, write custom assertion functions using testify's `assert.Assertions` type:

```go
// customassert/assert.go
package customassert

import (
    "github.com/stretchr/testify/assert"
)

// IsValidUUID asserts that the string is a valid UUID v4.
func IsValidUUID(t assert.TestingT, id string, msgAndArgs ...interface{}) bool {
    h, ok := t.(interface{ Helper() })
    if ok {
        h.Helper()
    }
    pattern := `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
    return assert.Regexp(t, pattern, id, msgAndArgs...)
}

// HasHTTPStatus asserts that an HTTP response has the expected status code.
func HasHTTPStatus(t assert.TestingT, resp *http.Response, expected int, msgAndArgs ...interface{}) bool {
    h, ok := t.(interface{ Helper() })
    if ok {
        h.Helper()
    }
    return assert.Equal(t, expected, resp.StatusCode,
        append([]interface{}{"HTTP status mismatch: want %d, got %d", expected, resp.StatusCode}, msgAndArgs...)...)
}
```

```go
// Usage in tests
func TestCreateUser_ReturnsValidID(t *testing.T) {
    user, err := CreateUser("test@example.com")
    require.NoError(t, err)
    customassert.IsValidUUID(t, user.ID, "user ID should be a valid UUID v4")
}
```

## Section 9: Testing HTTP Handlers with Testify

```go
func TestUserHandler_GetUser(t *testing.T) {
    mockRepo := new(MockUserRepository)
    mockRepo.On("FindByID", mock.Anything, "user-123").
        Return(&User{
            ID:    "user-123",
            Email: "alice@example.com",
            Name:  "Alice",
        }, nil)

    handler := NewUserHandler(mockRepo)
    server := httptest.NewServer(handler)
    defer server.Close()

    resp, err := http.Get(server.URL + "/users/user-123")
    require.NoError(t, err)
    defer resp.Body.Close()

    assert.Equal(t, http.StatusOK, resp.StatusCode)
    assert.Equal(t, "application/json", resp.Header.Get("Content-Type"))

    var body map[string]interface{}
    err = json.NewDecoder(resp.Body).Decode(&body)
    require.NoError(t, err)
    assert.Equal(t, "user-123", body["id"])
    assert.Equal(t, "alice@example.com", body["email"])

    mockRepo.AssertExpectations(t)
}
```

Testify's value is in the feedback loop it creates: meaningful failure messages that tell you exactly what was expected versus what occurred, without requiring you to write custom comparison logic for every data type. Combined with suites for organization and mocks for isolation, it provides a complete testing infrastructure that scales from unit tests to complex integration test scenarios.
