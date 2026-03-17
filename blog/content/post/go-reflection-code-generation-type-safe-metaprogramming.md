---
title: "Go Reflection and Code Generation: Type-Safe Metaprogramming Patterns"
date: 2030-06-24T00:00:00-05:00
draft: false
tags: ["Go", "Reflection", "Code Generation", "Metaprogramming", "Performance", "go/ast"]
categories:
- Go
- Software Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Go reflection: reflect package internals, dynamic struct traversal, type-safe code generation with text/template and go/ast, and when to prefer codegen over runtime reflection for performance."
more_link: "yes"
url: "/go-reflection-code-generation-type-safe-metaprogramming/"
---

Go's static type system eliminates entire classes of runtime errors, but it also creates friction when building generic infrastructure: serialization frameworks, ORM layers, validation engines, and RPC systems all need to inspect and manipulate types they have never seen at compile time. The reflect package provides runtime type introspection at the cost of type safety and performance. Code generation tools like `go generate`, `text/template`, and the `go/ast` package offer a compile-time alternative that preserves type safety while eliminating reflection overhead. Choosing between them — and knowing how to use each correctly — is the mark of an experienced Go engineer building production systems.

<!--more-->

## Reflection Fundamentals

### The Type System Dual Representation

Every value in Go has two runtime representations: a static type known at compile time and a dynamic type stored in the interface value. The reflect package bridges these two worlds.

```go
package main

import (
    "fmt"
    "reflect"
)

type Server struct {
    Host    string `json:"host" validate:"required"`
    Port    int    `json:"port" validate:"min=1,max=65535"`
    TLS     bool   `json:"tls"`
    Timeout int    `json:"timeout,omitempty"`
}

func inspectType(v any) {
    t := reflect.TypeOf(v)
    val := reflect.ValueOf(v)

    // Dereference pointer if needed
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
        val = val.Elem()
    }

    fmt.Printf("Type: %s, Kind: %s\n", t.Name(), t.Kind())

    for i := 0; i < t.NumField(); i++ {
        field := t.Field(i)
        fieldVal := val.Field(i)

        fmt.Printf("  Field: %-12s  Kind: %-8s  Value: %-15v  Tag: %s\n",
            field.Name,
            field.Type.Kind(),
            fieldVal.Interface(),
            field.Tag,
        )
    }
}

func main() {
    s := Server{
        Host:    "api.internal",
        Port:    8443,
        TLS:     true,
        Timeout: 30,
    }
    inspectType(s)
    inspectType(&s) // pointer handled transparently
}
```

### Value Settability

A common source of reflection panics is attempting to set a value that is not addressable. The rule is: only values obtained from exported fields of a pointer to a struct are settable.

```go
func setField(obj any, fieldName string, value any) error {
    v := reflect.ValueOf(obj)
    if v.Kind() != reflect.Ptr {
        return fmt.Errorf("obj must be a pointer, got %s", v.Kind())
    }
    v = v.Elem()
    if v.Kind() != reflect.Struct {
        return fmt.Errorf("obj must point to a struct, got %s", v.Kind())
    }

    field := v.FieldByName(fieldName)
    if !field.IsValid() {
        return fmt.Errorf("field %s not found", fieldName)
    }
    if !field.CanSet() {
        return fmt.Errorf("field %s is not settable (unexported?)", fieldName)
    }

    newVal := reflect.ValueOf(value)
    if field.Type() != newVal.Type() {
        // Attempt conversion for compatible types
        if newVal.Type().ConvertibleTo(field.Type()) {
            newVal = newVal.Convert(field.Type())
        } else {
            return fmt.Errorf("cannot set field %s of type %s with value of type %s",
                fieldName, field.Type(), newVal.Type())
        }
    }

    field.Set(newVal)
    return nil
}
```

## Dynamic Struct Traversal

### Recursive Field Walker

Struct traversal is the foundation of serialization libraries, validators, and configuration loaders. A robust walker must handle embedded structs, pointer indirection, and cycle detection.

```go
package walker

import (
    "fmt"
    "reflect"
    "strings"
)

// FieldVisitor is called for each leaf field in the struct tree.
type FieldVisitor func(path string, field reflect.StructField, value reflect.Value) error

// Walk traverses all exported fields of a struct recursively.
// Anonymous embedded structs are inlined. Named struct fields are descended into.
func Walk(v any, visitor FieldVisitor) error {
    val := reflect.ValueOf(v)
    typ := reflect.TypeOf(v)

    // Dereference pointer
    for val.Kind() == reflect.Ptr {
        if val.IsNil() {
            return nil
        }
        val = val.Elem()
        typ = typ.Elem()
    }

    if val.Kind() != reflect.Struct {
        return fmt.Errorf("Walk requires a struct or pointer to struct, got %s", val.Kind())
    }

    return walkStruct("", typ, val, visitor)
}

func walkStruct(prefix string, typ reflect.Type, val reflect.Value, visitor FieldVisitor) error {
    for i := 0; i < typ.NumField(); i++ {
        field := typ.Field(i)
        fieldVal := val.Field(i)

        // Skip unexported fields
        if !field.IsExported() {
            continue
        }

        path := field.Name
        if prefix != "" {
            path = prefix + "." + field.Name
        }

        // Dereference pointer fields
        fv := fieldVal
        ft := field.Type
        for fv.Kind() == reflect.Ptr {
            if fv.IsNil() {
                break
            }
            fv = fv.Elem()
            ft = ft.Elem()
        }

        // Inline anonymous embedded structs
        if field.Anonymous && fv.Kind() == reflect.Struct {
            if err := walkStruct(prefix, ft, fv, visitor); err != nil {
                return err
            }
            continue
        }

        // Descend into named struct fields
        if fv.Kind() == reflect.Struct {
            if err := walkStruct(path, ft, fv, visitor); err != nil {
                return err
            }
            continue
        }

        // Visit leaf fields
        if err := visitor(path, field, fieldVal); err != nil {
            return err
        }
    }
    return nil
}
```

### Tag-Based Validation Engine

Using the walker above, a validation engine can be built that reads struct tags at runtime:

```go
package validation

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
    return fmt.Sprintf("validation error: field '%s': %s", e.Field, e.Message)
}

type ValidationErrors []ValidationError

func (errs ValidationErrors) Error() string {
    msgs := make([]string, len(errs))
    for i, e := range errs {
        msgs[i] = e.Error()
    }
    return strings.Join(msgs, "; ")
}

func Validate(v any) error {
    var errs ValidationErrors

    err := Walk(v, func(path string, field reflect.StructField, value reflect.Value) error {
        tag := field.Tag.Get("validate")
        if tag == "" {
            return nil
        }

        rules := strings.Split(tag, ",")
        for _, rule := range rules {
            rule = strings.TrimSpace(rule)
            if rule == "" {
                continue
            }

            parts := strings.SplitN(rule, "=", 2)
            ruleName := parts[0]
            ruleArg := ""
            if len(parts) == 2 {
                ruleArg = parts[1]
            }

            if err := applyRule(path, ruleName, ruleArg, field, value); err != nil {
                errs = append(errs, ValidationError{Field: path, Message: err.Error()})
            }
        }
        return nil
    })

    if err != nil {
        return err
    }
    if len(errs) > 0 {
        return errs
    }
    return nil
}

func applyRule(path, rule, arg string, field reflect.StructField, value reflect.Value) error {
    switch rule {
    case "required":
        if isZero(value) {
            return fmt.Errorf("required field is empty")
        }

    case "min":
        n, err := strconv.ParseFloat(arg, 64)
        if err != nil {
            return fmt.Errorf("invalid min rule argument: %s", arg)
        }
        actual := toFloat64(value)
        if actual < n {
            return fmt.Errorf("value %v is less than minimum %v", actual, n)
        }

    case "max":
        n, err := strconv.ParseFloat(arg, 64)
        if err != nil {
            return fmt.Errorf("invalid max rule argument: %s", arg)
        }
        actual := toFloat64(value)
        if actual > n {
            return fmt.Errorf("value %v exceeds maximum %v", actual, n)
        }

    case "len":
        n, err := strconv.Atoi(arg)
        if err != nil {
            return fmt.Errorf("invalid len rule argument: %s", arg)
        }
        if value.Len() != n {
            return fmt.Errorf("length %d does not equal required length %d", value.Len(), n)
        }

    case "email":
        s := value.String()
        if !strings.Contains(s, "@") {
            return fmt.Errorf("value '%s' is not a valid email address", s)
        }
    }
    return nil
}

func isZero(v reflect.Value) bool {
    switch v.Kind() {
    case reflect.String:
        return v.Len() == 0
    case reflect.Bool:
        return !v.Bool()
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
        return v.Int() == 0
    case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
        return v.Uint() == 0
    case reflect.Float32, reflect.Float64:
        return v.Float() == 0
    case reflect.Ptr, reflect.Interface, reflect.Slice, reflect.Map:
        return v.IsNil()
    }
    return false
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

## Reflection Performance Characteristics

### Benchmarking Reflection Overhead

Reflection is significantly slower than direct field access. Understanding the actual cost is essential before deciding to use it in hot paths:

```go
package benchmark

import (
    "reflect"
    "testing"
)

type Config struct {
    Host    string
    Port    int
    Timeout int
}

func BenchmarkDirectAccess(b *testing.B) {
    cfg := Config{Host: "localhost", Port: 8080, Timeout: 30}
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = cfg.Host
        _ = cfg.Port
        _ = cfg.Timeout
    }
}

func BenchmarkReflectionAccess(b *testing.B) {
    cfg := Config{Host: "localhost", Port: 8080, Timeout: 30}
    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        v := reflect.ValueOf(cfg)
        _ = v.FieldByName("Host").String()
        _ = v.FieldByName("Port").Int()
        _ = v.FieldByName("Timeout").Int()
    }
}

func BenchmarkCachedReflection(b *testing.B) {
    cfg := Config{Host: "localhost", Port: 8080, Timeout: 30}
    t := reflect.TypeOf(cfg)
    // Cache field indices at startup
    hostIdx, _ := t.FieldByName("Host")
    portIdx, _ := t.FieldByName("Port")
    timeoutIdx, _ := t.FieldByName("Timeout")
    _ = hostIdx
    _ = portIdx
    _ = timeoutIdx

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        v := reflect.ValueOf(cfg)
        // Use index instead of name lookup
        _ = v.Field(0).String()
        _ = v.Field(1).Int()
        _ = v.Field(2).Int()
    }
}
```

Typical benchmark results on modern hardware:
- `BenchmarkDirectAccess`: ~0.5 ns/op
- `BenchmarkReflectionAccess`: ~150 ns/op (300x slower due to FieldByName hash lookup)
- `BenchmarkCachedReflection`: ~40 ns/op (80x slower, but cached index avoids string lookup)

### Caching Reflection Metadata

Cache type information at program startup rather than computing it on every request:

```go
package mapper

import (
    "fmt"
    "reflect"
    "sync"
)

// FieldMap caches struct field metadata indexed by field name.
type FieldMap struct {
    mu     sync.RWMutex
    cache  map[reflect.Type]map[string]int
}

var globalFieldMap = &FieldMap{
    cache: make(map[reflect.Type]map[string]int),
}

// GetFieldIndex returns the field index for a named field in the given type.
// Results are cached after the first lookup.
func (fm *FieldMap) GetFieldIndex(t reflect.Type, name string) (int, bool) {
    if t.Kind() == reflect.Ptr {
        t = t.Elem()
    }

    fm.mu.RLock()
    if m, ok := fm.cache[t]; ok {
        fm.mu.RUnlock()
        idx, found := m[name]
        return idx, found
    }
    fm.mu.RUnlock()

    fm.mu.Lock()
    defer fm.mu.Unlock()

    // Double-check after acquiring write lock
    if m, ok := fm.cache[t]; ok {
        idx, found := m[name]
        return idx, found
    }

    // Build the field map for this type
    m := make(map[string]int, t.NumField())
    for i := 0; i < t.NumField(); i++ {
        m[t.Field(i).Name] = i
    }
    fm.cache[t] = m

    idx, found := m[name]
    return idx, found
}

// FastGet retrieves a field value using cached index lookup.
func FastGet(v any, fieldName string) (any, error) {
    val := reflect.ValueOf(v)
    typ := val.Type()

    idx, ok := globalFieldMap.GetFieldIndex(typ, fieldName)
    if !ok {
        return nil, fmt.Errorf("field %s not found in type %s", fieldName, typ.Name())
    }

    if val.Kind() == reflect.Ptr {
        val = val.Elem()
    }
    return val.Field(idx).Interface(), nil
}
```

## Code Generation with go generate

Code generation produces Go source code at build time, eliminating runtime reflection entirely. The generated code is type-safe, IDE-navigable, and as fast as hand-written code.

### Setting Up go generate

Add a `//go:generate` directive to trigger generation:

```go
// server.go
package config

//go:generate go run ./gen/main.go -type=Server -output=server_gen.go

type Server struct {
    Host    string `json:"host" validate:"required"`
    Port    int    `json:"port" validate:"min=1,max=65535"`
    TLS     bool   `json:"tls"`
    Timeout int    `json:"timeout,omitempty"`
}
```

Run generation:

```bash
go generate ./...
```

### Writing a Code Generator with text/template

```go
// gen/main.go
package main

import (
    "flag"
    "fmt"
    "go/ast"
    "go/parser"
    "go/token"
    "os"
    "strings"
    "text/template"
)

var (
    typeName   = flag.String("type", "", "struct type to generate for")
    outputFile = flag.String("output", "", "output file path")
)

const validatorTemplate = `// Code generated by gen/main.go; DO NOT EDIT.
package {{.Package}}

import (
    "fmt"
    "strings"
)

// Validate{{.TypeName}} validates all fields of {{.TypeName}}.
// Generated from struct tags at build time.
func Validate{{.TypeName}}(v {{.TypeName}}) error {
    var errs []string
{{range .Fields}}
{{- if .Required}}
    if v.{{.Name}} == {{.ZeroValue}} {
        errs = append(errs, "field '{{.JSONName}}' is required")
    }
{{- end}}
{{- if .Min}}
    if float64(v.{{.Name}}) < {{.Min}} {
        errs = append(errs, fmt.Sprintf("field '{{.JSONName}}' value %v is below minimum {{.Min}}", v.{{.Name}}))
    }
{{- end}}
{{- if .Max}}
    if float64(v.{{.Name}}) > {{.Max}} {
        errs = append(errs, fmt.Sprintf("field '{{.JSONName}}' value %v exceeds maximum {{.Max}}", v.{{.Name}}))
    }
{{- end}}
{{- end}}
    if len(errs) > 0 {
        return fmt.Errorf("{{.TypeName}} validation failed: %s", strings.Join(errs, "; "))
    }
    return nil
}

// {{.TypeName}}FieldNames returns all JSON field names.
func {{.TypeName}}FieldNames() []string {
    return []string{
{{range .Fields}}        "{{.JSONName}}",
{{end}}    }
}
`

type FieldInfo struct {
    Name      string
    JSONName  string
    TypeName  string
    ZeroValue string
    Required  bool
    Min       string
    Max       string
}

type TemplateData struct {
    Package  string
    TypeName string
    Fields   []FieldInfo
}

func main() {
    flag.Parse()
    if *typeName == "" || *outputFile == "" {
        fmt.Fprintln(os.Stderr, "usage: gen -type=TypeName -output=output.go")
        os.Exit(1)
    }

    fset := token.NewFileSet()
    pkgs, err := parser.ParseDir(fset, ".", nil, parser.ParseComments)
    if err != nil {
        fmt.Fprintf(os.Stderr, "parse error: %v\n", err)
        os.Exit(1)
    }

    data := TemplateData{TypeName: *typeName}

    for pkgName, pkg := range pkgs {
        data.Package = pkgName
        for _, file := range pkg.Files {
            for _, decl := range file.Decls {
                genDecl, ok := decl.(*ast.GenDecl)
                if !ok {
                    continue
                }
                for _, spec := range genDecl.Specs {
                    typeSpec, ok := spec.(*ast.TypeSpec)
                    if !ok || typeSpec.Name.Name != *typeName {
                        continue
                    }
                    structType, ok := typeSpec.Type.(*ast.StructType)
                    if !ok {
                        continue
                    }
                    data.Fields = extractFields(structType)
                }
            }
        }
    }

    tmpl := template.Must(template.New("validator").Parse(validatorTemplate))
    f, err := os.Create(*outputFile)
    if err != nil {
        fmt.Fprintf(os.Stderr, "create output: %v\n", err)
        os.Exit(1)
    }
    defer f.Close()

    if err := tmpl.Execute(f, data); err != nil {
        fmt.Fprintf(os.Stderr, "template execute: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("Generated %s for type %s\n", *outputFile, *typeName)
}

func extractFields(s *ast.StructType) []FieldInfo {
    var fields []FieldInfo
    for _, field := range s.Fields.List {
        if len(field.Names) == 0 {
            continue
        }
        fi := FieldInfo{Name: field.Names[0].Name}

        // Determine zero value from type
        if ident, ok := field.Type.(*ast.Ident); ok {
            fi.TypeName = ident.Name
            switch ident.Name {
            case "string":
                fi.ZeroValue = `""`
            case "int", "int32", "int64", "float32", "float64":
                fi.ZeroValue = "0"
            case "bool":
                fi.ZeroValue = "false"
            default:
                fi.ZeroValue = "nil"
            }
        }

        // Parse struct tags
        if field.Tag != nil {
            tag := strings.Trim(field.Tag.Value, "`")
            fi.JSONName = parseTagValue(tag, "json")
            if fi.JSONName == "" || fi.JSONName == "-" {
                fi.JSONName = strings.ToLower(fi.Name)
            }
            fi.JSONName = strings.Split(fi.JSONName, ",")[0]

            validateTag := parseTagValue(tag, "validate")
            if validateTag != "" {
                for _, rule := range strings.Split(validateTag, ",") {
                    parts := strings.SplitN(rule, "=", 2)
                    switch parts[0] {
                    case "required":
                        fi.Required = true
                    case "min":
                        if len(parts) == 2 {
                            fi.Min = parts[1]
                        }
                    case "max":
                        if len(parts) == 2 {
                            fi.Max = parts[1]
                        }
                    }
                }
            }
        }

        fields = append(fields, fi)
    }
    return fields
}

func parseTagValue(tag, key string) string {
    prefix := key + `:"`
    idx := strings.Index(tag, prefix)
    if idx == -1 {
        return ""
    }
    rest := tag[idx+len(prefix):]
    end := strings.Index(rest, `"`)
    if end == -1 {
        return ""
    }
    return rest[:end]
}
```

### Example Generated Output

For the `Server` struct above, the generator produces:

```go
// Code generated by gen/main.go; DO NOT EDIT.
package config

import (
    "fmt"
    "strings"
)

// ValidateServer validates all fields of Server.
// Generated from struct tags at build time.
func ValidateServer(v Server) error {
    var errs []string

    if v.Host == "" {
        errs = append(errs, "field 'host' is required")
    }

    if float64(v.Port) < 1 {
        errs = append(errs, fmt.Sprintf("field 'port' value %v is below minimum 1", v.Port))
    }

    if float64(v.Port) > 65535 {
        errs = append(errs, fmt.Sprintf("field 'port' value %v exceeds maximum 65535", v.Port))
    }

    if len(errs) > 0 {
        return fmt.Errorf("Server validation failed: %s", strings.Join(errs, "; "))
    }
    return nil
}

// ServerFieldNames returns all JSON field names.
func ServerFieldNames() []string {
    return []string{
        "host",
        "port",
        "tls",
        "timeout",
    }
}
```

This generated code compiles with full type safety. Any type mismatch between the generator output and the actual struct causes a compile error, not a runtime panic.

## go/ast for Source Analysis

The `go/ast` package provides a complete abstract syntax tree of Go source files. It is the foundation of tools like `goimports`, `staticcheck`, and custom linters.

### Parsing and Walking an AST

```go
package astanalysis

import (
    "fmt"
    "go/ast"
    "go/parser"
    "go/token"
)

// FindInterfaceImplementors finds all types implementing the given interface name.
func FindInterfaceImplementors(dir, interfaceName string) ([]string, error) {
    fset := token.NewFileSet()
    pkgs, err := parser.ParseDir(fset, dir, nil, 0)
    if err != nil {
        return nil, fmt.Errorf("parse dir: %w", err)
    }

    var implementors []string

    for _, pkg := range pkgs {
        for _, file := range pkg.Files {
            ast.Inspect(file, func(n ast.Node) bool {
                typeDecl, ok := n.(*ast.GenDecl)
                if !ok {
                    return true
                }
                for _, spec := range typeDecl.Specs {
                    ts, ok := spec.(*ast.TypeSpec)
                    if !ok {
                        continue
                    }
                    if _, ok := ts.Type.(*ast.StructType); ok {
                        // Check if methods suggest interface implementation
                        // Full implementation requires type checker
                        implementors = append(implementors, ts.Name.Name)
                    }
                }
                return true
            })
        }
    }

    return implementors, nil
}

// CountPublicMethods counts exported methods on each struct type.
func CountPublicMethods(src string) (map[string]int, error) {
    fset := token.NewFileSet()
    f, err := parser.ParseFile(fset, "src.go", src, 0)
    if err != nil {
        return nil, err
    }

    methods := make(map[string]int)
    ast.Inspect(f, func(n ast.Node) bool {
        funcDecl, ok := n.(*ast.FuncDecl)
        if !ok {
            return true
        }
        // Only methods (have a receiver)
        if funcDecl.Recv == nil {
            return true
        }
        // Only exported methods
        if !funcDecl.Name.IsExported() {
            return true
        }

        // Extract receiver type name
        if len(funcDecl.Recv.List) > 0 {
            recv := funcDecl.Recv.List[0].Type
            typeName := extractTypeName(recv)
            methods[typeName]++
        }
        return true
    })

    return methods, nil
}

func extractTypeName(expr ast.Expr) string {
    switch t := expr.(type) {
    case *ast.Ident:
        return t.Name
    case *ast.StarExpr:
        return extractTypeName(t.X)
    }
    return ""
}
```

### Generating Boilerplate with AST Rewriting

For complex code generation that needs to be syntactically correct, build the AST directly rather than using text templates:

```go
package gentool

import (
    "bytes"
    "fmt"
    "go/ast"
    "go/format"
    "go/token"
)

// GenerateStringer generates a String() method for an integer-based type
// with a set of constants (like an enum).
func GenerateStringer(pkgName, typeName string, constants []string) (string, error) {
    fset := token.NewFileSet()

    // Build the case list
    caseClauses := make([]ast.Stmt, 0, len(constants)+1)
    for i, c := range constants {
        caseClauses = append(caseClauses, &ast.CaseClause{
            List: []ast.Expr{
                &ast.Ident{Name: c},
            },
            Body: []ast.Stmt{
                &ast.ReturnStmt{
                    Results: []ast.Expr{
                        &ast.BasicLit{
                            Kind:  token.STRING,
                            Value: fmt.Sprintf(`"%s"`, c),
                        },
                    },
                },
            },
            _ : i, // suppress unused warning in example
        })
    }

    // Default case
    caseClauses = append(caseClauses, &ast.CaseClause{
        Body: []ast.Stmt{
            &ast.ReturnStmt{
                Results: []ast.Expr{
                    &ast.CallExpr{
                        Fun: &ast.SelectorExpr{
                            X:   &ast.Ident{Name: "fmt"},
                            Sel: &ast.Ident{Name: "Sprintf"},
                        },
                        Args: []ast.Expr{
                            &ast.BasicLit{
                                Kind:  token.STRING,
                                Value: fmt.Sprintf(`"%s(%%d)"`, typeName),
                            },
                            &ast.Ident{Name: "s"},
                        },
                    },
                },
            },
        },
    })

    file := &ast.File{
        Name: &ast.Ident{Name: pkgName},
        Decls: []ast.Decl{
            &ast.GenDecl{
                Tok: token.IMPORT,
                Specs: []ast.Spec{
                    &ast.ImportSpec{
                        Path: &ast.BasicLit{Kind: token.STRING, Value: `"fmt"`},
                    },
                },
            },
            &ast.FuncDecl{
                Recv: &ast.FieldList{
                    List: []*ast.Field{
                        {
                            Names: []*ast.Ident{{Name: "s"}},
                            Type:  &ast.Ident{Name: typeName},
                        },
                    },
                },
                Name: &ast.Ident{Name: "String"},
                Type: &ast.FuncType{
                    Results: &ast.FieldList{
                        List: []*ast.Field{
                            {Type: &ast.Ident{Name: "string"}},
                        },
                    },
                },
                Body: &ast.BlockStmt{
                    List: []ast.Stmt{
                        &ast.SwitchStmt{
                            Tag: &ast.Ident{Name: "s"},
                            Body: &ast.BlockStmt{
                                List: caseClauses,
                            },
                        },
                    },
                },
            },
        },
    }

    var buf bytes.Buffer
    if err := format.Node(&buf, fset, file); err != nil {
        return "", fmt.Errorf("format node: %w", err)
    }

    return buf.String(), nil
}
```

## When to Choose Reflection vs Code Generation

| Criterion | Runtime Reflection | Code Generation |
|---|---|---|
| Type safety | None at compile time | Full compile-time safety |
| Performance | 50-300x slower than direct | Identical to hand-written |
| Debugging | Stack traces through reflect | Normal stack traces |
| IDE support | No completion on reflect.Value | Full IDE support |
| Build complexity | None | Requires generator tooling |
| Handles unknown types | Yes | No (types must be known at gen time) |
| Library code (unknown types) | Required | Not applicable |
| Application code (known types) | Avoid | Preferred |

### Use Reflection For

- Deserialization of arbitrary JSON/YAML into `interface{}` (encoding/json does this)
- Framework code that operates on user-provided types (ORMs, test frameworks)
- Debug and introspection tooling
- Dynamic proxy generation

### Use Code Generation For

- Validation of known struct types
- Marshal/unmarshal of performance-critical structs (easyjson, ffjson)
- Boilerplate elimination (getters, setters, builders)
- Typed event systems with known event types
- Any hot path that currently uses reflection

## Production Patterns

### Type-Safe Builder Pattern via Code Generation

```go
//go:generate go run ./gen/builder -type=ServerConfig

type ServerConfig struct {
    Host          string        `builder:"required"`
    Port          int           `builder:"default=8080"`
    ReadTimeout   time.Duration `builder:"default=30s"`
    WriteTimeout  time.Duration `builder:"default=30s"`
    MaxConns      int           `builder:"default=1000"`
}

// Generated: server_config_builder_gen.go
type ServerConfigBuilder struct {
    host         string
    port         int
    readTimeout  time.Duration
    writeTimeout time.Duration
    maxConns     int
    errs         []error
}

func NewServerConfigBuilder() *ServerConfigBuilder {
    return &ServerConfigBuilder{
        port:         8080,
        readTimeout:  30 * time.Second,
        writeTimeout: 30 * time.Second,
        maxConns:     1000,
    }
}

func (b *ServerConfigBuilder) WithHost(host string) *ServerConfigBuilder {
    if host == "" {
        b.errs = append(b.errs, fmt.Errorf("host is required"))
    }
    b.host = host
    return b
}

func (b *ServerConfigBuilder) WithPort(port int) *ServerConfigBuilder {
    if port < 1 || port > 65535 {
        b.errs = append(b.errs, fmt.Errorf("port %d is out of range [1, 65535]", port))
    }
    b.port = port
    return b
}

func (b *ServerConfigBuilder) Build() (ServerConfig, error) {
    if len(b.errs) > 0 {
        return ServerConfig{}, fmt.Errorf("build errors: %v", b.errs)
    }
    if b.host == "" {
        return ServerConfig{}, fmt.Errorf("host is required")
    }
    return ServerConfig{
        Host:         b.host,
        Port:         b.port,
        ReadTimeout:  b.readTimeout,
        WriteTimeout: b.writeTimeout,
        MaxConns:     b.maxConns,
    }, nil
}
```

## Toolchain Integration

### Makefile Integration

```makefile
.PHONY: generate
generate:
	go generate ./...
	go build ./...  # Verify generated code compiles

.PHONY: generate-check
generate-check:
	go generate ./...
	git diff --exit-code -- '*.gen.go' '**/*_gen.go'
	@echo "Generated files are up to date"
```

### CI Pipeline Validation

```yaml
# .github/workflows/generate.yml
name: Validate Generated Code
on: [pull_request]
jobs:
  generate:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-go@v5
      with:
        go-version: '1.23'
    - name: Run go generate
      run: go generate ./...
    - name: Check for uncommitted changes
      run: |
        if ! git diff --exit-code; then
          echo "Generated files are out of date. Run 'go generate ./...' and commit the results."
          exit 1
        fi
```

## Summary

Reflection is indispensable for framework code that must operate on types it has never seen. For application code where types are known at compile time, code generation produces faster, safer, and more maintainable programs. The decision framework is straightforward: if the types are known, generate; if they are not, reflect — and cache all metadata to minimize the performance penalty.

The `go/ast` package transforms code generation from string concatenation into a structured, type-safe transformation of Go's own data model, enabling generators that produce syntactically valid Go regardless of input complexity. Combined with `go generate` integration into the build pipeline, code generation becomes a first-class development tool rather than an afterthought.
