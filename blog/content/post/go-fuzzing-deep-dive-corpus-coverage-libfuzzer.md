---
title: "Go Fuzzing Deep Dive: Corpus Management, Coverage-Guided, and libFuzzer Integration"
date: 2029-11-08T00:00:00-05:00
draft: false
tags: ["Go", "Fuzzing", "Testing", "Security", "libFuzzer", "OSS-Fuzz", "Coverage-Guided Testing"]
categories:
- Go
- Testing
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go native fuzzing: go test -fuzz internals, seed corpus management, structured fuzzing, writing fuzz targets for parsers and decoders, and OSS-Fuzz integration for open source projects."
more_link: "yes"
url: "/go-fuzzing-deep-dive-corpus-coverage-libfuzzer/"
---

Go 1.18 introduced native fuzzing support directly into the `go test` toolchain. Unlike traditional testing that validates known inputs, fuzzing automatically generates inputs designed to find crashes, panics, and incorrect behavior. This post covers the internals of Go's coverage-guided fuzzer, corpus management strategies, writing effective fuzz targets, and integrating with Google's OSS-Fuzz infrastructure.

<!--more-->

# Go Fuzzing Deep Dive: Corpus Management, Coverage-Guided, and libFuzzer Integration

## What Coverage-Guided Fuzzing Does

Traditional random testing generates arbitrary inputs. Coverage-guided fuzzing is fundamentally different: it tracks which code paths each input exercises and uses this information to evolve the input corpus toward covering more code paths.

The feedback loop works as follows:

1. Start with seed corpus (initial set of valid inputs)
2. Mutate inputs using built-in mutators (bit flips, byte insertions, splicing)
3. Execute the fuzz target with the mutated input
4. Check if the new input covers previously unseen code paths
5. If yes, add it to the corpus and continue mutating from it
6. If the target panics or violates invariants, record it as a finding

Go's fuzzer uses the same underlying infrastructure as libFuzzer but implements it natively without requiring CGo.

## The go test -fuzz Command

```bash
# Run fuzzer indefinitely (Ctrl+C to stop)
go test -fuzz=FuzzParseJSON ./...

# Run for a specific duration
go test -fuzz=FuzzParseJSON -fuzztime=60s ./...

# Run until N iterations
go test -fuzz=FuzzParseJSON -fuzztime=10000x ./...

# Run with parallelism (default: GOMAXPROCS)
go test -fuzz=FuzzParseJSON -parallel=4 ./...

# Run only the seed corpus (regression testing, no mutation)
go test -run=FuzzParseJSON ./...

# Run with race detector
go test -fuzz=FuzzParseJSON -race ./...

# Verbose output during fuzzing
go test -fuzz=FuzzParseJSON -v ./...

# List fuzz tests without running
go test -list Fuzz ./...
```

### Understanding fuzz Output

```
fuzz: elapsed: 0s, gathering baseline coverage: 0/3 completed
fuzz: elapsed: 0s, gathering baseline coverage: 3/3 completed, now fuzzing with 8 workers
fuzz: elapsed: 3s, execs: 325017 (108336/sec), new interesting: 11 (total: 24), crashes: 0
fuzz: elapsed: 6s, execs: 680795 (118590/sec), new interesting: 3 (total: 27), crashes: 0

# Each line:
# elapsed: total time running
# execs: total executions, (executions/second)
# new interesting: inputs that expanded coverage (total corpus size)
# crashes: inputs that caused panics or failures
```

## Writing Fuzz Targets

A fuzz target follows a strict signature:

```go
func FuzzFunctionName(f *testing.F, ...) {}
// The only parameter after *testing.F must be fuzz-able types:
// string, []byte, bool, byte, rune, int, int8, int16, int32, int64,
// uint, uint8, uint16, uint32, uint64, float32, float64
```

### Basic Fuzz Target for a Parser

```go
// parser/parser_test.go
package parser_test

import (
    "testing"

    "example.com/myapp/parser"
)

// FuzzParseConfig fuzzes the configuration file parser
func FuzzParseConfig(f *testing.F) {
    // Seed corpus: provide representative valid inputs
    f.Add([]byte(`{"key": "value", "num": 42}`))
    f.Add([]byte(`{"nested": {"a": 1, "b": [1, 2, 3]}}`))
    f.Add([]byte(`{}`))
    f.Add([]byte(`{"key": ""}`))
    f.Add([]byte(``)) // Empty input
    f.Add([]byte(`null`))

    f.Fuzz(func(t *testing.T, data []byte) {
        // The fuzz target must:
        // 1. Never panic (panics are bugs)
        // 2. Be deterministic for the same input
        // 3. Return quickly (no blocking operations)

        cfg, err := parser.ParseConfig(data)
        if err != nil {
            // Errors for invalid input are expected - not a bug
            return
        }

        // If parsing succeeded, verify invariants
        if cfg == nil {
            t.Fatal("ParseConfig returned nil without error")
        }

        // Round-trip property: marshal then parse should produce equal result
        marshaled, err := cfg.Marshal()
        if err != nil {
            t.Fatalf("Marshal failed on successfully parsed config: %v", err)
        }

        cfg2, err := parser.ParseConfig(marshaled)
        if err != nil {
            t.Fatalf("Failed to re-parse marshaled config: %v\nOriginal: %q\nMarshaled: %q",
                err, data, marshaled)
        }

        if !cfg.Equal(cfg2) {
            t.Fatalf("Round-trip produced different config\nOriginal: %v\nRound-trip: %v",
                cfg, cfg2)
        }
    })
}
```

### Structured Fuzzing with Custom Types

Go's fuzzer only accepts primitive types directly. For structured inputs, use custom corpus format:

```go
// protocol/decoder_test.go
package protocol_test

import (
    "encoding/binary"
    "testing"

    "example.com/myapp/protocol"
)

// FuzzDecodeMessage fuzzes the binary protocol decoder
func FuzzDecodeMessage(f *testing.F) {
    // Seed corpus - valid protocol frames
    // Frame format: [version:1][type:1][length:4][payload:n]
    frame1 := makeFrame(1, protocol.TypePing, []byte("hello"))
    frame2 := makeFrame(1, protocol.TypeData, []byte{0x01, 0x02, 0x03})
    frame3 := makeFrame(1, protocol.TypeClose, nil)

    f.Add(frame1)
    f.Add(frame2)
    f.Add(frame3)
    f.Add([]byte{})
    f.Add([]byte{0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF})

    f.Fuzz(func(t *testing.T, data []byte) {
        msg, err := protocol.DecodeMessage(data)
        if err != nil {
            return // Invalid input, expected
        }

        // Invariant 1: decoded message should re-encode without error
        encoded, err := msg.Encode()
        if err != nil {
            t.Fatalf("encoding decoded message failed: %v", err)
        }

        // Invariant 2: re-encoded message should decode to same result
        msg2, err := protocol.DecodeMessage(encoded)
        if err != nil {
            t.Fatalf("decoding re-encoded message failed: %v", err)
        }

        // Invariant 3: messages should be semantically equal
        if msg.Type != msg2.Type {
            t.Fatalf("type mismatch: %d != %d", msg.Type, msg2.Type)
        }

        if len(msg.Payload) != len(msg2.Payload) {
            t.Fatalf("payload length mismatch: %d != %d",
                len(msg.Payload), len(msg2.Payload))
        }
    })
}

func makeFrame(version, msgType byte, payload []byte) []byte {
    frame := make([]byte, 6+len(payload))
    frame[0] = version
    frame[1] = msgType
    binary.BigEndian.PutUint32(frame[2:6], uint32(len(payload)))
    copy(frame[6:], payload)
    return frame
}
```

### Multi-Input Fuzzing

When your function takes multiple parameters, use multiple fuzz inputs:

```go
// sql/query_test.go
package sql_test

import (
    "testing"

    "example.com/myapp/sql"
)

// FuzzBuildQuery fuzzes the safe query builder
func FuzzBuildQuery(f *testing.F) {
    // Seed with table name and filter pairs
    f.Add("users", "active=true", 100)
    f.Add("orders", "status='pending'", 50)
    f.Add("", "", 0)

    f.Fuzz(func(t *testing.T, tableName string, filter string, limit int) {
        // The query builder should never produce SQL injection
        query, args, err := sql.BuildSelectQuery(tableName, filter, limit)
        if err != nil {
            return // Validation rejected invalid input
        }

        // Invariant: query should not contain unescaped user input
        // All user data should be in args, not interpolated into query
        if containsUnsafeInput(query, tableName) {
            t.Fatalf("query contains unescaped table name: %q in %q",
                tableName, query)
        }

        _ = args
        _ = query
    })
}

func containsUnsafeInput(query, input string) bool {
    if len(input) == 0 {
        return false
    }
    // Check if raw input appears unquoted in query
    // This is simplified - real check would be more sophisticated
    return strings.Contains(query, input) &&
        !strings.Contains(query, `"`+input+`"`)
}
```

## Corpus Management

### Corpus Directory Structure

```
testdata/
└── fuzz/
    └── FuzzParseConfig/
        ├── seed1                    # Manually created seed
        ├── seed2
        └── corpus/                  # Auto-generated by fuzzer
            ├── 8a5e1c2b3d4f...     # SHA256 hash of input
            ├── 7f3a9b1c2d4e...
            └── ...
```

The fuzzer stores interesting inputs (those that increase coverage) in `testdata/fuzz/<FuzzTestName>/`. These are committed to version control as regression inputs.

```bash
# View the seed corpus
ls testdata/fuzz/FuzzParseConfig/

# Examine a corpus entry (they're plain text files)
cat testdata/fuzz/FuzzParseConfig/8a5e1c2b3d4f...

# The format is:
# go test fuzz v1
# []byte("some input data")
```

### Adding Corpus Entries Manually

```bash
# Create a new corpus directory
mkdir -p testdata/fuzz/FuzzParseConfig

# Add a corpus entry manually
cat > testdata/fuzz/FuzzParseConfig/edge-case-1 << 'EOF'
go test fuzz v1
[]byte("\x00\xff\x80\x7f")
EOF

# Add a string corpus entry
cat > testdata/fuzz/FuzzParseConfig/large-input << 'EOF'
go test fuzz v1
[]byte("a very long string that might trigger buffer handling issues in parsers that don't validate length properly")
EOF
```

### Minimizing a Crash

When the fuzzer finds a crash, it stores the minimized input in `testdata/fuzz/<FuzzName>/`:

```bash
# The fuzzer automatically minimizes crash inputs
# A crash is recorded as:
# testdata/fuzz/FuzzParseConfig/
#   crash-8a5e1c2b3d4f...    # Minimal input that causes the crash

# To reproduce a specific crash
go test -run=FuzzParseConfig/crash-8a5e1c2b3d4f testdata/fuzz/FuzzParseConfig/

# To run just the failing test
go test -run='FuzzParseConfig/crash-' ./...
```

### Corpus Merging

When running long fuzzing sessions or across multiple machines, merge corpora:

```bash
# Use govulncheck's corpus merging (or manual merging)
# Merge two corpus directories
for f in corpus2/*; do
    cp "$f" corpus1/$(sha256sum "$f" | cut -d' ' -f1) 2>/dev/null || true
done

# Use go-fuzz-corpus tool if available
go install github.com/dvyukov/go-fuzz/go-fuzz-corpus@latest
go-fuzz-corpus -d testdata/fuzz/FuzzParseConfig corpus2/
```

## Advanced Fuzz Target Patterns

### Fuzzing an HTTP Handler

```go
// handler/handler_test.go
package handler_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"

    "example.com/myapp/handler"
)

func FuzzCreateUserHandler(f *testing.F) {
    // Seed with valid JSON bodies
    f.Add([]byte(`{"name":"alice","email":"alice@example.com"}`))
    f.Add([]byte(`{"name":"bob","email":"bob@example.com","role":"admin"}`))
    f.Add([]byte(`{}`))
    f.Add([]byte(`null`))
    f.Add([]byte(`"string"`))
    f.Add([]byte(``))

    h := handler.NewUserHandler(newTestDB())

    f.Fuzz(func(t *testing.T, body []byte) {
        req := httptest.NewRequest(http.MethodPost, "/users", bytes.NewReader(body))
        req.Header.Set("Content-Type", "application/json")
        rec := httptest.NewRecorder()

        // Must not panic
        h.CreateUser(rec, req)

        resp := rec.Result()
        defer resp.Body.Close()

        // Invariant: HTTP status must be a valid status code
        if resp.StatusCode < 100 || resp.StatusCode > 599 {
            t.Fatalf("invalid HTTP status: %d", resp.StatusCode)
        }

        // Invariant: if status is 2xx, body must be valid JSON
        if resp.StatusCode >= 200 && resp.StatusCode < 300 {
            var result map[string]interface{}
            if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
                t.Fatalf("success response is not valid JSON: %v", err)
            }

            // Invariant: success response must contain an ID
            if _, ok := result["id"]; !ok {
                t.Fatal("success response missing 'id' field")
            }
        }
    })
}
```

### Differential Fuzzing

Differential fuzzing compares two implementations for equivalence:

```go
// compare two JSON libraries for behavioral equivalence
func FuzzJSONEquivalence(f *testing.F) {
    f.Add([]byte(`{"a":1,"b":"hello","c":[1,2,3]}`))
    f.Add([]byte(`null`))
    f.Add([]byte(`[]`))
    f.Add([]byte(`1.7976931348623157e+308`))

    f.Fuzz(func(t *testing.T, data []byte) {
        // Compare stdlib encoding/json with a third-party library
        var v1 interface{}
        err1 := json.Unmarshal(data, &v1)

        var v2 interface{}
        err2 := jsoniter.Unmarshal(data, &v2)

        // Invariant: both should agree on whether input is valid
        if (err1 == nil) != (err2 == nil) {
            t.Fatalf("disagreement on validity:\nstdlib: %v\njsoniter: %v\ninput: %q",
                err1, err2, data)
        }

        // Invariant: both should produce the same value for valid input
        if err1 == nil && !reflect.DeepEqual(v1, v2) {
            t.Fatalf("parsed values differ:\nstdlib: %#v\njsoniter: %#v\ninput: %q",
                v1, v2, data)
        }
    })
}
```

### Stateful Fuzzing with State Machine

```go
// FuzzOperations fuzzes a series of database operations
func FuzzOperations(f *testing.F) {
    // Seed: sequence of operation bytes
    // byte 0: operation type (0=insert, 1=update, 2=delete, 3=get)
    // bytes 1-4: key (uint32)
    // bytes 5-8: value (uint32, for insert/update)
    f.Add([]byte{0, 0, 0, 0, 1, 0, 0, 0, 42})  // Insert key=1, val=42
    f.Add([]byte{3, 0, 0, 0, 1})                 // Get key=1
    f.Add([]byte{1, 0, 0, 0, 1, 0, 0, 0, 99})   // Update key=1, val=99
    f.Add([]byte{2, 0, 0, 0, 1})                 // Delete key=1

    f.Fuzz(func(t *testing.T, ops []byte) {
        db := newTestDB()
        expected := make(map[uint32]uint32) // Reference implementation

        i := 0
        for i < len(ops) {
            if i >= len(ops) {
                break
            }
            op := ops[i] % 4
            i++

            switch op {
            case 0: // Insert
                if i+8 > len(ops) {
                    return
                }
                key := binary.BigEndian.Uint32(ops[i:])
                val := binary.BigEndian.Uint32(ops[i+4:])
                i += 8

                err := db.Insert(key, val)
                if err == nil {
                    expected[key] = val
                }

            case 1: // Update
                if i+8 > len(ops) {
                    return
                }
                key := binary.BigEndian.Uint32(ops[i:])
                val := binary.BigEndian.Uint32(ops[i+4:])
                i += 8

                err := db.Update(key, val)
                if _, exists := expected[key]; exists {
                    if err != nil {
                        t.Fatalf("Update of existing key %d failed: %v", key, err)
                    }
                    expected[key] = val
                }

            case 2: // Delete
                if i+4 > len(ops) {
                    return
                }
                key := binary.BigEndian.Uint32(ops[i:])
                i += 4

                db.Delete(key)
                delete(expected, key)

            case 3: // Get
                if i+4 > len(ops) {
                    return
                }
                key := binary.BigEndian.Uint32(ops[i:])
                i += 4

                val, err := db.Get(key)
                expectedVal, shouldExist := expected[key]

                if shouldExist {
                    if err != nil {
                        t.Fatalf("Get(%d) failed but key should exist: %v", key, err)
                    }
                    if val != expectedVal {
                        t.Fatalf("Get(%d) = %d, want %d", key, val, expectedVal)
                    }
                } else {
                    if err == nil {
                        t.Fatalf("Get(%d) succeeded but key should not exist", key)
                    }
                }
            }
        }
    })
}
```

## libFuzzer Integration

For projects requiring libFuzzer's advanced features (custom mutators, dictionary-based mutation), Go supports compilation with the libFuzzer sanitizer.

```bash
# Build with libFuzzer support
# Requires clang and libFuzzer
go build -buildmode=c-archive -gcflags=all=-d=libfuzzer ./...

# Or use the experimental -fuzzsanitizer flag
GOFLAGS="-fuzzsanitizer=address" go test -fuzz=FuzzParseJSON ./...
```

### Custom Mutators via libFuzzer Interface

```go
// custom_mutator.go
//go:build libfuzzer

package parser_test

/*
#include <stdint.h>
#include <stddef.h>

// LLVMFuzzerCustomMutator - called by libFuzzer for custom mutation
size_t LLVMFuzzerCustomMutator(uint8_t *data, size_t size, size_t maxSize, unsigned int seed);
*/
import "C"
import (
    "encoding/binary"
    "math/rand"
    "unsafe"
)

//export LLVMFuzzerCustomMutator
func LLVMFuzzerCustomMutator(data *C.uint8_t, size, maxSize C.size_t, seed C.uint) C.size_t {
    buf := (*[1 << 30]byte)(unsafe.Pointer(data))[:size:maxSize]

    rng := rand.New(rand.NewSource(int64(seed)))

    switch rng.Intn(5) {
    case 0:
        // Bit flip
        if size > 0 {
            idx := rng.Intn(int(size))
            buf[idx] ^= 1 << uint(rng.Intn(8))
        }

    case 1:
        // Insert valid JSON token
        tokens := [][]byte{
            []byte(`"key"`),
            []byte(`null`),
            []byte(`true`),
            []byte(`false`),
            []byte(`42`),
            []byte(`"value"`),
        }
        token := tokens[rng.Intn(len(tokens))]
        if C.size_t(len(buf)+len(token)) <= maxSize {
            pos := rng.Intn(int(size) + 1)
            buf = append(buf[:pos], append(token, buf[pos:]...)...)
        }

    case 2:
        // Delete a byte
        if size > 1 {
            idx := rng.Intn(int(size))
            buf = append(buf[:idx], buf[idx+1:]...)
        }

    case 3:
        // Replace with interesting values
        if size > 4 {
            idx := rng.Intn(int(size) - 4)
            interesting := []uint32{0, 1, 0xFFFFFFFF, 0x80000000, 0x7FFFFFFF}
            v := interesting[rng.Intn(len(interesting))]
            binary.LittleEndian.PutUint32(buf[idx:], v)
        }

    case 4:
        // Splice with another interesting byte sequence
        if size > 2 {
            mid := rng.Intn(int(size))
            copy(buf, buf[mid:])
            size = size - C.size_t(mid)
        }
    }

    return C.size_t(len(buf))
}
```

### LibFuzzer Dictionary

Create a dictionary file for domain-specific mutations:

```
# json.dict - libFuzzer dictionary for JSON fuzzing
"{"
"}"
"["
"]"
":"
","
"null"
"true"
"false"
"\""
"\\"
"\\n"
"\\t"
"\\r"
"\\u0000"
"\\uFFFF"
"\u0000"
```

```bash
# Run libFuzzer with dictionary
./fuzz_binary -dict=json.dict testdata/fuzz/FuzzParseJSON/
```

## OSS-Fuzz Integration

OSS-Fuzz is Google's continuous fuzzing service for open source projects. Integrating your project provides continuous fuzzing powered by Google's infrastructure.

### Project Structure for OSS-Fuzz

```
oss-fuzz/
└── projects/
    └── myproject/
        ├── Dockerfile
        ├── build.sh
        └── project.yaml
```

### project.yaml

```yaml
# oss-fuzz/projects/myproject/project.yaml
homepage: "https://github.com/myorg/myproject"
language: go
primary_contact: "security@myorg.com"
auto_ccs:
  - "dev@myorg.com"
```

### Dockerfile

```dockerfile
# oss-fuzz/projects/myproject/Dockerfile
FROM gcr.io/oss-fuzz-base/base-builder-go

MAINTAINER security@myorg.com

# Clone the repo
RUN git clone --depth 1 https://github.com/myorg/myproject $GOPATH/src/github.com/myorg/myproject

# Copy build script
COPY build.sh $SRC/
```

### build.sh

```bash
#!/bin/bash -eu
# oss-fuzz/projects/myproject/build.sh

cd $GOPATH/src/github.com/myorg/myproject

# Build all fuzz targets
go install github.com/AdaLogics/go-fuzz-headers@latest

compile_go_fuzzer github.com/myorg/myproject/parser FuzzParseConfig fuzz_parse_config
compile_go_fuzzer github.com/myorg/myproject/protocol FuzzDecodeMessage fuzz_decode_message
compile_go_fuzzer github.com/myorg/myproject/handler FuzzCreateUserHandler fuzz_create_user

# Copy seed corpora
cp -r $GOPATH/src/github.com/myorg/myproject/testdata/fuzz/FuzzParseConfig $OUT/fuzz_parse_config_seed_corpus
zip -j $OUT/fuzz_parse_config_seed_corpus.zip $OUT/fuzz_parse_config_seed_corpus/*
```

### Native Go Fuzz with OSS-Fuzz (Go 1.18+)

```bash
# OSS-Fuzz now supports native Go fuzzing targets directly
# build.sh for native fuzzing
compile_native_go_fuzzer github.com/myorg/myproject/parser FuzzParseConfig fuzz_parse_config
```

### Testing OSS-Fuzz Integration Locally

```bash
# Install OSS-Fuzz locally for testing
git clone https://github.com/google/oss-fuzz.git
cd oss-fuzz

# Build the project
python3 infra/helper.py build_image myproject
python3 infra/helper.py build_fuzzers myproject

# Run a specific fuzzer
python3 infra/helper.py run_fuzzer myproject fuzz_parse_config -- -max_total_time=60

# Check for sanitizer errors
python3 infra/helper.py check_build myproject

# Run the fuzzer with a specific corpus
python3 infra/helper.py run_fuzzer myproject fuzz_parse_config \
    --corpus-dir=testdata/fuzz/FuzzParseConfig/
```

## Common Fuzzing Bugs Found

### Integer Overflow in Length Fields

```go
// Vulnerable: unchecked length field
func DecodeVulnerable(data []byte) ([]byte, error) {
    if len(data) < 4 {
        return nil, ErrTooShort
    }
    // BUG: length could be 0xFFFFFFFF, causing make() to allocate 4GB
    length := binary.BigEndian.Uint32(data[:4])
    result := make([]byte, length)  // panic: runtime: out of memory
    copy(result, data[4:])
    return result, nil
}

// Fixed: validate length before allocation
func DecodeFixed(data []byte) ([]byte, error) {
    if len(data) < 4 {
        return nil, ErrTooShort
    }
    length := binary.BigEndian.Uint32(data[:4])

    // Validate length is reasonable and within available data
    const maxLength = 1 << 20  // 1MB
    if length > maxLength {
        return nil, fmt.Errorf("message too large: %d > %d", length, maxLength)
    }
    if int(length) > len(data)-4 {
        return nil, fmt.Errorf("truncated message: need %d bytes, have %d",
            length, len(data)-4)
    }

    result := make([]byte, length)
    copy(result, data[4:4+length])
    return result, nil
}
```

### Nil Pointer After Early Return

```go
// Vulnerable: caller assumes non-nil on success
func ParseResponse(data []byte) (*Response, error) {
    var resp Response
    if err := json.Unmarshal(data, &resp); err != nil {
        return nil, err
    }
    // BUG: if JSON is "null", Unmarshal succeeds but resp.Items is nil
    // Caller calling len(result.Items) will work but semantic is wrong

    return &resp, nil
}

// Fixed: validate required fields after parsing
func ParseResponseFixed(data []byte) (*Response, error) {
    var resp Response
    if err := json.Unmarshal(data, &resp); err != nil {
        return nil, err
    }

    // Validate required fields
    if resp.Version == 0 {
        return nil, fmt.Errorf("missing required field: version")
    }
    if resp.Items == nil {
        resp.Items = []Item{}  // Normalize nil to empty
    }

    return &resp, nil
}
```

## CI Integration for Continuous Fuzzing

```yaml
# .github/workflows/fuzz.yml
name: Fuzzing

on:
  push:
    branches: [main]
  pull_request:
  schedule:
  - cron: '0 3 * * *'  # Daily at 3 AM

jobs:
  fuzz:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        fuzz-target:
        - FuzzParseConfig
        - FuzzDecodeMessage
        - FuzzCreateUserHandler
    steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-go@v5
      with:
        go-version: '1.22'

    - name: Restore fuzzing corpus cache
      uses: actions/cache@v4
      with:
        path: |
          testdata/fuzz/
        key: fuzz-corpus-${{ matrix.fuzz-target }}-${{ github.sha }}
        restore-keys: |
          fuzz-corpus-${{ matrix.fuzz-target }}-

    - name: Run fuzzer
      run: |
        # Shorter run on PRs, longer on schedule
        if [ "${{ github.event_name }}" = "schedule" ]; then
            FUZZ_TIME="600s"
        else
            FUZZ_TIME="60s"
        fi

        go test -fuzz=${{ matrix.fuzz-target }} \
            -fuzztime=$FUZZ_TIME \
            ./...

    - name: Check for crashes
      run: |
        # If fuzzer found crashes, they're in testdata/fuzz/
        CRASHES=$(find testdata/fuzz -name "crash-*" 2>/dev/null | wc -l)
        if [ "$CRASHES" -gt 0 ]; then
            echo "Fuzzer found $CRASHES crashes!"
            find testdata/fuzz -name "crash-*" -exec echo "Crash: {}" \;
            exit 1
        fi

    - name: Save corpus on crash
      if: failure()
      uses: actions/upload-artifact@v4
      with:
        name: fuzz-corpus-${{ matrix.fuzz-target }}
        path: testdata/fuzz/

    - name: Save expanded corpus
      uses: actions/cache/save@v4
      if: always()
      with:
        path: testdata/fuzz/
        key: fuzz-corpus-${{ matrix.fuzz-target }}-${{ github.sha }}
```

## Performance Considerations

```go
// Fuzz targets should be efficient - they run millions of times

// BAD: Opening file in each iteration
func FuzzBad(f *testing.F) {
    f.Add([]byte("input"))
    f.Fuzz(func(t *testing.T, data []byte) {
        // Don't do this - expensive setup in fuzz body
        db, _ := sql.Open("sqlite3", "test.db")
        defer db.Close()
        db.Exec("SELECT 1")
        processWithDB(db, data)
    })
}

// GOOD: One-time setup outside fuzz body
func FuzzGood(f *testing.F) {
    // One-time expensive setup
    db := newTestDB()
    f.Cleanup(func() { db.Close() })

    f.Add([]byte("input"))
    f.Fuzz(func(t *testing.T, data []byte) {
        // Only the tested logic runs each iteration
        processWithDB(db, data)
    })
}

// GOOD: Use sync.Pool for expensive objects
var bufPool = sync.Pool{
    New: func() interface{} {
        return make([]byte, 0, 4096)
    },
}

func FuzzWithPool(f *testing.F) {
    f.Add([]byte("input"))
    f.Fuzz(func(t *testing.T, data []byte) {
        buf := bufPool.Get().([]byte)
        defer func() {
            buf = buf[:0]
            bufPool.Put(buf)
        }()

        processWithBuffer(buf, data)
    })
}
```

## Summary

Go's native fuzzing support provides a powerful, low-friction path to finding security-relevant bugs. The key practices are:

- **Meaningful seed corpus**: Provide representative valid inputs covering different code paths; the fuzzer explores variations from these seeds
- **Strong invariants**: The fuzz target should verify properties that should always hold (round-trip parsing, no nil returns on success, valid HTTP status codes)
- **Efficient targets**: Minimize setup in the fuzz body; use one-time initialization outside `f.Fuzz()`
- **Differential fuzzing**: Comparing two implementations is highly effective at finding semantic bugs
- **Commit the corpus**: `testdata/fuzz/` entries serve as regression tests - check them into version control
- **OSS-Fuzz integration**: For open source projects, OSS-Fuzz provides continuous fuzzing at scale with automatic bug filing

The most impactful targets are parsers, decoders, and any code that processes untrusted external data. Start with these and expand coverage as your fuzzing program matures.
