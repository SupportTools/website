---
title: "Go Fuzzing: Production-Grade Fuzz Testing for Security-Critical Code"
date: 2030-12-18T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Fuzzing", "Security", "Testing", "CI/CD", "Software Quality", "Vulnerability Research"]
categories:
- Go
- Security
- Testing
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go native fuzzing: writing effective fuzz targets, corpus management, coverage-guided fuzzing internals, finding real security vulnerabilities, integrating fuzz tests into CI/CD pipelines, and managing long-running fuzz campaigns for security-critical Go code."
more_link: "yes"
url: "/go-fuzzing-production-grade-fuzz-testing-security-critical-code/"
---

Go 1.18 introduced native fuzzing support — coverage-guided fuzzing built directly into the standard toolchain with no external dependencies. Unlike property-based testing, fuzzing automatically generates test inputs that exercise new code paths, often discovering bugs that no human would think to write a test case for. This guide covers everything from writing your first fuzz target to running production-grade continuous fuzzing campaigns.

<!--more-->

# Go Fuzzing: Production-Grade Fuzz Testing for Security-Critical Code

## Section 1: Understanding Go's Fuzzing Implementation

Go fuzzing uses coverage-guided mutation fuzzing. The fuzzer:

1. Starts with a seed corpus (provided test cases)
2. Runs the fuzz function with each seed
3. Mutates inputs that increase code coverage
4. Reports any input that causes a panic, a data race, or a custom assertion failure
5. Saves failing inputs to `testdata/fuzz/FuzzFunctionName/` for reproduction

### Coverage-Guided Fuzzing Internals

The Go runtime instruments the compiled code to track which branches are executed. When a mutated input exercises a previously unseen branch combination, the fuzzer adds that input to its working corpus for further mutation. This directed exploration is far more effective than random input generation.

```
Seed corpus → Mutation engine → Instrumented binary
                                     ↓
                              Branch coverage tracking
                                     ↓
               New coverage? → Add to working corpus
                    ↓
               No new coverage → Discard mutation
                    ↓
               Crash/panic? → Save to testdata/fuzz/
```

### Fuzz Test vs Regular Test

```go
// Regular test — you specify the inputs
func TestParseURL(t *testing.T) {
    tests := []struct {
        input   string
        wantErr bool
    }{
        {"https://example.com", false},
        {"not-a-url", true},
        {"", true},
    }
    for _, tt := range tests {
        t.Run(tt.input, func(t *testing.T) {
            _, err := ParseURL(tt.input)
            if (err != nil) != tt.wantErr {
                t.Errorf("ParseURL(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
            }
        })
    }
}

// Fuzz test — the fuzzer generates inputs automatically
func FuzzParseURL(f *testing.F) {
    // Seed corpus — give the fuzzer a starting point
    f.Add("https://example.com/path?query=value#fragment")
    f.Add("http://user:pass@host:8080/path")
    f.Add("ftp://files.example.com/file.txt")
    f.Add("")
    f.Add("not-a-url")
    f.Add("javascript:alert(1)")
    f.Add("data:text/html,<h1>Hello</h1>")

    // The fuzz function — called with each generated input
    f.Fuzz(func(t *testing.T, input string) {
        // We're not testing for correctness here, just that the function
        // doesn't panic, infinite loop, or produce contradictory results
        url1, err1 := ParseURL(input)

        // Stability check: parsing the same input twice must give the same result
        url2, err2 := ParseURL(input)
        if (err1 == nil) != (err2 == nil) {
            t.Errorf("inconsistent error for input %q: %v vs %v", input, err1, err2)
        }
        if err1 == nil && url1.String() != url2.String() {
            t.Errorf("inconsistent output for input %q: %q vs %q", input, url1.String(), url2.String())
        }

        // Round-trip check: parse → serialize → parse must give the same result
        if err1 == nil {
            serialized := url1.String()
            url3, err3 := ParseURL(serialized)
            if err3 != nil {
                t.Errorf("round-trip failed for input %q: serialized to %q, parse error: %v",
                    input, serialized, err3)
            }
            if url3 != nil && url3.String() != serialized {
                t.Errorf("round-trip unstable for input %q: %q → %q → %q",
                    input, input, serialized, url3.String())
            }
        }
    })
}
```

## Section 2: Writing Effective Fuzz Targets

### Supported Fuzz Types

Go's fuzzer can generate the following types:
```go
// All supported types as fuzz function parameters
f.Fuzz(func(t *testing.T,
    s string,
    b []byte,
    i int,
    i8 int8,
    i16 int16,
    i32 int32,
    i64 int64,
    u uint,
    u8 uint8,
    u16 uint16,
    u32 uint32,
    u64 uint64,
    f32 float32,
    f64 float64,
    boolVal bool,
) {
    // ... test body
})
```

### Fuzz Testing a Parser

```go
// internal/parser/json_parser_test.go
package parser_test

import (
    "encoding/json"
    "testing"

    "myapp/internal/parser"
)

// FuzzJSONParser verifies our custom JSON parser against encoding/json.
func FuzzJSONParser(f *testing.F) {
    // Diverse seed corpus
    seeds := []string{
        `{}`,
        `{"key": "value"}`,
        `{"nested": {"a": 1, "b": [1, 2, 3]}}`,
        `null`,
        `true`,
        `false`,
        `42`,
        `3.14`,
        `""`,
        `"hello, world"`,
        `[]`,
        `[1, 2, 3]`,
        // Edge cases
        `{"key": null}`,
        `{"unicode": "\u0000\u001f"}`,
        `{"large": 9999999999999999999}`,
        // Potentially problematic inputs
        `{"key": "value with \"quotes\""}`,
        `[` + string(make([]byte, 1000)) + `]`,
    }

    for _, seed := range seeds {
        f.Add([]byte(seed))
    }

    f.Fuzz(func(t *testing.T, data []byte) {
        // Property 1: Our parser must not panic
        ourResult, ourErr := parser.Parse(data)

        // Property 2: Consistency with stdlib
        var stdResult interface{}
        stdErr := json.Unmarshal(data, &stdResult)

        // If stdlib succeeds, our parser must also succeed
        if stdErr == nil && ourErr != nil {
            t.Errorf("stdlib accepted but our parser rejected: %q\nstdErr=%v ourErr=%v",
                data, stdErr, ourErr)
        }

        // If our parser succeeds, stdlib must also succeed
        // (our parser must not be more lenient than stdlib)
        if ourErr == nil && stdErr != nil {
            t.Errorf("our parser accepted but stdlib rejected: %q\nourErr=%v stdErr=%v",
                data, ourErr, stdErr)
        }

        // If both succeed, results must be semantically equivalent
        if ourErr == nil && stdErr == nil {
            ourJSON, err := json.Marshal(ourResult)
            if err != nil {
                t.Errorf("failed to re-marshal our result: %v", err)
                return
            }
            stdJSON, err := json.Marshal(stdResult)
            if err != nil {
                t.Errorf("failed to re-marshal stdlib result: %v", err)
                return
            }
            if string(ourJSON) != string(stdJSON) {
                t.Errorf("different results for input %q:\nours:   %s\nstdlib: %s",
                    data, ourJSON, stdJSON)
            }
        }
    })
}
```

### Fuzz Testing Cryptographic Code

```go
// internal/crypto/encrypt_test.go
package crypto_test

import (
    "bytes"
    "testing"

    "myapp/internal/crypto"
)

// FuzzEncryptDecrypt verifies encrypt/decrypt round-trip integrity.
// Critical property: decrypt(encrypt(plaintext, key), key) == plaintext
func FuzzEncryptDecrypt(f *testing.F) {
    f.Add([]byte("hello, world"), []byte("key16byteslong!"))
    f.Add([]byte(""), []byte("key16byteslong!"))
    f.Add([]byte{0x00, 0xff, 0x80, 0x7f}, []byte("key16byteslong!"))
    f.Add(make([]byte, 65536), []byte("key16byteslong!")) // Large input

    f.Fuzz(func(t *testing.T, plaintext []byte, key []byte) {
        // Skip invalid keys (the function handles this, but we want to
        // focus fuzzing on valid cases where bugs are more subtle)
        if len(key) != 16 && len(key) != 24 && len(key) != 32 {
            t.Skip()
        }

        // Encrypt
        ciphertext, err := crypto.Encrypt(plaintext, key)
        if err != nil {
            // Encryption should always succeed for valid keys
            t.Errorf("Encrypt(%x, %x) failed: %v", plaintext, key, err)
            return
        }

        // Verify ciphertext differs from plaintext (unless plaintext is empty)
        if len(plaintext) > 0 && bytes.Equal(plaintext, ciphertext) {
            t.Errorf("ciphertext equals plaintext for input %x", plaintext)
        }

        // Decrypt — must recover the original plaintext
        decrypted, err := crypto.Decrypt(ciphertext, key)
        if err != nil {
            t.Errorf("Decrypt failed for ciphertext derived from %x: %v", plaintext, err)
            return
        }

        if !bytes.Equal(plaintext, decrypted) {
            t.Errorf("round-trip failed:\n  plaintext:  %x\n  decrypted:  %x", plaintext, decrypted)
        }

        // Verify that modifying the ciphertext causes decryption to fail
        // (tests authentication/integrity)
        if len(ciphertext) > 0 {
            tampered := make([]byte, len(ciphertext))
            copy(tampered, ciphertext)
            tampered[0] ^= 0x01 // Flip one bit

            _, err := crypto.Decrypt(tampered, key)
            if err == nil {
                t.Errorf("tampered ciphertext was accepted for plaintext %x", plaintext)
            }
        }
    })
}
```

### Fuzz Testing Network Protocol Parsers

```go
// internal/protocol/http_parser_test.go
package protocol_test

import (
    "bufio"
    "bytes"
    "net/http"
    "testing"

    "myapp/internal/protocol"
)

// FuzzHTTPRequestParser verifies our HTTP request parser.
func FuzzHTTPRequestParser(f *testing.F) {
    // Valid HTTP requests as seeds
    f.Add([]byte("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"))
    f.Add([]byte("POST /api HTTP/1.1\r\nHost: example.com\r\nContent-Length: 5\r\n\r\nhello"))
    f.Add([]byte("GET /path?q=v&k=w HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n"))
    // Malformed requests
    f.Add([]byte("GET / HTTP/1.0\r\n\r\n"))
    f.Add([]byte("INVALID\r\n\r\n"))
    f.Add([]byte("\r\n\r\n"))
    f.Add([]byte{0x00, 0x01, 0x02})

    f.Fuzz(func(t *testing.T, data []byte) {
        // Parse with our parser
        ourReq, ourErr := protocol.ParseHTTPRequest(data)

        // Parse with stdlib for comparison
        stdReq, stdErr := http.ReadRequest(bufio.NewReader(bytes.NewReader(data)))
        if stdReq != nil {
            stdReq.Body.Close()
        }

        // Critical: no panics should occur (handled by test framework)

        // Consistency check
        if ourErr == nil && stdErr != nil {
            t.Errorf("our parser more lenient than stdlib for:\n%q\nour result: %+v\nstd error: %v",
                data, ourReq, stdErr)
        }

        // Security check: our parser must not be more permissive on Host headers
        if ourErr == nil && stdErr == nil {
            if ourReq.Host != stdReq.Host {
                t.Errorf("Host header mismatch for %q:\nours: %q\nstd:  %q",
                    data, ourReq.Host, stdReq.Host)
            }
        }
    })
}
```

## Section 3: Corpus Management

### Seed Corpus Structure

```
your-package/
├── parser.go
├── parser_test.go          # Contains FuzzXxx functions
└── testdata/
    └── fuzz/
        └── FuzzJSONParser/  # One directory per fuzz function
            ├── corpus/      # Seeds added programmatically via f.Add
            └── crashers/    # Inputs that caused failures (auto-generated)
                └── abc123   # Failing input (binary or text)
                └── abc123.output  # Error output for the failing input
```

### Manual Corpus Files

```bash
# Add a corpus file manually
mkdir -p testdata/fuzz/FuzzJSONParser

# Simple text corpus entry
echo -n '{"key": "\u0000"}' > testdata/fuzz/FuzzJSONParser/null-char-key

# Binary corpus entry (base64-encoded in the file)
cat > testdata/fuzz/FuzzJSONParser/edge-case-001 << 'EOF'
go test fuzz v1
[]byte("\x00\xff\x80\x7f\xfe")
EOF
```

### Extracting Corpus from Production Traffic

```go
// middleware/fuzz_corpus_collector.go
//go:build fuzz_collect
// +build fuzz_collect

package middleware

import (
    "crypto/sha256"
    "fmt"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "sync/atomic"
)

// corpusCollector samples production requests for use as fuzz corpus.
// Only compiled when -tags fuzz_collect is used — never in production.
type corpusCollector struct {
    dir     string
    counter int64
    rate    int64 // Sample 1 in N requests
}

func newCorpusCollector(dir string, rate int64) *corpusCollector {
    os.MkdirAll(dir, 0755)
    return &corpusCollector{dir: dir, rate: rate}
}

func (c *corpusCollector) Wrap(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if atomic.AddInt64(&c.counter, 1)%c.rate == 0 {
            body, err := io.ReadAll(r.Body)
            if err == nil {
                hash := sha256.Sum256(body)
                filename := filepath.Join(c.dir, fmt.Sprintf("%x", hash[:8]))
                os.WriteFile(filename, body, 0644)
            }
        }
        next.ServeHTTP(w, r)
    })
}
```

## Section 4: Running Fuzz Tests

### Basic Fuzzing

```bash
# Run the fuzzer for 30 seconds
go test -fuzz=FuzzJSONParser -fuzztime=30s ./internal/parser/

# Run until a failure is found (no time limit)
go test -fuzz=FuzzJSONParser ./internal/parser/

# Run with specific GOOS/GOARCH (important for finding platform-specific bugs)
GOOS=linux GOARCH=amd64 go test -fuzz=FuzzJSONParser -fuzztime=60s ./internal/parser/

# Run multiple fuzzing jobs in parallel
for fuzz_func in FuzzJSONParser FuzzEncryptDecrypt FuzzHTTPRequestParser; do
    go test -fuzz=$fuzz_func -fuzztime=5m ./... &
done
wait
```

### Fuzzing with a Seed Corpus Directory

```bash
# Run against existing corpus only (useful for CI — fast, deterministic)
go test -run=FuzzJSONParser ./internal/parser/

# The -run flag without -fuzz executes corpus entries as regular tests
```

### Reproducing a Failure

```bash
# When the fuzzer finds a bug, it saves the input to testdata/fuzz/
ls testdata/fuzz/FuzzJSONParser/

# Reproduce the failure
go test -run=FuzzJSONParser/corpus/abc123 ./internal/parser/

# Or use -fuzz with the specific failing input
go test -run=FuzzJSONParser -v ./internal/parser/ < testdata/fuzz/FuzzJSONParser/abc123
```

## Section 5: Real Bugs Found by Fuzzing

### Example: Off-by-One in Buffer Parsing

```go
// BEFORE: Vulnerable code with off-by-one error
func ParseLengthPrefixedMessage(data []byte) ([]byte, error) {
    if len(data) < 4 {
        return nil, errors.New("too short")
    }
    length := binary.BigEndian.Uint32(data[:4])
    // BUG: Should be len(data)-4, not len(data)
    // This can be triggered by fuzzing with length = len(data)
    if int(length) > len(data) {
        return nil, errors.New("message too long")
    }
    return data[4 : 4+length], nil // Panic: index out of range
}

// AFTER: Fixed code
func ParseLengthPrefixedMessage(data []byte) ([]byte, error) {
    if len(data) < 4 {
        return nil, errors.New("too short")
    }
    length := binary.BigEndian.Uint32(data[:4])
    if int(length) > len(data)-4 {  // Fixed: compare against payload capacity
        return nil, fmt.Errorf("declared length %d exceeds available data %d", length, len(data)-4)
    }
    return data[4 : 4+length], nil
}

// Fuzz test that would have caught this
func FuzzParseLengthPrefixedMessage(f *testing.F) {
    f.Add([]byte{0, 0, 0, 5, 'h', 'e', 'l', 'l', 'o'}) // Valid
    f.Add([]byte{0, 0, 0, 0})                            // Empty message
    f.Add([]byte{0, 0, 0, 10, 'h', 'i'})                // Length > available data

    f.Fuzz(func(t *testing.T, data []byte) {
        // Must not panic
        result, err := ParseLengthPrefixedMessage(data)
        if err != nil {
            return
        }
        // If successful, result must be within bounds
        if len(result) > len(data)-4 {
            t.Errorf("result length %d > available %d", len(result), len(data)-4)
        }
    })
}
```

### Example: Integer Overflow in Allocation

```go
// BEFORE: Integer overflow vulnerability
func NewBuffer(size uint32, alignment uint32) []byte {
    // BUG: If alignment is 0, this panics with division by zero
    // If size + alignment overflows uint32, allocation is too small
    padded := (size + alignment - 1) / alignment * alignment
    return make([]byte, padded)
}

// AFTER: Safe version
func NewBuffer(size uint32, alignment uint32) ([]byte, error) {
    if alignment == 0 {
        return nil, errors.New("alignment must be non-zero")
    }
    if alignment&(alignment-1) != 0 {
        return nil, errors.New("alignment must be a power of two")
    }
    // Safe overflow-checked addition
    padded := (size + alignment - 1) & ^(alignment - 1)
    if padded < size {
        return nil, errors.New("size overflow")
    }
    return make([]byte, padded), nil
}

// Fuzz test
func FuzzNewBuffer(f *testing.F) {
    f.Add(uint32(100), uint32(16))
    f.Add(uint32(0), uint32(1))
    f.Add(uint32(1<<31-1), uint32(4096))

    f.Fuzz(func(t *testing.T, size uint32, alignment uint32) {
        buf, err := NewBuffer(size, alignment)
        if err != nil {
            return
        }
        if uint64(len(buf)) < uint64(size) {
            t.Errorf("buffer too small: allocated %d, requested %d", len(buf), size)
        }
        if alignment > 0 && uint64(len(buf))%uint64(alignment) != 0 {
            t.Errorf("buffer not aligned: len=%d, alignment=%d", len(buf), alignment)
        }
    })
}
```

## Section 6: Integrating Fuzzing into CI/CD

### GitHub Actions Fuzzing Pipeline

```yaml
# .github/workflows/fuzz.yaml
name: Fuzz Testing

on:
  # Run short fuzz on every PR
  pull_request:
    branches: [main]
  # Run extended fuzz nightly
  schedule:
    - cron: '0 2 * * *'
  # Allow manual trigger
  workflow_dispatch:
    inputs:
      fuzz_time:
        description: 'Fuzzing duration per target'
        required: false
        default: '5m'

jobs:
  fuzz-short:
    name: Short Fuzz (PR)
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - name: Run fuzz tests (30s each)
        run: |
          FUZZ_TIME=30s
          # Find all fuzz functions
          FUZZ_FUNCS=$(grep -rh "^func Fuzz" --include="*_test.go" . \
              | sed 's/func \(Fuzz[^(]*\).*/\1/' \
              | sort -u)

          for func in $FUZZ_FUNCS; do
            PKG=$(grep -rhl "^func ${func}" --include="*_test.go" . \
                | xargs -I{} dirname {} \
                | sed 's|^./||')
            echo "Fuzzing $func in $PKG for $FUZZ_TIME"
            go test -fuzz="^${func}$" -fuzztime="$FUZZ_TIME" "./${PKG}" \
                || { echo "FAILURE: $func found a bug!"; exit 1; }
          done

      # Save corpus to cache for next run
      - name: Cache fuzz corpus
        uses: actions/cache@v4
        with:
          path: '**/testdata/fuzz/**'
          key: fuzz-corpus-${{ github.sha }}
          restore-keys: fuzz-corpus-

  fuzz-extended:
    name: Extended Fuzz (Nightly)
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        # Run different functions in parallel
        target:
          - { pkg: './internal/parser/', func: 'FuzzJSONParser' }
          - { pkg: './internal/crypto/', func: 'FuzzEncryptDecrypt' }
          - { pkg: './internal/protocol/', func: 'FuzzHTTPRequestParser' }
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod

      - name: Restore corpus
        uses: actions/cache/restore@v4
        with:
          path: '**/testdata/fuzz/**'
          key: fuzz-corpus-

      - name: Run extended fuzz
        run: |
          FUZZ_TIME="${{ github.event.inputs.fuzz_time || '10m' }}"
          go test -fuzz="^${{ matrix.target.func }}$" \
              -fuzztime="$FUZZ_TIME" \
              "${{ matrix.target.pkg }}" \
              2>&1 | tee /tmp/fuzz-output.txt

          # Check if fuzzer found a bug
          if grep -q "FAIL" /tmp/fuzz-output.txt; then
            echo "Fuzzer found a bug in ${{ matrix.target.func }}"
            cat /tmp/fuzz-output.txt
            exit 1
          fi

      - name: Upload corpus on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: fuzz-failure-${{ matrix.target.func }}
          path: |
            **/testdata/fuzz/${{ matrix.target.func }}/
          retention-days: 30

      - name: Update corpus cache
        if: always()
        uses: actions/cache/save@v4
        with:
          path: '**/testdata/fuzz/**'
          key: fuzz-corpus-${{ github.sha }}-${{ matrix.target.func }}
```

### OSS-Fuzz Integration

For open-source projects, OSS-Fuzz provides continuous fuzzing at scale:

```go
// oss-fuzz/build.sh
#!/bin/bash -eu

go build -o "$OUT/fuzz" \
    -tags fuzz \
    -fuzz=FuzzJSONParser \
    ./internal/parser/
```

```go
// oss-fuzz/fuzz.go
//go:build fuzz

package main

import (
    "os"
    "testing"

    "myapp/internal/parser"
)

func main() {
    // Bridge between libFuzzer and Go fuzzing
    data, _ := os.ReadFile(os.Args[1])
    _ = parser.Parse(data)
}
```

## Section 7: Advanced Fuzzing Patterns

### Stateful Fuzzing

```go
// FuzzDatabaseOperations tests a sequence of database operations
func FuzzDatabaseOperations(f *testing.F) {
    // Seed: a sequence of operations encoded as bytes
    // Byte 0: operation type (0=get, 1=set, 2=delete, 3=list)
    // Bytes 1-16: key
    // Bytes 17-N: value (for set operations)
    f.Add([]byte{1, 'k', 'e', 'y', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'v', 'a', 'l', 'u', 'e'})
    f.Add([]byte{0, 'k', 'e', 'y', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0})

    f.Fuzz(func(t *testing.T, ops []byte) {
        db := database.NewInMemory()

        // Track expected state
        expected := make(map[string]string)

        i := 0
        for i < len(ops) {
            if i >= len(ops) {
                break
            }
            opType := ops[i] % 4
            i++

            // Extract key (fixed 16 bytes for simplicity)
            if i+16 > len(ops) {
                break
            }
            key := string(bytes.TrimRight(ops[i:i+16], "\x00"))
            i += 16

            switch opType {
            case 0: // Get
                got, err := db.Get(key)
                wantVal, wantExists := expected[key]
                if wantExists && (err != nil || got != wantVal) {
                    t.Errorf("Get(%q): want %q (exists=%v), got %q (err=%v)",
                        key, wantVal, wantExists, got, err)
                }
                if !wantExists && err == nil {
                    t.Errorf("Get(%q): expected not-found, got %q", key, got)
                }

            case 1: // Set
                if i >= len(ops) {
                    break
                }
                valLen := int(ops[i]) % 64
                i++
                if i+valLen > len(ops) {
                    valLen = len(ops) - i
                }
                value := string(ops[i : i+valLen])
                i += valLen

                if err := db.Set(key, value); err != nil {
                    t.Errorf("Set(%q, %q): unexpected error: %v", key, value, err)
                } else {
                    expected[key] = value
                }

            case 2: // Delete
                _ = db.Delete(key)
                delete(expected, key)

            case 3: // List keys
                keys, err := db.ListKeys()
                if err != nil {
                    t.Errorf("ListKeys: unexpected error: %v", err)
                }
                // Verify all expected keys are in the list
                keySet := make(map[string]bool)
                for _, k := range keys {
                    keySet[k] = true
                }
                for k := range expected {
                    if k != "" && !keySet[k] {
                        t.Errorf("ListKeys: missing expected key %q", k)
                    }
                }
            }
        }
    })
}
```

### Differential Fuzzing (Two Implementations)

```go
// FuzzParserDifferential compares two implementations of the same parser
func FuzzParserDifferential(f *testing.F) {
    f.Add([]byte("test input"))
    f.Add([]byte(""))
    f.Add([]byte{0xff, 0xfe, 0xfd})

    f.Fuzz(func(t *testing.T, input []byte) {
        // Two implementations of the same function
        result1, err1 := parser.ParseV1(input)
        result2, err2 := parser.ParseV2(input)

        // Both must agree on whether parsing succeeds
        if (err1 == nil) != (err2 == nil) {
            t.Errorf("v1 and v2 disagree on input %x:\nv1 err: %v\nv2 err: %v",
                input, err1, err2)
            return
        }

        // Both must produce the same output
        if err1 == nil {
            r1bytes, _ := json.Marshal(result1)
            r2bytes, _ := json.Marshal(result2)
            if !bytes.Equal(r1bytes, r2bytes) {
                t.Errorf("v1 and v2 produce different results for %x:\nv1: %s\nv2: %s",
                    input, r1bytes, r2bytes)
            }
        }
    })
}
```

### Fuzzing with Custom Mutators

```go
// For complex structured inputs, use a custom decoder to guide mutation
func FuzzHTTPRequest(f *testing.F) {
    // Encode HTTP request as bytes using our custom format
    encode := func(method, path, body string, headers map[string]string) []byte {
        var buf bytes.Buffer
        // Format: [method_len][method][path_len][path][headers_count][key_len][key][val_len][val]...[body_len][body]
        writeString := func(s string) {
            length := make([]byte, 2)
            binary.BigEndian.PutUint16(length, uint16(len(s)))
            buf.Write(length)
            buf.WriteString(s)
        }
        writeString(method)
        writeString(path)
        buf.WriteByte(byte(len(headers)))
        for k, v := range headers {
            writeString(k)
            writeString(v)
        }
        writeString(body)
        return buf.Bytes()
    }

    f.Add(encode("GET", "/api/v1/users", "", map[string]string{
        "Accept": "application/json",
    }))
    f.Add(encode("POST", "/api/v1/users", `{"name":"test"}`, map[string]string{
        "Content-Type": "application/json",
    }))

    f.Fuzz(func(t *testing.T, data []byte) {
        // Decode our custom format back to HTTP fields
        req, err := decodeHTTPRequest(data)
        if err != nil {
            t.Skip() // Invalid encoding, skip
        }

        // Test with the decoded request
        resp := processRequest(req)
        if resp.StatusCode < 100 || resp.StatusCode > 599 {
            t.Errorf("invalid status code %d for request %+v", resp.StatusCode, req)
        }
    })
}
```

Fuzzing finds bugs that no human would think to test for — off-by-one errors in parsers, integer overflows in allocations, and inconsistencies between implementations that only manifest at the boundaries of valid input space. Integrating Go's native fuzzer into CI pipelines ensures that as code evolves, these classes of bugs are caught before reaching production.
