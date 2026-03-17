---
title: "Go Testing Patterns: Table-Driven Tests, Test Fixtures, Fuzz Testing, and Integration Test Strategies"
date: 2028-08-01T00:00:00-05:00
draft: false
tags: ["Go", "Testing", "Table-Driven Tests", "Fuzz Testing", "Integration Tests"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go testing best practices: table-driven tests with subtests, fixture management, parallel test execution, fuzz testing for input validation, testcontainers for integration tests, and test coverage strategies."
more_link: "yes"
url: "/go-testing-patterns-table-driven-fuzz-guide/"
---

Tests that are easy to write, easy to read, and easy to maintain are one of the clearest indicators of code quality in a Go project. Go has an unusually good testing ecosystem — built-in test runner, benchmarks, example tests, fuzz testing, and now testcontainers support in the standard library — but using these tools effectively requires knowing the patterns that scale to large codebases.

This guide covers the full spectrum of Go testing: table-driven tests with proper subtests and parallel execution, fixture management, fuzz testing for finding edge cases in input parsers, testcontainers for database integration tests, test coverage strategies, and the patterns that make test suites fast and reliable.

<!--more-->

# Go Testing Patterns: From Unit Tests to Integration Testing

## The Testing Philosophy

Go's testing philosophy is pragmatic: prefer simple, explicit tests over sophisticated frameworks. The standard library `testing` package provides everything needed for unit and integration testing. External dependencies (testify, gomock) are useful but not required.

The key principles:
- Tests should be fast enough to run on every commit (unit tests under 100ms, integration tests under 5 seconds)
- Tests should be deterministic: the same code must produce the same result every run
- Test failures should produce clear error messages that point directly to the problem
- Tests should be easy to run locally with no special setup

## Section 1: Table-Driven Tests

Table-driven tests are idiomatic Go. They define test cases as data and run them through a single test function, making it easy to add new cases and impossible to miss testing a case.

### Basic Table-Driven Pattern

```go
// pkg/parser/url_test.go
package parser_test

import (
	"testing"

	"github.com/example/app/pkg/parser"
)

func TestParseURL(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantHost string
		wantPath string
		wantErr  bool
	}{
		{
			name:     "valid_https_url",
			input:    "https://example.com/api/v1",
			wantHost: "example.com",
			wantPath: "/api/v1",
		},
		{
			name:     "valid_http_url_with_port",
			input:    "http://localhost:8080/health",
			wantHost: "localhost:8080",
			wantPath: "/health",
		},
		{
			name:    "missing_scheme",
			input:   "example.com/path",
			wantErr: true,
		},
		{
			name:    "empty_string",
			input:   "",
			wantErr: true,
		},
		{
			name:     "url_with_query",
			input:    "https://api.example.com/search?q=test",
			wantHost: "api.example.com",
			wantPath: "/search",
		},
	}

	for _, tt := range tests {
		// Capture range variable for parallel tests.
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			// Parallel subtests run concurrently with other subtests in this table.
			t.Parallel()

			got, err := parser.ParseURL(tt.input)

			if (err != nil) != tt.wantErr {
				t.Errorf("ParseURL(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
				return
			}
			if err != nil {
				return // Expected error; no further checks.
			}

			if got.Host != tt.wantHost {
				t.Errorf("ParseURL(%q).Host = %q, want %q", tt.input, got.Host, tt.wantHost)
			}
			if got.Path != tt.wantPath {
				t.Errorf("ParseURL(%q).Path = %q, want %q", tt.input, got.Path, tt.wantPath)
			}
		})
	}
}
```

### Advanced Table Structure with Helper Types

```go
// pkg/auth/validator_test.go
package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/example/app/pkg/auth"
)

// testCase provides a structured test case definition.
type validationTestCase struct {
	name    string
	token   string
	setup   func(t *testing.T) *auth.Validator
	wantErr error
	wantSub string
}

func TestValidateToken(t *testing.T) {
	validKey := []byte("test-signing-key-32-bytes-long!!")
	expiredToken := mustMakeToken(t, validKey, time.Now().Add(-time.Hour))
	validToken := mustMakeToken(t, validKey, time.Now().Add(time.Hour))
	wrongKeyToken := mustMakeToken(t, []byte("wrong-key-32-bytes-long!!!!!!!!"), time.Now().Add(time.Hour))

	tests := []validationTestCase{
		{
			name:    "valid_token",
			token:   validToken,
			wantSub: "user123",
			setup: func(t *testing.T) *auth.Validator {
				return auth.NewValidator(validKey)
			},
		},
		{
			name:    "expired_token",
			token:   expiredToken,
			wantErr: auth.ErrTokenExpired,
			setup: func(t *testing.T) *auth.Validator {
				return auth.NewValidator(validKey)
			},
		},
		{
			name:    "wrong_signing_key",
			token:   wrongKeyToken,
			wantErr: auth.ErrInvalidSignature,
			setup: func(t *testing.T) *auth.Validator {
				return auth.NewValidator(validKey)
			},
		},
		{
			name:    "empty_token",
			token:   "",
			wantErr: auth.ErrInvalidToken,
			setup: func(t *testing.T) *auth.Validator {
				return auth.NewValidator(validKey)
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			validator := tt.setup(t)
			claims, err := validator.Validate(context.Background(), tt.token)

			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
				}
				return
			}

			if err != nil {
				t.Errorf("Validate() unexpected error: %v", err)
				return
			}

			if claims.Subject != tt.wantSub {
				t.Errorf("claims.Subject = %q, want %q", claims.Subject, tt.wantSub)
			}
		})
	}
}
```

## Section 2: Test Helpers and Fixtures

### Test Helper Functions

```go
// testhelpers/helpers.go
package testhelpers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// MustMarshalJSON marshals v to JSON or fails the test.
func MustMarshalJSON(t *testing.T, v interface{}) []byte {
	t.Helper() // Marks this as a helper so failures point to the caller.
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal JSON: %v", err)
	}
	return data
}

// AssertStatusCode fails the test if the response status code doesn't match.
func AssertStatusCode(t *testing.T, resp *http.Response, wantCode int) {
	t.Helper()
	if resp.StatusCode != wantCode {
		t.Errorf("status code = %d, want %d", resp.StatusCode, wantCode)
	}
}

// AssertJSONBody decodes the response body into v and fails on error.
func AssertJSONBody(t *testing.T, resp *http.Response, v interface{}) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode response body: %v", err)
	}
}

// NewTestServer creates a test HTTP server and returns the URL and a cleanup function.
func NewTestServer(t *testing.T, handler http.Handler) (url string, cleanup func()) {
	t.Helper()
	srv := httptest.NewServer(handler)
	return srv.URL, srv.Close
}
```

### Golden File Testing

Golden files store expected outputs and make it easy to update them when behavior changes:

```go
// pkg/renderer/renderer_test.go
package renderer_test

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/example/app/pkg/renderer"
)

// -update flag regenerates golden files instead of comparing.
var updateGolden = flag.Bool("update", false, "update golden files")

func TestRenderTemplate(t *testing.T) {
	tests := []struct {
		name     string
		template string
		data     map[string]interface{}
	}{
		{
			name:     "user_greeting",
			template: "greeting.tmpl",
			data:     map[string]interface{}{"Name": "Alice", "Role": "admin"},
		},
		{
			name:     "empty_list",
			template: "list.tmpl",
			data:     map[string]interface{}{"Items": []string{}},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := renderer.Render(tt.template, tt.data)
			if err != nil {
				t.Fatalf("Render(%q): %v", tt.template, err)
			}

			goldenFile := filepath.Join("testdata", tt.name+".golden")

			if *updateGolden {
				// Update mode: write the current output as the new golden file.
				if err := os.MkdirAll("testdata", 0755); err != nil {
					t.Fatalf("create testdata dir: %v", err)
				}
				if err := os.WriteFile(goldenFile, []byte(got), 0644); err != nil {
					t.Fatalf("write golden file: %v", err)
				}
				return
			}

			// Compare mode: compare against the golden file.
			want, err := os.ReadFile(goldenFile)
			if err != nil {
				t.Fatalf("read golden file %s: %v", goldenFile, err)
			}

			if strings.TrimSpace(got) != strings.TrimSpace(string(want)) {
				t.Errorf("output mismatch for %s:\ngot:\n%s\nwant:\n%s",
					tt.name, got, want)
			}
		})
	}
}

// To update golden files: go test ./pkg/renderer/... -update
```

### Test Fixtures with Cleanup

```go
// testhelpers/fixtures.go
package testhelpers

import (
	"os"
	"path/filepath"
	"testing"
)

// TempDir creates a temporary directory and registers cleanup.
func TempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "test-*")
	if err != nil {
		t.Fatalf("create temp dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// WriteFixture writes content to a file in testdata and returns the path.
func WriteFixture(t *testing.T, name, content string) string {
	t.Helper()
	dir := TempDir(t)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}
```

## Section 3: Mocking and Dependency Injection

### Interface-Based Mocks

```go
// pkg/notification/sender.go
package notification

// Sender sends notifications.
type Sender interface {
	Send(to, subject, body string) error
}

// EmailSender is the production email implementation.
type EmailSender struct {
	smtpHost string
	smtpPort int
}

func (e *EmailSender) Send(to, subject, body string) error {
	// Production SMTP implementation.
	return nil
}
```

```go
// pkg/notification/sender_test.go
package notification_test

import (
	"testing"

	"github.com/example/app/pkg/notification"
)

// mockSender records sent notifications for test assertions.
type mockSender struct {
	calls []mockSendCall
	err   error // If set, Send returns this error.
}

type mockSendCall struct {
	to      string
	subject string
	body    string
}

func (m *mockSender) Send(to, subject, body string) error {
	m.calls = append(m.calls, mockSendCall{to: to, subject: subject, body: body})
	return m.err
}

func (m *mockSender) AssertSentTo(t *testing.T, expectedTo string) {
	t.Helper()
	for _, call := range m.calls {
		if call.to == expectedTo {
			return
		}
	}
	t.Errorf("expected notification sent to %q, but was not. Calls: %v", expectedTo, m.calls)
}

func TestService_NotifyUser(t *testing.T) {
	mock := &mockSender{}
	svc := notification.NewService(mock)

	if err := svc.NotifyUser("user@example.com", "Welcome!"); err != nil {
		t.Fatalf("NotifyUser: %v", err)
	}

	mock.AssertSentTo(t, "user@example.com")
}
```

### Using gomock

For more complex mocking scenarios:

```bash
go install go.uber.org/mock/mockgen@latest
```

```go
//go:generate mockgen -source=sender.go -destination=mock_sender_test.go -package=notification_test
```

```go
// pkg/notification/service_test.go
package notification_test

import (
	"testing"

	"go.uber.org/mock/gomock"
	"github.com/example/app/pkg/notification"
)

func TestService_WithGomock(t *testing.T) {
	ctrl := gomock.NewController(t)
	// ctrl.Finish() is called automatically on test cleanup in gomock v2.

	mockSender := NewMockSender(ctrl)

	// Expect exactly one call to Send with specific arguments.
	mockSender.EXPECT().
		Send("user@example.com", gomock.Any(), gomock.Contains("Welcome")).
		Return(nil).
		Times(1)

	svc := notification.NewService(mockSender)
	if err := svc.NotifyUser("user@example.com", "Welcome!"); err != nil {
		t.Errorf("NotifyUser: %v", err)
	}
}
```

## Section 4: Fuzz Testing

Fuzz testing uses automated input generation to find edge cases that human-written test cases miss. Go 1.18+ includes a built-in fuzzer.

### Basic Fuzz Test

```go
// pkg/parser/url_fuzz_test.go
package parser_test

import (
	"strings"
	"testing"

	"github.com/example/app/pkg/parser"
)

// FuzzParseURL tests that ParseURL never panics on any input.
// This is the most basic fuzz test property: crash-freedom.
func FuzzParseURL(f *testing.F) {
	// Seed corpus: these values are always tested, even without fuzzing.
	f.Add("")
	f.Add("https://example.com/path?query=value#fragment")
	f.Add("http://user:pass@host:8080/path")
	f.Add("://invalid")
	f.Add(strings.Repeat("a", 10000)) // Very long string.
	f.Add("\x00\x01\x02")             // Binary data.
	f.Add("https://\xff.com")         // Invalid UTF-8.

	f.Fuzz(func(t *testing.T, input string) {
		// The fuzz target must not panic.
		// We do not check the return value; we only check for panics.
		_, _ = parser.ParseURL(input)
	})
}

// FuzzParseURLRoundTrip tests that parsing and re-serializing is idempotent.
func FuzzParseURLRoundTrip(f *testing.F) {
	f.Add("https://example.com/path")
	f.Add("http://localhost:8080")

	f.Fuzz(func(t *testing.T, input string) {
		parsed, err := parser.ParseURL(input)
		if err != nil {
			return // Invalid input; skip.
		}

		// Serialize and re-parse.
		reparsed, err := parser.ParseURL(parsed.String())
		if err != nil {
			t.Fatalf("re-parse of valid URL %q failed: %v", parsed.String(), err)
		}

		// The canonical form should be stable.
		if parsed.String() != reparsed.String() {
			t.Errorf("round-trip mismatch:\n  original: %q\n  reparsed: %q",
				parsed.String(), reparsed.String())
		}
	})
}
```

### Running Fuzz Tests

```bash
# Run the seed corpus (always fast, suitable for CI).
go test ./pkg/parser/ -run FuzzParseURL

# Run the fuzzer for a limited time.
go test ./pkg/parser/ -fuzz=FuzzParseURL -fuzztime=30s

# Run the fuzzer until a failure is found (for dedicated fuzz environments).
go test ./pkg/parser/ -fuzz=FuzzParseURL

# If a failure is found, the corpus is saved to testdata/fuzz/FuzzParseURL/.
# Subsequent runs always test the saved corpus.
ls testdata/fuzz/FuzzParseURL/
```

### Advanced Fuzz Test: JSON Parser

```go
// pkg/parser/json_fuzz_test.go
package parser_test

import (
	"encoding/json"
	"testing"

	"github.com/example/app/pkg/parser"
)

// FuzzParseJSON verifies that the custom JSON parser accepts all valid JSON
// and rejects all invalid JSON.
func FuzzParseJSON(f *testing.F) {
	// Valid JSON seeds.
	f.Add(`{}`)
	f.Add(`{"key": "value"}`)
	f.Add(`[1, 2, 3]`)
	f.Add(`null`)
	f.Add(`"string"`)
	f.Add(`{"nested": {"key": [1, null, true, false, 2.5]}}`)

	// Invalid JSON seeds (should be rejected).
	f.Add(`{invalid}`)
	f.Add(`{`)
	f.Add(`}`)
	f.Add(`'single-quoted'`)

	f.Fuzz(func(t *testing.T, input []byte) {
		// Determine whether the input is valid JSON.
		var standard interface{}
		stdErr := json.Unmarshal(input, &standard)

		// Parse with our custom parser.
		_, customErr := parser.ParseJSON(input)

		// Our parser must agree with the standard library.
		if (stdErr == nil) != (customErr == nil) {
			t.Errorf(
				"JSON validity disagreement for input %q:\n  stdlib: %v\n  custom: %v",
				input, stdErr, customErr,
			)
		}
	})
}
```

## Section 5: Integration Tests with Testcontainers

Testcontainers for Go allows integration tests to spin up real databases, message brokers, and other services without requiring them to be installed on the developer's machine.

### Database Integration Test

```go
// pkg/store/postgres_test.go
package store_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/example/app/pkg/store"
)

// setupPostgres starts a PostgreSQL container and returns a connection string.
// The container is automatically cleaned up when the test ends.
func setupPostgres(t *testing.T) string {
	t.Helper()
	ctx := context.Background()

	pgContainer, err := postgres.RunContainer(ctx,
		testcontainers.WithImage("postgres:16"),
		postgres.WithDatabase("testdb"),
		postgres.WithUsername("testuser"),
		postgres.WithPassword("testpass"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2)),
	)
	if err != nil {
		t.Fatalf("start postgres container: %v", err)
	}

	t.Cleanup(func() {
		if err := pgContainer.Terminate(ctx); err != nil {
			t.Logf("terminate postgres container: %v", err)
		}
	})

	connStr, err := pgContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("get connection string: %v", err)
	}

	return connStr
}

func TestUserStore_CreateAndGet(t *testing.T) {
	// Skip if integration tests are disabled.
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	connStr := setupPostgres(t)

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		t.Fatalf("connect to postgres: %v", err)
	}
	defer conn.Close(ctx)

	// Run migrations.
	s := store.New(conn)
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Test creating a user.
	user := &store.User{
		Email: "test@example.com",
		Name:  "Test User",
	}
	if err := s.CreateUser(ctx, user); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// Test retrieving the user.
	got, err := s.GetUserByEmail(ctx, "test@example.com")
	if err != nil {
		t.Fatalf("GetUserByEmail: %v", err)
	}

	if got.Name != user.Name {
		t.Errorf("user.Name = %q, want %q", got.Name, user.Name)
	}
}

// TestMain runs setup/teardown for all tests in the package.
func TestMain(m *testing.M) {
	// This is where package-level setup would go.
	// For testcontainers, each test creates its own container.
	os.Exit(m.Run())
}
```

### Redis Integration Test

```go
// pkg/cache/redis_test.go
package cache_test

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/redismod"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/example/app/pkg/cache"
)

func setupRedis(t *testing.T) *redis.Client {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping Redis integration test")
	}

	ctx := context.Background()
	container, err := redismod.RunContainer(ctx,
		testcontainers.WithImage("redis:7"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("Ready to accept connections")),
	)
	if err != nil {
		t.Fatalf("start redis: %v", err)
	}
	t.Cleanup(func() { container.Terminate(ctx) })

	addr, err := container.Endpoint(ctx, "")
	if err != nil {
		t.Fatalf("redis endpoint: %v", err)
	}

	return redis.NewClient(&redis.Options{Addr: addr})
}

func TestCache_SetAndGet(t *testing.T) {
	client := setupRedis(t)
	c := cache.New(client)

	ctx := context.Background()

	// Set a value.
	if err := c.Set(ctx, "key1", "value1", time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}

	// Get the value.
	got, err := c.Get(ctx, "key1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != "value1" {
		t.Errorf("Get(%q) = %q, want %q", "key1", got, "value1")
	}

	// Miss case.
	_, err = c.Get(ctx, "missing")
	if !cache.IsNotFound(err) {
		t.Errorf("expected cache miss error, got %v", err)
	}
}
```

## Section 6: Benchmark Testing

```go
// pkg/crypto/aes_bench_test.go
package crypto_test

import (
	"testing"

	"github.com/example/app/pkg/crypto"
)

func BenchmarkEncrypt(b *testing.B) {
	key, _ := crypto.GenerateKey()
	sizes := []int{128, 1024, 64 * 1024, 1 << 20}

	for _, size := range sizes {
		plaintext := make([]byte, size)
		b.Run(fmt.Sprintf("%dB", size), func(b *testing.B) {
			b.SetBytes(int64(size))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_, _ = crypto.Encrypt(key, plaintext)
			}
		})
	}
}

func BenchmarkHashPassword(b *testing.B) {
	params := crypto.DefaultArgon2Params
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = crypto.HashPassword("test-password-123", params)
	}
}
```

```bash
# Run benchmarks.
go test -bench=BenchmarkEncrypt -benchmem -count=5 ./pkg/crypto/

# Compare benchmarks between two commits.
# Install benchstat.
go install golang.org/x/perf/cmd/benchstat@latest

# Capture baseline.
go test -bench=. -benchmem -count=10 ./... > before.txt
# Make changes, then capture after.
go test -bench=. -benchmem -count=10 ./... > after.txt
# Compare.
benchstat before.txt after.txt
```

## Section 7: Test Coverage Strategy

```bash
# Run tests with coverage.
go test -coverprofile=coverage.out ./...

# View coverage in the terminal.
go tool cover -func=coverage.out

# View coverage as HTML.
go tool cover -html=coverage.out -o coverage.html
open coverage.html

# Filter to show only packages below 80% coverage.
go tool cover -func=coverage.out | awk '$3+0 < 80 && $3+0 > 0 {print}' | sort -k3 -n
```

### Coverage in CI

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-go@v5
      with:
        go-version: '1.22'

    - name: Run unit tests
      run: go test -short -race -coverprofile=unit.out ./...

    - name: Run integration tests
      run: go test -run Integration -coverprofile=integration.out ./...

    - name: Merge coverage profiles
      run: |
        go install github.com/wadey/gocovmerge@latest
        gocovmerge unit.out integration.out > combined.out

    - name: Check coverage threshold
      run: |
        COVERAGE=$(go tool cover -func=combined.out | tail -1 | awk '{print $3}' | tr -d '%')
        echo "Coverage: ${COVERAGE}%"
        if (( $(echo "$COVERAGE < 75" | bc -l) )); then
          echo "Coverage ${COVERAGE}% is below threshold 75%"
          exit 1
        fi

    - name: Upload coverage
      uses: codecov/codecov-action@v4
      with:
        files: combined.out
```

## Section 8: Test Organization Patterns

### Package Layout

```
pkg/
  user/
    user.go          # Production code
    user_test.go     # White-box tests (package user)
    user_external_test.go  # Black-box tests (package user_test)
    testdata/
      fixtures.json  # Test fixtures
      golden/        # Golden files
    mock_test.go     # Mock implementations (package user_test)
```

### Build Tags for Test Categories

```go
//go:build integration

// pkg/store/postgres_integration_test.go
package store_test

// Integration tests require a running PostgreSQL instance.
// Run with: go test -tags=integration ./pkg/store/
```

```bash
# Run only unit tests (fast, suitable for pre-commit hooks).
go test -short ./...

# Run unit + integration tests.
go test -tags=integration ./...

# Run unit + integration + e2e tests.
go test -tags="integration e2e" ./...
```

## Section 9: Testing HTTP Handlers

```go
// pkg/api/handlers_test.go
package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/example/app/pkg/api"
	"github.com/example/app/pkg/store"
	testhelpers "github.com/example/app/testhelpers"
)

func TestCreateUser_Success(t *testing.T) {
	// Set up a mock store.
	mockStore := &store.MockStore{}
	mockStore.CreateUserFunc = func(ctx context.Context, user *store.User) error {
		user.ID = "generated-id"
		return nil
	}

	// Create the handler.
	h := api.NewHandler(mockStore)

	// Create the request.
	body, _ := json.Marshal(map[string]string{
		"email": "new@example.com",
		"name":  "New User",
	})
	req := httptest.NewRequest(http.MethodPost, "/users", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	// Record the response.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	// Assert status code.
	testhelpers.AssertStatusCode(t, rr.Result(), http.StatusCreated)

	// Assert response body.
	var resp map[string]string
	testhelpers.AssertJSONBody(t, rr.Result(), &resp)

	if resp["id"] != "generated-id" {
		t.Errorf("response id = %q, want %q", resp["id"], "generated-id")
	}
}

func TestCreateUser_InvalidJSON(t *testing.T) {
	h := api.NewHandler(nil) // Nil store is fine; we shouldn't reach it.

	req := httptest.NewRequest(http.MethodPost, "/users",
		bytes.NewReader([]byte("not json")))
	req.Header.Set("Content-Type", "application/json")

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	testhelpers.AssertStatusCode(t, rr.Result(), http.StatusBadRequest)
}
```

## Section 10: Race Condition Detection

```bash
# Always run tests with the race detector in CI.
go test -race ./...

# Run benchmarks with the race detector too.
go test -race -bench=. ./...
```

### Testing Concurrent Code

```go
// pkg/cache/concurrent_test.go
package cache_test

import (
	"sync"
	"testing"

	"github.com/example/app/pkg/cache"
)

// TestCache_ConcurrentAccess verifies that the cache is safe for concurrent use.
// This test is meaningless without -race; run as:
// go test -race ./pkg/cache/ -run TestCache_ConcurrentAccess
func TestCache_ConcurrentAccess(t *testing.T) {
	c := cache.New()

	const goroutines = 100
	const iterations = 1000

	var wg sync.WaitGroup
	wg.Add(goroutines * 2)

	// Writers.
	for i := 0; i < goroutines; i++ {
		go func(id int) {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := fmt.Sprintf("key-%d-%d", id, j)
				c.Set(key, id)
			}
		}(i)
	}

	// Readers.
	for i := 0; i < goroutines; i++ {
		go func(id int) {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := fmt.Sprintf("key-%d-%d", id, j)
				_ = c.Get(key)
			}
		}(i)
	}

	wg.Wait()
}
```

## Section 11: Testing Checklist

**Test Quality**
- Every public function should have at least one test
- Table-driven tests for functions with multiple input/output combinations
- Always test error paths, not just the happy path
- Use `t.Helper()` in helper functions to get accurate line numbers in failure messages

**Performance**
- Mark all tests that can run in parallel with `t.Parallel()`
- Use `testing.Short()` to skip slow tests during development
- Use testcontainers to isolate integration tests without requiring external infrastructure

**Correctness**
- Run with `-race` in CI to detect race conditions
- Include fuzz targets for all input parsing functions
- Use golden file tests for complex outputs (HTML, JSON reports)

**Maintenance**
- Keep test cases close to the production code
- Update golden files with `-update` flag, not manually
- Document the purpose of complex test fixtures

## Conclusion

Go's testing ecosystem rewards a disciplined, consistent approach. Table-driven tests make it easy to add test cases and communicate intent. Fuzz testing finds bugs that no human would write a test for. Testcontainers makes integration tests reliable and portable. The race detector catches concurrency bugs before they reach production.

The patterns in this guide — from helper functions with `t.Helper()` to ScaledJob for batch workers, from golden files for complex output to build tags for test categories — represent the practices that make large Go codebases maintainable and reliable over time. Tests are not a tax on development; they are the feedback loop that makes confident, rapid iteration possible.
