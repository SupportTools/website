---
title: "Go Fuzzing for Security Testing: Finding Bugs with go test -fuzz"
date: 2028-06-12T00:00:00-05:00
draft: false
tags: ["Go", "Security", "Fuzzing", "Testing", "CI/CD", "Vulnerabilities"]
categories: ["Go", "Security", "Testing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go fuzzing for security testing: go test -fuzz mechanics, corpus management, finding panics and security vulnerabilities, CI integration, and fuzzing HTTP handlers, JSON parsers, and binary protocol parsers."
more_link: "yes"
url: "/go-fuzzing-security-testing/"
---

Go's native fuzzing engine, introduced in Go 1.18, provides a production-grade tool for finding security bugs that unit tests and manual review miss. Fuzzing generates unexpected inputs, discovers edge cases that trigger panics or incorrect behavior, and builds a corpus of interesting inputs that continuously expand test coverage. This guide covers the mechanics of Go fuzzing, corpus management, integration with CI pipelines, and practical fuzzing targets for the security-critical code paths most engineers encounter: HTTP handlers, JSON parsers, and binary protocol decoders.

<!--more-->

## What Fuzzing Finds That Tests Don't

Unit tests verify that known inputs produce expected outputs. Fuzzing discovers what happens with inputs you didn't think to test. The categories of bugs fuzzing finds:

- **Panics on malformed input**: `index out of range`, `nil pointer dereference`, `slice bounds out of range`
- **Integer overflow/underflow**: Arithmetic on attacker-controlled values
- **Off-by-one errors**: Buffer boundaries that only trigger with specific lengths
- **Type confusion**: Incorrect handling of type tags in binary formats
- **Regex denial of service (ReDoS)**: Catastrophically backtracking patterns
- **Infinite loops**: Parsers that cycle on certain inputs
- **Memory exhaustion**: Allocating attacker-controlled amounts of memory
- **Logic errors on boundary values**: Behavior at zero, max int64, empty strings

These bugs share a characteristic: they require specific input values to trigger, and no developer thinks to write a test case with `"\x00\xff\xfe\x00"` as a string field.

## Go Fuzzing Fundamentals

### A Minimal Fuzz Test

```go
package parser_test

import (
    "testing"

    "github.com/yourorg/service/parser"
)

// FuzzParseUserInput is a fuzz test for the user input parser.
// Run with: go test -fuzz=FuzzParseUserInput
// Run with seed corpus: go test -run=FuzzParseUserInput
func FuzzParseUserInput(f *testing.F) {
    // Seed corpus: provide known-interesting inputs
    f.Add("hello")
    f.Add("hello world")
    f.Add("")
    f.Add("   ")
    f.Add("hello\x00world")   // Null byte
    f.Add("hello\nworld")     // Newline
    f.Add(string(make([]byte, 10000))) // Large input
    f.Add("😀🎉🚀")                    // Unicode

    f.Fuzz(func(t *testing.T, input string) {
        // The fuzz function must not panic for any input
        // If it does, the fuzzer records the failing input
        result, err := parser.ParseUserInput(input)

        // Validate invariants that must hold for all inputs
        if err != nil {
            // Errors are acceptable; panics are not
            return
        }

        // If parsing succeeded, verify structural invariants
        if result == nil {
            t.Error("successful parse returned nil result")
        }

        // Round-trip invariant: parsing then re-serializing should be stable
        serialized := result.String()
        result2, err := parser.ParseUserInput(serialized)
        if err != nil {
            t.Errorf("round-trip failed: serialized=%q, err=%v", serialized, err)
        }
        if result2 != nil && result2.String() != serialized {
            t.Errorf("round-trip not idempotent: first=%q, second=%q", serialized, result2.String())
        }
    })
}
```

### Running the Fuzzer

```bash
# Run all seed corpus entries as regular tests (no fuzzing)
go test -run=FuzzParseUserInput

# Start fuzzing with 1 worker
go test -fuzz=FuzzParseUserInput

# Fuzz for 2 minutes then stop
go test -fuzz=FuzzParseUserInput -fuzztime=2m

# Fuzz with 4 parallel workers (uses all CPU cores by default)
go test -fuzz=FuzzParseUserInput -parallel=4

# Fuzz a specific package
go test -fuzz=FuzzParseUserInput ./pkg/parser/

# Show verbose output including each generated input
go test -fuzz=FuzzParseUserInput -v
```

### Understanding Fuzzer Output

```
fuzz: elapsed: 0s, gathering baseline coverage: 0/192 completed
fuzz: elapsed: 0s, gathering baseline coverage: 192/192 completed, now fuzzing with 8 workers
fuzz: elapsed: 3s, execs: 196109 (65366/sec), new interesting: 27 (total: 219)
fuzz: elapsed: 6s, execs: 410078 (71303/sec), new interesting: 31 (total: 223)
fuzz: elapsed: 9s, execs: 628591 (72802/sec), new interesting: 33 (total: 225)
--- FAIL: FuzzParseUserInput (9.48s)
    --- FAIL: FuzzParseUserInput (0.00s)
        fuzz.go:43: panic: runtime error: index out of range [256] with length 256
        ...

Failing input written to testdata/fuzz/FuzzParseUserInput/58e1e490...
To re-run:
go test -run=FuzzParseUserInput/58e1e490...
```

Key metrics:
- **execs**: Total executions
- **execs/sec**: Execution rate (higher = more inputs explored)
- **new interesting**: Inputs that found new code coverage paths

### Reproducing and Debugging Failures

```bash
# The failing input is written to testdata/fuzz/FuzzParseUserInput/<hash>
cat testdata/fuzz/FuzzParseUserInput/58e1e490...

# Reproduce the failure deterministically
go test -run=FuzzParseUserInput/58e1e490...

# Run with verbose output to see the exact input
go test -run=FuzzParseUserInput/58e1e490... -v
```

The failing input file format:

```
go test fuzz v1
string("hello\x00world\xff\xfe")
```

## Corpus Management

The corpus is the set of seed inputs the fuzzer uses as starting points. A good corpus dramatically improves coverage.

### Corpus Directory Structure

```
pkg/parser/
├── parser.go
├── parser_test.go
└── testdata/
    └── fuzz/
        └── FuzzParseUserInput/
            ├── seed-001      # Manual seed: empty input
            ├── seed-002      # Manual seed: typical input
            ├── seed-003      # Manual seed: Unicode
            ├── 58e1e490...   # Auto-generated: found a panic
            └── a3b2c1d0...   # Auto-generated: found interesting coverage
```

### Adding Seeds from Production Traffic

```go
// Capture real production inputs and add them as seeds
func TestCaptureProductionSeeds(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping production seed capture in short mode")
    }

    // Read real inputs from a file
    data, err := os.ReadFile("testdata/production_samples.json")
    if err != nil {
        t.Skip("production samples not available")
    }

    var samples []string
    json.Unmarshal(data, &samples)

    // Write each sample as a corpus entry
    for i, sample := range samples {
        path := fmt.Sprintf("testdata/fuzz/FuzzParseUserInput/production-%04d", i)
        content := fmt.Sprintf("go test fuzz v1\nstring(%q)\n", sample)
        os.WriteFile(path, []byte(content), 0644)
    }
}
```

### Minimizing the Corpus

After an extended fuzzing session, the corpus can contain redundant entries. Minimize it to remove inputs that don't add coverage:

```bash
# Run fuzzing in minimization mode
go test -fuzz=FuzzParseUserInput -fuzztime=10m
# Go's fuzzer automatically minimizes failing inputs when it finds them

# For corpus minimization (remove redundant entries that don't add coverage)
# Use the third-party tool corpus-tools or run coverage analysis
go test -run=FuzzParseUserInput -cover
```

## Fuzzing HTTP Handlers

HTTP handlers are prime targets for fuzzing. Attackers control the request body, headers, and URL parameters.

```go
package handler_test

import (
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"

    "github.com/yourorg/service/handler"
)

// FuzzCreateUser fuzzes the CreateUser HTTP handler.
func FuzzCreateUser(f *testing.F) {
    h := handler.NewCreateUserHandler(
        // Use a test database or in-memory store
        handler.NewTestUserStore(),
    )

    // Seed with typical request bodies
    f.Add(`{"username":"alice","email":"alice@example.com","password":"hunter2"}`)
    f.Add(`{}`)
    f.Add(`{"username":"","email":"","password":""}`)
    f.Add(`{"username":null,"email":null}`)
    f.Add(`["not", "an", "object"]`)
    f.Add(`null`)
    f.Add(`"just a string"`)
    f.Add(strings.Repeat(`{"key":"`, 1000))  // Malformed truncated JSON

    f.Fuzz(func(t *testing.T, body string) {
        req := httptest.NewRequest(
            http.MethodPost,
            "/api/v1/users",
            strings.NewReader(body),
        )
        req.Header.Set("Content-Type", "application/json")
        req.Header.Set("X-Request-ID", "fuzz-test-001")

        w := httptest.NewRecorder()

        // This must not panic for any input
        h.ServeHTTP(w, req)

        // Validate response invariants
        status := w.Code

        // Response must always have a valid HTTP status code
        if status < 100 || status >= 600 {
            t.Errorf("invalid status code: %d", status)
        }

        // For non-5xx responses, Content-Type must be set
        if status < 500 && w.Header().Get("Content-Type") == "" {
            t.Error("missing Content-Type header on non-5xx response")
        }

        // Response body must be valid JSON when Content-Type is application/json
        if strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
            var response interface{}
            if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
                t.Errorf("invalid JSON response body: %v\nbody: %s", err, w.Body.String())
            }
        }
    })
}
```

### Fuzzing with Multiple Input Fields

```go
// FuzzQueryEndpoint fuzzes a search endpoint with multiple parameters.
func FuzzQueryEndpoint(f *testing.F) {
    h := handler.NewSearchHandler(testSearchService)

    f.Add("alice", "asc", 0, 20)
    f.Add("", "desc", -1, 0)
    f.Add(strings.Repeat("a", 10000), "invalid", 0, 1000000)
    f.Add("'; DROP TABLE users; --", "asc", 0, 10)  // SQL injection attempt
    f.Add("../../../etc/passwd", "asc", 0, 10)       // Path traversal

    f.Fuzz(func(t *testing.T, query, sortDir string, offset, limit int) {
        req := httptest.NewRequest(
            http.MethodGet,
            fmt.Sprintf("/api/v1/search?q=%s&sort=%s&offset=%d&limit=%d",
                url.QueryEscape(query),
                url.QueryEscape(sortDir),
                offset,
                limit,
            ),
            nil,
        )
        req.Header.Set("Authorization", "Bearer test-token")

        w := httptest.NewRecorder()
        h.ServeHTTP(w, req)

        // Handler must not panic or return 500 for any input
        if w.Code >= 500 {
            t.Errorf("server error for query=%q sort=%q offset=%d limit=%d: %s",
                query, sortDir, offset, limit, w.Body.String())
        }
    })
}
```

## Fuzzing JSON Parsers

Custom JSON parsing code is a common source of security vulnerabilities. Fuzz test any code that manually parses JSON.

```go
package jsonparser_test

import (
    "encoding/json"
    "testing"

    "github.com/yourorg/service/protocol"
)

// FuzzParseWebhookPayload fuzzes the webhook payload parser.
// Webhook payloads come from external systems and should be treated as hostile.
func FuzzParseWebhookPayload(f *testing.F) {
    f.Add(`{"event":"user.created","data":{"id":1,"email":"a@b.com"}}`)
    f.Add(`{"event":"","data":null}`)
    f.Add(`{"event":"user.created","data":{"id":-9223372036854775808}}`) // MinInt64
    f.Add(`{"event":"user.created","data":{"id":9223372036854775807}}`)  // MaxInt64
    f.Add(`{}`)
    f.Add(`{"nested":{"nested":{"nested":{"deeply":true}}}}`)
    f.Add(`{"array":[` + strings.Repeat(`0,`, 10000) + `0]}`) // Large array

    f.Fuzz(func(t *testing.T, data []byte) {
        event, err := protocol.ParseWebhookPayload(data)
        if err != nil {
            // Errors are fine; panics are not
            return
        }

        // Invariant: if parsing succeeds, event type must be non-empty
        if event.Type == "" {
            t.Error("successfully parsed event with empty type")
        }

        // Invariant: re-serializing should produce valid JSON
        serialized, err := json.Marshal(event)
        if err != nil {
            t.Errorf("failed to serialize parsed event: %v", err)
        }

        // Invariant: re-parsing serialized form should succeed
        _, err = protocol.ParseWebhookPayload(serialized)
        if err != nil {
            t.Errorf("round-trip failed: %v\noriginal: %s\nserialized: %s",
                err, data, serialized)
        }
    })
}
```

### Fuzzing with Byte Slices

For binary protocols and raw byte inputs:

```go
func FuzzParseMessageFrame(f *testing.F) {
    // Custom binary protocol: [4-byte length][1-byte type][n-byte payload]
    f.Add([]byte{0x00, 0x00, 0x00, 0x05, 0x01, 0x68, 0x65, 0x6c, 0x6c, 0x6f}) // valid
    f.Add([]byte{})                                                               // empty
    f.Add([]byte{0xFF, 0xFF, 0xFF, 0xFF, 0x01})                                   // max length
    f.Add([]byte{0x00, 0x00, 0x00, 0x01, 0x99})                                   // unknown type

    f.Fuzz(func(t *testing.T, data []byte) {
        msg, err := protocol.ParseMessageFrame(data)
        if err != nil {
            return
        }

        // Invariant: payload length must match declared length
        if int(msg.DeclaredLength) != len(msg.Payload) {
            t.Errorf("length mismatch: declared=%d actual=%d",
                msg.DeclaredLength, len(msg.Payload))
        }

        // Invariant: type must be a known value
        if !protocol.IsKnownMessageType(msg.Type) {
            t.Errorf("unknown message type %d was accepted", msg.Type)
        }
    })
}
```

## Fuzzing Binary Protocol Parsers

Binary protocol parsers are high-risk targets for security vulnerabilities. TLS record parsing, gRPC framing, Protobuf decoding — all have had vulnerabilities found through fuzzing.

```go
package wire_test

import (
    "testing"

    "github.com/yourorg/service/wire"
)

// FuzzDecodeProtoMessage fuzzes a Protobuf decoder.
// Protobuf inputs from untrusted sources (user uploads, webhook payloads)
// should be fuzz-tested.
func FuzzDecodeProtoMessage(f *testing.F) {
    // Valid encoded messages from unit tests
    validMsg := &wire.SensorReading{
        SensorId:  "sensor-001",
        Timestamp: 1700000000,
        Value:     42.5,
    }
    validBytes, _ := proto.Marshal(validMsg)
    f.Add(validBytes)

    // Edge cases
    f.Add([]byte{})                           // Empty
    f.Add([]byte{0xFF, 0xFF, 0xFF, 0xFF})    // Invalid varint
    f.Add(bytes.Repeat([]byte{0x0A, 0x10}, 100)) // Repeated fields
    f.Add(make([]byte, 65536))                // Large zero input

    f.Fuzz(func(t *testing.T, data []byte) {
        var msg wire.SensorReading
        err := proto.Unmarshal(data, &msg)
        if err != nil {
            // Proto errors are fine; panics are not
            return
        }

        // If parsing succeeded, re-encoding must succeed
        encoded, err := proto.Marshal(&msg)
        if err != nil {
            t.Errorf("failed to re-encode successfully parsed message: %v", err)
        }

        // Re-decode must also succeed
        var msg2 wire.SensorReading
        if err := proto.Unmarshal(encoded, &msg2); err != nil {
            t.Errorf("failed to re-decode re-encoded message: %v", err)
        }
    })
}
```

### Fuzzing Cryptographic Operations

```go
// FuzzDecryptPayload fuzzes an authenticated decryption function.
// Focus: ensure invalid ciphertext never panics (may return errors).
func FuzzDecryptPayload(f *testing.F) {
    key := make([]byte, 32) // 256-bit key
    rand.Read(key)

    // Create valid ciphertexts as seeds
    plaintext := []byte("hello world")
    ciphertext, _ := crypto.Encrypt(key, plaintext)
    f.Add(ciphertext)

    // Truncated ciphertext
    f.Add(ciphertext[:len(ciphertext)/2])

    // Modified nonce
    modified := make([]byte, len(ciphertext))
    copy(modified, ciphertext)
    modified[0] ^= 0xFF
    f.Add(modified)

    f.Add([]byte{})
    f.Add(make([]byte, 12))  // Exactly nonce size (no ciphertext)

    f.Fuzz(func(t *testing.T, input []byte) {
        // Must not panic for any input
        // Expected result: either successful decrypt or a clearly marked error
        plaintext, err := crypto.Decrypt(key, input)
        if err != nil {
            // Errors are expected for invalid ciphertext
            return
        }

        // If decryption succeeded, the plaintext must be re-encryptable
        if len(plaintext) == 0 {
            t.Error("decryption succeeded but returned empty plaintext")
        }
    })
}
```

## Input Validation Fuzzing

Use fuzzing to verify that input validation is exhaustive:

```go
// FuzzValidateEmail fuzzes email validation logic.
// Email validation is notoriously tricky; fuzzing finds edge cases.
func FuzzValidateEmail(f *testing.F) {
    // Valid emails
    f.Add("user@example.com")
    f.Add("user+tag@example.co.uk")
    f.Add("user.name@subdomain.example.com")

    // Known tricky inputs
    f.Add("@example.com")          // No local part
    f.Add("user@")                 // No domain
    f.Add("user@.")                // Domain starts with dot
    f.Add("user@example.com.")     // Trailing dot
    f.Add(strings.Repeat("a", 255) + "@example.com")  // Max length
    f.Add("user@" + strings.Repeat("a", 255) + ".com") // Long domain

    f.Fuzz(func(t *testing.T, email string) {
        isValid := validation.IsValidEmail(email)

        if isValid {
            // If marked valid, verify our requirements:
            // 1. Contains exactly one @ sign
            atCount := strings.Count(email, "@")
            if atCount != 1 {
                t.Errorf("email marked valid with %d @ signs: %q", atCount, email)
            }

            // 2. Local part is not empty
            parts := strings.SplitN(email, "@", 2)
            if len(parts[0]) == 0 {
                t.Errorf("email marked valid with empty local part: %q", email)
            }

            // 3. Domain part is not empty
            if len(parts[1]) == 0 {
                t.Errorf("email marked valid with empty domain: %q", email)
            }

            // 4. Total length must be <= 254 characters (RFC 5321)
            if len(email) > 254 {
                t.Errorf("email longer than 254 chars marked valid: %q (length %d)", email, len(email))
            }
        }
    })
}
```

## CI Integration

### GitHub Actions Integration

```yaml
name: Fuzz Testing

on:
  schedule:
    # Run fuzzing nightly
    - cron: '0 2 * * *'
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      fuzz_time:
        description: 'Fuzzing duration per target'
        default: '5m'

jobs:
  fuzz:
    name: Fuzz ${{ matrix.target }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        target:
          - FuzzParseUserInput
          - FuzzCreateUser
          - FuzzDecodeProtoMessage
          - FuzzValidateEmail
          - FuzzParseMessageFrame
      fail-fast: false  # Run all targets even if one fails

    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      - name: Download corpus from cache
        uses: actions/cache@v4
        with:
          path: |
            **/testdata/fuzz
          key: fuzz-corpus-${{ matrix.target }}-${{ github.sha }}
          restore-keys: |
            fuzz-corpus-${{ matrix.target }}-

      - name: Run fuzzing
        run: |
          FUZZ_TIME="${{ github.event.inputs.fuzz_time || '2m' }}"
          go test -fuzz=${{ matrix.target }} \
            -fuzztime="${FUZZ_TIME}" \
            -v \
            ./...

      - name: Upload corpus on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: fuzz-failure-corpus-${{ matrix.target }}
          path: |
            **/testdata/fuzz/${{ matrix.target }}/
          retention-days: 30

      - name: Upload updated corpus
        uses: actions/cache/save@v4
        if: always()
        with:
          path: |
            **/testdata/fuzz
          key: fuzz-corpus-${{ matrix.target }}-${{ github.sha }}
```

### Running Corpus Tests in Regular CI

Every CI run should run the corpus as regular tests (without fuzzing):

```yaml
- name: Test with existing corpus (no fuzzing)
  run: |
    # -run=FuzzXxx runs the fuzz function with only corpus entries (no generation)
    go test -run=FuzzParseUserInput -v ./pkg/parser/
    go test -run=FuzzCreateUser -v ./handler/
    go test -run=FuzzDecodeProtoMessage -v ./protocol/
```

This ensures that any inputs found during previous fuzzing runs are replayed on every commit, catching regressions.

## Finding Security Bugs: Patterns and Examples

### Integer Overflow Example

```go
// Vulnerable code: allocates based on attacker-controlled length
func ParseFrameVulnerable(data []byte) ([]byte, error) {
    if len(data) < 4 {
        return nil, errors.New("too short")
    }
    length := int(binary.BigEndian.Uint32(data[:4]))
    // BUG: if length is very large, this allocates gigabytes of memory
    payload := make([]byte, length)
    if len(data[4:]) < length {
        return nil, errors.New("truncated")
    }
    copy(payload, data[4:])
    return payload, nil
}

// Fixed: validate length before allocation
func ParseFrameSafe(data []byte) ([]byte, error) {
    if len(data) < 4 {
        return nil, errors.New("too short")
    }
    length := int(binary.BigEndian.Uint32(data[:4]))

    // Validate: length must not exceed remaining data
    if length > len(data)-4 {
        return nil, fmt.Errorf("declared length %d exceeds remaining data %d", length, len(data)-4)
    }

    // Validate: length must not exceed maximum frame size
    const maxFrameSize = 1 * 1024 * 1024 // 1MB
    if length > maxFrameSize {
        return nil, fmt.Errorf("frame length %d exceeds maximum %d", length, maxFrameSize)
    }

    payload := make([]byte, length)
    copy(payload, data[4:4+length])
    return payload, nil
}
```

### Path Traversal Example

```go
// FuzzReadConfigFile fuzzes file reading to detect path traversal
func FuzzReadConfigFile(f *testing.F) {
    f.Add("database.yaml")
    f.Add("app.yaml")
    f.Add("../../../etc/passwd")
    f.Add("/etc/shadow")
    f.Add("config/../../../etc/passwd")
    f.Add("config\x00.yaml")  // Null byte injection

    f.Fuzz(func(t *testing.T, filename string) {
        config, err := configReader.ReadConfig("/etc/app/config", filename)
        if err != nil {
            return
        }

        // Invariant: successful reads must be from within the config directory
        // If this fires, path traversal is possible
        absPath, err := filepath.Abs(filepath.Join("/etc/app/config", filename))
        if err != nil {
            t.Errorf("Abs failed for %q: %v", filename, err)
            return
        }
        if !strings.HasPrefix(absPath, "/etc/app/config/") {
            t.Errorf("path traversal: resolved to %q for filename %q",
                absPath, filename)
        }
    })
}
```

## OSS-Fuzz Integration

For open-source projects, OSS-Fuzz provides continuous fuzzing infrastructure. Projects with fuzz tests can register:

```go
// build.sh: Required by OSS-Fuzz
#!/bin/bash -eu

go build ./...

# Compile fuzz targets into OSS-Fuzz format
compile_go_fuzzer github.com/yourorg/yourproject/pkg/parser FuzzParseUserInput fuzz_parse_user_input
compile_go_fuzzer github.com/yourorg/yourproject/handler FuzzCreateUser fuzz_create_user
```

## Measuring Fuzz Coverage

```bash
# Run fuzzing with coverage instrumentation
go test -fuzz=FuzzParseUserInput \
  -fuzztime=5m \
  -coverprofile=fuzz-coverage.out \
  ./pkg/parser/

# Generate coverage report
go tool cover -html=fuzz-coverage.out -o fuzz-coverage.html

# Check coverage percentage for the fuzz target
go tool cover -func=fuzz-coverage.out | grep parser
```

A well-fuzzed critical function should have >90% code coverage from the fuzzer alone. Lines not covered by fuzzing indicate code paths the fuzzer hasn't explored — often exactly the paths that contain security bugs.

## Operational Recommendations

For teams adopting Go fuzzing:

1. Write fuzz tests for all code that processes external input: HTTP bodies, JSON, binary protocols, file formats, URLs, and environment variables
2. Add the `testdata/fuzz/*/` directory to version control; the corpus is an asset
3. Run corpus tests (not full fuzzing) in every CI run to catch regressions from previously-found inputs
4. Schedule nightly fuzzing runs of 30-60 minutes per target using GitHub Actions or a dedicated fuzzing machine
5. Triage failures within 24 hours; a panic in a fuzz target is a potential security bug
6. When fixing a bug found by fuzzing, add the failing input as a named seed in the corpus
7. Fuzz targets are security documentation: they describe the invariants your parser must satisfy

Go's built-in fuzzing is one of the highest-value security investments available to Go teams. Unlike manual security review, fuzzing runs continuously, scales with CI resources, and finds bugs that no human reviewer would think to test.
