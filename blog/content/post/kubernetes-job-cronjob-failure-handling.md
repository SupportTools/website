---
title: "Job and CronJob Failure Handling Patterns: Enterprise-Ready Kubernetes Batch Workload Management"
date: 2026-08-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Job", "CronJob", "Batch Processing", "Error Handling", "Reliability"]
categories: ["Kubernetes", "DevOps", "Automation"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing robust failure handling, retry strategies, and monitoring patterns for Kubernetes Jobs and CronJobs in production environments."
more_link: "yes"
url: "/kubernetes-job-cronjob-failure-handling/"
---

Kubernetes Jobs and CronJobs are essential for running batch workloads, scheduled tasks, and one-time operations. However, production environments require sophisticated failure handling strategies to ensure reliability and observability. This comprehensive guide explores enterprise-ready patterns for managing Job and CronJob failures, implementing retry logic, and building resilient batch processing systems.

<!--more-->

## Understanding Job Failure Modes

Kubernetes Jobs can fail in several ways:

1. **Container Failures**: Application exits with non-zero status
2. **Resource Constraints**: Insufficient CPU, memory, or storage
3. **Scheduling Failures**: No suitable nodes available
4. **Deadlines Exceeded**: Job runs longer than specified timeout
5. **Backoff Limit Reached**: Too many retry attempts
6. **Node Failures**: Worker node crashes during execution

## Basic Job Configuration with Failure Handling

### Simple Job with Retry Logic

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processor
  namespace: batch
spec:
  # Number of successful completions required
  completions: 1
  # Number of pods to run in parallel
  parallelism: 1
  # Maximum number of retries before marking as failed
  backoffLimit: 3
  # Time limit for job execution
  activeDeadlineSeconds: 3600  # 1 hour
  # Clean up completed jobs
  ttlSecondsAfterFinished: 86400  # 24 hours
  template:
    metadata:
      labels:
        app: data-processor
        job-name: data-processor
    spec:
      restartPolicy: OnFailure  # or Never
      containers:
      - name: processor
        image: data/processor:v1.0
        command:
        - /bin/sh
        - -c
        - |
          set -e
          echo "Starting data processing..."

          # Implement application-level retry logic
          MAX_RETRIES=3
          RETRY_COUNT=0

          while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
            if process_data; then
              echo "Processing successful"
              exit 0
            else
              RETRY_COUNT=$((RETRY_COUNT + 1))
              echo "Attempt $RETRY_COUNT failed, retrying..."
              sleep $((RETRY_COUNT * 10))
            fi
          done

          echo "All retries exhausted"
          exit 1
        env:
        - name: JOB_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['job-name']
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        emptyDir:
          sizeLimit: 10Gi
```

### Advanced Job with Exponential Backoff

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: advanced-processor
  namespace: batch
  labels:
    app: advanced-processor
    tier: batch
spec:
  completions: 1
  parallelism: 1
  backoffLimit: 5
  activeDeadlineSeconds: 7200
  ttlSecondsAfterFinished: 172800  # 48 hours
  template:
    metadata:
      labels:
        app: advanced-processor
      annotations:
        sidecar.istio.io/inject: "false"  # Disable service mesh for batch jobs
    spec:
      restartPolicy: OnFailure
      # Use specific service account with limited permissions
      serviceAccountName: batch-processor
      # Set security context
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      initContainers:
      - name: init-validator
        image: busybox:1.35
        command:
        - sh
        - -c
        - |
          # Validate prerequisites
          echo "Checking prerequisites..."

          if [ ! -d "/data/input" ]; then
            echo "ERROR: Input directory not found"
            exit 1
          fi

          if [ -z "$(ls -A /data/input)" ]; then
            echo "ERROR: No input files found"
            exit 1
          fi

          echo "Prerequisites validated"
        volumeMounts:
        - name: data
          mountPath: /data
      containers:
      - name: processor
        image: advanced/processor:v2.0
        command:
        - /app/processor
        args:
        - --input=/data/input
        - --output=/data/output
        - --retry-attempts=5
        - --retry-delay=30
        - --exponential-backoff=true
        env:
        - name: LOG_LEVEL
          value: "info"
        - name: ENABLE_METRICS
          value: "true"
        - name: METRICS_PORT
          value: "8080"
        # Inject failure handling configuration
        - name: MAX_RETRIES
          value: "5"
        - name: RETRY_BACKOFF_MULTIPLIER
          value: "2"
        - name: RETRY_INITIAL_DELAY
          value: "10"
        - name: RETRY_MAX_DELAY
          value: "300"
        # Cloud provider credentials
        - name: AWS_REGION
          value: us-east-1
        - name: AWS_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: aws-credentials
              key: access-key-id
        - name: AWS_SECRET_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: aws-credentials
              key: secret-access-key
        resources:
          requests:
            memory: "1Gi"
            cpu: "1000m"
          limits:
            memory: "4Gi"
            cpu: "4000m"
        volumeMounts:
        - name: data
          mountPath: /data
        - name: config
          mountPath: /etc/processor
        - name: cache
          mountPath: /cache
        # Health checks for long-running jobs
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 30
          timeoutSeconds: 5
          failureThreshold: 3
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: batch-data-pvc
      - name: config
        configMap:
          name: processor-config
      - name: cache
        emptyDir:
          sizeLimit: 5Gi
      # Node selection for batch workloads
      nodeSelector:
        workload-type: batch
      # Tolerations for dedicated batch nodes
      tolerations:
      - key: batch-workload
        operator: Equal
        value: "true"
        effect: NoSchedule
      # Anti-affinity to spread across nodes
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - advanced-processor
              topologyKey: kubernetes.io/hostname
```

## CronJob Configuration with Failure Handling

### Production CronJob with Comprehensive Error Handling

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-report-generator
  namespace: batch
  labels:
    app: report-generator
    schedule: daily
spec:
  # Run at 2 AM UTC daily
  schedule: "0 2 * * *"
  # Timezone support (Kubernetes 1.25+)
  timeZone: "America/New_York"
  # Concurrency policy
  concurrencyPolicy: Forbid  # Don't start new if previous still running
  # Deadline for starting job (seconds)
  startingDeadlineSeconds: 300
  # Number of successful jobs to retain
  successfulJobsHistoryLimit: 3
  # Number of failed jobs to retain
  failedJobsHistoryLimit: 5
  # Suspend cron schedule
  suspend: false
  jobTemplate:
    metadata:
      labels:
        app: report-generator
        type: cronjob
    spec:
      completions: 1
      parallelism: 1
      backoffLimit: 2
      activeDeadlineSeconds: 3600
      ttlSecondsAfterFinished: 86400
      template:
        metadata:
          labels:
            app: report-generator
          annotations:
            prometheus.io/scrape: "true"
            prometheus.io/port: "8080"
        spec:
          restartPolicy: OnFailure
          serviceAccountName: report-generator
          containers:
          - name: generator
            image: reports/generator:v1.0
            command:
            - /bin/bash
            - -c
            - |
              #!/bin/bash
              set -euo pipefail

              # Trap errors and send notifications
              trap 'handle_error $? $LINENO' ERR

              handle_error() {
                local exit_code=$1
                local line_num=$2
                echo "ERROR: Job failed with exit code $exit_code at line $line_num"

                # Send failure notification
                curl -X POST ${SLACK_WEBHOOK_URL} \
                  -H 'Content-Type: application/json' \
                  -d "{\"text\":\"Report generation failed: Exit code $exit_code at line $line_num\"}"

                exit $exit_code
              }

              echo "Starting report generation at $(date)"

              # Check dependencies
              if ! check_database_connection; then
                echo "ERROR: Cannot connect to database"
                exit 1
              fi

              # Generate report with retry logic
              generate_report_with_retry() {
                local max_attempts=3
                local attempt=1
                local delay=10

                while [ $attempt -le $max_attempts ]; do
                  echo "Attempt $attempt of $max_attempts"

                  if /app/generate-report; then
                    echo "Report generated successfully"
                    return 0
                  fi

                  if [ $attempt -lt $max_attempts ]; then
                    echo "Attempt failed, waiting ${delay}s before retry..."
                    sleep $delay
                    delay=$((delay * 2))
                  fi

                  attempt=$((attempt + 1))
                done

                return 1
              }

              if generate_report_with_retry; then
                echo "Report generation completed successfully at $(date)"

                # Send success notification
                curl -X POST ${SLACK_WEBHOOK_URL} \
                  -H 'Content-Type: application/json' \
                  -d "{\"text\":\"Daily report generated successfully\"}"

                exit 0
              else
                echo "ERROR: Report generation failed after all retries"
                exit 1
              fi
            env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: database-credentials
                  key: url
            - name: SLACK_WEBHOOK_URL
              valueFrom:
                secretKeyRef:
                  name: notification-credentials
                  key: slack-webhook
            - name: REPORT_DATE
              value: "$(date +%Y-%m-%d)"
            resources:
              requests:
                memory: "512Mi"
                cpu: "500m"
              limits:
                memory: "2Gi"
                cpu: "2000m"
            volumeMounts:
            - name: reports
              mountPath: /reports
            - name: tmp
              mountPath: /tmp
          volumes:
          - name: reports
            persistentVolumeClaim:
              claimName: reports-pvc
          - name: tmp
            emptyDir:
              sizeLimit: 1Gi
```

### CronJob with Success/Failure Webhooks

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: job-webhook-script
  namespace: batch
data:
  webhook.sh: |
    #!/bin/bash
    # Send job status to webhook endpoint

    JOB_NAME=${JOB_NAME}
    JOB_STATUS=${1:-unknown}
    WEBHOOK_URL=${WEBHOOK_URL}
    EXIT_CODE=${2:-0}

    PAYLOAD=$(cat <<EOF
    {
      "job_name": "${JOB_NAME}",
      "status": "${JOB_STATUS}",
      "exit_code": ${EXIT_CODE},
      "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
      "namespace": "${NAMESPACE}",
      "pod_name": "${POD_NAME}"
    }
    EOF
    )

    echo "Sending webhook notification..."
    curl -X POST "${WEBHOOK_URL}" \
      -H "Content-Type: application/json" \
      -d "${PAYLOAD}" \
      --max-time 10 \
      --retry 3 \
      --retry-delay 5

    echo "Webhook sent successfully"
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-with-notifications
  namespace: batch
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: Never
          containers:
          - name: backup
            image: backup/tool:v1.0
            command:
            - /bin/bash
            - -c
            - |
              #!/bin/bash
              set -e

              # Source webhook script
              source /scripts/webhook.sh

              # Run backup
              echo "Starting backup..."
              if /app/backup.sh; then
                echo "Backup completed successfully"
                webhook.sh success 0
                exit 0
              else
                exit_code=$?
                echo "Backup failed with exit code $exit_code"
                webhook.sh failure $exit_code
                exit $exit_code
              fi
            env:
            - name: JOB_NAME
              value: backup-with-notifications
            - name: NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: WEBHOOK_URL
              valueFrom:
                secretKeyRef:
                  name: webhook-credentials
                  key: url
            volumeMounts:
            - name: scripts
              mountPath: /scripts
            - name: backup-data
              mountPath: /backup
          volumes:
          - name: scripts
            configMap:
              name: job-webhook-script
              defaultMode: 0755
          - name: backup-data
            persistentVolumeClaim:
              claimName: backup-pvc
```

## Parallel Job Processing with Failure Isolation

### Work Queue Pattern

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: worker-script
  namespace: batch
data:
  worker.sh: |
    #!/bin/bash
    set -euo pipefail

    QUEUE_URL=${QUEUE_URL}
    WORKER_ID=${HOSTNAME}

    echo "Worker ${WORKER_ID} starting..."

    process_item() {
      local item=$1
      echo "Processing item: $item"

      # Simulate work with possible failures
      if ! /app/process.sh "$item"; then
        echo "ERROR: Failed to process item: $item"
        # Send item to dead letter queue
        send_to_dlq "$item"
        return 1
      fi

      return 0
    }

    send_to_dlq() {
      local item=$1
      echo "Sending to dead letter queue: $item"
      # Implementation depends on queue system
      curl -X POST "${DLQ_URL}" -d "{\"item\": \"$item\", \"worker\": \"$WORKER_ID\"}"
    }

    # Main processing loop
    success_count=0
    failure_count=0

    while true; do
      # Fetch item from queue
      item=$(curl -s "${QUEUE_URL}/next" || echo "")

      if [ -z "$item" ] || [ "$item" == "null" ]; then
        echo "No more items in queue"
        break
      fi

      if process_item "$item"; then
        success_count=$((success_count + 1))
        # Acknowledge item
        curl -X POST "${QUEUE_URL}/ack" -d "{\"item\": \"$item\"}"
      else
        failure_count=$((failure_count + 1))
      fi

      # Respect rate limits
      sleep 1
    done

    echo "Worker completed: $success_count successful, $failure_count failed"

    # Exit with error if any failures occurred
    if [ $failure_count -gt 0 ]; then
      exit 1
    fi
---
apiVersion: batch/v1
kind: Job
metadata:
  name: parallel-processor
  namespace: batch
spec:
  completions: 10
  parallelism: 5
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: worker
        image: worker/processor:v1.0
        command:
        - /bin/bash
        - /scripts/worker.sh
        env:
        - name: QUEUE_URL
          value: "http://queue-service.batch.svc.cluster.local:8080"
        - name: DLQ_URL
          value: "http://dlq-service.batch.svc.cluster.local:8080"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        volumeMounts:
        - name: scripts
          mountPath: /scripts
      volumes:
      - name: scripts
        configMap:
          name: worker-script
          defaultMode: 0755
```

### Indexed Job for Batch Processing

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: indexed-batch-job
  namespace: batch
spec:
  completions: 100
  parallelism: 10
  completionMode: Indexed
  backoffLimit: 5
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: processor
        image: batch/indexed-processor:v1.0
        command:
        - /bin/bash
        - -c
        - |
          #!/bin/bash
          set -euo pipefail

          # JOB_COMPLETION_INDEX is automatically set by Kubernetes
          INDEX=${JOB_COMPLETION_INDEX}
          BATCH_SIZE=100
          TOTAL_ITEMS=10000

          # Calculate range for this index
          START=$((INDEX * BATCH_SIZE))
          END=$(((INDEX + 1) * BATCH_SIZE))

          echo "Processing items $START to $END"

          # Process items with retry logic
          for item_id in $(seq $START $((END - 1))); do
            retry_count=0
            max_retries=3

            while [ $retry_count -lt $max_retries ]; do
              if process_item $item_id; then
                echo "Item $item_id processed successfully"
                break
              else
                retry_count=$((retry_count + 1))
                if [ $retry_count -lt $max_retries ]; then
                  echo "Retry $retry_count for item $item_id"
                  sleep $((retry_count * 5))
                else
                  echo "ERROR: Failed to process item $item_id after $max_retries attempts"
                  # Log failure but continue with other items
                  echo "$item_id" >> /failures/failed_items.txt
                fi
              fi
            done
          done

          echo "Batch $INDEX completed"
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: database-credentials
              key: url
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        volumeMounts:
        - name: failures
          mountPath: /failures
      volumes:
      - name: failures
        persistentVolumeClaim:
          claimName: failure-logs-pvc
```

## Job Failure Monitoring and Alerting

### Job Status Exporter

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: job-monitor-script
  namespace: monitoring
data:
  monitor.sh: |
    #!/bin/bash
    # Monitor Job and CronJob statuses

    while true; do
      # Get all Jobs
      kubectl get jobs --all-namespaces -o json | jq -r '
        .items[] |
        select(.status.failed != null or .status.succeeded != null) |
        {
          namespace: .metadata.namespace,
          name: .metadata.name,
          active: (.status.active // 0),
          succeeded: (.status.succeeded // 0),
          failed: (.status.failed // 0),
          completion_time: .status.completionTime,
          start_time: .status.startTime
        }
      ' | while read -r job; do
        # Process job status and emit metrics
        namespace=$(echo "$job" | jq -r '.namespace')
        name=$(echo "$job" | jq -r '.name')
        failed=$(echo "$job" | jq -r '.failed')
        succeeded=$(echo "$job" | jq -r '.succeeded')

        # Write metrics in Prometheus format
        cat <<EOF >> /tmp/metrics.prom
job_status_failed{namespace="$namespace",job="$name"} $failed
job_status_succeeded{namespace="$namespace",job="$name"} $succeeded
EOF
      done

      # Get all CronJobs
      kubectl get cronjobs --all-namespaces -o json | jq -r '
        .items[] |
        {
          namespace: .metadata.namespace,
          name: .metadata.name,
          suspended: .spec.suspend,
          last_schedule: .status.lastScheduleTime,
          active: (.status.active // []) | length
        }
      ' | while read -r cronjob; do
        # Process cronjob status
        namespace=$(echo "$cronjob" | jq -r '.namespace')
        name=$(echo "$cronjob" | jq -r '.name')
        active=$(echo "$cronjob" | jq -r '.active')
        suspended=$(echo "$cronjob" | jq -r '.suspended')

        cat <<EOF >> /tmp/metrics.prom
cronjob_active_jobs{namespace="$namespace",cronjob="$name"} $active
cronjob_suspended{namespace="$namespace",cronjob="$name"} $([ "$suspended" == "true" ] && echo 1 || echo 0)
EOF
      done

      mv /tmp/metrics.prom /metrics/job_metrics.prom
      sleep 30
    done
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: job-monitor
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: job-monitor
  template:
    metadata:
      labels:
        app: job-monitor
    spec:
      serviceAccountName: job-monitor
      containers:
      - name: monitor
        image: bitnami/kubectl:latest
        command:
        - /bin/bash
        - /scripts/monitor.sh
        volumeMounts:
        - name: scripts
          mountPath: /scripts
        - name: metrics
          mountPath: /metrics
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "200m"
      - name: metrics-server
        image: nginx:alpine
        ports:
        - containerPort: 80
          name: http
        volumeMounts:
        - name: metrics
          mountPath: /usr/share/nginx/html
        - name: nginx-config
          mountPath: /etc/nginx/conf.d
      volumes:
      - name: scripts
        configMap:
          name: job-monitor-script
          defaultMode: 0755
      - name: metrics
        emptyDir: {}
      - name: nginx-config
        configMap:
          name: nginx-metrics-config
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: job-monitor
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: job-monitor
rules:
- apiGroups: ["batch"]
  resources: ["jobs", "cronjobs"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: job-monitor
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: job-monitor
subjects:
- kind: ServiceAccount
  name: job-monitor
  namespace: monitoring
```

### Prometheus Rules for Job Monitoring

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: job-alerts
  namespace: monitoring
spec:
  groups:
  - name: kubernetes-jobs
    interval: 30s
    rules:
    - alert: JobFailed
      expr: |
        kube_job_status_failed{job!~".*test.*"} > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Job {{ $labels.namespace }}/{{ $labels.job_name }} has failed"
        description: "Job {{ $labels.namespace }}/{{ $labels.job_name }} has failed {{ $value }} times."

    - alert: JobRunningTooLong
      expr: |
        time() - kube_job_status_start_time{job!~".*test.*"} > 7200
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Job {{ $labels.namespace }}/{{ $labels.job_name }} running too long"
        description: "Job {{ $labels.namespace }}/{{ $labels.job_name }} has been running for more than 2 hours."

    - alert: CronJobSuspended
      expr: |
        kube_cronjob_spec_suspend > 0
      for: 24h
      labels:
        severity: info
      annotations:
        summary: "CronJob {{ $labels.namespace }}/{{ $labels.cronjob }} is suspended"
        description: "CronJob {{ $labels.namespace}}/{{ $labels.cronjob }} has been suspended for more than 24 hours."

    - alert: CronJobNotScheduled
      expr: |
        time() - kube_cronjob_status_last_schedule_time > 3600
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "CronJob {{ $labels.namespace }}/{{ $labels.cronjob }} not scheduled"
        description: "CronJob {{ $labels.namespace }}/{{ $labels.cronjob }} has not been scheduled for more than 1 hour."

    - alert: JobBackoffLimitReached
      expr: |
        kube_job_status_failed >= kube_job_spec_backoff_limit
      labels:
        severity: critical
      annotations:
        summary: "Job {{ $labels.namespace }}/{{ $labels.job_name }} reached backoff limit"
        description: "Job {{ $labels.namespace }}/{{ $labels.job_name }} has reached its backoff limit and will not retry."
```

## Job Cleanup and Maintenance

### Automated Job Cleanup Controller

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: job-cleanup-script
  namespace: batch
data:
  cleanup.sh: |
    #!/bin/bash
    # Cleanup completed and failed jobs

    set -euo pipefail

    # Configuration
    COMPLETED_RETENTION_HOURS=${COMPLETED_RETENTION_HOURS:-24}
    FAILED_RETENTION_HOURS=${FAILED_RETENTION_HOURS:-168}  # 7 days
    DRY_RUN=${DRY_RUN:-false}

    echo "Starting job cleanup..."
    echo "Completed job retention: ${COMPLETED_RETENTION_HOURS} hours"
    echo "Failed job retention: ${FAILED_RETENTION_HOURS} hours"

    # Calculate cutoff timestamps
    COMPLETED_CUTOFF=$(date -u -d "${COMPLETED_RETENTION_HOURS} hours ago" +%Y-%m-%dT%H:%M:%SZ)
    FAILED_CUTOFF=$(date -u -d "${FAILED_RETENTION_HOURS} hours ago" +%Y-%m-%dT%H:%M:%SZ)

    # Cleanup completed jobs
    echo "Cleaning up completed jobs older than $COMPLETED_CUTOFF..."
    kubectl get jobs --all-namespaces -o json | jq -r "
      .items[] |
      select(.status.succeeded != null and .status.succeeded > 0) |
      select(.status.completionTime < \"$COMPLETED_CUTOFF\") |
      \"\(.metadata.namespace)/\(.metadata.name)\"
    " | while read -r job; do
      namespace=$(echo "$job" | cut -d/ -f1)
      name=$(echo "$job" | cut -d/ -f2)

      echo "Deleting completed job: $namespace/$name"
      if [ "$DRY_RUN" == "false" ]; then
        kubectl delete job "$name" -n "$namespace" --ignore-not-found=true
      else
        echo "DRY RUN: Would delete $namespace/$name"
      fi
    done

    # Cleanup failed jobs
    echo "Cleaning up failed jobs older than $FAILED_CUTOFF..."
    kubectl get jobs --all-namespaces -o json | jq -r "
      .items[] |
      select(.status.failed != null and .status.failed > 0) |
      select(.status.completionTime < \"$FAILED_CUTOFF\" or .status.startTime < \"$FAILED_CUTOFF\") |
      \"\(.metadata.namespace)/\(.metadata.name)\"
    " | while read -r job; do
      namespace=$(echo "$job" | cut -d/ -f1)
      name=$(echo "$job" | cut -d/ -f2)

      echo "Deleting failed job: $namespace/$name"
      if [ "$DRY_RUN" == "false" ]; then
        kubectl delete job "$name" -n "$namespace" --ignore-not-found=true
      else
        echo "DRY RUN: Would delete $namespace/$name"
      fi
    done

    echo "Cleanup complete"
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: job-cleanup
  namespace: batch
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: job-cleanup
          restartPolicy: OnFailure
          containers:
          - name: cleanup
            image: bitnami/kubectl:latest
            command:
            - /bin/bash
            - /scripts/cleanup.sh
            env:
            - name: COMPLETED_RETENTION_HOURS
              value: "24"
            - name: FAILED_RETENTION_HOURS
              value: "168"
            - name: DRY_RUN
              value: "false"
            volumeMounts:
            - name: scripts
              mountPath: /scripts
            resources:
              requests:
                memory: "128Mi"
                cpu: "100m"
              limits:
                memory: "256Mi"
                cpu: "200m"
          volumes:
          - name: scripts
            configMap:
              name: job-cleanup-script
              defaultMode: 0755
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: job-cleanup
  namespace: batch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: job-cleanup
rules:
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: job-cleanup
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: job-cleanup
subjects:
- kind: ServiceAccount
  name: job-cleanup
  namespace: batch
```

## Advanced Failure Recovery Patterns

### Dead Letter Queue Implementation

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dlq-processor
  namespace: batch
data:
  dlq.sh: |
    #!/bin/bash
    # Process items from dead letter queue

    set -euo pipefail

    DLQ_URL=${DLQ_URL}
    MAX_RETRY_ATTEMPTS=${MAX_RETRY_ATTEMPTS:-3}

    echo "Starting DLQ processor..."

    process_dlq_item() {
      local item=$1
      local retry_count=$2

      echo "Processing DLQ item (attempt $retry_count): $item"

      # Implement custom recovery logic
      if /app/retry-process.sh "$item"; then
        echo "DLQ item processed successfully: $item"
        # Remove from DLQ
        curl -X DELETE "${DLQ_URL}/item/${item}"
        return 0
      else
        echo "DLQ item processing failed: $item"
        return 1
      fi
    }

    # Main processing loop
    while true; do
      # Fetch items from DLQ
      items=$(curl -s "${DLQ_URL}/items" | jq -r '.[]')

      if [ -z "$items" ]; then
        echo "No items in DLQ, sleeping..."
        sleep 60
        continue
      fi

      echo "$items" | while read -r item_json; do
        item_id=$(echo "$item_json" | jq -r '.id')
        retry_count=$(echo "$item_json" | jq -r '.retry_count')

        if [ "$retry_count" -ge "$MAX_RETRY_ATTEMPTS" ]; then
          echo "Item $item_id exceeded max retries, moving to permanent failure store"
          curl -X POST "${PERMANENT_FAILURE_URL}" -d "$item_json"
          curl -X DELETE "${DLQ_URL}/item/${item_id}"
          continue
        fi

        if process_dlq_item "$item_id" "$retry_count"; then
          echo "Successfully recovered item $item_id"
        else
          # Increment retry count
          new_retry_count=$((retry_count + 1))
          curl -X PUT "${DLQ_URL}/item/${item_id}" \
            -d "{\"retry_count\": $new_retry_count}"
        fi

        # Rate limiting
        sleep 5
      done
    done
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dlq-processor
  namespace: batch
spec:
  replicas: 2
  selector:
    matchLabels:
      app: dlq-processor
  template:
    metadata:
      labels:
        app: dlq-processor
    spec:
      containers:
      - name: processor
        image: dlq/processor:v1.0
        command:
        - /bin/bash
        - /scripts/dlq.sh
        env:
        - name: DLQ_URL
          value: "http://dlq-service.batch.svc.cluster.local:8080"
        - name: PERMANENT_FAILURE_URL
          value: "http://failure-store.batch.svc.cluster.local:8080"
        - name: MAX_RETRY_ATTEMPTS
          value: "3"
        volumeMounts:
        - name: scripts
          mountPath: /scripts
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
      volumes:
      - name: scripts
        configMap:
          name: dlq-processor
          defaultMode: 0755
```

## Best Practices Summary

### 1. Resource Management

```yaml
# Always set resource requests and limits
resources:
  requests:
    memory: "512Mi"
    cpu: "500m"
  limits:
    memory: "2Gi"
    cpu: "2000m"
```

### 2. Proper Restart Policies

```yaml
# Use OnFailure for retryable operations
restartPolicy: OnFailure

# Use Never when you want full control
restartPolicy: Never
```

### 3. Backoff Limits

```yaml
# Set appropriate backoff limits
backoffLimit: 3  # Retry up to 3 times
activeDeadlineSeconds: 3600  # Timeout after 1 hour
```

### 4. Job Cleanup

```yaml
# Always set TTL for automatic cleanup
ttlSecondsAfterFinished: 86400  # Clean up after 24 hours
```

### 5. CronJob History

```yaml
# Retain job history for debugging
successfulJobsHistoryLimit: 3
failedJobsHistoryLimit: 5
```

## Conclusion

Robust failure handling for Kubernetes Jobs and CronJobs requires:

- **Comprehensive retry strategies** at both application and Kubernetes levels
- **Proper resource allocation** to prevent resource-related failures
- **Monitoring and alerting** to detect and respond to failures quickly
- **Automated cleanup** to prevent cluster resource exhaustion
- **Dead letter queues** for graceful degradation
- **Thorough logging** for post-mortem analysis

By implementing these patterns, you can build reliable batch processing systems that handle failures gracefully and maintain operational visibility.