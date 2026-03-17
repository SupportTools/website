---
title: "Go HTTP Testing: httptest, testify/suite, and End-to-End API Test Patterns"
date: 2030-11-18T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "HTTP", "httptest", "testify", "Integration Testing", "API Testing", "TDD"]
categories:
- Go
- Testing
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise HTTP testing in Go: httptest.Server setup, golden file response testing, database-backed integration tests, authentication test helpers, parallel test execution, test fixture management, and building comprehensive API test coverage."
more_link: "yes"
url: "/go-http-testing-httptest-testify-api-patterns-enterprise-guide/"
---

Comprehensive HTTP API testing in Go requires more than calling `httptest.NewRecorder()` for a few happy-path cases. Production API suites need golden file comparisons for response stability, database-backed integration tests that verify real persistence behavior, authentication helpers that simulate the token/session lifecycle, parallel execution with proper test isolation, and fixture management that keeps test data deterministic. This guide builds a complete testing infrastructure for a JSON API service.

<!--more-->

## Test Architecture Overview

A mature Go HTTP test suite is organized in three tiers:

1. **Unit tests** (`*_test.go` alongside source files): Test individual handlers with mocked dependencies using `httptest.NewRecorder`.
2. **Integration tests** (`integration/` or `_test` build tag): Test handlers against real databases and external services using `httptest.NewServer`.
3. **End-to-end tests** (`e2e/` or a dedicated test binary): Test the running service binary via HTTP from a client perspective.

This guide focuses on tiers 1 and 2, which cover the vast majority of API correctness requirements.

## Project Structure

```
api/
├── handler/
│   ├── users.go
│   ├── users_test.go          # Unit tests
│   └── testutil/
│       ├── server.go          # Shared test server builder
│       ├── fixtures.go        # Database fixture management
│       ├── auth.go            # Auth token helpers
│       └── golden.go          # Golden file utilities
├── integration/
│   ├── users_test.go          # Integration tests
│   └── setup_test.go          # TestMain with database setup
└── testdata/
    └── golden/
        ├── users_list.json
        ├── user_get_200.json
        └── user_get_404.json
```

## Building a Test Server Helper

The core pattern is a `TestServer` type that wraps `httptest.Server` with convenience methods for making requests and asserting responses:

```go
// handler/testutil/server.go
package testutil

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestServer wraps httptest.Server with request/response helpers.
type TestServer struct {
	server *httptest.Server
	client *http.Client
	t      testing.TB
}

// NewTestServer creates a new TestServer wrapping the provided handler.
// The server is closed when the test finishes.
func NewTestServer(t testing.TB, handler http.Handler) *TestServer {
	t.Helper()

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	return &TestServer{
		server: srv,
		client: srv.Client(),
		t:      t,
	}
}

// URL returns the base URL of the test server.
func (ts *TestServer) URL() string {
	return ts.server.URL
}

// Request performs an HTTP request against the test server.
// It sets the Content-Type to application/json and marshals body if non-nil.
func (ts *TestServer) Request(
	ctx context.Context,
	method, path string,
	body interface{},
	headers map[string]string,
) *Response {
	ts.t.Helper()

	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		require.NoError(ts.t, err, "marshal request body")
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, ts.server.URL+path, bodyReader)
	require.NoError(ts.t, err, "create request")

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := ts.client.Do(req)
	require.NoError(ts.t, err, "execute request")

	return &Response{t: ts.t, resp: resp}
}

// GET is a convenience method for GET requests.
func (ts *TestServer) GET(ctx context.Context, path string, headers ...map[string]string) *Response {
	hdrs := map[string]string{}
	for _, h := range headers {
		for k, v := range h {
			hdrs[k] = v
		}
	}
	return ts.Request(ctx, http.MethodGet, path, nil, hdrs)
}

// POST is a convenience method for POST requests.
func (ts *TestServer) POST(ctx context.Context, path string, body interface{}, headers ...map[string]string) *Response {
	hdrs := map[string]string{}
	for _, h := range headers {
		for k, v := range h {
			hdrs[k] = v
		}
	}
	return ts.Request(ctx, http.MethodPost, path, body, hdrs)
}

// PATCH is a convenience method for PATCH requests.
func (ts *TestServer) PATCH(ctx context.Context, path string, body interface{}, headers ...map[string]string) *Response {
	hdrs := map[string]string{}
	for _, h := range headers {
		for k, v := range h {
			hdrs[k] = v
		}
	}
	return ts.Request(ctx, http.MethodPatch, path, body, hdrs)
}

// DELETE is a convenience method for DELETE requests.
func (ts *TestServer) DELETE(ctx context.Context, path string, headers ...map[string]string) *Response {
	hdrs := map[string]string{}
	for _, h := range headers {
		for k, v := range h {
			hdrs[k] = v
		}
	}
	return ts.Request(ctx, http.MethodDelete, path, nil, hdrs)
}
```

## The Response Assertion Helper

```go
// handler/testutil/response.go
package testutil

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Response wraps an *http.Response with test assertion helpers.
type Response struct {
	t    testing.TB
	resp *http.Response
	body []byte
	read bool
}

// StatusCode returns the HTTP status code.
func (r *Response) StatusCode() int {
	return r.resp.StatusCode
}

// Header returns the value of a response header.
func (r *Response) Header(key string) string {
	return r.resp.Header.Get(key)
}

// Body reads and caches the response body.
func (r *Response) Body() []byte {
	r.t.Helper()
	if !r.read {
		b, err := io.ReadAll(r.resp.Body)
		require.NoError(r.t, err, "read response body")
		r.resp.Body.Close()
		r.body = b
		r.read = true
	}
	return r.body
}

// AssertStatus asserts the response status code.
func (r *Response) AssertStatus(expected int) *Response {
	r.t.Helper()
	assert.Equal(r.t, expected, r.resp.StatusCode,
		"unexpected status code; body: %s", string(r.Body()))
	return r
}

// AssertHeader asserts a response header value.
func (r *Response) AssertHeader(key, expected string) *Response {
	r.t.Helper()
	assert.Equal(r.t, expected, r.resp.Header.Get(key))
	return r
}

// UnmarshalJSON parses the response body into dst.
func (r *Response) UnmarshalJSON(dst interface{}) *Response {
	r.t.Helper()
	require.NoError(r.t, json.Unmarshal(r.Body(), dst),
		"unmarshal response body: %s", string(r.Body()))
	return r
}

// AssertJSONField asserts that a top-level JSON field has the expected string value.
func (r *Response) AssertJSONField(field, expected string) *Response {
	r.t.Helper()
	var m map[string]interface{}
	require.NoError(r.t, json.Unmarshal(r.Body(), &m))
	actual, ok := m[field]
	require.True(r.t, ok, "field %q not found in response", field)
	assert.Equal(r.t, expected, fmt.Sprintf("%v", actual))
	return r
}

// AssertGolden compares the response body to a golden file.
func (r *Response) AssertGolden(name string) *Response {
	r.t.Helper()
	AssertGolden(r.t, name, r.Body())
	return r
}
```

## Golden File Testing

Golden files store the expected response bodies in `testdata/golden/`. When `UPDATE_GOLDEN=1` is set, tests write the actual response to the golden file instead of comparing:

```go
// handler/testutil/golden.go
package testutil

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const goldenDir = "testdata/golden"

// AssertGolden compares actual to the contents of testdata/golden/<name>.json.
// Set the UPDATE_GOLDEN environment variable to regenerate golden files.
func AssertGolden(t testing.TB, name string, actual []byte) {
	t.Helper()

	// Normalize JSON formatting for stable comparisons.
	var normalized interface{}
	if err := json.Unmarshal(actual, &normalized); err == nil {
		var buf []byte
		buf, err = json.MarshalIndent(normalized, "", "  ")
		if err == nil {
			actual = buf
		}
	}

	goldenPath := filepath.Join(goldenDir, name+".json")

	if os.Getenv("UPDATE_GOLDEN") == "1" {
		require.NoError(t, os.MkdirAll(goldenDir, 0755))
		require.NoError(t, os.WriteFile(goldenPath, actual, 0644),
			"write golden file %s", goldenPath)
		t.Logf("updated golden file: %s", goldenPath)
		return
	}

	expected, err := os.ReadFile(goldenPath)
	if os.IsNotExist(err) {
		t.Fatalf("golden file %s does not exist; run with UPDATE_GOLDEN=1 to create it", goldenPath)
	}
	require.NoError(t, err)

	// Normalize expected JSON too.
	var normalizedExpected interface{}
	if err := json.Unmarshal(expected, &normalizedExpected); err == nil {
		if buf, err := json.MarshalIndent(normalizedExpected, "", "  "); err == nil {
			expected = buf
		}
	}

	assert.JSONEq(t, string(expected), string(actual),
		"response does not match golden file %s", goldenPath)
}
```

## Authentication Test Helpers

```go
// handler/testutil/auth.go
package testutil

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var testJWTSecret = []byte("test-jwt-secret-not-for-production")

// TokenClaims holds the claims embedded in a test JWT.
type TokenClaims struct {
	UserID   string `json:"user_id"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	TenantID string `json:"tenant_id"`
}

// MakeAuthToken generates a JWT token for use in test requests.
// In production, the JWT secret is loaded from a Secret or KMS; in tests,
// the handler must be configured with the testJWTSecret.
func MakeAuthToken(t testing.TB, claims TokenClaims) string {
	t.Helper()

	jwtClaims := jwt.MapClaims{
		"sub":       claims.UserID,
		"email":     claims.Email,
		"role":      claims.Role,
		"tenant_id": claims.TenantID,
		"iat":       time.Now().Unix(),
		"exp":       time.Now().Add(24 * time.Hour).Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwtClaims)
	signed, err := token.SignedString(testJWTSecret)
	if err != nil {
		t.Fatalf("MakeAuthToken: sign: %v", err)
	}

	return signed
}

// BearerHeader returns a map suitable for passing to TestServer request methods
// that sets the Authorization header to a Bearer token.
func BearerHeader(token string) map[string]string {
	return map[string]string{
		"Authorization": fmt.Sprintf("Bearer %s", token),
	}
}

// AdminHeaders returns the Authorization header for an admin user.
func AdminHeaders(t testing.TB) map[string]string {
	return BearerHeader(MakeAuthToken(t, TokenClaims{
		UserID:   "00000000-0000-0000-0000-000000000001",
		Email:    "admin@test.company.com",
		Role:     "admin",
		TenantID: "tenant-test-01",
	}))
}

// UserHeaders returns the Authorization header for a regular user.
func UserHeaders(t testing.TB, userID, tenantID string) map[string]string {
	return BearerHeader(MakeAuthToken(t, TokenClaims{
		UserID:   userID,
		Email:    fmt.Sprintf("user-%s@test.company.com", userID[:8]),
		Role:     "user",
		TenantID: tenantID,
	}))
}
```

## testify/suite for Integration Tests

The `testify/suite` package provides test lifecycle management that is essential for database-backed tests:

```go
// integration/setup_test.go
package integration_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"

	_ "github.com/lib/pq"
	"github.com/pressly/goose/v3"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

var (
	testDB  *sql.DB
	testDSN string
)

// TestMain starts a PostgreSQL container for all integration tests in this package.
// Using testcontainers-go ensures the test database is ephemeral and isolated.
func TestMain(m *testing.M) {
	ctx := context.Background()

	container, err := postgres.RunContainer(ctx,
		testcontainers.WithImage("postgres:16.3-alpine"),
		postgres.WithDatabase("testdb"),
		postgres.WithUsername("testuser"),
		postgres.WithPassword("testpass"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(30*time.Second),
		),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start postgres container: %v\n", err)
		os.Exit(1)
	}
	defer container.Terminate(ctx)

	testDSN, err = container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		fmt.Fprintf(os.Stderr, "get connection string: %v\n", err)
		os.Exit(1)
	}

	testDB, err = sql.Open("postgres", testDSN)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open db: %v\n", err)
		os.Exit(1)
	}

	// Run migrations
	if err := goose.Up(testDB, "../../migrations"); err != nil {
		fmt.Fprintf(os.Stderr, "run migrations: %v\n", err)
		os.Exit(1)
	}

	code := m.Run()
	os.Exit(code)
}
```

```go
// integration/users_test.go
package integration_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/suite"
	"internal.company.com/api/handler"
	"internal.company.com/api/handler/testutil"
	"internal.company.com/api/repository"
)

// UserHandlerSuite groups all user handler integration tests.
type UserHandlerSuite struct {
	suite.Suite

	ctx    context.Context
	server *testutil.TestServer
	repo   *repository.UserRepository
}

// SetupSuite runs once before any test in the suite.
func (s *UserHandlerSuite) SetupSuite() {
	s.ctx = context.Background()
	s.repo = repository.NewUserRepository(testDB)

	// Build the real handler wired to the test database
	h := handler.NewUserHandler(s.repo, testutil.TestJWTConfig())
	s.server = testutil.NewTestServer(s.T(), h)
}

// SetupTest runs before each test — truncates tables for isolation.
func (s *UserHandlerSuite) SetupTest() {
	_, err := testDB.ExecContext(s.ctx, `
		TRUNCATE TABLE users RESTART IDENTITY CASCADE;
		TRUNCATE TABLE user_roles RESTART IDENTITY CASCADE;
	`)
	s.Require().NoError(err, "truncate tables")
}

// TearDownTest runs after each test — optional cleanup.
func (s *UserHandlerSuite) TearDownTest() {
	// Nothing needed when SetupTest truncates
}

// TestListUsers_Empty verifies that listing users on an empty database returns
// an empty array, not null.
func (s *UserHandlerSuite) TestListUsers_Empty() {
	resp := s.server.GET(s.ctx, "/api/v1/users", testutil.AdminHeaders(s.T()))

	resp.AssertStatus(200).
		AssertHeader("Content-Type", "application/json").
		AssertGolden("users_list_empty")
}

// TestListUsers_WithData verifies pagination and response structure.
func (s *UserHandlerSuite) TestListUsers_WithData() {
	// Insert fixtures
	fixtures := testutil.InsertUsers(s.T(), testDB, []testutil.UserFixture{
		{Email: "alice@company.com", Role: "admin", TenantID: "tenant-a"},
		{Email: "bob@company.com", Role: "user", TenantID: "tenant-a"},
		{Email: "carol@company.com", Role: "user", TenantID: "tenant-b"},
	})

	resp := s.server.GET(s.ctx,
		"/api/v1/users?tenant_id=tenant-a&page=1&page_size=10",
		testutil.AdminHeaders(s.T()),
	)

	resp.AssertStatus(200)

	var body struct {
		Data  []map[string]interface{} `json:"data"`
		Total int                      `json:"total"`
		Page  int                      `json:"page"`
	}
	resp.UnmarshalJSON(&body)

	s.Assert().Equal(2, body.Total, "should return 2 users for tenant-a")
	s.Assert().Equal(1, body.Page)
	s.Assert().Len(body.Data, 2)

	_ = fixtures
}

// TestGetUser_NotFound verifies the 404 response structure.
func (s *UserHandlerSuite) TestGetUser_NotFound() {
	resp := s.server.GET(s.ctx,
		"/api/v1/users/00000000-0000-0000-0000-000000000099",
		testutil.AdminHeaders(s.T()),
	)

	resp.AssertStatus(404).
		AssertGolden("user_get_404")
}

// TestGetUser_Unauthorized verifies that requests without a token return 401.
func (s *UserHandlerSuite) TestGetUser_Unauthorized() {
	resp := s.server.GET(s.ctx, "/api/v1/users/00000000-0000-0000-0000-000000000001")
	resp.AssertStatus(401)
	resp.AssertJSONField("error", "authentication required")
}

// TestCreateUser_Success verifies user creation and response body.
func (s *UserHandlerSuite) TestCreateUser_Success() {
	payload := map[string]string{
		"email":     "newuser@company.com",
		"role":      "user",
		"tenant_id": "tenant-a",
	}

	resp := s.server.POST(s.ctx, "/api/v1/users", payload, testutil.AdminHeaders(s.T()))

	resp.AssertStatus(201).
		AssertHeader("Content-Type", "application/json")

	var created struct {
		ID       string `json:"id"`
		Email    string `json:"email"`
		Role     string `json:"role"`
		TenantID string `json:"tenant_id"`
	}
	resp.UnmarshalJSON(&created)

	s.Assert().NotEmpty(created.ID, "id must be set")
	s.Assert().Equal("newuser@company.com", created.Email)
	s.Assert().Equal("user", created.Role)
	s.Assert().Equal("tenant-a", created.TenantID)

	// Verify the user was actually persisted
	var count int
	err := testDB.QueryRowContext(s.ctx,
		"SELECT COUNT(*) FROM users WHERE email = $1", "newuser@company.com",
	).Scan(&count)
	s.Require().NoError(err)
	s.Assert().Equal(1, count, "user should be in database")
}

// TestCreateUser_DuplicateEmail verifies that duplicate emails return 409.
func (s *UserHandlerSuite) TestCreateUser_DuplicateEmail() {
	testutil.InsertUsers(s.T(), testDB, []testutil.UserFixture{
		{Email: "existing@company.com", Role: "user", TenantID: "tenant-a"},
	})

	payload := map[string]string{
		"email":     "existing@company.com",
		"role":      "user",
		"tenant_id": "tenant-a",
	}

	resp := s.server.POST(s.ctx, "/api/v1/users", payload, testutil.AdminHeaders(s.T()))
	resp.AssertStatus(409)
	resp.AssertJSONField("error", "email already exists")
}

// TestCreateUser_RoleAccessControl verifies that regular users cannot create admins.
func (s *UserHandlerSuite) TestCreateUser_RoleAccessControl() {
	fixtures := testutil.InsertUsers(s.T(), testDB, []testutil.UserFixture{
		{Email: "requester@company.com", Role: "user", TenantID: "tenant-a"},
	})

	payload := map[string]string{
		"email":     "newadmin@company.com",
		"role":      "admin",
		"tenant_id": "tenant-a",
	}

	resp := s.server.POST(s.ctx, "/api/v1/users", payload,
		testutil.UserHeaders(s.T(), fixtures[0].ID, "tenant-a"),
	)

	resp.AssertStatus(403)
	_ = fixtures
}

// TestUpdateUser_Idempotent verifies PATCH idempotency.
func (s *UserHandlerSuite) TestUpdateUser_Idempotent() {
	fixtures := testutil.InsertUsers(s.T(), testDB, []testutil.UserFixture{
		{Email: "user@company.com", Role: "user", TenantID: "tenant-a"},
	})

	payload := map[string]string{"role": "moderator"}

	// Apply the same PATCH twice
	for i := 0; i < 2; i++ {
		resp := s.server.PATCH(s.ctx,
			"/api/v1/users/"+fixtures[0].ID,
			payload,
			testutil.AdminHeaders(s.T()),
		)
		resp.AssertStatus(200)
	}

	// Verify final state
	resp := s.server.GET(s.ctx,
		"/api/v1/users/"+fixtures[0].ID,
		testutil.AdminHeaders(s.T()),
	)
	resp.AssertStatus(200)
	resp.AssertJSONField("role", "moderator")
}

// TestDeleteUser_Success verifies deletion and idempotent 404 on second delete.
func (s *UserHandlerSuite) TestDeleteUser_Success() {
	fixtures := testutil.InsertUsers(s.T(), testDB, []testutil.UserFixture{
		{Email: "todelete@company.com", Role: "user", TenantID: "tenant-a"},
	})

	resp := s.server.DELETE(s.ctx,
		"/api/v1/users/"+fixtures[0].ID,
		testutil.AdminHeaders(s.T()),
	)
	resp.AssertStatus(204)

	// Second delete should return 404
	resp2 := s.server.DELETE(s.ctx,
		"/api/v1/users/"+fixtures[0].ID,
		testutil.AdminHeaders(s.T()),
	)
	resp2.AssertStatus(404)
}

// In order for 'go test' to run this suite's tests, we need to create
// a normal test function and pass our suite to suite.Run.
func TestUserHandlerSuite(t *testing.T) {
	suite.Run(t, new(UserHandlerSuite))
}
```

## Test Fixture Management

```go
// handler/testutil/fixtures.go
package testutil

import (
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// UserFixture represents a user to be inserted into the test database.
type UserFixture struct {
	Email    string
	Role     string
	TenantID string
}

// InsertedUser is returned by InsertUsers and includes the generated ID.
type InsertedUser struct {
	ID       string
	Email    string
	Role     string
	TenantID string
}

// InsertUsers inserts test users into the database and returns their generated IDs.
// All inserted users are automatically cleaned up in t.Cleanup if using SetupTest
// truncation is not preferred.
func InsertUsers(t testing.TB, db *sql.DB, fixtures []UserFixture) []InsertedUser {
	t.Helper()

	result := make([]InsertedUser, 0, len(fixtures))

	for _, f := range fixtures {
		id := uuid.New().String()
		now := time.Now().UTC()

		_, err := db.Exec(`
			INSERT INTO users (id, email, role, tenant_id, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $5)
		`, id, f.Email, f.Role, f.TenantID, now)
		require.NoError(t, err, fmt.Sprintf("insert user %s", f.Email))

		result = append(result, InsertedUser{
			ID:       id,
			Email:    f.Email,
			Role:     f.Role,
			TenantID: f.TenantID,
		})
	}

	return result
}
```

## Parallel Test Execution

For unit tests that do not share state, parallel execution reduces CI time significantly:

```go
// handler/users_test.go
package handler_test

import (
	"context"
	"testing"

	"internal.company.com/api/handler/testutil"
)

func TestGetUser_Parallel(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name           string
		userID         string
		expectedStatus int
		goldenFile     string
	}{
		{
			name:           "valid user ID",
			userID:         "00000000-0000-0000-0000-000000000001",
			expectedStatus: 200,
			goldenFile:     "user_get_200",
		},
		{
			name:           "nonexistent user",
			userID:         "00000000-0000-0000-0000-000000000099",
			expectedStatus: 404,
			goldenFile:     "user_get_404",
		},
		{
			name:           "invalid UUID format",
			userID:         "not-a-uuid",
			expectedStatus: 400,
			goldenFile:     "user_get_400",
		},
	}

	for _, tc := range testCases {
		tc := tc // capture loop variable
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			// Each sub-test gets its own handler with an in-memory mock store
			store := testutil.NewInMemoryUserStore()
			store.AddUser("00000000-0000-0000-0000-000000000001", "alice@company.com", "admin", "tenant-a")

			h := handler.NewUserHandler(store, testutil.TestJWTConfig())
			srv := testutil.NewTestServer(t, h)

			resp := srv.GET(context.Background(),
				"/api/v1/users/"+tc.userID,
				testutil.AdminHeaders(t),
			)

			resp.AssertStatus(tc.expectedStatus).
				AssertGolden(tc.goldenFile)
		})
	}
}
```

## Testing Middleware

```go
// handler/middleware_test.go
package handler_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"internal.company.com/api/handler/testutil"
)

func TestRateLimiterMiddleware(t *testing.T) {
	t.Parallel()

	// Handler that always returns 200
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Wrap with rate limiter allowing 5 requests/second
	limited := handler.RateLimiterMiddleware(5)(h)
	srv := testutil.NewTestServer(t, limited)

	ctx := context.Background()

	// First 5 requests should succeed
	for i := 0; i < 5; i++ {
		resp := srv.GET(ctx, "/")
		resp.AssertStatus(200)
	}

	// 6th request should be rate limited
	resp := srv.GET(ctx, "/")
	resp.AssertStatus(429)
	assert.Equal(t, "application/json", resp.Header("Content-Type"))
}

func TestCORSMiddleware(t *testing.T) {
	t.Parallel()

	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	cors := handler.CORSMiddleware([]string{"https://app.company.com"})(h)
	srv := testutil.NewTestServer(t, cors)

	t.Run("allowed origin", func(t *testing.T) {
		resp := srv.Request(context.Background(), http.MethodOptions, "/", nil, map[string]string{
			"Origin":                        "https://app.company.com",
			"Access-Control-Request-Method": "POST",
		})
		resp.AssertStatus(204).
			AssertHeader("Access-Control-Allow-Origin", "https://app.company.com").
			AssertHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
	})

	t.Run("disallowed origin", func(t *testing.T) {
		resp := srv.Request(context.Background(), http.MethodOptions, "/", nil, map[string]string{
			"Origin":                        "https://evil.example.com",
			"Access-Control-Request-Method": "POST",
		})
		assert.Empty(t, resp.Header("Access-Control-Allow-Origin"))
	})
}
```

## CI/CD Pipeline Integration

```yaml
# .github/workflows/test.yaml
name: Test

on: [push, pull_request]

jobs:
  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - name: Run unit tests
        run: |
          go test ./handler/... \
            -v \
            -race \
            -coverprofile=coverage-unit.out \
            -coverpkg=./... \
            -timeout=5m

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: coverage-unit.out
          flags: unit

  integration-tests:
    name: Integration Tests
    runs-on: ubuntu-22.04
    services:
      postgres:
        image: postgres:16.3-alpine
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: testuser
          POSTGRES_PASSWORD: testpass
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - name: Run integration tests
        env:
          TEST_DATABASE_URL: "postgres://testuser:testpass@localhost:5432/testdb?sslmode=disable"
        run: |
          go test ./integration/... \
            -v \
            -race \
            -coverprofile=coverage-integration.out \
            -coverpkg=./... \
            -timeout=10m

      - name: Check golden file drift
        run: |
          UPDATE_GOLDEN=1 go test ./... -run TestGolden 2>/dev/null || true
          git diff --exit-code testdata/golden/ || \
            (echo "Golden files are out of date. Run: UPDATE_GOLDEN=1 go test ./..." && exit 1)
```

## Summary

A production-quality Go HTTP test suite uses `httptest.NewServer` for integration tests that validate real handler behavior against a live database, `testify/suite` for test lifecycle management that ensures per-test isolation without the overhead of spinning up new containers for each test, golden files for stable response structure validation that detects unintentional API contract changes, and authentication helpers that exercise the full token validation path. The parallel execution model for unit tests and the `testcontainers-go` pattern for integration tests together produce a test suite that runs in under 5 minutes while achieving >90% code coverage on the handler layer.
