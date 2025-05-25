---
title: "Building a Production-Ready Load Balancer in Go"
date: 2025-10-21T09:00:00-05:00
draft: false
tags: ["Go", "Load Balancing", "Distributed Systems", "Networking", "Microservices", "Performance"]
categories:
- Go
- Networking
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing a high-performance, feature-rich load balancer in Go with multiple distribution strategies, health checks, and production optimizations"
more_link: "yes"
url: "/building-load-balancer-golang/"
---

Load balancers are critical components in modern distributed systems, ensuring reliability, scalability, and high availability. This guide walks through building a robust load balancer in Go, from fundamental concepts to advanced features and optimizations.

<!--more-->

# Building a Production-Ready Load Balancer in Go

## Understanding Load Balancers

A load balancer is a critical infrastructure component that distributes incoming network traffic across multiple servers to ensure high availability, reliability, and optimal resource utilization. Before diving into implementation, let's understand the core concepts.

### Types of Load Balancers

Load balancers operate at different layers of the OSI model:

1. **Layer 4 (Transport Layer) Load Balancers**
   - Operate at the transport layer (TCP/UDP)
   - Route traffic based on IP address and port information
   - Simple and fast, with lower overhead
   - Limited application awareness

2. **Layer 7 (Application Layer) Load Balancers**
   - Operate at the application layer (HTTP/HTTPS)
   - Route based on content (URL, headers, cookies, etc.)
   - More intelligent routing capabilities
   - Higher processing overhead

### Load Balancing Algorithms

Several strategies exist for determining how to distribute traffic:

1. **Round Robin**: Distributes requests sequentially among servers
2. **Weighted Round Robin**: Like round robin, but servers with higher capacity receive more requests
3. **Least Connections**: Routes to the server with the fewest active connections
4. **Least Response Time**: Routes to the server with the lowest response time
5. **IP Hash**: Uses client IP address to determine which server receives the request
6. **Random**: Randomly selects a server for each request

### Health Checks

Health checks monitor backend server status:

1. **Active Checks**: The load balancer periodically probes server health
2. **Passive Checks**: Monitoring real client traffic for failures

### Session Persistence

Sometimes called "sticky sessions," this ensures a client continues to connect to the same server:

1. **Source IP**: Uses the client's IP address
2. **Cookie-Based**: Uses HTTP cookies
3. **Application-Controlled**: The application manages session state

## Designing Our Load Balancer

Our Go load balancer will have these key features:

1. Support for multiple load balancing algorithms
2. Health checking (both active and passive)
3. Configurable backends with weight support
4. Metrics collection
5. Clean shutdown and hot reload
6. Extensive logging

Let's start with a basic architecture, then progressively enhance it.

## Basic Implementation: A Simple Reverse Proxy

We'll begin with a simple reverse proxy that forwards requests to a single backend:

```go
package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
)

func main() {
	// Set up a single backend server
	targetURL, err := url.Parse("http://localhost:8081")
	if err != nil {
		log.Fatal(err)
	}

	// Create a reverse proxy
	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Set up the server
	server := http.Server{
		Addr:    ":8080",
		Handler: proxy,
	}

	// Start the server
	log.Printf("Starting load balancer on :8080")
	log.Fatal(server.ListenAndServe())
}
```

This simple example forwards all requests to a single backend. Now, let's extend it to support multiple backends and implement round-robin load balancing.

## Adding Multiple Backends with Round Robin

Next, let's implement round-robin load balancing across multiple backends:

```go
package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
)

// Backend represents a server to forward requests to
type Backend struct {
	URL          *url.URL
	Alive        bool
	ReverseProxy *httputil.ReverseProxy
	mux          sync.RWMutex
}

// SetAlive updates the alive status of the backend
func (b *Backend) SetAlive(alive bool) {
	b.mux.Lock()
	b.Alive = alive
	b.mux.Unlock()
}

// IsAlive returns true if the backend is alive
func (b *Backend) IsAlive() bool {
	b.mux.RLock()
	alive := b.Alive
	b.mux.RUnlock()
	return alive
}

// LoadBalancer represents the load balancer
type LoadBalancer struct {
	backends []*Backend
	current  int
	mux      sync.Mutex
}

// NewLoadBalancer creates a new load balancer
func NewLoadBalancer(backendURLs []string) *LoadBalancer {
	backends := make([]*Backend, len(backendURLs))
	
	for i, rawURL := range backendURLs {
		url, err := url.Parse(rawURL)
		if err != nil {
			log.Fatal(err)
		}
		
		proxy := httputil.NewSingleHostReverseProxy(url)
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("Error: %v", err)
			w.WriteHeader(http.StatusBadGateway)
		}
		
		backends[i] = &Backend{
			URL:          url,
			Alive:        true,
			ReverseProxy: proxy,
		}
	}
	
	return &LoadBalancer{
		backends: backends,
	}
}

// NextBackend returns the next available backend using round-robin selection
func (lb *LoadBalancer) NextBackend() *Backend {
	lb.mux.Lock()
	defer lb.mux.Unlock()
	
	// Initial version: Loop through backends starting from current position
	// until we find an available one
	initialIndex := lb.current
	
	for {
		lb.current = (lb.current + 1) % len(lb.backends)
		if lb.backends[lb.current].IsAlive() {
			return lb.backends[lb.current]
		}
		
		// If we've checked all backends and none are alive, or we've come full circle
		if lb.current == initialIndex {
			return nil
		}
	}
}

// ServeHTTP implements the http.Handler interface
func (lb *LoadBalancer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	backend := lb.NextBackend()
	if backend == nil {
		http.Error(w, "No available backends", http.StatusServiceUnavailable)
		return
	}
	
	log.Printf("Forwarding request to: %s", backend.URL)
	backend.ReverseProxy.ServeHTTP(w, r)
}

func main() {
	// Define backend servers
	backends := []string{
		"http://localhost:8081",
		"http://localhost:8082",
		"http://localhost:8083",
	}
	
	// Create and start the load balancer
	lb := NewLoadBalancer(backends)
	server := http.Server{
		Addr:    ":8080",
		Handler: lb,
	}
	
	log.Printf("Starting load balancer on :8080")
	log.Fatal(server.ListenAndServe())
}
```

This implementation provides basic round-robin load balancing across multiple backends. Next, let's add health checks to detect and route around failed servers.

## Implementing Health Checks

Let's add both active and passive health checks to our load balancer:

```go
package main

import (
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"time"
)

// Backend represents a server to forward requests to
type Backend struct {
	URL          *url.URL
	Alive        bool
	ReverseProxy *httputil.ReverseProxy
	mux          sync.RWMutex
	failCount    int
}

// SetAlive updates the alive status of the backend
func (b *Backend) SetAlive(alive bool) {
	b.mux.Lock()
	b.Alive = alive
	if alive {
		b.failCount = 0
	}
	b.mux.Unlock()
}

// IsAlive returns true if the backend is alive
func (b *Backend) IsAlive() bool {
	b.mux.RLock()
	alive := b.Alive
	b.mux.RUnlock()
	return alive
}

// IncreaseFailCount increases the failure count of the backend
func (b *Backend) IncreaseFailCount() int {
	b.mux.Lock()
	b.failCount++
	count := b.failCount
	b.mux.Unlock()
	return count
}

// ResetFailCount resets the failure count of the backend
func (b *Backend) ResetFailCount() {
	b.mux.Lock()
	b.failCount = 0
	b.mux.Unlock()
}

// LoadBalancer represents the load balancer
type LoadBalancer struct {
	backends       []*Backend
	current        int
	mux            sync.Mutex
	healthCheckInterval time.Duration
	maxFailCount   int
}

// NewLoadBalancer creates a new load balancer
func NewLoadBalancer(backendURLs []string, healthCheckInterval time.Duration, maxFailCount int) *LoadBalancer {
	backends := make([]*Backend, len(backendURLs))
	
	for i, rawURL := range backendURLs {
		url, err := url.Parse(rawURL)
		if err != nil {
			log.Fatal(err)
		}
		
		backends[i] = &Backend{
			URL:          url,
			Alive:        true,
			ReverseProxy: httputil.NewSingleHostReverseProxy(url),
		}
		
		// Configure error handler for passive health checks
		backends[i].ReverseProxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			backend := backends[i]
			failCount := backend.IncreaseFailCount()
			log.Printf("Backend %s request failed: %v, fail count: %d", backend.URL.Host, err, failCount)
			
			// Mark server as down if it fails too many times
			if failCount >= maxFailCount {
				log.Printf("Backend %s is marked as down due to too many failures", backend.URL.Host)
				backend.SetAlive(false)
			}
			
			// Find a new backend for this request
			lb := r.Context().Value("loadbalancer").(*LoadBalancer)
			if newBackend := lb.NextBackend(); newBackend != nil {
				log.Printf("Retrying request on backend %s", newBackend.URL.Host)
				newBackend.ReverseProxy.ServeHTTP(w, r)
				return
			}
			
			// If all backends are down
			http.Error(w, "Service Unavailable", http.StatusServiceUnavailable)
		}
	}
	
	lb := &LoadBalancer{
		backends:       backends,
		healthCheckInterval: healthCheckInterval,
		maxFailCount:   maxFailCount,
	}
	
	// Start active health checks
	go lb.healthCheck()
	
	return lb
}

// NextBackend returns the next available backend using round-robin selection
func (lb *LoadBalancer) NextBackend() *Backend {
	lb.mux.Lock()
	defer lb.mux.Unlock()
	
	// Keep track of starting position to avoid infinite loop
	initialIndex := lb.current
	
	// Try to find a healthy backend
	for i := 0; i < len(lb.backends); i++ {
		idx := (initialIndex + i) % len(lb.backends)
		if lb.backends[idx].IsAlive() {
			lb.current = idx
			return lb.backends[idx]
		}
	}
	
	// No healthy backends found
	return nil
}

// isBackendAlive checks if a backend is alive by establishing a TCP connection
func isBackendAlive(u *url.URL) bool {
	timeout := 2 * time.Second
	conn, err := net.DialTimeout("tcp", u.Host, timeout)
	if err != nil {
		log.Printf("Health check failed for %s: %v", u.Host, err)
		return false
	}
	defer conn.Close()
	return true
}

// healthCheck performs health checks on all backends
func (lb *LoadBalancer) healthCheck() {
	ticker := time.NewTicker(lb.healthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			log.Println("Starting health check...")
			for _, backend := range lb.backends {
				alive := isBackendAlive(backend.URL)
				backend.SetAlive(alive)
				status := "up"
				if !alive {
					status = "down"
				}
				log.Printf("Backend %s status: %s", backend.URL.Host, status)
			}
			log.Println("Health check completed")
		}
	}
}

// ServeHTTP implements the http.Handler interface
func (lb *LoadBalancer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Store load balancer in context for error handler
	ctx := context.WithValue(r.Context(), "loadbalancer", lb)
	r = r.WithContext(ctx)
	
	backend := lb.NextBackend()
	if backend == nil {
		http.Error(w, "No available backends", http.StatusServiceUnavailable)
		return
	}
	
	log.Printf("Forwarding request to: %s", backend.URL.Host)
	backend.ReverseProxy.ServeHTTP(w, r)
	
	// Reset fail count on successful request (passive health check)
	backend.ResetFailCount()
}

func main() {
	// Define backend servers
	backends := []string{
		"http://localhost:8081",
		"http://localhost:8082",
		"http://localhost:8083",
	}
	
	// Create and start the load balancer
	lb := NewLoadBalancer(backends, 30*time.Second, 3)
	server := http.Server{
		Addr:    ":8080",
		Handler: lb,
	}
	
	log.Printf("Starting load balancer on :8080")
	log.Fatal(server.ListenAndServe())
}
```

This implementation now includes:
- **Active health checks** that periodically verify if backends are responsive
- **Passive health checks** that detect failures during actual request processing
- **Failure counting** to mark servers as down after multiple failures
- **Retry logic** that attempts to find an alternative backend when a request fails

## Advanced Features: Multiple Load Balancing Strategies

Now let's expand our load balancer to support multiple load balancing algorithms:

```go
package main

import (
	"hash/fnv"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Strategy represents a load balancing strategy
type Strategy int

const (
	RoundRobin Strategy = iota
	LeastConnections
	IPHash
	Random
	WeightedRoundRobin
)

// Backend represents a server to forward requests to
type Backend struct {
	URL          *url.URL
	Alive        bool
	ReverseProxy *httputil.ReverseProxy
	mux          sync.RWMutex
	failCount    int
	weight       int
	connections  int
}

// LoadBalancer represents the load balancer
type LoadBalancer struct {
	backends           []*Backend
	current            int
	mux                sync.Mutex
	healthCheckInterval time.Duration
	maxFailCount       int
	strategy           Strategy
}

// NewLoadBalancer creates a new load balancer
func NewLoadBalancer(backendURLs []string, weights []int, healthCheckInterval time.Duration, maxFailCount int, strategy Strategy) *LoadBalancer {
	if len(weights) == 0 {
		weights = make([]int, len(backendURLs))
		for i := range weights {
			weights[i] = 1 // Default weight
		}
	}
	
	backends := make([]*Backend, len(backendURLs))
	
	for i, rawURL := range backendURLs {
		url, err := url.Parse(rawURL)
		if err != nil {
			log.Fatal(err)
		}
		
		backends[i] = &Backend{
			URL:          url,
			Alive:        true,
			ReverseProxy: httputil.NewSingleHostReverseProxy(url),
			weight:       weights[i],
		}
		
		// Configure error handler
		// (implementation same as before)
	}
	
	lb := &LoadBalancer{
		backends:           backends,
		healthCheckInterval: healthCheckInterval,
		maxFailCount:       maxFailCount,
		strategy:           strategy,
	}
	
	// Start health checks
	go lb.healthCheck()
	
	return lb
}

// chooseBackendByStrategy selects a backend based on the chosen strategy
func (lb *LoadBalancer) chooseBackendByStrategy(r *http.Request) *Backend {
	lb.mux.Lock()
	defer lb.mux.Unlock()
	
	// Count alive backends
	aliveCount := 0
	for _, b := range lb.backends {
		if b.IsAlive() {
			aliveCount++
		}
	}
	
	if aliveCount == 0 {
		return nil
	}
	
	switch lb.strategy {
	case RoundRobin:
		return lb.roundRobinSelect()
	case LeastConnections:
		return lb.leastConnectionsSelect()
	case IPHash:
		return lb.ipHashSelect(r)
	case Random:
		return lb.randomSelect()
	case WeightedRoundRobin:
		return lb.weightedRoundRobinSelect()
	default:
		return lb.roundRobinSelect()
	}
}

// roundRobinSelect selects a backend using round-robin algorithm
func (lb *LoadBalancer) roundRobinSelect() *Backend {
	// Initial position
	initialPosition := lb.current
	
	// Find next alive backend
	for i := 0; i < len(lb.backends); i++ {
		idx := (initialPosition + i) % len(lb.backends)
		if lb.backends[idx].IsAlive() {
			lb.current = idx
			return lb.backends[idx]
		}
	}
	
	return nil
}

// leastConnectionsSelect selects the backend with the least active connections
func (lb *LoadBalancer) leastConnectionsSelect() *Backend {
	var leastConnBackend *Backend
	leastConn := -1
	
	for _, b := range lb.backends {
		if !b.IsAlive() {
			continue
		}
		
		b.mux.RLock()
		connCount := b.connections
		b.mux.RUnlock()
		
		if leastConn == -1 || connCount < leastConn {
			leastConn = connCount
			leastConnBackend = b
		}
	}
	
	return leastConnBackend
}

// ipHashSelect selects a backend based on client IP hash
func (lb *LoadBalancer) ipHashSelect(r *http.Request) *Backend {
	// Extract client IP
	ip := getClientIP(r)
	
	// Hash the IP
	hash := fnv.New32()
	hash.Write([]byte(ip))
	idx := hash.Sum32() % uint32(len(lb.backends))
	
	// Find the selected backend or next available
	initialIdx := idx
	for i := 0; i < len(lb.backends); i++ {
		checkIdx := (initialIdx + uint32(i)) % uint32(len(lb.backends))
		if lb.backends[checkIdx].IsAlive() {
			return lb.backends[checkIdx]
		}
	}
	
	return nil
}

// randomSelect randomly selects an alive backend
func (lb *LoadBalancer) randomSelect() *Backend {
	// Count alive backends and get their indices
	var aliveIndices []int
	for i, b := range lb.backends {
		if b.IsAlive() {
			aliveIndices = append(aliveIndices, i)
		}
	}
	
	if len(aliveIndices) == 0 {
		return nil
	}
	
	// Pick a random alive backend
	randomIdx := aliveIndices[rand.Intn(len(aliveIndices))]
	return lb.backends[randomIdx]
}

// weightedRoundRobinSelect selects a backend based on its weight
func (lb *LoadBalancer) weightedRoundRobinSelect() *Backend {
	// Count total weight of alive backends
	totalWeight := 0
	for _, b := range lb.backends {
		if b.IsAlive() {
			totalWeight += b.weight
		}
	}
	
	if totalWeight == 0 {
		return nil
	}
	
	// Pick a random point in the total weight
	targetWeight := rand.Intn(totalWeight)
	currentWeight := 0
	
	// Find the backend that contains this weight point
	for _, b := range lb.backends {
		if !b.IsAlive() {
			continue
		}
		
		currentWeight += b.weight
		if targetWeight < currentWeight {
			return b
		}
	}
	
	// Fallback - should not reach here
	return lb.roundRobinSelect()
}

// getClientIP extracts the client IP from a request
func getClientIP(r *http.Request) string {
	// Check for X-Forwarded-For header first
	xForwardedFor := r.Header.Get("X-Forwarded-For")
	if xForwardedFor != "" {
		// X-Forwarded-For can contain multiple IPs, use the first one
		ips := strings.Split(xForwardedFor, ",")
		if len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}
	
	// Otherwise use RemoteAddr
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

// ServeHTTP implements the http.Handler interface
func (lb *LoadBalancer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	backend := lb.chooseBackendByStrategy(r)
	if backend == nil {
		http.Error(w, "No available backends", http.StatusServiceUnavailable)
		return
	}
	
	// Increment connection counter (for least connections strategy)
	backend.mux.Lock()
	backend.connections++
	backend.mux.Unlock()
	
	log.Printf("Forwarding request to: %s", backend.URL.Host)
	
	// Wrap the response writer to intercept the response status
	wrappedWriter := &responseWriterInterceptor{
		ResponseWriter: w,
		statusCode:     http.StatusOK,
	}
	
	backend.ReverseProxy.ServeHTTP(wrappedWriter, r)
	
	// Decrement connection counter when request is done
	backend.mux.Lock()
	backend.connections--
	backend.mux.Unlock()
	
	// Reset fail count on successful request
	if wrappedWriter.statusCode < 500 {
		backend.ResetFailCount()
	}
}

// responseWriterInterceptor wraps http.ResponseWriter to capture the status code
type responseWriterInterceptor struct {
	http.ResponseWriter
	statusCode int
}

// WriteHeader intercepts the status code
func (w *responseWriterInterceptor) WriteHeader(statusCode int) {
	w.statusCode = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

func main() {
	// Define backend servers
	backends := []string{
		"http://localhost:8081",
		"http://localhost:8082",
		"http://localhost:8083",
	}
	
	// Define weights (optional, for weighted round-robin)
	weights := []int{3, 2, 1} // Backend 1 gets 3x traffic of Backend 3
	
	// Initialize random seed
	rand.Seed(time.Now().UnixNano())
	
	// Create and start the load balancer
	lb := NewLoadBalancer(
		backends, 
		weights, 
		30*time.Second,
		3,
		WeightedRoundRobin,
	)
	
	server := http.Server{
		Addr:    ":8080",
		Handler: lb,
	}
	
	log.Printf("Starting load balancer on :8080 with strategy: WeightedRoundRobin")
	log.Fatal(server.ListenAndServe())
}
```

This enhanced implementation now supports multiple load balancing strategies:
- Round Robin
- Least Connections
- IP Hash (for session persistence)
- Random
- Weighted Round Robin

## Adding Configuration via JSON and Command Line Flags

Let's make our load balancer configurable via both a JSON configuration file and command line flags:

```go
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"time"
)

// Config represents the load balancer configuration
type Config struct {
	ListenAddr          string            `json:"listen_addr"`
	HealthCheckInterval time.Duration     `json:"health_check_interval"`
	MaxFailCount        int               `json:"max_fail_count"`
	Strategy            string            `json:"strategy"`
	Backends            []BackendConfig   `json:"backends"`
}

// BackendConfig represents a backend server configuration
type BackendConfig struct {
	URL    string `json:"url"`
	Weight int    `json:"weight"`
}

// parseStrategyString converts a strategy string to a Strategy enum
func parseStrategyString(s string) (Strategy, error) {
	switch s {
	case "round_robin":
		return RoundRobin, nil
	case "least_connections":
		return LeastConnections, nil
	case "ip_hash":
		return IPHash, nil
	case "random":
		return Random, nil
	case "weighted_round_robin":
		return WeightedRoundRobin, nil
	default:
		return 0, fmt.Errorf("unknown strategy: %s", s)
	}
}

func main() {
	// Define command line flags
	configPath := flag.String("config", "", "Path to configuration file")
	listenAddr := flag.String("listen", ":8080", "Address to listen on")
	strategyStr := flag.String("strategy", "round_robin", "Load balancing strategy")
	healthCheckInterval := flag.Duration("health-check-interval", 30*time.Second, "Health check interval")
	maxFailCount := flag.Int("max-fail-count", 3, "Maximum failure count before marking backend as down")
	
	flag.Parse()
	
	var config Config
	
	// If config file is provided, load it
	if *configPath != "" {
		data, err := ioutil.ReadFile(*configPath)
		if err != nil {
			log.Fatalf("Error reading config file: %v", err)
		}
		
		if err := json.Unmarshal(data, &config); err != nil {
			log.Fatalf("Error parsing config file: %v", err)
		}
	} else {
		// Use command line flags
		config = Config{
			ListenAddr:          *listenAddr,
			HealthCheckInterval: *healthCheckInterval,
			MaxFailCount:        *maxFailCount,
			Strategy:            *strategyStr,
			Backends: []BackendConfig{
				{URL: "http://localhost:8081", Weight: 1},
				{URL: "http://localhost:8082", Weight: 1},
				{URL: "http://localhost:8083", Weight: 1},
			},
		}
	}
	
	// Parse strategy
	strategy, err := parseStrategyString(config.Strategy)
	if err != nil {
		log.Fatalf("Invalid strategy: %v", err)
	}
	
	// Extract backends and weights
	backendURLs := make([]string, len(config.Backends))
	weights := make([]int, len(config.Backends))
	
	for i, backend := range config.Backends {
		backendURLs[i] = backend.URL
		weights[i] = backend.Weight
	}
	
	// Create load balancer
	lb := NewLoadBalancer(
		backendURLs,
		weights,
		config.HealthCheckInterval,
		config.MaxFailCount,
		strategy,
	)
	
	// Start server
	server := http.Server{
		Addr:    config.ListenAddr,
		Handler: lb,
	}
	
	log.Printf("Starting load balancer on %s with strategy: %s", config.ListenAddr, config.Strategy)
	log.Fatal(server.ListenAndServe())
}
```

Example JSON configuration file:

```json
{
  "listen_addr": ":8080",
  "health_check_interval": "30s",
  "max_fail_count": 3,
  "strategy": "weighted_round_robin",
  "backends": [
    {
      "url": "http://localhost:8081",
      "weight": 3
    },
    {
      "url": "http://localhost:8082",
      "weight": 2
    },
    {
      "url": "http://localhost:8083",
      "weight": 1
    }
  ]
}
```

## Adding Metrics Collection and Monitoring

Let's enhance our load balancer with metrics collection using Prometheus:

```go
package main

import (
	"log"
	"net/http"
	"time"
	
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics defines our Prometheus metrics
type Metrics struct {
	requestCount        *prometheus.CounterVec
	requestDuration     *prometheus.HistogramVec
	backendUpGauge      *prometheus.GaugeVec
	activeConnections   *prometheus.GaugeVec
	backendResponseTime *prometheus.HistogramVec
	backendErrors       *prometheus.CounterVec
}

// NewMetrics creates a new metrics collection
func NewMetrics(namespace string) *Metrics {
	m := &Metrics{
		requestCount: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Namespace: namespace,
				Name:      "request_count_total",
				Help:      "Total number of requests handled by the load balancer",
			},
			[]string{"backend", "status", "method"},
		),
		requestDuration: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Namespace: namespace,
				Name:      "request_duration_seconds",
				Help:      "Request duration in seconds",
				Buckets:   prometheus.DefBuckets,
			},
			[]string{"backend"},
		),
		backendUpGauge: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Namespace: namespace,
				Name:      "backend_up",
				Help:      "Whether the backend is up (1) or down (0)",
			},
			[]string{"backend"},
		),
		activeConnections: prometheus.NewGaugeVec(
			prometheus.GaugeOpts{
				Namespace: namespace,
				Name:      "backend_connections_active",
				Help:      "Number of active connections per backend",
			},
			[]string{"backend"},
		),
		backendResponseTime: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Namespace: namespace,
				Name:      "backend_response_seconds",
				Help:      "Backend response time in seconds",
				Buckets:   prometheus.DefBuckets,
			},
			[]string{"backend"},
		),
		backendErrors: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Namespace: namespace,
				Name:      "backend_errors_total",
				Help:      "Total number of backend errors",
			},
			[]string{"backend", "error_type"},
		),
	}
	
	// Register metrics
	prometheus.MustRegister(m.requestCount)
	prometheus.MustRegister(m.requestDuration)
	prometheus.MustRegister(m.backendUpGauge)
	prometheus.MustRegister(m.activeConnections)
	prometheus.MustRegister(m.backendResponseTime)
	prometheus.MustRegister(m.backendErrors)
	
	return m
}

// Modify the LoadBalancer to include metrics
type LoadBalancer struct {
	// ... existing fields
	metrics *Metrics
}

// Update ServeHTTP to collect metrics
func (lb *LoadBalancer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	backend := lb.chooseBackendByStrategy(r)
	if backend == nil {
		http.Error(w, "No available backends", http.StatusServiceUnavailable)
		lb.metrics.requestCount.WithLabelValues("none", "503", r.Method).Inc()
		return
	}
	
	// Track request start time
	start := time.Now()
	
	// Increment connection counter
	backend.mux.Lock()
	backend.connections++
	backend.mux.Unlock()
	
	// Update metrics for active connections
	backendLabel := backend.URL.Host
	lb.metrics.activeConnections.WithLabelValues(backendLabel).Inc()
	
	// Create a wrapped response writer to capture the status code
	wrappedWriter := &metricsResponseWriter{
		ResponseWriter: w,
		statusCode:     http.StatusOK,
	}
	
	// Forward the request to the backend
	log.Printf("Forwarding request to: %s", backend.URL.Host)
	backend.ReverseProxy.ServeHTTP(wrappedWriter, r)
	
	// Calculate request duration
	duration := time.Since(start).Seconds()
	
	// Decrement connection counter
	backend.mux.Lock()
	backend.connections--
	backend.mux.Unlock()
	
	// Update metrics for active connections
	lb.metrics.activeConnections.WithLabelValues(backendLabel).Dec()
	
	// Update request metrics
	statusCode := fmt.Sprintf("%d", wrappedWriter.statusCode)
	lb.metrics.requestCount.WithLabelValues(backendLabel, statusCode, r.Method).Inc()
	lb.metrics.requestDuration.WithLabelValues(backendLabel).Observe(duration)
	lb.metrics.backendResponseTime.WithLabelValues(backendLabel).Observe(duration)
	
	// Reset fail count on successful request
	if wrappedWriter.statusCode < 500 {
		backend.ResetFailCount()
	} else {
		lb.metrics.backendErrors.WithLabelValues(backendLabel, "response_error").Inc()
	}
}

// metricsResponseWriter wraps http.ResponseWriter to capture the status code
type metricsResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

// WriteHeader intercepts the status code
func (w *metricsResponseWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

// Update healthCheck to update metrics
func (lb *LoadBalancer) healthCheck() {
	ticker := time.NewTicker(lb.healthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			log.Println("Starting health check...")
			for _, backend := range lb.backends {
				alive := isBackendAlive(backend.URL)
				backend.SetAlive(alive)
				
				// Update metrics
				backendLabel := backend.URL.Host
				if alive {
					lb.metrics.backendUpGauge.WithLabelValues(backendLabel).Set(1)
				} else {
					lb.metrics.backendUpGauge.WithLabelValues(backendLabel).Set(0)
					lb.metrics.backendErrors.WithLabelValues(backendLabel, "health_check").Inc()
				}
				
				status := "up"
				if !alive {
					status = "down"
				}
				log.Printf("Backend %s status: %s", backend.URL.Host, status)
			}
			log.Println("Health check completed")
		}
	}
}

func main() {
	// ... existing setup code
	
	// Create metrics collector
	metrics := NewMetrics("loadbalancer")
	
	// Create load balancer with metrics
	lb := NewLoadBalancer(
		backendURLs,
		weights,
		config.HealthCheckInterval,
		config.MaxFailCount,
		strategy,
	)
	lb.metrics = metrics
	
	// Create a mux to handle both load balancing and metrics
	mux := http.NewServeMux()
	mux.Handle("/", lb)
	mux.Handle("/metrics", promhttp.Handler())
	
	// Start server
	server := http.Server{
		Addr:    config.ListenAddr,
		Handler: mux,
	}
	
	log.Printf("Starting load balancer on %s with strategy: %s", config.ListenAddr, config.Strategy)
	log.Printf("Metrics available at %s/metrics", config.ListenAddr)
	log.Fatal(server.ListenAndServe())
}
```

## Adding Graceful Shutdown and Hot Reload

Let's enhance our load balancer with graceful shutdown and configuration hot reload:

```go
package main

import (
	"context"
	"encoding/json"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	// ... existing setup code
	
	// Create load balancer
	lb := NewLoadBalancer(
		backendURLs,
		weights,
		config.HealthCheckInterval,
		config.MaxFailCount,
		strategy,
	)
	lb.metrics = metrics
	
	// Create a mux to handle load balancing, metrics, and admin endpoints
	mux := http.NewServeMux()
	mux.Handle("/", lb)
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/admin/reload", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		
		// Reload configuration
		if err := reloadConfiguration(lb, *configPath); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("Configuration reloaded successfully"))
	})
	
	// Create server
	server := http.Server{
		Addr:    config.ListenAddr,
		Handler: mux,
	}
	
	// Set up a channel to listen for OS signals
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	
	// Start server in a goroutine
	go func() {
		log.Printf("Starting load balancer on %s with strategy: %s", config.ListenAddr, config.Strategy)
		log.Printf("Metrics available at %s/metrics", config.ListenAddr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Error starting server: %v", err)
		}
	}()
	
	// Wait for interrupt signal
	<-stop
	log.Println("Shutting down server...")
	
	// Create a deadline for shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	
	// Gracefully shutdown the server
	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server shutdown failed: %v", err)
	}
	
	log.Println("Server gracefully stopped")
}

// reloadConfiguration reloads the configuration from the config file
func reloadConfiguration(lb *LoadBalancer, configPath string) error {
	if configPath == "" {
		return fmt.Errorf("no config file provided")
	}
	
	data, err := ioutil.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("error reading config file: %v", err)
	}
	
	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("error parsing config file: %v", err)
	}
	
	// Parse strategy
	strategy, err := parseStrategyString(config.Strategy)
	if err != nil {
		return fmt.Errorf("invalid strategy: %v", err)
	}
	
	// Extract backends and weights
	backendURLs := make([]string, len(config.Backends))
	weights := make([]int, len(config.Backends))
	
	for i, backend := range config.Backends {
		backendURLs[i] = backend.URL
		weights[i] = backend.Weight
	}
	
	// Update load balancer configuration
	lb.mux.Lock()
	lb.healthCheckInterval = config.HealthCheckInterval
	lb.maxFailCount = config.MaxFailCount
	lb.strategy = strategy
	
	// Update backends (keep the existing ones if they're still in the config)
	oldBackends := lb.backends
	lb.backends = make([]*Backend, len(config.Backends))
	
	for i, url := range backendURLs {
		// Check if this backend already exists
		found := false
		for _, oldBackend := range oldBackends {
			if oldBackend.URL.String() == url {
				// Keep the existing backend but update its weight
				lb.backends[i] = oldBackend
				oldBackend.weight = weights[i]
				found = true
				break
			}
		}
		
		// If not found, create a new backend
		if !found {
			parsedURL, _ := url.Parse(url) // Error already checked earlier
			lb.backends[i] = &Backend{
				URL:          parsedURL,
				Alive:        true, // Assume alive until health check
				ReverseProxy: httputil.NewSingleHostReverseProxy(parsedURL),
				weight:       weights[i],
			}
			
			// Set up error handler
			// ... (same as in NewLoadBalancer)
		}
	}
	
	lb.mux.Unlock()
	
	log.Printf("Configuration reloaded with %d backends and strategy: %s", len(lb.backends), config.Strategy)
	return nil
}
```

## Performance Optimization

Let's optimize the load balancer for high performance:

```go
package main

import (
	"net"
	"net/http"
	"sync/atomic"
	"time"
)

// For round robin selection, use atomic operations instead of locks
func (lb *LoadBalancer) fastRoundRobinSelect() *Backend {
	numBackends := len(lb.backends)
	initialIndex := int(atomic.LoadUint32(&lb.atomicCurrent)) % numBackends
	
	for i := 0; i < numBackends; i++ {
		idx := (initialIndex + i) % numBackends
		if lb.backends[idx].IsAlive() {
			atomic.StoreUint32(&lb.atomicCurrent, uint32(idx+1))
			return lb.backends[idx]
		}
	}
	
	return nil
}

// Use connection pooling for health checks
func (lb *LoadBalancer) optimizedHealthCheck() {
	// Create a transport with connection pooling
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   2 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   2 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	
	client := &http.Client{
		Transport: transport,
		Timeout:   3 * time.Second,
	}
	
	ticker := time.NewTicker(lb.healthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Use a worker pool to check health in parallel
			results := make(chan struct {
				index int
				alive bool
			}, len(lb.backends))
			
			// Launch goroutines for each backend
			for i, backend := range lb.backends {
				go func(i int, backend *Backend) {
					alive := isBackendAliveHTTP(backend.URL, client)
					results <- struct {
						index int
						alive bool
					}{i, alive}
				}(i, backend)
			}
			
			// Collect results
			for i := 0; i < len(lb.backends); i++ {
				result := <-results
				backend := lb.backends[result.index]
				backend.SetAlive(result.alive)
				
				// Update metrics
				backendLabel := backend.URL.Host
				if result.alive {
					lb.metrics.backendUpGauge.WithLabelValues(backendLabel).Set(1)
				} else {
					lb.metrics.backendUpGauge.WithLabelValues(backendLabel).Set(0)
					lb.metrics.backendErrors.WithLabelValues(backendLabel, "health_check").Inc()
				}
			}
		}
	}
}

// isBackendAliveHTTP checks if a backend is alive by making an HTTP request
func isBackendAliveHTTP(u *url.URL, client *http.Client) bool {
	resp, err := client.Get(u.String() + "/health") // Assuming backends have a /health endpoint
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode < 500 // Consider any non-5xx response as alive
}

// Use a pre-copy buffer pool for proxy operations
var bufferPool = &sync.Pool{
	New: func() interface{} {
		return make([]byte, 32*1024) // 32KB buffers
	},
}

// Use an optimized reverse proxy that reuses buffers
func createOptimizedReverseProxy(target *url.URL) *httputil.ReverseProxy {
	director := func(req *http.Request) {
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.URL.Path = singleJoiningSlash(target.Path, req.URL.Path)
		
		// Preserve the Host header if specified
		if req.Header.Get("Host") == "" {
			req.Host = target.Host
		}
		
		// If the target has query parameters, add them
		targetQuery := target.RawQuery
		if targetQuery == "" || req.URL.RawQuery == "" {
			req.URL.RawQuery = targetQuery + req.URL.RawQuery
		} else {
			req.URL.RawQuery = targetQuery + "&" + req.URL.RawQuery
		}
	}
	
	// Create a transport with optimized connection pooling
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   100,  // Important for load balancers
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		// Enable HTTP/2 if needed
		ForceAttemptHTTP2: true,
	}
	
	return &httputil.ReverseProxy{
		Director:  director,
		Transport: transport,
		BufferPool: bufferPool,
	}
}

// Utility function to join paths
func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		return a + "/" + b
	}
	return a + b
}
```

## Complete Example: Bringing It All Together

Here's how to use our complete load balancer:

1. **Create a configuration file**:
```json
{
  "listen_addr": ":8080",
  "health_check_interval": "30s",
  "max_fail_count": 3,
  "strategy": "weighted_round_robin",
  "backends": [
    {
      "url": "http://backend1:8081",
      "weight": 3
    },
    {
      "url": "http://backend2:8082",
      "weight": 2
    },
    {
      "url": "http://backend3:8083",
      "weight": 1
    }
  ]
}
```

2. **Run the load balancer**:
```bash
go run main.go --config=config.json
```

3. **Monitor metrics**:
```bash
curl localhost:8080/metrics
```

4. **Reload configuration**:
```bash
curl -X POST localhost:8080/admin/reload
```

## Conclusion: Building Enterprise-Grade Load Balancers

We've built a high-performance, feature-rich load balancer in Go that supports:

1. **Multiple load balancing strategies**:
   - Round Robin
   - Weighted Round Robin
   - Least Connections
   - IP Hash (session persistence)
   - Random Selection

2. **Health checking**:
   - Active monitoring
   - Passive detection of failures
   - Configurable failure thresholds

3. **Production-ready features**:
   - Prometheus metrics collection
   - Configuration via file and flags
   - Hot reload of configuration
   - Graceful shutdown
   - Performance optimizations

4. **Extensibility**:
   - Easy to add new strategies
   - Modular design for extending functionality

While our implementation is powerful, it's important to note that for critical production environments, mature solutions like NGINX, HAProxy, or Envoy might be more appropriate due to their extensive battle-testing and feature sets. However, understanding how load balancers work from the ground up is invaluable for any systems engineer or developer working with distributed systems.

This implementation also demonstrates Go's strengths in building networking software - its concurrency model, standard library, and performance characteristics make it an excellent choice for network services like load balancers, proxies, and API gateways.

By building on these concepts, you can create specialized load balancers for your specific use cases, from simple application-level traffic distribution to complex service mesh ingress controllers.