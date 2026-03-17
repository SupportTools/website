---
title: "Go Compile-Time Safety: iota, const iota, and Typed Constants"
date: 2029-05-06T00:00:00-05:00
draft: false
tags: ["Go", "iota", "Constants", "Type Safety", "Code Generation", "Compile-Time"]
categories:
- Go
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Go compile-time safety with iota patterns, typed string enums, stringer generation, exhaustive switch checking, compile-time assertions, and const expressions for production-grade code."
more_link: "yes"
url: "/go-compile-time-safety-iota-typed-constants/"
---

Go's type system is deliberately lean, but its constant and iota mechanisms provide powerful compile-time guarantees that many developers underutilize. Typed constants, iota patterns, `go generate` with stringer, and compile-time assertions can catch entire classes of bugs before the program ever runs. This guide covers the complete toolkit for leveraging Go's compile-time safety features in production code.

<!--more-->

# Go Compile-Time Safety: iota, const iota, and Typed Constants

## Why Typed Constants Matter

Untyped integer constants are contagious — they can accidentally be compared with, added to, or passed where completely different types are expected:

```go
// BAD: plain integers as enum values
const (
    StatusActive   = 1
    StatusInactive = 2
    StatusDeleted  = 3
)

// These all compile with NO error — all type checks pass
var userStatus int = StatusActive
var httpStatus int = 200
var diskSectors int = 512

// These are all "int" — compiler won't catch misuse
func setStatus(s int) { /* ... */ }
setStatus(httpStatus)    // Bug: passed HTTP code as user status
setStatus(diskSectors)   // Bug: passed sector count as user status
```

```go
// GOOD: typed constants
type UserStatus int

const (
    UserStatusActive   UserStatus = 1
    UserStatusInactive UserStatus = 2
    UserStatusDeleted  UserStatus = 3
)

func setStatus(s UserStatus) { /* ... */ }
setStatus(200)         // COMPILE ERROR: cannot use 200 (type int) as UserStatus
setStatus(httpStatus)  // COMPILE ERROR: cannot use httpStatus (type int) as UserStatus
```

## iota: Compile-Time Enumerated Constants

`iota` is a special predeclared identifier available in `const` blocks. It starts at 0 and increments by 1 for each constant in the block.

### Basic iota

```go
type Weekday int

const (
    Sunday    Weekday = iota   // 0
    Monday                     // 1
    Tuesday                    // 2
    Wednesday                  // 3
    Thursday                   // 4
    Friday                     // 5
    Saturday                   // 6
)

func (d Weekday) String() string {
    names := [...]string{
        "Sunday", "Monday", "Tuesday", "Wednesday",
        "Thursday", "Friday", "Saturday",
    }
    if d < Sunday || d > Saturday {
        return fmt.Sprintf("Weekday(%d)", int(d))
    }
    return names[d]
}
```

### Skipping Zero Value

Reserve zero as "unknown" or "unset":

```go
type Status int

const (
    _              Status = iota  // Skip 0 (use blank identifier)
    StatusPending                 // 1
    StatusRunning                 // 2
    StatusSucceeded               // 3
    StatusFailed                  // 4
)

// Now the zero value of Status is not a valid state
var s Status
if s == 0 {
    fmt.Println("uninitialized status") // Detect unset values
}
```

### iota Expressions

iota can be used in expressions:

```go
type ByteSize float64

const (
    _           = iota             // skip 0
    KB ByteSize = 1 << (10 * iota) // 1024
    MB                             // 1 << 20 = 1048576
    GB                             // 1 << 30
    TB                             // 1 << 40
    PB                             // 1 << 50
)

// Use in expressions
const (
    ReadPermission  = 1 << iota // 1
    WritePermission             // 2
    ExecPermission              // 4
)

type FileMode int

func (m FileMode) CanRead()    bool { return m&ReadPermission != 0 }
func (m FileMode) CanWrite()   bool { return m&WritePermission != 0 }
func (m FileMode) CanExecute() bool { return m&ExecPermission != 0 }
```

### Bitmask Flags

iota powers type-safe bitmask flags:

```go
type Feature uint32

const (
    FeatureNone      Feature = 0
    FeatureEncryption Feature = 1 << iota  // 2 (iota=1 here)
    FeatureCompression                      // 4
    FeatureDeduplication                    // 8
    FeatureReplication                      // 16
    FeatureSnapshotting                     // 32

    // Combinations
    FeatureBasic    = FeatureEncryption | FeatureCompression
    FeatureAdvanced = FeatureBasic | FeatureDeduplication | FeatureReplication
    FeatureAll      = ^Feature(0)   // All bits set
)

func (f Feature) Has(flag Feature) bool { return f&flag != 0 }
func (f Feature) Set(flag Feature) Feature { return f | flag }
func (f Feature) Clear(flag Feature) Feature { return f &^ flag }

func (f Feature) String() string {
    if f == FeatureNone {
        return "none"
    }
    var parts []string
    if f.Has(FeatureEncryption)    { parts = append(parts, "encryption") }
    if f.Has(FeatureCompression)   { parts = append(parts, "compression") }
    if f.Has(FeatureDeduplication) { parts = append(parts, "deduplication") }
    if f.Has(FeatureReplication)   { parts = append(parts, "replication") }
    if f.Has(FeatureSnapshotting)  { parts = append(parts, "snapshotting") }
    return strings.Join(parts, "|")
}
```

## Typed String Enums

Go's iota only works with integers. For string-backed enums:

```go
type Environment string

const (
    EnvDevelopment Environment = "development"
    EnvStaging     Environment = "staging"
    EnvProduction  Environment = "production"
)

// Validation at the edge
func ParseEnvironment(s string) (Environment, error) {
    switch Environment(s) {
    case EnvDevelopment, EnvStaging, EnvProduction:
        return Environment(s), nil
    default:
        return "", fmt.Errorf("unknown environment %q: must be one of: development, staging, production", s)
    }
}

// Marshaling
func (e Environment) MarshalText() ([]byte, error) {
    return []byte(e), nil
}

func (e *Environment) UnmarshalText(b []byte) error {
    v, err := ParseEnvironment(string(b))
    if err != nil {
        return err
    }
    *e = v
    return nil
}

func (e *Environment) UnmarshalJSON(b []byte) error {
    var s string
    if err := json.Unmarshal(b, &s); err != nil {
        return err
    }
    return e.UnmarshalText([]byte(s))
}
```

## Stringer Generation with go generate

The `stringer` tool from `golang.org/x/tools` generates `String()` methods automatically:

```go
// status.go
package main

//go:generate stringer -type=Status -linecomment

type Status int

const (
    StatusPending   Status = iota // pending
    StatusRunning                 // running
    StatusSucceeded               // succeeded
    StatusFailed                  // failed
    StatusCancelled               // cancelled
)
```

Running `go generate ./...` creates `status_string.go`:

```go
// Code generated by "stringer -type=Status -linecomment"; DO NOT EDIT.

package main

import "strconv"

func _() {
    // An "invalid array index" compiler error signifies that the constant values
    // have changed. Fire the constructor.
    var x [1]struct{}
    _ = x[StatusPending-0]
    _ = x[StatusRunning-1]
    _ = x[StatusSucceeded-2]
    _ = x[StatusFailed-3]
    _ = x[StatusCancelled-4]
}

const _Status_name = "pendingrunningsucceededfailedcancelled"

var _Status_index = [...]uint8{0, 7, 14, 23, 29, 38}

func (i Status) String() string {
    if i < 0 || i >= Status(len(_Status_index)-1) {
        return "Status(" + strconv.FormatInt(int64(i), 10) + ")"
    }
    return _Status_name[_Status_index[i]:_Status_index[i+1]]
}
```

Notice the compile-time assertion: if the constant values change, the generated code fails to compile, reminding you to regenerate.

### Additional stringer Options

```bash
# Trim the type name prefix from String() output
go generate stringer -type=Status -trimprefix=Status

# Generate for multiple types
go generate stringer -type=Status,Priority,Phase

# Custom output file
go generate stringer -type=Status -output=status_string.go
```

## Exhaustive Switch Checking

The `exhaustive` linter enforces that all enum values are handled in switch statements:

```bash
go install github.com/nishanths/exhaustive/cmd/exhaustive@latest
```

```go
// This will trigger exhaustive linter warnings:
func describeStatus(s Status) string {
    switch s {
    case StatusPending:
        return "waiting to run"
    case StatusRunning:
        return "currently running"
    // Missing: StatusSucceeded, StatusFailed, StatusCancelled
    }
    return "unknown"  // Won't save you from missing cases
}

// exhaustive lint output:
// missing cases in switch of type Status: StatusSucceeded, StatusFailed, StatusCancelled
```

### golangci-lint Integration

```yaml
# .golangci.yml
linters:
  enable:
    - exhaustive

linters-settings:
  exhaustive:
    default-signifies-exhaustive: false  # 'default:' does not count as exhaustive
    package-scope-only: false
```

### Manual Exhaustiveness via Compile-Time Assertion

Without a linter, you can enforce exhaustiveness using a compile-time map:

```go
// This map must have an entry for every Status value.
// If you add a new Status and forget to update this map,
// the compile-time assertion below will catch it.
var statusDescriptions = map[Status]string{
    StatusPending:   "waiting to run",
    StatusRunning:   "currently running",
    StatusSucceeded: "completed successfully",
    StatusFailed:    "completed with errors",
    StatusCancelled: "cancelled by user",
}

// Compile-time assertion: map length must equal number of Status values
// (assuming _maxStatus is the sentinel value)
const _maxStatus = StatusCancelled + 1

var _ [_maxStatus]struct{} = [len(statusDescriptions)]struct{}{}
// If len(statusDescriptions) != int(_maxStatus), this array literal fails to compile
```

## Compile-Time Assertions

Go lacks `static_assert`, but several patterns achieve equivalent effect.

### Array Size Assertion

```go
// Fail to compile if SomeStruct exceeds 64 bytes (cache line size)
var _ [64 - unsafe.Sizeof(SomeStruct{})]byte

// Fail to compile if the slice header size changes
const _ = [1]struct{}{}[unsafe.Sizeof(reflect.SliceHeader{}) - 24]
```

### Interface Implementation Assertion

The most common compile-time assertion in Go:

```go
// Ensure MyHandler implements http.Handler at compile time
var _ http.Handler = (*MyHandler)(nil)

// Ensure MyWriter implements io.Writer and io.Closer
var _ interface {
    io.Writer
    io.Closer
} = (*MyWriter)(nil)

// For interface with unexported methods
var _ json.Marshaler   = (*MyType)(nil)
var _ json.Unmarshaler = (*MyType)(nil)
var _ encoding.TextMarshaler   = (*MyType)(nil)
var _ encoding.TextUnmarshaler = (*MyType)(nil)
```

### Type Size Assertion (for Wire Protocol Compatibility)

```go
type WireHeader struct {
    Version   uint8
    Flags     uint8
    Length    uint16
    RequestID uint32
}

// Ensure the wire format size never changes
const _ = [1]struct{}{}[8 - unsafe.Sizeof(WireHeader{})]
// Fails to compile if WireHeader is not exactly 8 bytes
```

### Alignment Assertion

```go
// Ensure atomic fields are 64-bit aligned (required for 32-bit systems)
type AtomicCounter struct {
    _   [0]atomic.Int64  // Forces 8-byte alignment of the struct
    val int64
}

// Or use direct assertion
const _ = [1]struct{}{}[unsafe.Alignof(AtomicCounter{}.val) - 8]
```

## Const Expressions

Go evaluates constant expressions at compile time with arbitrary precision:

```go
const (
    // Arithmetic
    MaxInt8   = 1<<7 - 1   // 127
    MinInt8   = -1 << 7    // -128
    MaxUint16 = 1<<16 - 1  // 65535

    // Complex expressions
    SecondsPerDay  = 24 * 60 * 60    // 86400
    SecondsPerWeek = 7 * SecondsPerDay // 604800

    // String operations at compile time (limited)
    Prefix     = "api/v1/"
    HealthPath = Prefix + "health"  // "api/v1/health"
)

// Constant functions (using iota expressions)
const (
    // Networking
    DefaultHTTPPort  = 80
    DefaultHTTPSPort = 443
    DefaultGRPCPort  = 50051

    // Buffer sizes (powers of 2 for alignment)
    SmallBufSize  = 1 << 10  // 1 KB
    MediumBufSize = 1 << 16  // 64 KB
    LargeBufSize  = 1 << 20  // 1 MB
)
```

### Typed Constant Arithmetic

```go
type Duration int64

const (
    Nanosecond  Duration = 1
    Microsecond          = 1000 * Nanosecond
    Millisecond          = 1000 * Microsecond
    Second               = 1000 * Millisecond
    Minute               = 60 * Second
    Hour                 = 60 * Minute
)

// Type-safe time arithmetic
func sleep(d Duration) {
    time.Sleep(time.Duration(d))
}

sleep(5 * Second)           // GOOD: typed
sleep(300 * Millisecond)    // GOOD: typed
sleep(5 * time.Second)      // COMPILE ERROR: time.Duration != Duration
```

## enumer: Full-Featured Code Generation

The `enumer` tool generates more complete enum support than `stringer`:

```go
//go:generate enumer -type=Status -json -yaml -sql -transform=snake

type Status int

const (
    StatusPending Status = iota
    StatusRunning
    StatusSucceeded
    StatusFailed
)
```

Generated code includes:
- `String() string`
- `StatusString(s string) (Status, error)` (reverse lookup)
- `IsAStatus(s string) bool`
- `StatusValues() []Status`
- `MarshalJSON()` / `UnmarshalJSON()`
- `MarshalYAML()` / `UnmarshalYAML()`
- `Value()` / `Scan()` for database/sql

## Practical Patterns for Production Code

### Domain Event Types

```go
type EventType string

const (
    EventTypeOrderCreated   EventType = "order.created"
    EventTypeOrderPaid      EventType = "order.paid"
    EventTypeOrderShipped   EventType = "order.shipped"
    EventTypeOrderDelivered EventType = "order.delivered"
    EventTypeOrderCancelled EventType = "order.cancelled"
)

//go:generate enumer -type=EventType -linecomment -json

type Event struct {
    ID        string    `json:"id"`
    Type      EventType `json:"type"`
    Timestamp time.Time `json:"timestamp"`
    Payload   json.RawMessage `json:"payload"`
}

func ProcessEvent(e Event) error {
    switch e.Type {
    case EventTypeOrderCreated:
        return handleOrderCreated(e)
    case EventTypeOrderPaid:
        return handleOrderPaid(e)
    case EventTypeOrderShipped:
        return handleOrderShipped(e)
    case EventTypeOrderDelivered:
        return handleOrderDelivered(e)
    case EventTypeOrderCancelled:
        return handleOrderCancelled(e)
    default:
        return fmt.Errorf("unhandled event type: %s", e.Type)
    }
}
```

### Configuration Keys

```go
type ConfigKey string

const (
    ConfigKeyDatabaseURL    ConfigKey = "database.url"
    ConfigKeyRedisAddress   ConfigKey = "redis.address"
    ConfigKeyLogLevel       ConfigKey = "log.level"
    ConfigKeyEnv            ConfigKey = "app.environment"
    ConfigKeyMaxConnections ConfigKey = "database.max_connections"
)

type Config struct {
    data map[ConfigKey]string
}

func (c *Config) Get(key ConfigKey) string {
    return c.data[key]
}

func (c *Config) Set(key ConfigKey, value string) {
    c.data[key] = value
}

// Usage: config.Get(ConfigKeyDatabaseURL) — cannot pass arbitrary strings
```

### HTTP Route Names

```go
type RouteName string

const (
    RouteHealth    RouteName = "health"
    RouteMetrics   RouteName = "metrics"
    RouteOrderList RouteName = "order.list"
    RouteOrderGet  RouteName = "order.get"
    RouteOrderCreate RouteName = "order.create"
)

type Router struct {
    routes map[RouteName]*Route
}

func (r *Router) URL(name RouteName, params ...string) (string, error) {
    route, ok := r.routes[name]
    if !ok {
        return "", fmt.Errorf("unknown route: %s", name)
    }
    return route.Build(params...)
}
```

## Summary

Go's compile-time safety toolkit covers more ground than most developers realize:

- **Typed iota**: Prevents accidental mixing of integer constants from different domains.
- **Typed string constants**: Validated at the edge, safe in the core.
- **stringer / enumer**: Eliminates boilerplate and ensures String() stays in sync with const values.
- **exhaustive linter**: Turns missing switch cases from runtime surprises into compile-time errors.
- **Compile-time assertions**: `var _ Interface = (*Impl)(nil)` is the single most important pattern in every Go codebase.
- **Const expressions**: Evaluated with arbitrary precision at compile time — use them for protocol constants, buffer sizes, and derived configuration values.

These patterns are not academic. They actively prevent production incidents by eliminating entire categories of type confusion bugs at compile time, long before any test runs.
