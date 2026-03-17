---
title: "Go Reflection and Code Generation: reflect Package, go generate, text/template, and AST Manipulation"
date: 2028-08-10T00:00:00-05:00
draft: false
tags: ["Go", "Reflection", "Code Generation", "go generate", "AST"]
categories:
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go reflection and code generation covering the reflect package for runtime type inspection, go generate for automating repetitive code, text/template for code templates, AST parsing and manipulation with go/ast, and practical generator patterns used in production Go codebases."
more_link: "yes"
url: "/go-reflection-code-generation-guide/"
---

Go's approach to metaprogramming is distinctive: the language avoids macro systems and generative syntax, instead offering two complementary mechanisms — runtime reflection via the `reflect` package, and compile-time code generation via `go generate`. Understanding when to use each, and how to use them correctly, is the hallmark of advanced Go engineering.

Reflection enables dynamic behavior at runtime but at a performance and type-safety cost. Code generation produces static, type-safe, performant code but requires tooling. Most production Go codebases use both: reflection for serialization frameworks and dependency injection, code generation for repetitive boilerplate that would otherwise be hand-written.

This guide covers both mechanisms in depth, plus the AST tooling that underlies most Go generators.

<!--more-->

# Go Reflection and Code Generation: reflect Package, go generate, text/template, and AST Manipulation

## Section 1: The reflect Package

### Core Types

The `reflect` package is built on two fundamental types:

- `reflect.Type` — represents a Go type at runtime
- `reflect.Value` — represents a Go value at runtime, with its type

```go
package main

import (
    "fmt"
    "reflect"
)

type User struct {
    ID       int64  `json:"id" db:"user_id" validate:"required"`
    Name     string `json:"name" db:"name" validate:"required,min=2,max=100"`
    Email    string `json:"email" db:"email" validate:"required,email"`
    IsAdmin  bool   `json:"is_admin" db:"is_admin"`
    Password string `json:"-" db:"password_hash"` // omit from JSON
}

func main() {
    u := User{ID: 1, Name: "Alice", Email: "alice@example.com"}

    // Get the reflect.Type
    t := reflect.TypeOf(u)
    fmt.Println(t.Name())         // "User"
    fmt.Println(t.Kind())         // struct
    fmt.Println(t.NumField())     // 5
    fmt.Println(t.PkgPath())      // "main"

    // Iterate fields
    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        fmt.Printf("Field: %-10s Type: %-8s JSON: %s DB: %s\n",
            field.Name,
            field.Type.Kind(),
            field.Tag.Get("json"),
            field.Tag.Get("db"),
        )
    }

    // Get the reflect.Value
    v := reflect.ValueOf(u)
    for i := 0; i < v.NumField(); i++ {
        fmt.Printf("Value[%s]: %v\n", t.Field(i).Name, v.Field(i).Interface())
    }
}
```

### Type Inspection

```go
// type-inspection.go
package reflection

import (
    "fmt"
    "reflect"
)

// TypeInfo extracts complete type information recursively.
func TypeInfo(v interface{}) {
    inspectType(reflect.TypeOf(v), 0)
}

func inspectType(t reflect.Type, depth int) {
    prefix := fmt.Sprintf("%*s", depth*2, "")

    switch t.Kind() {
    case reflect.Ptr:
        fmt.Printf("%sPointer to: ", prefix)
        inspectType(t.Elem(), depth+1)

    case reflect.Slice:
        fmt.Printf("%sSlice of: ", prefix)
        inspectType(t.Elem(), depth+1)

    case reflect.Map:
        fmt.Printf("%sMap[", prefix)
        inspectType(t.Key(), 0)
        fmt.Printf("] of ")
        inspectType(t.Elem(), 0)

    case reflect.Struct:
        fmt.Printf("%sStruct %s {\n", prefix, t.Name())
        for i := 0; i < t.NumField(); i++ {
            f := t.Field(i)
            fmt.Printf("%s  %s %s", prefix, f.Name, f.Type.Kind())
            if tag := f.Tag; tag != "" {
                fmt.Printf(" `%s`", tag)
            }
            fmt.Println()
        }
        fmt.Printf("%s}\n", prefix)

    case reflect.Func:
        fmt.Printf("%sFunc(%d in, %d out)\n", prefix, t.NumIn(), t.NumOut())

    case reflect.Interface:
        fmt.Printf("%sInterface %s\n", prefix, t.Name())

    default:
        fmt.Printf("%s%s\n", prefix, t.Kind())
    }
}
```

### Dynamic Struct Manipulation

```go
// dynamic-struct.go
package reflection

import (
    "fmt"
    "reflect"
    "strings"
)

// SetField sets a struct field by name using reflection.
// The target must be a pointer to a struct.
func SetField(target interface{}, fieldName string, value interface{}) error {
    v := reflect.ValueOf(target)
    if v.Kind() != reflect.Ptr || v.Elem().Kind() != reflect.Struct {
        return fmt.Errorf("target must be a pointer to a struct")
    }

    v = v.Elem()
    field := v.FieldByName(fieldName)
    if !field.IsValid() {
        return fmt.Errorf("field %q not found in %T", fieldName, target)
    }
    if !field.CanSet() {
        return fmt.Errorf("field %q is not settable (unexported?)", fieldName)
    }

    val := reflect.ValueOf(value)
    if !val.Type().AssignableTo(field.Type()) {
        // Try conversion
        if val.Type().ConvertibleTo(field.Type()) {
            val = val.Convert(field.Type())
        } else {
            return fmt.Errorf("cannot assign %T to field %q of type %s",
                value, fieldName, field.Type())
        }
    }

    field.Set(val)
    return nil
}

// CopyFields copies matching fields from src to dst by field name.
// Both src and dst must be pointers to structs.
func CopyFields(dst, src interface{}) {
    srcVal := reflect.ValueOf(src).Elem()
    dstVal := reflect.ValueOf(dst).Elem()
    srcType := srcVal.Type()

    for i := 0; i < srcType.NumField(); i++ {
        srcField := srcType.Field(i)
        dstField := dstVal.FieldByName(srcField.Name)
        if !dstField.IsValid() || !dstField.CanSet() {
            continue
        }
        if srcField.Type.AssignableTo(dstField.Type()) {
            dstField.Set(srcVal.Field(i))
        }
    }
}

// StructToMap converts a struct to map[string]interface{} using field names.
// Respects json tags; omits fields tagged with `json:"-"`.
func StructToMap(v interface{}) map[string]interface{} {
    t := reflect.TypeOf(v)
    val := reflect.ValueOf(v)

    if t.Kind() == reflect.Ptr {
        t = t.Elem()
        val = val.Elem()
    }

    result := make(map[string]interface{}, t.NumField())
    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        fval := val.Field(i)

        // Get key name from json tag
        key := field.Name
        if tag := field.Tag.Get("json"); tag != "" {
            parts := strings.Split(tag, ",")
            if parts[0] == "-" {
                continue // Skip this field
            }
            if parts[0] != "" {
                key = parts[0]
            }
            // Handle omitempty
            if len(parts) > 1 && parts[1] == "omitempty" {
                if fval.IsZero() {
                    continue
                }
            }
        }

        result[key] = fval.Interface()
    }
    return result
}
```

### Method Invocation via Reflection

```go
// method-invoke.go
package reflection

import (
    "fmt"
    "reflect"
)

// CallMethod calls a method on v by name with the given args.
func CallMethod(v interface{}, method string, args ...interface{}) ([]interface{}, error) {
    val := reflect.ValueOf(v)
    m := val.MethodByName(method)
    if !m.IsValid() {
        return nil, fmt.Errorf("method %q not found on %T", method, v)
    }

    // Build argument slice
    in := make([]reflect.Value, len(args))
    for i, arg := range args {
        in[i] = reflect.ValueOf(arg)
    }

    // Call the method
    result := m.Call(in)

    // Convert results to []interface{}
    out := make([]interface{}, len(result))
    for i, r := range result {
        out[i] = r.Interface()
    }
    return out, nil
}

// IsImplementer reports whether v implements the interface I.
// Usage: IsImplementer(myObj, (*io.Writer)(nil))
func IsImplementer(v interface{}, iface interface{}) bool {
    ifaceType := reflect.TypeOf(iface).Elem()
    valType := reflect.TypeOf(v)
    return valType.Implements(ifaceType)
}
```

### Reflection Performance

Reflection is 10-100x slower than direct field access. Use it judiciously:

```go
// bench_test.go
package reflection_test

import (
    "reflect"
    "testing"
)

type TestStruct struct {
    Name  string
    Value int
}

var sink interface{}

func BenchmarkDirectFieldAccess(b *testing.B) {
    s := TestStruct{Name: "test", Value: 42}
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        sink = s.Name
    }
}

func BenchmarkReflectionFieldAccess(b *testing.B) {
    s := TestStruct{Name: "test", Value: 42}
    v := reflect.ValueOf(s)
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        sink = v.Field(0).Interface()
    }
}

func BenchmarkReflectionWithCaching(b *testing.B) {
    s := TestStruct{Name: "test", Value: 42}
    v := reflect.ValueOf(s)
    nameIdx := 0 // Pre-computed field index
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        sink = v.Field(nameIdx).Interface()
    }
}

// Results (approximate):
// BenchmarkDirectFieldAccess        2000000000    0.3 ns/op
// BenchmarkReflectionFieldAccess      30000000   45.2 ns/op
// BenchmarkReflectionWithCaching      50000000   28.7 ns/op
```

### Caching Reflection Results

```go
// cached-reflect.go
package reflection

import (
    "reflect"
    "sync"
)

// FieldIndex caches field indices for fast repeated access.
type FieldIndex struct {
    mu    sync.RWMutex
    cache map[reflect.Type]map[string]int
}

var defaultFieldIndex = &FieldIndex{
    cache: make(map[reflect.Type]map[string]int),
}

func (fi *FieldIndex) Get(t reflect.Type, fieldName string) (int, bool) {
    fi.mu.RLock()
    fields, ok := fi.cache[t]
    fi.mu.RUnlock()

    if !ok {
        fi.mu.Lock()
        fields = make(map[string]int, t.NumField())
        for i := 0; i < t.NumField(); i++ {
            fields[t.Field(i).Name] = i
        }
        fi.cache[t] = fields
        fi.mu.Unlock()
    }

    idx, found := fields[fieldName]
    return idx, found
}

// FastGetField gets a struct field value with caching for performance.
func FastGetField(v interface{}, fieldName string) (interface{}, bool) {
    val := reflect.ValueOf(v)
    if val.Kind() == reflect.Ptr {
        val = val.Elem()
    }
    t := val.Type()

    idx, ok := defaultFieldIndex.Get(t, fieldName)
    if !ok {
        return nil, false
    }
    return val.Field(idx).Interface(), true
}
```

## Section 2: go generate

`go generate` runs commands embedded in Go source files as specially formatted comments. It's the standard mechanism for:

- Generating mock implementations
- Running `stringer` for enum types
- Running `protoc` for protocol buffers
- Generating CRUD code from database schema
- Creating type-safe wrappers

### Basic go generate Usage

```go
// models.go

//go:generate stringer -type=Status
//go:generate mockgen -destination=mocks/mock_repository.go -package=mocks . Repository

package models

type Status int

const (
    StatusPending Status = iota
    StatusActive
    StatusInactive
    StatusDeleted
)

type Repository interface {
    FindByID(id int64) (*User, error)
    Save(user *User) error
    Delete(id int64) error
}
```

```bash
# Run all generators in the current package
go generate ./...

# Run generators for a specific file
go generate models/models.go

# Run with verbose output
go generate -v ./...

# Run generators matching a pattern
go generate -run stringer ./...
```

### Stringer Generation

```go
// direction.go
//go:generate stringer -type=Direction

package navigation

type Direction int

const (
    North Direction = iota
    South
    East
    West
)
```

After running `go generate`, the file `direction_string.go` is created:

```go
// direction_string.go — generated by stringer; do not edit.
package navigation

import "strconv"

func _() {
    var x [1]struct{}
    _ = x[North-0]
    _ = x[South-1]
    _ = x[East-2]
    _ = x[West-3]
}

const _Direction_name = "NorthSouthEastWest"
var _Direction_index = [...]uint8{0, 5, 10, 14, 18}

func (i Direction) String() string {
    if i < 0 || i >= Direction(len(_Direction_index)-1) {
        return "Direction(" + strconv.FormatInt(int64(i), 10) + ")"
    }
    return _Direction_name[_Direction_index[i]:_Direction_index[i+1]]
}
```

## Section 3: text/template for Code Generation

`text/template` is Go's standard templating engine. It's used by most Go code generators, including `controller-gen`, `protoc-gen-go`, and numerous others.

### Template Basics

```go
// generator.go
package generator

import (
    "bytes"
    "fmt"
    "os"
    "text/template"
)

const repositoryTemplate = `// Code generated by generator; DO NOT EDIT.
// Source: {{ .SourceFile }}
// Generated at: {{ .GeneratedAt }}

package {{ .PackageName }}

import (
    "context"
    "database/sql"
    "fmt"
)

// {{ .TypeName }}Repository provides database access for {{ .TypeName }}.
type {{ .TypeName }}Repository struct {
    db *sql.DB
}

// New{{ .TypeName }}Repository creates a new repository.
func New{{ .TypeName }}Repository(db *sql.DB) *{{ .TypeName }}Repository {
    return &{{ .TypeName }}Repository{db: db}
}

// FindByID retrieves a {{ .TypeName }} by its primary key.
func (r *{{ .TypeName }}Repository) FindByID(ctx context.Context, id {{ .IDType }}) (*{{ .TypeName }}, error) {
    const query = ` + "`" + `SELECT {{ .ColumnList }} FROM {{ .TableName }} WHERE {{ .PrimaryKey }} = $1` + "`" + `
    row := r.db.QueryRowContext(ctx, query, id)

    var obj {{ .TypeName }}
    err := row.Scan({{ .ScanList }})
    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("{{ .TypeName | lower }} not found: id=%v", id)
    }
    if err != nil {
        return nil, fmt.Errorf("scanning {{ .TypeName | lower }}: %w", err)
    }
    return &obj, nil
}

// Save inserts or updates a {{ .TypeName }}.
func (r *{{ .TypeName }}Repository) Save(ctx context.Context, obj *{{ .TypeName }}) error {
    const query = ` + "`" + `
        INSERT INTO {{ .TableName }} ({{ .ColumnList }})
        VALUES ({{ .Placeholders }})
        ON CONFLICT ({{ .PrimaryKey }}) DO UPDATE SET
        {{ .UpdateList }}
        RETURNING {{ .PrimaryKey }}
    ` + "`"

    return r.db.QueryRowContext(ctx, query, {{ .FieldList }}).Scan(&obj.{{ .IDField }})
}

// Delete removes a {{ .TypeName }} by ID.
func (r *{{ .TypeName }}Repository) Delete(ctx context.Context, id {{ .IDType }}) error {
    const query = ` + "`" + `DELETE FROM {{ .TableName }} WHERE {{ .PrimaryKey }} = $1` + "`"
    result, err := r.db.ExecContext(ctx, query, id)
    if err != nil {
        return fmt.Errorf("deleting {{ .TypeName | lower }}: %w", err)
    }
    rows, _ := result.RowsAffected()
    if rows == 0 {
        return fmt.Errorf("{{ .TypeName | lower }} not found: id=%v", id)
    }
    return nil
}
`

type RepositoryData struct {
    SourceFile   string
    GeneratedAt  string
    PackageName  string
    TypeName     string
    IDType       string
    IDField      string
    TableName    string
    PrimaryKey   string
    ColumnList   string
    ScanList     string
    FieldList    string
    Placeholders string
    UpdateList   string
}

func GenerateRepository(data RepositoryData, outputPath string) error {
    funcMap := template.FuncMap{
        "lower": strings.ToLower,
        "upper": strings.ToUpper,
        "title": strings.Title,
    }

    tmpl, err := template.New("repository").Funcs(funcMap).Parse(repositoryTemplate)
    if err != nil {
        return fmt.Errorf("parsing template: %w", err)
    }

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, data); err != nil {
        return fmt.Errorf("executing template: %w", err)
    }

    // Format the generated Go code
    formatted, err := format.Source(buf.Bytes())
    if err != nil {
        // Write unformatted for debugging
        os.WriteFile(outputPath+".unformatted", buf.Bytes(), 0644)
        return fmt.Errorf("formatting generated code: %w", err)
    }

    return os.WriteFile(outputPath, formatted, 0644)
}
```

### Complex Template with Iteration

```go
// crud-template.go
package generator

const crudTemplate = `// Code generated. DO NOT EDIT.

package {{ .Package }}

{{ range .Types }}
// ===== {{ .Name }} =====

type {{ .Name }}Filter struct {
    {{- range .Fields }}
    {{ .Name }} *{{ .Type }} ` + "`" + `json:"{{ .JSONName }},omitempty"` + "`" + `
    {{- end }}
    Limit  int ` + "`json:"limit,omitempty"`" + `
    Offset int ` + "`json:"offset,omitempty"`" + `
}

type {{ .Name }}List struct {
    Items []*{{ .Name }} ` + "`json:"items"`" + `
    Total int            ` + "`json:"total"`" + `
}

func (r *{{ $.RepositoryType }}) List{{ .Name }}s(ctx context.Context, filter {{ .Name }}Filter) (*{{ .Name }}List, error) {
    var conditions []string
    var args []interface{}
    argIdx := 1

    {{- range .FilterableFields }}
    if filter.{{ .Name }} != nil {
        conditions = append(conditions, fmt.Sprintf("{{ .Column }} = $%d", argIdx))
        args = append(args, *filter.{{ .Name }})
        argIdx++
    }
    {{- end }}

    where := ""
    if len(conditions) > 0 {
        where = "WHERE " + strings.Join(conditions, " AND ")
    }

    countQuery := fmt.Sprintf("SELECT COUNT(*) FROM {{ .Table }} %s", where)
    var total int
    if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
        return nil, fmt.Errorf("counting {{ .Name | lower }}s: %w", err)
    }

    limit := filter.Limit
    if limit <= 0 || limit > 1000 {
        limit = 100
    }

    query := fmt.Sprintf(
        "SELECT {{ .ColumnList }} FROM {{ .Table }} %s LIMIT %d OFFSET %d",
        where, limit, filter.Offset,
    )

    rows, err := r.db.QueryContext(ctx, query, args...)
    if err != nil {
        return nil, fmt.Errorf("listing {{ .Name | lower }}s: %w", err)
    }
    defer rows.Close()

    items := make([]*{{ .Name }}, 0)
    for rows.Next() {
        var obj {{ .Name }}
        if err := rows.Scan({{ .ScanFields }}); err != nil {
            return nil, fmt.Errorf("scanning {{ .Name | lower }}: %w", err)
        }
        items = append(items, &obj)
    }
    if err := rows.Err(); err != nil {
        return nil, err
    }

    return &{{ .Name }}List{Items: items, Total: total}, nil
}
{{ end }}
`
```

## Section 4: AST Manipulation

The `go/ast`, `go/parser`, and `go/token` packages provide access to Go's abstract syntax tree. These are the building blocks of all Go code analysis tools.

### Parsing and Walking an AST

```go
// ast-walk.go
package asttools

import (
    "fmt"
    "go/ast"
    "go/parser"
    "go/token"
)

// ExtractFunctions extracts all function names from a Go source file.
func ExtractFunctions(src string) ([]string, error) {
    fset := token.NewFileSet()
    f, err := parser.ParseFile(fset, "input.go", src, parser.ParseComments)
    if err != nil {
        return nil, fmt.Errorf("parsing source: %w", err)
    }

    var functions []string
    ast.Inspect(f, func(n ast.Node) bool {
        switch fn := n.(type) {
        case *ast.FuncDecl:
            if fn.Name != nil {
                functions = append(functions, fn.Name.Name)
            }
        }
        return true // continue walking
    })
    return functions, nil
}

// ExtractStructFields extracts struct field information.
type FieldInfo struct {
    StructName string
    FieldName  string
    FieldType  string
    Tags       map[string]string
}

func ExtractStructFields(src string) ([]FieldInfo, error) {
    fset := token.NewFileSet()
    f, err := parser.ParseFile(fset, "input.go", src, 0)
    if err != nil {
        return nil, err
    }

    var fields []FieldInfo
    ast.Inspect(f, func(n ast.Node) bool {
        typeSpec, ok := n.(*ast.TypeSpec)
        if !ok {
            return true
        }
        structType, ok := typeSpec.Type.(*ast.StructType)
        if !ok {
            return true
        }

        for _, field := range structType.Fields.List {
            typeName := fmt.Sprintf("%v", field.Type)
            tags := parseTags(field.Tag)

            for _, name := range field.Names {
                fields = append(fields, FieldInfo{
                    StructName: typeSpec.Name.Name,
                    FieldName:  name.Name,
                    FieldType:  typeName,
                    Tags:       tags,
                })
            }
        }
        return true
    })
    return fields, nil
}

func parseTags(tag *ast.BasicLit) map[string]string {
    result := make(map[string]string)
    if tag == nil {
        return result
    }
    // Strip backticks
    raw := tag.Value[1 : len(tag.Value)-1]
    // Use reflect.StructTag for parsing
    st := reflect.StructTag(raw)
    for _, key := range []string{"json", "db", "validate", "yaml"} {
        if v := st.Get(key); v != "" {
            result[key] = v
        }
    }
    return result
}
```

### Writing a Complete Code Generator

```go
// cmd/gen-repository/main.go
// A complete generator that reads struct definitions and generates repository code.
//
//go:generate go run . -type=User -output=user_repository_gen.go

package main

import (
    "flag"
    "fmt"
    "go/ast"
    "go/format"
    "go/parser"
    "go/token"
    "os"
    "strings"
    "text/template"
    "time"
    "unicode"
)

var (
    typeName   = flag.String("type", "", "Struct type to generate repository for")
    outputFile = flag.String("output", "", "Output file path")
    pkg        = flag.String("package", "", "Package name (defaults to current package)")
)

type Field struct {
    GoName   string
    GoType   string
    DBColumn string
    IsID     bool
    Nullable bool
}

type GeneratorInput struct {
    Package     string
    SourceFile  string
    GeneratedAt string
    TypeName    string
    TableName   string
    Fields      []Field
}

func main() {
    flag.Parse()
    if *typeName == "" {
        fmt.Fprintln(os.Stderr, "error: -type flag is required")
        os.Exit(1)
    }

    // Find the source file containing the struct
    goFile := os.Getenv("GOFILE")
    if goFile == "" {
        goFile = findGoFile(*typeName)
    }

    // Parse the source file
    fset := token.NewFileSet()
    f, err := parser.ParseFile(fset, goFile, nil, parser.ParseComments)
    if err != nil {
        fmt.Fprintf(os.Stderr, "error parsing %s: %v\n", goFile, err)
        os.Exit(1)
    }

    // Extract the struct definition
    input := extractStruct(f, *typeName)
    if input == nil {
        fmt.Fprintf(os.Stderr, "struct %q not found in %s\n", *typeName, goFile)
        os.Exit(1)
    }

    input.SourceFile = goFile
    input.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
    if *pkg != "" {
        input.Package = *pkg
    } else {
        input.Package = f.Name.Name
    }

    // Generate code
    code, err := generateCode(input)
    if err != nil {
        fmt.Fprintf(os.Stderr, "error generating code: %v\n", err)
        os.Exit(1)
    }

    // Write output
    out := *outputFile
    if out == "" {
        out = strings.ToLower(*typeName) + "_repository_gen.go"
    }
    if err := os.WriteFile(out, code, 0644); err != nil {
        fmt.Fprintf(os.Stderr, "error writing %s: %v\n", out, err)
        os.Exit(1)
    }
    fmt.Printf("Generated: %s\n", out)
}

func findGoFile(typeName string) string {
    // Search current directory for the struct definition
    entries, err := os.ReadDir(".")
    if err != nil {
        return ""
    }
    for _, e := range entries {
        if !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_gen.go") {
            continue
        }
        fset := token.NewFileSet()
        f, err := parser.ParseFile(fset, e.Name(), nil, 0)
        if err != nil {
            continue
        }
        for _, decl := range f.Decls {
            genDecl, ok := decl.(*ast.GenDecl)
            if !ok {
                continue
            }
            for _, spec := range genDecl.Specs {
                typeSpec, ok := spec.(*ast.TypeSpec)
                if !ok {
                    continue
                }
                if typeSpec.Name.Name == typeName {
                    return e.Name()
                }
            }
        }
    }
    return ""
}

func extractStruct(f *ast.File, typeName string) *GeneratorInput {
    for _, decl := range f.Decls {
        genDecl, ok := decl.(*ast.GenDecl)
        if !ok {
            continue
        }
        for _, spec := range genDecl.Specs {
            typeSpec, ok := spec.(*ast.TypeSpec)
            if !ok || typeSpec.Name.Name != typeName {
                continue
            }
            structType, ok := typeSpec.Type.(*ast.StructType)
            if !ok {
                continue
            }

            input := &GeneratorInput{
                TypeName:  typeName,
                TableName: toSnakeCase(typeName) + "s",
            }

            for _, field := range structType.Fields.List {
                if len(field.Names) == 0 {
                    continue // embedded field
                }
                name := field.Names[0].Name
                if !ast.IsExported(name) {
                    continue
                }

                typeStr := exprToString(field.Type)
                dbColumn := toSnakeCase(name)
                isID := false

                if field.Tag != nil {
                    tag := reflect.StructTag(strings.Trim(field.Tag.Value, "`"))
                    if db := tag.Get("db"); db != "" && db != "-" {
                        parts := strings.Split(db, ",")
                        dbColumn = parts[0]
                        for _, opt := range parts[1:] {
                            if opt == "pk" || opt == "primarykey" {
                                isID = true
                            }
                        }
                    }
                }

                if strings.ToLower(name) == "id" {
                    isID = true
                }

                input.Fields = append(input.Fields, Field{
                    GoName:   name,
                    GoType:   typeStr,
                    DBColumn: dbColumn,
                    IsID:     isID,
                    Nullable: strings.HasPrefix(typeStr, "*"),
                })
            }

            return input
        }
    }
    return nil
}

func generateCode(input *GeneratorInput) ([]byte, error) {
    funcMap := template.FuncMap{
        "lower":      strings.ToLower,
        "upper":      strings.ToUpper,
        "snakeCase":  toSnakeCase,
        "join":       strings.Join,
        "idField":    func(fields []Field) Field {
            for _, f := range fields {
                if f.IsID { return f }
            }
            return fields[0]
        },
        "nonIDFields": func(fields []Field) []Field {
            var result []Field
            for _, f := range fields {
                if !f.IsID { result = append(result, f) }
            }
            return result
        },
    }

    const tmpl = `// Code generated by gen-repository. DO NOT EDIT.
// Source: {{ .SourceFile }}
// Generated: {{ .GeneratedAt }}

package {{ .Package }}

import (
    "context"
    "database/sql"
    "fmt"
    "strings"
)

// {{ .TypeName }}Repository provides database operations for {{ .TypeName }}.
type {{ .TypeName }}Repository struct {
    db *sql.DB
}

// New{{ .TypeName }}Repository creates a new repository.
func New{{ .TypeName }}Repository(db *sql.DB) *{{ .TypeName }}Repository {
    return &{{ .TypeName }}Repository{db: db}
}

{{ $idField := (idField .Fields) -}}
{{ $nonID := (nonIDFields .Fields) -}}

// FindByID retrieves a {{ .TypeName }} by primary key.
func (r *{{ .TypeName }}Repository) FindByID(ctx context.Context, id {{ $idField.GoType }}) (*{{ .TypeName }}, error) {
    const q = ` + "`SELECT " + `{{ range $i, $f := .Fields }}{{ if $i }}, {{ end }}{{ $f.DBColumn }}{{ end }}` + ` FROM {{ .TableName }} WHERE {{ $idField.DBColumn }} = $1` + "`" + `
    var obj {{ .TypeName }}
    err := r.db.QueryRowContext(ctx, q, id).Scan(
        {{- range .Fields }}
        &obj.{{ .GoName }},
        {{- end }}
    )
    if err == sql.ErrNoRows {
        return nil, fmt.Errorf("{{ .TypeName | lower }} not found")
    }
    if err != nil {
        return nil, fmt.Errorf("finding {{ .TypeName | lower }}: %w", err)
    }
    return &obj, nil
}

// Save inserts or updates a {{ .TypeName }}.
func (r *{{ .TypeName }}Repository) Save(ctx context.Context, obj *{{ .TypeName }}) error {
    const q = ` + "`INSERT INTO {{ .TableName }} (" +
        `{{ range $i, $f := .Fields }}{{ if $i }}, {{ end }}{{ $f.DBColumn }}{{ end }}` +
        `) VALUES (` +
        `{{ range $i, $f := .Fields }}{{ if $i }}, {{ end }}${{ add $i 1 }}{{ end }}` +
        `) ON CONFLICT ({{ $idField.DBColumn }}) DO UPDATE SET ` +
        `{{ range $i, $f := (nonIDFields .Fields) }}{{ if $i }}, {{ end }}{{ $f.DBColumn }} = EXCLUDED.{{ $f.DBColumn }}{{ end }}` +
        "`" + `
    _, err := r.db.ExecContext(ctx, q,
        {{- range .Fields }}
        obj.{{ .GoName }},
        {{- end }}
    )
    if err != nil {
        return fmt.Errorf("saving {{ .TypeName | lower }}: %w", err)
    }
    return nil
}

// Delete removes a {{ .TypeName }} by primary key.
func (r *{{ .TypeName }}Repository) Delete(ctx context.Context, id {{ $idField.GoType }}) error {
    const q = ` + "`DELETE FROM {{ .TableName }} WHERE {{ $idField.DBColumn }} = $1`" + `
    result, err := r.db.ExecContext(ctx, q, id)
    if err != nil {
        return fmt.Errorf("deleting {{ .TypeName | lower }}: %w", err)
    }
    n, _ := result.RowsAffected()
    if n == 0 {
        return fmt.Errorf("{{ .TypeName | lower }} not found")
    }
    return nil
}
`

    t, err := template.New("repo").Funcs(funcMap).Parse(tmpl)
    if err != nil {
        return nil, err
    }

    var buf strings.Builder
    if err := t.Execute(&buf, input); err != nil {
        return nil, err
    }

    return format.Source([]byte(buf.String()))
}

func toSnakeCase(s string) string {
    var result strings.Builder
    for i, r := range s {
        if unicode.IsUpper(r) && i > 0 {
            result.WriteByte('_')
        }
        result.WriteRune(unicode.ToLower(r))
    }
    return result.String()
}

func exprToString(expr ast.Expr) string {
    switch e := expr.(type) {
    case *ast.Ident:
        return e.Name
    case *ast.StarExpr:
        return "*" + exprToString(e.X)
    case *ast.SelectorExpr:
        return exprToString(e.X) + "." + e.Sel.Name
    case *ast.ArrayType:
        return "[]" + exprToString(e.Elt)
    default:
        return fmt.Sprintf("%T", expr)
    }
}
```

## Section 5: mockgen and Interface Generation

```bash
# Install mockgen
go install go.uber.org/mock/mockgen@latest

# Generate mocks from an interface in a package
mockgen -source=internal/repository/repository.go \
        -destination=internal/repository/mocks/mock_repository.go \
        -package=mocks

# Generate mock from a specific interface by reflection
mockgen github.com/supporttools/myapp/internal/repository UserRepository \
        -destination=internal/repository/mocks/mock_user_repository.go \
        -package=mocks

# Using go:generate directive
```

```go
// repository.go
//go:generate mockgen -destination=mocks/mock_user_repo.go -package=mocks . UserRepository
//go:generate mockgen -destination=mocks/mock_cache.go -package=mocks . Cache

package repository

type UserRepository interface {
    FindByID(ctx context.Context, id int64) (*User, error)
    FindByEmail(ctx context.Context, email string) (*User, error)
    Save(ctx context.Context, user *User) error
    Delete(ctx context.Context, id int64) error
    List(ctx context.Context, filter UserFilter) ([]*User, int, error)
}

type Cache interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
}
```

### Using Generated Mocks in Tests

```go
// service_test.go
package service_test

import (
    "context"
    "testing"

    "go.uber.org/mock/gomock"

    "github.com/supporttools/myapp/internal/repository/mocks"
    "github.com/supporttools/myapp/internal/service"
)

func TestUserService_GetUser(t *testing.T) {
    ctrl := gomock.NewController(t)
    defer ctrl.Finish()

    mockRepo := mocks.NewMockUserRepository(ctrl)
    mockCache := mocks.NewMockCache(ctrl)

    // Set expectations
    expectedUser := &User{ID: 1, Name: "Alice", Email: "alice@example.com"}

    // Cache miss
    mockCache.EXPECT().
        Get(gomock.Any(), "user:1").
        Return(nil, cache.ErrNotFound)

    // DB fetch
    mockRepo.EXPECT().
        FindByID(gomock.Any(), int64(1)).
        Return(expectedUser, nil)

    // Cache write
    mockCache.EXPECT().
        Set(gomock.Any(), "user:1", gomock.Any(), 5*time.Minute).
        Return(nil)

    svc := service.NewUserService(mockRepo, mockCache)
    user, err := svc.GetUser(context.Background(), 1)
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if user.Email != "alice@example.com" {
        t.Errorf("expected alice@example.com, got %s", user.Email)
    }
}
```

## Section 6: Using analysis/passes for Custom Linters

```go
// cmd/mychecker/main.go
// A custom linter that checks for common patterns

package main

import (
    "go/ast"
    "go/types"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/multichecker"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

var Analyzer = &analysis.Analyzer{
    Name:     "errwrap",
    Doc:      "check that errors from external packages are wrapped",
    Requires: []*analysis.Analyzer{inspect.Analyzer},
    Run:      run,
}

func run(pass *analysis.Pass) (interface{}, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    nodeFilter := []ast.Node{
        (*ast.ReturnStmt)(nil),
    }

    insp.Preorder(nodeFilter, func(n ast.Node) {
        ret := n.(*ast.ReturnStmt)
        for _, result := range ret.Results {
            call, ok := result.(*ast.CallExpr)
            if !ok {
                continue
            }
            // Check if this is returning an error directly from an external package
            // without wrapping with fmt.Errorf or errors.Wrap
            t := pass.TypesInfo.TypeOf(call)
            if t != nil && types.Implements(t, errorInterface(pass)) {
                if isExternalCall(pass, call) && !isWrapped(pass, call) {
                    pass.Reportf(call.Pos(),
                        "error from external package should be wrapped with %%w")
                }
            }
        }
    })

    return nil, nil
}

func errorInterface(pass *analysis.Pass) *types.Interface {
    obj := types.Universe.Lookup("error")
    return obj.Type().Underlying().(*types.Interface)
}

func isExternalCall(pass *analysis.Pass, call *ast.CallExpr) bool {
    sel, ok := call.Fun.(*ast.SelectorExpr)
    if !ok {
        return false
    }
    pkg, ok := pass.TypesInfo.ObjectOf(sel.Sel).(*types.Func)
    if !ok {
        return false
    }
    return pkg.Pkg().Path() != pass.Pkg.Path()
}

func isWrapped(pass *analysis.Pass, call *ast.CallExpr) bool {
    // Check if the call is fmt.Errorf with %w or errors.Wrap/errors.Wrapf
    sel, ok := call.Fun.(*ast.SelectorExpr)
    if !ok {
        return false
    }
    pkgIdent, ok := sel.X.(*ast.Ident)
    if !ok {
        return false
    }
    pkg := pass.TypesInfo.ObjectOf(pkgIdent)
    if pkg == nil {
        return false
    }
    pkgPath := ""
    if pkgName, ok := pkg.(*types.PkgName); ok {
        pkgPath = pkgName.Imported().Path()
    }
    return (pkgPath == "fmt" && sel.Sel.Name == "Errorf") ||
        (pkgPath == "github.com/pkg/errors" && (sel.Sel.Name == "Wrap" || sel.Sel.Name == "Wrapf"))
}

func main() {
    multichecker.Main(Analyzer)
}
```

## Conclusion

Reflection and code generation occupy complementary niches in Go engineering:

- **Use `reflect`** for generic serialization (JSON, protobuf, database scanning), dependency injection containers, testing utilities, and other runtime dynamic behavior. Cache reflection results to minimize the ~45ns per field access overhead.

- **Use `go generate`** with `stringer`, `mockgen`, and custom generators to eliminate repetitive boilerplate that would otherwise diverge from the interfaces they implement. The generated code is fast, type-safe, and doesn't require runtime reflection.

- **Use `text/template`** for code generators that need to produce idiomatic Go from a data model (struct → repository, interface → mock, schema → types).

- **Use `go/ast`** for code analysis tools, linters, and sophisticated generators that need to parse and understand Go source structure. The `golang.org/x/tools/go/analysis` framework provides a structured way to build production-quality analysis passes.

The key design principle: if you can generate the code at compile time (via `go generate`), do that instead of using reflection at runtime. Generated code is faster, easier to debug, and immediately visible to the compiler for type checking.
