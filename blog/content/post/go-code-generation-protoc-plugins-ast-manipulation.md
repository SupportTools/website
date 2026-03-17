---
title: "Go Code Generation: protoc plugins, go generate, and AST Manipulation for Boilerplate Elimination"
date: 2030-01-30T00:00:00-05:00
draft: false
tags: ["Go", "Code Generation", "protobuf", "AST", "protoc", "go generate", "Tooling"]
categories: ["Go", "Developer Tooling", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Build Go code generators: write protoc plugins, use go/ast for source analysis, the jen code generation library, maintaining generated code in CI, and eliminating boilerplate with go generate."
more_link: "yes"
url: "/go-code-generation-protoc-plugins-ast-manipulation/"
---

Code generation in Go eliminates entire categories of boilerplate: repetitive struct constructors, validation methods, mock implementations, database query builders, and protocol buffer service stubs. The Go toolchain provides multiple layers for generation — from the `go generate` directive that runs arbitrary commands to the `go/ast` package that gives programs full read-write access to Go source code, and the `protoc` plugin API that hooks into the Protocol Buffer compiler.

This guide covers building production-ready Go code generators: writing `protoc` plugins that generate service clients and servers, using `go/ast` for source analysis-driven generation, the `dave/jennifer` (jen) library for type-safe code generation, and integrating generated code into CI pipelines.

<!--more-->

## Understanding go generate

`go generate` is not a build tool — it runs arbitrary commands embedded as directives in Go source files. The generated code is checked into version control and regenerated when the source changes.

```go
// models/user.go
package models

//go:generate go run github.com/yourorg/tools/gen-validator -type User -output user_validation_gen.go
//go:generate mockgen -source=../interfaces/user_repository.go -destination=../mocks/user_repository_mock.go

// User represents a user in the system.
type User struct {
    ID        string `validate:"required,uuid4"`
    Email     string `validate:"required,email"`
    Name      string `validate:"required,min=2,max=100"`
    CreatedAt time.Time
}
```

```bash
# Run all go:generate directives in current package
go generate ./...

# Run for a specific file
go generate ./models/user.go

# With verbose output
go generate -v ./...

# Dry run (prints commands without executing)
go generate -n ./...
```

## Building a protoc Plugin

protoc plugins are executables that receive a `CodeGeneratorRequest` on stdin and write a `CodeGeneratorResponse` to stdout. They integrate directly into the `protoc` compilation pipeline.

### Plugin Setup

```bash
go mod init github.com/yourorg/protoc-gen-go-http

go get google.golang.org/protobuf@v1.33.0
go get google.golang.org/protobuf/compiler/protogen@v1.33.0
go get google.golang.org/grpc@v1.62.0
go get google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0

# Your plugin will be named protoc-gen-go-http
# protoc discovers plugins by looking for protoc-gen-<plugin-name> in PATH
```

### Plugin Structure

```
protoc-gen-go-http/
├── main.go
├── generator/
│   ├── generator.go
│   ├── http_server.go
│   └── http_client.go
├── templates/
│   ├── server.go.tmpl
│   └── client.go.tmpl
└── testdata/
    ├── api.proto
    └── api_http_gen.go  (expected output)
```

### main.go: Plugin Entry Point

```go
// main.go
package main

import (
	"flag"

	"google.golang.org/protobuf/compiler/protogen"

	"github.com/yourorg/protoc-gen-go-http/generator"
)

func main() {
	var flags flag.FlagSet
	// Plugin-specific options passed via --go-http_opt=key=value
	generateMockClient := flags.Bool("mock_client", false, "Generate a mock HTTP client for testing")
	baseURL := flags.String("base_url", "", "Default base URL for generated clients")

	opts := protogen.Options{
		ParamFunc: flags.Set,
	}

	opts.Run(func(gen *protogen.Plugin) error {
		gen.SupportedFeatures = uint64(
			protogen.SupportedFeatures(protogen.FeatureProto3Optional),
		)

		for _, f := range gen.Files {
			if !f.Generate {
				continue // Skip imported proto files
			}
			if err := generator.GenerateFile(gen, f, generator.Options{
				MockClient: *generateMockClient,
				BaseURL:    *baseURL,
			}); err != nil {
				return err
			}
		}
		return nil
	})
}
```

### generator/generator.go: Core Generation Logic

```go
// generator/generator.go
package generator

import (
	"fmt"
	"strings"

	"google.golang.org/protobuf/compiler/protogen"
	"google.golang.org/protobuf/reflect/protoreflect"

	// Import HTTP annotations proto
	httppb "google.golang.org/genproto/googleapis/api/annotations"
	"google.golang.org/protobuf/proto"
)

// Options configures code generation behavior.
type Options struct {
	MockClient bool
	BaseURL    string
}

// GenerateFile generates HTTP client/server code for a .proto file.
func GenerateFile(gen *protogen.Plugin, file *protogen.File, opts Options) error {
	if len(file.Services) == 0 {
		return nil // Nothing to generate
	}

	// Create output file: e.g., api.proto -> api_http_gen.go
	filename := file.GeneratedFilenamePrefix + "_http_gen.go"
	g := gen.NewGeneratedFile(filename, file.GoImportPath)

	// Write file header
	writeHeader(g, file)

	for _, service := range file.Services {
		if err := generateService(g, service, opts); err != nil {
			return fmt.Errorf("generating service %s: %w", service.GoName, err)
		}
	}

	if opts.MockClient {
		for _, service := range file.Services {
			generateMockClient(g, service)
		}
	}

	return nil
}

func writeHeader(g *protogen.GeneratedFile, file *protogen.File) {
	g.P("// Code generated by protoc-gen-go-http. DO NOT EDIT.")
	g.P("// source: ", file.Desc.Path())
	g.P()
	g.P("package ", file.GoPackageName)
	g.P()
}

// HTTPRule extracts HTTP annotations from a method.
type HTTPRule struct {
	Method  string // GET, POST, PUT, DELETE, PATCH
	Pattern string // URL pattern e.g., "/v1/users/{user_id}"
	Body    string // Field name for request body ("*" = full request)
}

func extractHTTPRule(method *protogen.Method) *HTTPRule {
	opts := method.Desc.Options()
	if opts == nil {
		return nil
	}
	rule, ok := proto.GetExtension(opts, httppb.E_Http).(*httppb.HttpRule)
	if !ok || rule == nil {
		return nil
	}

	var httpMethod, pattern string
	switch p := rule.Pattern.(type) {
	case *httppb.HttpRule_Get:
		httpMethod, pattern = "GET", p.Get
	case *httppb.HttpRule_Post:
		httpMethod, pattern = "POST", p.Post
	case *httppb.HttpRule_Put:
		httpMethod, pattern = "PUT", p.Put
	case *httppb.HttpRule_Delete:
		httpMethod, pattern = "DELETE", p.Delete
	case *httppb.HttpRule_Patch:
		httpMethod, pattern = "PATCH", p.Patch
	default:
		return nil
	}

	return &HTTPRule{
		Method:  httpMethod,
		Pattern: pattern,
		Body:    rule.Body,
	}
}

func generateService(g *protogen.GeneratedFile, service *protogen.Service, opts Options) error {
	// Generate HTTP handler interface
	g.P("// ", service.GoName, "HTTPHandler defines the HTTP handler interface.")
	g.P("type ", service.GoName, "HTTPHandler interface {")
	for _, method := range service.Methods {
		rule := extractHTTPRule(method)
		if rule == nil {
			continue
		}
		g.P("\t", method.GoName, "(w ", g.QualifiedGoIdent(httpPackage.Ident("ResponseWriter")),
			", r *", g.QualifiedGoIdent(httpPackage.Ident("Request")), ")")
	}
	g.P("}")
	g.P()

	// Generate route registration function
	g.P("// Register", service.GoName, "Routes registers HTTP routes for ", service.GoName, ".")
	g.P("func Register", service.GoName, "Routes(mux *", g.QualifiedGoIdent(httpPackage.Ident("ServeMux")), ", h ", service.GoName, "HTTPHandler) {")
	for _, method := range service.Methods {
		rule := extractHTTPRule(method)
		if rule == nil {
			continue
		}
		g.P("\tmux.HandleFunc(", fmt.Sprintf("%q", rule.Method+" "+rule.Pattern), ", h.", method.GoName, ")")
	}
	g.P("}")
	g.P()

	// Generate base handler struct with common functionality
	generateBaseHandler(g, service, opts)

	return nil
}

func generateBaseHandler(g *protogen.GeneratedFile, service *protogen.Service, opts Options) {
	structName := service.GoName + "BaseHTTPHandler"

	g.P("// ", structName, " provides base HTTP handler functionality.")
	g.P("type ", structName, " struct {")
	g.P("\tsvc ", service.GoName, "Server")
	g.P("\tencoder func(w ", g.QualifiedGoIdent(httpPackage.Ident("ResponseWriter")), ", v interface{}) error")
	g.P("\tdecoder func(r *", g.QualifiedGoIdent(httpPackage.Ident("Request")), ", v interface{}) error")
	g.P("}")
	g.P()

	g.P("// New", structName, " creates a new base HTTP handler for ", service.GoName, ".")
	g.P("func New", structName, "(svc ", service.GoName, "Server) *", structName, " {")
	g.P("\treturn &", structName, "{")
	g.P("\t\tsvc: svc,")
	g.P("\t\tencoder: defaultJSONEncoder,")
	g.P("\t\tdecoder: defaultJSONDecoder,")
	g.P("\t}")
	g.P("}")
	g.P()

	// Generate method handlers
	for _, method := range service.Methods {
		rule := extractHTTPRule(method)
		if rule == nil {
			continue
		}
		generateMethodHandler(g, service, method, rule, structName)
	}
}

func generateMethodHandler(g *protogen.GeneratedFile, svc *protogen.Service, method *protogen.Method, rule *HTTPRule, structName string) {
	inputType := method.Input.GoIdent
	outputType := method.Output.GoIdent

	g.P("// ", method.GoName, " handles HTTP ", rule.Method, " ", rule.Pattern)
	g.P("func (h *", structName, ") ", method.GoName, "(w ", g.QualifiedGoIdent(httpPackage.Ident("ResponseWriter")), ", r *", g.QualifiedGoIdent(httpPackage.Ident("Request")), ") {")

	// Body decoding for POST/PUT/PATCH
	if rule.Method != "GET" && rule.Method != "DELETE" {
		g.P("\tvar req ", g.QualifiedGoIdent(inputType))
		g.P("\tif err := h.decoder(r, &req); err != nil {")
		g.P("\t\thttp.Error(w, err.Error(), ", g.QualifiedGoIdent(httpPackage.Ident("StatusBadRequest")), ")")
		g.P("\t\treturn")
		g.P("\t}")
	} else {
		g.P("\tvar req ", g.QualifiedGoIdent(inputType))
		g.P("\t// TODO: Populate req from URL parameters and query string")
	}

	g.P("\tctx := r.Context()")
	g.P("\tresp, err := h.svc.", method.GoName, "(ctx, &req)")
	g.P("\tif err != nil {")
	g.P("\t\th.handleError(w, err)")
	g.P("\t\treturn")
	g.P("\t}")
	g.P("\tif err := h.encoder(w, resp); err != nil {")
	g.P("\t\thttp.Error(w, err.Error(), ", g.QualifiedGoIdent(httpPackage.Ident("StatusInternalServerError")), ")")
	g.P("\t}")
	g.P("}")
	g.P()
}

// Package identifiers for imports
var (
	httpPackage = protogen.GoImportPath("net/http")
	jsonPackage = protogen.GoImportPath("encoding/json")
	fmtPackage  = protogen.GoImportPath("fmt")
)
```

### Building and Installing the Plugin

```bash
# Build the plugin
cd protoc-gen-go-http
go build -o bin/protoc-gen-go-http ./cmd/protoc-gen-go-http

# Install to PATH
go install github.com/yourorg/protoc-gen-go-http@latest

# Test with a .proto file
protoc \
  --proto_path=. \
  --go_out=. \
  --go_opt=paths=source_relative \
  --go-grpc_out=. \
  --go-grpc_opt=paths=source_relative \
  --go-http_out=. \
  --go-http_opt=paths=source_relative \
  --go-http_opt=mock_client=true \
  api/v1/user_service.proto
```

## AST Manipulation with go/ast

The `go/ast` package provides a complete representation of Go source code as a tree, enabling both analysis and modification:

### Reading and Analyzing Go Source

```go
// tools/gen-validator/main.go
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

var (
	typeName   = flag.String("type", "", "Type name to generate validator for")
	outputFile = flag.String("output", "", "Output file path")
	pkg        = flag.String("package", "", "Package name (defaults to source package)")
)

func main() {
	flag.Parse()

	if *typeName == "" {
		fmt.Fprintln(os.Stderr, "error: -type is required")
		os.Exit(1)
	}

	// Parse the current directory's Go files
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi os.FileInfo) bool {
		// Skip test and generated files
		return !strings.HasSuffix(fi.Name(), "_test.go") &&
			!strings.HasSuffix(fi.Name(), "_gen.go")
	}, parser.ParseComments)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error parsing directory: %v\n", err)
		os.Exit(1)
	}

	for pkgName, pkg := range pkgs {
		for filename, file := range pkg.Files {
			structDef := findStruct(file, *typeName)
			if structDef == nil {
				continue
			}

			fields := extractValidationFields(fset, structDef)
			if len(fields) == 0 {
				fmt.Fprintf(os.Stderr, "no validate tags found in %s.%s\n", pkgName, *typeName)
				os.Exit(0)
			}

			fmt.Printf("Found struct %s in %s with %d validated fields\n",
				*typeName, filename, len(fields))

			generateValidator(*typeName, pkgName, fields, *outputFile)
			return
		}
	}

	fmt.Fprintf(os.Stderr, "error: type %s not found\n", *typeName)
	os.Exit(1)
}

// FieldValidation holds validation info extracted from struct tags.
type FieldValidation struct {
	Name     string
	TypeName string
	Rules    []string
}

func findStruct(file *ast.File, name string) *ast.StructType {
	for _, decl := range file.Decls {
		genDecl, ok := decl.(*ast.GenDecl)
		if !ok || genDecl.Tok != token.TYPE {
			continue
		}
		for _, spec := range genDecl.Specs {
			typeSpec, ok := spec.(*ast.TypeSpec)
			if !ok || typeSpec.Name.Name != name {
				continue
			}
			structType, ok := typeSpec.Type.(*ast.StructType)
			if ok {
				return structType
			}
		}
	}
	return nil
}

func extractValidationFields(fset *token.FileSet, structType *ast.StructType) []FieldValidation {
	var fields []FieldValidation

	for _, field := range structType.Fields.List {
		if field.Tag == nil {
			continue
		}

		// Extract validate tag value (e.g., `validate:"required,email"`)
		tag := strings.Trim(field.Tag.Value, "`")
		validateTag := extractTag(tag, "validate")
		if validateTag == "" {
			continue
		}

		fieldName := ""
		if len(field.Names) > 0 {
			fieldName = field.Names[0].Name
		}

		typeName := ""
		switch t := field.Type.(type) {
		case *ast.Ident:
			typeName = t.Name
		case *ast.SelectorExpr:
			typeName = fmt.Sprintf("%s.%s", t.X, t.Sel)
		case *ast.StarExpr:
			if ident, ok := t.X.(*ast.Ident); ok {
				typeName = "*" + ident.Name
			}
		}

		fields = append(fields, FieldValidation{
			Name:     fieldName,
			TypeName: typeName,
			Rules:    strings.Split(validateTag, ","),
		})
	}

	return fields
}

func extractTag(tag, key string) string {
	// Parse struct tags like `json:"name" validate:"required,email"`
	for tag != "" {
		// Skip leading spaces
		i := 0
		for i < len(tag) && tag[i] == ' ' {
			i++
		}
		tag = tag[i:]
		if tag == "" {
			break
		}

		// Find key:value
		i = 0
		for i < len(tag) && tag[i] != ':' && tag[i] != ' ' {
			i++
		}
		if i+1 >= len(tag) || tag[i] != ':' || tag[i+1] != '"' {
			break
		}
		name := tag[:i]
		tag = tag[i+1:]

		// Find quoted value
		i = 1
		for i < len(tag) && tag[i] != '"' {
			if tag[i] == '\\' {
				i++
			}
			i++
		}
		if i >= len(tag) {
			break
		}
		value := tag[1:i]
		tag = tag[i+1:]

		if name == key {
			return value
		}
	}
	return ""
}
```

## The Jennifer (jen) Code Generation Library

`jen` provides a fluent API for generating Go code programmatically, handling all formatting and import management automatically:

```bash
go get github.com/dave/jennifer@latest
```

### Generating Validation Code with jen

```go
// tools/gen-validator/generator.go
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/dave/jennifer/jen"
)

func generateValidator(typeName, pkgName string, fields []FieldValidation, outputFile string) {
	f := jen.NewFile(pkgName)

	f.Comment(fmt.Sprintf("Code generated by gen-validator for %s. DO NOT EDIT.", typeName))
	f.Comment(fmt.Sprintf("Run 'go generate' to regenerate this file."))
	f.Line()

	// Generate the Validate method
	generateValidateMethod(f, typeName, fields)

	// Generate individual field validators
	for _, field := range fields {
		for _, rule := range field.Rules {
			generateFieldValidator(f, typeName, field, rule)
		}
	}

	// Write to file or stdout
	if outputFile == "" {
		if err := f.Render(os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "error rendering code: %v\n", err)
			os.Exit(1)
		}
		return
	}

	out, err := os.Create(outputFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error creating output file: %v\n", err)
		os.Exit(1)
	}
	defer out.Close()

	if err := f.Render(out); err != nil {
		fmt.Fprintf(os.Stderr, "error writing output: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Generated: %s\n", outputFile)
}

func generateValidateMethod(f *jen.File, typeName string, fields []FieldValidation) {
	receiver := strings.ToLower(typeName[:1])

	f.Comment(fmt.Sprintf("Validate validates %s fields according to struct tags.", typeName))
	f.Func().Params(
		jen.Id(receiver).Op("*").Id(typeName),
	).Id("Validate").Params().Error().Block(
		buildValidationBody(receiver, fields)...,
	)
	f.Line()
}

func buildValidationBody(receiver string, fields []FieldValidation) []jen.Code {
	var stmts []jen.Code

	for _, field := range fields {
		for _, rule := range field.Rules {
			stmt := buildFieldValidation(receiver, field, rule)
			if stmt != nil {
				stmts = append(stmts, stmt)
			}
		}
	}

	stmts = append(stmts, jen.Return(jen.Nil()))
	return stmts
}

func buildFieldValidation(receiver string, field FieldValidation, rule string) jen.Code {
	fieldAccess := jen.Id(receiver).Dot(field.Name)

	switch rule {
	case "required":
		return jen.If(
			jen.Id(receiver).Dot(field.Name).Op("==").Lit(""),
		).Block(
			jen.Return(
				jen.Qual("fmt", "Errorf").Call(
					jen.Lit(field.Name+" is required"),
				),
			),
		)

	case "email":
		return jen.If(
			jen.Op("!").Qual("regexp", "MustCompile").Call(
				jen.Lit(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`),
			).Dot("MatchString").Call(fieldAccess),
		).Block(
			jen.Return(
				jen.Qual("fmt", "Errorf").Call(
					jen.Lit(field.Name+" must be a valid email address"),
				),
			),
		)

	case "uuid4":
		return jen.If(
			jen.Op("!").Qual("regexp", "MustCompile").Call(
				jen.Lit(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
			).Dot("MatchString").Call(fieldAccess),
		).Block(
			jen.Return(
				jen.Qual("fmt", "Errorf").Call(
					jen.Lit(field.Name+" must be a valid UUID v4"),
				),
			),
		)
	}

	// Handle min=N rules
	if strings.HasPrefix(rule, "min=") {
		minVal := strings.TrimPrefix(rule, "min=")
		return jen.If(
			jen.Qual("unicode/utf8", "RuneCountInString").Call(fieldAccess).
				Op("<").Lit(mustAtoi(minVal)),
		).Block(
			jen.Return(
				jen.Qual("fmt", "Errorf").Call(
					jen.Lit(fmt.Sprintf("%s must be at least %s characters", field.Name, minVal)),
				),
			),
		)
	}

	return nil
}

func generateFieldValidator(f *jen.File, typeName, field FieldValidation, rule string) {
	// Optionally generate standalone field validator functions
	// for reuse across types
}

func mustAtoi(s string) int {
	var n int
	fmt.Sscanf(s, "%d", &n)
	return n
}
```

### jen for Complex Code Generation

```go
// Example: Generating a complete CRUD handler from a struct definition
func generateCRUDHandler(f *jen.File, resourceName string, fields []FieldValidation) {
	// Generate Create handler
	f.Func().Id("Create"+resourceName+"Handler").
		Params(
			jen.Id("svc").Qual("", resourceName+"Service"),
		).
		Qual("net/http", "HandlerFunc").
		Block(
			jen.Return(
				jen.Qual("net/http", "HandlerFunc").Call(
					jen.Func().Params(
						jen.Id("w").Qual("net/http", "ResponseWriter"),
						jen.Id("r").Op("*").Qual("net/http", "Request"),
					).Block(
						// var req CreateUserRequest
						jen.Var().Id("req").Id("Create"+resourceName+"Request"),
						// if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
						jen.If(
							jen.Err().Op(":=").
								Qual("encoding/json", "NewDecoder").Call(jen.Id("r").Dot("Body")).
								Dot("Decode").Call(jen.Op("&").Id("req")),
							jen.Err().Op("!=").Nil(),
						).Block(
							jen.Qual("net/http", "Error").Call(
								jen.Id("w"),
								jen.Err().Dot("Error").Call(),
								jen.Qual("net/http", "StatusBadRequest"),
							),
							jen.Return(),
						),
						// if err := req.Validate(); err != nil {
						jen.If(
							jen.Err().Op(":=").Id("req").Dot("Validate").Call(),
							jen.Err().Op("!=").Nil(),
						).Block(
							jen.Qual("net/http", "Error").Call(
								jen.Id("w"),
								jen.Err().Dot("Error").Call(),
								jen.Qual("net/http", "StatusUnprocessableEntity"),
							),
							jen.Return(),
						),
						// result, err := svc.Create(r.Context(), req)
						jen.List(jen.Id("result"), jen.Err()).Op(":=").
							Id("svc").Dot("Create").Call(
								jen.Id("r").Dot("Context").Call(),
								jen.Id("req"),
							),
						jen.If(jen.Err().Op("!=").Nil()).Block(
							jen.Qual("net/http", "Error").Call(
								jen.Id("w"),
								jen.Err().Dot("Error").Call(),
								jen.Qual("net/http", "StatusInternalServerError"),
							),
							jen.Return(),
						),
						// w.WriteHeader(http.StatusCreated)
						jen.Id("w").Dot("WriteHeader").Call(
							jen.Qual("net/http", "StatusCreated"),
						),
						// json.NewEncoder(w).Encode(result)
						jen.Qual("encoding/json", "NewEncoder").Call(jen.Id("w")).
							Dot("Encode").Call(jen.Id("result")),
					),
				),
			),
		)
}
```

## Integrating go generate in CI

### Makefile Integration

```makefile
# Makefile
GENERATED_FILES = $(shell find . -name "*_gen.go" -not -path "*/vendor/*")

.PHONY: generate
generate: ## Regenerate all generated code
	@echo "Running go generate..."
	go generate ./...
	@echo "Running protoc..."
	buf generate
	@echo "Generation complete."

.PHONY: check-generated
check-generated: generate ## Verify generated code is up to date
	@echo "Checking for uncommitted generated changes..."
	@git diff --exit-code -- $(GENERATED_FILES) || \
		(echo "ERROR: Generated code is out of date. Run 'make generate' and commit."; exit 1)
	@echo "All generated code is up to date."

.PHONY: clean-generated
clean-generated: ## Remove all generated files
	find . -name "*_gen.go" -not -path "*/vendor/*" -delete
	find . -name "*.pb.go" -not -path "*/vendor/*" -delete
```

### GitHub Actions CI Check

```yaml
# .github/workflows/generated-code.yaml
name: Check Generated Code

on:
  pull_request:
    paths:
      - "**/*.proto"
      - "**/*.go"
      - "**/go.mod"
      - "**/go.sum"
      - "Makefile"

jobs:
  check-generated:
    name: Verify Generated Code
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true

      - name: Install protoc
        run: |
          sudo apt-get install -y protobuf-compiler
          go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
          go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
          go install github.com/yourorg/protoc-gen-go-http@latest

      - name: Install buf
        run: |
          curl -sSL "https://github.com/bufbuild/buf/releases/latest/download/buf-Linux-x86_64" \
            -o "/usr/local/bin/buf"
          chmod +x /usr/local/bin/buf

      - name: Install generation tools
        run: |
          go install github.com/golang/mock/mockgen@latest
          go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest

      - name: Run code generation
        run: make generate

      - name: Check for uncommitted changes
        run: |
          git diff --exit-code || {
            echo "::error::Generated code is out of date."
            echo "::error::Run 'make generate' locally and commit the changes."
            git diff --name-only
            exit 1
          }
```

### buf.gen.yaml for protoc Management

```yaml
# buf.gen.yaml
version: v2
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: github.com/yourorg/proto-gen

plugins:
  - remote: buf.build/protocolbuffers/go
    out: gen/go
    opt: paths=source_relative

  - remote: buf.build/grpc/go
    out: gen/go
    opt:
      - paths=source_relative
      - require_unimplemented_servers=true

  - local: protoc-gen-go-http
    out: gen/go
    opt:
      - paths=source_relative
      - mock_client=true

inputs:
  - directory: proto
```

## Advanced: AST Rewriting

```go
// tools/add-context-param/main.go
// Rewrites function signatures to add context.Context as first parameter
package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

// AddContextParam adds context.Context as the first parameter to all functions
// that match the provided interface. This automates migration of legacy APIs.
func AddContextParam(filename string, functionNames []string) error {
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, filename, nil, parser.ParseComments)
	if err != nil {
		return fmt.Errorf("parsing %s: %w", filename, err)
	}

	targetFuncs := make(map[string]bool)
	for _, name := range functionNames {
		targetFuncs[name] = true
	}

	modified := false
	ast.Inspect(node, func(n ast.Node) bool {
		funcDecl, ok := n.(*ast.FuncDecl)
		if !ok || !targetFuncs[funcDecl.Name.Name] {
			return true
		}

		// Check if context.Context is already the first parameter
		if len(funcDecl.Type.Params.List) > 0 {
			first := funcDecl.Type.Params.List[0]
			if sel, ok := first.Type.(*ast.SelectorExpr); ok {
				if sel.X.(*ast.Ident).Name == "context" && sel.Sel.Name == "Context" {
					return true // Already has context
				}
			}
		}

		// Create context.Context parameter
		ctxParam := &ast.Field{
			Names: []*ast.Ident{ast.NewIdent("ctx")},
			Type: &ast.SelectorExpr{
				X:   ast.NewIdent("context"),
				Sel: ast.NewIdent("Context"),
			},
		}

		// Prepend to parameter list
		params := funcDecl.Type.Params.List
		funcDecl.Type.Params.List = append([]*ast.Field{ctxParam}, params...)

		// Ensure context import exists (simplified — use golang.org/x/tools/imports for production)
		ensureContextImport(node)

		modified = true
		fmt.Printf("Modified function: %s\n", funcDecl.Name.Name)
		return true
	})

	if !modified {
		return nil
	}

	// Format and write back
	var buf bytes.Buffer
	if err := format.Node(&buf, fset, node); err != nil {
		return fmt.Errorf("formatting: %w", err)
	}

	return os.WriteFile(filename, buf.Bytes(), 0644)
}

func ensureContextImport(node *ast.File) {
	for _, imp := range node.Imports {
		if imp.Path.Value == `"context"` {
			return // Already imported
		}
	}

	// Add import
	contextImport := &ast.ImportSpec{
		Path: &ast.BasicLit{
			Kind:  token.STRING,
			Value: `"context"`,
		},
	}

	// Find or create import declaration
	for _, decl := range node.Decls {
		genDecl, ok := decl.(*ast.GenDecl)
		if !ok || genDecl.Tok != token.IMPORT {
			continue
		}
		genDecl.Specs = append(genDecl.Specs, contextImport)
		return
	}

	// Create new import block
	importDecl := &ast.GenDecl{
		Tok:    token.IMPORT,
		Specs:  []ast.Spec{contextImport},
	}
	node.Decls = append([]ast.Decl{importDecl}, node.Decls...)
}
```

## Testing Generated Code

```go
// generator/generator_test.go
package generator_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/compiler/protogen"
)

func TestGenerateFileMatchesGolden(t *testing.T) {
	// Run protoc with our plugin against testdata/api.proto
	tmpDir := t.TempDir()

	cmd := exec.Command("protoc",
		"--proto_path=testdata",
		"--go-http_out="+tmpDir,
		"--go-http_opt=paths=source_relative",
		"testdata/api.proto",
	)
	cmd.Env = append(os.Environ(),
		"PATH="+filepath.Join("..", "..", "bin")+":"+os.Getenv("PATH"),
	)
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, "protoc failed: %s", string(output))

	// Compare with golden file
	generated, err := os.ReadFile(filepath.Join(tmpDir, "api_http_gen.go"))
	require.NoError(t, err)

	golden, err := os.ReadFile("testdata/api_http_gen.go.golden")
	require.NoError(t, err)

	// Normalize line endings
	genStr := strings.ReplaceAll(string(generated), "\r\n", "\n")
	goldenStr := strings.ReplaceAll(string(golden), "\r\n", "\n")

	if !assert.Equal(t, goldenStr, genStr) {
		// Update golden file if UPDATE_GOLDEN=1
		if os.Getenv("UPDATE_GOLDEN") == "1" {
			os.WriteFile("testdata/api_http_gen.go.golden", generated, 0644)
			t.Log("Updated golden file. Re-run test.")
		} else {
			t.Log("Run 'UPDATE_GOLDEN=1 go test' to update golden files.")
		}
	}
}

func TestGeneratedCodeCompiles(t *testing.T) {
	// Ensure generated code compiles
	tmpDir := t.TempDir()

	// Run generation
	// ... (same as above)

	// Try to build the generated code
	cmd := exec.Command("go", "build", tmpDir+"/...")
	output, err := cmd.CombinedOutput()
	require.NoError(t, err, "generated code does not compile: %s", string(output))
}
```

## Key Takeaways

Go code generation is most effective when applied systematically to eliminate entire categories of repetitive code:

1. **protoc plugins eliminate protocol boilerplate**: Writing a plugin that generates HTTP adapters, validation, or OpenAPI specs from `.proto` files creates a single source of truth — the `.proto` file — and eliminates hand-written glue code.

2. **Golden file testing is non-negotiable**: Generator tests must compare output against known-good golden files. Without this, refactoring the generator has no safety net.

3. **go/ast for migration scripts**: AST rewriting is the right tool for large-scale refactoring across a codebase (adding context parameters, migrating error handling patterns) that would be impractical with sed/awk.

4. **jen produces correct code**: Hand-building strings for code generation creates whitespace bugs and import management issues. `jen` handles formatting and imports correctly and produces gofmt-compliant output.

5. **CI must verify generation is current**: The `make check-generated` pattern — regenerate and `git diff` — catches cases where `.proto` files changed but generated code was not committed.

6. **Annotate generated files clearly**: `// Code generated ... DO NOT EDIT.` at the top is recognized by Go tooling and enables `gopls` to skip generated files in refactoring operations.

7. **Keep generators simple and testable**: A generator that is itself complex becomes a maintenance burden. Favor templates for complex formatting over programmatic string building.
