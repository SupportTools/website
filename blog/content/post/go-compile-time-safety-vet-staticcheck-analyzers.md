---
title: "Go Compile-Time Safety: go vet, staticcheck, and Custom Analyzers with analysis.Analyzer"
date: 2030-02-23T00:00:00-05:00
draft: false
tags: ["Go", "Static Analysis", "go vet", "staticcheck", "Code Quality", "analysis.Analyzer"]
categories: ["Go", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Build production-grade custom Go analyzers using the analysis.Analyzer framework, integrate staticcheck rules, and enforce project-specific conventions at compile time."
more_link: "yes"
url: "/go-compile-time-safety-vet-staticcheck-analyzers/"
---

Static analysis is one of the most cost-effective investments a Go team can make. Catching bugs before tests run, before PRs merge, and before deployments happen saves hours of debugging and prevents production incidents. Go's `analysis` package provides a principled framework for building custom analyzers that enforce your team's specific conventions — the same framework used by `go vet`, `staticcheck`, and `gopls` themselves.

This guide covers writing custom analysis passes, integrating staticcheck rules into your pipeline, and testing analyzers with the `analysistest` package so they remain reliable as your codebase evolves.

<!--more-->

## Why Custom Analyzers Belong in Enterprise Go Projects

Every Go team accumulates project-specific conventions that are difficult to enforce through code review alone. These might include:

- All `http.Handler` functions must check the `X-Request-ID` header
- Context must be the first argument in every exported function
- Certain error types must always be wrapped with `fmt.Errorf("%w", err)`
- Internal packages must not import external packages directly
- SQL queries must use parameterized statements

Code reviews catch some of these violations, but they rely on human attention in a pull request window. Custom analyzers run on every `go build`, in every CI pipeline, and inside every developer's editor through `gopls`. The feedback loop shrinks from hours to milliseconds.

## The analysis.Analyzer Framework

The `golang.org/x/tools/go/analysis` package defines the `Analyzer` type:

```go
type Analyzer struct {
    Name       string
    Doc        string
    Flags      flag.FlagSet
    Run        func(*Pass) (interface{}, error)
    Requires   []*Analyzer
    ResultType reflect.Type
    FactTypes  []Fact
}
```

An `Analyzer` declares what it needs (`Requires`), what it produces (`ResultType`, `FactTypes`), and how it works (`Run`). The framework handles dependency ordering, package loading, and result caching automatically.

The `Pass` parameter to `Run` provides everything the analyzer needs:

```go
type Pass struct {
    Fset         *token.FileSet
    Files        []*ast.File
    OtherFiles   []string
    Pkg          *types.Package
    TypesInfo    *types.Info
    ResultOf     map[*Analyzer]interface{}
    Report       func(Diagnostic)
    Reportf      func(pos token.Pos, format string, args ...interface{})
    ImportPackageFact func(pkg *types.Package, fact Fact) bool
    ExportPackageFact func(fact Fact)
    ImportObjectFact  func(obj types.Object, fact Fact) bool
    ExportObjectFact  func(obj types.Object, fact Fact)
    AllPackageFacts   func() []PackageFact
    AllObjectFacts    func() []ObjectFact
}
```

## Setting Up an Analyzer Project

Organize your analyzers as a standalone module that can be used both as a `go vet` plugin and as a standalone binary.

```
myproject-lint/
├── go.mod
├── cmd/
│   └── myproject-lint/
│       └── main.go          # standalone binary
├── pkg/
│   ├── analyzer/
│   │   ├── contextfirst/
│   │   │   ├── analyzer.go
│   │   │   └── analyzer_test.go
│   │   ├── errwrap/
│   │   │   ├── analyzer.go
│   │   │   └── analyzer_test.go
│   │   └── noimportcycle/
│   │       ├── analyzer.go
│   │       └── analyzer_test.go
│   └── passes/
│       └── all.go           # registers all analyzers
└── testdata/
    ├── contextfirst/
    │   └── testdata.go
    └── errwrap/
        └── testdata.go
```

```go
// go.mod
module github.com/myorg/myproject-lint

go 1.22

require (
    golang.org/x/tools v0.19.0
)
```

## Writing Your First Analyzer: Context First

This analyzer enforces that the first parameter of every exported function accepting `context.Context` must actually be named `ctx` and be of type `context.Context` (not buried as a second or third parameter).

```go
// pkg/analyzer/contextfirst/analyzer.go
package contextfirst

import (
    "go/ast"
    "go/types"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

const Doc = `contextfirst checks that context.Context is the first parameter of exported functions.

Per the Go convention documented at https://pkg.go.dev/context, context.Context
should be the first parameter, conventionally named ctx. This analyzer reports
exported functions that accept context.Context but not as the first parameter.`

var Analyzer = &analysis.Analyzer{
    Name:     "contextfirst",
    Doc:      Doc,
    Run:      run,
    Requires: []*analysis.Analyzer{inspect.Analyzer},
}

func run(pass *analysis.Pass) (interface{}, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    // Obtain the context.Context type for comparison
    ctxType := contextType(pass)
    if ctxType == nil {
        // context package not imported, nothing to check
        return nil, nil
    }

    nodeFilter := []ast.Node{
        (*ast.FuncDecl)(nil),
    }

    insp.Preorder(nodeFilter, func(n ast.Node) {
        fn, ok := n.(*ast.FuncDecl)
        if !ok || fn.Name == nil {
            return
        }

        // Only check exported functions
        if !fn.Name.IsExported() {
            return
        }

        if fn.Type.Params == nil || len(fn.Type.Params.List) == 0 {
            return
        }

        // Find which parameter positions have context.Context
        ctxPositions := []int{}
        allParams := flattenParams(fn.Type.Params.List)

        for i, param := range allParams {
            if isContextType(pass, param.Type, ctxType) {
                ctxPositions = append(ctxPositions, i)
            }
        }

        if len(ctxPositions) == 0 {
            return // No context parameter, nothing to check
        }

        // If context is present but not in position 0, report
        if ctxPositions[0] != 0 {
            pass.Reportf(fn.Pos(),
                "exported function %s takes context.Context but it is not the first parameter (found at position %d)",
                fn.Name.Name, ctxPositions[0]+1,
            )
        }

        // If there are multiple context parameters, that's also suspicious
        if len(ctxPositions) > 1 {
            pass.Reportf(fn.Pos(),
                "exported function %s takes multiple context.Context parameters",
                fn.Name.Name,
            )
        }
    })

    return nil, nil
}

// flattenParams expands field lists into individual parameters.
// In Go AST, multiple params of the same type can share one ast.Field.
func flattenParams(fields []*ast.Field) []paramEntry {
    var result []paramEntry
    for _, field := range fields {
        if len(field.Names) == 0 {
            // Unnamed parameter
            result = append(result, paramEntry{Type: field.Type})
        } else {
            for _, name := range field.Names {
                result = append(result, paramEntry{Name: name, Type: field.Type})
            }
        }
    }
    return result
}

type paramEntry struct {
    Name *ast.Ident
    Type ast.Expr
}

// contextType returns the *types.Interface for context.Context.
func contextType(pass *analysis.Pass) *types.Interface {
    pkg := pass.Pkg
    if pkg == nil {
        return nil
    }
    // Look through imports for the context package
    for _, imp := range pkg.Imports() {
        if imp.Path() == "context" {
            obj := imp.Scope().Lookup("Context")
            if obj == nil {
                return nil
            }
            iface, ok := obj.Type().Underlying().(*types.Interface)
            if !ok {
                return nil
            }
            return iface
        }
    }
    return nil
}

// isContextType returns true if expr's type implements context.Context.
func isContextType(pass *analysis.Pass, expr ast.Expr, ctxIface *types.Interface) bool {
    t := pass.TypesInfo.TypeOf(expr)
    if t == nil {
        return false
    }
    return types.Implements(t, ctxIface) || types.Implements(types.NewPointer(t), ctxIface)
}
```

### Testing the Analyzer

The `analysistest` package lets you write test data as Go source files with special `// want` comments:

```go
// pkg/analyzer/contextfirst/analyzer_test.go
package contextfirst_test

import (
    "testing"

    "golang.org/x/tools/go/analysis/analysistest"
    "github.com/myorg/myproject-lint/pkg/analyzer/contextfirst"
)

func TestContextFirst(t *testing.T) {
    analysistest.Run(t, analysistest.TestData(), contextfirst.Analyzer, "contextfirst")
}
```

```go
// testdata/src/contextfirst/testdata.go
package contextfirst

import "context"

// Good: context is first
func GoodHandler(ctx context.Context, userID string) error {
    return nil
}

// Good: no context at all
func NoContext(userID string) error {
    return nil
}

// Bad: context is second parameter
func BadHandler(userID string, ctx context.Context) error { // want `exported function BadHandler takes context.Context but it is not the first parameter`
    return nil
}

// Bad: multiple contexts
func MultiCtx(ctx context.Context, ctx2 context.Context) error { // want `exported function MultiCtx takes multiple context.Context parameters`
    return nil
}

// OK: unexported function, not checked
func internalHelper(userID string, ctx context.Context) error {
    return nil
}
```

Run with:

```bash
go test ./pkg/analyzer/contextfirst/...
```

## Writing an Error Wrapping Analyzer

This analyzer enforces that `fmt.Errorf` calls that wrap errors always use the `%w` verb, not `%v` or `%s`.

```go
// pkg/analyzer/errwrap/analyzer.go
package errwrap

import (
    "go/ast"
    "go/types"
    "strings"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

const Doc = `errwrap checks that fmt.Errorf uses %%w when wrapping errors.

Using %%v or %%s with fmt.Errorf discards the original error type and prevents
callers from using errors.Is and errors.As. This analyzer reports fmt.Errorf
calls that include an error argument but do not use the %%w verb.`

var Analyzer = &analysis.Analyzer{
    Name:     "errwrap",
    Doc:      Doc,
    Run:      run,
    Requires: []*analysis.Analyzer{inspect.Analyzer},
}

func run(pass *analysis.Pass) (interface{}, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    nodeFilter := []ast.Node{
        (*ast.CallExpr)(nil),
    }

    // Get the error interface type
    errorIface := types.Universe.Lookup("error").Type().Underlying().(*types.Interface)

    insp.Preorder(nodeFilter, func(n ast.Node) {
        call, ok := n.(*ast.CallExpr)
        if !ok {
            return
        }

        // Check if this is fmt.Errorf
        if !isFmtErrorf(pass, call) {
            return
        }

        if len(call.Args) < 2 {
            return // fmt.Errorf with no args beyond format string
        }

        // Check if any argument implements error
        hasErrorArg := false
        for _, arg := range call.Args[1:] {
            t := pass.TypesInfo.TypeOf(arg)
            if t != nil && types.Implements(t, errorIface) {
                hasErrorArg = true
                break
            }
        }

        if !hasErrorArg {
            return // No error argument, nothing to check
        }

        // Extract the format string
        formatStr, ok := stringLiteral(call.Args[0])
        if !ok {
            return // Dynamic format string, cannot analyze
        }

        // Check if %w is used
        if !strings.Contains(formatStr, "%w") {
            pass.Reportf(call.Pos(),
                "fmt.Errorf wraps an error but does not use %%w verb (found: %q); use %%w to preserve error chain",
                formatStr,
            )
        }
    })

    return nil, nil
}

// isFmtErrorf returns true if call is fmt.Errorf.
func isFmtErrorf(pass *analysis.Pass, call *ast.CallExpr) bool {
    sel, ok := call.Fun.(*ast.SelectorExpr)
    if !ok {
        return false
    }
    if sel.Sel.Name != "Errorf" {
        return false
    }
    pkgIdent, ok := sel.X.(*ast.Ident)
    if !ok {
        return false
    }
    obj := pass.TypesInfo.ObjectOf(pkgIdent)
    if obj == nil {
        return false
    }
    pkgName, ok := obj.(*types.PkgName)
    if !ok {
        return false
    }
    return pkgName.Imported().Path() == "fmt"
}

// stringLiteral extracts the string value from a basic string literal.
func stringLiteral(expr ast.Expr) (string, bool) {
    lit, ok := expr.(*ast.BasicLit)
    if !ok {
        return "", false
    }
    // Remove surrounding quotes
    s := lit.Value
    if len(s) >= 2 && s[0] == '"' {
        return s[1 : len(s)-1], true
    }
    return "", false
}
```

```go
// testdata/src/errwrap/testdata.go
package errwrap

import (
    "errors"
    "fmt"
)

var ErrBase = errors.New("base error")

// Good: uses %w
func GoodWrap(err error) error {
    return fmt.Errorf("operation failed: %w", err)
}

// Bad: uses %v with error
func BadVerbV(err error) error {
    return fmt.Errorf("operation failed: %v", err) // want `fmt.Errorf wraps an error but does not use %w verb`
}

// Bad: uses %s with error
func BadVerbS(err error) error {
    return fmt.Errorf("operation failed: %s", err) // want `fmt.Errorf wraps an error but does not use %w verb`
}

// Good: no error argument
func NoError(code int) error {
    return fmt.Errorf("error code: %d", code)
}
```

## Writing a Facts-Based Analyzer: Tracking Across Package Boundaries

Facts allow analyzers to export information that other packages can consume. This example tracks which functions are "context-safe" (they properly propagate context) across package boundaries.

```go
// pkg/analyzer/ctxpropagate/analyzer.go
package ctxpropagate

import (
    "go/ast"
    "go/types"
    "reflect"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

// ContextSafeFact is exported for functions that properly propagate context.
type ContextSafeFact struct{}

func (f *ContextSafeFact) AFact() {}
func (f *ContextSafeFact) String() string { return "ContextSafe" }

var Analyzer = &analysis.Analyzer{
    Name:      "ctxpropagate",
    Doc:       "checks that context is properly propagated through call chains",
    Run:       run,
    Requires:  []*analysis.Analyzer{inspect.Analyzer},
    FactTypes: []analysis.Fact{(*ContextSafeFact)(nil)},
    ResultType: reflect.TypeOf(map[*types.Func]bool{}),
}

func run(pass *analysis.Pass) (interface{}, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)
    result := map[*types.Func]bool{}

    nodeFilter := []ast.Node{(*ast.FuncDecl)(nil)}

    insp.Preorder(nodeFilter, func(n ast.Node) {
        fn, ok := n.(*ast.FuncDecl)
        if !ok || fn.Body == nil {
            return
        }

        obj, ok := pass.TypesInfo.Defs[fn.Name]
        if !ok {
            return
        }
        funcObj, ok := obj.(*types.Func)
        if !ok {
            return
        }

        // Check if this function receives a context
        if !receivesContext(pass, fn) {
            return
        }

        // Check if it passes context down to all called functions that need it
        if propagatesContext(pass, fn) {
            pass.ExportObjectFact(funcObj, &ContextSafeFact{})
            result[funcObj] = true
        }
    })

    return result, nil
}

func receivesContext(pass *analysis.Pass, fn *ast.FuncDecl) bool {
    if fn.Type.Params == nil {
        return false
    }
    for _, field := range fn.Type.Params.List {
        if isContextExpr(pass, field.Type) {
            return true
        }
    }
    return false
}

func isContextExpr(pass *analysis.Pass, expr ast.Expr) bool {
    t := pass.TypesInfo.TypeOf(expr)
    if t == nil {
        return false
    }
    named, ok := t.(*types.Named)
    if !ok {
        return false
    }
    return named.Obj().Pkg().Path() == "context" && named.Obj().Name() == "Context"
}

func propagatesContext(pass *analysis.Pass, fn *ast.FuncDecl) bool {
    // Simplified check: look for at least one call passing a context variable
    hasContextCall := false
    ast.Inspect(fn.Body, func(n ast.Node) bool {
        call, ok := n.(*ast.CallExpr)
        if !ok {
            return true
        }
        for _, arg := range call.Args {
            if isContextExpr(pass, arg) {
                hasContextCall = true
                return false
            }
        }
        return true
    })
    return hasContextCall
}
```

## Integrating staticcheck

staticcheck provides over 150 analyzers covering correctness, performance, and code style. Integrating it into your CI pipeline alongside custom analyzers:

### Installing staticcheck

```bash
go install honnef.co/go/tools/cmd/staticcheck@latest
```

### Configuration File

```yaml
# staticcheck.conf (placed in project root)
checks = [
    "all",
    "-ST1000",   # disable: at least one file in a package must have a doc comment
    "-ST1003",   # disable: follow Go naming conventions (too strict for some teams)
    "-SA1019",   # disable: deprecated symbols (manage separately)
]

initialisms = ["URL", "HTTP", "HTTPS", "ID", "SQL", "API", "AWS", "GCP", "JSON", "XML"]
dot_import_whitelist = []
http_status_code_whitelist = ["200", "400", "404", "500"]
```

### Key staticcheck Check Categories

```
SA - staticcheck (correctness, bugs)
  SA1001: Invalid format string
  SA1006: Printf with dynamic first argument
  SA1019: Using deprecated function, variable, or type
  SA4000: Binary expression with identical sides
  SA4006: Unused variable
  SA9003: Empty body in an if or else branch

S  - simple (code simplification)
  S1000: Use plain channel send or receive
  S1001: Replace for loop with call to copy
  S1039: Unnecessary use of fmt.Sprint

ST - stylecheck (style issues)
  ST1000: Package-level doc comments
  ST1020: Exported functions must have documentation
  ST1021: Exported types must have documentation

QF - quickfix (quick fix suggestions)
  QF1001: Apply De Morgan's law
  QF1006: Lift if+break into loop condition
```

### Running staticcheck with Custom Analyzers Together

Create a unified lint runner:

```go
// cmd/myproject-lint/main.go
package main

import (
    "golang.org/x/tools/go/analysis/multichecker"

    // Standard Go analysis passes
    "golang.org/x/tools/go/analysis/passes/asmdecl"
    "golang.org/x/tools/go/analysis/passes/assign"
    "golang.org/x/tools/go/analysis/passes/atomic"
    "golang.org/x/tools/go/analysis/passes/bools"
    "golang.org/x/tools/go/analysis/passes/buildtag"
    "golang.org/x/tools/go/analysis/passes/cgocall"
    "golang.org/x/tools/go/analysis/passes/composite"
    "golang.org/x/tools/go/analysis/passes/copylock"
    "golang.org/x/tools/go/analysis/passes/errorsas"
    "golang.org/x/tools/go/analysis/passes/httpresponse"
    "golang.org/x/tools/go/analysis/passes/ifaceassert"
    "golang.org/x/tools/go/analysis/passes/loopclosure"
    "golang.org/x/tools/go/analysis/passes/lostcancel"
    "golang.org/x/tools/go/analysis/passes/nilfunc"
    "golang.org/x/tools/go/analysis/passes/printf"
    "golang.org/x/tools/go/analysis/passes/shadow"
    "golang.org/x/tools/go/analysis/passes/shift"
    "golang.org/x/tools/go/analysis/passes/stdmethods"
    "golang.org/x/tools/go/analysis/passes/stringintconv"
    "golang.org/x/tools/go/analysis/passes/structtag"
    "golang.org/x/tools/go/analysis/passes/testinggoroutine"
    "golang.org/x/tools/go/analysis/passes/tests"
    "golang.org/x/tools/go/analysis/passes/unmarshal"
    "golang.org/x/tools/go/analysis/passes/unreachable"
    "golang.org/x/tools/go/analysis/passes/unsafeptr"
    "golang.org/x/tools/go/analysis/passes/unusedresult"

    // staticcheck analyzers
    "honnef.co/go/tools/simple"
    "honnef.co/go/tools/staticcheck"
    "honnef.co/go/tools/stylecheck"

    // Custom analyzers
    "github.com/myorg/myproject-lint/pkg/analyzer/contextfirst"
    "github.com/myorg/myproject-lint/pkg/analyzer/errwrap"
    "github.com/myorg/myproject-lint/pkg/analyzer/ctxpropagate"
)

func main() {
    var analyzers []*analysis.Analyzer

    // Add standard vet analyzers
    analyzers = append(analyzers,
        asmdecl.Analyzer,
        assign.Analyzer,
        atomic.Analyzer,
        bools.Analyzer,
        buildtag.Analyzer,
        cgocall.Analyzer,
        composite.Analyzer,
        copylock.Analyzer,
        errorsas.Analyzer,
        httpresponse.Analyzer,
        ifaceassert.Analyzer,
        loopclosure.Analyzer,
        lostcancel.Analyzer,
        nilfunc.Analyzer,
        printf.Analyzer,
        shadow.Analyzer,
        shift.Analyzer,
        stdmethods.Analyzer,
        stringintconv.Analyzer,
        structtag.Analyzer,
        testinggoroutine.Analyzer,
        tests.Analyzer,
        unmarshal.Analyzer,
        unreachable.Analyzer,
        unsafeptr.Analyzer,
        unusedresult.Analyzer,
    )

    // Add staticcheck analyzers
    for _, a := range staticcheck.Analyzers {
        analyzers = append(analyzers, a.Analyzer)
    }
    for _, a := range simple.Analyzers {
        analyzers = append(analyzers, a.Analyzer)
    }
    for _, a := range stylecheck.Analyzers {
        analyzers = append(analyzers, a.Analyzer)
    }

    // Add custom analyzers
    analyzers = append(analyzers,
        contextfirst.Analyzer,
        errwrap.Analyzer,
        ctxpropagate.Analyzer,
    )

    multichecker.Main(analyzers...)
}
```

Build and use:

```bash
go build -o myproject-lint ./cmd/myproject-lint/
./myproject-lint ./...
```

## Using go vet with Analysis Plugins

Go 1.12+ supports running custom analyzers via `go vet -vettool`:

```bash
# Build your analyzer as a standalone binary
go build -o myproject-lint ./cmd/myproject-lint/

# Run as a vet tool
go vet -vettool=$(pwd)/myproject-lint ./...
```

This integrates with `go test` as well:

```bash
go test -vet=$(pwd)/myproject-lint ./...
```

## Writing an AST-Based Convention Enforcer

This more complex example enforces that all SQL query strings in the codebase use named parameters (`:param`) rather than positional parameters (`?` or `$1`):

```go
// pkg/analyzer/sqlparam/analyzer.go
package sqlparam

import (
    "go/ast"
    "go/token"
    "regexp"
    "strings"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

const Doc = `sqlparam enforces named parameters in SQL queries.

Positional parameters (? or $1) make queries harder to read and maintain.
This analyzer reports SQL query strings that use positional parameters.`

var Analyzer = &analysis.Analyzer{
    Name:     "sqlparam",
    Doc:      Doc,
    Run:      run,
    Requires: []*analysis.Analyzer{inspect.Analyzer},
}

// Patterns that suggest a string is a SQL query
var sqlKeywords = regexp.MustCompile(`(?i)\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b`)

// Positional parameter patterns
var positionalParam = regexp.MustCompile(`\?|\$[0-9]+`)

// Named parameter pattern (allowed)
var namedParam = regexp.MustCompile(`:[a-zA-Z_][a-zA-Z0-9_]*`)

func run(pass *analysis.Pass) (interface{}, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    nodeFilter := []ast.Node{
        (*ast.BasicLit)(nil),
        (*ast.AssignStmt)(nil),
    }

    insp.Preorder(nodeFilter, func(n ast.Node) {
        lit, ok := n.(*ast.BasicLit)
        if !ok {
            return
        }

        if lit.Kind != token.STRING {
            return
        }

        // Strip quotes
        s := strings.Trim(lit.Value, "`\"")

        // Check if this looks like a SQL query
        if !sqlKeywords.MatchString(s) {
            return
        }

        // Report positional parameters
        if positionalParam.MatchString(s) {
            pass.Reportf(lit.Pos(),
                "SQL query uses positional parameters; use named parameters (e.g., :user_id) instead",
            )
        }
    })

    return nil, nil
}
```

## Configurable Analyzers with Flags

Analyzers can accept configuration through flags:

```go
// pkg/analyzer/maxfunclen/analyzer.go
package maxfunclen

import (
    "go/ast"
    "go/token"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

var maxLines int

var Analyzer = &analysis.Analyzer{
    Name:     "maxfunclen",
    Doc:      "checks that functions do not exceed a maximum line count",
    Run:      run,
    Requires: []*analysis.Analyzer{inspect.Analyzer},
}

func init() {
    Analyzer.Flags.IntVar(&maxLines, "max-lines", 80,
        "maximum number of lines allowed in a function body")
}

func run(pass *analysis.Pass) (interface{}, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    nodeFilter := []ast.Node{(*ast.FuncDecl)(nil)}

    insp.Preorder(nodeFilter, func(n ast.Node) {
        fn, ok := n.(*ast.FuncDecl)
        if !ok || fn.Body == nil {
            return
        }

        start := pass.Fset.Position(fn.Body.Lbrace)
        end := pass.Fset.Position(fn.Body.Rbrace)
        lineCount := end.Line - start.Line

        if lineCount > maxLines {
            pass.Reportf(fn.Pos(),
                "function %s has %d lines (max %d); consider breaking it into smaller functions",
                fn.Name.Name, lineCount, maxLines,
            )
        }
    })

    return nil, nil
}
```

Usage:

```bash
./myproject-lint -maxfunclen.max-lines=100 ./...
```

## CI/CD Integration

### Makefile Targets

```makefile
.PHONY: lint vet staticcheck custom-lint

lint: vet staticcheck custom-lint

vet:
	go vet ./...

staticcheck:
	staticcheck -checks=all,-ST1000 ./...

custom-lint: build-lint
	./bin/myproject-lint ./...

build-lint:
	go build -o bin/myproject-lint ./cmd/myproject-lint/

# Run all linters with the golangci-lint aggregator
golangci:
	golangci-lint run --config .golangci.yml ./...
```

### golangci-lint Integration

```yaml
# .golangci.yml
run:
  timeout: 5m
  go: "1.22"

linters:
  enable:
    - errcheck
    - gosimple
    - govet
    - ineffassign
    - staticcheck
    - unused
    - bodyclose
    - contextcheck
    - exhaustive
    - gocritic
    - gocyclo
    - godot
    - gofmt
    - goimports
    - gosec
    - misspell
    - noctx
    - rowserrcheck
    - sqlclosecheck
    - unconvert
    - unparam
    - whitespace

linters-settings:
  gocyclo:
    min-complexity: 15
  gocritic:
    enabled-tags:
      - diagnostic
      - experimental
      - opinionated
      - performance
      - style
  gosec:
    excludes:
      - G204  # subprocess with variable args (often intentional)
  staticcheck:
    checks:
      - "all"
      - "-SA1019"  # deprecated (managed separately)

issues:
  exclude-rules:
    - path: "_test.go"
      linters:
        - gosec
        - unparam
    - path: "cmd/"
      linters:
        - gocyclo
```

### GitHub Actions Workflow

```yaml
# .github/workflows/lint.yml
name: Lint

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true

      - name: Build custom linter
        run: go build -o bin/myproject-lint ./cmd/myproject-lint/

      - name: Run go vet
        run: go vet ./...

      - name: Run custom analyzers
        run: ./bin/myproject-lint ./...

      - name: Run staticcheck
        uses: dominikh/staticcheck-action@v1
        with:
          version: "2024.1"
          checks: "all,-ST1000"

      - name: Run golangci-lint
        uses: golangci/golangci-lint-action@v4
        with:
          version: v1.57
          args: --timeout=5m
```

## Testing Analyzers Thoroughly

### Table-Driven Analyzer Tests

```go
// pkg/analyzer/errwrap/analyzer_test.go
package errwrap_test

import (
    "testing"

    "golang.org/x/tools/go/analysis/analysistest"
    "github.com/myorg/myproject-lint/pkg/analyzer/errwrap"
)

func TestErrWrap(t *testing.T) {
    // Run against all testdata packages
    analysistest.Run(t, analysistest.TestData(), errwrap.Analyzer,
        "errwrap",
        "errwrap_generics",  // Test with generics
        "errwrap_stdlib",    // Test with stdlib errors
    )
}

func TestErrWrapSuggestedFixes(t *testing.T) {
    // Test that suggested fixes are correct
    analysistest.RunWithSuggestedFixes(t, analysistest.TestData(), errwrap.Analyzer, "errwrap")
}
```

### Suggested Fixes

Analyzers can provide automatic fix suggestions:

```go
// In your analyzer's run function, replace Reportf with:
pass.Report(analysis.Diagnostic{
    Pos:     call.Pos(),
    End:     call.End(),
    Message: "fmt.Errorf wraps an error but does not use %w verb",
    SuggestedFixes: []analysis.SuggestedFix{
        {
            Message: "Replace %v with %w",
            TextEdits: []analysis.TextEdit{
                {
                    Pos:     formatLit.Pos(),
                    End:     formatLit.End(),
                    NewText: []byte(`"` + strings.ReplaceAll(formatStr, "%v", "%w") + `"`),
                },
            },
        },
    },
})
```

Apply fixes automatically:

```bash
./myproject-lint -fix ./...
```

## Performance Considerations for Analyzers

Analyzers that traverse large codebases need to be efficient:

```go
// Use the inspector's NodeFilter to avoid visiting irrelevant nodes
// BAD: visits every node
ast.Inspect(file, func(n ast.Node) bool {
    // process nodes
    return true
})

// GOOD: only visits specified node types
nodeFilter := []ast.Node{
    (*ast.FuncDecl)(nil),
    (*ast.CallExpr)(nil),
}
insp.Preorder(nodeFilter, func(n ast.Node) {
    // process nodes
})

// Use facts for cross-package information instead of re-analyzing
// Export a fact once, import it in dependent packages

// Cache expensive computations in the analyzer's result
// Other analyzers that Require this one get the cached result
```

### Benchmark Analyzers

```go
func BenchmarkContextFirst(b *testing.B) {
    cfg := &packages.Config{
        Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax |
              packages.NeedTypes | packages.NeedTypesInfo,
        Tests: true,
    }

    pkgs, err := packages.Load(cfg, "./...")
    if err != nil {
        b.Fatal(err)
    }

    b.ResetTimer()
    for i := 0; i < b.N; i++ {
        _ = analysis.Analyze([]*analysis.Analyzer{contextfirst.Analyzer}, pkgs, nil)
    }
}
```

## Key Takeaways

Building custom Go analyzers with the `analysis.Analyzer` framework provides:

1. **Compile-time enforcement**: Rules run during every build, not just in CI
2. **IDE integration**: `gopls` runs analyzers in real-time as developers write code
3. **Cross-package analysis**: Facts allow tracking properties across package boundaries
4. **Testable rules**: The `analysistest` package makes analyzer behavior verifiable
5. **Composable pipeline**: Standard vet, staticcheck, and custom analyzers run together via `multichecker`

Start small: pick the one convention violation that costs your team the most review time, write an analyzer for it, and integrate it into your CI pipeline. The investment pays back quickly when developers get immediate feedback in their editors rather than during code review.

The analyzer source code lives alongside your application code, evolves with your conventions, and documents your team's standards in executable form. That combination of automation and documentation is difficult to achieve with any other approach.
