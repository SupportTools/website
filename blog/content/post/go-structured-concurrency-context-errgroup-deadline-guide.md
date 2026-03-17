---
title: "Go: Structured Concurrency Patterns with Context Cancellation, errgroup, and Deadline Propagation"
date: 2031-08-24T00:00:00-05:00
draft: false
tags: ["Go", "Concurrency", "Context", "errgroup", "Goroutines", "Patterns", "Production"]
categories: ["Go"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade Go concurrency patterns covering structured concurrency with errgroup, context deadline propagation, fan-out/fan-in, bounded parallelism, and the common pitfalls that cause goroutine leaks and hard-to-debug cancellation failures."
more_link: "yes"
url: "/go-structured-concurrency-context-errgroup-deadline-guide/"
---

Go's goroutines and channels are powerful, but raw goroutines without a lifecycle management pattern lead to the most insidious class of production bugs: goroutine leaks, partial failures that look like timeouts, and cancellation that propagates unpredictably. Structured concurrency is a programming model where concurrent operations are managed as a group — when the group is done (successfully or with error), all operations have either completed or been cancelled. In Go, this pattern is implemented primarily with `context.Context` and `golang.org/x/sync/errgroup`. This guide covers the patterns that work in production and the anti-patterns that cause incidents at 3 AM.

<!--more-->

# Go: Structured Concurrency Patterns with Context Cancellation, errgroup, and Deadline Propagation

## The Core Problem with Raw Goroutines

```go
// Anti-pattern: goroutine with no lifecycle management
func fetchAllUsers(ids []string) ([]User, error) {
    results := make([]User, len(ids))
    for i, id := range ids {
        go func(i int, id string) {  // Goroutine leaks if main returns early
            user, err := fetchUser(id)
            if err != nil {
                // How do we propagate this error? We can't.
            }
            results[i] = user
        }(i, id)
    }
    // Race condition: results may not be populated yet
    return results, nil
}
```

Problems:
1. **Goroutine leaks**: if the caller cancels, goroutines keep running
2. **Error propagation**: no way to return errors from goroutines
3. **Race conditions**: reading results before goroutines complete
4. **Unbounded parallelism**: if `ids` has 10,000 elements, we launch 10,000 goroutines

## errgroup: The Right Foundation

`golang.org/x/sync/errgroup` solves the error propagation and goroutine synchronization problems:

```go
import "golang.org/x/sync/errgroup"

// Correct pattern: errgroup with context
func fetchAllUsers(ctx context.Context, ids []string) ([]User, error) {
    results := make([]User, len(ids))

    // errgroup.WithContext returns a group and a derived context.
    // If any goroutine returns an error, the context is cancelled.
    g, gctx := errgroup.WithContext(ctx)

    for i, id := range ids {
        i, id := i, id  // Capture loop variables (Go < 1.22)
        g.Go(func() error {
            user, err := fetchUser(gctx, id)  // Use gctx, not ctx
            if err != nil {
                return fmt.Errorf("fetching user %s: %w", id, err)
            }
            results[i] = user
            return nil
        })
    }

    // Wait blocks until all goroutines complete.
    // Returns the first non-nil error encountered.
    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```

### Understanding errgroup Cancellation

When any goroutine returns an error, `errgroup.WithContext` cancels the derived context. Other goroutines check this context and stop work:

```go
func fetchUser(ctx context.Context, id string) (User, error) {
    req, err := http.NewRequestWithContext(ctx, "GET",
        fmt.Sprintf("https://api.example.com/users/%s", id), nil)
    if err != nil {
        return User{}, err
    }

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        // If ctx was cancelled, err will wrap context.Canceled
        // This is correct behavior - stop work when the group cancels
        return User{}, fmt.Errorf("http request: %w", err)
    }
    defer resp.Body.Close()

    var user User
    if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
        return User{}, err
    }
    return user, nil
}
```

**Critical detail**: errgroup only cancels on the first error but waits for all goroutines to complete. Goroutines that respect the context will return quickly; goroutines that ignore it will block `g.Wait()`.

## Bounded Parallelism with SetLimit

Launching one goroutine per item works for small inputs but fails at scale. `errgroup.SetLimit` implements bounded parallelism:

```go
func fetchAllUsersParallel(ctx context.Context, ids []string) ([]User, error) {
    results := make([]User, len(ids))
    errors := make([]error, len(ids))

    g, gctx := errgroup.WithContext(ctx)
    g.SetLimit(20)  // Maximum 20 concurrent goroutines

    for i, id := range ids {
        i, id := i, id
        g.Go(func() error {
            user, err := fetchUser(gctx, id)
            if err != nil {
                errors[i] = err
                return nil  // Don't cancel other fetches on individual errors
            }
            results[i] = user
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }

    // Collect partial errors
    var allErrors []error
    for i, err := range errors {
        if err != nil {
            allErrors = append(allErrors, fmt.Errorf("user %s: %w", ids[i], err))
        }
    }
    if len(allErrors) > 0 {
        return results, errors.Join(allErrors...)
    }
    return results, nil
}
```

## Context Deadline Propagation

Context deadlines propagate through the call chain. Understanding how they interact with `errgroup` prevents subtle bugs:

```go
// Deadline hierarchy example
func handleRequest(w http.ResponseWriter, r *http.Request) {
    // r.Context() has the HTTP server's deadline
    // (based on server.ReadTimeout + WriteTimeout)
    ctx := r.Context()

    // Add a tighter deadline for this specific operation
    // The child context uses the EARLIER of the two deadlines
    opCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()  // Always defer cancel to release resources

    result, err := processRequest(opCtx)
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            http.Error(w, "request timeout", http.StatusGatewayTimeout)
            return
        }
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }

    json.NewEncoder(w).Encode(result)
}
```

### Deadline Inheritance Example

```go
// DeadlineChain demonstrates how deadlines propagate
func DeadlineChain() {
    // Root context with 10-second deadline
    root, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    // Child with 5-second deadline (wins because it's earlier)
    child, cancel2 := context.WithTimeout(root, 5*time.Second)
    defer cancel2()

    // Grandchild with 20-second deadline (loses - parent's 5s wins)
    grandchild, cancel3 := context.WithTimeout(child, 20*time.Second)
    defer cancel3()

    dl, ok := grandchild.Deadline()
    if ok {
        remaining := time.Until(dl)
        fmt.Printf("Effective deadline: ~%.1fs\n", remaining.Seconds())
        // Output: Effective deadline: ~5.0s
    }
}
```

### Propagating Deadlines Across Service Boundaries

When making RPC calls, propagate the remaining deadline rather than a fixed timeout:

```go
// Good: propagate remaining deadline to downstream service
func callDownstream(ctx context.Context, req *Request) (*Response, error) {
    // The HTTP client will respect ctx's deadline
    httpReq, _ := http.NewRequestWithContext(ctx, "POST", downstreamURL, reqBody)

    // Optionally: inform the downstream service of our deadline via a header
    if dl, ok := ctx.Deadline(); ok {
        remaining := time.Until(dl)
        // Subtract a small buffer for network transit and response processing
        downstreamDeadline := dl.Add(-100 * time.Millisecond)
        httpReq.Header.Set("X-Request-Deadline",
            downstreamDeadline.UTC().Format(time.RFC3339))
        _ = remaining
    }

    resp, err := httpClient.Do(httpReq)
    // ...
    return parseResponse(resp)
}
```

## Fan-Out / Fan-In Pattern

```go
// fanOut sends work to multiple workers and collects results
func fanOut[T, R any](
    ctx context.Context,
    inputs []T,
    workers int,
    process func(context.Context, T) (R, error),
) ([]R, error) {
    inputCh := make(chan struct{ idx int; val T }, len(inputs))
    resultCh := make(chan struct{ idx int; val R; err error }, len(inputs))

    // Enqueue all inputs (non-blocking since channel is buffered)
    for i, input := range inputs {
        inputCh <- struct{ idx int; val T }{i, input}
    }
    close(inputCh)

    g, gctx := errgroup.WithContext(ctx)

    // Launch workers
    for w := 0; w < workers; w++ {
        g.Go(func() error {
            for item := range inputCh {
                // Check context before processing each item
                select {
                case <-gctx.Done():
                    return gctx.Err()
                default:
                }

                result, err := process(gctx, item.val)
                resultCh <- struct{ idx int; val R; err error }{item.idx, result, err}
            }
            return nil
        })
    }

    // Close result channel when all workers complete
    go func() {
        g.Wait()
        close(resultCh)
    }()

    // Collect results
    results := make([]R, len(inputs))
    var errs []error
    for res := range resultCh {
        if res.err != nil {
            errs = append(errs, res.err)
        } else {
            results[res.idx] = res.val
        }
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    if len(errs) > 0 {
        return nil, errors.Join(errs...)
    }
    return results, nil
}

// Usage
results, err := fanOut(ctx, userIDs, 20, func(ctx context.Context, id string) (User, error) {
    return fetchUser(ctx, id)
})
```

## Pipeline Pattern

```go
// Pipeline chains stages of processing, each in its own goroutine
// Cancellation propagates automatically through context

// generator produces values into a channel
func generator[T any](ctx context.Context, vals ...T) <-chan T {
    ch := make(chan T, len(vals))
    go func() {
        defer close(ch)
        for _, v := range vals {
            select {
            case ch <- v:
            case <-ctx.Done():
                return
            }
        }
    }()
    return ch
}

// stage applies fn to each value from in, sending results to out
func stage[T, R any](
    ctx context.Context,
    in <-chan T,
    fn func(context.Context, T) (R, error),
) (<-chan R, <-chan error) {
    out := make(chan R, cap(in))
    errs := make(chan error, 1)

    go func() {
        defer close(out)
        defer close(errs)
        for v := range in {
            select {
            case <-ctx.Done():
                errs <- ctx.Err()
                return
            default:
            }

            result, err := fn(ctx, v)
            if err != nil {
                errs <- err
                return
            }
            select {
            case out <- result:
            case <-ctx.Done():
                errs <- ctx.Err()
                return
            }
        }
    }()
    return out, errs
}

// Example: multi-stage pipeline
func processPipeline(ctx context.Context, ids []string) ([]EnrichedUser, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    // Stage 1: Fetch users
    rawIDs := generator(ctx, ids...)
    users, fetchErrs := stage(ctx, rawIDs, func(ctx context.Context, id string) (User, error) {
        return fetchUser(ctx, id)
    })

    // Stage 2: Enrich users with profile data
    enriched, enrichErrs := stage(ctx, users, func(ctx context.Context, u User) (EnrichedUser, error) {
        return enrichUser(ctx, u)
    })

    // Collect results
    var results []EnrichedUser
    for v := range enriched {
        results = append(results, v)
    }

    // Check for errors from any stage
    if err := <-fetchErrs; err != nil {
        return nil, fmt.Errorf("fetch stage: %w", err)
    }
    if err := <-enrichErrs; err != nil {
        return nil, fmt.Errorf("enrich stage: %w", err)
    }

    return results, nil
}
```

## Graceful Shutdown Pattern

Production servers must drain in-flight requests on shutdown:

```go
// Server with graceful shutdown and context propagation
type Server struct {
    httpServer *http.Server
    inflight   sync.WaitGroup
}

func (s *Server) Start(ctx context.Context, addr string) error {
    mux := http.NewServeMux()
    mux.HandleFunc("/api/process", s.withInflight(s.handleProcess))

    s.httpServer = &http.Server{
        Addr:    addr,
        Handler: mux,
        // Set these conservatively - they bound the maximum goroutine lifetime
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    // Handle shutdown signal
    go func() {
        <-ctx.Done()
        s.shutdown()
    }()

    if err := s.httpServer.ListenAndServe(); err != http.ErrServerClosed {
        return err
    }
    return nil
}

// withInflight tracks in-flight requests for graceful shutdown
func (s *Server) withInflight(h http.HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        s.inflight.Add(1)
        defer s.inflight.Done()
        h(w, r)
    }
}

func (s *Server) shutdown() {
    // Stop accepting new requests
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := s.httpServer.Shutdown(shutdownCtx); err != nil {
        log.Printf("HTTP server shutdown error: %v", err)
    }

    // Wait for in-flight requests to complete (with timeout)
    done := make(chan struct{})
    go func() {
        s.inflight.Wait()
        close(done)
    }()

    select {
    case <-done:
        log.Println("All in-flight requests completed")
    case <-shutdownCtx.Done():
        log.Println("Shutdown timeout: some requests did not complete")
    }
}

// main.go - Graceful shutdown wired up
func main() {
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt, syscall.SIGTERM)
    defer stop()

    srv := &Server{}

    if err := srv.Start(ctx, ":8080"); err != nil {
        log.Fatalf("Server error: %v", err)
    }
}
```

## Avoiding Goroutine Leaks

### Anti-Pattern: Goroutine Leaking on Channel Send

```go
// WRONG: goroutine leaks if the caller stops reading from ch
func produce(ctx context.Context) <-chan int {
    ch := make(chan int)  // Unbuffered channel
    go func() {
        for i := 0; ; i++ {
            ch <- i  // Blocks forever if nobody reads
        }
    }()
    return ch
}

// CORRECT: goroutine exits when context is cancelled
func produce(ctx context.Context) <-chan int {
    ch := make(chan int)
    go func() {
        defer close(ch)
        for i := 0; ; i++ {
            select {
            case ch <- i:
            case <-ctx.Done():
                return
            }
        }
    }()
    return ch
}
```

### Anti-Pattern: Goroutine Leaking on Blocking Call

```go
// WRONG: goroutine can't be cancelled if db.Query doesn't respect context
func queryAsync(ctx context.Context, query string) <-chan *Result {
    ch := make(chan *Result, 1)
    go func() {
        // If db.Query ignores ctx, this goroutine leaks on cancellation
        rows, err := db.Query(query)
        ch <- &Result{rows: rows, err: err}
    }()
    return ch
}

// CORRECT: use QueryContext which respects cancellation
func queryAsync(ctx context.Context, query string) <-chan *Result {
    ch := make(chan *Result, 1)
    go func() {
        rows, err := db.QueryContext(ctx, query)
        ch <- &Result{rows: rows, err: err}
    }()
    return ch
}
```

### Detecting Goroutine Leaks in Tests

```go
// Use goleak to detect goroutine leaks in tests
import "go.uber.org/goleak"

func TestFetchAllUsers(t *testing.T) {
    defer goleak.VerifyNone(t)  // Fails test if goroutines leaked

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // Test cancellation path
    cancelCtx, cancelFn := context.WithCancel(ctx)
    go func() {
        time.Sleep(10 * time.Millisecond)
        cancelFn()  // Cancel mid-operation
    }()

    _, err := fetchAllUsers(cancelCtx, []string{"user1", "user2", "user3"})
    if !errors.Is(err, context.Canceled) {
        t.Errorf("expected context.Canceled, got %v", err)
    }

    // goleak.VerifyNone will check that all goroutines started by this test
    // have exited by the time the test function returns
}
```

## Timeout Budgeting

For operations with multiple sub-steps, use proportional timeouts rather than equal ones:

```go
// TimeoutBudget distributes a total timeout across multiple operations
type TimeoutBudget struct {
    deadline time.Time
}

func NewTimeoutBudget(ctx context.Context, total time.Duration) *TimeoutBudget {
    deadline := time.Now().Add(total)
    if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
        deadline = ctxDeadline
    }
    return &TimeoutBudget{deadline: deadline}
}

// Fraction returns a context with n/d of the remaining time as its deadline.
// Use this to allocate proportional timeouts to sub-operations.
func (b *TimeoutBudget) Fraction(ctx context.Context, n, d int) (context.Context, context.CancelFunc) {
    remaining := time.Until(b.deadline)
    allocated := time.Duration(int64(remaining) * int64(n) / int64(d))
    return context.WithTimeout(ctx, allocated)
}

// WithFloor returns a context with at least minDuration remaining.
func (b *TimeoutBudget) WithFloor(ctx context.Context, minDuration time.Duration) (context.Context, context.CancelFunc) {
    remaining := time.Until(b.deadline)
    if remaining < minDuration {
        return context.WithTimeout(ctx, minDuration)
    }
    return context.WithDeadline(ctx, b.deadline)
}

// Example: three-phase operation with proportional timeouts
func threePhaseOperation(ctx context.Context) error {
    budget := NewTimeoutBudget(ctx, 10*time.Second)

    // Phase 1: Database query (40% of budget = 4s)
    phase1Ctx, cancel1 := budget.Fraction(ctx, 4, 10)
    defer cancel1()
    if err := phase1(phase1Ctx); err != nil {
        return fmt.Errorf("phase 1: %w", err)
    }

    // Phase 2: External API call (40% of budget = 4s)
    phase2Ctx, cancel2 := budget.Fraction(ctx, 4, 10)
    defer cancel2()
    if err := phase2(phase2Ctx); err != nil {
        return fmt.Errorf("phase 2: %w", err)
    }

    // Phase 3: Write result (remaining 20% = 2s)
    phase3Ctx, cancel3 := budget.Fraction(ctx, 2, 10)
    defer cancel3()
    return phase3(phase3Ctx)
}
```

## The "Do or Cancel" Pattern

Sometimes you want to try an operation with a timeout but proceed with a fallback if it times out:

```go
// DoOrDefault attempts op with a timeout and returns defaultVal on timeout.
// Useful for non-critical enrichment operations.
func DoOrDefault[T any](ctx context.Context, timeout time.Duration, defaultVal T,
    op func(context.Context) (T, error)) T {

    result, err := func() (T, error) {
        timeoutCtx, cancel := context.WithTimeout(ctx, timeout)
        defer cancel()
        return op(timeoutCtx)
    }()

    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
            return defaultVal
        }
        // Non-timeout errors: still return default but could log/metric here
        return defaultVal
    }
    return result
}

// Usage: try to enrich a response with analytics data, fall back gracefully
func handleUserProfile(ctx context.Context, userID string) UserProfile {
    // Critical: fetch base profile (inherits parent deadline)
    profile, err := fetchProfile(ctx, userID)
    if err != nil {
        // Critical path failed - propagate the error
        return UserProfile{Error: err}
    }

    // Non-critical: enrich with analytics data (100ms budget, default to empty)
    analytics := DoOrDefault(ctx, 100*time.Millisecond, Analytics{}, func(ctx context.Context) (Analytics, error) {
        return fetchAnalytics(ctx, userID)
    })

    profile.Analytics = analytics
    return profile
}
```

## Monitoring Goroutine Health

```go
// In your application metrics setup
import "runtime"

func registerGoroutineMetrics(reg prometheus.Registerer) {
    goroutineGauge := prometheus.NewGaugeFunc(
        prometheus.GaugeOpts{
            Name: "go_goroutines_active",
            Help: "Number of goroutines currently running.",
        },
        func() float64 { return float64(runtime.NumGoroutine()) },
    )
    reg.MustRegister(goroutineGauge)
}

// Alert on goroutine count growth (indicates leak)
// PrometheusRule:
// - alert: GoroutineLeak
//   expr: rate(go_goroutines_active[5m]) > 10
//   for: 10m
//   annotations:
//     summary: "Goroutine count growing: possible leak"
```

## Key Principles Summary

The patterns in this guide share common principles:

1. **Always use `errgroup.WithContext`** rather than raw goroutines for groups of concurrent operations. The derived context ensures cancellation propagates to all members when one fails.

2. **Every goroutine must have an exit condition** tied to context cancellation. Goroutines that block on channels, network I/O, or locks must select on `ctx.Done()`.

3. **SetLimit on errgroup** for operations on large inputs. Unbounded parallelism creates resource exhaustion and thundering herd problems.

4. **Propagate deadlines, don't create new ones** when calling downstream services. Let the original caller's deadline flow through the system.

5. **Test cancellation paths explicitly** using `goleak.VerifyNone`. The cancellation path is rarely exercised in happy-path testing and almost always broken without deliberate testing.

6. **Defer all `cancel` functions** immediately after creation, even when you think the context will be cancelled by other means. Double-cancel is harmless; leaked contexts are not.

These patterns, consistently applied, eliminate the class of goroutine leak and partial failure bugs that typically account for a disproportionate fraction of production incidents in Go services.
