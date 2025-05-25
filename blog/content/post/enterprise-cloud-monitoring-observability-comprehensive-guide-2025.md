---
title: "Enterprise Cloud Monitoring & Observability: Comprehensive Guide 2025"
date: 2026-02-10T09:00:00-05:00
draft: false
description: "Comprehensive enterprise guide to cloud monitoring and observability covering Prometheus, Grafana, distributed tracing, OpenTelemetry, and advanced monitoring strategies for production systems."
tags: ["monitoring", "observability", "prometheus", "grafana", "opentelemetry", "distributed-tracing", "enterprise", "cloud", "devops", "sre"]
categories: ["Cloud Monitoring", "Enterprise Observability", "DevOps"]
author: "Support Tools"
showToc: true
TocOpen: false
hidemeta: false
comments: false
disableHLJS: false
disableShare: false
hideSummary: false
searchHidden: false
ShowReadingTime: true
ShowBreadCrumbs: true
ShowPostNavLinks: true
ShowWordCount: true
ShowRssButtonInSectionTermList: true
UseHugoToc: true
cover:
    image: ""
    alt: ""
    caption: ""
    relative: false
    hidden: true
editPost:
    URL: "https://github.com/supporttools/website/tree/main/blog/content"
    Text: "Suggest Changes"
    appendFilePath: true
---

# Enterprise Cloud Monitoring & Observability: Comprehensive Guide 2025

## Introduction

Enterprise cloud monitoring and observability in 2025 requires sophisticated approaches to handle distributed systems, microservices, and complex cloud-native architectures. This comprehensive guide covers advanced monitoring strategies, distributed tracing, metrics collection, alerting frameworks, and observability best practices for production enterprise systems.

## Chapter 1: Enterprise Monitoring Architecture

### Comprehensive Monitoring Stack Design

```go
// Enterprise monitoring architecture framework
package monitoring

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"
    
    "github.com/prometheus/client_golang/api"
    "github.com/prometheus/client_golang/api/v1"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/jaeger"
    "go.opentelemetry.io/otel/exporters/prometheus"
    "go.opentelemetry.io/otel/metric"
    "go.opentelemetry.io/otel/sdk/metric"
    "go.opentelemetry.io/otel/trace"
)

// EnterpriseMonitoringSystem provides comprehensive monitoring capabilities
type EnterpriseMonitoringSystem struct {
    // Metrics collection
    metricsRegistry    prometheus.Registerer
    metricsGatherer    prometheus.Gatherer
    customMetrics      map[string]prometheus.Collector
    
    // Distributed tracing
    tracer             trace.Tracer
    tracerProvider     *trace.TracerProvider
    
    // OpenTelemetry integration
    meterProvider      *metric.MeterProvider
    meter              metric.Meter
    
    // Alerting system
    alertManager       *AlertManager
    
    // Configuration
    config             *MonitoringConfig
    
    // Health checking
    healthCheckers     map[string]HealthChecker
    
    // SLI/SLO tracking
    sloTracker         *SLOTracker
    
    // Thread safety
    mutex              sync.RWMutex
}

type MonitoringConfig struct {
    ServiceName         string
    ServiceVersion      string
    Environment         string
    
    // Metrics configuration
    MetricsEnabled      bool
    MetricsPort         int
    MetricsPath         string
    ScrapeInterval      time.Duration
    
    // Tracing configuration
    TracingEnabled      bool
    TracingSampleRate   float64
    JaegerEndpoint      string
    
    // Alerting configuration
    AlertingEnabled     bool
    AlertManagerURL     string
    
    // SLO configuration
    SLOEnabled          bool
    SLOTargets          map[string]float64
    
    // Health check configuration
    HealthCheckEnabled  bool
    HealthCheckInterval time.Duration
}

// Create enterprise monitoring system
func NewEnterpriseMonitoringSystem(config *MonitoringConfig) (*EnterpriseMonitoringSystem, error) {
    ems := &EnterpriseMonitoringSystem{
        config:         config,
        customMetrics:  make(map[string]prometheus.Collector),
        healthCheckers: make(map[string]HealthChecker),
    }
    
    // Initialize metrics
    if config.MetricsEnabled {
        if err := ems.initializeMetrics(); err != nil {
            return nil, fmt.Errorf("failed to initialize metrics: %w", err)
        }
    }
    
    // Initialize tracing
    if config.TracingEnabled {
        if err := ems.initializeTracing(); err != nil {
            return nil, fmt.Errorf("failed to initialize tracing: %w", err)
        }
    }
    
    // Initialize alerting
    if config.AlertingEnabled {
        ems.alertManager = NewAlertManager(config.AlertManagerURL)
    }
    
    // Initialize SLO tracking
    if config.SLOEnabled {
        ems.sloTracker = NewSLOTracker(config.SLOTargets)
    }
    
    return ems, nil
}

// Initialize Prometheus metrics
func (ems *EnterpriseMonitoringSystem) initializeMetrics() error {
    registry := prometheus.NewRegistry()
    ems.metricsRegistry = registry
    ems.metricsGatherer = registry
    
    // Register default metrics
    if err := ems.registerDefaultMetrics(); err != nil {
        return err
    }
    
    return nil
}

// Register default enterprise metrics
func (ems *EnterpriseMonitoringSystem) registerDefaultMetrics() error {
    // HTTP request metrics
    httpRequests := prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "endpoint", "status_code", "service"},
    )
    
    httpDuration := prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
        },
        []string{"method", "endpoint", "service"},
    )
    
    // Database metrics
    dbConnections := prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "database_connections_active",
            Help: "Number of active database connections",
        },
        []string{"database", "service"},
    )
    
    dbQueryDuration := prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "database_query_duration_seconds",
            Help:    "Database query duration in seconds",
            Buckets: prometheus.ExponentialBuckets(0.0001, 2, 20),
        },
        []string{"query_type", "database", "service"},
    )
    
    // Business metrics
    businessEvents := prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "business_events_total",
            Help: "Total number of business events",
        },
        []string{"event_type", "status", "service"},
    )
    
    // Error metrics
    errorRate := prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "errors_total",
            Help: "Total number of errors",
        },
        []string{"error_type", "severity", "service"},
    )
    
    // Resource utilization metrics
    memoryUsage := prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "memory_usage_bytes",
            Help: "Memory usage in bytes",
        },
        []string{"memory_type", "service"},
    )
    
    cpuUsage := prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "cpu_usage_percent",
            Help: "CPU usage percentage",
        },
        []string{"cpu_type", "service"},
    )
    
    // Register all metrics
    collectors := map[string]prometheus.Collector{
        "http_requests":      httpRequests,
        "http_duration":      httpDuration,
        "db_connections":     dbConnections,
        "db_query_duration":  dbQueryDuration,
        "business_events":    businessEvents,
        "error_rate":         errorRate,
        "memory_usage":       memoryUsage,
        "cpu_usage":          cpuUsage,
    }
    
    for name, collector := range collectors {
        if err := ems.metricsRegistry.Register(collector); err != nil {
            return fmt.Errorf("failed to register metric %s: %w", name, err)
        }
        ems.customMetrics[name] = collector
    }
    
    return nil
}

// Initialize distributed tracing
func (ems *EnterpriseMonitoringSystem) initializeTracing() error {
    // Create Jaeger exporter
    exp, err := jaeger.New(jaeger.WithCollectorEndpoint(jaeger.WithEndpoint(ems.config.JaegerEndpoint)))
    if err != nil {
        return fmt.Errorf("failed to create Jaeger exporter: %w", err)
    }
    
    // Create tracer provider
    tp := trace.NewTracerProvider(
        trace.WithBatcher(exp),
        trace.WithSampler(trace.TraceIDRatioBased(ems.config.TracingSampleRate)),
        trace.WithResource(
            resource.NewWithAttributes(
                semconv.SchemaURL,
                semconv.ServiceNameKey.String(ems.config.ServiceName),
                semconv.ServiceVersionKey.String(ems.config.ServiceVersion),
                semconv.DeploymentEnvironmentKey.String(ems.config.Environment),
            ),
        ),
    )
    
    ems.tracerProvider = tp
    otel.SetTracerProvider(tp)
    
    // Create tracer
    ems.tracer = tp.Tracer(ems.config.ServiceName)
    
    return nil
}

// Enterprise metrics collection framework
type MetricsCollector struct {
    collectors     map[string]CustomCollector
    registry       prometheus.Registerer
    config         *CollectorConfig
    
    // Collection intervals
    intervals      map[string]time.Duration
    stopChannels   map[string]chan struct{}
    
    mutex          sync.RWMutex
}

type CustomCollector interface {
    Name() string
    Description() string
    Collect() (map[string]float64, error)
    Labels() []string
}

type CollectorConfig struct {
    DefaultInterval    time.Duration
    MaxConcurrency     int
    TimeoutDuration    time.Duration
    RetryAttempts      int
    EnableProfiling    bool
}

// Business metrics collector
type BusinessMetricsCollector struct {
    name          string
    dataSource    BusinessDataSource
    metrics       map[string]prometheus.Collector
}

func NewBusinessMetricsCollector(name string, dataSource BusinessDataSource) *BusinessMetricsCollector {
    return &BusinessMetricsCollector{
        name:       name,
        dataSource: dataSource,
        metrics:    make(map[string]prometheus.Collector),
    }
}

func (bmc *BusinessMetricsCollector) Name() string {
    return bmc.name
}

func (bmc *BusinessMetricsCollector) Description() string {
    return fmt.Sprintf("Business metrics collector for %s", bmc.name)
}

func (bmc *BusinessMetricsCollector) Collect() (map[string]float64, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    
    // Collect business metrics
    metrics := make(map[string]float64)
    
    // Revenue metrics
    revenue, err := bmc.dataSource.GetRevenue(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to collect revenue metrics: %w", err)
    }
    metrics["revenue_total"] = revenue.Total
    metrics["revenue_recurring"] = revenue.Recurring
    metrics["revenue_one_time"] = revenue.OneTime
    
    // User metrics
    users, err := bmc.dataSource.GetUserMetrics(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to collect user metrics: %w", err)
    }
    metrics["users_active_daily"] = float64(users.ActiveDaily)
    metrics["users_active_monthly"] = float64(users.ActiveMonthly)
    metrics["users_new_signups"] = float64(users.NewSignups)
    
    // Performance metrics
    performance, err := bmc.dataSource.GetPerformanceMetrics(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to collect performance metrics: %w", err)
    }
    metrics["response_time_avg"] = performance.AvgResponseTime
    metrics["throughput_requests_per_second"] = performance.RequestsPerSecond
    metrics["error_rate_percent"] = performance.ErrorRate
    
    return metrics, nil
}

func (bmc *BusinessMetricsCollector) Labels() []string {
    return []string{"service", "environment", "region"}
}

// Infrastructure metrics collector
type InfrastructureMetricsCollector struct {
    name           string
    systemMonitor  SystemMonitor
    cloudProvider  CloudProvider
}

func NewInfrastructureMetricsCollector(name string, systemMonitor SystemMonitor, cloudProvider CloudProvider) *InfrastructureMetricsCollector {
    return &InfrastructureMetricsCollector{
        name:          name,
        systemMonitor: systemMonitor,
        cloudProvider: cloudProvider,
    }
}

func (imc *InfrastructureMetricsCollector) Name() string {
    return imc.name
}

func (imc *InfrastructureMetricsCollector) Description() string {
    return "Infrastructure and system metrics collector"
}

func (imc *InfrastructureMetricsCollector) Collect() (map[string]float64, error) {
    metrics := make(map[string]float64)
    
    // System metrics
    sysMetrics, err := imc.systemMonitor.GetSystemMetrics()
    if err != nil {
        return nil, err
    }
    
    metrics["cpu_usage_percent"] = sysMetrics.CPUUsage
    metrics["memory_usage_percent"] = sysMetrics.MemoryUsage
    metrics["disk_usage_percent"] = sysMetrics.DiskUsage
    metrics["network_bytes_in"] = sysMetrics.NetworkBytesIn
    metrics["network_bytes_out"] = sysMetrics.NetworkBytesOut
    
    // Cloud provider metrics
    if imc.cloudProvider != nil {
        cloudMetrics, err := imc.cloudProvider.GetCloudMetrics()
        if err != nil {
            return nil, err
        }
        
        metrics["cloud_cost_daily"] = cloudMetrics.DailyCost
        metrics["cloud_instances_running"] = float64(cloudMetrics.RunningInstances)
        metrics["cloud_storage_used_gb"] = cloudMetrics.StorageUsedGB
    }
    
    return metrics, nil
}

func (imc *InfrastructureMetricsCollector) Labels() []string {
    return []string{"hostname", "region", "availability_zone", "instance_type"}
}

// Advanced alerting system
type AlertManager struct {
    alertRules      map[string]*AlertRule
    alertChannels   map[string]AlertChannel
    alertHistory    *AlertHistory
    escalationTree  *EscalationTree
    
    // Alert suppression
    suppressionRules map[string]*SuppressionRule
    activeAlerts     map[string]*Alert
    
    mutex           sync.RWMutex
}

type AlertRule struct {
    ID              string
    Name            string
    Description     string
    Query           string
    Threshold       float64
    Operator        ComparisonOperator
    Duration        time.Duration
    Severity        AlertSeverity
    Labels          map[string]string
    Annotations     map[string]string
    
    // Advanced features
    Runbook         string
    DashboardURL    string
    SLOImpact       string
}

type AlertSeverity int

const (
    SeverityInfo AlertSeverity = iota
    SeverityWarning
    SeverityError
    SeverityCritical
)

type ComparisonOperator int

const (
    OperatorGreaterThan ComparisonOperator = iota
    OperatorLessThan
    OperatorEqual
    OperatorNotEqual
)

type Alert struct {
    ID              string
    RuleID          string
    Name            string
    Description     string
    Severity        AlertSeverity
    Status          AlertStatus
    FiredAt         time.Time
    ResolvedAt      *time.Time
    
    // Context
    Labels          map[string]string
    Annotations     map[string]string
    Value           float64
    
    // Escalation
    EscalationLevel int
    AssignedTo      string
    
    // SLO impact
    SLOImpact       *SLOImpact
}

type AlertStatus int

const (
    StatusFiring AlertStatus = iota
    StatusPending
    StatusResolved
    StatusSuppressed
)

// SLO tracking and management
type SLOTracker struct {
    slos            map[string]*SLO
    measurements    map[string]*SLOMeasurement
    alertManager    *AlertManager
    
    // Time windows
    windowSizes     []time.Duration
    
    mutex           sync.RWMutex
}

type SLO struct {
    ID              string
    Name            string
    Description     string
    ServiceName     string
    
    // SLI configuration
    SLI             *SLI
    
    // Objective
    Target          float64  // e.g., 99.9% availability
    TimeWindow      time.Duration
    
    // Error budget
    ErrorBudget     float64
    BurnRate        float64
    
    // Alerting
    AlertRules      []*AlertRule
}

type SLI struct {
    Type            SLIType
    Query           string
    GoodQuery       string
    TotalQuery      string
    
    // Thresholds
    Thresholds      map[string]float64
}

type SLIType int

const (
    SLITypeAvailability SLIType = iota
    SLITypeLatency
    SLITypeErrorRate
    SLITypeThroughput
)

type SLOMeasurement struct {
    SLOID           string
    Timestamp       time.Time
    Value           float64
    Target          float64
    ErrorBudget     float64
    BurnRate        float64
    Status          SLOStatus
}

type SLOStatus int

const (
    SLOStatusHealthy SLOStatus = iota
    SLOStatusWarning
    SLOStatusCritical
    SLOStatusExhausted
)

// Distributed tracing enhancement
type EnterpriseTracer struct {
    tracer          trace.Tracer
    spanProcessors  []SpanProcessor
    samplingRules   []*SamplingRule
    
    // Custom attributes
    defaultLabels   map[string]string
    
    // Performance tracking
    spanMetrics     *SpanMetrics
}

type SpanProcessor interface {
    ProcessSpan(span trace.Span) error
}

type SamplingRule struct {
    ServicePattern  string
    OperationPattern string
    SampleRate      float64
    Priority        int
}

type SpanMetrics struct {
    SpanCount       prometheus.Counter
    SpanDuration    prometheus.Histogram
    SpanErrors      prometheus.Counter
}

// Create enhanced tracer
func NewEnterpriseTracer(tracer trace.Tracer, config *TracerConfig) *EnterpriseTracer {
    et := &EnterpriseTracer{
        tracer:        tracer,
        defaultLabels: config.DefaultLabels,
        samplingRules: config.SamplingRules,
    }
    
    // Initialize span metrics
    et.spanMetrics = &SpanMetrics{
        SpanCount: prometheus.NewCounter(prometheus.CounterOpts{
            Name: "traces_spans_total",
            Help: "Total number of spans created",
        }),
        SpanDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
            Name:    "traces_span_duration_seconds",
            Help:    "Span duration in seconds",
            Buckets: prometheus.ExponentialBuckets(0.0001, 2, 20),
        }),
        SpanErrors: prometheus.NewCounter(prometheus.CounterOpts{
            Name: "traces_span_errors_total",
            Help: "Total number of span errors",
        }),
    }
    
    return et
}

// Create span with enterprise features
func (et *EnterpriseTracer) StartSpan(ctx context.Context, operationName string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
    // Add default labels
    for key, value := range et.defaultLabels {
        opts = append(opts, trace.WithAttributes(attribute.String(key, value)))
    }
    
    // Start span
    ctx, span := et.tracer.Start(ctx, operationName, opts...)
    
    // Process through custom processors
    for _, processor := range et.spanProcessors {
        if err := processor.ProcessSpan(span); err != nil {
            // Log error but don't fail
            continue
        }
    }
    
    // Update metrics
    et.spanMetrics.SpanCount.Inc()
    
    return ctx, span
}

// Health checking framework
type HealthChecker interface {
    Name() string
    Check(ctx context.Context) HealthStatus
    Dependencies() []string
}

type HealthStatus struct {
    Status      string
    Message     string
    Details     map[string]interface{}
    Timestamp   time.Time
    Duration    time.Duration
}

type DatabaseHealthChecker struct {
    name     string
    db       DatabaseConnection
    timeout  time.Duration
}

func (dhc *DatabaseHealthChecker) Name() string {
    return dhc.name
}

func (dhc *DatabaseHealthChecker) Check(ctx context.Context) HealthStatus {
    start := time.Now()
    
    ctxWithTimeout, cancel := context.WithTimeout(ctx, dhc.timeout)
    defer cancel()
    
    // Perform health check
    err := dhc.db.Ping(ctxWithTimeout)
    duration := time.Since(start)
    
    if err != nil {
        return HealthStatus{
            Status:    "unhealthy",
            Message:   fmt.Sprintf("Database ping failed: %v", err),
            Timestamp: time.Now(),
            Duration:  duration,
        }
    }
    
    // Get additional details
    details := make(map[string]interface{})
    if stats := dhc.db.Stats(); stats != nil {
        details["open_connections"] = stats.OpenConnections
        details["in_use"] = stats.InUse
        details["idle"] = stats.Idle
    }
    
    return HealthStatus{
        Status:    "healthy",
        Message:   "Database is responsive",
        Details:   details,
        Timestamp: time.Now(),
        Duration:  duration,
    }
}

func (dhc *DatabaseHealthChecker) Dependencies() []string {
    return []string{"database"}
}

// HTTP middleware for monitoring
func (ems *EnterpriseMonitoringSystem) HTTPMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        
        // Start tracing
        ctx, span := ems.tracer.Start(r.Context(), fmt.Sprintf("%s %s", r.Method, r.URL.Path))
        defer span.End()
        
        // Add request attributes to span
        span.SetAttributes(
            attribute.String("http.method", r.Method),
            attribute.String("http.url", r.URL.String()),
            attribute.String("http.user_agent", r.UserAgent()),
        )
        
        // Wrap response writer to capture status code
        wrapped := &responseWriter{ResponseWriter: w, statusCode: 200}
        
        // Process request
        next.ServeHTTP(wrapped, r.WithContext(ctx))
        
        // Record metrics
        duration := time.Since(start)
        
        if httpRequests, ok := ems.customMetrics["http_requests"].(*prometheus.CounterVec); ok {
            httpRequests.WithLabelValues(
                r.Method,
                r.URL.Path,
                fmt.Sprintf("%d", wrapped.statusCode),
                ems.config.ServiceName,
            ).Inc()
        }
        
        if httpDuration, ok := ems.customMetrics["http_duration"].(*prometheus.HistogramVec); ok {
            httpDuration.WithLabelValues(
                r.Method,
                r.URL.Path,
                ems.config.ServiceName,
            ).Observe(duration.Seconds())
        }
        
        // Add response attributes to span
        span.SetAttributes(
            attribute.Int("http.status_code", wrapped.statusCode),
            attribute.Float64("http.duration_ms", float64(duration.Nanoseconds())/1000000),
        )
        
        // Set span status based on HTTP status code
        if wrapped.statusCode >= 400 {
            span.SetStatus(codes.Error, fmt.Sprintf("HTTP %d", wrapped.statusCode))
        }
    })
}

type responseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

// Interface definitions
type BusinessDataSource interface {
    GetRevenue(ctx context.Context) (*RevenueMetrics, error)
    GetUserMetrics(ctx context.Context) (*UserMetrics, error)
    GetPerformanceMetrics(ctx context.Context) (*PerformanceMetrics, error)
}

type SystemMonitor interface {
    GetSystemMetrics() (*SystemMetrics, error)
}

type CloudProvider interface {
    GetCloudMetrics() (*CloudMetrics, error)
}

type DatabaseConnection interface {
    Ping(ctx context.Context) error
    Stats() *DatabaseStats
}

// Data structures
type RevenueMetrics struct {
    Total     float64
    Recurring float64
    OneTime   float64
}

type UserMetrics struct {
    ActiveDaily   int
    ActiveMonthly int
    NewSignups    int
}

type PerformanceMetrics struct {
    AvgResponseTime    float64
    RequestsPerSecond  float64
    ErrorRate          float64
}

type SystemMetrics struct {
    CPUUsage        float64
    MemoryUsage     float64
    DiskUsage       float64
    NetworkBytesIn  float64
    NetworkBytesOut float64
}

type CloudMetrics struct {
    DailyCost        float64
    RunningInstances int
    StorageUsedGB    float64
}

type DatabaseStats struct {
    OpenConnections int
    InUse          int
    Idle           int
}

type TracerConfig struct {
    DefaultLabels  map[string]string
    SamplingRules  []*SamplingRule
}

type AlertChannel interface {
    SendAlert(alert *Alert) error
}

type AlertHistory interface {
    RecordAlert(alert *Alert) error
    GetAlertHistory(filters map[string]string) ([]*Alert, error)
}

type EscalationTree interface {
    GetNextEscalation(alert *Alert) (string, error)
}

type SuppressionRule struct {
    ID          string
    Pattern     string
    Duration    time.Duration
    Reason      string
}

type SLOImpact struct {
    SLOID       string
    Impact      string
    Severity    AlertSeverity
}
```

## Chapter 2: Advanced Prometheus Configuration

### Enterprise Prometheus Setup

```yaml
# Advanced Prometheus configuration for enterprise environments
global:
  scrape_interval: 15s
  scrape_timeout: 10s
  evaluation_interval: 15s
  external_labels:
    cluster: 'production'
    region: 'us-west-2'
    environment: 'prod'

# Rule files configuration
rule_files:
  - "/etc/prometheus/rules/*.yml"
  - "/etc/prometheus/slo/*.yml"
  - "/etc/prometheus/alerting/*.yml"

# Scrape configurations for enterprise services
scrape_configs:
  # Kubernetes API server
  - job_name: 'kubernetes-apiservers'
    kubernetes_sd_configs:
      - role: endpoints
        namespaces:
          names:
            - default
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      insecure_skip_verify: false
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    relabel_configs:
      - source_labels: [__meta_kubernetes_namespace, __meta_kubernetes_service_name, __meta_kubernetes_endpoint_port_name]
        action: keep
        regex: default;kubernetes;https
      - target_label: __address__
        replacement: kubernetes.default.svc:443

  # Kubernetes nodes
  - job_name: 'kubernetes-nodes'
    kubernetes_sd_configs:
      - role: node
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      insecure_skip_verify: false
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    relabel_configs:
      - action: labelmap
        regex: __meta_kubernetes_node_label_(.+)
      - target_label: __address__
        replacement: kubernetes.default.svc:443
      - source_labels: [__meta_kubernetes_node_name]
        regex: (.+)
        target_label: __metrics_path__
        replacement: /api/v1/nodes/${1}/proxy/metrics

  # Kubernetes pods
  - job_name: 'kubernetes-pods'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
        target_label: __address__
      - action: labelmap
        regex: __meta_kubernetes_pod_label_(.+)
      - source_labels: [__meta_kubernetes_namespace]
        action: replace
        target_label: kubernetes_namespace
      - source_labels: [__meta_kubernetes_pod_name]
        action: replace
        target_label: kubernetes_pod_name

  # Enterprise applications
  - job_name: 'enterprise-apps'
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
            - production
            - staging
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scheme]
        action: replace
        target_label: __scheme__
        regex: (https?)
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
        target_label: __address__
      - action: labelmap
        regex: __meta_kubernetes_pod_label_(.+)
      - source_labels: [__meta_kubernetes_namespace]
        action: replace
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        action: replace
        target_label: pod
      - source_labels: [__meta_kubernetes_pod_label_app]
        action: replace
        target_label: app
      - source_labels: [__meta_kubernetes_pod_label_version]
        action: replace
        target_label: version

  # External services monitoring
  - job_name: 'external-services'
    static_configs:
      - targets: ['api.external-service.com:443']
        labels:
          service: 'external-api'
          environment: 'production'
          tier: 'external'
    metrics_path: '/metrics'
    scheme: https
    scrape_interval: 30s
    scrape_timeout: 10s

  # Database exporters
  - job_name: 'postgres-exporter'
    static_configs:
      - targets: ['postgres-exporter:9187']
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
      - target_label: job
        replacement: postgres

  # Redis monitoring
  - job_name: 'redis-exporter'
    static_configs:
      - targets: ['redis-exporter:9121']
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
      - target_label: job
        replacement: redis

  # Message queue monitoring
  - job_name: 'rabbitmq-exporter'
    static_configs:
      - targets: ['rabbitmq-exporter:9419']
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
      - target_label: job
        replacement: rabbitmq

# Alertmanager configuration
alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - alertmanager:9093
      path_prefix: /
      scheme: http
      timeout: 10s
      api_version: v2

# Remote write configuration for long-term storage
remote_write:
  - url: "https://prometheus-remote-write.monitoring.svc.cluster.local/api/v1/write"
    remote_timeout: 30s
    write_relabel_configs:
      - source_labels: [__name__]
        regex: '(up|scrape_duration_seconds|scrape_samples_scraped|scrape_samples_post_metric_relabeling|scrape_series_added)'
        action: drop
    queue_config:
      capacity: 2500
      max_shards: 200
      min_shards: 1
      max_samples_per_send: 500
      batch_send_deadline: 5s
      min_backoff: 30ms
      max_backoff: 100ms

# Remote read configuration
remote_read:
  - url: "https://prometheus-remote-read.monitoring.svc.cluster.local/api/v1/read"
    remote_timeout: 1m
    read_recent: true

# Storage configuration
storage:
  tsdb:
    retention.time: 15d
    retention.size: 50GB
    wal-compression: true
---
# Advanced alerting rules
groups:
  - name: enterprise.slo.rules
    interval: 30s
    rules:
      # HTTP availability SLI
      - record: http_availability:sli
        expr: |
          (
            sum(rate(http_requests_total{status_code!~"5.."}[5m])) by (service)
            /
            sum(rate(http_requests_total[5m])) by (service)
          )

      # HTTP latency SLI (95th percentile)
      - record: http_latency:sli
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (service, le)
          )

      # Error budget calculation
      - record: http_availability:error_budget
        expr: |
          (
            1 - bool(http_availability:sli < 0.999)
          ) * 100

      # Burn rate calculation
      - record: http_availability:burn_rate
        expr: |
          (
            1 - http_availability:sli
          ) / (1 - 0.999)

  - name: enterprise.alerts
    rules:
      # High error rate alert
      - alert: HighErrorRate
        expr: |
          (
            sum(rate(http_requests_total{status_code=~"5.."}[5m])) by (service)
            /
            sum(rate(http_requests_total[5m])) by (service)
          ) > 0.01
        for: 2m
        labels:
          severity: warning
          slo_impact: availability
        annotations:
          summary: "High error rate detected for {{ $labels.service }}"
          description: "Service {{ $labels.service }} has error rate of {{ $value | humanizePercentage }} for more than 2 minutes"
          runbook_url: "https://runbooks.company.com/high-error-rate"
          dashboard_url: "https://grafana.company.com/d/service-overview"

      # Critical error rate alert
      - alert: CriticalErrorRate
        expr: |
          (
            sum(rate(http_requests_total{status_code=~"5.."}[5m])) by (service)
            /
            sum(rate(http_requests_total[5m])) by (service)
          ) > 0.05
        for: 1m
        labels:
          severity: critical
          slo_impact: availability
        annotations:
          summary: "Critical error rate detected for {{ $labels.service }}"
          description: "Service {{ $labels.service }} has critical error rate of {{ $value | humanizePercentage }}"
          runbook_url: "https://runbooks.company.com/critical-error-rate"

      # High latency alert
      - alert: HighLatency
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (service, le)
          ) > 1.0
        for: 5m
        labels:
          severity: warning
          slo_impact: latency
        annotations:
          summary: "High latency detected for {{ $labels.service }}"
          description: "Service {{ $labels.service }} 95th percentile latency is {{ $value }}s"

      # Database connection exhaustion
      - alert: DatabaseConnectionExhaustion
        expr: |
          database_connections_active / database_connections_max > 0.8
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Database connection pool near exhaustion"
          description: "Database {{ $labels.database }} connection usage is {{ $value | humanizePercentage }}"

      # Memory usage alert
      - alert: HighMemoryUsage
        expr: |
          (memory_usage_bytes{memory_type="used"} / memory_usage_bytes{memory_type="total"}) > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage detected"
          description: "Memory usage is {{ $value | humanizePercentage }} on {{ $labels.instance }}"

      # SLO burn rate alerts
      - alert: SLOBurnRateHigh
        expr: |
          http_availability:burn_rate > 10
        for: 2m
        labels:
          severity: critical
          slo_impact: availability
        annotations:
          summary: "SLO burn rate is critically high"
          description: "Service {{ $labels.service }} is burning error budget at {{ $value }}x normal rate"

      - alert: SLOBurnRateModerate
        expr: |
          http_availability:burn_rate > 2
        for: 15m
        labels:
          severity: warning
          slo_impact: availability
        annotations:
          summary: "SLO burn rate is elevated"
          description: "Service {{ $labels.service }} is burning error budget at {{ $value }}x normal rate"
```

This comprehensive guide covers enterprise cloud monitoring and observability with advanced Prometheus configurations, distributed tracing, SLO tracking, and sophisticated alerting strategies. Would you like me to continue with the remaining sections covering Grafana dashboards, log aggregation, and incident response frameworks?