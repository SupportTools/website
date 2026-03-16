---
title: "Prometheus Pushgateway: Monitoring Batch Jobs and Short-Lived Workloads"
date: 2027-03-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "Pushgateway", "Batch Jobs", "Monitoring"]
categories: ["Kubernetes", "Observability", "Prometheus"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Prometheus Pushgateway for Kubernetes batch job monitoring, covering metric push patterns in Go/Python/bash, job grouping keys, staleness handling, Pushgateway HA with sticky sessions, alternative approaches with Prometheus remote write, and anti-patterns to avoid."
more_link: "yes"
url: "/prometheus-pushgateway-batch-job-monitoring-guide/"
---

Kubernetes Jobs and CronJobs complete and disappear before Prometheus has a chance to scrape them. The Prometheus pull model, which works perfectly for long-running services, fails entirely for workloads measured in seconds or minutes. Pushgateway solves this problem by acting as an intermediary metrics store: batch jobs push their final metrics to Pushgateway on completion, and Prometheus scrapes Pushgateway on its regular interval, collecting the metrics long after the job pod has terminated. This guide covers the complete production deployment of Pushgateway, metric push patterns across multiple language clients, staleness management, high-availability configuration, and the critical anti-patterns that turn Pushgateway from a useful tool into a cardinality nightmare.

<!--more-->

## Pushgateway Architecture and Use Cases

### How Pushgateway Fits the Pull Model

```
┌────────────────────┐     push metrics     ┌─────────────────────┐
│  Kubernetes Job    │ ───────────────────► │  Pushgateway        │
│  (short-lived pod) │  HTTP PUT/POST        │  in-memory store    │
└────────────────────┘                       │  persists after pod │
                                             │  terminates         │
                                             └──────────┬──────────┘
                                                        │ scrape
                                                        ▼
                                             ┌─────────────────────┐
                                             │  Prometheus          │
                                             │  (on 15s interval)  │
                                             └─────────────────────┘
```

### Appropriate Use Cases

Pushgateway is the correct solution for these scenarios:

- **Kubernetes Jobs**: database migration jobs, report generation, data export pipelines
- **CronJobs**: nightly batch processing, scheduled backups, cache warm-up jobs
- **CI/CD pipeline metrics**: build duration, test pass rate, artifact size pushed from ephemeral CI runners
- **One-shot scripts**: infrastructure bootstrapping scripts, maintenance tasks that run once and report results

### Inappropriate Use Cases (Anti-Patterns)

Pushgateway is the wrong tool for:

- **Long-running services**: services that run for hours should be scraped directly; Pushgateway cannot provide the per-second granularity Prometheus excels at
- **Multiple instances of the same service**: Pushgateway stores one metric set per grouping key; pushing from multiple instances of the same service without unique keys causes last-write-wins clobbering
- **High-cardinality streaming metrics**: Pushgateway holds all pushed metrics in memory; pushing thousands of unique label combinations from streaming jobs exhausts memory

## Installing Pushgateway on Kubernetes

```bash
# Add Prometheus community Helm repository
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Install Pushgateway
helm upgrade --install pushgateway prometheus-community/prometheus-pushgateway \
  --namespace monitoring \
  --version 2.14.0 \
  --set "replicaCount=2" \
  --set "serviceAccount.create=true" \
  --set "resources.requests.cpu=100m" \
  --set "resources.requests.memory=128Mi" \
  --set "resources.limits.cpu=500m" \
  --set "resources.limits.memory=512Mi" \
  --set "persistentVolume.enabled=true" \
  --set "persistentVolume.size=1Gi" \
  --wait
```

### Pushgateway Service and ServiceMonitor

```yaml
# pushgateway-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: pushgateway
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: prometheus-pushgateway
  endpoints:
    - port: http
      interval: 15s
      honorLabels: true              # use job/instance labels from pushed metrics
      metricRelabelings:
        # Preserve the pushed_at timestamp for staleness detection
        - sourceLabels: [__name__]
          regex: push_time_seconds
          action: keep
        - sourceLabels: [__name__]
          regex: push_failure_time_seconds
          action: keep
        - sourceLabels: [__name__]
          targetLabel: __name__
          action: labelmap
          regex: (.+)
```

## Metric Text Format and Grouping Keys

### Prometheus Text Exposition Format

Pushgateway accepts the standard Prometheus text exposition format:

```
# HELP batch_job_duration_seconds Total duration of the batch job in seconds
# TYPE batch_job_duration_seconds gauge
batch_job_duration_seconds{environment="production"} 45.7

# HELP batch_job_records_processed_total Total number of records processed
# TYPE batch_job_records_processed_total counter
batch_job_records_processed_total{environment="production",status="success"} 98234
batch_job_records_processed_total{environment="production",status="error"} 17

# HELP batch_job_exit_code Job exit code (0=success, non-zero=failure)
# TYPE batch_job_exit_code gauge
batch_job_exit_code{environment="production"} 0

# HELP batch_job_last_success_time Unix timestamp of last successful completion
# TYPE batch_job_last_success_time gauge
batch_job_last_success_time{environment="production"} 1.7109612e+09
```

### Grouping Key Design

Every push to Pushgateway includes a grouping key, which uniquely identifies the metric set. Pushgateway stores one metric set per grouping key and replaces the entire set on each push.

```
PUT /metrics/job/<job>/[<label>/<value>]...
```

**Good grouping key examples:**

```
# CronJob: one grouping per job name (replaces metrics on each run)
/metrics/job/nightly-report

# CronJob with environment: prevents dev/prod clobbering
/metrics/job/nightly-report/environment/production

# Job with run ID: preserves history of individual runs
/metrics/job/database-migration/run_id/20260315-143022

# CI pipeline: unique per pipeline run
/metrics/job/ci-build/pipeline/deploy-api/run/5291
```

**Bad grouping key examples:**

```
# Missing environment: dev and prod overwrite each other
/metrics/job/backup

# Using pod name: creates unbounded cardinality as pods come and go
/metrics/job/backup/pod/backup-job-xk9f2
```

## HTTP API: PUT vs POST vs DELETE

### PUT (Replace): Full Replacement Push

`PUT` replaces the entire metric set for the grouping key. This is the correct method for jobs that push once at completion.

```bash
# Replace all metrics for job=nightly-report
cat <<'EOF' | curl -s --data-binary @- \
  http://pushgateway.monitoring.svc.cluster.local:9091/metrics/job/nightly-report/environment/production
# HELP batch_records_processed Total records processed
# TYPE batch_records_processed gauge
batch_records_processed{status="success"} 102840
batch_records_processed{status="error"} 3
# HELP batch_duration_seconds Job duration in seconds
# TYPE batch_duration_seconds gauge
batch_duration_seconds 127.4
# HELP batch_last_success_time Unix timestamp of last successful run
# TYPE batch_last_success_time gauge
batch_last_success_time 1709881200
EOF
```

### POST (Update): Append or Update Individual Metrics

`POST` updates individual metrics within the grouping key without replacing the entire set. Counters are accumulated (not reset).

```bash
# Append additional metrics to an existing group
cat <<'EOF' | curl -s --data-binary @- \
  -X POST \
  http://pushgateway.monitoring.svc.cluster.local:9091/metrics/job/nightly-report/environment/production
# HELP batch_pages_processed Pages processed in second phase
# TYPE batch_pages_processed gauge
batch_pages_processed 4821
EOF
```

### DELETE: Remove a Grouping Key

`DELETE` removes all metrics for a grouping key. Use this in cleanup scripts after alerting rules have fired.

```bash
# Delete stale metrics after manual intervention
curl -s -X DELETE \
  http://pushgateway.monitoring.svc.cluster.local:9091/metrics/job/nightly-report/environment/production
```

## Pushing Metrics from Go

```go
// pkg/metrics/push.go
package metrics

import (
	"fmt"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/push"
)

// BatchJobMetrics holds all metrics for a batch job run.
type BatchJobMetrics struct {
	registry         *prometheus.Registry
	recordsProcessed *prometheus.CounterVec
	errorCount       *prometheus.CounterVec
	duration         prometheus.Gauge
	exitCode         prometheus.Gauge
	lastSuccess      prometheus.Gauge
}

// NewBatchJobMetrics initializes a fresh Prometheus registry and registers job metrics.
func NewBatchJobMetrics() *BatchJobMetrics {
	reg := prometheus.NewRegistry()

	m := &BatchJobMetrics{
		registry: reg,

		recordsProcessed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "batch_job_records_processed_total",
			Help: "Total number of records processed by the batch job",
		}, []string{"status", "table"}),

		errorCount: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "batch_job_errors_total",
			Help: "Total number of errors encountered during processing",
		}, []string{"error_type"}),

		duration: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "batch_job_duration_seconds",
			Help: "Total wall-clock duration of the batch job in seconds",
		}),

		exitCode: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "batch_job_exit_code",
			Help: "Exit code of the batch job (0 = success)",
		}),

		lastSuccess: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "batch_job_last_success_time",
			Help: "Unix timestamp of the last successful job completion",
		}),
	}

	// Register all metrics in the dedicated registry (not default)
	reg.MustRegister(
		m.recordsProcessed,
		m.errorCount,
		m.duration,
		m.exitCode,
		m.lastSuccess,
	)

	return m
}

// PushResult pushes final metrics to Pushgateway.
// jobName identifies the job type; runEnv distinguishes environments.
func (m *BatchJobMetrics) PushResult(
	pushgatewayURL string,
	jobName string,
	runEnv string,
	startTime time.Time,
	exitCode int,
) error {
	elapsed := time.Since(startTime).Seconds()
	m.duration.Set(elapsed)
	m.exitCode.Set(float64(exitCode))

	if exitCode == 0 {
		m.lastSuccess.Set(float64(time.Now().Unix()))
	}

	pusher := push.New(pushgatewayURL, jobName).
		Grouping("environment", runEnv).
		Gatherer(m.registry)

	if err := pusher.Push(); err != nil {
		return fmt.Errorf("pushing metrics to Pushgateway %s: %w", pushgatewayURL, err)
	}

	return nil
}

// Example usage in a batch job main function:
//
// func main() {
//     startTime := time.Now()
//     m := metrics.NewBatchJobMetrics()
//
//     // ... process records ...
//     m.recordsProcessed.WithLabelValues("success", "orders").Add(float64(successCount))
//     m.recordsProcessed.WithLabelValues("error", "orders").Add(float64(errorCount))
//
//     exitCode := 0
//     if processingErr != nil {
//         m.errorCount.WithLabelValues("processing").Inc()
//         exitCode = 1
//     }
//
//     if pushErr := m.PushResult(
//         "http://pushgateway.monitoring.svc.cluster.local:9091",
//         "order-processing-job",
//         "production",
//         startTime,
//         exitCode,
//     ); pushErr != nil {
//         log.Printf("WARNING: metric push failed: %v", pushErr)
//         // Do not exit with error code here; job outcome should not depend on metrics
//     }
//
//     os.Exit(exitCode)
// }
```

## Pushing Metrics from Python

```python
#!/usr/bin/env python3
# batch_job_metrics.py

import os
import time
import logging
from prometheus_client import (
    CollectorRegistry,
    Gauge,
    Counter,
    push_to_gateway,
)

logger = logging.getLogger(__name__)


class BatchJobMetrics:
    """Collects and pushes batch job metrics to Prometheus Pushgateway."""

    def __init__(self, job_name: str, environment: str):
        self.job_name = job_name
        self.environment = environment
        self.start_time = time.time()

        # Use a dedicated registry; never push to default registry
        self.registry = CollectorRegistry()

        self.records_processed = Counter(
            "batch_job_records_processed_total",
            "Total number of records processed",
            ["status", "source"],
            registry=self.registry,
        )

        self.duration_seconds = Gauge(
            "batch_job_duration_seconds",
            "Total duration of the batch job in seconds",
            registry=self.registry,
        )

        self.exit_code = Gauge(
            "batch_job_exit_code",
            "Exit code of the batch job (0=success)",
            registry=self.registry,
        )

        self.last_success_time = Gauge(
            "batch_job_last_success_time",
            "Unix timestamp of the last successful completion",
            registry=self.registry,
        )

        self.memory_usage_bytes = Gauge(
            "batch_job_peak_memory_bytes",
            "Peak RSS memory usage in bytes during the job",
            registry=self.registry,
        )

    def record_success(self, count: int, source: str = "default") -> None:
        """Increment the success record counter."""
        self.records_processed.labels(status="success", source=source).inc(count)

    def record_error(self, count: int, source: str = "default") -> None:
        """Increment the error record counter."""
        self.records_processed.labels(status="error", source=source).inc(count)

    def push(
        self,
        pushgateway_url: str,
        exit_code: int = 0,
    ) -> None:
        """Finalize and push all metrics to Pushgateway."""
        elapsed = time.time() - self.start_time
        self.duration_seconds.set(elapsed)
        self.exit_code.set(exit_code)

        if exit_code == 0:
            self.last_success_time.set(time.time())

        # Capture peak memory from /proc/self/status
        try:
            with open("/proc/self/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        kb = int(line.split()[1])
                        self.memory_usage_bytes.set(kb * 1024)
                        break
        except OSError:
            pass  # not on Linux; skip memory metric

        grouping_key = {"environment": self.environment}

        try:
            push_to_gateway(
                pushgateway_url,
                job=self.job_name,
                registry=self.registry,
                grouping_key=grouping_key,
            )
            logger.info(
                "Metrics pushed to Pushgateway: job=%s env=%s duration=%.2fs",
                self.job_name, self.environment, elapsed,
            )
        except Exception as exc:
            # Log but do not re-raise: job success should not depend on metric delivery
            logger.warning("Failed to push metrics to Pushgateway: %s", exc)


# Example usage:
#
# if __name__ == "__main__":
#     metrics = BatchJobMetrics("inventory-sync", "production")
#     exit_code = 0
#     try:
#         for record in fetch_records():
#             try:
#                 process_record(record)
#                 metrics.record_success(1, source="warehouse-api")
#             except ProcessingError as e:
#                 metrics.record_error(1, source="warehouse-api")
#                 logger.error("Record processing failed: %s", e)
#     except Exception as e:
#         logger.critical("Job failed: %s", e)
#         exit_code = 1
#     finally:
#         metrics.push(
#             pushgateway_url=os.environ.get(
#                 "PUSHGATEWAY_URL",
#                 "http://pushgateway.monitoring.svc.cluster.local:9091",
#             ),
#             exit_code=exit_code,
#         )
#     sys.exit(exit_code)
```

## Pushing Metrics from Bash

```bash
#!/usr/bin/env bash
# push_job_metrics.sh — push batch job completion metrics from a shell script

set -euo pipefail

PUSHGATEWAY_URL="${PUSHGATEWAY_URL:-http://pushgateway.monitoring.svc.cluster.local:9091}"
JOB_NAME="${JOB_NAME:-shell-batch-job}"
ENVIRONMENT="${ENVIRONMENT:-production}"

# Record start time
START_TIME=$(date +%s)

# Run the actual job and capture exit code
set +e
/usr/local/bin/run-batch-job \
  --config /etc/batch/config.yaml \
  --output /tmp/batch-output.json
JOB_EXIT_CODE=$?
set -e

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Parse output for record counts (job-specific parsing)
RECORDS_SUCCESS=0
RECORDS_ERROR=0
if [[ -f /tmp/batch-output.json ]]; then
  RECORDS_SUCCESS=$(python3 -c "import json,sys; d=json.load(open('/tmp/batch-output.json')); print(d.get('success_count',0))" 2>/dev/null || echo 0)
  RECORDS_ERROR=$(python3 -c "import json,sys; d=json.load(open('/tmp/batch-output.json')); print(d.get('error_count',0))" 2>/dev/null || echo 0)
fi

# Build the metric payload using heredoc
METRICS_PAYLOAD=$(cat <<METRICS
# HELP batch_job_duration_seconds Total duration of the batch job
# TYPE batch_job_duration_seconds gauge
batch_job_duration_seconds{environment="${ENVIRONMENT}"} ${DURATION}
# HELP batch_job_records_processed_total Records processed by status
# TYPE batch_job_records_processed_total gauge
batch_job_records_processed_total{environment="${ENVIRONMENT}",status="success"} ${RECORDS_SUCCESS}
batch_job_records_processed_total{environment="${ENVIRONMENT}",status="error"} ${RECORDS_ERROR}
# HELP batch_job_exit_code Exit code of the batch job
# TYPE batch_job_exit_code gauge
batch_job_exit_code{environment="${ENVIRONMENT}"} ${JOB_EXIT_CODE}
# HELP batch_job_last_run_time Unix timestamp of last run
# TYPE batch_job_last_run_time gauge
batch_job_last_run_time{environment="${ENVIRONMENT}"} ${END_TIME}
METRICS
)

# Conditionally set last success timestamp
if [[ ${JOB_EXIT_CODE} -eq 0 ]]; then
  METRICS_PAYLOAD="${METRICS_PAYLOAD}
# HELP batch_job_last_success_time Unix timestamp of last successful completion
# TYPE batch_job_last_success_time gauge
batch_job_last_success_time{environment=\"${ENVIRONMENT}\"} ${END_TIME}"
fi

# Push to Pushgateway (PUT replaces all metrics for this grouping key)
PUSH_RESPONSE=$(echo "${METRICS_PAYLOAD}" | curl -sf \
  --data-binary @- \
  --write-out "%{http_code}" \
  --output /dev/null \
  "${PUSHGATEWAY_URL}/metrics/job/${JOB_NAME}/environment/${ENVIRONMENT}" \
  2>&1) || true

if [[ "${PUSH_RESPONSE}" == "200" || "${PUSH_RESPONSE}" == "202" ]]; then
  echo "Metrics pushed successfully (HTTP ${PUSH_RESPONSE})"
else
  echo "WARNING: Metric push failed (HTTP ${PUSH_RESPONSE}); continuing" >&2
fi

exit ${JOB_EXIT_CODE}
```

## Kubernetes Job Pattern: Push on Completion

### CronJob with Sidecar Push Container

For complex jobs where the main application cannot be modified to push metrics, use a sidecar or adapter container in the pod.

```yaml
# batch-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
  namespace: production
spec:
  schedule: "0 2 * * *"           # 2:00 AM UTC daily
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 2
      activeDeadlineSeconds: 7200  # 2-hour timeout
      template:
        spec:
          restartPolicy: Never
          shareProcessNamespace: false

          volumes:
            - name: metrics-share
              emptyDir: {}
            - name: report-config
              configMap:
                name: report-config

          initContainers:
            # Init container records job start time into shared volume
            - name: record-start
              image: busybox:1.36
              command:
                - sh
                - -c
                - |
                  echo $(date +%s) > /metrics/start_time
                  echo "Job started at $(date -Iseconds)"
              volumeMounts:
                - name: metrics-share
                  mountPath: /metrics

          containers:
            # Primary job container
            - name: report-generator
              image: registry.support.tools/report-generator:4.2.1
              command:
                - /app/generate-report
                - --config=/etc/report/config.yaml
                - --output=/tmp/report.parquet
                - --metrics-file=/metrics/job_output.json
              env:
                - name: ENVIRONMENT
                  value: production
                - name: JOB_NAME
                  valueFrom:
                    fieldRef:
                      fieldPath: metadata.labels['batch.kubernetes.io/job-name']
              volumeMounts:
                - name: metrics-share
                  mountPath: /metrics
                - name: report-config
                  mountPath: /etc/report
              resources:
                requests:
                  cpu: 500m
                  memory: 2Gi
                limits:
                  cpu: 2000m
                  memory: 4Gi

            # Sidecar: waits for job output and pushes metrics to Pushgateway
            - name: metrics-pusher
              image: registry.support.tools/metrics-pusher:1.0.3
              command:
                - /app/metrics-pusher
                - --wait-file=/metrics/job_output.json
                - --pushgateway-url=$(PUSHGATEWAY_URL)
                - --job-name=nightly-report
                - --environment=production
              env:
                - name: PUSHGATEWAY_URL
                  valueFrom:
                    secretKeyRef:
                      name: pushgateway-config
                      key: url
              volumeMounts:
                - name: metrics-share
                  mountPath: /metrics
              resources:
                requests:
                  cpu: 50m
                  memory: 32Mi
```

### Simple Job with Push in Entrypoint

For jobs where the container image can be wrapped, push metrics directly from the entrypoint script.

```yaml
# simple-migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migration-20260315
  namespace: production
  labels:
    job-type: database-migration
    run-id: "20260315-143022"
spec:
  backoffLimit: 0                  # no retries for schema migrations
  activeDeadlineSeconds: 3600      # 1-hour timeout
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: db-migrator
          image: registry.support.tools/db-migrator:2.3.0
          command:
            - /bin/sh
            - -c
            - |
              # Run migration and capture exit code
              START=$(date +%s)
              /app/migrate --direction=up --steps=all
              EXIT_CODE=$?
              END=$(date +%s)
              DURATION=$((END - START))

              # Push completion metrics regardless of outcome
              cat <<METRICS | curl -sf --data-binary @- \
                "${PUSHGATEWAY_URL}/metrics/job/db-migration/run_id/${RUN_ID}"
              # TYPE db_migration_duration_seconds gauge
              db_migration_duration_seconds ${DURATION}
              # TYPE db_migration_exit_code gauge
              db_migration_exit_code ${EXIT_CODE}
              # TYPE db_migration_completion_time gauge
              db_migration_completion_time ${END}
              METRICS

              exit ${EXIT_CODE}
          env:
            - name: PUSHGATEWAY_URL
              value: "http://pushgateway.monitoring.svc.cluster.local:9091"
            - name: RUN_ID
              value: "20260315-143022"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: migration-url
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
```

## Staleness and Stale Metric Cleanup

### The Staleness Problem

Pushgateway does not implement Prometheus staleness markers. If a job stops pushing metrics (because it is no longer running), the last-pushed values remain in Pushgateway indefinitely. This causes two issues:

1. **False positives**: Alerts like "job has not run successfully in 24 hours" trigger correctly, but metric values from the last successful run remain in Pushgateway and can confuse dashboards
2. **Memory accumulation**: Orphaned grouping keys from old job runs consume memory in Pushgateway

### Automated Stale Key Cleanup

```python
#!/usr/bin/env python3
# cleanup_stale_pushgateway_metrics.py
# Run as a CronJob to remove grouping keys that haven't been updated recently.

import time
import json
import logging
import requests

logger = logging.getLogger(__name__)

PUSHGATEWAY_URL = "http://pushgateway.monitoring.svc.cluster.local:9091"
MAX_AGE_SECONDS = 86400 * 2        # remove keys not updated in 2 days


def get_all_grouping_keys(base_url: str) -> list[dict]:
    """Fetch all grouping keys and their push timestamps from the Pushgateway API."""
    response = requests.get(f"{base_url}/api/v1/metrics", timeout=30)
    response.raise_for_status()
    return response.json().get("data", [])


def delete_grouping_key(base_url: str, labels: dict) -> None:
    """Delete a grouping key from Pushgateway."""
    # Build the URL path from grouping key labels
    path_parts = []
    for k, v in sorted(labels.items()):
        if k == "job":
            continue                # job is part of the base path
        path_parts.extend([k, v])

    job_name = labels.get("job", "unknown")
    url = f"{base_url}/metrics/job/{job_name}"
    if path_parts:
        url += "/" + "/".join(path_parts)

    response = requests.delete(url, timeout=30)
    if response.status_code not in (200, 202):
        logger.warning("Failed to delete %s: HTTP %s", url, response.status_code)
    else:
        logger.info("Deleted stale grouping key: job=%s labels=%s", job_name, labels)


def main() -> None:
    now = time.time()
    metric_groups = get_all_grouping_keys(PUSHGATEWAY_URL)

    for group in metric_groups:
        labels = group.get("labels", {})
        push_time = float(group.get("push_time_seconds", {}).get("metrics", [{}])[0].get("value", 0))

        if push_time == 0:
            logger.debug("No push_time for group %s; skipping", labels)
            continue

        age = now - push_time
        if age > MAX_AGE_SECONDS:
            logger.info(
                "Stale grouping key: labels=%s age=%.0f seconds",
                labels, age,
            )
            delete_grouping_key(PUSHGATEWAY_URL, labels)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
```

```yaml
# stale-cleanup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pushgateway-stale-cleanup
  namespace: monitoring
spec:
  schedule: "0 6 * * *"            # run daily at 6 AM UTC
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: cleanup
              image: registry.support.tools/pushgateway-tools:1.0.0
              command: ["python3", "/scripts/cleanup_stale_pushgateway_metrics.py"]
              resources:
                requests:
                  cpu: 50m
                  memory: 64Mi
```

## Pushgateway High Availability

Pushgateway does not natively support HA replication. Running two instances without coordination causes pushes to land on only one instance, causing Prometheus to see metrics from only the scraped instance.

### Nginx Sticky Session Approach

Route pushes from each job instance consistently to the same Pushgateway replica using IP-hash sticky sessions.

```yaml
# pushgateway-ha.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pushgateway
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: pushgateway
  template:
    metadata:
      labels:
        app: pushgateway
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: pushgateway
                topologyKey: kubernetes.io/hostname
      containers:
        - name: pushgateway
          image: prom/pushgateway:v1.9.0
          args:
            - --persistence.file=/data/pushgateway.db
            - --persistence.interval=5m
          ports:
            - containerPort: 9091
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}

---
# Nginx reverse proxy with IP-hash load balancing
apiVersion: v1
kind: ConfigMap
metadata:
  name: pushgateway-nginx-config
  namespace: monitoring
data:
  nginx.conf: |
    upstream pushgateway_backends {
        ip_hash;                    # sticky routing based on client IP
        server pushgateway-0.pushgateway.monitoring.svc.cluster.local:9091;
        server pushgateway-1.pushgateway.monitoring.svc.cluster.local:9091;
    }

    server {
        listen 9091;
        location / {
            proxy_pass http://pushgateway_backends;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_connect_timeout 10s;
            proxy_send_timeout 10s;
            proxy_read_timeout 10s;
        }
    }
```

### Prometheus Scrape Configuration with honor_labels

When Pushgateway is the scrape target, `honor_labels: true` is critical. Without it, Prometheus overwrites the `job` and `instance` labels with Pushgateway's own labels, destroying the job identification data that was pushed.

```yaml
# prometheus-pushgateway-scrape.yaml
scrape_configs:
  - job_name: pushgateway
    honor_labels: true             # preserve pushed job/instance labels
    static_configs:
      - targets:
          - pushgateway.monitoring.svc.cluster.local:9091
    relabel_configs:
      # Do NOT add a job label override — honor_labels handles this
      - target_label: pushgateway_instance
        replacement: pushgateway.monitoring.svc.cluster.local:9091
    metric_relabel_configs:
      # Drop Pushgateway's own internal metrics from this job scrape
      # (they are collected via a separate ServiceMonitor)
      - source_labels: [__name__]
        regex: push_time_seconds|push_failure_time_seconds
        action: drop
```

## Alerting on Batch Job Metrics

### Alert Rules for Job Success and Failure

```yaml
# batch-job-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: batch-job-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: batch.jobs
      rules:
        # Nightly report has not succeeded in 25 hours
        - alert: NightlyReportJobMissed
          expr: |
            (time() - batch_job_last_success_time{job="nightly-report",environment="production"})
            > 90000
          labels:
            severity: warning
            team: data-platform
          annotations:
            summary: "Nightly report job has not succeeded in 25 hours"
            description: "The nightly report job last succeeded {{ $value | humanizeDuration }} ago. Expected to run at 02:00 UTC daily."

        # Job exited with a non-zero code
        - alert: BatchJobFailure
          expr: batch_job_exit_code{environment="production"} != 0
          for: 1m                  # 1m avoids flapping during push delay
          labels:
            severity: critical
          annotations:
            summary: "Batch job {{ $labels.job }} failed with exit code {{ $value }}"
            description: "Job {{ $labels.job }} in {{ $labels.environment }} exited with code {{ $value }}. Check job logs for details."

        # High error rate in record processing
        - alert: BatchJobHighErrorRate
          expr: |
            (
              batch_job_records_processed_total{status="error",environment="production"}
              /
              (
                batch_job_records_processed_total{status="success",environment="production"}
                + batch_job_records_processed_total{status="error",environment="production"}
              )
            ) > 0.05
          labels:
            severity: warning
          annotations:
            summary: "Batch job {{ $labels.job }} error rate exceeds 5%"
            description: "Error rate is {{ $value | humanizePercentage }}. Investigate data quality issues."
```

## Comparison with OpenTelemetry Push

| Aspect | Pushgateway | OTEL Collector (push mode) |
|---|---|---|
| Protocol | Prometheus text format over HTTP | OTLP/gRPC or OTLP/HTTP |
| Metric types | Gauge, Counter, Histogram, Untyped | Gauge, Sum, Histogram, Summary |
| Data retention | In-memory until replaced or deleted | Forwarded immediately; no retention |
| Staleness handling | Manual DELETE or timeout-based cleanup | OTEL staleness markers (delta temporality) |
| Language support | All via HTTP API | Official SDKs for 11+ languages |
| Labels | Fixed at push time | Attributes set via Resource or Span context |
| Use with traces | No | Yes; metrics can correlate with traces |
| Kubernetes Jobs support | Native use case | Requires SDK integration in app code |

For new batch jobs being written from scratch, the OTEL SDK with OTLP push to a collector is preferred. Pushgateway remains the correct choice when:
- The job is a shell script or legacy binary that cannot link an OTEL SDK
- The job uses the Prometheus client library and the team is already operating Pushgateway
- The job needs to push metrics from init containers or sidecar wrappers

## Summary

Pushgateway bridges the gap between Prometheus's pull model and the ephemeral nature of Kubernetes Jobs and CronJobs. Effective production deployment depends on:

- Designing grouping keys that include environment and job type but avoid pod-name or run-ID unless per-run history is specifically required
- Always using `honor_labels: true` in the Prometheus scrape config for Pushgateway targets
- Implementing staleness cleanup to prevent stale metric accumulation from completed or deleted jobs
- For HA, using Nginx IP-hash sticky sessions to ensure pushes from the same job source reach the same Pushgateway replica
- Alerting on `batch_job_last_success_time` staleness rather than on the presence of metrics, which covers the case where a job never started
- Avoiding Pushgateway for long-running services, multiple instances of the same service, or high-cardinality streaming metrics
