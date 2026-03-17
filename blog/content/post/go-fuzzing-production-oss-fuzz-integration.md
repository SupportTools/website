---
title: "Go Fuzzing in Production: go-fuzz, OSS-Fuzz Integration, and Continuous Security Testing"
date: 2030-02-14T00:00:00-05:00
draft: false
tags: ["Go", "Fuzzing", "Security", "Testing", "OSS-Fuzz", "CI/CD", "go-fuzz"]
categories: ["Go", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Go fuzzing covering native go test fuzzing, go-fuzz corpus management, OSS-Fuzz CI integration, coverage-guided strategies, and finding real security vulnerabilities with automated fuzz testing."
more_link: "yes"
url: "/go-fuzzing-production-oss-fuzz-integration/"
---

Fuzzing has graduated from an academic exercise to a standard practice at every serious software organization. Go's native fuzzing support, introduced in Go 1.18 and matured significantly through subsequent releases, combined with the OSS-Fuzz continuous fuzzing infrastructure, gives Go teams a production-grade security testing pipeline that runs 24/7 against their codebase. This guide covers the full spectrum: writing effective fuzz targets, managing corpora at scale, integrating with OSS-Fuzz, and extracting actionable findings from coverage reports.

<!--more-->

## Why Fuzzing Finds Bugs That Tests Miss

Fuzzing operates by generating unexpected, malformed, or boundary-pushing inputs and observing whether the program panics, hangs, or produces incorrect results. This approach discovers classes of bugs that unit and integration tests consistently miss because human test authors naturally avoid the strange inputs that reveal bugs.

Real findings from fuzzing Go projects include:

- Integer overflow in protobuf varint decoding causing incorrect message boundaries
- Off-by-one in base64 decoding producing silently truncated output
- Panic in JSON unmarshalling due to nil pointer dereference on deeply nested structures
- Stack exhaustion via recursive YAML parsing without depth limits
- Use-after-free in CGo bindings exposed only under specific allocation patterns

The return on investment for a well-configured fuzzing pipeline is exceptional: OSS-Fuzz reports finding over 10,000 bugs per year across the projects it covers, many of them CVE-qualifying security vulnerabilities.

## Go Native Fuzzing

### Writing Your First Fuzz Target

Native fuzzing targets look like test functions with a specific signature:

```go
// pkg/parser/parser.go
package parser

import (
    "fmt"
    "strings"
)

// ParseConfig parses a simple key=value configuration format.
// This is the function we want to fuzz.
func ParseConfig(input []byte) (map[string]string, error) {
    result := make(map[string]string)
    lines := strings.Split(string(input), "\n")
    for i, line := range lines {
        line = strings.TrimSpace(line)
        if line == "" || strings.HasPrefix(line, "#") {
            continue
        }
        parts := strings.SplitN(line, "=", 2)
        if len(parts) != 2 {
            return nil, fmt.Errorf("line %d: invalid format %q", i+1, line)
        }
        key := strings.TrimSpace(parts[0])
        value := strings.TrimSpace(parts[1])
        if key == "" {
            return nil, fmt.Errorf("line %d: empty key", i+1)
        }
        result[key] = value
    }
    return result, nil
}
```

```go
// pkg/parser/fuzz_test.go
package parser

import (
    "testing"
    "unicode/utf8"
)

// FuzzParseConfig is the fuzz target for ParseConfig.
// It must start with "Fuzz" and accept *testing.F.
func FuzzParseConfig(f *testing.F) {
    // Seed corpus: representative valid inputs that guide the fuzzer
    // toward interesting code paths
    f.Add([]byte("key=value"))
    f.Add([]byte("# comment\nkey=value\nkey2=value2"))
    f.Add([]byte("key=value with spaces"))
    f.Add([]byte("KEY=value\nkey=VALUE"))
    f.Add([]byte(""))
    f.Add([]byte("key="))           // empty value
    f.Add([]byte("=value"))         // empty key — should error
    f.Add([]byte("key=val=ue"))     // value containing equals sign
    f.Add([]byte("\xff\xfe key=v")) // invalid UTF-8 prefix

    f.Fuzz(func(t *testing.T, data []byte) {
        // Property 1: ParseConfig must not panic on any input
        result, err := ParseConfig(data)

        if err != nil {
            // An error is acceptable; verify it's well-formed
            if err.Error() == "" {
                t.Error("error must not be empty string")
            }
            return
        }

        // Property 2: All returned keys must be valid UTF-8
        for k, v := range result {
            if !utf8.ValidString(k) {
                t.Errorf("key %q is not valid UTF-8", k)
            }
            if !utf8.ValidString(v) {
                t.Errorf("value %q is not valid UTF-8", v)
            }
        }

        // Property 3: Round-trip consistency
        // If we can parse it, re-serializing and re-parsing
        // should yield the same result
        reserialized := make([]byte, 0, len(data))
        for k, v := range result {
            reserialized = append(reserialized,
                []byte(k+"="+v+"\n")...)
        }
        result2, err2 := ParseConfig(reserialized)
        if err2 != nil {
            t.Errorf("re-parse of valid output failed: %v", err2)
            return
        }
        if len(result) != len(result2) {
            t.Errorf("round-trip: got %d keys, want %d", len(result2), len(result))
        }
    })
}
```

### Running the Fuzzer

```bash
# Run for 60 seconds against FuzzParseConfig
go test -fuzz=FuzzParseConfig -fuzztime=60s ./pkg/parser/

# Run with 4 parallel workers
go test -fuzz=FuzzParseConfig -fuzztime=5m -parallel=4 ./pkg/parser/

# Run only seed corpus (regression test mode — use in CI)
go test -run=FuzzParseConfig ./pkg/parser/

# Run all fuzz functions in seed-corpus-only mode
go test -run='^Fuzz' ./...
```

When the fuzzer finds a failure, it writes the input to a testdata directory:

```
--- FAIL: FuzzParseConfig (0.12s)
    --- FAIL: FuzzParseConfig/seed#7 (0.00s)
        fuzz_test.go:61: re-parse of valid output failed: line 1: empty key

Failing input written to testdata/fuzz/FuzzParseConfig/a1b2c3d4
To re-run: go test -run=FuzzParseConfig/a1b2c3d4 ./pkg/parser/
```

### Corpus Management

The corpus is the set of inputs that guided the fuzzer to new coverage. Managing it properly ensures both that findings are reproducible and that future fuzzing sessions start from interesting positions.

```
# Corpus directory structure
testdata/
  fuzz/
    FuzzParseConfig/
      # Seed corpus (committed to git)
      seed_001           # hand-crafted by developer
      seed_002
      # Generated corpus (gitignored or stored in corpus cache)
      a1b2c3d4           # fuzzer-generated — commit if it represents a fixed bug
      e5f6a7b8
```

```bash
# Merge external corpus into the seed corpus
go test -fuzz=FuzzParseConfig \
  -fuzztime=0s \
  -test.fuzzcachedir=/tmp/corpus-merge \
  ./pkg/parser/

# Minimize a crash-reproducing input to its smallest form
go test -fuzz=FuzzParseConfig \
  -fuzzminimize=30s \
  -run=FuzzParseConfig/a1b2c3d4 \
  ./pkg/parser/
```

### Advanced Fuzz Target Patterns

```go
// pkg/http/handler_fuzz_test.go
package http

import (
    "bytes"
    "net/http"
    "net/http/httptest"
    "testing"
)

// FuzzHTTPHandler tests an HTTP handler for panics and
// invariant violations when given arbitrary request bodies.
func FuzzHTTPHandler(f *testing.F) {
    f.Add(
        []byte(`{"action":"read","id":1}`),
        "application/json",
    )
    f.Add(
        []byte(`<?xml version="1.0"?><request><action>read</action></request>`),
        "application/xml",
    )
    f.Add([]byte(""), "application/json")

    handler := NewAPIHandler()

    f.Fuzz(func(t *testing.T, body []byte, contentType string) {
        req := httptest.NewRequest(http.MethodPost, "/api/v1/action",
            bytes.NewReader(body))
        req.Header.Set("Content-Type", contentType)
        req.Header.Set("Authorization", "Bearer test-token-for-fuzzing")

        rr := httptest.NewRecorder()

        // Handler must not panic
        handler.ServeHTTP(rr, req)

        // Handler must return a valid HTTP status code
        code := rr.Code
        if code < 100 || code > 599 {
            t.Errorf("invalid HTTP status code %d", code)
        }

        // 5xx responses on input we control are bugs
        if code >= 500 {
            t.Errorf("handler returned 5xx (%d) for controlled input: %s",
                code, rr.Body.String())
        }
    })
}
```

```go
// pkg/crypto/decoder_fuzz_test.go
package crypto

import (
    "bytes"
    "testing"
)

// FuzzDecodeAndEncrypt tests that the decode+encrypt pipeline
// never panics and maintains the invariant that encrypted
// output is never shorter than a minimum ciphertext size.
func FuzzDecodeAndEncrypt(f *testing.F) {
    key := bytes.Repeat([]byte{0x42}, 32) // fixed test key
    f.Add([]byte("hello world"), key)
    f.Add([]byte{}, key)
    f.Add(make([]byte, 65536), key) // large input

    f.Fuzz(func(t *testing.T, plaintext, keyMaterial []byte) {
        // Use a fixed key to avoid key-derivation variations
        // that obscure the actual target behavior
        fixedKey := make([]byte, 32)
        copy(fixedKey, keyMaterial)

        ciphertext, err := EncryptAESGCM(plaintext, fixedKey)
        if err != nil {
            return // acceptable failure
        }

        // AES-GCM ciphertext = nonce (12) + ciphertext + tag (16)
        const minCiphertextLen = 12 + 16
        if len(ciphertext) < minCiphertextLen {
            t.Errorf("ciphertext too short: got %d, want >= %d",
                len(ciphertext), minCiphertextLen)
        }

        // Decryption of the just-encrypted data must succeed
        decrypted, err := DecryptAESGCM(ciphertext, fixedKey)
        if err != nil {
            t.Errorf("decrypt of freshly encrypted data failed: %v", err)
            return
        }

        // Decrypted plaintext must match original
        if !bytes.Equal(decrypted, plaintext) {
            t.Errorf("round-trip mismatch: got %x, want %x",
                decrypted, plaintext)
        }
    })
}
```

## go-fuzz for Legacy and Advanced Scenarios

While native fuzzing covers most use cases in Go 1.18+, `dvyukov/go-fuzz` remains relevant for:

- Projects that must support Go versions before 1.18
- Integration with Syzkaller for kernel interface fuzzing
- Multi-package fuzzing with shared state

### go-fuzz Setup and Workflow

```bash
# Install go-fuzz
go install github.com/dvyukov/go-fuzz/go-fuzz@latest
go install github.com/dvyukov/go-fuzz/go-fuzz-build@latest

# Build the fuzz binary
go-fuzz-build -o fuzz.zip ./pkg/parser/

# Create corpus directory
mkdir -p corpus/FuzzParseConfig
echo "key=value" > corpus/FuzzParseConfig/seed1
echo "# comment" > corpus/FuzzParseConfig/seed2

# Run fuzzer
go-fuzz -bin=fuzz.zip -workdir=fuzzwork -procs=8

# Monitor coverage (outputs to fuzzwork/coverprofile)
go-fuzz -bin=fuzz.zip -workdir=fuzzwork -procs=8 -coverprofile=fuzz.cover
```

```go
// pkg/parser/gofuzz_test.go
// +build gofuzz

package parser

// Fuzz is the entry point for go-fuzz.
// The build tag ensures it only compiles with go-fuzz-build.
func Fuzz(data []byte) int {
    result, err := ParseConfig(data)
    if err != nil {
        return 0 // uninteresting — expected error
    }
    if len(result) == 0 {
        return 0
    }
    // Return 1 to signal that this input is "interesting"
    // and should be added to the corpus
    return 1
}
```

## OSS-Fuzz Integration

### What OSS-Fuzz Provides

OSS-Fuzz is Google's continuous fuzzing infrastructure for open-source projects. It provides:

- Free compute running your fuzz targets 24/7 across thousands of cores
- Automatic crash deduplication, triage, and minimization
- Coverage reports updated daily
- Automatic issue filing when new bugs are found
- Notification when bugs are fixed

### Project Onboarding

OSS-Fuzz requires three files in a `oss-fuzz` subdirectory or by submitting a PR to the `google/oss-fuzz` repository.

```dockerfile
# oss-fuzz/Dockerfile
FROM gcr.io/oss-fuzz-base/base-builder-go:latest

# Install dependencies your project needs at build time
RUN apt-get update && apt-get install -y \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Copy your project source
WORKDIR $GOPATH/src/github.com/example/myproject
COPY . .

# Copy build scripts into the container
COPY oss-fuzz/build.sh $SRC/build.sh
```

```bash
#!/bin/bash
# oss-fuzz/build.sh
set -euo pipefail

# Navigate to project root
cd "$GOPATH/src/github.com/example/myproject"

# Build each fuzz target as a separate binary.
# OSS-Fuzz expects compiled binaries in $OUT.

go-fuzz-build \
  -func FuzzParseConfig \
  -o "$OUT/fuzz_parse_config" \
  ./pkg/parser/

go-fuzz-build \
  -func FuzzHTTPHandler \
  -o "$OUT/fuzz_http_handler" \
  ./pkg/http/

go-fuzz-build \
  -func FuzzDecodeAndEncrypt \
  -o "$OUT/fuzz_decode_and_encrypt" \
  ./pkg/crypto/

# Copy seed corpora
zip -j "$OUT/fuzz_parse_config_seed_corpus.zip" \
  ./pkg/parser/testdata/fuzz/FuzzParseConfig/*

zip -j "$OUT/fuzz_http_handler_seed_corpus.zip" \
  ./pkg/http/testdata/fuzz/FuzzHTTPHandler/*

zip -j "$OUT/fuzz_decode_and_encrypt_seed_corpus.zip" \
  ./pkg/crypto/testdata/fuzz/FuzzDecodeAndEncrypt/*
```

```yaml
# oss-fuzz/project.yaml
homepage: "https://github.com/example/myproject"
language: go
primary_contact: "security@example.com"
auto_ccs:
  - "ops@example.com"
fuzzing_engines:
  - libfuzzer
  - afl
  - honggfuzz
sanitizers:
  - address
  - memory
  - undefined
```

### Building and Testing Locally with OSS-Fuzz

```bash
# Clone the OSS-Fuzz repository
git clone https://github.com/google/oss-fuzz.git
cd oss-fuzz

# Build the project's Docker image
python3 infra/helper.py build_image myproject

# Compile fuzz targets inside the container
python3 infra/helper.py build_fuzzers myproject

# Run a specific fuzz target for 60 seconds
python3 infra/helper.py run_fuzzer myproject fuzz_parse_config \
  -max_total_time=60

# Reproduce a crash from a specific input
python3 infra/helper.py reproduce myproject fuzz_parse_config \
  path/to/crash-input

# Check coverage
python3 infra/helper.py coverage myproject \
  --fuzz-target fuzz_parse_config
```

### Using Native Go Fuzzing with OSS-Fuzz

Since go-fuzz and native fuzzing use different build systems, OSS-Fuzz now natively supports Go's `testing.F` via a wrapper:

```bash
#!/bin/bash
# oss-fuzz/build.sh — native go fuzzing variant
set -euo pipefail

cd "$GOPATH/src/github.com/example/myproject"

# Compile with native Go fuzzing support
# The -func flag selects the fuzz function name
compile_native_go_fuzzer \
  github.com/example/myproject/pkg/parser \
  FuzzParseConfig \
  fuzz_parse_config

compile_native_go_fuzzer \
  github.com/example/myproject/pkg/http \
  FuzzHTTPHandler \
  fuzz_http_handler

# Seed corpora are automatically picked up from testdata/fuzz/
```

## CI/CD Integration

### GitHub Actions Fuzzing Workflow

```yaml
# .github/workflows/fuzz.yaml
name: Fuzz Testing

on:
  push:
    branches: [main, release/*]
  pull_request:
    branches: [main]
  schedule:
    # Run extended fuzzing nightly
    - cron: '0 2 * * *'

jobs:
  fuzz-short:
    name: Fuzz (short — PR gate)
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'
        cache: true

    - name: Run fuzz targets (30s each)
      run: |
        set -euo pipefail
        FUZZ_TIME="30s"
        PACKAGES=$(go list ./... | grep -v vendor)

        for pkg in $PACKAGES; do
          # Find all Fuzz functions in this package
          FUZZ_FUNCS=$(grep -rE '^func (Fuzz[A-Z][A-Za-z0-9]*)' \
            $(go list -f '{{.Dir}}' "$pkg") \
            --include='*_test.go' 2>/dev/null | \
            grep -oP '(?<=func )(Fuzz\w+)' || true)

          for func in $FUZZ_FUNCS; do
            echo "Fuzzing $pkg:$func for $FUZZ_TIME"
            go test -fuzz="^${func}$" \
              -fuzztime="$FUZZ_TIME" \
              -timeout="$((60 + 30))s" \
              "$pkg" || {
                echo "FUZZ FAILURE: $pkg:$func"
                exit 1
              }
          done
        done

    - name: Run seed corpus regression
      run: go test -run='^Fuzz' ./...

  fuzz-extended:
    name: Fuzz (extended — nightly)
    runs-on: ubuntu-latest
    if: github.event_name == 'schedule'
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'

    - name: Restore fuzzing corpus cache
      uses: actions/cache@v4
      with:
        path: |
          ~/.cache/go/fuzz
        key: fuzz-corpus-${{ runner.os }}-${{ github.sha }}
        restore-keys: |
          fuzz-corpus-${{ runner.os }}-

    - name: Run extended fuzzing (10m each)
      run: |
        set -euo pipefail
        TARGETS=(
          "pkg/parser:FuzzParseConfig"
          "pkg/http:FuzzHTTPHandler"
          "pkg/crypto:FuzzDecodeAndEncrypt"
        )

        FAILURES=()
        for target in "${TARGETS[@]}"; do
          PKG="${target%%:*}"
          FUNC="${target##*:}"
          echo "=== Fuzzing ./$PKG:$FUNC for 10m ==="
          if ! go test -fuzz="^${FUNC}$" \
            -fuzztime="10m" \
            -parallel=4 \
            -timeout="700s" \
            "./$PKG"; then
            FAILURES+=("$target")
          fi
        done

        if [ ${#FAILURES[@]} -gt 0 ]; then
          echo "FAILED fuzz targets:"
          printf '  %s\n' "${FAILURES[@]}"
          exit 1
        fi

    - name: Save updated corpus cache
      uses: actions/cache/save@v4
      if: always()
      with:
        path: ~/.cache/go/fuzz
        key: fuzz-corpus-${{ runner.os }}-${{ github.sha }}

    - name: Upload crash artifacts
      uses: actions/upload-artifact@v4
      if: failure()
      with:
        name: fuzz-crashes
        path: |
          **/testdata/fuzz/**/
        retention-days: 90
```

### Makefile Integration

```makefile
# Makefile targets for fuzzing
FUZZ_TIME ?= 60s
FUZZ_PARALLEL ?= 4

.PHONY: fuzz fuzz-short fuzz-seed

## fuzz: Run all fuzz targets for FUZZ_TIME (default 60s)
fuzz:
	@echo "Running fuzz targets for $(FUZZ_TIME)..."
	@for target in \
		"./pkg/parser/:FuzzParseConfig" \
		"./pkg/http/:FuzzHTTPHandler" \
		"./pkg/crypto/:FuzzDecodeAndEncrypt"; do \
		pkg=$$(echo "$$target" | cut -d: -f1); \
		func=$$(echo "$$target" | cut -d: -f2); \
		echo "Fuzzing $$pkg:$$func"; \
		go test -fuzz="^$${func}$$" \
			-fuzztime="$(FUZZ_TIME)" \
			-parallel="$(FUZZ_PARALLEL)" \
			"$$pkg" || exit 1; \
	done

## fuzz-seed: Run only seed corpus (CI regression mode)
fuzz-seed:
	go test -run='^Fuzz' ./...

## fuzz-coverage: Generate coverage report for all fuzz targets
fuzz-coverage:
	go test -run='^Fuzz' -coverprofile=fuzz.cover ./...
	go tool cover -html=fuzz.cover -o fuzz-coverage.html
	@echo "Coverage report: fuzz-coverage.html"
```

## Coverage-Guided Fuzzing Strategies

### Understanding Coverage Feedback

Go's native fuzzer uses the same coverage instrumentation as `go test -cover`. The fuzzer maximizes the number of unique basic blocks reached, which guides it toward unexplored code paths.

To understand what the fuzzer is actually covering:

```bash
# Generate coverage profile while running the seed corpus
go test -run='^FuzzParseConfig$' \
  -coverprofile=seed-cover.out \
  ./pkg/parser/

# Run the fuzzer for an extended period, saving the corpus
go test -fuzz=FuzzParseConfig \
  -fuzztime=5m \
  -test.fuzzcachedir=./fuzz-corpus \
  ./pkg/parser/

# Now run the accumulated corpus against the code to see coverage
go test -run='^FuzzParseConfig$' \
  -test.fuzzcachedir=./fuzz-corpus \
  -coverprofile=fuzz-cover.out \
  ./pkg/parser/

# Compare coverage
go tool cover -func=seed-cover.out | tail -1
go tool cover -func=fuzz-cover.out | tail -1
```

### Structuring Fuzz Targets for Maximum Coverage

```go
// pkg/protocol/fuzz_test.go
package protocol

import (
    "encoding/binary"
    "testing"
)

// FuzzMessageDecode aims to maximize coverage of the
// message decoding state machine by using structured
// random inputs that respect the protocol framing.
func FuzzMessageDecode(f *testing.F) {
    // Valid messages of different types
    f.Add(makeMessage(t, MsgTypeRequest, []byte(`{"op":"read"}`)))
    f.Add(makeMessage(t, MsgTypeResponse, []byte(`{"status":200}`)))
    f.Add(makeMessage(t, MsgTypePing, []byte(nil)))

    // Edge cases
    f.Add([]byte{})                  // empty
    f.Add([]byte{0x00, 0x00})        // too short for header
    f.Add(make([]byte, 65537))       // oversized

    f.Fuzz(func(t *testing.T, data []byte) {
        // Invariant 1: never panic
        msg, err := DecodeMessage(data)
        if err != nil {
            return
        }

        // Invariant 2: decoded message must re-encode to
        // something that also decodes successfully
        reencoded, err := EncodeMessage(msg)
        if err != nil {
            t.Errorf("encode of decoded message failed: %v", err)
            return
        }

        msg2, err := DecodeMessage(reencoded)
        if err != nil {
            t.Errorf("decode of re-encoded message failed: %v", err)
            return
        }

        // Invariant 3: message type must be preserved
        if msg.Type != msg2.Type {
            t.Errorf("type mismatch: got %d, want %d", msg2.Type, msg.Type)
        }
    })
}

// makeMessage constructs a valid wire-format message for seed corpus creation.
// Note: helper functions used in fuzz tests should not call t.Fatal
// during corpus construction — use panic instead.
func makeMessage(_ interface{}, msgType uint8, payload []byte) []byte {
    header := make([]byte, 5)
    header[0] = msgType
    binary.BigEndian.PutUint32(header[1:5], uint32(len(payload)))
    return append(header, payload...)
}
```

### Detecting Semantic Bugs Beyond Panics

```go
// FuzzSortedInsert tests a sorted data structure for
// ordering invariants that pure panic-detection misses.
func FuzzSortedInsert(f *testing.F) {
    f.Add([]byte{1, 5, 3, 2, 4})
    f.Add([]byte{})
    f.Add([]byte{255, 0, 127})

    f.Fuzz(func(t *testing.T, data []byte) {
        tree := NewBST()
        for _, b := range data {
            tree.Insert(int(b))
        }

        // Invariant: in-order traversal must be sorted
        values := tree.InOrder()
        for i := 1; i < len(values); i++ {
            if values[i] < values[i-1] {
                t.Errorf("sort violation at index %d: %d < %d",
                    i, values[i], values[i-1])
            }
        }

        // Invariant: Contains must agree with the insertion set
        seen := make(map[int]bool)
        for _, b := range data {
            seen[int(b)] = true
        }
        for v := range seen {
            if !tree.Contains(v) {
                t.Errorf("tree missing value %d that was inserted", v)
            }
        }

        // Invariant: size must match unique values
        if tree.Size() != len(seen) {
            t.Errorf("size mismatch: got %d, want %d",
                tree.Size(), len(seen))
        }
    })
}
```

## Analyzing and Triaging Findings

### Reproducing and Minimizing Crashes

```bash
# Reproduce a specific crash
go test -run=FuzzParseConfig/crashers/a1b2c3d4 ./pkg/parser/

# Minimize the crashing input while preserving the failure
# (requires -fuzzminimize flag)
go test \
  -fuzz=FuzzParseConfig \
  -fuzztime=0s \
  -run=FuzzParseConfig/crashers/a1b2c3d4 \
  ./pkg/parser/

# Print the crashing input in human-readable form
go run golang.org/x/tools/cmd/fiximports@latest \
  ./pkg/parser/testdata/fuzz/FuzzParseConfig/a1b2c3d4
```

### Automated Triage Script

```bash
#!/bin/bash
# scripts/fuzz-triage.sh
# Runs all known crash inputs and categorizes failures

set -euo pipefail

CRASH_DIR="${1:-.}"
PACKAGE="${2:-./...}"
REPORT_FILE="fuzz-triage-report.txt"

echo "=== Fuzz Triage Report ===" > "$REPORT_FILE"
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

TOTAL=0
PANICS=0
INVARIANT_VIOLATIONS=0
FIXED=0

while IFS= read -r -d '' crash_file; do
    TOTAL=$((TOTAL + 1))
    FUNC=$(basename "$(dirname "$crash_file")")
    INPUT=$(basename "$crash_file")

    echo "Testing $FUNC/$INPUT..." >&2

    OUTPUT=$(go test -run="${FUNC}/${INPUT}" "$PACKAGE" 2>&1 || true)

    if echo "$OUTPUT" | grep -q "^panic:"; then
        PANICS=$((PANICS + 1))
        echo "PANIC: $FUNC/$INPUT" >> "$REPORT_FILE"
        echo "$OUTPUT" | grep "^panic:" | head -1 >> "$REPORT_FILE"
    elif echo "$OUTPUT" | grep -q "FAIL"; then
        INVARIANT_VIOLATIONS=$((INVARIANT_VIOLATIONS + 1))
        echo "INVARIANT: $FUNC/$INPUT" >> "$REPORT_FILE"
        echo "$OUTPUT" | grep "Error\|Fail" | head -3 >> "$REPORT_FILE"
    else
        FIXED=$((FIXED + 1))
        echo "FIXED: $FUNC/$INPUT (no longer reproduces)" >> "$REPORT_FILE"
    fi
    echo "" >> "$REPORT_FILE"

done < <(find "$CRASH_DIR" -name "testdata" -prune -o \
  -path "*/testdata/fuzz/*/*" -type f -print0)

echo "=== Summary ===" >> "$REPORT_FILE"
echo "Total crash inputs tested: $TOTAL" >> "$REPORT_FILE"
echo "Active panics: $PANICS" >> "$REPORT_FILE"
echo "Active invariant violations: $INVARIANT_VIOLATIONS" >> "$REPORT_FILE"
echo "No longer reproducing (fixed): $FIXED" >> "$REPORT_FILE"

cat "$REPORT_FILE"
```

## Key Takeaways

Go's native fuzzing infrastructure provides a low-friction path to continuous security testing that every production Go team should adopt.

The core practices that yield the highest return:

1. Write fuzz targets alongside unit tests, not as afterthoughts. A fuzz target for every parser, decoder, and user-controlled data handler is a reasonable baseline.

2. Design fuzz targets around invariants, not just panic detection. Round-trip consistency, monotonic counters, ordering guarantees, and size bounds are all excellent invariants to assert.

3. Commit seed corpora to version control. The seed corpus is documentation of the interesting input space and ensures that the CI regression pass (seed-corpus-only mode) covers known edge cases.

4. Integrate OSS-Fuzz for any library or tool with external users. The compute is free and the continuous nature of OSS-Fuzz finds bugs that bounded local sessions miss.

5. Run fuzz targets in seed-only mode (`-run='^Fuzz'`) on every CI run as a regression gate. Extended fuzzing (`-fuzztime=10m+`) belongs in nightly or scheduled workflows.

6. Treat fuzzer-discovered crashes as security findings until proven otherwise. Many buffer handling bugs are exploitable under the right conditions.
