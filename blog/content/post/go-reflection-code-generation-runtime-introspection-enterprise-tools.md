---
title: "Go Reflection and Code Generation: Runtime Introspection for Enterprise Tools"
date: 2030-11-22T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Reflection", "Code Generation", "go:generate", "Templates", "ORM", "Serialization"]
categories:
- Go
- Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go's reflect package, struct tag parsing, code generation with go:generate and text/template, and practical patterns for building ORMs, serialization libraries, and enterprise tooling with runtime introspection."
more_link: "yes"
url: "/go-reflection-code-generation-runtime-introspection-enterprise-tools/"
---

Go's static type system is one of its greatest strengths, but many real-world enterprise tools require dynamic behavior: serializing arbitrary structs to JSON without pre-defined marshaling logic, mapping database rows to structs with configurable column names, generating boilerplate code from annotations, or validating configuration structs at startup. The `reflect` package and `go:generate` tooling address these needs, but both come with significant complexity and performance implications that require careful engineering.

This guide covers the `reflect` package in depth, struct tag parsing conventions, code generation with `text/template`, practical patterns for building ORM-style mappers and serialization libraries, and production considerations for performance-critical paths.

<!--more-->

# Go Reflection and Code Generation: Runtime Introspection for Enterprise Tools

## Section 1: The reflect Package Fundamentals

Go's `reflect` package provides runtime type introspection. Every value in Go has both a type and a kind. Understanding this distinction is critical:

- **Type**: The named type as declared (e.g., `MyStruct`, `time.Time`, `[]byte`)
- **Kind**: The underlying category (e.g., `reflect.Struct`, `reflect.Slice`, `reflect.Ptr`)

```go
package main

import (
    "fmt"
    "reflect"
    "time"
)

type User struct {
    ID        int64     `db:"id" json:"id"`
    Name      string    `db:"name" json:"name"`
    Email     string    `db:"email" json:"email,omitempty"`
    CreatedAt time.Time `db:"created_at" json:"created_at"`
    internal  string    // unexported - not accessible via reflect
}

func inspectType(v interface{}) {
    t := reflect.TypeOf(v)
    val := reflect.ValueOf(v)

    fmt.Printf("Type: %v\n", t)
    fmt.Printf("Kind: %v\n", t.Kind())

    // Dereference pointer if necessary
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
        val = val.Elem()
        fmt.Printf("Dereferenced Type: %v\n", t)
        fmt.Printf("Dereferenced Kind: %v\n", t.Kind())
    }

    if t.Kind() != reflect.Struct {
        fmt.Printf("Value: %v\n", val.Interface())
        return
    }

    fmt.Printf("\nStruct fields (%d):\n", t.NumField())
    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        fieldVal := val.Field(i)

        // Unexported fields are not accessible
        if !field.IsExported() {
            fmt.Printf("  [unexported] %s\n", field.Name)
            continue
        }

        fmt.Printf("  %s (%v) = %v\n",
            field.Name,
            field.Type,
            fieldVal.Interface(),
        )

        // Print struct tags
        if tag := field.Tag; tag != "" {
            fmt.Printf("    Tags: db=%q json=%q\n",
                tag.Get("db"),
                tag.Get("json"),
            )
        }
    }
}

func main() {
    u := User{
        ID:    1,
        Name:  "Alice",
        Email: "alice@example.com",
    }
    inspectType(u)
    inspectType(&u) // pointer form
}
```

### Type vs. Value Operations

Reflect operations split into two categories:

```go
// Type operations - work on reflect.Type, no allocation
t := reflect.TypeOf((*User)(nil)).Elem() // get type without a value
fmt.Println(t.Name())          // "User"
fmt.Println(t.PkgPath())       // "main"
fmt.Println(t.NumField())      // 5
fmt.Println(t.Field(0).Name)   // "ID"

// Value operations - work on reflect.Value, may require allocation
u := User{ID: 42, Name: "Bob"}
v := reflect.ValueOf(&u).Elem() // get addressable value

// Setting values requires addressable Value
v.Field(0).SetInt(100)       // sets ID to 100
v.Field(1).SetString("Carol") // sets Name to "Carol"

fmt.Printf("Modified: %+v\n", u)
// Modified: {ID:100 Name:Carol Email: CreatedAt:0001-01-01 00:00:00 +0000 UTC internal:}
```

## Section 2: Struct Tag Parsing

Struct tags are the primary mechanism for annotating Go structs with metadata. The `reflect` package provides `StructTag.Get()` for reading them, but robust tag parsing requires handling edge cases.

### Tag Format Specification

The canonical format is: `key:"value"` with space-separated key-value pairs:

```go
type Record struct {
    // Simple tag
    ID int `db:"id"`

    // Multiple options (comma-separated values)
    Name string `json:"name,omitempty" db:"user_name,varchar(255)"`

    // Boolean flag pattern (empty value means true)
    ReadOnly bool `db:"-" validate:"required"`

    // Nested key-value in value
    Config string `env:"APP_CONFIG,default=production,required"`
}
```

### Robust Tag Parser

```go
package tagparser

import (
    "strings"
)

// TagOptions represents the parsed options within a single tag value
type TagOptions struct {
    Name    string
    Options map[string]string
    Flags   []string
}

// ParseTag parses a struct tag value like "name,omitempty" or "name,key=value,flag"
func ParseTag(tag string) TagOptions {
    opts := TagOptions{
        Options: make(map[string]string),
    }

    if tag == "" || tag == "-" {
        opts.Name = tag
        return opts
    }

    parts := strings.Split(tag, ",")
    opts.Name = parts[0]

    for _, part := range parts[1:] {
        part = strings.TrimSpace(part)
        if idx := strings.IndexByte(part, '='); idx >= 0 {
            key := part[:idx]
            val := part[idx+1:]
            opts.Options[key] = val
        } else if part != "" {
            opts.Flags = append(opts.Flags, part)
        }
    }

    return opts
}

// HasFlag returns true if the given flag is present
func (t TagOptions) HasFlag(flag string) bool {
    for _, f := range t.Flags {
        if f == flag {
            return true
        }
    }
    return false
}

// GetOption returns the value for a key, or the default if not present
func (t TagOptions) GetOption(key, defaultVal string) string {
    if v, ok := t.Options[key]; ok {
        return v
    }
    return defaultVal
}
```

### Struct Tag Registry Pattern

Production code benefits from caching parsed tag metadata to avoid repeated reflection calls:

```go
package mapper

import (
    "fmt"
    "reflect"
    "sync"
)

// FieldInfo holds pre-parsed metadata for a struct field
type FieldInfo struct {
    Index      int
    Name       string
    ColumnName string
    Type       reflect.Type
    Omitempty  bool
    Nullable   bool
    PrimaryKey bool
    Immutable  bool
}

// StructInfo holds pre-parsed metadata for a struct
type StructInfo struct {
    Type       reflect.Type
    Fields     []FieldInfo
    ByColumn   map[string]*FieldInfo
    ByGoName   map[string]*FieldInfo
    PrimaryKey *FieldInfo
}

// Registry caches struct metadata to avoid repeated reflection
type Registry struct {
    mu    sync.RWMutex
    cache map[reflect.Type]*StructInfo
}

var globalRegistry = &Registry{
    cache: make(map[reflect.Type]*StructInfo),
}

// GetStructInfo returns cached struct metadata, computing it if necessary
func GetStructInfo(t reflect.Type) (*StructInfo, error) {
    // Dereference pointer types
    for t.Kind() == reflect.Ptr {
        t = t.Elem()
    }

    if t.Kind() != reflect.Struct {
        return nil, fmt.Errorf("expected struct, got %v", t.Kind())
    }

    // Fast path: read lock
    globalRegistry.mu.RLock()
    if info, ok := globalRegistry.cache[t]; ok {
        globalRegistry.mu.RUnlock()
        return info, nil
    }
    globalRegistry.mu.RUnlock()

    // Slow path: compute and cache
    globalRegistry.mu.Lock()
    defer globalRegistry.mu.Unlock()

    // Double-check after acquiring write lock
    if info, ok := globalRegistry.cache[t]; ok {
        return info, nil
    }

    info, err := computeStructInfo(t)
    if err != nil {
        return nil, err
    }

    globalRegistry.cache[t] = info
    return info, nil
}

func computeStructInfo(t reflect.Type) (*StructInfo, error) {
    info := &StructInfo{
        Type:     t,
        ByColumn: make(map[string]*FieldInfo),
        ByGoName: make(map[string]*FieldInfo),
    }

    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)

        // Skip unexported fields
        if !field.IsExported() {
            continue
        }

        dbTag := field.Tag.Get("db")

        // Skip explicitly excluded fields
        if dbTag == "-" {
            continue
        }

        fi := FieldInfo{
            Index:  i,
            Name:   field.Name,
            Type:   field.Type,
        }

        // Parse db tag
        if dbTag != "" {
            opts := ParseTag(dbTag)
            if opts.Name != "" {
                fi.ColumnName = opts.Name
            } else {
                fi.ColumnName = toSnakeCase(field.Name)
            }
            fi.Omitempty = opts.HasFlag("omitempty")
            fi.Nullable = opts.HasFlag("nullable")
            fi.PrimaryKey = opts.HasFlag("pk")
            fi.Immutable = opts.HasFlag("immutable")
        } else {
            fi.ColumnName = toSnakeCase(field.Name)
        }

        info.Fields = append(info.Fields, fi)
        fieldPtr := &info.Fields[len(info.Fields)-1]
        info.ByColumn[fi.ColumnName] = fieldPtr
        info.ByGoName[fi.Name] = fieldPtr

        if fi.PrimaryKey && info.PrimaryKey == nil {
            info.PrimaryKey = fieldPtr
        }
    }

    return info, nil
}

// toSnakeCase converts "CamelCase" to "snake_case"
func toSnakeCase(s string) string {
    var result []rune
    for i, r := range s {
        if i > 0 && r >= 'A' && r <= 'Z' {
            result = append(result, '_')
        }
        if r >= 'A' && r <= 'Z' {
            result = append(result, r+32)
        } else {
            result = append(result, r)
        }
    }
    return string(result)
}
```

## Section 3: Building an ORM-Style Mapper with Reflection

With the registry in place, we can build a type-safe mapper that translates between database rows and Go structs:

```go
package mapper

import (
    "database/sql"
    "fmt"
    "reflect"
)

// Mapper handles struct-to-database mapping
type Mapper struct {
    registry *Registry
}

// ScanRow scans a sql.Rows result into a struct, using db tags for column mapping
func ScanRow(rows *sql.Rows, dest interface{}) error {
    destVal := reflect.ValueOf(dest)
    if destVal.Kind() != reflect.Ptr || destVal.IsNil() {
        return fmt.Errorf("dest must be a non-nil pointer to a struct")
    }
    destVal = destVal.Elem()

    destType := destVal.Type()
    info, err := GetStructInfo(destType)
    if err != nil {
        return fmt.Errorf("get struct info: %w", err)
    }

    // Get column names from result set
    columns, err := rows.Columns()
    if err != nil {
        return fmt.Errorf("get columns: %w", err)
    }

    // Build slice of pointers for scanning
    scanTargets := make([]interface{}, len(columns))
    for i, col := range columns {
        fi, ok := info.ByColumn[col]
        if !ok {
            // Column has no matching field - use a discard sink
            var discard interface{}
            scanTargets[i] = &discard
            continue
        }

        fieldVal := destVal.Field(fi.Index)
        if !fieldVal.CanAddr() {
            return fmt.Errorf("field %s is not addressable", fi.Name)
        }
        scanTargets[i] = fieldVal.Addr().Interface()
    }

    return rows.Scan(scanTargets...)
}

// ScanAll scans all rows into a slice of structs
func ScanAll[T any](rows *sql.Rows) ([]T, error) {
    var results []T

    for rows.Next() {
        var item T
        if err := ScanRow(rows, &item); err != nil {
            return nil, fmt.Errorf("scan row: %w", err)
        }
        results = append(results, item)
    }

    return results, rows.Err()
}

// BuildInsert generates an INSERT statement and argument list from a struct
func BuildInsert(tableName string, src interface{}) (string, []interface{}, error) {
    srcVal := reflect.ValueOf(src)
    if srcVal.Kind() == reflect.Ptr {
        srcVal = srcVal.Elem()
    }

    info, err := GetStructInfo(srcVal.Type())
    if err != nil {
        return "", nil, err
    }

    var (
        columns []string
        placeholders []string
        args    []interface{}
        idx     = 1
    )

    for _, fi := range info.Fields {
        // Skip primary key (auto-generated) and immutable fields
        if fi.PrimaryKey || fi.Immutable {
            continue
        }

        fieldVal := srcVal.Field(fi.Index)

        // Handle omitempty
        if fi.Omitempty && isZero(fieldVal) {
            continue
        }

        columns = append(columns, fi.ColumnName)
        placeholders = append(placeholders, fmt.Sprintf("$%d", idx))
        args = append(args, fieldVal.Interface())
        idx++
    }

    if len(columns) == 0 {
        return "", nil, fmt.Errorf("no insertable columns found")
    }

    query := fmt.Sprintf(
        "INSERT INTO %s (%s) VALUES (%s)",
        tableName,
        joinStrings(columns, ", "),
        joinStrings(placeholders, ", "),
    )

    return query, args, nil
}

func isZero(v reflect.Value) bool {
    switch v.Kind() {
    case reflect.Array, reflect.Map, reflect.Slice, reflect.String:
        return v.Len() == 0
    case reflect.Bool:
        return !v.Bool()
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        return v.Int() == 0
    case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
        return v.Uint() == 0
    case reflect.Float32, reflect.Float64:
        return v.Float() == 0
    case reflect.Interface, reflect.Ptr:
        return v.IsNil()
    }
    return false
}

func joinStrings(ss []string, sep string) string {
    result := ""
    for i, s := range ss {
        if i > 0 {
            result += sep
        }
        result += s
    }
    return result
}
```

## Section 4: Code Generation with go:generate

While reflection provides runtime flexibility, code generation offers compile-time safety and zero runtime overhead. The `go:generate` directive triggers external commands during `go generate`.

### Project Structure for Code Generation

```
myproject/
├── cmd/
│   └── gen/
│       └── main.go          # The code generator binary
├── internal/
│   └── models/
│       ├── user.go          # Source structs with annotations
│       └── user_gen.go      # Generated code (git-tracked)
├── tools.go                 # Tool imports for go modules
└── Makefile
```

```go
// tools.go - Pin tool versions in go.mod
//go:build tools

package tools

import (
    _ "golang.org/x/tools/cmd/stringer"
    _ "github.com/jmattheis/goverter/cmd/goverter"
)
```

```go
// internal/models/user.go
package models

import "time"

//go:generate go run ../../cmd/gen/main.go -type=User -output=user_gen.go
//go:generate go run ../../cmd/gen/main.go -type=Product -output=product_gen.go

// User represents an application user
// gen:table users
// gen:cache 5m
type User struct {
    ID        int64     `db:"id,pk"          json:"id"`
    Name      string    `db:"name"            json:"name"           validate:"required,min=1,max=255"`
    Email     string    `db:"email"           json:"email"          validate:"required,email"`
    Role      string    `db:"role"            json:"role"           validate:"oneof=admin user guest"`
    Active    bool      `db:"active"          json:"active"`
    CreatedAt time.Time `db:"created_at,immutable" json:"created_at"`
    UpdatedAt time.Time `db:"updated_at"      json:"updated_at"`
}
```

### The Code Generator

```go
// cmd/gen/main.go
package main

import (
    "bytes"
    "flag"
    "fmt"
    "go/ast"
    "go/parser"
    "go/token"
    "os"
    "strings"
    "text/template"
    "time"
    "unicode"
)

type FieldMeta struct {
    Name       string
    GoType     string
    ColumnName string
    JSONName   string
    PrimaryKey bool
    Immutable  bool
    Omitempty  bool
    Required   bool
}

type StructMeta struct {
    PackageName string
    TypeName    string
    TableName   string
    Fields      []FieldMeta
    Generated   time.Time
}

var (
    typeName   = flag.String("type", "", "struct type name to generate for")
    outputFile = flag.String("output", "", "output file name")
    inputFile  = flag.String("input", "", "input Go source file (defaults to env GOFILE)")
)

func main() {
    flag.Parse()

    if *typeName == "" {
        fmt.Fprintln(os.Stderr, "error: -type is required")
        os.Exit(1)
    }

    // When invoked via go:generate, GOFILE is set automatically
    srcFile := *inputFile
    if srcFile == "" {
        srcFile = os.Getenv("GOFILE")
    }
    if srcFile == "" {
        fmt.Fprintln(os.Stderr, "error: -input is required or run via go:generate")
        os.Exit(1)
    }

    meta, err := parseStruct(srcFile, *typeName)
    if err != nil {
        fmt.Fprintf(os.Stderr, "parse struct: %v\n", err)
        os.Exit(1)
    }

    out, err := generate(meta)
    if err != nil {
        fmt.Fprintf(os.Stderr, "generate: %v\n", err)
        os.Exit(1)
    }

    outPath := *outputFile
    if outPath == "" {
        outPath = strings.ToLower(*typeName) + "_gen.go"
    }

    if err := os.WriteFile(outPath, out, 0644); err != nil {
        fmt.Fprintf(os.Stderr, "write output: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("Generated %s for %s\n", outPath, *typeName)
}

func parseStruct(filename, typeName string) (*StructMeta, error) {
    fset := token.NewFileSet()
    f, err := parser.ParseFile(fset, filename, nil, parser.ParseComments)
    if err != nil {
        return nil, fmt.Errorf("parse file: %w", err)
    }

    meta := &StructMeta{
        PackageName: f.Name.Name,
        TypeName:    typeName,
        TableName:   toSnakeCase(typeName) + "s",
        Generated:   time.Now().UTC(),
    }

    // Look for the struct declaration
    for _, decl := range f.Decls {
        genDecl, ok := decl.(*ast.GenDecl)
        if !ok {
            continue
        }

        // Check for gen: comments above the type
        if genDecl.Doc != nil {
            for _, comment := range genDecl.Doc.List {
                text := strings.TrimPrefix(comment.Text, "//")
                text = strings.TrimSpace(text)
                if strings.HasPrefix(text, "gen:table ") {
                    meta.TableName = strings.TrimPrefix(text, "gen:table ")
                }
            }
        }

        for _, spec := range genDecl.Specs {
            typeSpec, ok := spec.(*ast.TypeSpec)
            if !ok || typeSpec.Name.Name != typeName {
                continue
            }

            structType, ok := typeSpec.Type.(*ast.StructType)
            if !ok {
                return nil, fmt.Errorf("%s is not a struct", typeName)
            }

            for _, field := range structType.Fields.List {
                if len(field.Names) == 0 {
                    continue // embedded field
                }

                fieldName := field.Names[0].Name
                if !unicode.IsUpper(rune(fieldName[0])) {
                    continue // unexported
                }

                fm := FieldMeta{
                    Name:       fieldName,
                    GoType:     exprToString(field.Type),
                    ColumnName: toSnakeCase(fieldName),
                    JSONName:   strings.ToLower(fieldName[:1]) + fieldName[1:],
                }

                // Parse struct tags
                if field.Tag != nil {
                    tagStr := strings.Trim(field.Tag.Value, "`")
                    dbTag := extractTag(tagStr, "db")
                    jsonTag := extractTag(tagStr, "json")
                    validateTag := extractTag(tagStr, "validate")

                    if dbTag != "" && dbTag != "-" {
                        parts := strings.Split(dbTag, ",")
                        fm.ColumnName = parts[0]
                        for _, opt := range parts[1:] {
                            switch opt {
                            case "pk":
                                fm.PrimaryKey = true
                            case "immutable":
                                fm.Immutable = true
                            case "omitempty":
                                fm.Omitempty = true
                            }
                        }
                    }

                    if jsonTag != "" && jsonTag != "-" {
                        parts := strings.Split(jsonTag, ",")
                        fm.JSONName = parts[0]
                    }

                    if strings.Contains(validateTag, "required") {
                        fm.Required = true
                    }
                }

                meta.Fields = append(meta.Fields, fm)
            }
        }
    }

    if len(meta.Fields) == 0 {
        return nil, fmt.Errorf("struct %s not found or has no exported fields", typeName)
    }

    return meta, nil
}

func exprToString(expr ast.Expr) string {
    switch e := expr.(type) {
    case *ast.Ident:
        return e.Name
    case *ast.SelectorExpr:
        return exprToString(e.X) + "." + e.Sel.Name
    case *ast.StarExpr:
        return "*" + exprToString(e.X)
    case *ast.ArrayType:
        return "[]" + exprToString(e.Elt)
    default:
        return "interface{}"
    }
}

func extractTag(tagStr, key string) string {
    prefix := key + `:"`
    idx := strings.Index(tagStr, prefix)
    if idx < 0 {
        return ""
    }
    rest := tagStr[idx+len(prefix):]
    end := strings.Index(rest, `"`)
    if end < 0 {
        return ""
    }
    return rest[:end]
}

func toSnakeCase(s string) string {
    var result []byte
    for i := 0; i < len(s); i++ {
        c := s[i]
        if c >= 'A' && c <= 'Z' {
            if i > 0 {
                result = append(result, '_')
            }
            result = append(result, c+32)
        } else {
            result = append(result, c)
        }
    }
    return string(result)
}

const codeTemplate = `// Code generated by gen. DO NOT EDIT.
// Generated at: {{ .Generated.Format "2006-01-02T15:04:05Z" }}
// Source type: {{ .TypeName }}

package {{ .PackageName }}

import (
    "database/sql"
    "fmt"
    "strings"
)

// {{ .TypeName }}Columns lists all database column names for {{ .TypeName }}
var {{ .TypeName }}Columns = []string{
{{ range .Fields }}    "{{ .ColumnName }}",
{{ end -}}
}

// {{ .TypeName }}TableName is the database table for {{ .TypeName }}
const {{ .TypeName }}TableName = "{{ .TableName }}"

// Scan{{ .TypeName }} scans a database row into a {{ .TypeName }} struct
func Scan{{ .TypeName }}(row *sql.Row) (*{{ .TypeName }}, error) {
    var m {{ .TypeName }}
    err := row.Scan(
{{ range .Fields }}        &m.{{ .Name }},
{{ end -}}
    )
    if err != nil {
        return nil, fmt.Errorf("scan {{ .TypeName }}: %w", err)
    }
    return &m, nil
}

// Scan{{ .TypeName }}Rows scans multiple rows into a slice of {{ .TypeName }}
func Scan{{ .TypeName }}Rows(rows *sql.Rows) ([]*{{ .TypeName }}, error) {
    var results []*{{ .TypeName }}
    for rows.Next() {
        var m {{ .TypeName }}
        err := rows.Scan(
{{ range .Fields }}            &m.{{ .Name }},
{{ end -}}
        )
        if err != nil {
            return nil, fmt.Errorf("scan {{ .TypeName }} row: %w", err)
        }
        results = append(results, &m)
    }
    return results, rows.Err()
}

// {{ .TypeName }}InsertSQL returns an INSERT SQL statement for {{ .TypeName }}
func {{ .TypeName }}InsertSQL() string {
    cols := []string{
{{ range .Fields }}{{ if not .PrimaryKey }}{{ if not .Immutable }}        "{{ .ColumnName }}",
{{ end }}{{ end }}{{ end -}}
    }
    placeholders := make([]string, len(cols))
    for i := range cols {
        placeholders[i] = fmt.Sprintf("$%d", i+1)
    }
    return fmt.Sprintf(
        "INSERT INTO {{ .TableName }} (%s) VALUES (%s) RETURNING id",
        strings.Join(cols, ", "),
        strings.Join(placeholders, ", "),
    )
}

// {{ .TypeName }}InsertArgs returns the argument list for an INSERT of {{ .TypeName }}
func {{ .TypeName }}InsertArgs(m *{{ .TypeName }}) []interface{} {
    return []interface{}{
{{ range .Fields }}{{ if not .PrimaryKey }}{{ if not .Immutable }}        m.{{ .Name }},
{{ end }}{{ end }}{{ end -}}
    }
}
`

func generate(meta *StructMeta) ([]byte, error) {
    // Add template function to negate bool
    funcMap := template.FuncMap{
        "not": func(b bool) bool { return !b },
    }

    tmpl, err := template.New("code").Funcs(funcMap).Parse(codeTemplate)
    if err != nil {
        return nil, fmt.Errorf("parse template: %w", err)
    }

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, meta); err != nil {
        return nil, fmt.Errorf("execute template: %w", err)
    }

    return buf.Bytes(), nil
}
```

## Section 5: Advanced Reflection Patterns

### Deep Copy with Reflection

```go
package deepcopy

import (
    "reflect"
    "time"
)

// Copy creates a deep copy of src, supporting structs, slices, maps, and pointers
func Copy[T any](src T) T {
    srcVal := reflect.ValueOf(src)
    copied := deepCopy(srcVal)
    return copied.Interface().(T)
}

func deepCopy(src reflect.Value) reflect.Value {
    switch src.Kind() {
    case reflect.Ptr:
        if src.IsNil() {
            return reflect.Zero(src.Type())
        }
        dst := reflect.New(src.Type().Elem())
        dst.Elem().Set(deepCopy(src.Elem()))
        return dst

    case reflect.Interface:
        if src.IsNil() {
            return reflect.Zero(src.Type())
        }
        dst := reflect.New(src.Type()).Elem()
        dst.Set(deepCopy(src.Elem()))
        return dst

    case reflect.Struct:
        // Special case for time.Time - it's a struct but should be copied by value
        if src.Type() == reflect.TypeOf(time.Time{}) {
            dst := reflect.New(src.Type()).Elem()
            dst.Set(src)
            return dst
        }

        dst := reflect.New(src.Type()).Elem()
        for i := 0; i < src.NumField(); i++ {
            if !src.Type().Field(i).IsExported() {
                continue
            }
            dst.Field(i).Set(deepCopy(src.Field(i)))
        }
        return dst

    case reflect.Slice:
        if src.IsNil() {
            return reflect.Zero(src.Type())
        }
        dst := reflect.MakeSlice(src.Type(), src.Len(), src.Cap())
        for i := 0; i < src.Len(); i++ {
            dst.Index(i).Set(deepCopy(src.Index(i)))
        }
        return dst

    case reflect.Map:
        if src.IsNil() {
            return reflect.Zero(src.Type())
        }
        dst := reflect.MakeMapWithSize(src.Type(), src.Len())
        for _, key := range src.MapKeys() {
            dst.SetMapIndex(deepCopy(key), deepCopy(src.MapIndex(key)))
        }
        return dst

    default:
        // Primitive types, no deep copy needed
        dst := reflect.New(src.Type()).Elem()
        dst.Set(src)
        return dst
    }
}
```

### Struct Validator with Reflection

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
    Tag     string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("field %s: %s", e.Field, e.Message)
}

type ValidationErrors []ValidationError

func (e ValidationErrors) Error() string {
    msgs := make([]string, len(e))
    for i, err := range e {
        msgs[i] = err.Error()
    }
    return strings.Join(msgs, "; ")
}

var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

// Validate validates a struct using "validate" struct tags
func Validate(s interface{}) error {
    val := reflect.ValueOf(s)
    for val.Kind() == reflect.Ptr {
        if val.IsNil() {
            return fmt.Errorf("nil pointer")
        }
        val = val.Elem()
    }

    if val.Kind() != reflect.Struct {
        return fmt.Errorf("expected struct, got %v", val.Kind())
    }

    t := val.Type()
    var errs ValidationErrors

    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        if !field.IsExported() {
            continue
        }

        validateTag := field.Tag.Get("validate")
        if validateTag == "" {
            continue
        }

        fieldVal := val.Field(i)
        fieldErrs := validateField(field.Name, fieldVal, validateTag)
        errs = append(errs, fieldErrs...)
    }

    if len(errs) > 0 {
        return errs
    }
    return nil
}

func validateField(name string, val reflect.Value, tag string) []ValidationError {
    var errs []ValidationError
    rules := strings.Split(tag, ",")

    for _, rule := range rules {
        rule = strings.TrimSpace(rule)
        if rule == "" {
            continue
        }

        var (
            key   string
            param string
        )

        if idx := strings.IndexByte(rule, '='); idx >= 0 {
            key = rule[:idx]
            param = rule[idx+1:]
        } else {
            key = rule
        }

        var err *ValidationError
        switch key {
        case "required":
            if isZeroValue(val) {
                err = &ValidationError{Field: name, Tag: "required", Message: "is required"}
            }
        case "min":
            if n, e := strconv.ParseFloat(param, 64); e == nil {
                if err2 := validateMin(name, val, n); err2 != nil {
                    errs = append(errs, *err2)
                }
            }
        case "max":
            if n, e := strconv.ParseFloat(param, 64); e == nil {
                if err2 := validateMax(name, val, n); err2 != nil {
                    errs = append(errs, *err2)
                }
            }
        case "email":
            if val.Kind() == reflect.String && !emailRegex.MatchString(val.String()) {
                err = &ValidationError{Field: name, Tag: "email", Message: "must be a valid email address"}
            }
        case "oneof":
            opts := strings.Split(param, " ")
            if !isOneOf(val, opts) {
                err = &ValidationError{
                    Field:   name,
                    Tag:     "oneof",
                    Message: fmt.Sprintf("must be one of: %s", strings.Join(opts, ", ")),
                }
            }
        }

        if err != nil {
            errs = append(errs, *err)
        }
    }

    return errs
}

func isZeroValue(v reflect.Value) bool {
    return v.IsZero()
}

func validateMin(name string, val reflect.Value, min float64) *ValidationError {
    switch val.Kind() {
    case reflect.String:
        if float64(val.Len()) < min {
            return &ValidationError{Field: name, Tag: "min",
                Message: fmt.Sprintf("length must be >= %g", min)}
        }
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        if float64(val.Int()) < min {
            return &ValidationError{Field: name, Tag: "min",
                Message: fmt.Sprintf("must be >= %g", min)}
        }
    case reflect.Float32, reflect.Float64:
        if val.Float() < min {
            return &ValidationError{Field: name, Tag: "min",
                Message: fmt.Sprintf("must be >= %g", min)}
        }
    }
    return nil
}

func validateMax(name string, val reflect.Value, max float64) *ValidationError {
    switch val.Kind() {
    case reflect.String:
        if float64(val.Len()) > max {
            return &ValidationError{Field: name, Tag: "max",
                Message: fmt.Sprintf("length must be <= %g", max)}
        }
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        if float64(val.Int()) > max {
            return &ValidationError{Field: name, Tag: "max",
                Message: fmt.Sprintf("must be <= %g", max)}
        }
    }
    return nil
}

func isOneOf(val reflect.Value, options []string) bool {
    str := fmt.Sprintf("%v", val.Interface())
    for _, opt := range options {
        if str == opt {
            return true
        }
    }
    return false
}
```

## Section 6: Performance Considerations

Reflection has measurable overhead. The following benchmarks illustrate the cost:

```go
package benchmark

import (
    "reflect"
    "testing"
)

type BenchStruct struct {
    ID    int64
    Name  string
    Value float64
}

// Direct field access - baseline
func BenchmarkDirectAccess(b *testing.B) {
    s := BenchStruct{ID: 1, Name: "test", Value: 3.14}
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = s.ID
        _ = s.Name
        _ = s.Value
    }
}

// reflect.ValueOf each time - worst case
func BenchmarkReflectUncached(b *testing.B) {
    s := BenchStruct{ID: 1, Name: "test", Value: 3.14}
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        v := reflect.ValueOf(s)
        _ = v.Field(0).Int()
        _ = v.Field(1).String()
        _ = v.Field(2).Float()
    }
}

// Cached reflect.Type, only reflect.ValueOf at call site
func BenchmarkReflectCachedType(b *testing.B) {
    s := BenchStruct{ID: 1, Name: "test", Value: 3.14}
    // Pre-cache the type info
    t := reflect.TypeOf(s)
    _ = t // would be stored in a global cache
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        v := reflect.ValueOf(s)
        _ = v.Field(0).Int()
        _ = v.Field(1).String()
        _ = v.Field(2).Float()
    }
}

/*
Typical results:
BenchmarkDirectAccess        1000000000    0.29 ns/op
BenchmarkReflectUncached       10000000   150.00 ns/op
BenchmarkReflectCachedType     20000000    75.00 ns/op

Reflection is ~250-500x slower than direct access for simple field reads.
For hot paths, prefer code generation over runtime reflection.
*/
```

### When to Use Reflection vs. Code Generation

| Scenario | Reflection | Code Generation |
|----------|------------|-----------------|
| Library used by external packages | Good (no codegen step) | Better (zero overhead) |
| Hot path (>1M calls/sec) | Avoid | Preferred |
| Schema unknown at compile time | Required | Not possible |
| CI/CD integration required | Simple | Needs codegen step |
| Type safety | Partial | Full |
| Debug-friendly | Hard | Easy |

## Section 7: The stringer Pattern

The most widely used Go code generator is `stringer`, which generates `String()` methods for integer types:

```go
// status.go
package status

//go:generate stringer -type=Status

// Status represents a task lifecycle state
type Status int

const (
    StatusPending  Status = iota // Pending
    StatusRunning                // Running
    StatusComplete               // Complete
    StatusFailed                 // Failed
    StatusCanceled               // Canceled
)
```

Running `go generate ./...` produces:

```go
// status_string.go (generated by stringer)
// Code generated by "stringer -type=Status"; DO NOT EDIT.

package status

import "strconv"

func _() {
    // An "invalid array index" compiler error signifies that the constant values have changed.
    var x [1]struct{}
    _ = x[StatusPending-0]
    _ = x[StatusRunning-1]
    _ = x[StatusComplete-2]
    _ = x[StatusFailed-3]
    _ = x[StatusCanceled-4]
}

const _Status_name = "PendingRunningCompleteFailedCanceled"

var _Status_index = [...]uint8{0, 7, 14, 22, 28, 36}

func (i Status) String() string {
    if i < 0 || i >= Status(len(_Status_index)-1) {
        return "Status(" + strconv.FormatInt(int64(i), 10) + ")"
    }
    return _Status_name[_Status_index[i]:_Status_index[i+1]]
}
```

## Section 8: Integration in Enterprise Pipelines

### Makefile Integration

```makefile
.PHONY: generate test build

generate:
	go generate ./...
	# Verify generated files are up to date in CI
	git diff --exit-code --name-only '*_gen.go' || \
		(echo "Generated files are out of date. Run 'make generate'" && exit 1)

test: generate
	go test ./... -race -count=1

lint: generate
	golangci-lint run

build: generate
	go build ./cmd/...
```

### CI Validation Script

```bash
#!/bin/bash
# scripts/check-generated.sh
# Ensures generated code matches what go generate would produce

set -euo pipefail

echo "Running go generate..."
go generate ./...

echo "Checking for uncommitted changes in generated files..."
CHANGED=$(git diff --name-only -- '*_gen.go' 'zz_*.go')
if [[ -n "$CHANGED" ]]; then
    echo "ERROR: The following generated files are out of date:"
    echo "$CHANGED"
    echo ""
    echo "Run 'go generate ./...' and commit the results."
    exit 1
fi

echo "All generated files are up to date."
```

## Conclusion

Go's reflection and code generation capabilities form a complementary pair. Use reflection for library code that must handle arbitrary types at runtime — ORMs, serialization, validation frameworks, and dependency injection. Use code generation for application code where performance matters, type safety is valuable, and you can afford a `go generate` step in the build pipeline.

The struct tag system provides a clean, idiomatic mechanism for annotating types with metadata. With a well-designed tag parser and struct registry backed by `sync.RWMutex`, reflection overhead can be reduced to a single `reflect.ValueOf` call at the hot path, with all type analysis amortized across many calls. For anything more performance-sensitive, the code generator approach eliminates reflection entirely while preserving the ergonomic annotation-driven workflow.
