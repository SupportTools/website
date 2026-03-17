---
title: "Go Reflection Patterns: Dynamic Struct Inspection and Configuration Binding"
date: 2029-02-09T00:00:00-05:00
draft: false
tags: ["Go", "Reflection", "Configuration", "Golang", "Performance", "Enterprise"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go's reflect package for building production-grade configuration binding, struct validation, and dynamic dispatch systems without code generation overhead."
more_link: "yes"
url: "/go-reflection-patterns-dynamic-struct-inspection-configuration-binding/"
---

Go's `reflect` package is one of the most powerful and most avoided corners of the standard library. The avoidance is understandable: reflection bypasses compile-time type safety, and misuse produces runtime panics that are painful to debug. But in the right contexts—configuration loaders, ORM-style mappers, testing utilities, and plugin systems—reflection eliminates enormous volumes of boilerplate and enables patterns that code generation cannot easily replicate at runtime.

This guide covers production-proven reflection patterns for struct inspection, configuration binding from environment variables and YAML, struct-level validation, and dynamic method dispatch. Every example includes the panic-avoidance patterns and performance considerations required in enterprise applications.

<!--more-->

## Understanding the reflect.Type and reflect.Value Model

Before writing any reflection code, it is essential to understand the distinction between `reflect.Type` and `reflect.Value`. `reflect.Type` describes the static shape of a type—its kind, field names, tags, and methods. `reflect.Value` holds both the type and the actual data at runtime.

```go
package main

import (
	"fmt"
	"reflect"
)

type ServerConfig struct {
	Host        string `env:"SERVER_HOST" default:"0.0.0.0"`
	Port        int    `env:"SERVER_PORT" default:"8080"`
	TLSEnabled  bool   `env:"TLS_ENABLED"  default:"false"`
	MaxConns    int    `env:"MAX_CONNS"    default:"1000"`
	LogLevel    string `env:"LOG_LEVEL"    default:"info"`
}

func inspectStruct(v interface{}) {
	t := reflect.TypeOf(v)
	// Dereference pointers until we reach the struct
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		fmt.Println("not a struct")
		return
	}

	fmt.Printf("Type: %s (%d fields)\n", t.Name(), t.NumField())
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		fmt.Printf(
			"  [%d] %-15s %-8s env=%q default=%q exported=%v\n",
			i,
			field.Name,
			field.Type.Kind(),
			field.Tag.Get("env"),
			field.Tag.Get("default"),
			field.IsExported(),
		)
	}
}

func main() {
	inspectStruct(&ServerConfig{})
}
// Output:
// Type: ServerConfig (5 fields)
//   [0] Host            string   env="SERVER_HOST" default="0.0.0.0" exported=true
//   [1] Port            int      env="SERVER_PORT" default="8080" exported=true
//   [2] TLSEnabled      bool     env="TLS_ENABLED"  default="false" exported=true
//   [3] MaxConns        int      env="MAX_CONNS"    default="1000" exported=true
//   [4] LogLevel        string   env="LOG_LEVEL"    default="info" exported=true
```

## Environment Variable Configuration Binding

The following implements a full production-ready `envconfig` binder that handles strings, integers, booleans, durations, slices, and nested structs—all driven by struct tags.

```go
package envconfig

import (
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// Bind populates dst (must be a pointer to a struct) from environment variables.
// Fields are matched using the `env` tag. The `default` tag supplies fallback values.
// Nested structs are traversed recursively. Unexported fields are skipped.
func Bind(dst interface{}) error {
	v := reflect.ValueOf(dst)
	if v.Kind() != reflect.Ptr || v.IsNil() {
		return fmt.Errorf("envconfig.Bind: dst must be a non-nil pointer, got %T", dst)
	}
	return bindStruct(v.Elem())
}

func bindStruct(v reflect.Value) error {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		fieldVal := v.Field(i)

		if !field.IsExported() {
			continue
		}

		// Recurse into nested structs (but not time.Duration, etc.)
		if field.Type.Kind() == reflect.Struct && field.Type != reflect.TypeOf(time.Time{}) {
			if err := bindStruct(fieldVal); err != nil {
				return fmt.Errorf("%s.%s: %w", t.Name(), field.Name, err)
			}
			continue
		}

		envKey := field.Tag.Get("env")
		if envKey == "" {
			continue
		}

		raw, found := os.LookupEnv(envKey)
		if !found {
			raw = field.Tag.Get("default")
			if raw == "" {
				continue
			}
		}

		if err := setField(fieldVal, field.Type, raw); err != nil {
			return fmt.Errorf("field %s (env=%s): %w", field.Name, envKey, err)
		}
	}
	return nil
}

func setField(v reflect.Value, t reflect.Type, raw string) error {
	// Handle pointer fields: allocate and recurse
	if t.Kind() == reflect.Ptr {
		ptr := reflect.New(t.Elem())
		if err := setField(ptr.Elem(), t.Elem(), raw); err != nil {
			return err
		}
		v.Set(ptr)
		return nil
	}

	switch t.Kind() {
	case reflect.String:
		v.SetString(raw)

	case reflect.Bool:
		b, err := strconv.ParseBool(raw)
		if err != nil {
			return fmt.Errorf("invalid bool %q: %w", raw, err)
		}
		v.SetBool(b)

	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		// Special-case time.Duration
		if t == reflect.TypeOf(time.Duration(0)) {
			d, err := time.ParseDuration(raw)
			if err != nil {
				return fmt.Errorf("invalid duration %q: %w", raw, err)
			}
			v.SetInt(int64(d))
			return nil
		}
		n, err := strconv.ParseInt(raw, 10, t.Bits())
		if err != nil {
			return fmt.Errorf("invalid int %q: %w", raw, err)
		}
		v.SetInt(n)

	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		n, err := strconv.ParseUint(raw, 10, t.Bits())
		if err != nil {
			return fmt.Errorf("invalid uint %q: %w", raw, err)
		}
		v.SetUint(n)

	case reflect.Float32, reflect.Float64:
		f, err := strconv.ParseFloat(raw, t.Bits())
		if err != nil {
			return fmt.Errorf("invalid float %q: %w", raw, err)
		}
		v.SetFloat(f)

	case reflect.Slice:
		// Comma-separated values for slices
		parts := strings.Split(raw, ",")
		slice := reflect.MakeSlice(t, len(parts), len(parts))
		for i, p := range parts {
			if err := setField(slice.Index(i), t.Elem(), strings.TrimSpace(p)); err != nil {
				return fmt.Errorf("slice[%d]: %w", i, err)
			}
		}
		v.Set(slice)

	default:
		return fmt.Errorf("unsupported kind %s for value %q", t.Kind(), raw)
	}
	return nil
}
```

### Usage Example

```go
package main

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/supporttools/envconfig"
)

type Config struct {
	Database struct {
		Host     string        `env:"DB_HOST"     default:"postgres.prod.svc.cluster.local"`
		Port     int           `env:"DB_PORT"     default:"5432"`
		DBName   string        `env:"DB_NAME"     default:"appdb"`
		MaxConns int           `env:"DB_MAX_CONNS" default:"25"`
		Timeout  time.Duration `env:"DB_TIMEOUT"  default:"5s"`
		SSLMode  string        `env:"DB_SSL_MODE" default:"require"`
	}
	Cache struct {
		Hosts   []string      `env:"REDIS_HOSTS"   default:"redis-0.redis:6379,redis-1.redis:6379"`
		Timeout time.Duration `env:"REDIS_TIMEOUT" default:"2s"`
	}
	App struct {
		Name     string `env:"APP_NAME"  default:"myservice"`
		Version  string `env:"APP_VERSION" default:"1.0.0"`
		LogLevel string `env:"LOG_LEVEL"   default:"info"`
		Debug    bool   `env:"DEBUG"       default:"false"`
	}
}

func main() {
	os.Setenv("DB_HOST", "pg-primary.databases.svc.cluster.local")
	os.Setenv("DB_MAX_CONNS", "50")
	os.Setenv("REDIS_HOSTS", "redis-0:6379,redis-1:6379,redis-2:6379")

	var cfg Config
	if err := envconfig.Bind(&cfg); err != nil {
		log.Fatalf("config: %v", err)
	}

	fmt.Printf("DB Host: %s\n", cfg.Database.Host)         // pg-primary.databases.svc.cluster.local
	fmt.Printf("DB MaxConns: %d\n", cfg.Database.MaxConns) // 50
	fmt.Printf("Redis hosts: %v\n", cfg.Cache.Hosts)       // [redis-0:6379 redis-1:6379 redis-2:6379]
	fmt.Printf("DB Timeout: %s\n", cfg.Database.Timeout)   // 5s
}
```

## Struct Validation with Reflection

A reflection-based validator avoids the need for generated code while supporting custom validation tags.

```go
package validator

import (
	"fmt"
	"reflect"
	"regexp"
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

func (errs ValidationErrors) Error() string {
	msgs := make([]string, len(errs))
	for i, e := range errs {
		msgs[i] = e.Error()
	}
	return strings.Join(msgs, "; ")
}

// Validate inspects each field in v (a struct pointer) and applies rules from the `validate` tag.
// Supported rules: required, min=N, max=N, email, regexp=PATTERN
func Validate(v interface{}) error {
	rv := reflect.ValueOf(v)
	for rv.Kind() == reflect.Ptr {
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Struct {
		return fmt.Errorf("Validate: expected struct, got %s", rv.Kind())
	}

	var errs ValidationErrors
	validateStruct(rv, "", &errs)
	if len(errs) > 0 {
		return errs
	}
	return nil
}

func validateStruct(v reflect.Value, prefix string, errs *ValidationErrors) {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		fv := v.Field(i)

		if !field.IsExported() {
			continue
		}

		name := prefix + field.Name
		if field.Type.Kind() == reflect.Struct {
			validateStruct(fv, name+".", errs)
			continue
		}

		rules := field.Tag.Get("validate")
		if rules == "" {
			continue
		}

		for _, rule := range strings.Split(rules, ",") {
			rule = strings.TrimSpace(rule)
			if err := applyRule(fv, name, rule); err != nil {
				*errs = append(*errs, ValidationError{Field: name, Message: err.Error()})
			}
		}
	}
}

func applyRule(v reflect.Value, fieldName, rule string) error {
	switch {
	case rule == "required":
		if v.IsZero() {
			return fmt.Errorf("field is required")
		}

	case strings.HasPrefix(rule, "min="):
		minStr := strings.TrimPrefix(rule, "min=")
		min, err := strconv.ParseFloat(minStr, 64)
		if err != nil {
			return fmt.Errorf("invalid min rule: %s", minStr)
		}
		actual := toFloat64(v)
		if actual < min {
			return fmt.Errorf("value %v is less than minimum %v", actual, min)
		}

	case strings.HasPrefix(rule, "max="):
		maxStr := strings.TrimPrefix(rule, "max=")
		max, err := strconv.ParseFloat(maxStr, 64)
		if err != nil {
			return fmt.Errorf("invalid max rule: %s", maxStr)
		}
		actual := toFloat64(v)
		if actual > max {
			return fmt.Errorf("value %v exceeds maximum %v", actual, max)
		}

	case rule == "email":
		emailRe := regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)
		if v.Kind() != reflect.String || !emailRe.MatchString(v.String()) {
			return fmt.Errorf("value %q is not a valid email address", v)
		}

	case strings.HasPrefix(rule, "regexp="):
		pattern := strings.TrimPrefix(rule, "regexp=")
		re, err := regexp.Compile(pattern)
		if err != nil {
			return fmt.Errorf("invalid regexp %q: %w", pattern, err)
		}
		if v.Kind() != reflect.String || !re.MatchString(v.String()) {
			return fmt.Errorf("value %q does not match pattern %q", v, pattern)
		}
	}
	return nil
}

func toFloat64(v reflect.Value) float64 {
	switch v.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(v.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(v.Uint())
	case reflect.Float32, reflect.Float64:
		return v.Float()
	}
	return 0
}
```

## Dynamic Method Dispatch

Reflection enables invoking methods by name at runtime—useful for plugin registries and command routers.

```go
package dispatch

import (
	"context"
	"fmt"
	"reflect"
)

// Handler is the signature all command handlers must satisfy.
type Handler interface {
	Handle(ctx context.Context, payload []byte) ([]byte, error)
}

// Registry maps command names to handler instances and dispatches by reflection.
type Registry struct {
	handlers map[string]reflect.Value
}

func NewRegistry() *Registry {
	return &Registry{handlers: make(map[string]reflect.Value)}
}

// Register associates a name with an object. Methods on the object named
// "Handle<Name>" become callable handlers.
func (r *Registry) Register(obj interface{}) {
	v := reflect.ValueOf(obj)
	t := reflect.TypeOf(obj)
	for i := 0; i < t.NumMethod(); i++ {
		method := t.Method(i)
		if !strings.HasPrefix(method.Name, "Handle") {
			continue
		}
		// Validate method signature: func(ctx, []byte) ([]byte, error)
		if method.Type.NumIn() != 3 || method.Type.NumOut() != 2 {
			continue
		}
		name := strings.TrimPrefix(method.Name, "Handle")
		r.handlers[name] = v.Method(i)
	}
}

// Dispatch calls the handler registered for the given command.
func (r *Registry) Dispatch(ctx context.Context, command string, payload []byte) ([]byte, error) {
	handler, ok := r.handlers[command]
	if !ok {
		return nil, fmt.Errorf("no handler registered for command %q", command)
	}

	ctxVal := reflect.ValueOf(ctx)
	payloadVal := reflect.ValueOf(payload)

	results := handler.Call([]reflect.Value{ctxVal, payloadVal})

	var result []byte
	if !results[0].IsNil() {
		result = results[0].Bytes()
	}
	var err error
	if !results[1].IsNil() {
		err = results[1].Interface().(error)
	}
	return result, err
}
```

## Reflection-Based Deep Copy

A generic deep copy that handles arbitrary nested structures is a classic reflection use case.

```go
package deepcopy

import "reflect"

// Copy returns a deep copy of v. Handles structs, slices, maps, pointers, and interfaces.
func Copy(v interface{}) interface{} {
	if v == nil {
		return nil
	}
	return deepCopy(reflect.ValueOf(v)).Interface()
}

func deepCopy(v reflect.Value) reflect.Value {
	switch v.Kind() {
	case reflect.Ptr:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		cp := reflect.New(v.Type().Elem())
		cp.Elem().Set(deepCopy(v.Elem()))
		return cp

	case reflect.Struct:
		cp := reflect.New(v.Type()).Elem()
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				cp.Field(i).Set(deepCopy(v.Field(i)))
			}
		}
		return cp

	case reflect.Slice:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		cp := reflect.MakeSlice(v.Type(), v.Len(), v.Cap())
		for i := 0; i < v.Len(); i++ {
			cp.Index(i).Set(deepCopy(v.Index(i)))
		}
		return cp

	case reflect.Map:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		cp := reflect.MakeMap(v.Type())
		for _, key := range v.MapKeys() {
			cp.SetMapIndex(deepCopy(key), deepCopy(v.MapIndex(key)))
		}
		return cp

	case reflect.Interface:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		cp := reflect.New(v.Elem().Type()).Elem()
		cp.Set(deepCopy(v.Elem()))
		result := reflect.New(v.Type()).Elem()
		result.Set(cp)
		return result

	default:
		// Scalars (int, string, bool, etc.) — copy by value
		cp := reflect.New(v.Type()).Elem()
		cp.Set(v)
		return cp
	}
}
```

## Performance Considerations and Caching

Reflection is slower than direct field access by roughly 10-50x. In hot paths, cache `reflect.Type` and field indices.

```go
package cached

import (
	"reflect"
	"sync"
)

type fieldInfo struct {
	index   int
	envKey  string
	defVal  string
	kind    reflect.Kind
}

type typeCache struct {
	mu    sync.RWMutex
	cache map[reflect.Type][]fieldInfo
}

var globalCache = &typeCache{
	cache: make(map[reflect.Type][]fieldInfo),
}

func (tc *typeCache) get(t reflect.Type) ([]fieldInfo, bool) {
	tc.mu.RLock()
	defer tc.mu.RUnlock()
	info, ok := tc.cache[t]
	return info, ok
}

func (tc *typeCache) set(t reflect.Type, info []fieldInfo) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	tc.cache[t] = info
}

func introspect(t reflect.Type) []fieldInfo {
	if info, ok := globalCache.get(t); ok {
		return info
	}

	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}

	var fields []fieldInfo
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		envKey := f.Tag.Get("env")
		if envKey == "" {
			continue
		}
		fields = append(fields, fieldInfo{
			index:  i,
			envKey: envKey,
			defVal: f.Tag.Get("default"),
			kind:   f.Type.Kind(),
		})
	}

	globalCache.set(t, fields)
	return fields
}
```

## Struct Diffing for Audit Logging

Reflecting over two instances of the same struct to produce a human-readable change set.

```go
package diff

import (
	"fmt"
	"reflect"
)

type Change struct {
	Field    string
	OldValue interface{}
	NewValue interface{}
}

// Diff returns a list of field changes between old and new (both must be same struct type).
func Diff(oldVal, newVal interface{}) ([]Change, error) {
	ov := reflect.ValueOf(oldVal)
	nv := reflect.ValueOf(newVal)

	for ov.Kind() == reflect.Ptr {
		ov = ov.Elem()
	}
	for nv.Kind() == reflect.Ptr {
		nv = nv.Elem()
	}

	if ov.Type() != nv.Type() {
		return nil, fmt.Errorf("type mismatch: %s vs %s", ov.Type(), nv.Type())
	}
	if ov.Kind() != reflect.Struct {
		return nil, fmt.Errorf("expected struct, got %s", ov.Kind())
	}

	var changes []Change
	diffStructs(ov, nv, "", &changes)
	return changes, nil
}

func diffStructs(ov, nv reflect.Value, prefix string, changes *[]Change) {
	t := ov.Type()
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		if !field.IsExported() {
			continue
		}
		name := prefix + field.Name
		ofv := ov.Field(i)
		nfv := nv.Field(i)

		if field.Type.Kind() == reflect.Struct {
			diffStructs(ofv, nfv, name+".", changes)
			continue
		}

		if !reflect.DeepEqual(ofv.Interface(), nfv.Interface()) {
			*changes = append(*changes, Change{
				Field:    name,
				OldValue: ofv.Interface(),
				NewValue: nfv.Interface(),
			})
		}
	}
}
```

## Panic Safety Patterns

Reflection panics when code accesses unexported fields, calls on nil pointers, or sets non-addressable values. Use these defensive patterns consistently.

```go
package safe

import (
	"fmt"
	"reflect"
)

// SafeGet retrieves a field value by name, returning an error instead of panicking.
func SafeGet(v interface{}, fieldName string) (interface{}, error) {
	rv := reflect.ValueOf(v)
	for rv.Kind() == reflect.Ptr {
		if rv.IsNil() {
			return nil, fmt.Errorf("nil pointer while accessing field %q", fieldName)
		}
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Struct {
		return nil, fmt.Errorf("expected struct, got %s", rv.Kind())
	}

	fv := rv.FieldByName(fieldName)
	if !fv.IsValid() {
		return nil, fmt.Errorf("no field named %q in %s", fieldName, rv.Type().Name())
	}
	if !fv.CanInterface() {
		return nil, fmt.Errorf("field %q is unexported", fieldName)
	}
	return fv.Interface(), nil
}

// SafeSet sets a field by name, returning an error instead of panicking.
func SafeSet(v interface{}, fieldName string, value interface{}) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic setting field %q: %v", fieldName, r)
		}
	}()

	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Ptr || rv.IsNil() {
		return fmt.Errorf("v must be a non-nil pointer")
	}
	rv = rv.Elem()

	fv := rv.FieldByName(fieldName)
	if !fv.IsValid() {
		return fmt.Errorf("no field named %q", fieldName)
	}
	if !fv.CanSet() {
		return fmt.Errorf("field %q cannot be set (unexported or non-addressable)", fieldName)
	}

	nv := reflect.ValueOf(value)
	if !nv.Type().AssignableTo(fv.Type()) {
		return fmt.Errorf("value of type %s is not assignable to field %q of type %s",
			nv.Type(), fieldName, fv.Type())
	}

	fv.Set(nv)
	return nil
}
```

## Benchmarking Reflection vs. Direct Access

Understanding the performance trade-off is essential for deciding where reflection is appropriate.

```go
package bench_test

import (
	"reflect"
	"testing"
)

type BenchStruct struct {
	Name  string
	Port  int
	Debug bool
}

var sink interface{}

func BenchmarkDirectFieldAccess(b *testing.B) {
	s := BenchStruct{Name: "server", Port: 8080, Debug: false}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sink = s.Name
	}
}

func BenchmarkReflectFieldAccess(b *testing.B) {
	s := BenchStruct{Name: "server", Port: 8080, Debug: false}
	rv := reflect.ValueOf(s)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sink = rv.FieldByName("Name").Interface()
	}
}

func BenchmarkCachedReflectFieldAccess(b *testing.B) {
	s := BenchStruct{Name: "server", Port: 8080, Debug: false}
	t := reflect.TypeOf(s)
	f, _ := t.FieldByName("Name")
	idx := f.Index[0]
	rv := reflect.ValueOf(s)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sink = rv.Field(idx).Interface()
	}
}
// Typical results on amd64:
// BenchmarkDirectFieldAccess-8         1000000000    0.26 ns/op
// BenchmarkReflectFieldAccess-8          20000000   68.00 ns/op
// BenchmarkCachedReflectFieldAccess-8   200000000    8.50 ns/op
```

Caching the field index reduces reflect overhead by ~8x compared to `FieldByName` while still being ~30x slower than direct access. Reserve uncached reflection for initialization paths, not request handling loops.

## Testing Reflection Code

```go
package envconfig_test

import (
	"os"
	"testing"
	"time"

	"github.com/supporttools/envconfig"
)

func TestBind_AllTypes(t *testing.T) {
	os.Setenv("STR_VAL", "hello")
	os.Setenv("INT_VAL", "42")
	os.Setenv("BOOL_VAL", "true")
	os.Setenv("DUR_VAL", "15s")
	os.Setenv("SLICE_VAL", "a,b,c")
	defer func() {
		os.Unsetenv("STR_VAL")
		os.Unsetenv("INT_VAL")
		os.Unsetenv("BOOL_VAL")
		os.Unsetenv("DUR_VAL")
		os.Unsetenv("SLICE_VAL")
	}()

	var cfg struct {
		Str   string        `env:"STR_VAL"`
		Int   int           `env:"INT_VAL"`
		Bool  bool          `env:"BOOL_VAL"`
		Dur   time.Duration `env:"DUR_VAL"`
		Slice []string      `env:"SLICE_VAL"`
	}

	if err := envconfig.Bind(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if cfg.Str != "hello" {
		t.Errorf("Str: want hello, got %q", cfg.Str)
	}
	if cfg.Int != 42 {
		t.Errorf("Int: want 42, got %d", cfg.Int)
	}
	if !cfg.Bool {
		t.Errorf("Bool: want true, got false")
	}
	if cfg.Dur != 15*time.Second {
		t.Errorf("Dur: want 15s, got %v", cfg.Dur)
	}
	if len(cfg.Slice) != 3 || cfg.Slice[1] != "b" {
		t.Errorf("Slice: want [a b c], got %v", cfg.Slice)
	}
}

func TestBind_DefaultValues(t *testing.T) {
	var cfg struct {
		Port int    `env:"MISSING_PORT" default:"9090"`
		Host string `env:"MISSING_HOST" default:"localhost"`
	}
	if err := envconfig.Bind(&cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Port != 9090 {
		t.Errorf("Port: want 9090, got %d", cfg.Port)
	}
	if cfg.Host != "localhost" {
		t.Errorf("Host: want localhost, got %q", cfg.Host)
	}
}
```

## When to Use Reflection vs. Alternatives

| Pattern | Reflection | Code Generation | Interface + Switch |
|---------|-----------|-----------------|-------------------|
| Config binding | Best fit | Verbose | Unmaintainable |
| ORM mapping | Best fit | Competitive | Verbose |
| JSON/YAML serialization | Competitive | Fastest | Inflexible |
| Plugin dispatch | Best fit | Not viable | Good for small sets |
| Hot-path data access | Avoid | Best | Good |
| Struct cloning/diffing | Best fit | Verbose | Not viable |

Reflection is the right choice when the structure is not known until runtime, when the number of types is large and growing, and when the code runs infrequently (initialization, middleware, tests). Avoid reflection in handlers that execute thousands of times per second without caching.

## Summary

Go's reflection package supports a rich set of production patterns: environment variable binding, struct validation, dynamic dispatch, deep copy, and audit diffing. The key to safe reflection is defensive coding (nil checks, kind checks, CanSet/CanInterface guards), caching type metadata for hot paths, and writing focused tests for each field type combination. Used judiciously, reflection eliminates entire categories of boilerplate while preserving the readability of a well-typed codebase.
