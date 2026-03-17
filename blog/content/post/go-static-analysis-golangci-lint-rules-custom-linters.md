---
title: "Go Static Analysis: golangci-lint Rules and Custom Linters"
date: 2029-09-03T00:00:00-05:00
draft: false
tags: ["Go", "Static Analysis", "golangci-lint", "Code Quality", "Security", "DevOps", "CI/CD"]
categories: ["Go", "DevOps", "Code Quality"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Go static analysis covering golangci-lint configuration, essential linters including staticcheck, errcheck, and gosec, writing custom analyzers with the go/analysis framework, and integrating static analysis into CI/CD pipelines."
more_link: "yes"
url: "/go-static-analysis-golangci-lint-rules-custom-linters/"
---

Static analysis catches entire classes of bugs before code reaches production. For Go specifically, the `go/analysis` framework and the ecosystem of linters in `golangci-lint` provide coverage that the compiler cannot: unused error returns, unsafe type assertions, race conditions, security vulnerabilities, and organizational code standard violations. This guide builds from basic configuration through writing a production-grade custom analyzer.

<!--more-->

# Go Static Analysis: golangci-lint Rules and Custom Linters

## Section 1: Why Static Analysis Matters in Go

Go's design makes certain bugs harder to write — no implicit type coercions, no undefined behavior from integer overflow — but it also leaves important error paths entirely to the programmer's discipline. The most common Go bugs that reach production are:

1. **Ignored errors**: `f, _ := os.Open(...)` — silently discarding errors
2. **Nil pointer dereferences**: Accessing fields on potentially-nil interface values
3. **Data races**: Accessing shared state without synchronization
4. **Context leaks**: Not cancelling contexts, leading to goroutine leaks
5. **Shadowed variables**: Short variable declarations that shadow outer scope
6. **Unchecked type assertions**: `v := i.(SomeType)` panics on type mismatch
7. **SQL injection**: String concatenation in SQL queries

Static analysis catches these at code review time rather than in production monitoring.

## Section 2: golangci-lint Configuration

`golangci-lint` is the standard meta-linter for Go, aggregating 100+ individual linters behind a single binary and configuration file.

### Installation

```bash
# Install the latest stable version
curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | \
  sh -s -- -b $(go env GOPATH)/bin v1.62.0

# Verify installation
golangci-lint --version
# golangci-lint has version 1.62.0

# Or install via Go (slower but ensures version matches go.mod)
go install github.com/golangci/golangci-lint/cmd/golangci-lint@v1.62.0
```

### Production Configuration

```yaml
# .golangci.yml
# Version of golangci-lint config
version: "2"

run:
  # Timeout for analysis (increase for large codebases)
  timeout: 10m
  # Number of CPUs to use
  concurrency: 4
  # If false, golangci-lint will run analysis for all packages
  go: "1.22"
  # Build tags to pass to all tools
  build-tags:
    - integration
  # Which files to analyze (relative to project root)
  skip-dirs:
    - vendor
    - third_party
    - ".*_generated"
    - testdata
  # Include test files in analysis
  tests: true

linters:
  # Start with a clean slate - only enable what we explicitly configure
  disable-all: true
  enable:
    # Core Go correctness
    - errcheck        # Check that error returns are checked
    - govet           # Report suspicious code constructs
    - staticcheck     # Advanced static analysis (SA, S, QF, ST checks)
    - unused          # Check for unused code

    # Error handling
    - errorlint       # Find issues with error wrapping
    - wrapcheck       # Ensure errors from external packages are wrapped
    - nilerr          # Find code returning nil even when err != nil

    # Code style and complexity
    - cyclop          # Cyclomatic complexity check
    - gocognit        # Cognitive complexity check
    - maintidx        # Maintainability index check
    - funlen          # Function length check
    - lll             # Line length limit

    # Security
    - gosec           # Security-focused checks
    - bodyclose       # Ensure HTTP response bodies are closed
    - sqlclosecheck   # Ensure sql.Rows are closed

    # Go idioms
    - godot           # Check comment endings (period)
    - gocritic        # Opinionated Go code style checks
    - goconst         # Find string constants that could be extracted
    - godox           # Detect TODO/FIXME comments
    - noctx           # Find HTTP requests without context
    - contextcheck    # Check whether context is properly propagated
    - containedctx    # Detect context.Context embedded in structs
    - prealloc        # Suggest slice preallocation
    - ineffassign     # Detect ineffectual assignments
    - dupl            # Detect code duplication

    # Import organization
    - goimports       # Check import formatting and ordering
    - grouper         # Import group checking

    # Performance
    - makezero        # Find slice declarations that could use make with capacity
    - gosmopolitan    # Check for locale-sensitive comparisons

    # Testing
    - testifylint     # Check testify usage

    # Naming
    - revive          # Fast, configurable replacement for golint

linters-settings:
  errcheck:
    # Also check type assertions
    check-type-assertions: true
    # Also check blank assignments
    check-blank: true
    # Exclude patterns (use sparingly)
    exclude-functions:
      # Allow ignoring errors from fmt.Fprintf to stderr
      - fmt.Fprintln
      - fmt.Fprintf
      # Allow ignoring close errors for defer calls (controversial)
      # Uncomment only if your team has a policy for this
      # - (io.Closer).Close

  staticcheck:
    # Enable all staticcheck checks
    checks:
      - "all"
      # Disable specific checks that don't apply:
      # - "-SA1019"  # Ignore deprecated API usage warnings
      - "-ST1000"  # Disable package comment requirement
      - "-ST1003"  # Disable naming convention (too opinionated for mixed codebases)

  gosec:
    # Severity levels: low, medium, high
    severity: medium
    confidence: medium
    # Exclude rules that produce too many false positives in our codebase
    excludes:
      - G304  # File path provided as taint input (we sanitize paths ourselves)
      - G401  # Use of weak cryptographic primitive (we have legacy MD5 checksums)
    # Include rules that are off by default
    includes:
      - G601  # Implicit memory aliasing in for loop (important for Go < 1.22)

  govet:
    # Enable the printf analyzer
    enable:
      - printf
      - shadow
      - structtag
      - unreachable
      - unusedresult
      - loopclosure

  cyclop:
    # Maximum cyclomatic complexity allowed
    max-complexity: 15
    # Per-package average complexity
    package-average: 8.0

  gocognit:
    # Minimum complexity to report
    min-complexity: 20

  funlen:
    # Maximum function length
    lines: 80
    statements: 50

  lll:
    # Maximum line length
    line-length: 130
    # Handle tab width
    tab-width: 4

  gocritic:
    # Enable all experimental checks
    enabled-checks:
      - hugeParam
      - rangeValCopy
      - typeAssert
      - paramTypeCombine
      - unnamedResult
    disabled-checks:
      - appendAssign  # Too many false positives

  revive:
    severity: warning
    rules:
      - name: blank-imports
      - name: context-as-argument
        arguments:
          - allowTypesBefore: "*testing.T,*testing.B"
      - name: context-keys-type
      - name: dot-imports
      - name: error-return
      - name: error-strings
      - name: error-naming
      - name: exported
      - name: if-return
      - name: increment-decrement
      - name: var-naming
      - name: var-declaration
      - name: unused-parameter
      - name: unreachable-code
      - name: redefines-builtin-id

  dupl:
    # Minimum number of duplicate lines
    threshold: 150

  wrapcheck:
    # Packages whose errors should always be wrapped
    ignorePackageGlobs:
      - "github.com/myorg/app/internal/*"  # Internal packages don't need wrapping

  testifylint:
    enable-all: true

issues:
  # Maximum number of issues per linter
  max-issues-per-linter: 50
  # Maximum number of same issues
  max-same-issues: 5

  # Exclude specific issues by text pattern
  exclude-rules:
    # Exclude some linters from running on test files
    - path: "_test\\.go"
      linters:
        - funlen     # Test functions are allowed to be longer
        - dupl       # Test code duplication is acceptable
        - wrapcheck  # Tests don't need to wrap errors

    # Exclude error checking for test helpers that panic
    - path: "_test\\.go"
      text: "Error return value of .* is not checked"
      linters:
        - errcheck

    # Allow TODO comments in specific paths
    - path: "internal/legacy"
      linters:
        - godox

    # Generated code
    - path: ".*\\.pb\\.go"
      linters:
        - all

  # Use the same issues threshold as the whole codebase
  exclude-use-default: false

  # Report issues from new/modified code only (useful for gradually adopting linting)
  new: false
  # new-from-rev: "main"  # Uncomment to only lint new code since main branch
```

## Section 3: Essential Linter Deep Dives

### errcheck — The Most Important Linter

Go's error handling requires every error to be explicitly handled or explicitly ignored. `errcheck` enforces this.

```go
// BAD: errcheck will flag these
func badExamples() {
    os.Remove("/tmp/tempfile")               // Error discarded
    json.Unmarshal(data, &result)             // Error discarded
    f, _ := os.Open("/etc/passwd")            // Blank identifier with check-blank enabled
    _ = f.Close()                             // Explicit blank is fine (or not, with check-blank)

    // Defer close with no error check
    defer f.Close()  // errcheck won't flag this by default (defer pattern is common)
}

// GOOD: Explicit error handling
func goodExamples() error {
    if err := os.Remove("/tmp/tempfile"); err != nil && !os.IsNotExist(err) {
        return fmt.Errorf("removing temp file: %w", err)
    }

    if err := json.Unmarshal(data, &result); err != nil {
        return fmt.Errorf("unmarshaling response: %w", err)
    }

    f, err := os.Open("/etc/passwd")
    if err != nil {
        return fmt.Errorf("opening file: %w", err)
    }
    defer func() {
        if cerr := f.Close(); cerr != nil {
            // Log or handle close error
            slog.Error("closing file", "error", cerr)
        }
    }()

    return nil
}
```

### gosec — Security-Focused Analysis

```go
// gosec catches common security vulnerabilities:

// G101: Hardcoded credentials
const apiKey = "sk-1234567890abcdef"  // gosec: G101 Potential hardcoded credentials

// G202: SQL query building with string concatenation
func badQuery(db *sql.DB, userID string) {
    rows, _ := db.Query("SELECT * FROM users WHERE id = " + userID)  // G202: SQL injection
    _ = rows
}

// G202 fix: Use parameterized queries
func goodQuery(db *sql.DB, userID string) (*sql.Rows, error) {
    return db.QueryContext(context.Background(),
        "SELECT id, name, email FROM users WHERE id = $1", userID)
}

// G304: File path provided as taint input
func badFileRead(filename string) ([]byte, error) {
    return os.ReadFile(filename)  // G304: potential path traversal
}

// G304 fix: Sanitize and validate paths
func goodFileRead(baseDir, filename string) ([]byte, error) {
    // Ensure filename doesn't escape the base directory
    cleanPath := filepath.Clean(filepath.Join(baseDir, filename))
    if !strings.HasPrefix(cleanPath, filepath.Clean(baseDir)+string(os.PathSeparator)) {
        return nil, fmt.Errorf("invalid path: %s escapes base directory", filename)
    }
    return os.ReadFile(cleanPath)
}

// G501: Import blocklist (MD5, SHA1)
import "crypto/md5"  // G501: blocklisted import

// G501 fix: Use SHA-256 for new code; add to gosec excludes if legacy checksums needed
```

### staticcheck — Advanced Analysis

```go
// SA1006: Printf with dynamic format string
func badPrintf(msg string) {
    fmt.Printf(msg)  // SA1006: should use Println or ensure msg is a literal
}

// SA4003: Comparing unsigned integer to negative value (always false)
func alwaysFalse(n uint32) bool {
    return n < 0  // SA4003: uint32 is always >= 0
}

// SA5011: Possible nil pointer dereference
func nilDeref(s *string) string {
    if s == nil {
        return ""
    }
    return *s
}

// S1000: Use plain channel send/receive
func badSelect(ch chan int) {
    select {
    case ch <- 1:  // S1000: Use ch <- 1 directly (single case select)
    }
}

// QF1001: Apply De Morgan's law
func deMorgan(a, b bool) bool {
    return !(a || b)  // QF1001: could be written as !a && !b
}
```

## Section 4: Writing Custom Analyzers with go/analysis

The `go/analysis` package provides a framework for writing type-safe, composable static analysis passes. Custom analyzers can enforce organization-specific coding standards that no general-purpose linter covers.

### Custom Analyzer: Detect Context Passed by Value

This analyzer flags functions that accept `context.Context` by value in a struct (an anti-pattern that makes context propagation difficult).

```go
// analyzers/contextinstructs/analyzer.go
package contextinstructs

import (
    "go/ast"
    "go/types"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

// Analyzer reports context.Context fields embedded in structs.
var Analyzer = &analysis.Analyzer{
    Name:     "contextinstructs",
    Doc:      "Detect context.Context stored in struct fields",
    Run:      run,
    Requires: []*analysis.Analyzer{inspect.Analyzer},
}

func run(pass *analysis.Pass) (interface{}, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    // We only care about struct type declarations
    nodeFilter := []ast.Node{
        (*ast.StructType)(nil),
    }

    insp.Preorder(nodeFilter, func(n ast.Node) {
        structType, ok := n.(*ast.StructType)
        if !ok {
            return
        }

        for _, field := range structType.Fields.List {
            if isContextType(pass.TypesInfo, field.Type) {
                // Determine the position to report
                pos := field.Pos()
                if len(field.Names) > 0 {
                    pos = field.Names[0].Pos()
                }
                pass.Reportf(pos,
                    "context.Context should not be stored in a struct (see https://pkg.go.dev/context#pkg-overview)")
            }
        }
    })

    return nil, nil
}

func isContextType(info *types.Info, expr ast.Expr) bool {
    t := info.TypeOf(expr)
    if t == nil {
        return false
    }

    // Check if the type is context.Context interface
    named, ok := t.(*types.Named)
    if !ok {
        return false
    }

    obj := named.Obj()
    return obj.Pkg() != nil &&
        obj.Pkg().Path() == "context" &&
        obj.Name() == "Context"
}
```

### Custom Analyzer: Require Error Wrapping Pattern

This analyzer enforces that all error returns from exported functions include caller context via `fmt.Errorf("...: %w", err)`.

```go
// analyzers/errorwrapping/analyzer.go
package errorwrapping

import (
    "go/ast"
    "go/token"
    "go/types"
    "strings"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

// Analyzer reports errors returned without wrapping context.
var Analyzer = &analysis.Analyzer{
    Name:     "errorwrapping",
    Doc:      "Require error wrapping with context for exported functions",
    Run:      run,
    Requires: []*analysis.Analyzer{inspect.Analyzer},
}

func run(pass *analysis.Pass) (interface{}, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    nodeFilter := []ast.Node{
        (*ast.FuncDecl)(nil),
    }

    insp.Preorder(nodeFilter, func(n ast.Node) {
        funcDecl, ok := n.(*ast.FuncDecl)
        if !ok {
            return
        }

        // Only check exported functions
        if funcDecl.Name == nil || !funcDecl.Name.IsExported() {
            return
        }

        // Only check functions that return error
        if !returnsError(pass, funcDecl) {
            return
        }

        // Find all return statements that return a bare error variable
        ast.Inspect(funcDecl.Body, func(node ast.Node) bool {
            retStmt, ok := node.(*ast.ReturnStmt)
            if !ok {
                return true
            }

            for _, result := range retStmt.Results {
                if isBareErrorReturn(pass, result) {
                    pass.Reportf(retStmt.Pos(),
                        "exported function %s returns unwrapped error; "+
                            "use fmt.Errorf(\"<context>: %%w\", err) to add context",
                        funcDecl.Name.Name)
                }
            }
            return true
        })
    })

    return nil, nil
}

func returnsError(pass *analysis.Pass, funcDecl *ast.FuncDecl) bool {
    if funcDecl.Type.Results == nil {
        return false
    }
    for _, field := range funcDecl.Type.Results.List {
        if isErrorType(pass.TypesInfo, field.Type) {
            return true
        }
    }
    return false
}

func isBareErrorReturn(pass *analysis.Pass, expr ast.Expr) bool {
    ident, ok := expr.(*ast.Ident)
    if !ok {
        return false
    }

    obj := pass.TypesInfo.ObjectOf(ident)
    if obj == nil {
        return false
    }

    t := obj.Type()
    if !isErrorInterfaceType(t) {
        return false
    }

    // Allow returning nil error
    if ident.Name == "nil" {
        return false
    }

    return true
}

func isErrorType(info *types.Info, expr ast.Expr) bool {
    t := info.TypeOf(expr)
    return t != nil && isErrorInterfaceType(t)
}

func isErrorInterfaceType(t types.Type) bool {
    named, ok := t.(*types.Named)
    if !ok {
        return false
    }
    return named.Obj().Name() == "error" && named.Obj().Pkg() == nil
}
```

### Custom Analyzer: No Magic Numbers

```go
// analyzers/nomagiclits/analyzer.go
package nomagiclits

import (
    "go/ast"
    "go/token"
    "strconv"

    "golang.org/x/tools/go/analysis"
    "golang.org/x/tools/go/analysis/passes/inspect"
    "golang.org/x/tools/go/ast/inspector"
)

// Analyzer reports magic number literals in non-constant contexts.
var Analyzer = &analysis.Analyzer{
    Name:     "nomagiclits",
    Doc:      "Detect magic number literals that should be named constants",
    Run:      run,
    Requires: []*analysis.Analyzer{inspect.Analyzer},
}

// Allowed magic numbers (common zero/one values)
var allowedLiterals = map[string]bool{
    "0":    true,
    "1":    true,
    "-1":   true,
    "2":    true,
    "true": true,
    "false": true,
}

func run(pass *analysis.Pass) (interface{}, error) {
    insp := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector)

    nodeFilter := []ast.Node{
        (*ast.BasicLit)(nil),
    }

    insp.Preorder(nodeFilter, func(n ast.Node) {
        lit, ok := n.(*ast.BasicLit)
        if !ok {
            return
        }

        // Only check integer and float literals
        if lit.Kind != token.INT && lit.Kind != token.FLOAT {
            return
        }

        if allowedLiterals[lit.Value] {
            return
        }

        // Check if the parent is a const declaration (allowed)
        // This requires walking up the AST, which is done via the path in Preorder
        // For simplicity, check if value is > 100 (team-specific threshold)
        val, err := strconv.ParseInt(lit.Value, 0, 64)
        if err != nil {
            return
        }
        if val > 100 || val < -100 {
            pass.Reportf(lit.Pos(),
                "magic number %s: consider using a named constant", lit.Value)
        }
    })

    return nil, nil
}
```

### Running Custom Analyzers

```go
// cmd/customlint/main.go
package main

import (
    "golang.org/x/tools/go/analysis/multichecker"

    "github.com/myorg/app/analyzers/contextinstructs"
    "github.com/myorg/app/analyzers/errorwrapping"
    "github.com/myorg/app/analyzers/nomagiclits"
)

func main() {
    multichecker.Main(
        contextinstructs.Analyzer,
        errorwrapping.Analyzer,
        nomagiclits.Analyzer,
    )
}
```

```bash
# Build the custom linter
go build -o bin/customlint ./cmd/customlint/

# Run against the codebase
./bin/customlint ./...

# Integrate with golangci-lint via the custom linters feature
# .golangci.yml addition:
# linters-settings:
#   custom:
#     customlint:
#       path: ./bin/customlint
#       description: Custom organization linters
#       original-url: github.com/myorg/app/analyzers
```

## Section 5: Testing Custom Analyzers

The `analysistest` package makes testing analyzers straightforward with inline expected-diagnostic annotations.

```go
// analyzers/contextinstructs/analyzer_test.go
package contextinstructs_test

import (
    "testing"

    "golang.org/x/tools/go/analysis/analysistest"

    "github.com/myorg/app/analyzers/contextinstructs"
)

func TestAnalyzer(t *testing.T) {
    // analysistest.Run looks for test data in the testdata directory
    // and checks that reported diagnostics match // want comments
    analysistest.Run(t, analysistest.TestData(), contextinstructs.Analyzer, "a")
}
```

```go
// analyzers/contextinstructs/testdata/src/a/a.go
package a

import "context"

// BAD: context in struct field
type Server struct {
    ctx context.Context // want `context.Context should not be stored in a struct`
    db  interface{}
}

// GOOD: context passed as parameter
type Handler struct {
    db interface{}
}

func (h *Handler) Handle(ctx context.Context) error {
    return nil
}
```

## Section 6: CI/CD Integration

### GitHub Actions Pipeline

```yaml
# .github/workflows/lint.yml
name: Lint

on:
  push:
    branches: [main, release/*]
  pull_request:
    branches: [main]

jobs:
  golangci-lint:
    name: golangci-lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      # Run golangci-lint using the official action
      - uses: golangci/golangci-lint-action@v6
        with:
          version: v1.62.0
          # Only run on new/changed code (much faster for PRs)
          args: --new-from-rev=${{ github.event.pull_request.base.sha }}
          # Cache golangci-lint results
          cache: true
          # Show full output including linter names
          format: colored-line-number

  custom-linters:
    name: Custom Linters
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - name: Build custom linters
        run: go build -o bin/customlint ./cmd/customlint/

      - name: Run custom linters
        run: ./bin/customlint ./...

  govulncheck:
    name: Vulnerability Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod

      - name: Install govulncheck
        run: go install golang.org/x/vuln/cmd/govulncheck@latest

      - name: Check for vulnerabilities
        run: govulncheck ./...
```

### Pre-commit Hook Integration

```yaml
# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: golangci-lint
        name: golangci-lint
        entry: golangci-lint run --fix
        language: system
        types: [go]
        pass_filenames: false

      - id: custom-linters
        name: custom-linters
        entry: ./bin/customlint
        language: system
        types: [go]
        pass_filenames: false

      - id: go-vet
        name: go vet
        entry: go vet ./...
        language: system
        types: [go]
        pass_filenames: false
```

### Makefile Integration

```makefile
# Makefile lint targets
GOLANGCI_LINT_VERSION := v1.62.0
GOLANGCI_LINT := $(shell go env GOPATH)/bin/golangci-lint

.PHONY: lint lint-fix lint-install govulncheck custom-lint

# Install lint tools
lint-install:
	@echo "Installing golangci-lint $(GOLANGCI_LINT_VERSION)..."
	curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | \
		sh -s -- -b $(go env GOPATH)/bin $(GOLANGCI_LINT_VERSION)
	go install golang.org/x/vuln/cmd/govulncheck@latest

# Run all linters
lint: lint-install
	$(GOLANGCI_LINT) run --timeout 10m ./...
	$(MAKE) custom-lint
	$(MAKE) govulncheck

# Run linters and auto-fix issues where possible
lint-fix: lint-install
	$(GOLANGCI_LINT) run --fix ./...
	goimports -w -local github.com/myorg/app ./...

# Run only on changed files (faster for development)
lint-diff:
	$(GOLANGCI_LINT) run --new-from-rev=main ./...

# Run custom organization linters
custom-lint:
	@if [ ! -f bin/customlint ]; then \
		echo "Building custom linter..."; \
		go build -o bin/customlint ./cmd/customlint/; \
	fi
	./bin/customlint ./...

# Check for known vulnerabilities
govulncheck:
	govulncheck ./...

# Generate lint report for PR review
lint-report:
	$(GOLANGCI_LINT) run \
		--out-format json \
		./... | jq -r '.Issues[] | "\(.Pos.Filename):\(.Pos.Line): [\(.FromLinter)] \(.Text)"' \
		> lint-report.txt
	@wc -l lint-report.txt
```

## Section 7: Suppressing False Positives

```go
// Suppressing individual findings with nolint directives
// Always include the specific linter name to prevent blanket suppressions

// GOOD: Specific suppression with explanation
func computeLegacyChecksum(data []byte) string {
    // nolint:gosec // G401: Legacy MD5 checksum for backwards compat with v1 API
    h := md5.Sum(data) //nolint:gosec
    return hex.EncodeToString(h[:])
}

// GOOD: Suppressing on struct field
type config struct {
    // nolint:lll // This constant must remain on one line for grep compatibility
    AuthToken string `json:"auth_token" env:"AUTH_TOKEN_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"`
}

// BAD: Blanket suppression (never do this - it hides real issues)
// nolint

// Suppressing entire files: create .golangci-ignore or use exclude-rules in config
// For generated code, add this comment at the top of the file:
// Code generated by protoc-gen-go. DO NOT EDIT.
// golangci-lint automatically skips files with this pattern.
```

## Section 8: Baseline Configuration for Common Scenarios

### Startup Project (Minimal friction)

```yaml
# .golangci.yml for new projects
linters:
  disable-all: true
  enable:
    - errcheck
    - govet
    - staticcheck
    - ineffassign
    - unused

issues:
  exclude-use-default: false
```

### Team Project (Balanced)

Use the full configuration from Section 2, but enable `new-from-rev: main` to only report new issues on existing codebases.

### High-Security Service (Strict)

```yaml
# Additional linters for high-security services
linters:
  enable:
    # ... all linters from balanced config ...
    - exhaustive    # Ensure all enum values are handled in switch
    - exhaustruct   # Require all struct fields to be initialized
    - forbidigo     # Forbid specific function calls
    - gochecknoinits # Prohibit init() functions
    - goheader      # Check file headers
    - nilnil        # Report functions returning nil, nil
    - noctx         # Require context in HTTP requests
    - rowserrcheck  # Check SQL rows.Err() is checked
    - wastedassign  # Find wasted assignments

linters-settings:
  forbidigo:
    forbid:
      - pattern: "^(fmt\\.Print(|f|ln)|log\\.Print(|f|ln)|log\\.Fatal(|f|ln)|log\\.Panic(|f|ln))$"
        msg: "Use structured logging (slog or zap) instead of fmt/log"
      - pattern: "^os\\.Exit$"
        msg: "Do not call os.Exit directly; return errors up the call stack"
      - pattern: "^panic$"
        msg: "Do not panic in production code; return errors"
```

## Conclusion

Static analysis in Go pays dividends that compound over time. Every class of bug prevented by a linter is a class of bug that never appears in production incidents, post-mortems, or customer escalations. The investment in configuring `golangci-lint` properly and writing custom analyzers for organization-specific patterns typically pays back within a month for any codebase larger than a single developer's project.

The most important linters to start with are `errcheck` (ignored errors are the root cause of most Go service failures), `staticcheck` (it catches an enormous range of code correctness issues), and `gosec` (catches security vulnerabilities before they reach code review). Add the remaining linters incrementally as your team develops tolerance for fixing pre-existing findings, using `new-from-rev` to avoid being blocked by legacy violations.

Custom analyzers are the tool of choice for enforcing architectural invariants that no general linter can know about — correct error wrapping patterns, banned import paths between packages, required interface implementations, or domain-specific type safety rules.
