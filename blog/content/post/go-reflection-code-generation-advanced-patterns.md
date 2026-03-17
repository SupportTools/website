---
title: "Go Reflection and Code Generation: Advanced Patterns"
date: 2029-03-31T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Reflection", "Code Generation", "protobuf", "go generate"]
categories: ["Go", "Software Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go's reflect package, unsafe.Pointer usage, go generate workflows, protobuf and JSON code generation, and template-based generators for production Go development."
more_link: "yes"
url: "/go-reflection-code-generation-advanced-patterns/"
---

Go's static type system catches entire classes of bugs at compile time, but there are legitimate scenarios where runtime type introspection or compile-time code generation are the right tools. The reflect package powers most of Go's standard library serialization, dependency injection frameworks, and ORM implementations. Code generation through `go generate` eliminates boilerplate while maintaining type safety. This guide covers both topics with production-oriented examples.

<!--more-->

# Go Reflection and Code Generation: Advanced Patterns

## Section 1: The reflect Package Fundamentals

The `reflect` package exposes Go's type system at runtime through two central types: `reflect.Type` and `reflect.Value`.

- `reflect.Type` describes a type's structure - its kind, fields, methods, and metadata
- `reflect.Value` holds an actual value at runtime and allows reading and (sometimes) writing it

```go
package main

import (
    "fmt"
    "reflect"
)

type Server struct {
    Host    string `json:"host" validate:"required"`
    Port    int    `json:"port" validate:"min=1,max=65535"`
    TLSEnabled bool `json:"tls_enabled"`
}

func inspectType(v interface{}) {
    t := reflect.TypeOf(v)
    val := reflect.ValueOf(v)

    // Dereference pointer
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
        val = val.Elem()
    }

    fmt.Printf("Type: %s, Kind: %s\n", t.Name(), t.Kind())
    fmt.Printf("Number of fields: %d\n", t.NumField())

    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        fieldVal := val.Field(i)

        fmt.Printf("  Field: %-15s Type: %-10s Value: %v\n",
            field.Name,
            field.Type.Kind(),
            fieldVal.Interface(),
        )

        // Read struct tags
        if jsonTag := field.Tag.Get("json"); jsonTag != "" {
            fmt.Printf("    json tag: %s\n", jsonTag)
        }
        if validateTag := field.Tag.Get("validate"); validateTag != "" {
            fmt.Printf("    validate tag: %s\n", validateTag)
        }
    }
}

func main() {
    s := &Server{
        Host:       "localhost",
        Port:       8080,
        TLSEnabled: true,
    }
    inspectType(s)
}
```

### Kind vs Type

A common source of confusion: `Kind` is the underlying Go primitive kind, while `Type` is the declared type name.

```go
type Celsius float64
type Fahrenheit float64

var c Celsius = 100.0

t := reflect.TypeOf(c)
fmt.Println(t.Name())  // "Celsius"
fmt.Println(t.Kind())  // "float64"

// Kind tells you what operations are valid
// Type tells you the declared type identity
```

## Section 2: Reading and Writing Values with reflect

### Safe Value Inspection

```go
package reflection

import (
    "fmt"
    "reflect"
    "strings"
)

// FlattenStruct converts a struct to a map[string]interface{}
// recursively, using json tags as keys when present.
func FlattenStruct(v interface{}) map[string]interface{} {
    result := make(map[string]interface{})
    flattenValue(reflect.ValueOf(v), "", result)
    return result
}

func flattenValue(v reflect.Value, prefix string, result map[string]interface{}) {
    // Dereference pointer or interface
    for v.Kind() == reflect.Ptr || v.Kind() == reflect.Interface {
        if v.IsNil() {
            return
        }
        v = v.Elem()
    }

    t := v.Type()

    switch v.Kind() {
    case reflect.Struct:
        for i := 0; i < t.NumField(); i++ {
            field := t.Field(i)
            fieldVal := v.Field(i)

            // Skip unexported fields
            if !field.IsExported() {
                continue
            }

            key := field.Name
            // Use json tag name if available
            if tag := field.Tag.Get("json"); tag != "" {
                parts := strings.Split(tag, ",")
                if parts[0] != "" && parts[0] != "-" {
                    key = parts[0]
                }
            }

            fullKey := key
            if prefix != "" {
                fullKey = prefix + "." + key
            }

            flattenValue(fieldVal, fullKey, result)
        }

    case reflect.Map:
        for _, mapKey := range v.MapKeys() {
            keyStr := fmt.Sprintf("%v", mapKey.Interface())
            fullKey := keyStr
            if prefix != "" {
                fullKey = prefix + "." + keyStr
            }
            flattenValue(v.MapIndex(mapKey), fullKey, result)
        }

    default:
        result[prefix] = v.Interface()
    }
}
```

### Setting Values via Reflection

To set a value via reflection, the original value must be addressable (passed as a pointer):

```go
// SetField sets a struct field by name using reflection.
// The target must be a non-nil pointer to a struct.
func SetField(target interface{}, fieldName string, value interface{}) error {
    v := reflect.ValueOf(target)
    if v.Kind() != reflect.Ptr || v.IsNil() {
        return fmt.Errorf("target must be a non-nil pointer, got %T", target)
    }

    v = v.Elem()
    if v.Kind() != reflect.Struct {
        return fmt.Errorf("target must point to a struct, got %s", v.Kind())
    }

    field := v.FieldByName(fieldName)
    if !field.IsValid() {
        return fmt.Errorf("field %q not found in %T", fieldName, target)
    }

    if !field.CanSet() {
        return fmt.Errorf("field %q is not settable (unexported?)", fieldName)
    }

    newVal := reflect.ValueOf(value)

    // Handle type mismatch - attempt conversion
    if newVal.Type() != field.Type() {
        if !newVal.Type().ConvertibleTo(field.Type()) {
            return fmt.Errorf("cannot assign %T to field %s of type %s",
                value, fieldName, field.Type())
        }
        newVal = newVal.Convert(field.Type())
    }

    field.Set(newVal)
    return nil
}
```

## Section 3: Building a Struct Validator with reflect

A practical example: building a validation framework that reads struct tags at runtime.

```go
package validator

import (
    "fmt"
    "reflect"
    "strconv"
    "strings"
)

type ValidationError struct {
    Field   string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("validation failed for field %q: %s", e.Field, e.Message)
}

type ValidationErrors []ValidationError

func (ve ValidationErrors) Error() string {
    msgs := make([]string, len(ve))
    for i, e := range ve {
        msgs[i] = e.Error()
    }
    return strings.Join(msgs, "; ")
}

// Validate inspects a struct using reflection and validates
// fields based on "validate" struct tags.
// Supported tags: required, min=N, max=N, minlen=N, maxlen=N
func Validate(v interface{}) error {
    rv := reflect.ValueOf(v)
    if rv.Kind() == reflect.Ptr {
        if rv.IsNil() {
            return fmt.Errorf("cannot validate nil pointer")
        }
        rv = rv.Elem()
    }

    if rv.Kind() != reflect.Struct {
        return fmt.Errorf("Validate requires a struct, got %s", rv.Kind())
    }

    var errs ValidationErrors
    validateStruct(rv, rv.Type(), "", &errs)

    if len(errs) > 0 {
        return errs
    }
    return nil
}

func validateStruct(v reflect.Value, t reflect.Type, prefix string, errs *ValidationErrors) {
    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        fieldVal := v.Field(i)

        if !field.IsExported() {
            continue
        }

        fieldName := field.Name
        if prefix != "" {
            fieldName = prefix + "." + field.Name
        }

        // Recurse into nested structs
        if field.Type.Kind() == reflect.Struct {
            validateStruct(fieldVal, field.Type, fieldName, errs)
            continue
        }

        tag := field.Tag.Get("validate")
        if tag == "" {
            continue
        }

        rules := strings.Split(tag, ",")
        for _, rule := range rules {
            rule = strings.TrimSpace(rule)
            if err := applyRule(rule, fieldName, fieldVal); err != nil {
                *errs = append(*errs, ValidationError{
                    Field:   fieldName,
                    Message: err.Error(),
                })
            }
        }
    }
}

func applyRule(rule, fieldName string, v reflect.Value) error {
    switch {
    case rule == "required":
        return validateRequired(v)

    case strings.HasPrefix(rule, "min="):
        n, err := strconv.ParseFloat(strings.TrimPrefix(rule, "min="), 64)
        if err != nil {
            return fmt.Errorf("invalid min tag: %s", rule)
        }
        return validateMin(v, n)

    case strings.HasPrefix(rule, "max="):
        n, err := strconv.ParseFloat(strings.TrimPrefix(rule, "max="), 64)
        if err != nil {
            return fmt.Errorf("invalid max tag: %s", rule)
        }
        return validateMax(v, n)

    case strings.HasPrefix(rule, "minlen="):
        n, err := strconv.Atoi(strings.TrimPrefix(rule, "minlen="))
        if err != nil {
            return fmt.Errorf("invalid minlen tag: %s", rule)
        }
        return validateMinLen(v, n)
    }

    return nil
}

func validateRequired(v reflect.Value) error {
    switch v.Kind() {
    case reflect.String:
        if v.String() == "" {
            return fmt.Errorf("value is required")
        }
    case reflect.Ptr, reflect.Interface:
        if v.IsNil() {
            return fmt.Errorf("value is required")
        }
    case reflect.Slice, reflect.Map:
        if v.IsNil() || v.Len() == 0 {
            return fmt.Errorf("value is required")
        }
    }
    return nil
}

func validateMin(v reflect.Value, min float64) error {
    switch v.Kind() {
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        if float64(v.Int()) < min {
            return fmt.Errorf("value %d is less than minimum %g", v.Int(), min)
        }
    case reflect.Float32, reflect.Float64:
        if v.Float() < min {
            return fmt.Errorf("value %g is less than minimum %g", v.Float(), min)
        }
    }
    return nil
}

func validateMax(v reflect.Value, max float64) error {
    switch v.Kind() {
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        if float64(v.Int()) > max {
            return fmt.Errorf("value %d exceeds maximum %g", v.Int(), max)
        }
    case reflect.Float32, reflect.Float64:
        if v.Float() > max {
            return fmt.Errorf("value %g exceeds maximum %g", v.Float(), max)
        }
    }
    return nil
}

func validateMinLen(v reflect.Value, minLen int) error {
    switch v.Kind() {
    case reflect.String:
        if len(v.String()) < minLen {
            return fmt.Errorf("length %d is less than minimum %d", len(v.String()), minLen)
        }
    case reflect.Slice, reflect.Map, reflect.Array:
        if v.Len() < minLen {
            return fmt.Errorf("length %d is less than minimum %d", v.Len(), minLen)
        }
    }
    return nil
}
```

## Section 4: unsafe.Pointer - When You Need to Break the Rules

`unsafe.Pointer` is the escape hatch from Go's type system. It is used in performance-critical code where the reflect package's overhead is unacceptable.

The legal conversions involving `unsafe.Pointer` per the Go spec:

1. Any pointer type to `unsafe.Pointer`
2. `unsafe.Pointer` to any pointer type
3. `uintptr` to `unsafe.Pointer` (only within certain patterns)
4. `unsafe.Pointer` to `uintptr`

```go
package unsafe_example

import (
    "fmt"
    "unsafe"
)

// StringToBytes converts a string to []byte without allocation.
// This is safe only if the caller does NOT modify the returned slice.
// The string's backing memory is shared.
func StringToBytes(s string) []byte {
    if s == "" {
        return nil
    }
    // A string header has (ptr, len)
    // A slice header has (ptr, len, cap)
    // We can reuse the string's ptr and len directly.
    return (*[1 << 30]byte)(unsafe.Pointer(
        (*[2]uintptr)(unsafe.Pointer(&s))[0],
    ))[:len(s):len(s)]
}

// BytesToString converts []byte to string without allocation.
// The string shares memory with the slice; the slice must not
// be modified afterward.
func BytesToString(b []byte) string {
    if len(b) == 0 {
        return ""
    }
    return *(*string)(unsafe.Pointer(&b))
}

// OffsetOf returns the byte offset of a field in a struct.
// Equivalent to unsafe.Offsetof but computed at runtime.
func fieldOffset(v interface{}, fieldName string) uintptr {
    // This is for illustration - prefer unsafe.Offsetof in real code
    t := reflect.TypeOf(v)
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
    }
    f, ok := t.FieldByName(fieldName)
    if !ok {
        panic(fmt.Sprintf("field %s not found", fieldName))
    }
    return f.Offset
}
```

### Zero-Copy JSON Decoding with unsafe

High-performance JSON decoders like `jsoniter` and `sonic` use `unsafe` to avoid string allocations:

```go
package jsonfast

import (
    "unsafe"
)

// noescape prevents the Go escape analysis from marking
// the pointer as escaping to the heap.
// This is the same pattern used in the standard library.
//
//go:noescape
//go:nosplit
func noescape(p unsafe.Pointer) unsafe.Pointer

// stringHeader mirrors the internal string representation
type stringHeader struct {
    Data unsafe.Pointer
    Len  int
}

// sliceHeader mirrors the internal slice representation
type sliceHeader struct {
    Data unsafe.Pointer
    Len  int
    Cap  int
}

// parseStringUnsafe extracts a string from a byte slice without
// allocating. The returned string is only valid while b is alive
// and unmodified.
func parseStringUnsafe(b []byte, start, end int) string {
    sh := stringHeader{
        Data: unsafe.Pointer(&b[start]),
        Len:  end - start,
    }
    return *(*string)(unsafe.Pointer(&sh))
}
```

## Section 5: go generate Workflow

`go generate` is a code generation tool built into the Go toolchain. It reads special comments in Go source files and executes arbitrary commands.

```go
// In your Go source file:

//go:generate stringer -type=Status
//go:generate mockgen -source=service.go -destination=mocks/service_mock.go
//go:generate protoc --go_out=. --go-grpc_out=. proto/service.proto
//go:generate go run ./cmd/codegen/main.go -output generated.go

type Status int

const (
    StatusPending Status = iota
    StatusActive
    StatusInactive
    StatusDeleted
)
```

### Running go generate

```bash
# Generate for specific package
go generate ./internal/models/...

# Generate for entire module
go generate ./...

# Generate with verbose output
go generate -v ./...

# Run only generators matching a pattern
go generate -run "stringer" ./...

# Dry run to see what would be executed
go generate -n ./...
```

## Section 6: Writing a Custom Code Generator

A real-world code generator that produces typed event bus code from annotated interfaces:

```go
// cmd/eventgen/main.go
package main

import (
    "bytes"
    "flag"
    "fmt"
    "go/ast"
    "go/parser"
    "go/token"
    "go/types"
    "log"
    "os"
    "strings"
    "text/template"

    "golang.org/x/tools/go/packages"
)

var (
    outputFile = flag.String("output", "eventbus_gen.go", "Output file")
    pkg        = flag.String("package", "", "Package to process")
)

type EventType struct {
    Name       string
    StructName string
    Fields     []Field
}

type Field struct {
    Name string
    Type string
    Tag  string
}

type GeneratorInput struct {
    PackageName string
    Events      []EventType
}

const eventBusTemplate = `// Code generated by eventgen. DO NOT EDIT.
// Source: {{ .PackageName }}

package {{ .PackageName }}

import (
    "context"
    "sync"
)

// EventBus provides a type-safe publish/subscribe mechanism.
type EventBus struct {
    mu      sync.RWMutex
    handlers map[string][]interface{}
}

// NewEventBus creates a new EventBus instance.
func NewEventBus() *EventBus {
    return &EventBus{
        handlers: make(map[string][]interface{}),
    }
}

{{ range .Events }}
// Subscribe{{ .Name }} registers a handler for {{ .StructName }} events.
func (b *EventBus) Subscribe{{ .Name }}(handler func(ctx context.Context, event {{ .StructName }})) {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.handlers["{{ .Name }}"] = append(b.handlers["{{ .Name }}"], handler)
}

// Publish{{ .Name }} dispatches a {{ .StructName }} event to all subscribers.
func (b *EventBus) Publish{{ .Name }}(ctx context.Context, event {{ .StructName }}) {
    b.mu.RLock()
    handlers := b.handlers["{{ .Name }}"]
    b.mu.RUnlock()

    for _, h := range handlers {
        if fn, ok := h.(func(context.Context, {{ .StructName }})); ok {
            fn(ctx, event)
        }
    }
}
{{ end }}
`

func main() {
    flag.Parse()

    // Load the package using golang.org/x/tools/go/packages
    cfg := &packages.Config{
        Mode: packages.NeedName | packages.NeedFiles |
            packages.NeedSyntax | packages.NeedTypes |
            packages.NeedTypesInfo,
    }

    pkgs, err := packages.Load(cfg, *pkg)
    if err != nil {
        log.Fatalf("Failed to load package: %v", err)
    }

    var events []EventType

    for _, p := range pkgs {
        for _, file := range p.Syntax {
            ast.Inspect(file, func(n ast.Node) bool {
                typeSpec, ok := n.(*ast.TypeSpec)
                if !ok {
                    return true
                }

                structType, ok := typeSpec.Type.(*ast.StructType)
                if !ok {
                    return true
                }

                // Check for //event: comment above the type
                if !hasEventMarker(file, typeSpec) {
                    return true
                }

                event := EventType{
                    Name:       typeSpec.Name.Name,
                    StructName: typeSpec.Name.Name,
                }

                for _, field := range structType.Fields.List {
                    if len(field.Names) == 0 {
                        continue
                    }
                    f := Field{
                        Name: field.Names[0].Name,
                        Type: types.ExprString(field.Type),
                    }
                    if field.Tag != nil {
                        f.Tag = field.Tag.Value
                    }
                    event.Fields = append(event.Fields, f)
                }

                events = append(events, event)
                return true
            })
        }
    }

    if len(events) == 0 {
        log.Println("No event types found")
        return
    }

    input := GeneratorInput{
        PackageName: pkgs[0].Name,
        Events:      events,
    }

    tmpl := template.Must(template.New("eventbus").Parse(eventBusTemplate))

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, input); err != nil {
        log.Fatalf("Template execution failed: %v", err)
    }

    if err := os.WriteFile(*outputFile, buf.Bytes(), 0644); err != nil {
        log.Fatalf("Failed to write output: %v", err)
    }

    fmt.Printf("Generated %s with %d event types\n", *outputFile, len(events))
}

func hasEventMarker(file *ast.File, typeSpec *ast.TypeSpec) bool {
    // Look for comment "//event:" before the type declaration
    for _, cg := range file.Comments {
        for _, c := range cg.List {
            if strings.HasPrefix(c.Text, "//event:") {
                return true
            }
        }
    }
    return false
}
```

Usage in source files:

```go
package events

//go:generate go run ../../cmd/eventgen/main.go -package . -output eventbus_gen.go

//event: UserCreated is published when a new user registers
type UserCreatedEvent struct {
    UserID    string `json:"user_id"`
    Email     string `json:"email"`
    CreatedAt int64  `json:"created_at"`
}

//event: OrderPlaced is published when a user places an order
type OrderPlacedEvent struct {
    OrderID   string  `json:"order_id"`
    UserID    string  `json:"user_id"`
    Total     float64 `json:"total"`
    PlacedAt  int64   `json:"placed_at"`
}
```

## Section 7: Protocol Buffer Code Generation

protobuf is the most common use case for code generation in Go backend services.

### Protobuf Setup

```bash
# Install protoc compiler
# macOS
brew install protobuf

# Linux
apt-get install -y protobuf-compiler

# Install Go plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Install buf (modern protobuf toolchain)
go install github.com/bufbuild/buf/cmd/buf@latest
```

### buf.yaml Configuration

```yaml
# buf.yaml
version: v1
breaking:
  use:
    - FILE
lint:
  use:
    - DEFAULT
  except:
    - PACKAGE_VERSION_SUFFIX
```

### buf.gen.yaml for Code Generation

```yaml
# buf.gen.yaml
version: v1
plugins:
  - plugin: go
    out: gen/go
    opt:
      - paths=source_relative

  - plugin: go-grpc
    out: gen/go
    opt:
      - paths=source_relative
      - require_unimplemented_servers=false

  - plugin: grpc-gateway
    out: gen/go
    opt:
      - paths=source_relative
      - generate_unbound_methods=true

  - plugin: openapiv2
    out: gen/openapi
```

### Proto Definition

```protobuf
// proto/user/v1/user.proto
syntax = "proto3";

package user.v1;

option go_package = "github.com/example/myservice/gen/go/user/v1;userv1";

import "google/protobuf/timestamp.proto";
import "google/api/annotations.proto";

// UserService manages user lifecycle operations.
service UserService {
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse) {
    option (google.api.http) = {
      post: "/v1/users"
      body: "*"
    };
  }

  rpc GetUser(GetUserRequest) returns (GetUserResponse) {
    option (google.api.http) = {
      get: "/v1/users/{user_id}"
    };
  }

  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse) {
    option (google.api.http) = {
      get: "/v1/users"
    };
  }
}

message User {
  string user_id = 1;
  string email = 2;
  string display_name = 3;
  google.protobuf.Timestamp created_at = 4;
  google.protobuf.Timestamp updated_at = 5;
  UserStatus status = 6;
}

enum UserStatus {
  USER_STATUS_UNSPECIFIED = 0;
  USER_STATUS_ACTIVE = 1;
  USER_STATUS_INACTIVE = 2;
  USER_STATUS_SUSPENDED = 3;
}

message CreateUserRequest {
  string email = 1;
  string display_name = 2;
}

message CreateUserResponse {
  User user = 1;
}

message GetUserRequest {
  string user_id = 1;
}

message GetUserResponse {
  User user = 1;
}

message ListUsersRequest {
  int32 page_size = 1;
  string page_token = 2;
}

message ListUsersResponse {
  repeated User users = 1;
  string next_page_token = 2;
}
```

### Makefile Integration

```makefile
# Makefile

PROTO_DIR := proto
GEN_DIR := gen/go

.PHONY: generate proto lint-proto

generate: proto
    go generate ./...

proto:
    buf generate
    @echo "Generated protobuf code in $(GEN_DIR)"

lint-proto:
    buf lint

check-breaking:
    buf breaking --against '.git#branch=main'

clean-gen:
    rm -rf $(GEN_DIR)
    mkdir -p $(GEN_DIR)
```

## Section 8: JSON Code Generation with easyjson

For high-throughput JSON-heavy services, `easyjson` generates marshal/unmarshal code that avoids reflection at runtime:

```bash
go install github.com/mailru/easyjson/...@latest
```

```go
// models/order.go

//go:generate easyjson -all order.go

package models

import "time"

//easyjson:json
type Order struct {
    ID         string    `json:"id"`
    UserID     string    `json:"user_id"`
    Items      []Item    `json:"items"`
    TotalCents int64     `json:"total_cents"`
    CreatedAt  time.Time `json:"created_at"`
    Status     string    `json:"status"`
}

//easyjson:json
type Item struct {
    ProductID string `json:"product_id"`
    Quantity  int    `json:"quantity"`
    PriceCents int64 `json:"price_cents"`
}
```

After running `go generate`, easyjson creates `order_easyjson.go` with generated marshal/unmarshal methods. Benchmarks typically show 3-5x throughput improvement over `encoding/json`.

## Section 9: Template-Based Code Generation

The `text/template` package is the foundation of most Go code generators. Here is a robust template pattern:

```go
// internal/codegen/generator.go
package codegen

import (
    "bytes"
    "fmt"
    "go/format"
    "os"
    "text/template"
)

// Generator manages code generation from templates.
type Generator struct {
    packageName string
    imports     []string
    templates   map[string]*template.Template
}

var templateFuncs = template.FuncMap{
    "lower":      strings.ToLower,
    "upper":      strings.ToUpper,
    "title":      strings.Title,
    "camelCase":  toCamelCase,
    "snakeCase":  toSnakeCase,
    "pluralize":  pluralize,
    "hasPrefix":  strings.HasPrefix,
    "trimPrefix": strings.TrimPrefix,
}

func NewGenerator(pkgName string) *Generator {
    return &Generator{
        packageName: pkgName,
        templates:   make(map[string]*template.Template),
    }
}

func (g *Generator) AddTemplate(name, tmplText string) error {
    tmpl, err := template.New(name).Funcs(templateFuncs).Parse(tmplText)
    if err != nil {
        return fmt.Errorf("parsing template %q: %w", name, err)
    }
    g.templates[name] = tmpl
    return nil
}

func (g *Generator) Generate(templateName string, data interface{}) ([]byte, error) {
    tmpl, ok := g.templates[templateName]
    if !ok {
        return nil, fmt.Errorf("template %q not registered", templateName)
    }

    var buf bytes.Buffer

    // Write package header
    fmt.Fprintf(&buf, "// Code generated by codegen. DO NOT EDIT.\n\n")
    fmt.Fprintf(&buf, "package %s\n\n", g.packageName)

    if len(g.imports) > 0 {
        fmt.Fprintf(&buf, "import (\n")
        for _, imp := range g.imports {
            fmt.Fprintf(&buf, "\t%q\n", imp)
        }
        fmt.Fprintf(&buf, ")\n\n")
    }

    if err := tmpl.Execute(&buf, data); err != nil {
        return nil, fmt.Errorf("executing template: %w", err)
    }

    // Format the generated code
    formatted, err := format.Source(buf.Bytes())
    if err != nil {
        // Return unformatted code with error for debugging
        return buf.Bytes(), fmt.Errorf("formatting generated code: %w\nUnformatted:\n%s",
            err, buf.String())
    }

    return formatted, nil
}

func (g *Generator) WriteFile(filename, templateName string, data interface{}) error {
    code, err := g.Generate(templateName, data)
    if err != nil {
        return err
    }
    return os.WriteFile(filename, code, 0644)
}
```

## Section 10: Type-Safe Dependency Injection via Reflection

Wire (from Google) and fx (from Uber) use reflection to build dependency injection containers:

```go
// A simplified DI container implementation
package di

import (
    "fmt"
    "reflect"
)

// Container holds type-to-instance mappings.
type Container struct {
    providers map[reflect.Type]reflect.Value
}

func NewContainer() *Container {
    return &Container{
        providers: make(map[reflect.Type]reflect.Value),
    }
}

// Provide registers a constructor function.
// The constructor's return type becomes the provided type.
func (c *Container) Provide(constructor interface{}) error {
    fn := reflect.ValueOf(constructor)
    if fn.Kind() != reflect.Func {
        return fmt.Errorf("constructor must be a function, got %T", constructor)
    }

    fnType := fn.Type()
    if fnType.NumOut() < 1 {
        return fmt.Errorf("constructor must return at least one value")
    }

    returnType := fnType.Out(0)
    c.providers[returnType] = fn
    return nil
}

// Resolve creates an instance of T by calling the registered constructor,
// recursively resolving dependencies.
func Resolve[T any](c *Container) (T, error) {
    var zero T
    t := reflect.TypeOf(&zero).Elem()

    val, err := c.resolve(t)
    if err != nil {
        return zero, err
    }
    return val.Interface().(T), nil
}

func (c *Container) resolve(t reflect.Type) (reflect.Value, error) {
    constructor, ok := c.providers[t]
    if !ok {
        return reflect.Value{}, fmt.Errorf("no provider registered for type %s", t)
    }

    fnType := constructor.Type()
    args := make([]reflect.Value, fnType.NumIn())

    for i := 0; i < fnType.NumIn(); i++ {
        depType := fnType.In(i)
        dep, err := c.resolve(depType)
        if err != nil {
            return reflect.Value{}, fmt.Errorf("resolving dependency %s for %s: %w",
                depType, t, err)
        }
        args[i] = dep
    }

    results := constructor.Call(args)
    if len(results) == 2 {
        if !results[1].IsNil() {
            return reflect.Value{}, results[1].Interface().(error)
        }
    }

    return results[0], nil
}
```

## Section 11: Performance Characteristics and Caching

Reflection has measurable overhead. The primary costs are:

- `reflect.TypeOf()`: ~2-5ns per call (fast due to caching)
- `reflect.ValueOf()`: ~5-10ns per call
- Field access via reflection: ~50-100ns vs ~1ns for direct access
- Method calls via reflection: ~100-200ns vs ~5ns for direct calls

For hot paths, cache the reflect metadata:

```go
package fastmarshal

import (
    "reflect"
    "sync"
)

// fieldCache caches struct field metadata to avoid repeated reflection.
type fieldCache struct {
    mu     sync.RWMutex
    fields map[reflect.Type][]cachedField
}

type cachedField struct {
    index  int
    name   string
    typ    reflect.Type
    offset uintptr
}

var globalCache = &fieldCache{
    fields: make(map[reflect.Type][]cachedField),
}

func (fc *fieldCache) get(t reflect.Type) []cachedField {
    fc.mu.RLock()
    fields, ok := fc.fields[t]
    fc.mu.RUnlock()

    if ok {
        return fields
    }

    // Build and cache
    fc.mu.Lock()
    defer fc.mu.Unlock()

    // Double-check after acquiring write lock
    if fields, ok = fc.fields[t]; ok {
        return fields
    }

    fields = buildFieldCache(t)
    fc.fields[t] = fields
    return fields
}

func buildFieldCache(t reflect.Type) []cachedField {
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
    }

    result := make([]cachedField, 0, t.NumField())
    for i := 0; i < t.NumField(); i++ {
        f := t.Field(i)
        if !f.IsExported() {
            continue
        }
        result = append(result, cachedField{
            index:  i,
            name:   f.Name,
            typ:    f.Type,
            offset: f.Offset,
        })
    }
    return result
}
```

## Section 12: Testing Generated Code

Generated code needs testing, but you should test behavior, not the generated code itself:

```go
// Code generation test - verifies the generator produces compilable output
package codegen_test

import (
    "go/parser"
    "go/token"
    "os"
    "os/exec"
    "path/filepath"
    "testing"
)

func TestGeneratedCodeCompiles(t *testing.T) {
    // Run the generator
    tmpDir := t.TempDir()
    outputFile := filepath.Join(tmpDir, "generated.go")

    cmd := exec.Command("go", "run", "./cmd/codegen/main.go",
        "-output", outputFile,
        "-package", "./testdata/input",
    )
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    if err := cmd.Run(); err != nil {
        t.Fatalf("Generator failed: %v", err)
    }

    // Verify the output parses as valid Go
    fset := token.NewFileSet()
    _, err := parser.ParseFile(fset, outputFile, nil, parser.AllErrors)
    if err != nil {
        t.Fatalf("Generated code has syntax errors: %v", err)
    }

    // Verify it compiles
    compileCmd := exec.Command("go", "build", outputFile)
    if out, err := compileCmd.CombinedOutput(); err != nil {
        t.Fatalf("Generated code does not compile: %v\n%s", err, out)
    }
}

// Golden file test - verify generated output is stable
func TestGeneratorGoldenFile(t *testing.T) {
    generated, err := runGenerator("./testdata/input")
    if err != nil {
        t.Fatalf("Generator failed: %v", err)
    }

    goldenFile := "testdata/golden/expected_output.go"

    if os.Getenv("UPDATE_GOLDEN") == "1" {
        if err := os.WriteFile(goldenFile, generated, 0644); err != nil {
            t.Fatalf("Failed to update golden file: %v", err)
        }
        t.Log("Golden file updated")
        return
    }

    expected, err := os.ReadFile(goldenFile)
    if err != nil {
        t.Fatalf("Failed to read golden file: %v", err)
    }

    if string(generated) != string(expected) {
        t.Errorf("Generated output differs from golden file.\nRun with UPDATE_GOLDEN=1 to update.")
    }
}
```

## Summary

Go's reflection and code generation capabilities occupy distinct but complementary roles:

**Reflection** (`reflect` package) is appropriate for:
- Frameworks that operate on arbitrary types (validators, serializers, ORMs)
- Runtime configuration binding
- Dependency injection containers
- Dynamic dispatch patterns

**Code generation** (`go generate`) is appropriate for:
- Eliminating boilerplate while maintaining type safety
- Generating serialization code for performance
- Creating type-safe event buses, state machines, and repositories from annotations
- Protobuf/gRPC service implementation scaffolding

**unsafe.Pointer** is appropriate only when:
- Reflection overhead is measured and proven to be the bottleneck
- The code is in a well-tested, isolated package
- The invariants protecting memory safety are clearly documented

The combination of these tools allows Go teams to maintain the language's static type safety guarantees while achieving the flexibility and reduced boilerplate that large codebases require.
