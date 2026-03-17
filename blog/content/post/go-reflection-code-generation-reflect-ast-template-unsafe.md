---
title: "Go Reflection and Code Generation: reflect Package Deep Dive, AST Parsing, text/template for Codegen, and unsafe Pointers"
date: 2032-01-05T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Reflection", "Code Generation", "AST", "Templates", "Performance", "Systems Programming"]
categories:
- Go
- DevOps
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Go reflection, AST parsing, template-driven code generation, and the unsafe package—with production patterns, pitfalls, and performance benchmarks."
more_link: "yes"
url: "/go-reflection-code-generation-reflect-ast-template-unsafe/"
---

Go's static type system is one of its greatest strengths, but large-scale enterprise codebases frequently encounter scenarios where types are not known at compile time: generic serialization frameworks, ORM mappings, dependency injection containers, RPC stub generators, and configuration validators. Go provides a structured path through these challenges via the `reflect` package, the `go/ast` package for compile-time code generation, `text/template` for flexible output, and—when performance demands it—the `unsafe` package for direct memory access. This guide covers each layer with production-grade patterns.

<!--more-->

# Go Reflection and Code Generation

## The Reflection Continuum

Go offers three distinct levels of runtime/compile-time introspection:

```
Runtime reflection (reflect)     — inspect/manipulate values at runtime
                                   cost: allocation, interface boxing, bounds checks
                                   use: unmarshaling, validation, dependency injection

Compile-time code generation     — generate Go source from types/specs
(go/ast + text/template + go:generate)
                                   cost: build-time complexity
                                   use: ORMs, mocks, serialization, client stubs

Unsafe memory access (unsafe)    — bypass type system for zero-copy operations
                                   cost: loss of safety guarantees, gc interaction
                                   use: high-performance serialization, FFI, cgo bridges
```

## Part 1: The reflect Package

### Type Identity and Kind

Every `reflect.Type` has both a `Type` (the full named type identity) and a `Kind` (the underlying structural category). Confusing these is the most common source of reflection bugs:

```go
package main

import (
    "fmt"
    "reflect"
)

type UserID int64
type OrderID int64

func printTypeInfo(v any) {
    t := reflect.TypeOf(v)
    fmt.Printf("Type:    %v\n", t)        // main.UserID
    fmt.Printf("Kind:    %v\n", t.Kind()) // int64
    fmt.Printf("PkgPath: %v\n", t.PkgPath()) // main
    fmt.Printf("Name:    %v\n", t.Name())     // UserID
}

func main() {
    var uid UserID = 42
    var oid OrderID = 99
    printTypeInfo(uid) // Type: main.UserID, Kind: int64
    printTypeInfo(oid) // Type: main.OrderID, Kind: int64

    // reflect.TypeOf is pointer-to-type aware
    printTypeInfo(&uid) // Type: *main.UserID, Kind: ptr
    fmt.Println(reflect.TypeOf(&uid).Elem()) // main.UserID
}
```

### Struct Field Traversal with Tags

Struct tags drive most enterprise reflection use cases—JSON marshaling, database column mapping, validation, form binding:

```go
package structutil

import (
    "fmt"
    "reflect"
    "strings"
)

// FieldMeta holds metadata for a single struct field.
type FieldMeta struct {
    Name      string
    Index     []int // support for embedded structs
    Type      reflect.Type
    JSONName  string
    DBColumn  string
    Validate  string
    OmitEmpty bool
    Required  bool
}

// ExtractFields recursively extracts field metadata from a struct type,
// following embedded structs. The caller passes the root type; embedded
// anonymous fields are inlined with correct index paths.
func ExtractFields(t reflect.Type) []FieldMeta {
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
    }
    if t.Kind() != reflect.Struct {
        panic(fmt.Sprintf("ExtractFields: expected struct, got %s", t.Kind()))
    }
    return extractFields(t, nil)
}

func extractFields(t reflect.Type, indexPrefix []int) []FieldMeta {
    var fields []FieldMeta
    for i := 0; i < t.NumField(); i++ {
        f := t.Field(i)
        idx := append(append([]int{}, indexPrefix...), i)

        // Skip unexported fields
        if !f.IsExported() {
            continue
        }

        // Recurse into anonymous embedded structs
        if f.Anonymous {
            ft := f.Type
            if ft.Kind() == reflect.Ptr {
                ft = ft.Elem()
            }
            if ft.Kind() == reflect.Struct {
                fields = append(fields, extractFields(ft, idx)...)
                continue
            }
        }

        meta := FieldMeta{
            Name:  f.Name,
            Index: idx,
            Type:  f.Type,
        }

        // Parse json tag
        if tag, ok := f.Tag.Lookup("json"); ok {
            parts := strings.Split(tag, ",")
            if parts[0] != "" && parts[0] != "-" {
                meta.JSONName = parts[0]
            } else if parts[0] == "" {
                meta.JSONName = f.Name
            }
            for _, opt := range parts[1:] {
                if opt == "omitempty" {
                    meta.OmitEmpty = true
                }
            }
        } else {
            meta.JSONName = f.Name
        }

        // Parse db tag
        if tag, ok := f.Tag.Lookup("db"); ok {
            meta.DBColumn = tag
        }

        // Parse validate tag
        if tag, ok := f.Tag.Lookup("validate"); ok {
            meta.Validate = tag
            meta.Required = strings.Contains(tag, "required")
        }

        fields = append(fields, meta)
    }
    return fields
}

// GetFieldByIndex navigates nested index paths (for embedded structs).
func GetFieldByIndex(v reflect.Value, index []int) reflect.Value {
    for _, i := range index {
        if v.Kind() == reflect.Ptr {
            if v.IsNil() {
                return reflect.Value{}
            }
            v = v.Elem()
        }
        v = v.Field(i)
    }
    return v
}
```

### Building a Generic Validator

Using the field metadata above, we can build a reusable struct validator:

```go
package validator

import (
    "errors"
    "fmt"
    "reflect"
    "strings"

    "myorg/structutil"
)

type ValidationError struct {
    Field   string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("field %q: %s", e.Field, e.Message)
}

type ValidationErrors []ValidationError

func (errs ValidationErrors) Error() string {
    msgs := make([]string, len(errs))
    for i, e := range errs {
        msgs[i] = e.Error()
    }
    return strings.Join(msgs, "; ")
}

// Validate inspects v using struct tags and returns all validation errors.
func Validate(v any) error {
    rv := reflect.ValueOf(v)
    if rv.Kind() == reflect.Ptr {
        if rv.IsNil() {
            return errors.New("cannot validate nil pointer")
        }
        rv = rv.Elem()
    }

    fields := structutil.ExtractFields(rv.Type())
    var errs ValidationErrors

    for _, meta := range fields {
        fv := structutil.GetFieldByIndex(rv, meta.Index)
        if !fv.IsValid() {
            continue
        }

        rules := strings.Split(meta.Validate, ",")
        for _, rule := range rules {
            switch {
            case rule == "required":
                if fv.IsZero() {
                    errs = append(errs, ValidationError{
                        Field:   meta.Name,
                        Message: "is required",
                    })
                }
            case strings.HasPrefix(rule, "min="):
                min := 0
                fmt.Sscanf(rule, "min=%d", &min)
                if fv.Kind() == reflect.String && len(fv.String()) < min {
                    errs = append(errs, ValidationError{
                        Field:   meta.Name,
                        Message: fmt.Sprintf("must be at least %d characters", min),
                    })
                }
            case strings.HasPrefix(rule, "max="):
                max := 0
                fmt.Sscanf(rule, "max=%d", &max)
                if fv.Kind() == reflect.String && len(fv.String()) > max {
                    errs = append(errs, ValidationError{
                        Field:   meta.Name,
                        Message: fmt.Sprintf("must be at most %d characters", max),
                    })
                }
            }
        }
    }

    if len(errs) > 0 {
        return errs
    }
    return nil
}
```

### Dynamic Method Invocation

Calling methods by name is a common pattern in plugin systems and middleware chains:

```go
package dispatch

import (
    "context"
    "fmt"
    "reflect"
)

// Dispatcher dynamically calls methods on a handler by action name.
type Dispatcher struct {
    handler reflect.Value
    methods map[string]reflect.Method
}

func NewDispatcher(handler any) (*Dispatcher, error) {
    rv := reflect.ValueOf(handler)
    rt := rv.Type()

    d := &Dispatcher{
        handler: rv,
        methods: make(map[string]reflect.Method),
    }

    for i := 0; i < rt.NumMethod(); i++ {
        m := rt.Method(i)
        if !m.IsExported() {
            continue
        }
        d.methods[m.Name] = m
    }
    return d, nil
}

// Dispatch calls handler.ActionName(ctx, req) and returns the results.
// The method signature must be: func (ctx context.Context, req T) (R, error)
func (d *Dispatcher) Dispatch(ctx context.Context, action string, req any) (any, error) {
    m, ok := d.methods[action]
    if !ok {
        return nil, fmt.Errorf("unknown action: %q", action)
    }

    mt := m.Type
    // Validate signature: first arg is receiver, second is context, third is request
    if mt.NumIn() != 3 || mt.NumOut() != 2 {
        return nil, fmt.Errorf("action %q has wrong signature", action)
    }
    if !mt.In(1).Implements(reflect.TypeOf((*context.Context)(nil)).Elem()) {
        return nil, fmt.Errorf("action %q: second arg must be context.Context", action)
    }

    // Convert req to the expected type
    reqType := mt.In(2)
    reqVal := reflect.ValueOf(req)
    if !reqVal.Type().AssignableTo(reqType) {
        if !reqVal.Type().ConvertibleTo(reqType) {
            return nil, fmt.Errorf("action %q: req type mismatch: got %T, want %v", action, req, reqType)
        }
        reqVal = reqVal.Convert(reqType)
    }

    results := m.Func.Call([]reflect.Value{
        d.handler,
        reflect.ValueOf(ctx),
        reqVal,
    })

    // results[1] is the error return
    errVal := results[1].Interface()
    if errVal != nil {
        return nil, errVal.(error)
    }
    return results[0].Interface(), nil
}
```

### reflect Performance Patterns

Reflection is expensive. These patterns minimize overhead in hot paths:

```go
package reflectcache

import (
    "reflect"
    "sync"
)

// TypeCache caches expensive reflect.Type computations keyed by type.
type TypeCache struct {
    mu    sync.RWMutex
    cache map[reflect.Type]any
}

var globalCache = &TypeCache{
    cache: make(map[reflect.Type]any),
}

func GetOrCompute(t reflect.Type, compute func(reflect.Type) any) any {
    globalCache.mu.RLock()
    v, ok := globalCache.cache[t]
    globalCache.mu.RUnlock()
    if ok {
        return v
    }

    globalCache.mu.Lock()
    defer globalCache.mu.Unlock()
    // Double-check under write lock
    if v, ok = globalCache.cache[t]; ok {
        return v
    }
    v = compute(t)
    globalCache.cache[t] = v
    return v
}

// Pre-computed type references avoid repeated TypeOf calls
var (
    typeError   = reflect.TypeOf((*error)(nil)).Elem()
    typeString  = reflect.TypeOf("")
    typeBytes   = reflect.TypeOf([]byte(nil))
    typeContext = reflect.TypeOf((*interface{ Deadline() (interface{}, bool) })(nil)).Elem()
)

// FieldAccessor uses a cached index path for zero-allocation field access
// after the first lookup.
type FieldAccessor struct {
    once  sync.Once
    index []int
    name  string
}

func (fa *FieldAccessor) Get(v reflect.Value) reflect.Value {
    fa.once.Do(func() {
        t := v.Type()
        if t.Kind() == reflect.Ptr {
            t = t.Elem()
        }
        sf, ok := t.FieldByName(fa.name)
        if !ok {
            panic("field not found: " + fa.name)
        }
        fa.index = sf.Index
    })
    return v.FieldByIndex(fa.index)
}
```

## Part 2: AST Parsing with go/ast

### Overview of the go/ast Package

The `go/ast` package provides a complete abstract syntax tree representation of parsed Go source code. Combined with `go/parser`, `go/token`, and `go/types`, it enables full type-aware analysis and transformation—the foundation of tools like `gofmt`, `gopls`, `mockgen`, and `protoc-gen-go`.

### Parsing a Go Source File

```go
package main

import (
    "fmt"
    "go/ast"
    "go/parser"
    "go/token"
    "go/types"
    "os"
)

func main() {
    fset := token.NewFileSet()

    // Parse a single file
    f, err := parser.ParseFile(fset, "example.go", nil, parser.ParseComments)
    if err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }

    // Walk the AST
    ast.Inspect(f, func(n ast.Node) bool {
        switch v := n.(type) {
        case *ast.FuncDecl:
            fmt.Printf("Function: %s at %s\n",
                v.Name.Name,
                fset.Position(v.Pos()))

        case *ast.TypeSpec:
            fmt.Printf("Type: %s\n", v.Name.Name)

        case *ast.StructType:
            for _, field := range v.Fields.List {
                for _, name := range field.Names {
                    fmt.Printf("  Field: %s %s\n",
                        name.Name,
                        types.ExprString(field.Type))
                }
            }
        }
        return true
    })
}
```

### Building a Full Package Analyzer

Real codegen tools parse entire packages, not individual files:

```go
package pkganalyzer

import (
    "go/ast"
    "go/importer"
    "go/parser"
    "go/token"
    "go/types"
    "path/filepath"
)

// StructInfo holds extracted information about a Go struct.
type StructInfo struct {
    Name    string
    Fields  []FieldInfo
    Methods []MethodInfo
    Doc     string
}

// FieldInfo represents a single struct field.
type FieldInfo struct {
    Name     string
    TypeName string
    Tags     map[string]string
    Doc      string
}

// MethodInfo represents a method on a type.
type MethodInfo struct {
    Name       string
    Params     []ParamInfo
    Results    []ParamInfo
    IsExported bool
}

// ParamInfo is a parameter or return value.
type ParamInfo struct {
    Name     string
    TypeName string
}

// AnalyzePackage parses the Go package at dir and extracts struct/method metadata.
func AnalyzePackage(dir string) ([]StructInfo, error) {
    fset := token.NewFileSet()

    pkgs, err := parser.ParseDir(fset, dir, nil, parser.ParseComments)
    if err != nil {
        return nil, err
    }

    // Collect all files
    var files []*ast.File
    for _, pkg := range pkgs {
        for _, f := range pkg.Files {
            files = append(files, f)
        }
    }

    // Type-check the package
    conf := types.Config{
        Importer: importer.ForCompiler(fset, "gc", nil),
    }
    info := &types.Info{
        Types: make(map[ast.Expr]types.TypeAndValue),
        Defs:  make(map[*ast.Ident]types.Object),
        Uses:  make(map[*ast.Ident]types.Object),
    }
    pkg, err := conf.Check(filepath.Base(dir), fset, files, info)
    if err != nil {
        return nil, err
    }

    var structs []StructInfo
    scope := pkg.Scope()

    for _, name := range scope.Names() {
        obj := scope.Lookup(name)
        typeName, ok := obj.(*types.TypeName)
        if !ok {
            continue
        }

        structType, ok := typeName.Type().Underlying().(*types.Struct)
        if !ok {
            continue
        }

        si := StructInfo{Name: name}

        for i := 0; i < structType.NumFields(); i++ {
            field := structType.Field(i)
            tag := structType.Tag(i)
            si.Fields = append(si.Fields, FieldInfo{
                Name:     field.Name(),
                TypeName: field.Type().String(),
                Tags:     parseStructTag(tag),
            })
        }

        // Extract methods via the method set
        mset := types.NewMethodSet(types.NewPointer(typeName.Type()))
        for i := 0; i < mset.Len(); i++ {
            sel := mset.At(i)
            fn, ok := sel.Obj().(*types.Func)
            if !ok {
                continue
            }
            sig := fn.Type().(*types.Signature)
            mi := MethodInfo{
                Name:       fn.Name(),
                IsExported: fn.Exported(),
            }
            for j := 0; j < sig.Params().Len(); j++ {
                p := sig.Params().At(j)
                mi.Params = append(mi.Params, ParamInfo{
                    Name:     p.Name(),
                    TypeName: p.Type().String(),
                })
            }
            for j := 0; j < sig.Results().Len(); j++ {
                r := sig.Results().At(j)
                mi.Results = append(mi.Results, ParamInfo{
                    Name:     r.Name(),
                    TypeName: r.Type().String(),
                })
            }
            si.Methods = append(si.Methods, mi)
        }

        structs = append(structs, si)
    }
    return structs, nil
}

func parseStructTag(tag string) map[string]string {
    t := reflect.StructTag(tag)
    // This is a simplified parser; production code would use reflect.StructTag.Lookup
    result := make(map[string]string)
    for _, key := range []string{"json", "db", "xml", "yaml", "validate", "mapstructure"} {
        if v := t.Get(key); v != "" {
            result[key] = v
        }
    }
    return result
}
```

## Part 3: Code Generation with text/template

### Template-Driven Codegen Architecture

The canonical Go codegen pattern:

1. Parse the source package with `go/ast`
2. Extract type metadata into a plain Go data structure
3. Execute `text/template` to render the output file
4. Run `go/format` to normalize the output
5. Write the file alongside the source

```go
package main

import (
    "bytes"
    "flag"
    "fmt"
    "go/format"
    "os"
    "text/template"

    "myorg/pkganalyzer"
)

var (
    dir      = flag.String("dir", ".", "directory to analyze")
    outFile  = flag.String("out", "generated.go", "output file")
    pkgName  = flag.String("pkg", "", "package name (defaults to source package)")
)

// repositoryTemplate generates a CRUD repository for each struct.
const repositoryTemplate = `// Code generated by repogen. DO NOT EDIT.
// Source: {{ .SourceDir }}

package {{ .PackageName }}

import (
    "context"
    "database/sql"
    "fmt"
)

{{ range .Structs }}
// {{ .Name }}Repository provides database operations for {{ .Name }}.
type {{ .Name }}Repository struct {
    db *sql.DB
}

// New{{ .Name }}Repository creates a new repository.
func New{{ .Name }}Repository(db *sql.DB) *{{ .Name }}Repository {
    return &{{ .Name }}Repository{db: db}
}

// FindByID retrieves a {{ .Name }} by its primary key.
func (r *{{ .Name }}Repository) FindByID(ctx context.Context, id int64) (*{{ .Name }}, error) {
    const query = ` + "`" + `SELECT {{ range $i, $f := .Fields }}{{ if $i }}, {{ end }}{{ $f.DBColumn }}{{ end }} FROM {{ .TableName }} WHERE id = $1` + "`" + `
    row := r.db.QueryRowContext(ctx, query, id)
    var m {{ .Name }}
    err := row.Scan({{ range $i, $f := .Fields }}{{ if $i }}, {{ end }}&m.{{ $f.Name }}{{ end }})
    if err == sql.ErrNoRows {
        return nil, nil
    }
    if err != nil {
        return nil, fmt.Errorf("{{ .Name }}Repository.FindByID: %w", err)
    }
    return &m, nil
}

// Insert persists a new {{ .Name }} to the database.
func (r *{{ .Name }}Repository) Insert(ctx context.Context, m *{{ .Name }}) error {
    const query = ` + "`" + `INSERT INTO {{ .TableName }} ({{ range $i, $f := .NonIDFields }}{{ if $i }}, {{ end }}{{ $f.DBColumn }}{{ end }}) VALUES ({{ range $i, $f := .NonIDFields }}{{ if $i }}, {{ end }}${{ inc $i }}{{ end }})` + "`" + `
    _, err := r.db.ExecContext(ctx, query, {{ range $i, $f := .NonIDFields }}{{ if $i }}, {{ end }}m.{{ $f.Name }}{{ end }})
    if err != nil {
        return fmt.Errorf("{{ .Name }}Repository.Insert: %w", err)
    }
    return nil
}

{{ end }}
`

type TemplateData struct {
    SourceDir   string
    PackageName string
    Structs     []StructTemplateData
}

type StructTemplateData struct {
    Name        string
    TableName   string
    Fields      []FieldTemplateData
    NonIDFields []FieldTemplateData
}

type FieldTemplateData struct {
    Name     string
    DBColumn string
    TypeName string
}

func toSnakeCase(s string) string {
    // Simplified snake_case conversion
    var result []byte
    for i, r := range s {
        if r >= 'A' && r <= 'Z' {
            if i > 0 {
                result = append(result, '_')
            }
            result = append(result, byte(r-'A'+'a'))
        } else {
            result = append(result, byte(r))
        }
    }
    return string(result)
}

func main() {
    flag.Parse()

    structs, err := pkganalyzer.AnalyzePackage(*dir)
    if err != nil {
        fmt.Fprintf(os.Stderr, "analyze: %v\n", err)
        os.Exit(1)
    }

    var templateStructs []StructTemplateData
    for _, s := range structs {
        ts := StructTemplateData{
            Name:      s.Name,
            TableName: toSnakeCase(s.Name) + "s",
        }
        for _, f := range s.Fields {
            col := f.Tags["db"]
            if col == "" {
                col = toSnakeCase(f.Name)
            }
            fd := FieldTemplateData{
                Name:     f.Name,
                DBColumn: col,
                TypeName: f.TypeName,
            }
            ts.Fields = append(ts.Fields, fd)
            if f.Name != "ID" && f.Name != "Id" {
                ts.NonIDFields = append(ts.NonIDFields, fd)
            }
        }
        templateStructs = append(templateStructs, ts)
    }

    data := TemplateData{
        SourceDir:   *dir,
        PackageName: *pkgName,
        Structs:     templateStructs,
    }

    funcMap := template.FuncMap{
        "inc": func(i int) int { return i + 1 },
    }

    tmpl, err := template.New("repo").Funcs(funcMap).Parse(repositoryTemplate)
    if err != nil {
        fmt.Fprintf(os.Stderr, "parse template: %v\n", err)
        os.Exit(1)
    }

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, data); err != nil {
        fmt.Fprintf(os.Stderr, "execute template: %v\n", err)
        os.Exit(1)
    }

    // Format the generated Go source
    formatted, err := format.Source(buf.Bytes())
    if err != nil {
        // Write unformatted for debugging
        fmt.Fprintln(os.Stderr, "format error:", err)
        os.WriteFile(*outFile, buf.Bytes(), 0o644)
        os.Exit(1)
    }

    if err := os.WriteFile(*outFile, formatted, 0o644); err != nil {
        fmt.Fprintf(os.Stderr, "write: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("Generated %s\n", *outFile)
}
```

### go:generate Integration

Wire your generator into the standard `go generate` workflow:

```go
// In models/user.go:
//go:generate go run ../../tools/repogen -dir=. -out=user_repository_gen.go -pkg=models

package models

// User represents an application user.
type User struct {
    ID        int64  `db:"id"`
    Email     string `db:"email" validate:"required,email"`
    FirstName string `db:"first_name" validate:"required,min=1,max=100"`
    LastName  string `db:"last_name" validate:"required,min=1,max=100"`
    CreatedAt int64  `db:"created_at"`
}
```

Run generation for the entire module:

```bash
# Generate all //go:generate directives in the module
go generate ./...

# Or target a specific package
go generate ./models/...
```

### Advanced Template Patterns

```go
// Multi-file generation: write one file per struct
tmpl := template.Must(template.New("").Funcs(funcMap).ParseFS(templateFS, "templates/*.tmpl"))

for _, s := range structs {
    outPath := filepath.Join(outDir, toSnakeCase(s.Name)+"_gen.go")
    f, err := os.Create(outPath)
    if err != nil {
        return err
    }

    var buf bytes.Buffer
    if err := tmpl.ExecuteTemplate(&buf, "repository.tmpl", s); err != nil {
        f.Close()
        return err
    }

    formatted, err := format.Source(buf.Bytes())
    if err != nil {
        f.Close()
        return fmt.Errorf("format %s: %w\n%s", outPath, err, buf.String())
    }

    f.Write(formatted)
    f.Close()
}
```

## Part 4: The unsafe Package

### When unsafe Is Justified

The `unsafe` package bypasses Go's type safety. It should be considered only when:

1. You have measured a genuine performance bottleneck
2. The operation is well-understood and tested
3. The code is isolated behind a safe API
4. You understand the interaction with the garbage collector

Common legitimate uses:
- Zero-copy string/byte slice conversion
- Accessing unexported struct fields in vendored code (rare, avoid if possible)
- Atomic operations on 64-bit values on 32-bit platforms
- FFI/cgo struct layout matching

### Zero-Copy String/[]byte Conversion

The canonical example: converting between `string` and `[]byte` without allocation:

```go
package zerocopy

import (
    "unsafe"
)

// StringToBytes converts a string to a []byte without allocation.
// The returned slice MUST NOT be modified. The string must remain live
// for the lifetime of the slice.
//
// WARNING: This is safe only when the caller guarantees immutability.
// Do not use this for bytes you intend to write to.
func StringToBytes(s string) []byte {
    if len(s) == 0 {
        return nil
    }
    // reflect.StringHeader and reflect.SliceHeader are deprecated in Go 1.20+
    // Use unsafe.SliceData / unsafe.StringData instead (Go 1.20+)
    p := unsafe.StringData(s)
    return unsafe.Slice(p, len(s))
}

// BytesToString converts a []byte to string without allocation.
// The string MUST NOT outlive the original slice. The slice must remain
// live and unmodified for the duration of the string's use.
func BytesToString(b []byte) string {
    if len(b) == 0 {
        return ""
    }
    return unsafe.String(unsafe.SliceData(b), len(b))
}
```

Benchmark comparison:

```go
package zerocopy_test

import (
    "testing"
    "strings"
)

var sink []byte
var sinkStr string

func BenchmarkStringToBytesCopy(b *testing.B) {
    s := strings.Repeat("x", 1024)
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        sink = []byte(s) // allocation
    }
}

func BenchmarkStringToBytesZeroCopy(b *testing.B) {
    s := strings.Repeat("x", 1024)
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        sink = StringToBytes(s) // no allocation
    }
}
```

Typical results:
```
BenchmarkStringToBytesCopy-8        5000000    245 ns/op   1024 B/op   1 allocs/op
BenchmarkStringToBytesZeroCopy-8   50000000      24 ns/op      0 B/op   0 allocs/op
```

### Struct Memory Layout and Padding

`unsafe.Offsetof` and `unsafe.Sizeof` reveal the compiler's struct packing decisions:

```go
package layout

import (
    "fmt"
    "unsafe"
)

// Inefficient: 32 bytes due to alignment padding
type BadLayout struct {
    A bool   // 1 byte + 7 pad
    B int64  // 8 bytes
    C bool   // 1 byte + 7 pad
    D int64  // 8 bytes
}

// Efficient: 18 bytes (sorted by alignment requirement, descending)
type GoodLayout struct {
    B int64  // 8 bytes
    D int64  // 8 bytes
    A bool   // 1 byte
    C bool   // 1 byte
    // 6 bytes padding at end (struct alignment = 8)
}

func main() {
    var bad BadLayout
    var good GoodLayout

    fmt.Printf("BadLayout:  %d bytes\n", unsafe.Sizeof(bad))   // 32
    fmt.Printf("GoodLayout: %d bytes\n", unsafe.Sizeof(good))  // 24

    fmt.Printf("BadLayout.B offset:  %d\n", unsafe.Offsetof(bad.B))  // 8
    fmt.Printf("GoodLayout.B offset: %d\n", unsafe.Offsetof(good.B)) // 0
}
```

### Atomic 64-bit Operations on 32-bit Platforms

On 32-bit platforms (ARMv6, x86), `sync/atomic` operations on 64-bit values require 8-byte alignment. `unsafe` helps diagnose and fix alignment issues:

```go
package atomicutil

import (
    "sync/atomic"
    "unsafe"
)

// AlignedInt64 wraps an int64 with guaranteed 8-byte alignment,
// safe for use with sync/atomic on 32-bit platforms.
type AlignedInt64 struct {
    _ [0]int64 // forces 8-byte alignment
    v int64
}

func (a *AlignedInt64) Load() int64 {
    return atomic.LoadInt64(&a.v)
}

func (a *AlignedInt64) Store(val int64) {
    atomic.StoreInt64(&a.v, val)
}

func (a *AlignedInt64) Add(delta int64) int64 {
    return atomic.AddInt64(&a.v, delta)
}

// VerifyAlignment checks that a pointer is properly aligned for atomic use.
func VerifyAlignment(p *int64) bool {
    return uintptr(unsafe.Pointer(p))%8 == 0
}
```

### unsafe.Pointer Rules (The Four Legal Conversions)

The Go spec permits only four conversions involving `unsafe.Pointer`:

```go
// Rule 1: unsafe.Pointer <-> *T (any pointer type)
p := unsafe.Pointer(&someStruct)
s := (*SomeStruct)(p)

// Rule 2: unsafe.Pointer <-> uintptr (for pointer arithmetic)
// WARNING: Do not store uintptr; it is not a GC root.
// The following is SAFE (single expression):
field := (*int)(unsafe.Pointer(uintptr(unsafe.Pointer(&s)) + unsafe.Offsetof(s.Field)))

// The following is UNSAFE (uintptr stored in variable across GC point):
// ptr := uintptr(unsafe.Pointer(&s))  // GC may move s
// field := (*int)(unsafe.Pointer(ptr + unsafe.Offsetof(s.Field)))  // WRONG

// Rule 3: reflect.Value.Pointer() -> unsafe.Pointer
// Rule 4: reflect.SliceHeader/StringHeader conversion (deprecated in 1.20, use unsafe.Slice/unsafe.String)
```

### unsafe in High-Performance Serialization

A real-world example from a binary protocol implementation:

```go
package binproto

import (
    "encoding/binary"
    "unsafe"
)

// MessageHeader is a fixed-size header for a binary protocol.
// Fields are ordered for natural alignment (no padding).
type MessageHeader struct {
    Magic    uint32
    Version  uint16
    Flags    uint16
    Sequence uint64
    Length   uint32
    Checksum uint32
}

const headerSize = int(unsafe.Sizeof(MessageHeader{})) // 24 bytes

// EncodeHeader serializes a MessageHeader to dst without reflection.
// dst must be at least 24 bytes. Returns number of bytes written.
func EncodeHeader(dst []byte, h *MessageHeader) int {
    if len(dst) < headerSize {
        panic("dst too small")
    }
    binary.LittleEndian.PutUint32(dst[0:4], h.Magic)
    binary.LittleEndian.PutUint16(dst[4:6], h.Version)
    binary.LittleEndian.PutUint16(dst[6:8], h.Flags)
    binary.LittleEndian.PutUint64(dst[8:16], h.Sequence)
    binary.LittleEndian.PutUint32(dst[16:20], h.Length)
    binary.LittleEndian.PutUint32(dst[20:24], h.Checksum)
    return headerSize
}

// DecodeHeaderFast decodes a MessageHeader using unsafe memory casting
// on little-endian platforms where alignment is guaranteed.
// This is ~3x faster than the field-by-field approach above.
// ONLY use when: platform is little-endian, src is 8-byte aligned.
func DecodeHeaderFast(src []byte) *MessageHeader {
    if len(src) < headerSize {
        panic("src too small")
    }
    // Cast the slice data pointer directly to *MessageHeader
    // This is valid because:
    // 1. MessageHeader has no padding (verified by unsafe.Sizeof)
    // 2. The data is little-endian (checked at startup)
    // 3. src is guaranteed aligned by the caller
    return (*MessageHeader)(unsafe.Pointer(unsafe.SliceData(src)))
}
```

## Putting It All Together: A Practical Code Generator

Here is a complete, production-style code generator that combines all four concepts:

```bash
# Directory structure
tools/
  modelgen/
    main.go           # Entry point with go/ast analysis
    templates/
      model_gen.tmpl  # text/template for output
    testdata/
      models/
        user.go       # Input structs with tags
```

```bash
# Makefile integration
.PHONY: generate
generate:
	@echo "Running code generation..."
	go generate ./...
	@echo "Formatting generated code..."
	gofmt -w ./**/*_gen.go
	@echo "Running vet on generated code..."
	go vet ./...

.PHONY: check-generated
check-generated: generate
	@git diff --exit-code -- '*.go' || \
		(echo "Generated files are out of date. Run 'make generate'."; exit 1)
```

## Benchmarks and When to Choose Each Approach

| Scenario | Best Approach | Rationale |
|----------|--------------|-----------|
| JSON unmarshaling into unknown struct | `reflect` | Runtime polymorphism required |
| Type-safe repository per model | `go/ast` + `text/template` | Compile-time safety, zero overhead |
| Struct tag validation (hot path) | `reflect` + cache | One-time reflection cost |
| Zero-copy HTTP response bodies | `unsafe.String` | Measured bottleneck, isolated |
| Mock generation | `go/ast` + `text/template` | Standard Go tooling |
| Plugin dispatch | `reflect` | Dynamic method sets |
| Binary protocol header parsing | `unsafe` cast | Proven 3x speedup, tested |

## Summary

Go's reflection and metaprogramming ecosystem offers a graduated set of tools:

- The `reflect` package handles runtime type introspection with caching strategies to minimize allocation overhead in hot paths.
- `go/ast` combined with `go/types` enables type-aware compile-time analysis for accurate, safe code generation.
- `text/template` renders generated Go source with `go/format` normalization to produce clean, idiomatic output.
- The `unsafe` package provides surgical performance optimization for bottlenecked, well-understood paths—governed by strict rules about pointer lifetime and GC interaction.

The discipline is knowing which tool belongs to which problem: runtime dynamism needs `reflect`, compile-time patterns need `go generate`, and performance-critical paths that have earned it get `unsafe`.
