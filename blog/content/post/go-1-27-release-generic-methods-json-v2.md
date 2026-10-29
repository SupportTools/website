---
title: "Go 1.27: Generic Methods, encoding/json/v2 and uuid"
date: 2026-11-03T09:00:00-05:00
draft: false
tags: ["Go", "Golang", "Go 1.27", "Generics", "encoding/json", "Release Notes"]
categories:
- Go
- Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "What changed in Go 1.27: generic methods, encoding/json/v2 behind encoding/json, the uuid package, goroutine leak profiles, ML-DSA and upgrade traps."
more_link: "yes"
url: "/go-1-27-release-generic-methods-json-v2/"
images: ["https://cdn.support.tools/posts/go-1-27-release-generic-methods-json-v2/og-454cfb2eae.jpg"]
---

Go 1.27 shipped on 2026-08-19 (the current patch release is 1.27.3). It is the release where methods can finally have their own type parameters, `encoding/json` moves onto the v2 engine, and the standard library gains a `uuid` package. This page covers what changed, what can break when you bump the `go` line in `go.mod`, and how to use the new APIs.

<!--more-->

## Quick answer

```bash
# Install alongside your current toolchain
go install golang.org/dl/go1.27.3@latest
go1.27.3 download

# Or let the go command fetch it for a module
go get go@1.27.3
go mod tidy
```

The changes most likely to matter on upgrade:

| Change | What to check |
|---|---|
| `encoding/json` now runs on the v2 engine | Error message text can differ; behavior is preserved. Opt out with `GOEXPERIMENT=nojsonv2` while you test. |
| `asynctimerchan` GODEBUG removed | `time` channels are always unbuffered (synchronous). Old `godebug asynctimerchan=1` settings now fail the build. |
| `go vet` printf check | `fmt.Errorf("...: %w", p)` where `p` is `*E` and `E` (not `*E`) implements `error` is reported. |
| `go test` runs the `stdversion` vet check | Code using APIs newer than the module's `go` version fails tests. |
| `go tool trace -http=:6060` | Now listens on localhost only. Use `-http=0.0.0.0:6060` to listen on all addresses. |
| macOS | Go 1.27 requires macOS 13 Ventura or later. |
| `bzr` | The go command no longer fetches modules from Bazaar repositories. |

This replaces the [Go 1.24 features overview](/go-1-24-features-performance-improvements/), which covers the earlier release (Swiss Table maps, weak pointers, `os.Root`).

## Generic methods

Until Go 1.26, only functions and types could declare type parameters. In Go 1.27 a method declaration can declare its own:

```go
package config

type Registry struct {
	values map[string]any
}

// Get returns the value stored under key if it has type T.
func (r *Registry) Get[T any](key string) (T, bool) {
	v, ok := r.values[key].(T)
	return v, ok
}
```

```go
retries, ok := reg.Get[int]("retries")
endpoint, _ := reg.Get[string]("endpoint")
```

Two limits from the release notes:

- Interface methods may not declare type parameters.
- A generic method cannot implement an interface method.

So generic methods are for concrete types. The standard library uses the feature immediately: `math/rand/v2` adds `(*Rand) N[Int intType](Int) Int`, the method form of the existing top-level `rand.N`.

Two smaller language changes ship alongside:

- A key in a struct literal may be any valid field selector for the struct type, not just a top-level field name.
- Function type inference now applies wherever a generic function is assigned or converted to a matching function type.

## encoding/json/v2 and encoding/json/jsontext

The v2 JSON packages leave `GOEXPERIMENT` and become regular standard library packages:

- `encoding/json/v2` provides `Marshal`, `MarshalWrite`, `MarshalEncode`, `Unmarshal`, `UnmarshalRead` and `UnmarshalDecode`, each taking variadic `Options`.
- `encoding/json/jsontext` handles JSON syntax: `Encoder`, `Decoder`, `Token` and `Value`.

```go
import (
	"os"

	json "encoding/json/v2"
)

type Server struct {
	Name    string            `json:"name"`
	Port    int               `json:"port,omitzero"`
	Labels  map[string]string `json:"labels,omitempty"`
}

func write(s Server) error {
	// Stream straight to a writer, with map keys sorted
	return json.MarshalWrite(os.Stdout, s, json.Deterministic(true))
}

func read(b []byte) (Server, error) {
	var s Server
	// Fail on fields the struct does not know about
	err := json.Unmarshal(b, &s, json.RejectUnknownMembers(true))
	return s, err
}
```

v2 defaults are stricter than v1: invalid UTF-8 in strings and duplicate object member names are errors. Struct tags support `omitzero`, `omitempty`, `string`, `case:ignore` or `case:strict`, and `embed` (which promotes a field's members into the parent object).

The existing `encoding/json` package is now implemented on top of v2. Its behavior is preserved, `Unmarshal` is significantly faster, `Marshal` is roughly at parity, and error strings may differ. If tests compare JSON error text, update them or run with `GOEXPERIMENT=nojsonv2` while you migrate; the release notes say that opt-out will be removed later.

> [!WARNING]
> If you used the `GOEXPERIMENT=jsonv2` preview in Go 1.25 or 1.26, the final API changed: the `format` and `unknown` tag options, `DiscardUnknownMembers` and the `SkipFunc` sentinel error were removed, and the `inline` tag option is now `embed`.

## The uuid package

Generating UUIDs no longer needs a third-party module:

```go
import "uuid"

id := uuid.New()            // currently the same as NewV4
orderID := uuid.NewV7()     // time-ordered, good for database keys
fmt.Println(id.String())

parsed, err := uuid.Parse("urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6")
```

`uuid.UUID` is a `[16]byte` with `String`, `Compare`, `MarshalText`, `UnmarshalText` and `AppendText`. `Parse` accepts the plain, braced, `urn:uuid:` and 32-hex-digit forms, in either case. `NewV7` values sort in creation order unless the system clock moves backwards, which makes them a better primary key than v4 for B-tree indexes.

## Runtime and diagnostics

- **Goroutine leak profile is GA.** `runtime/pprof` has a `goroutineleak` profile and `net/http/pprof` serves it at `/debug/pprof/goroutineleak`. Leaks are found through garbage collector reachability, so a goroutine blocked on a channel nothing else can reach is reported. Leaks involving primitives still reachable from globals or from runnable goroutines can go undetected.
- **Goroutine labels in tracebacks.** For modules declaring `go 1.27`, crash tracebacks include `runtime/pprof` labels in each goroutine's header line. Disable with `GODEBUG=tracebacklabels=0`.
- **Faster small allocations.** Size-specialized allocation routines cut the cost of some allocations under 80 bytes by up to 30%, about 1% overall in allocation-heavy programs, at roughly 60 KB of extra binary size. `GOEXPERIMENT=nosizespecializedmalloc` opts out.

```bash
# Inspect leaked goroutines in a service that imports net/http/pprof
go tool pprof -top http://localhost:6060/debug/pprof/goroutineleak
```

## Crypto and TLS

- `crypto/mldsa` implements ML-DSA (FIPS 204) post-quantum signatures. `crypto/x509` parses ML-DSA keys and signatures, and `crypto/tls` accepts the `MLDSA44`, `MLDSA65` and `MLDSA87` signature schemes in TLS 1.3.
- `crypto/tls` supports `MLKEM1024` key exchange through `Config.CurvePreferences`, and hybrid post-quantum key exchanges can be enabled there explicitly even when `tlsmlkem=0` or `tlssecpmlkem=0` is set.
- `Config.Rand` is deprecated; use `testing/cryptotest.SetGlobalRandom` for deterministic tests.
- These GODEBUG settings are gone: `tlsunsafeekm`, `tlsrsakex`, `tls3des`, `tls10server`, `x509keypairleaf`. A service that used them to re-enable RSA key exchange, 3DES or a TLS 1.0 server can no longer do so, and clients that need those will fail to connect.
- `crypto/x509.SystemCertPool` now honors `SSL_CERT_FILE` and `SSL_CERT_DIR` on Windows and macOS (disable with `GODEBUG=x509sslcertoverrideplatform=0`).

## Smaller library additions worth knowing

| Package | Addition |
|---|---|
| `bytes`, `strings` | `CutLast` |
| `net/url` | `URL.Clone`, `Values.Clone` |
| `net/http` | HTTP/2 server honors RFC 9218 client priorities (`Server.DisableClientPriority` restores round robin); `Server.MaxHeaderValueCount`; HTTP/1 response bodies are drained on close for connection reuse |
| `net/http/httptest` | `NewTestServer`, an in-memory server that works with `testing/synctest` |
| `testing/synctest` | `Sleep`, which combines `time.Sleep` and `synctest.Wait` |
| `database/sql` | `ConvertAssign`; `driver.RowsColumnScanner` |
| `math/big` | `Int.Divide` with `Trunc`, `Floor`, `Round` and `Ceil` modes |
| `compress/flate` | Faster compression; output bytes can differ from Go 1.26 (also affects gzip, zlib, zip and PNG) |
| `unicode` | Unicode 17 |

The `compress/flate` change is the one to watch in tests: golden files containing gzip or PNG bytes may need regenerating even though the decompressed content is identical.

## Tooling changes

- `go doc` accepts `package@version` and has `-ex` to list runnable examples.
- `go fix` gains the `atomictypes`, `embedlit`, `slicesbackward` and `unsafefuncs` modernizers; `waitgroup` is renamed `waitgroupgo`.
- `go mod tidy` in a `go 1.27` module merges multiple `require` blocks into at most two (direct and indirect).
- `gofmt` alignment is now identical across CPU architectures, so reformatting may produce small whitespace diffs once.
- The compiler gives closures simpler names that do not depend on inlining; tests that assert on symbol names may need updating.

## Upgrade checklist

1. Install the toolchain and run your tests unchanged with `go1.27.3 test ./...`.
2. Run `go1.27.3 vet ./...` and fix new printf `%w` findings.
3. Search `go.mod` and `//go:debug` lines for `asynctimerchan` and the removed TLS settings.
4. Run JSON-heavy tests; if only error strings differ, update the assertions.
5. Regenerate golden files that contain compressed bytes.
6. Bump the `go` line in `go.mod` to `1.27` and run `go mod tidy`.
7. Update CI images and Dockerfile `FROM golang:` lines to 1.27.3.

Related guides on this site:

- [Go 1.24 features and performance](/go-1-24-features-performance-improvements/), the previous version of this overview.
- [Weak pointers in Go 1.24 for caching](/go-1-24-weak-pointers-efficient-caching/).
- [Go's ServeMux routing since Go 1.22](/go-servemux-evolution-http-routing/).
- [Observability in Go with OpenTelemetry and Prometheus](/post/go-observability-opentelemetry-prometheus/), which pairs well with the new leak profile.

Sources: the [Go 1.27 release notes](https://go.dev/doc/go1.27), the [release history](https://go.dev/doc/devel/release), and the [uuid](https://pkg.go.dev/uuid) and [encoding/json/v2](https://pkg.go.dev/encoding/json/v2) package documentation.
