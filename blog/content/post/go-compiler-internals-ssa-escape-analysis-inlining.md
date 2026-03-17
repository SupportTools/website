---
title: "Go Compiler Internals: SSA, Escape Analysis, and Inlining"
date: 2029-09-25T00:00:00-05:00
draft: false
tags: ["Go", "Compiler", "SSA", "Escape Analysis", "Inlining", "Performance", "Optimization"]
categories: ["Go", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go compiler internals: the SSA form and optimization passes, reading escape analysis output, understanding the inlining budget and its limits, devirtualization, bounds check elimination, and practical techniques for writing code the compiler can optimize."
more_link: "yes"
url: "/go-compiler-internals-ssa-escape-analysis-inlining/"
---

Writing performant Go code requires understanding what the compiler does with your source. The Go compiler transforms your code through multiple optimization passes — constructing SSA form, analyzing which values escape to the heap, deciding which functions to inline, eliminating redundant bounds checks, and devirtualizing interface calls. This post peels back those layers, showing you how to read the compiler's diagnostic output, interpret SSA dumps, and write code that cooperates with the optimizer rather than fighting it.

<!--more-->

# Go Compiler Internals: SSA, Escape Analysis, and Inlining

## The Go Compiler Pipeline

The Go compiler (gc) processes source through these major phases:

```
Source (.go files)
    │
    ▼
Parsing → AST construction
    │
    ▼
Type checking → Type-annotated AST
    │
    ▼
Escape analysis → Heap allocation decisions
    │
    ▼
Inlining → Inline eligible function calls
    │
    ▼
Middle-end → Convert to SSA form
    │
    ▼
SSA optimization passes:
    - Dead code elimination
    - Nil check elimination
    - Bounds check elimination
    - Common subexpression elimination
    - Copy propagation
    - Phi elimination
    │
    ▼
Architecture-specific lowering
    │
    ▼
Register allocation
    │
    ▼
Machine code generation (.o files)
```

Understanding each phase helps you write code that benefits from these optimizations.

## Static Single Assignment (SSA) Form

SSA is an intermediate representation where every variable is assigned exactly once. When a variable is modified, the compiler creates a new version. This property enables a wide class of dataflow analyses and optimizations.

### Dumping SSA Output

```bash
# Dump SSA for a specific function
GOSSAFUNC=BenchmarkSum go build ./...
# Creates ssa.html in current directory — open in browser

# More targeted: dump for one package
GOSSAFUNC=(*Server).ServeHTTP go build ./cmd/server/...

# To see SSA for a specific phase
GOSSAFUNC=processItem GOSSAPHASEDEBUG=lower go build ./...
```

### Reading the SSA Dump

Given this simple function:

```go
// sum.go
package math

func Sum(a, b int) int {
    c := a + b
    return c
}
```

The initial SSA looks like:

```
# Generated SSA (simplified) for Sum
b1:  # entry block
  v1 = Arg <int> {a}      # parameter a
  v2 = Arg <int> {b}      # parameter b
  v3 = Add64 <int> v1 v2  # c = a + b
  Ret v3                   # return c
```

After optimization, simple functions like this may be entirely inlined at call sites — the SSA for the caller will directly contain the Add64 instruction without a CALL.

### SSA with Control Flow

```go
func Max(a, b int) int {
    if a > b {
        return a
    }
    return b
}
```

```
b1:  # entry
  v1 = Arg <int> {a}
  v2 = Arg <int> {b}
  v3 = Greater64 <bool> v1 v2   # a > b
  If v3 → b2, b3

b2:  # a > b
  Ret v1

b3:  # a <= b
  Ret v2
```

After SSA optimizations, if the compiler can prove at compile time which branch is taken (e.g., through constant propagation or loop unrolling), it eliminates the unreachable branch entirely.

## Escape Analysis

Escape analysis determines whether a value can be allocated on the stack (cheap, no GC pressure) or must be allocated on the heap (more expensive, GC-managed). Values "escape" to the heap when:

1. Their address is taken and stored somewhere that outlives the stack frame
2. They are passed to an interface (typically requires boxing)
3. They are returned as pointers
4. They exceed the maximum stack-allocable size (~32 KB for slices)

### Reading Escape Analysis Output

```bash
# Show escape analysis decisions
go build -gcflags="-m" ./...

# More verbose escape analysis
go build -gcflags="-m=2" ./...

# All escape analysis details
go build -gcflags="-m -m" ./...
```

### Examples and Interpretations

```go
// escape_examples.go
package escape

import "fmt"

// Example 1: Stack allocation — value does NOT escape
func stackAlloc() *int {
    x := 42
    return &x  // x escapes to heap because we return a pointer to it
}
// Output: ./escape_examples.go:9:2: moved to heap: x

// Example 2: Heap allocation — value escapes
func heapEscape(n int) []int {
    s := make([]int, n)  // n is not constant — may be large
    return s             // returned slice escapes
}
// Output: ./escape_examples.go:14:12: make([]int, n) escapes to heap

// Example 3: No escape — stays on stack
func noEscape() int {
    var sum int
    for i := 0; i < 100; i++ {
        sum += i
    }
    return sum  // returning value (not pointer) — sum stays on stack
}
// (no output for sum — stays on stack)

// Example 4: Interface boxing causes escape
func interfaceEscape(v int) interface{} {
    return v  // int value boxed into interface — escapes to heap
}
// Output: ./escape_examples.go:29:9: v escapes to heap

// Example 5: Closure captures
func closureCapture() func() int {
    x := 42
    return func() int { return x }  // x captured — escapes to heap
}
// Output: ./escape_examples.go:35:2: moved to heap: x

// Example 6: fmt.Println causes escape
func printValue(s string) {
    fmt.Println(s)  // s is passed to interface — may escape
}
// Output: ./escape_examples.go:41:14: s escapes to heap

// Example 7: Staying on stack with sized buffer
func stackBuffer() string {
    var buf [256]byte  // fixed-size array — stays on stack
    n := copy(buf[:], "hello")
    return string(buf[:n])  // string conversion copies — original stays on stack
}
// (no escape for buf)
```

### Preventing Unnecessary Escapes

```go
// patterns to reduce heap allocations

// Pattern 1: Pass output buffer instead of returning allocated slice
// BAD: allocates every call
func buildResponseBad(data []byte) []byte {
    result := make([]byte, 0, 1024)
    result = append(result, []byte("HTTP/1.1 200 OK\r\n")...)
    result = append(result, data...)
    return result
}

// GOOD: caller provides buffer, no allocation if buffer is large enough
func buildResponseGood(dst []byte, data []byte) []byte {
    dst = append(dst[:0], []byte("HTTP/1.1 200 OK\r\n")...)
    dst = append(dst, data...)
    return dst
}

// Pattern 2: Use sync.Pool to reuse heap objects
var bufPool = sync.Pool{
    New: func() any { return make([]byte, 0, 4096) },
}

func processWithPool(data []byte) []byte {
    buf := bufPool.Get().([]byte)
    defer bufPool.Put(buf[:0])
    buf = append(buf[:0], data...)
    return buf  // Note: caller must not hold reference after returning buf to pool
}

// Pattern 3: Avoid interfaces in hot paths
// BAD: interface{} boxing in tight loop
func sumBad(values []interface{}) int {
    var sum int
    for _, v := range values {
        sum += v.(int)  // type assertion + original boxing causes allocation
    }
    return sum
}

// GOOD: typed slice, no boxing
func sumGood(values []int) int {
    var sum int
    for _, v := range values {
        sum += v
    }
    return sum
}

// Pattern 4: Value receivers instead of pointer receivers for small structs
type SmallPoint struct{ X, Y float32 }

// BAD: pointer receiver for small value — receiver may escape
func (p *SmallPoint) DistanceBad(other *SmallPoint) float32 {
    dx := p.X - other.X
    dy := p.Y - other.Y
    return dx*dx + dy*dy
}

// GOOD: value receiver — passed and returned by value, stays on stack
func (p SmallPoint) DistanceGood(other SmallPoint) float32 {
    dx := p.X - other.X
    dy := p.Y - other.Y
    return dx*dx + dy*dy
}
```

## Inlining

Inlining replaces a function call with the function body at the call site. This eliminates function call overhead (stack setup, parameter passing, return) and enables further optimizations on the combined code (constant folding, dead code elimination).

### Inlining Budget

The Go compiler assigns each function an "inlining cost" based on AST node count. If the cost is below a threshold (~80 nodes for Go 1.23+), the function can be inlined.

```bash
# Show inlining decisions
go build -gcflags="-m" ./... 2>&1 | grep "can inline\|cannot inline\|inlining call"

# More detail on why a function cannot be inlined
go build -gcflags="-m=2" ./... 2>&1 | grep "cannot inline"
```

```go
// inlining_examples.go
package inline

import (
    "fmt"
    "sync"
)

// Can be inlined — simple, small
func Add(a, b int) int {
    return a + b  // "can inline Add"
}

// Cannot be inlined — uses defer
func SafeDiv(a, b int) (int, error) {
    defer func() {
        // ...
    }()
    if b == 0 {
        return 0, fmt.Errorf("division by zero")
    }
    return a / b, nil
    // "cannot inline SafeDiv: has defer, too complex"
}

// Cannot be inlined — body too large
func BigFunction(data []byte) []byte {
    // Many operations...
    result := make([]byte, 0, len(data)*2)
    for i, b := range data {
        result = append(result, b, b^byte(i))
    }
    return result
    // May exceed inlining budget
}

// Inlining is blocked by closures in some cases
func WithMutex(mu *sync.Mutex, fn func()) {
    mu.Lock()
    defer mu.Unlock()
    fn()
    // "cannot inline WithMutex: has defer"
}

// Workaround: avoid defer if performance-critical
func WithMutexFast(mu *sync.Mutex, fn func()) {
    mu.Lock()
    fn()
    mu.Unlock()
    // Now can be inlined (if fn call is also inlinable)
}
```

### Profile-Guided Inlining (PGO)

Go 1.20+ supports Profile-Guided Optimization (PGO), which uses runtime profiles to make better inlining decisions — inlining hot functions that exceed the normal budget.

```bash
# Step 1: Build without PGO
go build -o myapp ./cmd/myapp/

# Step 2: Collect a CPU profile under production load
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=30
# Save the profile as cpu.pprof

# Step 3: Build with PGO profile
go build -pgo=cpu.pprof -o myapp-pgo ./cmd/myapp/

# Step 4: Verify PGO inlining decisions
go build -pgo=cpu.pprof -gcflags="-m" ./cmd/myapp/ 2>&1 | grep "inlining"
# PGO-driven: "inlining call to Foo with cost X (PGO-enabled)"
```

Typical PGO improvements are 2-10% for CPU-bound workloads.

### Controlling Inlining with go:noinline

```go
// Force a function to never be inlined
// Useful for: debugging (keeping distinct stack frames), benchmarking,
// ensuring a function appears in stack traces

//go:noinline
func AlwaysVisible(x int) int {
    return x * 2
}

// Force inlining (experimental, use sparingly)
// Only available for very simple functions
//go:nosplit
func Critical(x int) int {
    return x
}
```

## Bounds Check Elimination (BCE)

The Go compiler inserts bounds checks for slice/array accesses. BCE eliminates redundant checks when the compiler can prove the index is in range.

```bash
# Show bounds checks being eliminated
go build -gcflags="-d=ssa/check_bce/debug=1" ./...
# Reports: "Found IsInBounds" (check present) vs eliminated (check removed)
```

```go
// BCE patterns

// Pattern 1: Bounds check NOT eliminated — index not provably in range
func getBad(s []int, i int) int {
    return s[i]  // bounds check required
}

// Pattern 2: BCE with explicit length check
func getGood(s []int, i int) int {
    if i >= 0 && i < len(s) {
        return s[i]  // bounds check eliminated — compiler proves i is valid
    }
    return 0
}

// Pattern 3: BCE in range loops — no bounds checks needed
func sumSlice(s []int) int {
    var sum int
    for i := range s {
        sum += s[i]  // BCE: i is always in [0, len(s))
    }
    return sum
}

// Pattern 4: Manual BCE hint — tell compiler the index is valid
// by accessing the length element first
func processThree(s []byte) {
    // This single check bounds-checks s[0], s[1], s[2] all at once
    _ = s[2]  // panics if len(s) < 3 — single check for all three
    s[0] = 'A'
    s[1] = 'B'
    s[2] = 'C'
}

// Pattern 5: BCE with constant indices
func processFour(s [4]int) int {
    // Array has fixed size 4 — all accesses s[0]-s[3] have BCE
    return s[0] + s[1] + s[2] + s[3]
}

// Pattern 6: BCE in copy-loop
func copyBytes(dst, src []byte) {
    n := len(src)
    if len(dst) >= n {
        // Both slices have at least n elements — no bounds checks in loop
        for i := 0; i < n; i++ {
            dst[i] = src[i]
        }
    }
}
```

### Benchmarking BCE Impact

```go
// benchmark_bce_test.go
package bce

import "testing"

var data = make([]int, 1000)

// With bounds check (each iteration checks i < len(data))
func BenchmarkWithCheck(b *testing.B) {
    s := data
    for b.Loop() {
        sum := 0
        for i := 0; i < len(s); i++ {
            sum += getUnchecked(s, i)  // artificial bounds check
        }
        _ = sum
    }
}

// BCE applied — compiler eliminates redundant checks
func BenchmarkWithBCE(b *testing.B) {
    s := data
    for b.Loop() {
        sum := 0
        for _, v := range s {
            sum += v  // BCE: compiler knows index is always valid
        }
        _ = sum
    }
}
```

## Devirtualization

Interface method calls are indirect (virtual dispatch): the compiler looks up the method in the interface table at runtime. Devirtualization replaces the indirect call with a direct call when the concrete type can be inferred.

```bash
# Show devirtualization
go build -gcflags="-m=2" ./... 2>&1 | grep "devirtualize\|devirt"
```

```go
// devirtualization_examples.go
package devirt

import "io"

// Cannot be devirtualized — interface value, unknown concrete type
func readAll(r io.Reader) ([]byte, error) {
    buf := make([]byte, 4096)
    n, err := r.Read(buf)  // virtual dispatch — cannot devirt
    return buf[:n], err
}

// Can be devirtualized — concrete type is known at call site
type BytesReader struct {
    data []byte
    pos  int
}

func (br *BytesReader) Read(p []byte) (int, error) {
    n := copy(p, br.data[br.pos:])
    br.pos += n
    return n, nil
}

func readFromBytes() {
    br := &BytesReader{data: []byte("hello world")}
    var r io.Reader = br
    buf := make([]byte, 4)
    // If the compiler can prove r is always *BytesReader, it devirtualizes the call
    r.Read(buf)
}

// PGO-assisted devirtualization
// With PGO, if profiling shows that 95% of calls to r.Read are *BytesReader,
// the compiler generates:
//   if type(r) == *BytesReader {
//       BytesReader.Read(r.(*BytesReader), buf)  // direct call
//   } else {
//       r.Read(buf)  // fallback virtual call
//   }

// Type switch for manual devirtualization
func processWriter(w io.Writer, data []byte) {
    switch ww := w.(type) {
    case *strings.Builder:
        ww.Write(data)  // direct call — no virtual dispatch
    case *bytes.Buffer:
        ww.Write(data)  // direct call
    default:
        w.Write(data)   // virtual dispatch for unknown types
    }
}
```

## go/ssa Package for Analysis Tools

The `go/ssa` package in `golang.org/x/tools` provides a complete SSA IR for building analysis tools. It is separate from the gc compiler's internal SSA (which is not exported).

```go
// analysis/dead_code/main.go — find functions never called
package main

import (
    "fmt"
    "go/token"
    "os"

    "golang.org/x/tools/go/packages"
    "golang.org/x/tools/go/ssa"
    "golang.org/x/tools/go/ssa/ssautil"
)

func main() {
    cfg := &packages.Config{
        Mode: packages.NeedFiles |
              packages.NeedSyntax |
              packages.NeedTypes |
              packages.NeedTypesInfo,
        Fset: token.NewFileSet(),
    }

    pkgs, err := packages.Load(cfg, os.Args[1:]...)
    if err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }

    // Build SSA program
    prog, ssaPkgs := ssautil.AllPackages(pkgs, ssa.InstantiateGenerics)
    prog.Build()

    // Find all reachable functions using CHA (Class Hierarchy Analysis)
    mains := ssautil.MainPackages(ssaPkgs)
    if len(mains) == 0 {
        fmt.Fprintln(os.Stderr, "no main packages found")
        os.Exit(1)
    }

    // Collect all defined functions
    allFuncs := make(map[*ssa.Function]bool)
    for _, pkg := range ssaPkgs {
        if pkg == nil {
            continue
        }
        for _, member := range pkg.Members {
            if fn, ok := member.(*ssa.Function); ok {
                allFuncs[fn] = false  // false = not yet seen as reachable
            }
        }
    }

    // Walk reachable functions from main
    var walkFn func(*ssa.Function)
    walkFn = func(fn *ssa.Function) {
        if allFuncs[fn] {
            return  // already visited
        }
        allFuncs[fn] = true

        // Visit all callees
        for _, block := range fn.Blocks {
            for _, instr := range block.Instrs {
                if call, ok := instr.(ssa.CallInstruction); ok {
                    if callee := call.Common().StaticCallee(); callee != nil {
                        walkFn(callee)
                    }
                }
            }
        }
    }

    for _, main := range mains {
        if fn := main.Func("main"); fn != nil {
            walkFn(fn)
        }
        if fn := main.Func("init"); fn != nil {
            walkFn(fn)
        }
    }

    // Report unreachable (potentially dead) functions
    fmt.Println("Potentially unreachable functions:")
    for fn, reachable := range allFuncs {
        if !reachable && fn.Pos().IsValid() {
            fmt.Printf("  %s\n", fn)
        }
    }
}
```

### Inspecting SSA Instructions

```go
// Iterating over SSA instructions to find all heap allocations
func findAllocations(fn *ssa.Function) []ssa.Instruction {
    var allocs []ssa.Instruction
    for _, block := range fn.Blocks {
        for _, instr := range block.Instrs {
            switch instr.(type) {
            case *ssa.Alloc:
                // Stack or heap allocation
                if instr.(*ssa.Alloc).Heap {
                    allocs = append(allocs, instr)
                }
            case *ssa.MakeSlice, *ssa.MakeMap, *ssa.MakeChan:
                allocs = append(allocs, instr)
            }
        }
    }
    return allocs
}
```

## Practical Compilation Diagnostics

A script for a comprehensive view of compiler decisions for a package:

```bash
#!/bin/bash
# compiler-analysis.sh — comprehensive compiler diagnostics
PKG=${1:-./...}

echo "=== Inlining decisions ==="
go build -gcflags="-m" $PKG 2>&1 | grep -E "can inline|cannot inline|inlining call" | head -40

echo ""
echo "=== Escape analysis (allocations going to heap) ==="
go build -gcflags="-m" $PKG 2>&1 | grep "escapes to heap\|moved to heap" | head -40

echo ""
echo "=== Functions too large to inline ==="
go build -gcflags="-m=2" $PKG 2>&1 | grep "too complex\|too large\|budget exceeded" | head -20

echo ""
echo "=== PGO inlining (if pgo profile exists) ==="
if [ -f cpu.pprof ]; then
    go build -pgo=cpu.pprof -gcflags="-m" $PKG 2>&1 | grep "PGO" | head -20
fi
```

### Combining Diagnostics with Benchmarks

```go
// benchmark_optimization_test.go
package opt_test

import (
    "testing"
)

// Use b.ReportAllocs() to track allocations per operation
func BenchmarkStringConcat(b *testing.B) {
    b.ReportAllocs()
    for b.Loop() {
        // Triggers heap allocation for the result string
        _ = "hello" + " " + "world"
    }
}

func BenchmarkStringBuilder(b *testing.B) {
    b.ReportAllocs()
    var sb strings.Builder
    for b.Loop() {
        sb.Reset()
        sb.WriteString("hello")
        sb.WriteByte(' ')
        sb.WriteString("world")
        _ = sb.String()
    }
}
```

```bash
# Run benchmarks with allocation tracking
go test -bench=. -benchmem -count=5 ./...

# Compare before and after optimization
go test -bench=. -benchmem -count=5 ./... | tee before.txt
# make changes
go test -bench=. -benchmem -count=5 ./... | tee after.txt
benchstat before.txt after.txt
```

## Summary

The Go compiler makes sophisticated optimization decisions that directly affect your program's performance and memory footprint:

- **SSA form** enables dataflow analyses and multi-pass optimizations. Use `GOSSAFUNC=FuncName go build` to inspect the IR and verify the compiler is doing what you expect.
- **Escape analysis** (`-gcflags="-m"`) reveals which values go to the heap. Design hot-path functions to keep values on the stack: use value types for small structs, avoid interface boxing, pre-allocate fixed-size buffers.
- **Inlining** (`-gcflags="-m"`) shows which function calls are eliminated. Keep hot utility functions under the ~80-node budget. Use PGO to enable inlining for larger, frequently-called functions.
- **Bounds check elimination** happens automatically for range loops and after explicit length checks. For slice-heavy code, structure your access patterns to let the compiler prove index validity statically.
- **Devirtualization** replaces virtual dispatch with direct calls when the concrete type is known. Use type switches in performance-critical code paths, or provide type hints via concrete wrappers.
- **PGO** (Go 1.20+) feeds runtime profile data back into the compiler, enabling better inlining and devirtualization decisions for your actual workload — typically yielding 2-10% throughput improvement with no code changes.

The go/ssa package exposes the same IR concepts for building your own static analysis and optimization tooling, making Go one of the most analyzable compiled languages in the ecosystem.
