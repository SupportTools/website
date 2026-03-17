---
title: "Go Assembly Language: Performance-Critical Functions"
date: 2029-04-16T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Assembly", "Performance", "SIMD", "Crypto", "Optimization"]
categories:
- Go
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go assembly language covering Plan 9 assembly syntax, calling conventions, SIMD intrinsics, AES-NI and SHA hardware acceleration, and benchmarking assembly against pure Go implementations."
more_link: "yes"
url: "/go-assembly-language-performance-critical-functions-guide/"
---

Go is a high-level language with excellent performance for most workloads, but certain hot paths — cryptographic operations, checksums, bulk data transformations, and SIMD-eligible loops — benefit from hand-written assembly that exploits hardware features the compiler cannot always utilize. The Go toolchain supports assembly via Plan 9 syntax, which is used extensively in the standard library for functions like `strings.Count`, `bytes.IndexByte`, AES encryption, and SHA hashing.

This guide covers Go assembly from the ground up: Plan 9 syntax, calling conventions, SIMD intrinsics, hardware-accelerated crypto, and disciplined benchmarking methodology to measure whether assembly actually helps.

<!--more-->

# Go Assembly Language: Performance-Critical Functions

## Section 1: Plan 9 Assembly Fundamentals

### Why Plan 9 Assembly

Go uses a modified version of Plan 9 assembly rather than AT&T or Intel syntax. The key differences:

- Instructions are pseudo-instructions that map to real machine instructions
- Register names are architecture-independent aliases (AX, BX, CX, DX, SI, DI, R8-R15 on amd64)
- The assembler handles some calling convention details
- Frame pointer, stack growth, and GC metadata are managed through directives

### Register Names on amd64

| Plan 9 Name | amd64 Register | Common Use |
|---|---|---|
| AX | RAX | Return value, function args |
| BX | RBX | Callee-saved |
| CX | RCX | 4th argument, loop counter |
| DX | RDX | 2nd return value |
| SI | RSI | Source pointer (string ops) |
| DI | RDI | Destination pointer |
| SP | RSP | Stack pointer |
| BP | RBP | Frame pointer (since Go 1.12) |
| R8-R15 | R8-R15 | Extra registers |
| X0-X15 | XMM0-XMM15 | 128-bit SSE |
| Y0-Y15 | YMM0-YMM15 | 256-bit AVX/AVX2 |
| Z0-Z31 | ZMM0-ZMM31 | 512-bit AVX-512 |

### Basic Assembly File Structure

```asm
// sum_amd64.s
#include "textflag.h"

// func Sum(a, b int64) int64
TEXT ·Sum(SB), NOSPLIT, $0-24
    // Arguments at offsets from FP (frame pointer pseudo-register):
    // a at FP+0, b at FP+8, return value at FP+16
    MOVQ    a+0(FP), AX     // load a into AX
    MOVQ    b+8(FP), BX     // load b into BX
    ADDQ    BX, AX          // AX = AX + BX
    MOVQ    AX, ret+16(FP)  // store result
    RET
```

The corresponding Go declaration:

```go
// sum.go
package mypackage

// Sum adds two int64 values.
// The actual implementation is in sum_amd64.s
func Sum(a, b int64) int64
```

### TEXT Directive Parameters

```asm
TEXT ·FunctionName(SB), FLAGS, $FRAMESIZE-ARGSIZE
```

- `SB`: Static Base pseudo-register — marks a global symbol
- `FLAGS`: `NOSPLIT` (don't grow stack), `NOFRAME` (no frame pointer), `NEEDCTXT` (needs context)
- `$FRAMESIZE`: Local variable space on stack (0 if no locals)
- `ARGSIZE`: Total size of arguments + return values (for stack maps)

### Memory Addressing Modes

```asm
// Immediate values
MOVQ    $42, AX             // AX = 42
MOVQ    $-1, AX             // AX = -1

// Register
MOVQ    AX, BX              // BX = AX

// Memory with offset
MOVQ    8(SP), AX           // AX = *(SP + 8)
MOVQ    AX, 8(SP)           // *(SP + 8) = AX

// Indexed memory
MOVQ    0(SI)(CX*8), AX     // AX = *(SI + CX*8)

// Frame pointer relative (arguments and locals)
MOVQ    arg+0(FP), AX       // first argument
MOVQ    ret+8(FP), AX       // return value at offset 8
```

## Section 2: Calling Conventions

### Go Internal ABI

Go uses an internal ABI (Application Binary Interface) for function calls. Since Go 1.17, the register-based ABI is the default for most functions:

**Argument passing:**
- Integer/pointer arguments: AX, BX, CX, DI, SI, R8, R9, R10, R11 (in order)
- Floating-point arguments: X0-X14 (in order)
- Arguments beyond what fits in registers are spilled to the stack

**Return values:**
- Integer/pointer returns: AX, BX, CX, DI, SI, R8, R9, R10, R11 (in order)
- Floating-point returns: X0-X14

**Callee-saved registers:**
- BX, BP, R12, R13, R14, R15 (must be preserved across calls)

### Assembly with Register ABI

For functions called from Go, you can use the register ABI directly:

```asm
// Multiply two int64 values using register ABI
// func Multiply(a, b int64) int64
TEXT ·Multiply(SB), NOSPLIT, $0
    // With register ABI: a is in AX, b is in BX
    IMULQ   BX, AX      // AX = AX * BX (signed multiply)
    RET                 // return value in AX
```

### Stack-Based ABI (legacy, for cgo)

When interfacing with C code via cgo, the stack-based ABI is used:

```asm
// Legacy stack-based calling convention
// func LegacyAdd(a, b int32) int32
TEXT ·LegacyAdd(SB), NOSPLIT, $0-12
    MOVL    a+0(FP), AX
    MOVL    b+4(FP), BX
    ADDL    BX, AX
    MOVL    AX, ret+8(FP)
    RET
```

## Section 3: Practical Assembly — Bulk Memory Operations

### Optimized Memory Copy

```asm
// memcpy_amd64.s — AVX2-accelerated memory copy
#include "textflag.h"

// func CopyAVX2(dst, src unsafe.Pointer, n int)
TEXT ·CopyAVX2(SB), NOSPLIT, $0-24
    MOVQ    dst+0(FP), DI   // destination
    MOVQ    src+8(FP), SI   // source
    MOVQ    n+16(FP), CX    // byte count

    // Check if AVX2 is available
    // (In production, use cpu detection at init time)

    // Process 32-byte chunks with AVX2
loop32:
    CMPQ    CX, $32
    JLT     tail

    VMOVDQU (SI), Y0        // load 32 bytes from source
    VMOVDQU Y0, (DI)        // store 32 bytes to destination
    ADDQ    $32, SI
    ADDQ    $32, DI
    SUBQ    $32, CX
    JMP     loop32

tail:
    // Handle remaining bytes (< 32)
    CMPQ    CX, $0
    JEQ     done
    MOVB    (SI), AX
    MOVB    AX, (DI)
    INCQ    SI
    INCQ    DI
    DECQ    CX
    JMP     tail

done:
    VZEROUPPER              // Required after AVX operations before calling non-AVX code
    RET
```

### Vectorized Sum (SIMD Example)

```asm
// sum_int32_amd64.s — SSE4.1-accelerated int32 sum
#include "textflag.h"

// func SumInt32(data []int32) int64
TEXT ·SumInt32(SB), NOSPLIT, $0-32
    MOVQ    data_base+0(FP), SI   // slice base pointer
    MOVQ    data_len+8(FP), CX    // slice length

    XORQ    AX, AX                // accumulator = 0
    PXOR    X0, X0                // 128-bit accumulator = 0
    PXOR    X1, X1                // second accumulator for unrolling

    // Process 8 int32 values per iteration (2x 128-bit)
loop8:
    CMPQ    CX, $8
    JLT     loop1

    MOVDQU  (SI), X2              // load 4 int32s
    MOVDQU  16(SI), X3            // load next 4 int32s
    PMOVZXDQ X2, X4              // zero-extend to int64 (low 2)
    // Full vectorized path needs more careful handling for sign extension
    // Simplified version using scalar fallback for clarity:
    MOVLQSX (SI), R8
    MOVLQSX 4(SI), R9
    MOVLQSX 8(SI), R10
    MOVLQSX 12(SI), R11
    ADDQ    R8, AX
    ADDQ    R9, AX
    ADDQ    R10, AX
    ADDQ    R11, AX
    ADDQ    $16, SI
    SUBQ    $4, CX
    JMP     loop8

loop1:
    CMPQ    CX, $0
    JEQ     done
    MOVLQSX (SI), R8
    ADDQ    R8, AX
    ADDQ    $4, SI
    DECQ    CX
    JMP     loop1

done:
    MOVQ    AX, ret+24(FP)
    RET
```

The Go declaration and benchmark:

```go
// sum_int32.go
package simd

import "unsafe"

// SumInt32 returns the sum of all int32 values in the slice.
// Uses SIMD acceleration on amd64.
func SumInt32(data []int32) int64

// SumInt32Pure is the pure Go implementation for benchmarking comparison.
func SumInt32Pure(data []int32) int64 {
    var sum int64
    for _, v := range data {
        sum += int64(v)
    }
    return sum
}
```

## Section 4: AES-NI Hardware Acceleration

### AES-NI Instructions

Modern x86 CPUs include AES-NI instructions that perform AES operations in hardware, approximately 10x faster than software implementations.

```asm
// aes_amd64.s — AES-128 ECB block encryption using AES-NI
#include "textflag.h"

// func AESEncryptBlock(key *[176]byte, plaintext, ciphertext *[16]byte)
// Encrypts a single 16-byte block. Key schedule must be precomputed.
TEXT ·AESEncryptBlock(SB), NOSPLIT, $0-24
    MOVQ    key+0(FP), AX           // key schedule pointer
    MOVQ    plaintext+8(FP), BX     // plaintext pointer
    MOVQ    ciphertext+16(FP), CX   // ciphertext pointer

    // Load plaintext block
    MOVDQU  (BX), X0

    // AES encryption: XOR with round key, then 9 AES rounds, then final round
    MOVDQU  0(AX), X1               // round key 0
    PXOR    X1, X0                  // initial XOR

    MOVDQU  16(AX), X1
    AESENC  X1, X0                  // round 1

    MOVDQU  32(AX), X1
    AESENC  X1, X0                  // round 2

    MOVDQU  48(AX), X1
    AESENC  X1, X0                  // round 3

    MOVDQU  64(AX), X1
    AESENC  X1, X0                  // round 4

    MOVDQU  80(AX), X1
    AESENC  X1, X0                  // round 5

    MOVDQU  96(AX), X1
    AESENC  X1, X0                  // round 6

    MOVDQU  112(AX), X1
    AESENC  X1, X0                  // round 7

    MOVDQU  128(AX), X1
    AESENC  X1, X0                  // round 8

    MOVDQU  144(AX), X1
    AESENC  X1, X0                  // round 9

    MOVDQU  160(AX), X1
    AESENCLAST X1, X0               // final round

    MOVDQU  X0, (CX)                // store ciphertext
    RET
```

### Detecting CPU Features at Runtime

```go
// cpu_detect.go
package crypto

import (
    "golang.org/x/sys/cpu"
)

var (
    hasAESNI  = cpu.X86.HasAES
    hasSHA    = cpu.X86.HasSHA
    hasAVX2   = cpu.X86.HasAVX2
    hasAVX512 = cpu.X86.HasAVX512F
)

// UseAESNI returns true if the CPU supports AES-NI instructions.
func UseAESNI() bool {
    return hasAESNI
}

// Dispatch to hardware or software implementation at init time
func init() {
    if hasAESNI {
        encryptBlockFn = encryptBlockAESNI  // assembly function
    } else {
        encryptBlockFn = encryptBlockSoftware  // pure Go fallback
    }
}

var encryptBlockFn func(key *[176]byte, plaintext, ciphertext *[16]byte)

// EncryptBlock dispatches to hardware or software implementation.
func EncryptBlock(key *[176]byte, plaintext, ciphertext *[16]byte) {
    encryptBlockFn(key, plaintext, ciphertext)
}
```

## Section 5: SHA Hardware Acceleration

### SHA-256 with SHA Extensions

Intel and AMD CPUs since 2017 include SHA extensions for accelerating SHA-1 and SHA-256:

```asm
// sha256_amd64.s — SHA-256 block using SHA-NI instructions
// Based on Intel's optimization guide for SHA extensions
#include "textflag.h"

// SHA-256 constants for rounds
DATA K256<>+0x00(SB)/4, $0x428a2f98
DATA K256<>+0x04(SB)/4, $0x71374491
DATA K256<>+0x08(SB)/4, $0xb5c0fbcf
DATA K256<>+0x0c(SB)/4, $0xe9b5dba5
// ... (all 64 constants would be listed here)
GLOBL K256<>(SB), RODATA, $256

// func sha256Block(digest *[8]uint32, data []byte)
TEXT ·sha256Block(SB), NOSPLIT, $0-32
    MOVQ    digest+0(FP), DI
    MOVQ    data_base+8(FP), SI
    MOVQ    data_len+16(FP), DX

    // Load initial hash values
    MOVDQU  (DI), X14           // H0-H3
    MOVDQU  16(DI), X15         // H4-H7

    // SHA-256 initial transformation
    PSHUFD  $0x1B, X14, X14     // swap byte order for SHA-NI
    PSHUFD  $0x1B, X15, X15

loop:
    CMPQ    DX, $64
    JLT     done

    // Save current hash values
    MOVDQA  X14, X12
    MOVDQA  X15, X13

    // Load message schedule (16 32-bit words = 64 bytes)
    MOVDQU  0(SI), X4
    MOVDQU  16(SI), X5
    MOVDQU  32(SI), X6
    MOVDQU  48(SI), X7

    // Byte-swap for endianness
    MOVDQA  endianMask<>(SB), X3
    PSHUFB  X3, X4
    PSHUFB  X3, X5
    PSHUFB  X3, X6
    PSHUFB  X3, X7

    // Rounds 0-3
    MOVDQA  X4, X0
    PADDD   K256<>+0*16(SB), X0
    SHA256RNDS2 X0, X14, X15
    PSHUFD  $0x0E, X0, X0
    SHA256RNDS2 X0, X15, X14

    // Rounds 4-7
    MOVDQA  X5, X0
    PADDD   K256<>+1*16(SB), X0
    SHA256RNDS2 X0, X14, X15
    PSHUFD  $0x0E, X0, X0
    SHA256RNDS2 X0, X15, X14

    // ... (rounds 8-63 follow the same pattern)

    // Add back saved hash values
    PADDD   X12, X14
    PADDD   X13, X15

    ADDQ    $64, SI
    SUBQ    $64, DX
    JMP     loop

done:
    // Restore byte order and store
    PSHUFD  $0x1B, X14, X14
    PSHUFD  $0x1B, X15, X15
    MOVDQU  X14, (DI)
    MOVDQU  X15, 16(DI)
    RET

DATA endianMask<>+0(SB)/16, $0x0c0d0e0f08090a0b0405060700010203
GLOBL endianMask<>(SB), RODATA, $16
```

## Section 6: Vectorized String Operations

### Counting Bytes with SSE2

The Go standard library uses assembly for `bytes.Count` and `strings.Count`:

```asm
// countbyte_amd64.s — count occurrences of a byte in a slice
#include "textflag.h"

// func CountByte(s []byte, b byte) int
TEXT ·CountByte(SB), NOSPLIT, $0-32
    MOVQ    s_base+0(FP), SI    // slice base
    MOVQ    s_len+8(FP), CX    // slice length
    MOVBQZX b+24(FP), AX       // byte to search

    XORQ    DX, DX              // count = 0

    // Broadcast byte to all 16 positions in XMM register
    // XMM0 = [b, b, b, b, b, b, b, b, b, b, b, b, b, b, b, b]
    MOVD    AX, X0
    PXOR    X1, X1
    PSHUFB  X1, X0

    // Process 16 bytes at a time with SSE2
loop16:
    CMPQ    CX, $16
    JLT     tail

    MOVDQU  (SI), X1           // load 16 bytes
    PCMPEQB X0, X1             // compare each byte: 0xFF if equal, 0x00 if not
    PMOVMSKB X1, BX            // create 16-bit mask from MSBs
    POPCNTL BX, BX             // count set bits
    ADDQ    BX, DX             // add to total count

    ADDQ    $16, SI
    SUBQ    $16, CX
    JMP     loop16

tail:
    CMPQ    CX, $0
    JEQ     done

    MOVBQZX (SI), BX
    CMPQ    BX, AX
    JNE     next
    INCQ    DX
next:
    INCQ    SI
    DECQ    CX
    JMP     tail

done:
    MOVQ    DX, ret+25(FP)
    RET
```

### CRC32 with Hardware Instructions

```asm
// crc32_amd64.s — CRC32C using SSE4.2 CRC32 instruction
#include "textflag.h"

// func CRC32C(crc uint32, data []byte) uint32
TEXT ·CRC32C(SB), NOSPLIT, $0-36
    MOVLQZX crc+0(FP), AX     // initial CRC value
    MOVQ    data_base+8(FP), SI
    MOVQ    data_len+16(FP), CX

    // Process 8 bytes at a time
loop8:
    CMPQ    CX, $8
    JLT     loop4

    CRC32Q  (SI), AX           // CRC32C over 8 bytes
    ADDQ    $8, SI
    SUBQ    $8, CX
    JMP     loop8

loop4:
    CMPQ    CX, $4
    JLT     loop1

    CRC32L  (SI), AX           // CRC32C over 4 bytes
    ADDQ    $4, SI
    SUBQ    $4, CX

loop1:
    CMPQ    CX, $0
    JEQ     done

    CRC32B  (SI), AX           // CRC32C over 1 byte
    INCQ    SI
    DECQ    CX
    JMP     loop1

done:
    MOVL    AX, ret+32(FP)
    RET
```

## Section 7: Benchmarking Assembly vs Pure Go

### Benchmark Methodology

```go
// benchmark_test.go
package simd_test

import (
    "testing"
    "math/rand"

    "github.com/example/simd"
)

var testData []int32

func init() {
    testData = make([]int32, 1024*1024)  // 1M elements = 4MB
    r := rand.New(rand.NewSource(42))
    for i := range testData {
        testData[i] = r.Int31()
    }
}

func BenchmarkSumInt32Pure(b *testing.B) {
    b.SetBytes(int64(len(testData) * 4))
    b.ReportAllocs()
    b.ResetTimer()

    var result int64
    for i := 0; i < b.N; i++ {
        result = simd.SumInt32Pure(testData)
    }
    _ = result
}

func BenchmarkSumInt32ASM(b *testing.B) {
    b.SetBytes(int64(len(testData) * 4))
    b.ReportAllocs()
    b.ResetTimer()

    var result int64
    for i := 0; i < b.N; i++ {
        result = simd.SumInt32(testData)
    }
    _ = result
}

func BenchmarkCRC32CPure(b *testing.B) {
    data := make([]byte, 64*1024)  // 64KB
    rand.Read(data)
    b.SetBytes(int64(len(data)))
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        simd.CRC32CPure(0, data)
    }
}

func BenchmarkCRC32CASM(b *testing.B) {
    data := make([]byte, 64*1024)
    rand.Read(data)
    b.SetBytes(int64(len(data)))
    b.ResetTimer()

    for i := 0; i < b.N; i++ {
        simd.CRC32C(0, data)
    }
}
```

### Running and Interpreting Benchmarks

```bash
# Run benchmarks with multiple counts for statistical validity
go test -bench=. -benchmem -benchtime=5s -count=5 ./...

# Example output:
# BenchmarkSumInt32Pure-16    5000   1200000 ns/op   3495.11 MB/s   0 B/op   0 allocs/op
# BenchmarkSumInt32ASM-16    18000    330000 ns/op  12709.33 MB/s   0 B/op   0 allocs/op
#
# ~3.6x speedup from SIMD

# Use benchstat for statistical comparison
go install golang.org/x/perf/cmd/benchstat@latest

go test -bench=BenchmarkCRC32C -count=10 > before.txt
# (deploy assembly version)
go test -bench=BenchmarkCRC32C -count=10 > after.txt

benchstat before.txt after.txt
# name          old time/op    new time/op    delta
# CRC32C-16     8.25µs ± 2%    0.82µs ± 1%  -90.1%  (p=0.000 n=10+10)
# name          old speed      new speed      delta
# CRC32C-16     7.98GB/s ±2%  80.2GB/s ±1%  +905%   (p=0.000 n=10+10)
```

### Profile-Guided Verification

```bash
# Profile the benchmark to confirm assembly functions are called
go test -bench=BenchmarkSumInt32ASM -cpuprofile=cpu.prof ./...
go tool pprof -top cpu.prof

# Verify no unexpected allocations
go test -bench=BenchmarkSumInt32ASM -memprofile=mem.prof ./...
go tool pprof -alloc_space mem.prof

# Use perf for hardware counter profiling
perf stat -e cycles,cache-misses,cache-references,instructions \
  go test -bench=BenchmarkSumInt32ASM -benchtime=10s ./...
```

## Section 8: Assembly Stubs and Build Constraints

### Build Constraints for Architecture-Specific Assembly

```go
// sum_stub.go — fallback for non-amd64 platforms
//go:build !amd64

package simd

// SumInt32 on non-amd64 platforms uses the pure Go implementation.
func SumInt32(data []int32) int64 {
    return SumInt32Pure(data)
}
```

```go
// sum_amd64.go — amd64 declaration for assembly
//go:build amd64

package simd

// SumInt32 uses SSE4.1 SIMD instructions on amd64.
// Implementation is in sum_int32_amd64.s
func SumInt32(data []int32) int64
```

### go:linkname for Internal Package Assembly

For assembly in internal packages of the standard library:

```go
// internal/cpu/cpu.go
package cpu

// Exported as an assembly function
var X86 struct {
    HasAES     bool
    HasAVX2    bool
    HasAVX512F bool
    HasSHA     bool
}
```

### Verifying Assembly Correctness

```go
// correctness_test.go
package simd_test

import (
    "testing"
    "math/rand"
    "testing/quick"

    "github.com/example/simd"
)

func TestSumInt32Correctness(t *testing.T) {
    // Property-based testing: ASM result must match pure Go result
    f := func(data []int32) bool {
        return simd.SumInt32(data) == simd.SumInt32Pure(data)
    }

    if err := quick.Check(f, &quick.Config{MaxCount: 10000}); err != nil {
        t.Fatal(err)
    }
}

func TestCRC32CCorrectness(t *testing.T) {
    // Test vectors from RFC 3720
    tests := []struct {
        data     []byte
        initial  uint32
        expected uint32
    }{
        {[]byte{0x00, 0x00, 0x00, 0x00}, 0xFFFFFFFF, 0xAA36918A},
        {[]byte{0xFF, 0xFF, 0xFF, 0xFF}, 0xFFFFFFFF, 0x43ABA862},
    }

    for _, tt := range tests {
        got := simd.CRC32C(tt.initial, tt.data)
        if got != tt.expected {
            t.Errorf("CRC32C(%v) = %08X, want %08X", tt.data, got, tt.expected)
        }
    }
}
```

## Section 9: Common Assembly Patterns and Pitfalls

### Stack Frame Management

```asm
// Function with local variables on stack
// func ProcessBuffer(buf *[64]byte) uint64
TEXT ·ProcessBuffer(SB), NOSPLIT, $32-16
    // $32 = local frame size: 32 bytes for two uint64 vars + alignment
    // -16 = argument size: 8 (pointer) + 8 (return)

    MOVQ    buf+0(FP), SI       // load buffer pointer

    // Allocate local space on stack
    // Local variables at SP+0, SP+8, SP+16, SP+24
    MOVQ    $0, x-8(SP)         // local var x = 0 (at SP-8 from local frame base)

    // ... processing ...

    MOVQ    x-8(SP), AX         // load result
    MOVQ    AX, ret+8(FP)       // store return value
    RET
```

### Avoiding the Write Barrier for GC Correctness

When writing pointers to memory locations that the GC tracks, you must use the write barrier. In most assembly functions that work with integers or non-pointer data, this is not an issue. For pointer writes:

```go
// Use //go:nosplit carefully — prevents stack growth
// Only use for leaf functions with small, bounded stack usage

//go:nosplit
func writePtr(dst **T, p *T) {
    // Must use typedmemmove or runtime.writeBarrier for pointer writes
    // Avoid direct pointer writes in assembly for GC-managed memory
}
```

### Performance Anti-Patterns

```asm
// BAD: Unnecessary moves hurt performance
MOVQ    (SI), AX
MOVQ    AX, BX          // unnecessary intermediate move
MOVQ    BX, (DI)

// BETTER: Use memory-to-memory move where possible
MOVQ    (SI), AX
MOVQ    AX, (DI)

// BAD: Branching in hot loop with poor prediction
// BETTER: Use conditional moves for branchless code
CMPQ    AX, BX
CMOVQGT BX, AX          // AX = max(AX, BX) without branch

// BAD: Unaligned SIMD loads when alignment is known
MOVDQU  (SI), X0        // unaligned load

// BETTER: Use aligned load when pointer is 16-byte aligned
MOVDQA  (SI), X0        // aligned load (faster on older CPUs)
```

## Summary

Go assembly is a precision tool for specific hot paths where the compiler cannot fully exploit hardware capabilities. The most impactful use cases are:

- **Cryptographic operations**: AES-NI reduces AES encryption cost by 10x; SHA-NI reduces SHA-256 by 5x
- **Bulk memory operations**: AVX2 moves 32 bytes per instruction vs 8 bytes for scalar code
- **Checksum computation**: CRC32C hardware instruction processes 8 bytes in 3 cycles
- **String operations**: SSE2 PCMPEQB compares 16 bytes simultaneously

Key practices:
- Always write a pure Go fallback and use build constraints to select the implementation per architecture
- Use `testing/quick` for property-based correctness testing before measuring performance
- Benchmark with `benchstat` over multiple runs for statistically valid comparisons
- Use `golang.org/x/sys/cpu` for runtime CPU feature detection rather than assuming all CPUs support a given instruction set
- Never write assembly for code that isn't in a verified hot path — premature optimization via assembly creates maintenance burdens that rarely pay off
