---
title: "Go Micro-Optimization: SIMD, Bounds Check Elimination, and Escape Analysis"
date: 2029-08-07T00:00:00-05:00
draft: false
tags: ["Go", "Performance", "SIMD", "Compiler", "Optimization", "Assembly"]
categories: ["Go", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Go micro-optimization techniques: goasm SIMD intrinsics, bounds check elimination patterns, escape analysis with -gcflags, inline budget management, and compiler directives like //go:noescape."
more_link: "yes"
url: "/go-micro-optimization-simd-bounds-check-escape-analysis/"
---

Modern Go programs often leave significant performance on the table. The Go compiler is good, but it is not magic — understanding how it thinks about memory, bounds, inlining, and data layout lets you guide it toward faster code. This post covers the techniques that matter most in hot paths: SIMD via assembly stubs, bounds check elimination, escape analysis enforcement, inline budget tuning, and compiler directives.

<!--more-->

# Go Micro-Optimization: SIMD, Bounds Check Elimination, and Escape Analysis

## Section 1: Understanding the Go Compiler Pipeline

Before touching a single line of optimized code, you need a mental model of what happens between `go build` and the final binary.

The Go compiler pipeline at a high level:

1. **Parsing and type-checking** — produces a typed AST
2. **Escape analysis** — decides stack vs heap allocation for each value
3. **Inlining** — substitutes call sites with function bodies (budget: 80 nodes by default)
4. **SSA lowering** — converts the AST into Static Single Assignment form
5. **Machine-code generation** — emits architecture-specific instructions
6. **Bounds check insertion** — adds range checks before every slice/array index

The key insight is that escape analysis and inlining happen **before** SSA. This means allocation decisions made during escape analysis affect the code the SSA optimizer sees. If you force a value onto the heap unnecessarily, the optimizer never gets the chance to keep it in a register.

### Inspecting Compiler Decisions

```bash
# Show all compiler decisions: inlining, escape, bounds checks
go build -gcflags="-m=2" ./...

# Show only inlining decisions
go build -gcflags="-m" ./...

# Dump SSA phases for a specific function
GOSSAFUNC=ProcessBatch go build ./pkg/processor/

# Show bounds check insertions
go build -gcflags="-d=ssa/prove/debug=1" ./...

# Disable optimizations entirely (baseline for benchmarks)
go build -gcflags="-N -l" ./...
```

### Reading -m=2 Output

```text
./processor.go:42:16: inlining call to sumSlice
./processor.go:15:6: moved to heap: result
./processor.go:87:22: (*Buffer).Write does not escape
./processor.go:91:14: leaking param: dst to result ~r0 level=0
```

Each line tells a story:
- `inlining call to` — the function was cheap enough to inline
- `moved to heap` — a value escaped; this is an allocation you may not have intended
- `does not escape` — good; the value stays on the stack
- `leaking param` — a pointer argument escapes through the return value

## Section 2: Escape Analysis — Keeping Values on the Stack

Heap allocation is expensive for two reasons: the allocator call itself costs ~25ns, and the GC must later scan and collect it. Stack allocation is free — it is just a stack pointer adjustment.

### Common Escape Patterns and How to Avoid Them

**Pattern 1: Interface boxing**

```go
// BAD — value escapes to heap when stored in interface
func logValue(v interface{}) {
    fmt.Println(v)
}

func process(n int) {
    logValue(n) // n escapes to heap here
}

// GOOD — use typed function or generics
func logInt(n int) {
    fmt.Printf("%d\n", n)
}

// ALSO GOOD — use generics (Go 1.18+), no boxing for concrete types
func logTyped[T any](v T) {
    fmt.Printf("%v\n", v)
}
```

**Pattern 2: Pointer returned from function**

```go
// BAD — result escapes
func newResult() *Result {
    r := Result{} // r moves to heap
    return &r
}

// GOOD — caller owns the storage
func fillResult(r *Result) {
    r.Value = 42
    r.Name = "ok"
}

func process() {
    var r Result      // stays on stack
    fillResult(&r)
    use(r)
}
```

**Pattern 3: Closure capturing a variable**

```go
// BAD — x escapes because closure outlives the stack frame
func makeAdder(x int) func(int) int {
    return func(n int) int { return x + n } // x escapes
}

// GOOD — pass x as argument to the closure
func makeAdderValue(x int) func(int) int {
    return func(n int) int {
        captured := x  // x is copied into closure; x itself may still escape
        return captured + n
    }
}

// BEST — avoid closures in hot paths; use a struct with a method
type Adder struct{ base int }
func (a Adder) Add(n int) int { return a.base + n }
```

**Pattern 4: Appending to a nil slice returned through an interface**

```go
// Causes escape because the slice header is stored in interface{}
var results []string
for _, item := range items {
    results = append(results, process(item))
}
return results // fine if caller is typed

// vs.

var buf bytes.Buffer  // stack-allocated, never escapes if not too large
```

### Verifying Stack Allocation with Benchmarks

```go
package processor_test

import (
    "testing"
    "github.com/example/processor"
)

func BenchmarkProcess_Allocs(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        processor.Process(42)
    }
}
```

```bash
go test -bench=BenchmarkProcess_Allocs -benchmem ./pkg/processor/
# BenchmarkProcess_Allocs-8   50000000   24.1 ns/op   0 B/op   0 allocs/op
```

Zero allocs is the goal for hot-path functions.

## Section 3: Bounds Check Elimination

Every time you index a slice, the compiler inserts a bounds check: `if index >= len(slice) { panic(...) }`. In tight loops over large arrays this overhead is measurable — typically 5-15% of loop time.

### How BCE Works

The compiler's `prove` pass tracks value ranges. If it can prove an index is always within bounds, it eliminates the check. The key is to give it enough information at compile time.

```go
// BEFORE BCE — compiler cannot prove safety
func sumNaive(data []float64) float64 {
    var total float64
    for i := 0; i < len(data); i++ {
        total += data[i] // bounds check here
    }
    return total
}

// AFTER BCE — range loop gives the compiler what it needs
func sumRange(data []float64) float64 {
    var total float64
    for _, v := range data {
        total += v // NO bounds check — compiler proved safety
    }
    return total
}
```

### Manual BCE with Length Hints

When you must use index-based access, hoist a length check:

```go
func processTriple(a, b, c []float64) {
    n := len(a)
    if len(b) < n { n = len(b) }
    if len(c) < n { n = len(c) }

    // Narrow the slices to proven-safe length
    a = a[:n:n]
    b = b[:n:n]
    c = c[:n:n]

    for i := 0; i < n; i++ {
        // All three: bounds check eliminated
        a[i] = b[i] + c[i]
    }
}
```

The `a[:n:n]` three-index slice expression both restricts the length and sets the capacity, which helps the compiler's `prove` pass eliminate checks.

### BCE for Fixed-Size Arrays

```go
// Fixed-size array: all bounds checks eliminated at compile time
func dot4(a, b [4]float64) float64 {
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]
}

// Unrolled slice version with pre-check
func dot4Slice(a, b []float64) float64 {
    _ = a[3] // BCE hint: prove len >= 4 before the loop
    _ = b[3]
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3]
}
```

The `_ = a[3]` trick is idiomatic Go BCE: it forces a single bounds check at the top, after which the compiler knows all subsequent accesses within [0,3] are safe.

### Verifying BCE with -d=ssa/prove

```bash
GOSSAFUNC=dot4Slice go build -gcflags="-d=ssa/prove/debug=1" ./...
# Look for "Proved IsInBounds" lines in the output
```

## Section 4: Inlining — Budget and Control

The Go inliner assigns a cost to each function based on AST node count. The default budget is **80 nodes**. Functions exceeding this budget are not inlined regardless of how hot they are.

### Checking Inline Budget

```bash
go build -gcflags="-m=2" ./... 2>&1 | grep "too complex"
# ./pkg/hot.go:15:6: cannot inline hotPath: function too complex: cost 112 exceeds budget 80
```

### Reducing Inline Cost

```go
// BEFORE — single function too large to inline (cost ~95)
func processItem(item Item, cfg Config) Result {
    if item.Type == TypeA {
        // 20 lines of TypeA processing
    } else if item.Type == TypeB {
        // 20 lines of TypeB processing
    }
    // 15 more lines
    return result
}

// AFTER — dispatch is inlined; branches are not (total cost ~30)
func processItem(item Item, cfg Config) Result {
    switch item.Type {
    case TypeA:
        return processTypeA(item, cfg)  // not inlined, but call is cheap
    case TypeB:
        return processTypeB(item, cfg)
    }
    return processDefault(item, cfg)
}
```

### //go:noinline — Preventing Inlining

Sometimes you want to prevent inlining to keep benchmarks accurate or to preserve stack traces:

```go
//go:noinline
func slowPath(data []byte) int {
    // complex logic that should not be inlined
    // keeping it out of hot paths intentionally
    return complexScan(data)
}
```

### //go:inline — Forcing Inlining (Go 1.22+)

```go
//go:inline
func fastAbs(x int64) int64 {
    if x < 0 {
        return -x
    }
    return x
}
```

Note: `//go:inline` is a hint, not a guarantee. The compiler still rejects it if the function is genuinely too complex.

## Section 5: SIMD with Go Assembly

Go's assembly dialect (Plan 9 assembly) lets you write functions that use SIMD instructions (SSE2, AVX2, AVX-512) while keeping a pure-Go fallback. The pattern involves three files:

1. `func.go` — Go declaration and fallback
2. `func_amd64.s` — AMD64 assembly implementation
3. `func_amd64.go` — build-tag-guarded stub

### Example: Sum of Float32 Slice with AVX2

**sum_amd64.go** — Go stub declaration:

```go
//go:build amd64

package simd

// sumFloat32AVX2 sums a slice of float32 using AVX2 instructions.
// The assembly implementation is in sum_amd64.s.
//
//go:noescape
func sumFloat32AVX2(data []float32) float32
```

**sum.go** — Portable fallback and dispatcher:

```go
package simd

import "golang.org/x/sys/cpu"

// SumFloat32 returns the sum of all elements in data.
// On AMD64 with AVX2 support it uses SIMD; otherwise falls back to scalar.
func SumFloat32(data []float32) float32 {
    if cpu.X86.HasAVX2 && len(data) >= 8 {
        return sumFloat32AVX2(data)
    }
    return sumFloat32Scalar(data)
}

func sumFloat32Scalar(data []float32) float32 {
    var sum float32
    for _, v := range data {
        sum += v
    }
    return sum
}
```

**sum_amd64.s** — AVX2 implementation:

```asm
// func sumFloat32AVX2(data []float32) float32
// Args: SI=data pointer, BX=len, CX=cap (unused)
// Returns: XMM0 (lower 32 bits)
TEXT ·sumFloat32AVX2(SB),NOSPLIT,$0-28
    MOVQ    data_base+0(FP), SI   // pointer to data
    MOVQ    data_len+8(FP), BX    // length

    VXORPS  Y0, Y0, Y0            // accumulator = 0.0 (256-bit)
    MOVQ    BX, AX
    SHRQ    $3, AX                // AX = len / 8 (full AVX2 chunks)
    JZ      tail

loop:
    VMOVUPS (SI), Y1              // load 8 x float32
    VADDPS  Y1, Y0, Y0            // accumulate
    ADDQ    $32, SI               // advance pointer by 32 bytes
    DECQ    AX
    JNZ     loop

tail:
    // Horizontal sum of Y0
    VEXTRACTF128 $1, Y0, X1       // X1 = upper 128 bits of Y0
    VADDPS  X1, X0, X0            // X0 = sum of all 8 lanes
    VHADDPS X0, X0, X0            // X0 = [a+b, c+d, a+b, c+d]
    VHADDPS X0, X0, X0            // X0 = [sum, sum, sum, sum]

    // Handle remaining elements (len % 8)
    ANDQ    $7, BX
    JZ      done
scalar:
    VMOVSS  (SI), X1
    VADDSS  X1, X0, X0
    ADDQ    $4, SI
    DECQ    BX
    JNZ     scalar

done:
    VMOVSS  X0, ret+24(FP)        // store return value
    VZEROUPPER                    // avoid AVX-SSE transition penalty
    RET
```

### //go:noescape — Critical for Assembly Stubs

The `//go:noescape` directive tells the escape analyzer that the function's pointer arguments do not escape. Without it, any slice or pointer passed to an assembly function is assumed to escape to the heap.

```go
//go:noescape
func sumFloat32AVX2(data []float32) float32

//go:noescape
func copyAligned(dst, src []byte, n int)

//go:noescape
func compareBytes(a, b []byte) int
```

Rules for `//go:noescape`:
- Must appear immediately before the function declaration (no blank lines)
- Only valid for functions with no Go body (i.e., assembly implementations)
- If the function does allow escaping, omitting the directive is the safe default

### Checking Assembly Output

```bash
# Disassemble a specific function
go tool objdump -s 'simd\.SumFloat32' ./bin/myapp

# Check that AVX2 instructions appear
go tool objdump -s 'simd\.sumFloat32AVX2' ./bin/myapp | grep -E 'VADD|VMOV|VHAD'
```

## Section 6: Compiler Directives Reference

### //go:nosplit

Prevents the function from being split at a stack growth point. Used in very low-level code where the goroutine stack cannot be grown (signal handlers, runtime internals).

```go
//go:nosplit
func atomicAdd(p *int64, delta int64) int64 {
    return (*int64)(unsafe.Pointer(p))  // simplified example
}
```

### //go:linkname

Accesses unexported symbols from another package. Powerful but fragile — breaks with Go version upgrades.

```go
//go:linkname nanotime runtime.nanotime
func nanotime() int64
```

### //go:generate

Triggers code generation. Commonly used to pre-generate lookup tables or marshal code.

```go
//go:generate go run ./cmd/gen-tables -output tables_generated.go
```

### Pragma Summary Table

| Directive | Effect | Use Case |
|---|---|---|
| `//go:noinline` | Prevents inlining | Benchmark isolation, stack trace clarity |
| `//go:inline` | Hints to inline | Force inline of undersized budget functions |
| `//go:noescape` | Params don't escape | Assembly stub declarations |
| `//go:nosplit` | No stack split | Runtime-level functions |
| `//go:norace` | Skips race detector | Atomic operations the detector misidentifies |
| `//go:uintptrescapes` | uintptr args are pointers | cgo bridge code |

## Section 7: Benchmarking Micro-Optimizations

Micro-optimizations are only valid when measured properly. Common mistakes: measuring with optimizations disabled, not warming CPU caches, and not accounting for benchmark noise.

### Benchmark Template

```go
package processor_test

import (
    "math/rand"
    "testing"
    "github.com/example/processor"
)

var sink float32 // prevent dead-code elimination

func BenchmarkSumFloat32_Scalar(b *testing.B) {
    data := makeFloat32Slice(1024)
    b.ResetTimer()
    b.SetBytes(int64(len(data)) * 4)
    for i := 0; i < b.N; i++ {
        sink = processor.SumFloat32Scalar(data)
    }
}

func BenchmarkSumFloat32_AVX2(b *testing.B) {
    data := makeFloat32Slice(1024)
    b.ResetTimer()
    b.SetBytes(int64(len(data)) * 4)
    for i := 0; i < b.N; i++ {
        sink = processor.SumFloat32AVX2(data)
    }
}

func makeFloat32Slice(n int) []float32 {
    s := make([]float32, n)
    for i := range s {
        s[i] = rand.Float32()
    }
    return s
}
```

```bash
# Run benchmarks with CPU statistics
go test -bench=BenchmarkSumFloat32 -benchmem -count=5 -cpuprofile=cpu.prof ./pkg/processor/

# Compare with benchstat
go install golang.org/x/perf/cmd/benchstat@latest
go test -bench=BenchmarkSumFloat32_Scalar -count=10 > old.txt
go test -bench=BenchmarkSumFloat32_AVX2   -count=10 > new.txt
benchstat old.txt new.txt
```

### Expected Results

```text
name                    old time/op    new time/op    delta
SumFloat32/1024-8         892ns ± 2%     124ns ± 1%  -86.11%  (p=0.000 n=10+10)

name                    old speed      new speed      delta
SumFloat32/1024-8       4.59GB/s ± 2%  33.1GB/s ± 1%  +621%   (p=0.000 n=10+10)
```

## Section 8: Profiling-Guided Optimization Workflow

Micro-optimizations applied blindly are dangerous — they add complexity without measurable benefit. The correct workflow:

```bash
# Step 1: Profile the real workload
go test -bench=BenchmarkRealWorkload -cpuprofile=cpu.prof -memprofile=mem.prof ./...

# Step 2: Identify hot functions
go tool pprof -top cpu.prof

# Step 3: Examine assembly of hot functions
go tool pprof -disasm hotFunction cpu.prof

# Step 4: Apply targeted optimization

# Step 5: Measure again — confirm improvement
go test -bench=BenchmarkRealWorkload -count=10 ./... > after.txt
benchstat before.txt after.txt

# Step 6: Run full test suite to confirm correctness
go test -race ./...
```

### Reading pprof Disassembly

```text
Total:  892ms  892ms (flat, cum 100%)
    10    10ms    MOVQ    0x10(AX), CX    ; len(data)
    11    80ms    VADDPS  (SI), Y0, Y0    ; hot: 9% of time
    12     5ms    ADDQ    $0x20, SI       ; pointer advance
```

Lines with high flat time are your optimization targets.

## Section 9: Memory Layout Optimization

Cache efficiency often matters more than algorithmic tricks. A cache miss costs ~100ns — the same as 100 simple arithmetic operations.

### Struct Field Ordering

```go
// BAD — wasted padding bytes
type BadStruct struct {
    A bool    // 1 byte
    B int64   // 8 bytes — 7 bytes padding before this
    C bool    // 1 byte
    D int64   // 8 bytes — 7 bytes padding before this
    // Total: 32 bytes
}

// GOOD — largest fields first
type GoodStruct struct {
    B int64  // 8 bytes
    D int64  // 8 bytes
    A bool   // 1 byte
    C bool   // 1 byte
    // Total: 18 bytes (with 6 bytes trailing padding = 24)
}
```

```bash
# Check struct sizes
go run golang.org/x/tools/cmd/structlayout -json ./pkg/types/ BadStruct | jq .
go run golang.org/x/tools/cmd/structlayout-optimize ./pkg/types/ BadStruct
```

### Array of Structs vs Struct of Arrays

```go
// Array of Structs (AoS) — poor for vectorization
type Particle struct {
    X, Y, Z float32
    Mass     float32
    Charge   float32
}
type ParticlesAoS []Particle

// Struct of Arrays (SoA) — excellent for SIMD
type ParticlesSoA struct {
    X, Y, Z []float32
    Mass     []float32
    Charge   []float32
}

// When computing only positions (X,Y,Z), SoA loads only needed data.
// AoS loads Mass and Charge into cache even though they are not needed.
```

## Section 10: Production Checklist

Before shipping micro-optimized code:

- [ ] Benchmark shows statistically significant improvement (p < 0.05 via benchstat)
- [ ] Zero regressions in correctness tests: `go test -race ./...`
- [ ] Fallback path exists for CPUs without SIMD extensions
- [ ] Assembly stubs use `//go:noescape` where appropriate
- [ ] No `unsafe.Pointer` usage without accompanying comment explaining the invariant
- [ ] `-gcflags="-m"` output reviewed — no unexpected heap escapes introduced
- [ ] Memory allocations unchanged or reduced: `go test -benchmem`
- [ ] Code is documented with a reference to the optimization technique and benchmark data
- [ ] Considered whether the optimization is actually in a hot path (profile first)

## Conclusion

Go micro-optimization is a discipline that combines compiler knowledge, hardware awareness, and rigorous measurement. The tools are all in the standard toolchain: `-gcflags="-m=2"` for escape analysis, `-d=ssa/prove/debug=1` for bounds check verification, `GOSSAFUNC` for SSA inspection, and `go tool pprof` for profiling.

The most impactful techniques in order of typical ROI:

1. **Escape analysis** — eliminate heap allocations in hot paths (free performance, no complexity cost)
2. **Bounds check elimination** — use range loops and length hints (5-15% in array-heavy code)
3. **Inlining** — keep hot functions under the 80-node budget (measurable for call-heavy workloads)
4. **SIMD** — use assembly stubs for data-parallel operations (10x+ for suitable workloads)
5. **Memory layout** — struct field ordering and SoA patterns (cache-efficiency gains)

Always profile before optimizing, measure after, and document what you changed and why.
