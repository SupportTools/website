---
title: "Kubernetes Prometheus Pushgateway: Ephemeral Job Metrics, TTL Cleanup, Label Hygiene, and Anti-Patterns"
date: 2032-01-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Pushgateway", "Monitoring", "Observability", "Metrics"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Prometheus Pushgateway covering ephemeral job metric collection, TTL-based cleanup strategies, label hygiene practices, grouping key design, and a frank assessment of when Pushgateway is and is not the right tool for the job."
more_link: "yes"
url: "/kubernetes-prometheus-pushgateway-ephemeral-jobs-ttl-label-hygiene/"
---

The Prometheus Pushgateway exists to bridge a specific gap: short-lived jobs that complete before Prometheus can scrape them. In Kubernetes environments, this means batch jobs, CronJobs, database migrations, data import scripts, and CI/CD pipeline stages. Used correctly, Pushgateway provides valuable operational metrics for workloads that the standard pull model cannot serve. Used incorrectly, it becomes a source of stale metrics, false alerts, and operational toil.

<!--more-->

# Prometheus Pushgateway: Production Guide

## Section 1: Architecture and Use Cases

Pushgateway acts as an intermediary metric store. Jobs push metrics to Pushgateway using HTTP, and Prometheus scrapes Pushgateway at regular intervals like any other target.

```
┌──────────────────────┐          ┌───────────────┐         ┌────────────────┐
│  CronJob / BatchJob  │ ──push──► │  Pushgateway  │ ◄─scrape─ │   Prometheus   │
│  (lives < 60 seconds)│          │               │          │                │
└──────────────────────┘          └───────────────┘          └────────────────┘
```

### Legitimate Use Cases

1. **Kubernetes CronJobs with short execution windows** - Jobs that run and complete in under 60 seconds cannot be scraped by Prometheus
2. **Database migration scripts** - One-time operations that need to report success/failure and duration
3. **Batch data processing** - ETL jobs that process files and need to report record counts, error rates, processing time
4. **CI/CD pipeline metrics** - Build times, test pass rates, deployment success metrics
5. **Service-level batch operations** - Daily report generation, scheduled cleanups

### When NOT to Use Pushgateway

The Pushgateway documentation is explicit: it is NOT a general-purpose metrics aggregation tool. The following are anti-patterns:

- **Long-running services** - Use the standard pull model; services can expose `/metrics` endpoints
- **Multiple instances of the same job** - Pushgateway uses per-group last-write-wins; concurrent jobs overwrite each other
- **Health checks** - Use blackbox exporter
- **High-cardinality metrics** - Pushgateway holds all pushed metrics in memory indefinitely by default

## Section 2: Deploying Pushgateway on Kubernetes

### Helm Installation

```bash
# Add prometheus-community helm repo
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Install with production-ready values
helm install pushgateway prometheus-community/prometheus-pushgateway \
  -n monitoring \
  -f pushgateway-values.yaml \
  --version 2.14.0
```

```yaml
# pushgateway-values.yaml
replicaCount: 1   # Pushgateway is stateful; HA requires external state store

image:
  tag: v1.8.0

resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 256Mi

# Persistent storage for metric state across restarts
persistentVolume:
  enabled: true
  storageClass: standard-rwo
  size: 2Gi
  accessModes:
    - ReadWriteOnce

# Enable --persistence.file for state persistence
extraArgs:
  - --persistence.file=/data/pushgateway.db
  - --persistence.interval=5m
  - --web.enable-admin-api        # allows DELETE via API

containerPort: 9091

serviceMonitor:
  enabled: true
  namespace: monitoring
  labels:
    release: prometheus

serviceAccount:
  create: true

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "9091"
```

### Manual Deployment for Air-Gapped Environments

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pushgateway
  namespace: monitoring
  labels:
    app: pushgateway
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pushgateway
  template:
    metadata:
      labels:
        app: pushgateway
    spec:
      serviceAccountName: pushgateway
      securityContext:
        fsGroup: 65534
        runAsUser: 65534
        runAsNonRoot: true
      containers:
        - name: pushgateway
          image: prom/pushgateway:v1.8.0
          args:
            - --persistence.file=/data/metrics.db
            - --persistence.interval=5m
            - --web.enable-admin-api
            - --web.listen-address=:9091
          ports:
            - containerPort: 9091
              name: metrics
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
          volumeMounts:
            - name: data
              mountPath: /data
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 9091
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 9091
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: pushgateway-data
---
apiVersion: v1
kind: Service
metadata:
  name: pushgateway
  namespace: monitoring
  labels:
    app: pushgateway
spec:
  selector:
    app: pushgateway
  ports:
    - name: metrics
      port: 9091
      targetPort: 9091
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pushgateway-data
  namespace: monitoring
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: standard-rwo
  resources:
    requests:
      storage: 2Gi
```

## Section 3: Grouping Keys and Label Hygiene

### Understanding Grouping Keys

The grouping key is the cornerstone of Pushgateway's data model. Each unique grouping key maps to an independent metric group. When you push metrics with a given grouping key, they replace all previous metrics under that key.

The URL structure encodes the grouping key:

```
POST /metrics/job/<job_label>/instance/<instance_label>/...
```

```bash
# Push with job label only (simplest form)
curl -X POST http://pushgateway.monitoring.svc.cluster.local:9091/metrics/job/daily_backup \
  --data-binary '
# HELP job_duration_seconds Duration of the backup job
# TYPE job_duration_seconds gauge
job_duration_seconds 42.3

# HELP job_success Whether the job succeeded (1=success, 0=failure)
# TYPE job_success gauge
job_success 1
'

# Push with job + additional dimensions
curl -X POST \
  "http://pushgateway.monitoring.svc.cluster.local:9091/metrics/job/etl_pipeline/environment/production/dataset/customers" \
  --data-binary '
# HELP etl_records_processed Total records processed
# TYPE etl_records_processed gauge
etl_records_processed 150000

# HELP etl_errors_total Total errors encountered
# TYPE etl_errors_total gauge
etl_errors_total 23
'
```

### Grouping Key Design Principles

**Rule 1: Grouping key must be unique per concurrent job instance**

If two instances of the same CronJob can run simultaneously (which Kubernetes allows), they must use different grouping keys or they will overwrite each other's metrics.

```bash
# BAD: concurrent executions overwrite each other
JOB_LABEL="hourly_report"

# GOOD: unique per execution
JOB_LABEL="hourly_report"
INSTANCE="${JOB_NAME:-hourly-report}-${POD_NAME:-$(hostname)}"
```

**Rule 2: Grouping key cardinality must be bounded**

A new grouping key creates a new permanent metric group. If your job pushes with the current timestamp as part of the key, you will create thousands of orphaned metric groups.

```bash
# BAD: unbounded cardinality
PUSH_URL="http://pushgateway:9091/metrics/job/report/run_time/$(date +%s)"

# GOOD: bounded by job identity
PUSH_URL="http://pushgateway:9091/metrics/job/report/environment/production"
```

**Rule 3: Labels on the grouping key become labels on all metrics**

```bash
# All metrics pushed under this URL will have:
# job="batch_processor", environment="production", pipeline="transactions"
PUSH_URL="http://pushgateway:9091/metrics/job/batch_processor/environment/production/pipeline/transactions"
```

### Label Hygiene Checklist

```bash
# Avoid these label patterns:

# 1. Timestamps in labels (unbounded cardinality)
# BAD:
curl ".../metrics/job/etl/run_date/$(date +%Y-%m-%d)"
# GOOD: Use a metric instead
echo "job_last_run_timestamp $(date +%s)" | curl ... --data-binary @-

# 2. Random UUIDs in labels (unbounded)
# BAD:
curl ".../metrics/job/etl/run_id/$(uuidgen)"

# 3. User-provided values without validation
# BAD: ${INPUT_FILE} could be anything
curl ".../metrics/job/etl/file/${INPUT_FILE}"

# 4. Too many label dimensions (prefer fixed set)
# BAD: many varying dimensions create explosion of groups
curl ".../metrics/job/etl/host/${HOSTNAME}/pod/${POD_NAME}/node/${NODE_NAME}/az/${AZ}/region/${REGION}"

# GOOD: use consistent, bounded labels
# job + environment + pipeline covers 99% of cases
```

## Section 4: Pushing Metrics from Kubernetes Jobs

### Bash Push Script

```bash
#!/usr/bin/env bash
# push_metrics.sh - Production-ready Prometheus metric push

set -euo pipefail

PUSHGATEWAY_URL="${PUSHGATEWAY_URL:-http://pushgateway.monitoring.svc.cluster.local:9091}"
JOB_NAME="${JOB_NAME:-$(basename "$0" .sh)}"
ENVIRONMENT="${ENVIRONMENT:-production}"
PUSH_URL="${PUSHGATEWAY_URL}/metrics/job/${JOB_NAME}/environment/${ENVIRONMENT}"

START_TIME=$(date +%s%3N)  # milliseconds

# Initialize metrics
RECORDS_PROCESSED=0
RECORDS_FAILED=0
JOB_SUCCESS=0

cleanup() {
    local exit_code=$?
    local end_time
    end_time=$(date +%s%3N)
    local duration_ms=$((end_time - START_TIME))
    local duration_s
    duration_s=$(echo "scale=3; $duration_ms / 1000" | bc)

    if [ $exit_code -eq 0 ]; then
        JOB_SUCCESS=1
    fi

    # Push final metrics
    cat << EOF | curl -s -o /dev/null -w "%{http_code}" \
        --data-binary @- \
        "${PUSH_URL}"
# HELP job_duration_seconds Time taken to complete the job
# TYPE job_duration_seconds gauge
job_duration_seconds ${duration_s}
# HELP job_success Whether the job completed successfully
# TYPE job_success gauge
job_success ${JOB_SUCCESS}
# HELP job_records_processed Total records processed
# TYPE job_records_processed gauge
job_records_processed ${RECORDS_PROCESSED}
# HELP job_records_failed Records that failed processing
# TYPE job_records_failed gauge
job_records_failed ${RECORDS_FAILED}
# HELP job_last_run_timestamp Unix timestamp of last run
# TYPE job_last_run_timestamp gauge
job_last_run_timestamp $(date +%s)
EOF
    echo "Metrics pushed to Pushgateway (exit_code=${exit_code}, duration=${duration_s}s)"
}

trap cleanup EXIT

# Actual job work here
main() {
    echo "Starting job: ${JOB_NAME}"

    # Simulate work
    for i in $(seq 1 100); do
        if ((RANDOM % 10 == 0)); then
            RECORDS_FAILED=$((RECORDS_FAILED + 1))
        else
            RECORDS_PROCESSED=$((RECORDS_PROCESSED + 1))
        fi
    done

    echo "Processed ${RECORDS_PROCESSED} records, ${RECORDS_FAILED} failures"
}

main "$@"
```

### Go Client Library Push

```go
package main

import (
    "context"
    "fmt"
    "os"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/push"
)

type JobMetrics struct {
    registry         *prometheus.Registry
    jobDuration      prometheus.Gauge
    jobSuccess       prometheus.Gauge
    recordsProcessed prometheus.Gauge
    recordsFailed    prometheus.Gauge
    lastRunTimestamp prometheus.Gauge
}

func NewJobMetrics(jobName, environment string) *JobMetrics {
    reg := prometheus.NewRegistry()

    constLabels := prometheus.Labels{
        "job_name":    jobName,
        "environment": environment,
    }

    m := &JobMetrics{
        registry: reg,
        jobDuration: prometheus.NewGauge(prometheus.GaugeOpts{
            Name:        "job_duration_seconds",
            Help:        "Duration of the job in seconds",
            ConstLabels: constLabels,
        }),
        jobSuccess: prometheus.NewGauge(prometheus.GaugeOpts{
            Name:        "job_success",
            Help:        "Whether the job succeeded (1=success, 0=failure)",
            ConstLabels: constLabels,
        }),
        recordsProcessed: prometheus.NewGauge(prometheus.GaugeOpts{
            Name:        "job_records_processed_total",
            Help:        "Total records successfully processed",
            ConstLabels: constLabels,
        }),
        recordsFailed: prometheus.NewGauge(prometheus.GaugeOpts{
            Name:        "job_records_failed_total",
            Help:        "Total records that failed processing",
            ConstLabels: constLabels,
        }),
        lastRunTimestamp: prometheus.NewGauge(prometheus.GaugeOpts{
            Name:        "job_last_run_timestamp",
            Help:        "Unix timestamp of the last run",
            ConstLabels: constLabels,
        }),
    }

    reg.MustRegister(
        m.jobDuration,
        m.jobSuccess,
        m.recordsProcessed,
        m.recordsFailed,
        m.lastRunTimestamp,
    )

    return m
}

func (m *JobMetrics) Push(ctx context.Context, pushgatewayURL, jobName string) error {
    pusher := push.New(pushgatewayURL, jobName).
        Gatherer(m.registry).
        Grouping("environment", os.Getenv("ENVIRONMENT")).
        Client(&http.Client{Timeout: 10 * time.Second})

    return pusher.PushContext(ctx)
}

type JobRunner struct {
    metrics *JobMetrics
    name    string
    start   time.Time
}

func NewJobRunner(name, environment string) *JobRunner {
    return &JobRunner{
        metrics: NewJobMetrics(name, environment),
        name:    name,
        start:   time.Now(),
    }
}

func (r *JobRunner) Finish(err error) {
    duration := time.Since(r.start).Seconds()
    r.metrics.jobDuration.Set(duration)
    r.metrics.lastRunTimestamp.Set(float64(time.Now().Unix()))

    if err != nil {
        r.metrics.jobSuccess.Set(0)
    } else {
        r.metrics.jobSuccess.Set(1)
    }
}

func (r *JobRunner) IncrProcessed(n float64) { r.metrics.recordsProcessed.Add(n) }
func (r *JobRunner) IncrFailed(n float64)    { r.metrics.recordsFailed.Add(n) }

func main() {
    pushgatewayURL := os.Getenv("PUSHGATEWAY_URL")
    if pushgatewayURL == "" {
        pushgatewayURL = "http://pushgateway.monitoring.svc.cluster.local:9091"
    }

    environment := os.Getenv("ENVIRONMENT")
    if environment == "" {
        environment = "production"
    }

    runner := NewJobRunner("data-pipeline", environment)

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
    defer cancel()

    var runErr error
    func() {
        defer func() {
            if r := recover(); r != nil {
                runErr = fmt.Errorf("panic: %v", r)
            }
        }()
        runErr = runJob(ctx, runner)
    }()

    runner.Finish(runErr)

    pushCtx, pushCancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer pushCancel()

    if err := runner.metrics.Push(pushCtx, pushgatewayURL, "data-pipeline"); err != nil {
        fmt.Fprintf(os.Stderr, "Failed to push metrics: %v\n", err)
        // Don't exit with error just for metrics push failure
    }

    if runErr != nil {
        fmt.Fprintf(os.Stderr, "Job failed: %v\n", runErr)
        os.Exit(1)
    }
}

func runJob(ctx context.Context, runner *JobRunner) error {
    // Simulate data processing
    for i := 0; i < 10000; i++ {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }
        if i%100 == 0 {
            runner.IncrProcessed(99)
            runner.IncrFailed(1)
        }
    }
    return nil
}
```

### Kubernetes CronJob with Metric Push

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-data-sync
  namespace: data-team
spec:
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 2
      activeDeadlineSeconds: 3600
      template:
        spec:
          restartPolicy: Never
          serviceAccountName: data-sync
          containers:
            - name: data-sync
              image: data-sync-job:v2.3.1
              env:
                - name: PUSHGATEWAY_URL
                  value: "http://pushgateway.monitoring.svc.cluster.local:9091"
                - name: ENVIRONMENT
                  value: "production"
                - name: JOB_NAME
                  value: "nightly-data-sync"
                - name: POD_NAME
                  valueFrom:
                    fieldRef:
                      fieldPath: metadata.name
              resources:
                requests:
                  cpu: 500m
                  memory: 512Mi
                limits:
                  cpu: 2000m
                  memory: 2Gi
```

## Section 5: TTL Cleanup and Stale Metric Management

Stale metrics are the biggest operational problem with Pushgateway. When a job stops running (cron disabled, deprecated pipeline), its last-pushed metrics remain in Pushgateway forever unless explicitly deleted.

### Automatic Cleanup via Admin API

```bash
# Delete all metrics for a specific job group
curl -X DELETE \
  "http://pushgateway.monitoring.svc.cluster.local:9091/metrics/job/old_pipeline"

# Delete with additional grouping labels
curl -X DELETE \
  "http://pushgateway.monitoring.svc.cluster.local:9091/metrics/job/etl/environment/staging"

# Delete ALL metrics (nuclear option - use with care)
curl -X PUT "http://pushgateway.monitoring.svc.cluster.local:9091/api/v1/admin/wipe"
```

### TTL-Based Cleanup Controller

Implement a sidecar or CronJob that deletes metric groups older than a TTL:

```go
package main

import (
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "os"
    "time"
)

type MetricGroup struct {
    Labels       map[string]string `json:"labels"`
    PushTimestamp float64          `json:"push_time_seconds"`
}

type PushgatewayMetrics struct {
    Status string        `json:"status"`
    Data   []MetricGroup `json:"data"`
}

type TTLCleaner struct {
    baseURL string
    ttl     time.Duration
    client  *http.Client
}

func NewTTLCleaner(baseURL string, ttl time.Duration) *TTLCleaner {
    return &TTLCleaner{
        baseURL: baseURL,
        ttl:     ttl,
        client:  &http.Client{Timeout: 30 * time.Second},
    }
}

func (c *TTLCleaner) ListGroups() ([]MetricGroup, error) {
    resp, err := c.client.Get(c.baseURL + "/api/v1/metrics")
    if err != nil {
        return nil, fmt.Errorf("listing groups: %w", err)
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return nil, err
    }

    var result PushgatewayMetrics
    if err := json.Unmarshal(body, &result); err != nil {
        return nil, fmt.Errorf("parsing response: %w", err)
    }

    return result.Data, nil
}

func (c *TTLCleaner) DeleteGroup(labels map[string]string) error {
    job, ok := labels["job"]
    if !ok {
        return fmt.Errorf("group has no job label")
    }

    url := c.baseURL + "/metrics/job/" + job
    for k, v := range labels {
        if k == "job" {
            continue
        }
        url += "/" + k + "/" + v
    }

    req, err := http.NewRequest(http.MethodDelete, url, nil)
    if err != nil {
        return err
    }

    resp, err := c.client.Do(req)
    if err != nil {
        return fmt.Errorf("deleting group: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("delete returned %d: %s", resp.StatusCode, body)
    }
    return nil
}

func (c *TTLCleaner) CleanStale() (int, error) {
    groups, err := c.ListGroups()
    if err != nil {
        return 0, err
    }

    cutoff := time.Now().Add(-c.ttl)
    deleted := 0

    for _, group := range groups {
        pushTime := time.Unix(int64(group.PushTimestamp), 0)
        if pushTime.Before(cutoff) {
            job := group.Labels["job"]
            fmt.Printf("Deleting stale group job=%s pushed=%s ago\n",
                job, time.Since(pushTime).Round(time.Minute))

            if err := c.DeleteGroup(group.Labels); err != nil {
                fmt.Fprintf(os.Stderr, "Failed to delete group %v: %v\n", group.Labels, err)
                continue
            }
            deleted++
        }
    }

    return deleted, nil
}

func main() {
    pushgatewayURL := os.Getenv("PUSHGATEWAY_URL")
    if pushgatewayURL == "" {
        pushgatewayURL = "http://pushgateway.monitoring.svc.cluster.local:9091"
    }

    ttl := 25 * time.Hour // clean metrics older than 25 hours

    cleaner := NewTTLCleaner(pushgatewayURL, ttl)

    ticker := time.NewTicker(1 * time.Hour)
    defer ticker.Stop()

    for {
        n, err := cleaner.CleanStale()
        if err != nil {
            fmt.Fprintf(os.Stderr, "Cleanup failed: %v\n", err)
        } else {
            fmt.Printf("Cleaned %d stale metric groups\n", n)
        }
        <-ticker.C
    }
}
```

Deploy the cleaner as a sidecar or separate Deployment:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pushgateway-ttl-cleaner
  namespace: monitoring
spec:
  schedule: "0 * * * *"   # run hourly
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: cleaner
              image: pushgateway-ttl-cleaner:v1.0.0
              env:
                - name: PUSHGATEWAY_URL
                  value: "http://pushgateway:9091"
                - name: TTL_HOURS
                  value: "25"
              resources:
                requests:
                  cpu: 10m
                  memory: 16Mi
                limits:
                  cpu: 100m
                  memory: 64Mi
```

## Section 6: Prometheus Configuration for Pushgateway

### Scrape Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: pushgateway
    honor_labels: true        # CRITICAL: preserve labels from pushed metrics
    scrape_interval: 60s
    scrape_timeout: 30s
    static_configs:
      - targets:
          - pushgateway.monitoring.svc.cluster.local:9091
    metric_relabel_configs:
      # Drop internal Pushgateway metrics from job metrics namespace
      - source_labels: [__name__]
        regex: "push_time_seconds|push_failure_time_seconds"
        action: drop
```

The `honor_labels: true` setting is essential. Without it, Prometheus overwrites the `job` label with the scrape job name (`pushgateway`), losing the original job identity.

### Alerting on Job Failures

```yaml
groups:
  - name: batch-jobs
    rules:
      # Alert when any job fails
      - alert: BatchJobFailed
        expr: |
          job_success == 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Batch job {{ $labels.job_name }} failed"
          description: "Job {{ $labels.job_name }} in {{ $labels.environment }} failed"

      # Alert when a job hasn't run in expected window
      - alert: BatchJobNotRunning
        expr: |
          time() - job_last_run_timestamp > 90000  # 25 hours
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Batch job {{ $labels.job_name }} not running"
          description: "Job {{ $labels.job_name }} last ran {{ $value | humanizeDuration }} ago"

      # Alert on high error rate
      - alert: BatchJobHighErrorRate
        expr: |
          (job_records_failed_total / (job_records_processed_total + job_records_failed_total)) > 0.05
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "High error rate in batch job {{ $labels.job_name }}"
          description: "Error rate is {{ $value | humanizePercentage }}"

      # Alert on unusually long duration
      - alert: BatchJobSlow
        expr: |
          job_duration_seconds > 3600
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Batch job {{ $labels.job_name }} taking too long"
          description: "Job duration is {{ $value | humanizeDuration }}"
```

## Section 7: Pushgateway Anti-Patterns and Alternatives

### Anti-Pattern 1: Using Counters Instead of Gauges

Pushgateway does not aggregate. If you push a counter with value 5 and then push with value 3, Prometheus sees a metric that went from 5 to 3 - this looks like a counter reset and confuses rate() calculations.

```
# WRONG: using counter type in Pushgateway
# TYPE records_processed counter
records_processed 5000

# RIGHT: use gauge for job metrics in Pushgateway
# TYPE records_processed gauge
records_processed 5000
```

### Anti-Pattern 2: Storing Metrics During Job Execution

Pushing metrics only at job completion is correct. Pushing during execution creates race conditions and partial metric states.

```bash
# WRONG: push during execution
for batch in $(get_batches); do
    process "$batch"
    push_count_metrics  # partial data during execution
done

# RIGHT: accumulate, then push once at the end
process_all_batches
push_final_metrics     # complete, consistent snapshot
```

### Anti-Pattern 3: Using Pushgateway for Service Metrics

```yaml
# WRONG: A long-running service using Pushgateway
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  template:
    spec:
      containers:
        - name: api
          # This service should expose /metrics directly
          # NOT push to Pushgateway periodically
```

### When to Choose Alternatives

| Scenario | Better Alternative |
|----------|-------------------|
| Long-running services | Built-in `/metrics` endpoint |
| Blackbox monitoring | Blackbox Exporter |
| Log-based metrics | Promtail + Loki + recording rules |
| Distributed counters | StatsD + StatsD Exporter |
| External services | Custom Exporter |

### Pushgateway in High-Availability Setups

Pushgateway is deliberately not clustered - there is no built-in replication. The official guidance is to run a single instance with persistent storage. If you need HA, the recommended approach is:

1. Run two independent Pushgateway instances
2. Push to both from each job
3. Configure Prometheus to scrape both
4. Use `honor_labels: true` and deduplication recording rules

```yaml
# prometheus.yml - scrape both instances
scrape_configs:
  - job_name: pushgateway
    honor_labels: true
    static_configs:
      - targets:
          - pushgateway-0.monitoring.svc.cluster.local:9091
          - pushgateway-1.monitoring.svc.cluster.local:9091
    metric_relabel_configs:
      # Deduplicate by dropping instance label
      - source_labels: [instance]
        action: labeldrop
        regex: pushgateway-.*
```

Pushgateway fills a real gap in the Prometheus ecosystem, but its operational surface area is significant. Disciplined grouping key design, automatic TTL cleanup, and clear team guidelines on when to use it versus alternatives will keep it a useful tool rather than a source of monitoring toil.
