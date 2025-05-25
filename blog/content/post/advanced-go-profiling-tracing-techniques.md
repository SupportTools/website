---
title: "Advanced Go Profiling and Tracing: Pinpointing Performance Issues in Production"
date: 2025-07-31T09:00:00-05:00
draft: false
tags: ["Go", "Performance", "Profiling", "Tracing", "Optimization", "pprof", "OpenTelemetry"]
categories:
- Go
- Performance
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to effectively profile and trace Go applications in production to identify bottlenecks and optimize performance without disrupting users"
more_link: "yes"
url: "/advanced-go-profiling-tracing-techniques/"
---

When your Go microservices are running smoothly in development but struggling in production, you need advanced profiling and tracing techniques that work without impacting your users. This comprehensive guide shows you how to implement low-overhead continuous profiling and distributed tracing to identify performance bottlenecks in your Go applications.

<!--more-->

## Introduction

Performance issues in production often differ dramatically from what you see in development environments. In our production systems, we've repeatedly found that theoretical optimizations don't always match real-world needs. The solution? Implementing robust profiling and tracing systems that can run continuously in production with minimal overhead.

This article builds on our previous exploration of [optimizing Go data layers](/optimizing-go-data-layer-performance/) by focusing on how to identify exactly what needs optimization in the first place.

## Section 1: Continuous Profiling with pprof

The standard Go profiler (pprof) is powerful but traditionally challenging to use in production due to overhead concerns. Let's implement a low-impact continuous profiling system that automatically captures profiles during performance anomalies.

### Setting Up Continuous Profiling

First, let's add a basic pprof HTTP endpoint to your application:

```go
import (
    "net/http"
    _ "net/http/pprof" // Import for side effects
    "log"
)

func main() {
    // Your regular application code
    
    // Start pprof server on a separate port (not exposed externally)
    go func() {
        log.Println("Starting pprof server on :6060")
        log.Println(http.ListenAndServe("localhost:6060", nil))
    }()
    
    // Your application continues...
}
```

While this provides on-demand profiling, we need something more sophisticated for production. Let's create an adaptive profiler that throttles itself based on system load:

```go
package profiler

import (
    "os"
    "runtime"
    "runtime/pprof"
    "time"
    "sync"
    "fmt"
    "context"
)

type AdaptiveProfiler struct {
    // Configuration
    profileDir      string
    cpuThreshold    float64  // CPU threshold to trigger profiling (0-1)
    memThreshold    float64  // Memory threshold (0-1)
    minInterval     time.Duration
    profileDuration time.Duration
    
    // State
    lastProfile     time.Time
    mutex           sync.Mutex
    isRunning       bool
}

func NewAdaptiveProfiler(profileDir string) *AdaptiveProfiler {
    return &AdaptiveProfiler{
        profileDir:      profileDir,
        cpuThreshold:    0.70,  // Start profiling at 70% CPU
        memThreshold:    0.80,  // Start profiling at 80% memory
        minInterval:     10 * time.Minute,
        profileDuration: 30 * time.Second,
        lastProfile:     time.Time{},
    }
}

func (p *AdaptiveProfiler) Start(ctx context.Context) {
    go p.monitor(ctx)
}

func (p *AdaptiveProfiler) monitor(ctx context.Context) {
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-ticker.C:
            p.checkAndProfile()
        case <-ctx.Done():
            return
        }
    }
}

func (p *AdaptiveProfiler) checkAndProfile() {
    p.mutex.Lock()
    defer p.mutex.Unlock()
    
    if p.isRunning {
        return
    }
    
    // Check if we've profiled recently
    if time.Since(p.lastProfile) < p.minInterval {
        return
    }
    
    // Check system load
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    
    memUsage := float64(m.Alloc) / float64(m.Sys)
    
    // Use GOMAXPROCS as an approximation for available CPU
    cpus := runtime.GOMAXPROCS(0)
    var cpuUsage float64
    // Here you would calculate CPU usage
    // For a real implementation, you'd use something like:
    // - Read /proc/stat on Linux
    // - Use syscall.GetProcessTimes on Windows
    // For simplicity, we'll assume a function exists
    cpuUsage = getCPUUsage(cpus)
    
    // If thresholds are exceeded, profile
    if cpuUsage > p.cpuThreshold || memUsage > p.memThreshold {
        p.isRunning = true
        go p.captureProfiles()
    }
}

func getCPUUsage(cpus int) float64 {
    // Implementation depends on OS
    // Simple implementation that would need to be replaced
    return 0.5 // Placeholder
}

func (p *AdaptiveProfiler) captureProfiles() {
    timestamp := time.Now().Format("20060102-150405")
    
    // Capture CPU profile
    cpuFile, err := os.Create(fmt.Sprintf("%s/cpu-%s.pprof", p.profileDir, timestamp))
    if err != nil {
        // Log error and continue
        fmt.Printf("Error creating CPU profile: %v\n", err)
    } else {
        runtime.GC() // Run GC before profiling
        pprof.StartCPUProfile(cpuFile)
        time.Sleep(p.profileDuration) // Profile for N seconds
        pprof.StopCPUProfile()
        cpuFile.Close()
    }
    
    // Capture memory profile
    memFile, err := os.Create(fmt.Sprintf("%s/mem-%s.pprof", p.profileDir, timestamp))
    if err != nil {
        fmt.Printf("Error creating memory profile: %v\n", err)
    } else {
        runtime.GC() // Run GC before profiling
        if err := pprof.WriteHeapProfile(memFile); err != nil {
            fmt.Printf("Error writing memory profile: %v\n", err)
        }
        memFile.Close()
    }
    
    // Capture goroutine profile
    goroutineFile, err := os.Create(fmt.Sprintf("%s/goroutine-%s.pprof", p.profileDir, timestamp))
    if err != nil {
        fmt.Printf("Error creating goroutine profile: %v\n", err)
    } else {
        p := pprof.Lookup("goroutine")
        if p != nil {
            p.WriteTo(goroutineFile, 0)
        }
        goroutineFile.Close()
    }
    
    // Mark profiling complete
    p.mutex.Lock()
    p.lastProfile = time.Now()
    p.isRunning = false
    p.mutex.Unlock()
}
```

Use this adaptive profiler in your application:

```go
func main() {
    // Create a profile directory
    profileDir := "/var/log/myapp/profiles"
    os.MkdirAll(profileDir, 0755)
    
    // Create and start the adaptive profiler
    profiler := NewAdaptiveProfiler(profileDir)
    profiler.Start(context.Background())
    
    // Rest of your application...
}
```

### Analyzing Captured Profiles

To analyze the captured profiles, you can use the standard Go tools:

```bash
go tool pprof -http=:8080 /var/log/myapp/profiles/cpu-20250624-120000.pprof
```

For regular analysis, implement an automation script that processes profiles and generates reports:

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "strings"
    "time"
)

func main() {
    profileDir := "/var/log/myapp/profiles"
    reportDir := "/var/log/myapp/reports"
    
    // Create report directory
    os.MkdirAll(reportDir, 0755)
    
    // Find all CPU profiles from the last 24 hours
    yesterday := time.Now().Add(-24 * time.Hour)
    
    err := filepath.Walk(profileDir, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        
        // Only process CPU profiles
        if !strings.HasPrefix(filepath.Base(path), "cpu-") {
            return nil
        }
        
        // Check if the file is recent enough
        if info.ModTime().Before(yesterday) {
            return nil
        }
        
        // Generate SVG for this profile
        svgPath := filepath.Join(reportDir, strings.TrimSuffix(filepath.Base(path), ".pprof")+".svg")
        cmd := exec.Command("go", "tool", "pprof", "-svg", path)
        svg, err := cmd.Output()
        if err != nil {
            fmt.Printf("Error generating SVG for %s: %v\n", path, err)
            return nil
        }
        
        // Write SVG to file
        err = os.WriteFile(svgPath, svg, 0644)
        if err != nil {
            fmt.Printf("Error writing SVG to %s: %v\n", svgPath, err)
        }
        
        // Also generate a text report
        txtPath := filepath.Join(reportDir, strings.TrimSuffix(filepath.Base(path), ".pprof")+".txt")
        cmd = exec.Command("go", "tool", "pprof", "-top", path)
        txt, err := cmd.Output()
        if err != nil {
            fmt.Printf("Error generating text report for %s: %v\n", path, err)
            return nil
        }
        
        // Write text report to file
        err = os.WriteFile(txtPath, txt, 0644)
        if err != nil {
            fmt.Printf("Error writing text report to %s: %v\n", txtPath, err)
        }
        
        return nil
    })
    
    if err != nil {
        fmt.Printf("Error walking profile directory: %v\n", err)
    }
}
```

## Section 2: Distributed Tracing with OpenTelemetry

Profiling helps identify inefficient code, but distributed tracing shows you the bigger picture of your application's behavior across services. OpenTelemetry is the industry standard for distributed tracing and observability.

### Setting Up OpenTelemetry in Go

First, add the required dependencies:

```go
import (
    "context"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.4.0"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    "time"
)
```

Now, initialize the OpenTelemetry trace provider:

```go
func initTracer(ctx context.Context) (*sdktrace.TracerProvider, error) {
    // Create the OTLP exporter
    conn, err := grpc.DialContext(ctx, "otel-collector:4317", grpc.WithInsecure())
    if err != nil {
        return nil, err
    }
    
    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, err
    }
    
    // Create a resource describing this service
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceNameKey.String("user-service"),
            semconv.ServiceVersionKey.String("v1.0.0"),
            attribute.String("environment", "production"),
        ),
    )
    if err != nil {
        return nil, err
    }
    
    // Create the trace provider with a batch span processor
    bsp := sdktrace.NewBatchSpanProcessor(exporter)
    tracerProvider := sdktrace.NewTracerProvider(
        sdktrace.WithResource(res),
        sdktrace.WithSpanProcessor(bsp),
        // Sample 10% of traces in production for efficient resource usage
        sdktrace.WithSampler(sdktrace.TraceIDRatioBased(0.1)),
    )
    
    // Set the global trace provider
    otel.SetTracerProvider(tracerProvider)
    
    // Set the global propagator
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))
    
    return tracerProvider, nil
}
```

### Adding Tracing to Your Data Layer

Now that we have the tracing infrastructure set up, let's add tracing to our database calls:

```go
type TracedRepository struct {
    db     *sql.DB
    tracer trace.Tracer
}

func NewTracedRepository(db *sql.DB) *TracedRepository {
    return &TracedRepository{
        db:     db,
        tracer: otel.Tracer("data-repository"),
    }
}

func (r *TracedRepository) GetProductByID(ctx context.Context, id int) (*Product, error) {
    ctx, span := r.tracer.Start(ctx, "GetProductByID", 
        trace.WithAttributes(attribute.Int("product.id", id)))
    defer span.End()
    
    // Capture timing for the DB call
    startTime := time.Now()
    
    rows, err := r.db.QueryContext(ctx, "SELECT id, name, price FROM products WHERE id = ?", id)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    defer rows.Close()
    
    // Record DB call duration
    span.SetAttributes(attribute.Float64("db.duration_ms", float64(time.Since(startTime).Milliseconds())))
    
    if !rows.Next() {
        span.SetAttributes(attribute.Bool("product.found", false))
        return nil, ErrProductNotFound
    }
    
    var product Product
    if err := rows.Scan(&product.ID, &product.Name, &product.Price); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    
    span.SetAttributes(attribute.Bool("product.found", true))
    
    // Get related data (potentially causing N+1 problem)
    if err := r.loadProductReviews(ctx, &product); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    
    return &product, nil
}

func (r *TracedRepository) loadProductReviews(ctx context.Context, product *Product) error {
    ctx, span := r.tracer.Start(ctx, "loadProductReviews",
        trace.WithAttributes(attribute.Int("product.id", product.ID)))
    defer span.End()
    
    // Example of a database call that might be inefficient
    rows, err := r.db.QueryContext(ctx, 
        "SELECT id, rating, comment FROM reviews WHERE product_id = ?", 
        product.ID)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return err
    }
    defer rows.Close()
    
    var reviews []Review
    for rows.Next() {
        var review Review
        if err := rows.Scan(&review.ID, &review.Rating, &review.Comment); err != nil {
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
            return err
        }
        reviews = append(reviews, review)
    }
    
    product.Reviews = reviews
    span.SetAttributes(attribute.Int("reviews.count", len(reviews)))
    
    return nil
}
```

### Identifying Problems with Traces

The power of distributed tracing becomes evident when you have multiple services. Let's look at a complete HTTP handler with tracing:

```go
func (h *Handler) GetProductHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    
    // Extract trace context from incoming request
    ctx = otel.GetTextMapPropagator().Extract(ctx, propagation.HeaderCarrier(r.Header))
    
    // Create a new span for this handler
    ctx, span := h.tracer.Start(ctx, "GetProductHandler")
    defer span.End()
    
    // Extract product ID from request
    productID, err := strconv.Atoi(chi.URLParam(r, "id"))
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, "Invalid product ID")
        http.Error(w, "Invalid product ID", http.StatusBadRequest)
        return
    }
    
    span.SetAttributes(attribute.Int("product.id", productID))
    
    // Get product from repository
    product, err := h.repo.GetProductByID(ctx, productID)
    if err != nil {
        span.RecordError(err)
        
        if err == ErrProductNotFound {
            span.SetStatus(codes.Error, "Product not found")
            http.Error(w, "Product not found", http.StatusNotFound)
            return
        }
        
        span.SetStatus(codes.Error, "Failed to get product")
        http.Error(w, "Internal server error", http.StatusInternalServerError)
        return
    }
    
    // Get inventory from separate service
    inventory, err := h.getInventory(ctx, productID)
    if err != nil {
        span.RecordError(err)
        // Continue processing, inventory is not critical
        span.SetAttributes(attribute.Bool("inventory.available", false))
    } else {
        span.SetAttributes(attribute.Bool("inventory.available", true))
        span.SetAttributes(attribute.Int("inventory.quantity", inventory.Quantity))
        product.AvailableQuantity = inventory.Quantity
    }
    
    // Get pricing information (potentially from another service)
    pricing, err := h.getPricing(ctx, productID)
    if err != nil {
        span.RecordError(err)
        // Continue with default pricing
        span.SetAttributes(attribute.Bool("pricing.available", false))
    } else {
        span.SetAttributes(attribute.Bool("pricing.available", true))
        span.SetAttributes(attribute.Float64("pricing.discount", pricing.DiscountPercent))
        product.Price = pricing.CurrentPrice
        product.DiscountPercent = pricing.DiscountPercent
    }
    
    // Respond with JSON
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(product)
}

func (h *Handler) getInventory(ctx context.Context, productID int) (*Inventory, error) {
    ctx, span := h.tracer.Start(ctx, "getInventory")
    defer span.End()
    
    span.SetAttributes(attribute.Int("product.id", productID))
    
    url := fmt.Sprintf("http://inventory-service/products/%d/inventory", productID)
    
    // Create HTTP request with trace context
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    
    // Inject trace context into the outgoing HTTP request
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
    
    // Make HTTP request with timeout
    client := &http.Client{Timeout: 500 * time.Millisecond}
    resp, err := client.Do(req)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    defer resp.Body.Close()
    
    if resp.StatusCode != http.StatusOK {
        err := fmt.Errorf("inventory service returned status %d", resp.StatusCode)
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    
    var inventory Inventory
    if err := json.NewDecoder(resp.Body).Decode(&inventory); err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    
    return &inventory, nil
}
```

With this tracing in place, you can visualize the complete request flow through your system, identify bottlenecks in service calls, database queries, and third-party integrations.

## Section 3: Correlating Profiles with Traces

The real power comes when combining profiling with tracing. Here's how to correlate them:

1. Add profile metadata to trace a specific endpoint:

```go
func (h *Handler) GetProductHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    
    // Start the span as before
    ctx, span := h.tracer.Start(ctx, "GetProductHandler")
    defer span.End()
    
    // Take a CPU profile sample if this is a traced request
    spanContext := span.SpanContext()
    if spanContext.IsSampled() {
        // Capture a 5-second profile
        profileFile := fmt.Sprintf("/var/log/myapp/profiles/endpoint-cpu-%s.pprof", 
            spanContext.TraceID().String())
            
        f, err := os.Create(profileFile)
        if err == nil {
            span.SetAttributes(attribute.String("cpu_profile", profileFile))
            pprof.StartCPUProfile(f)
            defer func() {
                pprof.StopCPUProfile()
                f.Close()
            }()
        }
    }
    
    // Rest of the handler as before
    // ...
}
```

2. Build a simple dashboard to correlate the two:

```go
package main

import (
    "encoding/json"
    "fmt"
    "html/template"
    "net/http"
    "os"
    "path/filepath"
    "strings"
)

type Trace struct {
    ID        string `json:"id"`
    Name      string `json:"name"`
    Timestamp string `json:"timestamp"`
    Duration  int64  `json:"duration_ms"`
    CPUProfile string `json:"cpu_profile,omitempty"`
}

func main() {
    http.HandleFunc("/", handleRoot)
    http.HandleFunc("/traces", handleTraces)
    http.HandleFunc("/profiles/", handleProfiles)
    
    fmt.Println("Starting performance dashboard on :8080")
    http.ListenAndServe(":8080", nil)
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
    tmpl := template.Must(template.New("index").Parse(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Performance Dashboard</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; }
                table { border-collapse: collapse; width: 100%; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                tr:nth-child(even) { background-color: #f2f2f2; }
                th { background-color: #4CAF50; color: white; }
            </style>
            <script>
                async function loadTraces() {
                    const resp = await fetch('/traces');
                    const traces = await resp.json();
                    const tbody = document.getElementById('traces-body');
                    tbody.innerHTML = '';
                    
                    for (const trace of traces) {
                        const row = document.createElement('tr');
                        
                        const idCell = document.createElement('td');
                        idCell.textContent = trace.id;
                        row.appendChild(idCell);
                        
                        const nameCell = document.createElement('td');
                        nameCell.textContent = trace.name;
                        row.appendChild(nameCell);
                        
                        const timeCell = document.createElement('td');
                        timeCell.textContent = trace.timestamp;
                        row.appendChild(timeCell);
                        
                        const durationCell = document.createElement('td');
                        durationCell.textContent = trace.duration_ms + 'ms';
                        row.appendChild(durationCell);
                        
                        const profileCell = document.createElement('td');
                        if (trace.cpu_profile) {
                            const link = document.createElement('a');
                            link.href = '/profiles/' + trace.cpu_profile;
                            link.textContent = 'View CPU Profile';
                            link.target = '_blank';
                            profileCell.appendChild(link);
                        } else {
                            profileCell.textContent = 'N/A';
                        }
                        row.appendChild(profileCell);
                        
                        tbody.appendChild(row);
                    }
                }
                
                window.onload = loadTraces;
            </script>
        </head>
        <body>
            <h1>Performance Dashboard</h1>
            <h2>Recent Traces with Profiles</h2>
            <table>
                <thead>
                    <tr>
                        <th>Trace ID</th>
                        <th>Name</th>
                        <th>Timestamp</th>
                        <th>Duration</th>
                        <th>CPU Profile</th>
                    </tr>
                </thead>
                <tbody id="traces-body">
                    <tr><td colspan="5">Loading...</td></tr>
                </tbody>
            </table>
        </body>
        </html>
    `))
    
    tmpl.Execute(w, nil)
}

func handleTraces(w http.ResponseWriter, r *http.Request) {
    // In a real implementation, you would query your tracing backend
    // For this example, we'll simulate some traces with profile links
    
    traces := []Trace{
        {
            ID:         "d6e73400d48cfb94e716cd8b1c31f6d6",
            Name:       "GetProductHandler",
            Timestamp:  "2025-06-23T15:32:12Z",
            Duration:   327,
            CPUProfile: "endpoint-cpu-d6e73400d48cfb94e716cd8b1c31f6d6.pprof",
        },
        {
            ID:         "b39a2e5a7b1dcf4e8736a9b1c0a45e2d",
            Name:       "GetProductHandler",
            Timestamp:  "2025-06-23T15:30:45Z",
            Duration:   542,
            CPUProfile: "endpoint-cpu-b39a2e5a7b1dcf4e8736a9b1c0a45e2d.pprof",
        },
        {
            ID:         "f8e9a1b2c3d4e5f6a7b8c9d0e1f2a3b4",
            Name:       "SearchProductsHandler",
            Timestamp:  "2025-06-23T15:28:33Z",
            Duration:   892,
            CPUProfile: "endpoint-cpu-f8e9a1b2c3d4e5f6a7b8c9d0e1f2a3b4.pprof",
        },
    }
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(traces)
}

func handleProfiles(w http.ResponseWriter, r *http.Request) {
    profilePath := strings.TrimPrefix(r.URL.Path, "/profiles/")
    
    // Security check - ensure the path doesn't contain ".."
    if strings.Contains(profilePath, "..") {
        http.Error(w, "Invalid path", http.StatusBadRequest)
        return
    }
    
    // Path to profiles directory
    profileDir := "/var/log/myapp/profiles"
    fullPath := filepath.Join(profileDir, profilePath)
    
    // Generate an SVG visualization
    w.Header().Set("Content-Type", "image/svg+xml")
    
    // In a real implementation, you'd use the pprof tool to generate an SVG
    // Here we're simulating the output
    svg := `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
    <svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
        <rect width="800" height="600" fill="#f0f0f0"/>
        <text x="400" y="50" text-anchor="middle" font-family="Arial" font-size="24">
            CPU Profile Visualization for ` + profilePath + `
        </text>
        <text x="400" y="300" text-anchor="middle" font-family="Arial" font-size="18">
            [Actual SVG would be generated from the profile data]
        </text>
    </svg>`
    
    fmt.Fprint(w, svg)
}
```

## Section 4: Practical Application - Finding and Fixing Real Issues

Let's apply these techniques to identify and fix common performance problems:

### 1. Identifying N+1 Query Problems

The trace from our product handler might show:

```
GetProductHandler [328ms]
|
+-- GetProductByID [120ms]
|   |
|   +-- SQL Query: SELECT * FROM products WHERE id = ? [15ms]
|   |
|   +-- loadProductReviews [105ms]
|       |
|       +-- SQL Query: SELECT * FROM reviews WHERE product_id = ? [105ms]
|
+-- getInventory [80ms]
|
+-- getPricing [128ms]
```

Our trace clearly shows that loading product reviews takes 105ms, a significant portion of our request time. The pprof CPU profile might show that our database driver's Scan method is consuming a lot of CPU time.

The solution is to optimize the query with a join:

```go
func (r *TracedRepository) GetProductWithReviews(ctx context.Context, id int) (*Product, error) {
    ctx, span := r.tracer.Start(ctx, "GetProductWithReviews")
    defer span.End()
    
    // Use a JOIN query instead of separate queries
    query := `
        SELECT p.id, p.name, p.price, 
               r.id as review_id, r.rating, r.comment
        FROM products p
        LEFT JOIN reviews r ON p.id = r.product_id
        WHERE p.id = ?
    `
    
    rows, err := r.db.QueryContext(ctx, query, id)
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }
    defer rows.Close()
    
    var product *Product
    reviews := make(map[int]Review)
    
    for rows.Next() {
        var reviewID sql.NullInt64
        var rating sql.NullFloat64
        var comment sql.NullString
        
        if product == nil {
            product = &Product{
                Reviews: []Review{},
            }
            
            if err := rows.Scan(
                &product.ID, &product.Name, &product.Price,
                &reviewID, &rating, &comment,
            ); err != nil {
                span.RecordError(err)
                span.SetStatus(codes.Error, err.Error())
                return nil, err
            }
        } else {
            var productID int
            var name string
            var price float64
            
            if err := rows.Scan(
                &productID, &name, &price,
                &reviewID, &rating, &comment,
            ); err != nil {
                span.RecordError(err)
                span.SetStatus(codes.Error, err.Error())
                return nil, err
            }
        }
        
        // If we have a valid review, add it
        if reviewID.Valid {
            reviewIDInt := int(reviewID.Int64)
            if _, exists := reviews[reviewIDInt]; !exists {
                reviews[reviewIDInt] = Review{
                    ID:      reviewIDInt,
                    Rating:  rating.Float64,
                    Comment: comment.String,
                }
            }
        }
    }
    
    // Convert the map to a slice
    for _, review := range reviews {
        product.Reviews = append(product.Reviews, review)
    }
    
    return product, nil
}
```

After this change, our trace might look like:

```
GetProductHandler [215ms]
|
+-- GetProductWithReviews [30ms]
|   |
|   +-- SQL Query: SELECT products.*, reviews.* FROM products LEFT JOIN reviews... [30ms]
|
+-- getInventory [80ms]
|
+-- getPricing [105ms]
```

### 2. High Latency in Service Calls

Our trace also shows that the pricing service call takes 128ms, which is quite high. Looking at the code, we can see we're not using connection pooling:

```go
// Before:
client := &http.Client{Timeout: 500 * time.Millisecond}
resp, err := client.Do(req)
```

Let's fix this by using a shared HTTP client with proper connection pooling:

```go
// Global HTTP client with connection pooling
var httpClient = &http.Client{
    Timeout: 500 * time.Millisecond,
    Transport: &http.Transport{
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 20,
        IdleConnTimeout:     90 * time.Second,
    },
}

// In the getPricing function:
resp, err := httpClient.Do(req)
```

This simple change could reduce the service call time significantly.

### 3. Memory Allocation Issues

Analysis of the memory profile might show excessive allocations in our JSON serialization code. We can optimize this using a pre-allocated buffer:

```go
// Before:
w.Header().Set("Content-Type", "application/json")
json.NewEncoder(w).Encode(product)

// After:
w.Header().Set("Content-Type", "application/json")
var buf bytes.Buffer
buf.Grow(1024) // Pre-allocate 1KB
enc := json.NewEncoder(&buf)
if err := enc.Encode(product); err != nil {
    // Handle error
    return
}
w.Write(buf.Bytes())
```

## Conclusion

Effective profiling and tracing are essential for maintaining high-performance Go applications in production. By combining continuous profiling with distributed tracing, you can identify exactly what needs to be optimized and measure the improvement after changes.

The techniques presented in this article allow you to:

1. Implement low-overhead continuous profiling that triggers automatically during performance issues
2. Set up distributed tracing to visualize request flow across services
3. Correlate trace data with profile data to get a complete picture
4. Use this information to fix common issues like N+1 queries, inefficient service calls, and memory allocation problems

Remember that optimization should always be data-driven. The combination of profiling and tracing provides the data you need to make informed decisions about where to focus your optimization efforts.

For more on optimizing Go applications, see our related articles on [optimizing Go data layers](/optimizing-go-data-layer-performance/) and [benchmarking Go goroutines](/benchmarking-go-goroutines-scaling-limits-performance/).