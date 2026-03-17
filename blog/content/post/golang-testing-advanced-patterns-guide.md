---
title: "Advanced Go Testing: Table-Driven Tests, Mocks, and Integration Patterns"
date: 2027-11-17T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "TDD", "Mocks", "Integration Tests"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to advanced Go testing patterns including table-driven tests, testify suites, mock generation with mockery, httptest for HTTP handlers, testcontainers for database integration, fuzzing, and benchmark testing."
more_link: "yes"
url: "/golang-testing-advanced-patterns-guide/"
---

Testing in Go is a discipline that separates production-quality services from code that merely runs. The standard library provides a solid foundation, but production-grade test suites require patterns that handle complexity: generated mocks that match real interfaces, integration tests that spin up real databases, HTTP handler tests with realistic middleware chains, and fuzzing that finds edge cases humans never anticipate.

This guide covers the complete testing toolkit for Go services running in enterprise environments, with emphasis on patterns that scale to large codebases and CI pipelines.

<!--more-->

# Advanced Go Testing: Table-Driven Tests, Mocks, and Integration Patterns

## Section 1: Table-Driven Test Architecture

Table-driven tests are Go's idiomatic approach to testing multiple scenarios without duplicating logic. The pattern is straightforward but has significant variations in how test cases are structured, how errors are reported, and how subtests interact with the rest of the suite.

```go
package validation_test

import (
    "testing"
    "time"
)

// Email represents a validated email address
type Email struct {
    value string
}

// ParseEmail validates and parses an email address
func ParseEmail(s string) (Email, error) {
    if len(s) < 3 {
        return Email{}, fmt.Errorf("email too short")
    }
    at := strings.Index(s, "@")
    if at < 1 {
        return Email{}, fmt.Errorf("missing @ in email")
    }
    if at == len(s)-1 {
        return Email{}, fmt.Errorf("missing domain in email")
    }
    dot := strings.LastIndex(s[at:], ".")
    if dot < 2 {
        return Email{}, fmt.Errorf("invalid domain format")
    }
    return Email{value: strings.ToLower(s)}, nil
}

func TestParseEmail(t *testing.T) {
    tests := []struct {
        name      string
        input     string
        wantEmail string
        wantErr   string // empty string means no error expected
    }{
        {
            name:      "valid lowercase email",
            input:     "user@example.com",
            wantEmail: "user@example.com",
        },
        {
            name:      "valid mixed case normalizes to lowercase",
            input:     "User@Example.COM",
            wantEmail: "user@example.com",
        },
        {
            name:    "missing at sign",
            input:   "userexample.com",
            wantErr: "missing @",
        },
        {
            name:    "at sign at start",
            input:   "@example.com",
            wantErr: "missing @",
        },
        {
            name:    "missing domain",
            input:   "user@",
            wantErr: "missing domain",
        },
        {
            name:    "too short",
            input:   "a@",
            wantErr: "too short",
        },
        {
            name:    "empty string",
            input:   "",
            wantErr: "too short",
        },
        {
            name:      "subdomain email",
            input:     "user@mail.example.co.uk",
            wantEmail: "user@mail.example.co.uk",
        },
        {
            name:      "plus addressing",
            input:     "user+tag@example.com",
            wantEmail: "user+tag@example.com",
        },
    }

    for _, tc := range tests {
        tc := tc // capture range variable for parallel subtests
        t.Run(tc.name, func(t *testing.T) {
            t.Parallel() // subtests can run in parallel when they share no state

            got, err := ParseEmail(tc.input)

            if tc.wantErr != "" {
                if err == nil {
                    t.Errorf("ParseEmail(%q) = %v, want error containing %q",
                        tc.input, got, tc.wantErr)
                    return
                }
                if !strings.Contains(err.Error(), tc.wantErr) {
                    t.Errorf("ParseEmail(%q) error = %q, want it to contain %q",
                        tc.input, err.Error(), tc.wantErr)
                }
                return
            }

            if err != nil {
                t.Fatalf("ParseEmail(%q) unexpected error: %v", tc.input, err)
            }
            if got.value != tc.wantEmail {
                t.Errorf("ParseEmail(%q) = %q, want %q", tc.input, got.value, tc.wantEmail)
            }
        })
    }
}
```

### Structuring Complex Table Tests

For functions with multiple return values, struct comparisons, or error type checks, enrich the test case structure:

```go
package user_test

import (
    "errors"
    "testing"
    "time"

    "github.com/google/go-cmp/cmp"
    "github.com/google/go-cmp/cmp/cmpopts"
)

type User struct {
    ID        int64
    Email     string
    Name      string
    Role      string
    CreatedAt time.Time
    UpdatedAt time.Time
}

type CreateUserRequest struct {
    Email string
    Name  string
    Role  string
}

var ErrEmailTaken = errors.New("email already taken")
var ErrInvalidRole = errors.New("invalid role")

func createUser(req CreateUserRequest) (*User, error) {
    // Simplified implementation for illustration
    switch {
    case req.Email == "taken@example.com":
        return nil, ErrEmailTaken
    case req.Role != "admin" && req.Role != "user" && req.Role != "viewer":
        return nil, fmt.Errorf("%w: %s", ErrInvalidRole, req.Role)
    }
    return &User{
        ID:        42,
        Email:     req.Email,
        Name:      req.Name,
        Role:      req.Role,
        CreatedAt: time.Now(),
        UpdatedAt: time.Now(),
    }, nil
}

func TestCreateUser(t *testing.T) {
    tests := []struct {
        name    string
        req     CreateUserRequest
        want    *User
        wantErr error // use errors.Is check
    }{
        {
            name: "creates admin user",
            req: CreateUserRequest{
                Email: "admin@example.com",
                Name:  "Admin User",
                Role:  "admin",
            },
            want: &User{
                Email: "admin@example.com",
                Name:  "Admin User",
                Role:  "admin",
            },
        },
        {
            name: "rejects duplicate email",
            req: CreateUserRequest{
                Email: "taken@example.com",
                Name:  "Someone",
                Role:  "user",
            },
            wantErr: ErrEmailTaken,
        },
        {
            name: "rejects invalid role",
            req: CreateUserRequest{
                Email: "new@example.com",
                Name:  "Someone",
                Role:  "superadmin",
            },
            wantErr: ErrInvalidRole,
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            got, err := createUser(tc.req)

            if tc.wantErr != nil {
                if !errors.Is(err, tc.wantErr) {
                    t.Errorf("createUser() error = %v, want %v", err, tc.wantErr)
                }
                return
            }

            if err != nil {
                t.Fatalf("createUser() unexpected error: %v", err)
            }

            // Use go-cmp for deep comparison, ignoring dynamic fields
            diff := cmp.Diff(tc.want, got, cmpopts.IgnoreFields(User{}, "ID", "CreatedAt", "UpdatedAt"))
            if diff != "" {
                t.Errorf("createUser() mismatch (-want +got):\n%s", diff)
            }
        })
    }
}
```

## Section 2: Testify Suite Patterns

The `testify/suite` package provides lifecycle hooks and shared state management that the standard library lacks. It is particularly useful for integration tests that need database connections, HTTP servers, or other setup-teardown-heavy resources.

```go
package service_test

import (
    "context"
    "database/sql"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/stretchr/testify/suite"
)

// UserServiceSuite holds shared state for the user service test suite
type UserServiceSuite struct {
    suite.Suite
    db      *sql.DB
    service *UserService
    ctx     context.Context
    cancel  context.CancelFunc
}

// SetupSuite runs once before all tests in the suite
func (s *UserServiceSuite) SetupSuite() {
    s.ctx, s.cancel = context.WithTimeout(context.Background(), 5*time.Minute)

    db, err := sql.Open("postgres", testDSN())
    s.Require().NoError(err, "failed to connect to test database")

    s.Require().NoError(db.PingContext(s.ctx), "test database not reachable")
    s.db = db

    s.service = NewUserService(db)
}

// TearDownSuite runs once after all tests complete
func (s *UserServiceSuite) TearDownSuite() {
    if s.db != nil {
        s.db.Close()
    }
    s.cancel()
}

// SetupTest runs before each individual test
func (s *UserServiceSuite) SetupTest() {
    // Wrap each test in a transaction that gets rolled back
    // This provides test isolation without needing to truncate tables
    _, err := s.db.ExecContext(s.ctx, "BEGIN")
    s.Require().NoError(err)
}

// TearDownTest runs after each individual test
func (s *UserServiceSuite) TearDownTest() {
    _, _ = s.db.ExecContext(s.ctx, "ROLLBACK")
}

// TestCreateUser tests user creation
func (s *UserServiceSuite) TestCreateUser() {
    req := CreateUserRequest{
        Email: "test@example.com",
        Name:  "Test User",
        Role:  "user",
    }

    user, err := s.service.Create(s.ctx, req)
    s.Require().NoError(err)
    s.Assert().NotZero(user.ID)
    s.Assert().Equal("test@example.com", user.Email)
    s.Assert().Equal("Test User", user.Name)
    s.Assert().WithinDuration(time.Now(), user.CreatedAt, 5*time.Second)
}

// TestGetUserNotFound tests error handling for missing users
func (s *UserServiceSuite) TestGetUserNotFound() {
    _, err := s.service.Get(s.ctx, 999999)
    s.Assert().ErrorIs(err, ErrUserNotFound)
}

// TestUpdateUserEmail tests email update with uniqueness constraint
func (s *UserServiceSuite) TestUpdateUserEmail() {
    // Create two users
    user1, err := s.service.Create(s.ctx, CreateUserRequest{
        Email: "user1@example.com",
        Name:  "User One",
        Role:  "user",
    })
    s.Require().NoError(err)

    _, err = s.service.Create(s.ctx, CreateUserRequest{
        Email: "user2@example.com",
        Name:  "User Two",
        Role:  "user",
    })
    s.Require().NoError(err)

    // Updating to a unique email should succeed
    err = s.service.UpdateEmail(s.ctx, user1.ID, "new@example.com")
    s.Assert().NoError(err)

    // Updating to an existing email should fail
    err = s.service.UpdateEmail(s.ctx, user1.ID, "user2@example.com")
    s.Assert().ErrorIs(err, ErrEmailTaken)
}

// TestUserServiceSuite is the entry point that runs the suite
func TestUserServiceSuite(t *testing.T) {
    suite.Run(t, new(UserServiceSuite))
}

func testDSN() string {
    return "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"
}

// Stub types
type UserService struct{ db *sql.DB }
type CreateUserRequest struct{ Email, Name, Role string }
type User struct {
    ID        int64
    Email     string
    Name      string
    CreatedAt time.Time
}

var ErrUserNotFound = errors.New("user not found")
var ErrEmailTaken = errors.New("email taken")

func NewUserService(db *sql.DB) *UserService     { return &UserService{db: db} }
func (s *UserService) Create(ctx context.Context, req CreateUserRequest) (*User, error) { return nil, nil }
func (s *UserService) Get(ctx context.Context, id int64) (*User, error)                 { return nil, nil }
func (s *UserService) UpdateEmail(ctx context.Context, id int64, email string) error   { return nil }
```

## Section 3: Mock Generation with Mockery

Hand-written mocks drift from interfaces as code evolves. The `mockery` tool generates type-safe mocks from interface definitions automatically. Keep generated files in a `mocks/` directory adjacent to the interfaces they mock.

Install and configure mockery:

```bash
# Install mockery
go install github.com/vektra/mockery/v2@latest

# Generate mocks from all interfaces in the current package
mockery --all --output=mocks --outpkg=mocks

# Or target a specific interface
mockery --name=UserRepository --output=mocks --outpkg=mocks
```

Configure mockery per repository with `.mockery.yaml`:

```yaml
# .mockery.yaml
with-expecter: true
all: false
packages:
  github.com/myorg/myservice/internal/repository:
    interfaces:
      UserRepository:
        config:
          dir: "mocks"
          outpkg: "mocks"
          filename: "user_repository.go"
  github.com/myorg/myservice/internal/email:
    interfaces:
      Sender:
        config:
          dir: "mocks"
          outpkg: "mocks"
          filename: "email_sender.go"
```

Using generated mocks in tests:

```go
package service_test

import (
    "context"
    "errors"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "github.com/myorg/myservice/mocks"
)

// UserRepository is the interface we're mocking
type UserRepository interface {
    GetByID(ctx context.Context, id int64) (*User, error)
    GetByEmail(ctx context.Context, email string) (*User, error)
    Create(ctx context.Context, req CreateUserRequest) (*User, error)
    Update(ctx context.Context, user *User) error
}

// EmailSender is the email interface we're mocking
type EmailSender interface {
    SendWelcome(ctx context.Context, user *User) error
}

// RegistrationService is the service under test
type RegistrationService struct {
    users  UserRepository
    emails EmailSender
}

func NewRegistrationService(users UserRepository, emails EmailSender) *RegistrationService {
    return &RegistrationService{users: users, emails: emails}
}

func (s *RegistrationService) Register(ctx context.Context, req CreateUserRequest) (*User, error) {
    existing, err := s.users.GetByEmail(ctx, req.Email)
    if err != nil && !errors.Is(err, ErrUserNotFound) {
        return nil, fmt.Errorf("checking existing user: %w", err)
    }
    if existing != nil {
        return nil, ErrEmailTaken
    }

    user, err := s.users.Create(ctx, req)
    if err != nil {
        return nil, fmt.Errorf("creating user: %w", err)
    }

    if err := s.emails.SendWelcome(ctx, user); err != nil {
        // Log but don't fail - email is best effort
        fmt.Printf("failed to send welcome email to %s: %v\n", user.Email, err)
    }

    return user, nil
}

// TestRegister uses mockery-generated mocks
func TestRegister(t *testing.T) {
    ctx := context.Background()

    t.Run("successfully registers new user", func(t *testing.T) {
        repo := mocks.NewUserRepository(t)
        emailer := mocks.NewEmailSender(t)

        expectedUser := &User{
            ID:        1,
            Email:     "new@example.com",
            Name:      "New User",
            CreatedAt: time.Now(),
        }

        // Set up expectations using EXPECT() method (generated by with-expecter: true)
        repo.EXPECT().
            GetByEmail(ctx, "new@example.com").
            Return(nil, ErrUserNotFound).
            Once()

        repo.EXPECT().
            Create(ctx, mock.MatchedBy(func(req CreateUserRequest) bool {
                return req.Email == "new@example.com"
            })).
            Return(expectedUser, nil).
            Once()

        emailer.EXPECT().
            SendWelcome(ctx, expectedUser).
            Return(nil).
            Once()

        svc := NewRegistrationService(repo, emailer)
        user, err := svc.Register(ctx, CreateUserRequest{
            Email: "new@example.com",
            Name:  "New User",
            Role:  "user",
        })

        assert.NoError(t, err)
        assert.Equal(t, expectedUser, user)
        // mock.AssertExpectations called automatically by testify when using t-constructor
    })

    t.Run("rejects duplicate email", func(t *testing.T) {
        repo := mocks.NewUserRepository(t)
        emailer := mocks.NewEmailSender(t)

        existingUser := &User{ID: 1, Email: "taken@example.com"}

        repo.EXPECT().
            GetByEmail(ctx, "taken@example.com").
            Return(existingUser, nil).
            Once()
        // No Create call expected - mock will fail if Create is called

        svc := NewRegistrationService(repo, emailer)
        _, err := svc.Register(ctx, CreateUserRequest{
            Email: "taken@example.com",
            Name:  "Someone",
            Role:  "user",
        })

        assert.ErrorIs(t, err, ErrEmailTaken)
    })

    t.Run("continues when welcome email fails", func(t *testing.T) {
        repo := mocks.NewUserRepository(t)
        emailer := mocks.NewEmailSender(t)

        createdUser := &User{ID: 2, Email: "user@example.com"}

        repo.EXPECT().GetByEmail(ctx, "user@example.com").Return(nil, ErrUserNotFound).Once()
        repo.EXPECT().Create(ctx, mock.Anything).Return(createdUser, nil).Once()
        emailer.EXPECT().
            SendWelcome(ctx, createdUser).
            Return(errors.New("smtp connection refused")).
            Once()

        svc := NewRegistrationService(repo, emailer)
        user, err := svc.Register(ctx, CreateUserRequest{
            Email: "user@example.com",
            Name:  "User",
            Role:  "user",
        })

        // Email failure should not cause registration to fail
        assert.NoError(t, err)
        assert.Equal(t, createdUser, user)
    })
}
```

## Section 4: HTTP Handler Testing with httptest

The `net/http/httptest` package provides `httptest.NewRecorder()` and `httptest.NewServer()` for testing HTTP handlers without a real network listener.

```go
package handlers_test

import (
    "bytes"
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

// UserHandler handles user-related HTTP requests
type UserHandler struct {
    service UserService
}

type UserService interface {
    Get(ctx context.Context, id int64) (*User, error)
    Create(ctx context.Context, req CreateUserRequest) (*User, error)
}

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
    idStr := r.PathValue("id") // Go 1.22+ path parameters
    id, err := strconv.ParseInt(idStr, 10, 64)
    if err != nil {
        http.Error(w, "invalid user id", http.StatusBadRequest)
        return
    }

    user, err := h.service.Get(r.Context(), id)
    if errors.Is(err, ErrUserNotFound) {
        http.Error(w, "user not found", http.StatusNotFound)
        return
    }
    if err != nil {
        http.Error(w, "internal server error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(user)
}

func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
    var req CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    user, err := h.service.Create(r.Context(), req)
    if errors.Is(err, ErrEmailTaken) {
        http.Error(w, "email already taken", http.StatusConflict)
        return
    }
    if err != nil {
        http.Error(w, "internal server error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(user)
}

func TestGetUser(t *testing.T) {
    tests := []struct {
        name       string
        userID     string
        mockUser   *User
        mockErr    error
        wantStatus int
        wantBody   string
    }{
        {
            name:   "returns user for valid id",
            userID: "42",
            mockUser: &User{
                ID:    42,
                Email: "user@example.com",
                Name:  "Test User",
            },
            wantStatus: http.StatusOK,
        },
        {
            name:       "returns 404 for missing user",
            userID:     "999",
            mockErr:    ErrUserNotFound,
            wantStatus: http.StatusNotFound,
            wantBody:   "user not found",
        },
        {
            name:       "returns 400 for invalid id",
            userID:     "notanumber",
            wantStatus: http.StatusBadRequest,
            wantBody:   "invalid user id",
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            svc := mocks.NewUserService(t)
            if tc.mockUser != nil || tc.mockErr != nil {
                id, _ := strconv.ParseInt(tc.userID, 10, 64)
                if id > 0 {
                    svc.EXPECT().Get(mock.Anything, id).Return(tc.mockUser, tc.mockErr).Maybe()
                }
            }

            handler := &UserHandler{service: svc}

            // Build request with path parameter
            req := httptest.NewRequest(http.MethodGet, "/users/"+tc.userID, nil)
            req.SetPathValue("id", tc.userID)
            rec := httptest.NewRecorder()

            handler.GetUser(rec, req)

            assert.Equal(t, tc.wantStatus, rec.Code)
            if tc.wantBody != "" {
                assert.Contains(t, rec.Body.String(), tc.wantBody)
            }
            if tc.mockUser != nil {
                var got User
                require.NoError(t, json.NewDecoder(rec.Body).Decode(&got))
                assert.Equal(t, tc.mockUser.ID, got.ID)
                assert.Equal(t, tc.mockUser.Email, got.Email)
            }
        })
    }
}

func TestCreateUser(t *testing.T) {
    t.Run("creates user and returns 201", func(t *testing.T) {
        svc := mocks.NewUserService(t)
        svc.EXPECT().
            Create(mock.Anything, mock.MatchedBy(func(req CreateUserRequest) bool {
                return req.Email == "new@example.com"
            })).
            Return(&User{ID: 1, Email: "new@example.com", Name: "New"}, nil).
            Once()

        handler := &UserHandler{service: svc}

        body, _ := json.Marshal(CreateUserRequest{
            Email: "new@example.com",
            Name:  "New",
            Role:  "user",
        })
        req := httptest.NewRequest(http.MethodPost, "/users", bytes.NewReader(body))
        req.Header.Set("Content-Type", "application/json")
        rec := httptest.NewRecorder()

        handler.CreateUser(rec, req)

        assert.Equal(t, http.StatusCreated, rec.Code)
        assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

        var got User
        require.NoError(t, json.NewDecoder(rec.Body).Decode(&got))
        assert.Equal(t, int64(1), got.ID)
    })
}

// TestHandlerWithMiddlewareChain tests the full middleware stack
func TestHandlerWithMiddlewareChain(t *testing.T) {
    svc := mocks.NewUserService(t)
    svc.EXPECT().
        Get(mock.Anything, int64(1)).
        Return(&User{ID: 1, Email: "user@example.com"}, nil).
        Once()

    handler := &UserHandler{service: svc}

    // Build a full mux with middleware
    mux := http.NewServeMux()
    mux.HandleFunc("GET /users/{id}", handler.GetUser)

    // Apply middleware chain
    var h http.Handler = mux
    h = requestIDMiddleware(h)
    h = loggingMiddleware(h)

    srv := httptest.NewServer(h)
    defer srv.Close()

    resp, err := http.Get(srv.URL + "/users/1")
    require.NoError(t, err)
    defer resp.Body.Close()

    assert.Equal(t, http.StatusOK, resp.StatusCode)
    assert.NotEmpty(t, resp.Header.Get("X-Request-ID"))
}

func requestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("X-Request-ID", "test-request-id")
        next.ServeHTTP(w, r)
    })
}

func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        next.ServeHTTP(w, r)
    })
}
```

## Section 5: Testcontainers for Database Integration Tests

Testcontainers starts real Docker containers in tests, eliminating the gap between mocked and real database behavior. Tests run against the actual database engine with the same SQL, indexes, and constraints as production.

```go
package integration_test

import (
    "context"
    "database/sql"
    "testing"
    "time"

    "github.com/docker/go-connections/nat"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/wait"
    _ "github.com/lib/pq"
)

// PostgresContainer wraps a testcontainers postgres instance
type PostgresContainer struct {
    container *postgres.PostgresContainer
    DSN       string
}

// NewPostgresContainer starts a PostgreSQL container for testing.
// It applies schema migrations and returns a ready-to-use container.
func NewPostgresContainer(t *testing.T) *PostgresContainer {
    t.Helper()
    ctx := context.Background()

    container, err := postgres.Run(ctx,
        "postgres:16.2-alpine",
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("testuser"),
        postgres.WithPassword("testpassword"),
        postgres.WithInitScripts("testdata/schema.sql"),
        testcontainers.WithWaitStrategy(
            wait.ForLog("database system is ready to accept connections").
                WithOccurrence(2).
                WithStartupTimeout(60*time.Second),
        ),
    )
    if err != nil {
        t.Fatalf("failed to start postgres container: %v", err)
    }

    t.Cleanup(func() {
        if err := container.Terminate(ctx); err != nil {
            t.Logf("failed to terminate postgres container: %v", err)
        }
    })

    dsn, err := container.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        t.Fatalf("failed to get connection string: %v", err)
    }

    return &PostgresContainer{
        container: container,
        DSN:       dsn,
    }
}

// TestUserRepositoryIntegration runs against a real PostgreSQL database
func TestUserRepositoryIntegration(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test in short mode")
    }

    pg := NewPostgresContainer(t)

    db, err := sql.Open("postgres", pg.DSN)
    if err != nil {
        t.Fatalf("failed to connect to test database: %v", err)
    }
    defer db.Close()

    repo := NewUserRepository(db)
    ctx := context.Background()

    t.Run("create and retrieve user", func(t *testing.T) {
        user, err := repo.Create(ctx, CreateUserRequest{
            Email: "test@example.com",
            Name:  "Test User",
            Role:  "user",
        })
        if err != nil {
            t.Fatalf("Create() error: %v", err)
        }
        if user.ID == 0 {
            t.Error("expected non-zero ID after creation")
        }

        got, err := repo.GetByID(ctx, user.ID)
        if err != nil {
            t.Fatalf("GetByID() error: %v", err)
        }
        if got.Email != "test@example.com" {
            t.Errorf("GetByID() email = %q, want %q", got.Email, "test@example.com")
        }
    })

    t.Run("email uniqueness constraint", func(t *testing.T) {
        _, err := repo.Create(ctx, CreateUserRequest{
            Email: "unique@example.com",
            Name:  "First",
            Role:  "user",
        })
        if err != nil {
            t.Fatalf("first Create() error: %v", err)
        }

        _, err = repo.Create(ctx, CreateUserRequest{
            Email: "unique@example.com",
            Name:  "Second",
            Role:  "user",
        })
        if !errors.Is(err, ErrEmailTaken) {
            t.Errorf("expected ErrEmailTaken, got %v", err)
        }
    })

    t.Run("context cancellation cancels query", func(t *testing.T) {
        ctx, cancel := context.WithCancel(context.Background())
        cancel() // immediately cancel

        _, err := repo.GetByID(ctx, 1)
        if err == nil {
            t.Error("expected error for cancelled context")
        }
    })
}
```

The corresponding schema file for the test container:

```sql
-- testdata/schema.sql
CREATE TABLE IF NOT EXISTS users (
    id         BIGSERIAL PRIMARY KEY,
    email      TEXT NOT NULL,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (email)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);
```

## Section 6: Fuzzing

Go 1.18 introduced native fuzzing. Fuzz tests explore input space automatically, finding crashes and panics that table-driven tests miss.

```go
package parser_test

import (
    "testing"
    "unicode/utf8"
)

// parseQueryString parses a URL query string into a map.
// We want to fuzz this to find panics or incorrect behavior.
func parseQueryString(s string) (map[string]string, error) {
    result := make(map[string]string)
    if s == "" {
        return result, nil
    }

    for _, pair := range strings.Split(s, "&") {
        if pair == "" {
            continue
        }
        parts := strings.SplitN(pair, "=", 2)
        key := parts[0]
        if !utf8.ValidString(key) {
            return nil, fmt.Errorf("invalid UTF-8 in key")
        }
        var value string
        if len(parts) == 2 {
            value = parts[1]
        }
        result[key] = value
    }

    return result, nil
}

// FuzzParseQueryString finds panics or unexpected behavior via fuzzing.
// Run with: go test -fuzz=FuzzParseQueryString -fuzztime=60s
func FuzzParseQueryString(f *testing.F) {
    // Seed corpus: interesting starting inputs
    f.Add("key=value")
    f.Add("key=value&other=thing")
    f.Add("")
    f.Add("=value")
    f.Add("key=")
    f.Add("key=value=extra")
    f.Add("&&&&")

    f.Fuzz(func(t *testing.T, s string) {
        // Property 1: function must not panic on any input
        result, err := parseQueryString(s)

        // Property 2: on success, all keys must be valid UTF-8
        if err == nil {
            for k, v := range result {
                if !utf8.ValidString(k) {
                    t.Errorf("parseQueryString(%q) returned non-UTF-8 key %q", s, k)
                }
                if !utf8.ValidString(v) {
                    t.Errorf("parseQueryString(%q) returned non-UTF-8 value %q", s, v)
                }
            }
        }

        // Property 3: re-parsing a serialized form should be idempotent
        if err == nil && len(result) > 0 {
            // Build canonical form and re-parse
            var parts []string
            for k, v := range result {
                parts = append(parts, k+"="+v)
            }
            canonical := strings.Join(parts, "&")
            reparsed, err2 := parseQueryString(canonical)
            if err2 != nil {
                t.Errorf("re-parsing canonical form failed: %v", err2)
            }
            if len(reparsed) != len(result) {
                t.Errorf("re-parsing changed result count: got %d, want %d",
                    len(reparsed), len(result))
            }
        }
    })
}

// FuzzJSONRoundTrip tests that JSON marshaling and unmarshaling are inverses
type Config struct {
    Name    string
    Value   int
    Enabled bool
    Tags    []string
}

func FuzzJSONRoundTrip(f *testing.F) {
    f.Add(`{"name":"test","value":42,"enabled":true,"tags":["a","b"]}`)
    f.Add(`{}`)
    f.Add(`{"name":"","value":0,"enabled":false}`)

    f.Fuzz(func(t *testing.T, jsonStr string) {
        var config Config
        err := json.Unmarshal([]byte(jsonStr), &config)
        if err != nil {
            // Invalid JSON is expected and fine
            return
        }

        // Re-marshal and unmarshal should produce the same result
        data, err := json.Marshal(config)
        if err != nil {
            t.Errorf("failed to marshal valid config: %v", err)
            return
        }

        var config2 Config
        if err := json.Unmarshal(data, &config2); err != nil {
            t.Errorf("failed to unmarshal re-marshaled config: %v", err)
            return
        }

        if !reflect.DeepEqual(config, config2) {
            t.Errorf("round-trip changed config:\n  before: %+v\n  after:  %+v",
                config, config2)
        }
    })
}
```

## Section 7: Benchmark Testing

Benchmarks measure performance and detect regressions. They are particularly valuable for data transformation, serialization, and hot code paths.

```go
package serialization_test

import (
    "encoding/json"
    "testing"

    "github.com/bytedance/sonic"
    "google.golang.org/protobuf/proto"
)

// OrderEvent is a typical event payload
type OrderEvent struct {
    OrderID    string            `json:"order_id"`
    CustomerID string            `json:"customer_id"`
    Items      []OrderItem       `json:"items"`
    TotalCents int64             `json:"total_cents"`
    Currency   string            `json:"currency"`
    Metadata   map[string]string `json:"metadata,omitempty"`
}

type OrderItem struct {
    ProductID  string `json:"product_id"`
    Quantity   int    `json:"quantity"`
    PriceCents int64  `json:"price_cents"`
}

func newTestEvent() OrderEvent {
    return OrderEvent{
        OrderID:    "ord-abc123",
        CustomerID: "cust-xyz789",
        Items: []OrderItem{
            {ProductID: "prod-001", Quantity: 2, PriceCents: 1999},
            {ProductID: "prod-002", Quantity: 1, PriceCents: 4999},
        },
        TotalCents: 8997,
        Currency:   "USD",
        Metadata: map[string]string{
            "source":  "web",
            "version": "2",
        },
    }
}

// BenchmarkJSONMarshal measures standard library JSON marshaling
func BenchmarkJSONMarshal(b *testing.B) {
    event := newTestEvent()
    b.ReportAllocs()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _, err := json.Marshal(event)
        if err != nil {
            b.Fatal(err)
        }
    }
}

// BenchmarkJSONUnmarshal measures standard library JSON unmarshaling
func BenchmarkJSONUnmarshal(b *testing.B) {
    event := newTestEvent()
    data, _ := json.Marshal(event)
    b.ReportAllocs()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        var out OrderEvent
        if err := json.Unmarshal(data, &out); err != nil {
            b.Fatal(err)
        }
    }
}

// BenchmarkJSONRoundTrip measures combined marshal+unmarshal
func BenchmarkJSONRoundTrip(b *testing.B) {
    event := newTestEvent()
    b.ReportAllocs()
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        data, err := json.Marshal(event)
        if err != nil {
            b.Fatal(err)
        }
        var out OrderEvent
        if err := json.Unmarshal(data, &out); err != nil {
            b.Fatal(err)
        }
    }
}

// BenchmarkWithParallelism demonstrates parallel benchmarking
func BenchmarkJSONMarshalParallel(b *testing.B) {
    event := newTestEvent()
    b.ReportAllocs()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            _, err := json.Marshal(event)
            if err != nil {
                b.Fatal(err)
            }
        }
    })
}

// BenchmarkSubAllocationProfile shows allocation profiling per operation
func BenchmarkStringBuilder(b *testing.B) {
    words := []string{"the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog"}
    b.ReportAllocs()
    b.ResetTimer()

    b.Run("strings.Join", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            _ = strings.Join(words, " ")
        }
    })

    b.Run("strings.Builder", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            var sb strings.Builder
            for j, w := range words {
                if j > 0 {
                    sb.WriteByte(' ')
                }
                sb.WriteString(w)
            }
            _ = sb.String()
        }
    })

    b.Run("fmt.Sprintf", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            _ = fmt.Sprintf("%s %s %s %s %s %s %s %s %s",
                words[0], words[1], words[2], words[3], words[4],
                words[5], words[6], words[7], words[8])
        }
    })
}
```

Run benchmarks with memory profiling:

```bash
# Run all benchmarks for 10 seconds each
go test -bench=. -benchtime=10s -benchmem ./...

# Run specific benchmark with CPU profile
go test -bench=BenchmarkJSONMarshal -cpuprofile=cpu.prof ./serialization_test/
go tool pprof cpu.prof

# Compare benchmarks with benchstat
go test -bench=. -count=5 > before.txt
# Make changes
go test -bench=. -count=5 > after.txt
benchstat before.txt after.txt
```

## Section 8: Test Coverage Analysis

Coverage analysis should be integrated into CI pipelines with enforced minimums for critical packages.

```bash
# Generate coverage profile
go test -coverprofile=coverage.out -covermode=atomic ./...

# View coverage in browser
go tool cover -html=coverage.out

# Show coverage per function (finds untested functions)
go tool cover -func=coverage.out | grep -v "100.0%"

# Check coverage meets minimum threshold (CI gate)
go test -coverprofile=coverage.out ./...
COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | tr -d '%')
if (( $(echo "$COVERAGE < 80" | bc -l) )); then
    echo "Coverage $COVERAGE% is below 80% threshold"
    exit 1
fi
```

For more granular control, use a coverage configuration:

```yaml
# .github/workflows/test.yml
name: Test
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16.2-alpine
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: testuser
          POSTGRES_PASSWORD: testpassword
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
        go-version: '1.23'
        cache: true

    - name: Run unit tests
      run: go test -short -race -coverprofile=unit.out ./...

    - name: Run integration tests
      env:
        TEST_POSTGRES_DSN: postgres://testuser:testpassword@localhost:5432/testdb?sslmode=disable
      run: go test -run Integration -race -coverprofile=integration.out ./...

    - name: Merge coverage profiles
      run: |
        go install github.com/wadey/gocovmerge@latest
        gocovmerge unit.out integration.out > merged.out

    - name: Check coverage threshold
      run: |
        COVERAGE=$(go tool cover -func=merged.out | grep total | awk '{print $3}' | tr -d '%')
        echo "Total coverage: ${COVERAGE}%"
        if (( $(echo "$COVERAGE < 75" | bc -l) )); then
          echo "Coverage below 75% threshold"
          exit 1
        fi

    - name: Upload coverage to Codecov
      uses: codecov/codecov-action@v4
      with:
        files: merged.out
        fail_ci_if_error: true
```

## Section 9: Test Helpers and Fixtures

Well-designed test helpers reduce duplication and make test intent clear. Use `testing.TB` instead of `*testing.T` to make helpers usable in both tests and benchmarks.

```go
package testutil

import (
    "context"
    "database/sql"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"
)

// NewTestDB creates an in-transaction test database.
// The returned cleanup function rolls back the transaction.
func NewTestDB(t testing.TB, db *sql.DB) (*sql.Tx, func()) {
    t.Helper()
    tx, err := db.BeginTx(context.Background(), nil)
    if err != nil {
        t.Fatalf("testutil.NewTestDB: failed to begin transaction: %v", err)
    }
    return tx, func() {
        if err := tx.Rollback(); err != nil && err != sql.ErrTxDone {
            t.Logf("testutil.NewTestDB cleanup: rollback failed: %v", err)
        }
    }
}

// RequireNoError fails the test immediately if err is not nil.
// Provides cleaner output than t.Fatalf in helper functions.
func RequireNoError(t testing.TB, err error, msgAndArgs ...interface{}) {
    t.Helper()
    if err != nil {
        if len(msgAndArgs) > 0 {
            t.Fatalf("%v: unexpected error: %v", msgAndArgs[0], err)
        }
        t.Fatalf("unexpected error: %v", err)
    }
}

// MustParseTime parses a time string for use in test fixtures.
// Panics on parse failure so tests don't need error handling for fixtures.
func MustParseTime(layout, value string) time.Time {
    t, err := time.Parse(layout, value)
    if err != nil {
        panic(fmt.Sprintf("testutil.MustParseTime: failed to parse %q with layout %q: %v",
            value, layout, err))
    }
    return t
}

// NewTestServer creates an httptest.Server and returns its URL.
// Registers cleanup to stop the server when the test finishes.
func NewTestServer(t testing.TB, handler http.Handler) string {
    t.Helper()
    srv := httptest.NewServer(handler)
    t.Cleanup(srv.Close)
    return srv.URL
}

// NewTestContext returns a context that is cancelled when the test finishes.
func NewTestContext(t testing.TB) context.Context {
    t.Helper()
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    t.Cleanup(cancel)
    return ctx
}

// FixtureUser creates a standard test user fixture.
// The email is unique per call to avoid collision in parallel tests.
func FixtureUser(t testing.TB, repo UserRepository) *User {
    t.Helper()
    ctx := NewTestContext(t)
    user, err := repo.Create(ctx, CreateUserRequest{
        Email: fmt.Sprintf("fixture-%d@example.com", time.Now().UnixNano()),
        Name:  "Fixture User",
        Role:  "user",
    })
    RequireNoError(t, err, "creating fixture user")
    return user
}
```

## Section 10: Race Condition Detection

The `-race` flag instruments the binary to detect data races at runtime. Always run tests with `-race` in CI.

```go
package cache_test

import (
    "sync"
    "testing"
)

// Cache is a simple in-memory cache (with intentional race condition for demo)
type Cache struct {
    mu    sync.RWMutex
    items map[string]string
}

func NewCache() *Cache {
    return &Cache{items: make(map[string]string)}
}

func (c *Cache) Set(key, value string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.items[key] = value
}

func (c *Cache) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.items[key]
    return v, ok
}

// TestCacheConcurrentAccess tests the cache under concurrent load.
// Run with: go test -race ./...
func TestCacheConcurrentAccess(t *testing.T) {
    cache := NewCache()
    const goroutines = 100
    const operations = 1000

    var wg sync.WaitGroup
    wg.Add(goroutines * 2)

    // Writers
    for i := 0; i < goroutines; i++ {
        i := i
        go func() {
            defer wg.Done()
            for j := 0; j < operations; j++ {
                key := fmt.Sprintf("key-%d-%d", i, j)
                cache.Set(key, "value")
            }
        }()
    }

    // Readers
    for i := 0; i < goroutines; i++ {
        i := i
        go func() {
            defer wg.Done()
            for j := 0; j < operations; j++ {
                key := fmt.Sprintf("key-%d-%d", i, j)
                cache.Get(key)
            }
        }()
    }

    wg.Wait()
}
```

Run the full test suite with race detection and short timeouts for CI:

```bash
# Unit tests only (fast, no external dependencies)
go test -short -race -count=1 -timeout=120s ./...

# Integration tests (requires external services)
go test -run TestIntegration -race -count=1 -timeout=300s ./...

# Full suite with coverage
go test -race -count=1 -timeout=600s -coverprofile=coverage.out ./...

# Benchmark with race detection disabled (race detector adds overhead)
go test -bench=. -benchmem -count=3 ./...
```

## Summary

A production Go test suite combines multiple complementary strategies:

**Table-driven tests** cover the input space efficiently. Use `t.Parallel()` for subtests that share no state, and `go-cmp` for deep struct comparison with field exclusions.

**Testify suites** manage shared resources cleanly across test lifecycle hooks. Use transaction rollback in `TearDownTest` for database isolation without truncation overhead.

**Mockery-generated mocks** stay synchronized with interfaces automatically. The `EXPECT()` method from `with-expecter: true` provides a fluent, type-safe expectation API that fails clearly when expectations are not met.

**httptest** enables full HTTP handler testing including middleware chains without network overhead. Use `httptest.NewServer` when you need a real URL (for HTTP clients that cannot accept `http.Handler` directly).

**Testcontainers** eliminates the behavior gap between mocked databases and real ones. Use `testing.Short()` guards so unit test runs stay fast.

**Fuzzing** finds bugs that human-designed test cases miss. Add interesting seed corpus entries and let the fuzzer run for minutes to hours in CI.

**Benchmarks** catch performance regressions. Use `benchstat` to compare before and after changes, and `-memprofile` to find allocation regressions.

**Race detection** with `-race` is non-negotiable for concurrent code. It catches races that only manifest occasionally in production under load.
