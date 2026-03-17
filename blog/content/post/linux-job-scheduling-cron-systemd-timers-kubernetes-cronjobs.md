---
title: "Linux Job Scheduling: cron, systemd Timers, and Kubernetes CronJobs Compared"
date: 2030-06-11T00:00:00-05:00
draft: false
tags: ["Linux", "cron", "systemd", "Kubernetes", "CronJob", "Job Scheduling", "DevOps", "System Administration"]
categories:
- Linux
- Kubernetes
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise scheduling guide: crontab syntax and gotchas, systemd timer units with monotonic clocks, Kubernetes CronJob patterns, job history management, missed execution handling, and choosing the right scheduler."
more_link: "yes"
url: "/linux-job-scheduling-cron-systemd-timers-kubernetes-cronjobs/"
---

Three distinct scheduling systems operate in modern infrastructure: cron for host-level jobs, systemd timers for service-integrated scheduling, and Kubernetes CronJobs for containerized workloads. Each has specific strengths and failure modes. Choosing the wrong tool for a task leads to jobs that run at incorrect times, fail silently, or overwhelm systems during catch-up after maintenance windows. This guide covers the operational details that distinguish reliable scheduled jobs from fragile ones.

<!--more-->

## Cron: The Foundation

### crontab Syntax Reference

The five-field time specification controls when cron executes a job:

```
┌─────────── minute (0–59)
│ ┌───────── hour (0–23)
│ │ ┌─────── day of month (1–31)
│ │ │ ┌───── month (1–12 or jan–dec)
│ │ │ │ ┌─── day of week (0–7, 0 and 7 are Sunday, or sun–sat)
│ │ │ │ │
* * * * * command

# Special strings
@reboot    # Run once at system startup
@yearly    # Run once a year (0 0 1 1 *)
@annually  # Same as @yearly
@monthly   # Run once a month (0 0 1 * *)
@weekly    # Run once a week (0 0 * * 0)
@daily     # Run once a day (0 0 * * *)
@midnight  # Same as @daily
@hourly    # Run once an hour (0 * * * *)
```

### Common Syntax Examples

```bash
# Every minute
* * * * * /usr/local/bin/health-check.sh

# Every 5 minutes
*/5 * * * * /usr/local/bin/metrics-push.sh

# At 02:30 every day
30 2 * * * /usr/local/bin/nightly-backup.sh

# Every weekday at 08:00
0 8 * * 1-5 /usr/local/bin/send-daily-report.sh

# First day of every month at midnight
0 0 1 * * /usr/local/bin/monthly-billing.sh

# Every 15 minutes between 09:00 and 17:00 on weekdays
*/15 9-17 * * 1-5 /usr/local/bin/check-services.sh

# At 02:00 on weekdays, and 04:00 on weekends
0 2 * * 1-5 /usr/local/bin/weekday-task.sh
0 4 * * 0,6 /usr/local/bin/weekend-task.sh
```

### Critical cron Gotchas

**Gotcha 1: PATH is minimal**

cron runs with a restricted PATH. Commands that work interactively fail silently in cron:

```bash
# BAD: 'python3' may not be in cron's PATH
* * * * * python3 /opt/scripts/report.py

# GOOD: Use absolute paths always
* * * * * /usr/bin/python3 /opt/scripts/report.py

# Or set PATH explicitly
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * /opt/scripts/check.sh
```

**Gotcha 2: Silent failures**

By default, cron emails stdout/stderr to the local user. On servers without mail delivery, failures are invisible:

```bash
# Redirect output to a log file
30 2 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1

# Or to syslog
30 2 * * * /usr/bin/logger -t backup -p local0.info "$(/usr/local/bin/backup.sh 2>&1)"

# Or use anacron for critical jobs with email on failure
MAILTO=ops-team@example.com
30 2 * * * /usr/local/bin/backup.sh
```

**Gotcha 3: Concurrent execution**

cron does not track running jobs. If a job takes longer than its interval, multiple instances run simultaneously:

```bash
# Use flock to prevent concurrent execution
*/5 * * * * flock -n /tmp/metrics-push.lock /usr/local/bin/metrics-push.sh

# Or a PID file approach
*/5 * * * * /usr/local/bin/run-once.sh /tmp/metrics.pid /usr/local/bin/metrics-push.sh
```

```bash
#!/usr/bin/env bash
# run-once.sh — run a command only if not already running
PID_FILE="$1"
shift

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Already running (PID: $(cat "$PID_FILE"))" >&2
    exit 0
fi

echo $$ > "$PID_FILE"
"$@"
EXIT_CODE=$?
rm -f "$PID_FILE"
exit $EXIT_CODE
```

**Gotcha 4: Environment variables**

```bash
# cron does not source .bashrc, .profile, or any shell init files.
# Environment variables must be set explicitly in the crontab.
ENVIRONMENT=production
AWS_PROFILE=backup-role
HOME=/var/lib/backup

30 2 * * * /usr/local/bin/backup-to-s3.sh
```

**Gotcha 5: Day-of-month AND day-of-week are OR'd**

```bash
# This runs on the 1st of the month AND on every Monday (not only Monday the 1st)
0 10 1 * 1 /usr/local/bin/task.sh

# To run only when BOTH conditions are met, use a script:
0 10 1 * 1 [ "$(date +\%d)" = "01" ] && /usr/local/bin/task.sh
```

### System cron vs User crontabs

```bash
# System cron locations
/etc/crontab          # System crontab (has user field: minute hour dom month dow USER command)
/etc/cron.d/          # Drop-in files (same format as /etc/crontab)
/etc/cron.hourly/     # Scripts run hourly
/etc/cron.daily/      # Scripts run daily
/etc/cron.weekly/     # Scripts run weekly
/etc/cron.monthly/    # Scripts run monthly

# System crontab format (note USER field)
30 2 * * * root /usr/local/bin/backup.sh

# User crontab (no USER field)
crontab -e   # Edit current user's crontab
crontab -l   # List current user's crontab
crontab -u appuser -e  # Edit another user's crontab (root only)

# Example /etc/cron.d/app-jobs
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
MAILTO=""

30 2 * * *  appuser  /opt/app/bin/backup.sh >> /var/log/app-backup.log 2>&1
*/5 * * * * appuser  /opt/app/bin/health-push.sh > /dev/null 2>&1
```

## systemd Timers

systemd timers were covered in depth in the systemd unit management guide. This section focuses on the scheduling-specific features and comparison with cron.

### Calendar Expressions vs Cron Syntax

systemd uses a more readable calendar expression format:

```bash
# Equivalent cron → systemd OnCalendar expressions:
# * * * * *           → *-*-* *:*:*  (every minute)
# 0 * * * *           → *-*-* *:00:00 (every hour)
# 0 0 * * *           → *-*-* 00:00:00 (daily at midnight)
# 30 2 * * *          → *-*-* 02:30:00
# 0 8 * * 1-5         → Mon..Fri *-*-* 08:00:00
# */5 * * * *         → *-*-* *:0/5:00
# 0 0 1 * *           → *-*-01 00:00:00

# Verify and check next trigger times
systemd-analyze calendar --iterations=5 "Mon..Fri *-*-* 08:00:00"
```

### Advantages Over cron

**Persistent mode**: If a timer's service was missed (system was off), run it immediately on next activation:

```ini
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true  # Run missed jobs when system becomes available
```

**Randomized delays**: Distribute scheduled tasks to prevent thundering herd:

```ini
[Timer]
OnCalendar=*-*-* 02:00:00
RandomizedDelaySec=30min  # Runs between 02:00 and 02:30
```

**Dependency integration**: Timer-activated services can depend on other services:

```ini
[Unit]
Description=Database Backup
Requires=postgresql.service
After=postgresql.service network-online.target
```

**Journal integration**: All output is captured by journald automatically:

```bash
# View last 10 runs of the backup service
journalctl -u db-backup.service -n 50 --no-pager

# View all output from the last run
journalctl -u db-backup.service -b
```

### Converting cron Jobs to systemd Timers

```bash
# cron job to convert:
# 30 2 * * * appuser /usr/local/bin/backup-postgres.sh >> /var/log/pg-backup.log 2>&1
```

```ini
# /etc/systemd/system/pg-backup.timer
[Unit]
Description=PostgreSQL Backup Timer
Documentation=https://internal.example.com/ops/backups

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/pg-backup.service
[Unit]
Description=PostgreSQL Backup
After=postgresql.service network-online.target
Requires=postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
User=appuser
Group=appuser
ExecStart=/usr/local/bin/backup-postgres.sh
# Output captured by journald — no log redirection needed
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pg-backup

# Resource limits
MemoryMax=2G
CPUQuota=50%

# Security hardening
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/backups/postgres
```

```bash
systemctl enable --now pg-backup.timer
systemctl status pg-backup.timer
```

## Kubernetes CronJobs

Kubernetes CronJobs schedule Jobs using cron syntax. Each execution creates a Kubernetes Job, which creates one or more Pods.

### Basic CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: database-backup
  namespace: production
spec:
  # Standard cron expression (UTC timezone by default)
  schedule: "30 2 * * *"

  # CronJob-specific settings
  concurrencyPolicy: Forbid        # Do not allow concurrent runs
  failedJobsHistoryLimit: 5        # Keep 5 failed job records
  successfulJobsHistoryLimit: 3    # Keep 3 successful job records
  startingDeadlineSeconds: 300     # Miss window = skip (not catch up) after 300s
  suspend: false                   # Set to true to pause the CronJob

  jobTemplate:
    spec:
      # Job settings
      backoffLimit: 3              # Retry failed pods up to 3 times
      activeDeadlineSeconds: 3600  # Kill job if it runs longer than 1 hour
      ttlSecondsAfterFinished: 86400  # Delete finished jobs after 24 hours

      template:
        spec:
          restartPolicy: OnFailure
          serviceAccountName: backup-sa
          containers:
            - name: backup
              image: registry.example.com/pg-backup:v2.1.0
              command:
                - /bin/sh
                - -c
                - |
                  set -euo pipefail
                  echo "Starting backup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
                  pg_dump \
                    -h "${DB_HOST}" \
                    -U "${DB_USER}" \
                    -d "${DB_NAME}" \
                    -F custom \
                    -f "/backups/${DB_NAME}-$(date +%Y%m%d-%H%M%S).dump"
                  echo "Backup completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
              env:
                - name: DB_HOST
                  valueFrom:
                    secretKeyRef:
                      name: db-secret
                      key: host
                - name: DB_USER
                  valueFrom:
                    secretKeyRef:
                      name: db-secret
                      key: user
                - name: PGPASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: db-secret
                      key: password
                - name: DB_NAME
                  value: "production_db"
              volumeMounts:
                - name: backup-storage
                  mountPath: /backups
              resources:
                requests:
                  cpu: 200m
                  memory: 512Mi
                limits:
                  cpu: 2000m
                  memory: 2Gi
          volumes:
            - name: backup-storage
              persistentVolumeClaim:
                claimName: backup-pvc
```

### Concurrency Policies

```yaml
# ConcurrencyPolicy options:

# Allow: Multiple instances can run simultaneously (default, use for stateless jobs)
concurrencyPolicy: Allow

# Forbid: Skip new run if previous is still running (use for non-idempotent jobs)
concurrencyPolicy: Forbid

# Replace: Cancel the running job and start a new one (use when freshness matters)
concurrencyPolicy: Replace
```

### Timezone Configuration

```yaml
spec:
  # Specify timezone (requires Kubernetes 1.27+)
  timeZone: "America/New_York"
  schedule: "30 2 * * *"  # Now interpreted as 02:30 Eastern
```

For older clusters, use UTC-offset math:

```yaml
# Run at 02:30 Eastern (UTC-5 in winter, UTC-4 in summer)
# Use UTC+5 (02:30 + 5 = 07:30 UTC) for winter
schedule: "30 7 * * *"  # 07:30 UTC = 02:30 EST
```

### Handling Missed Jobs

`startingDeadlineSeconds` controls what happens when a CronJob misses its scheduled time:

```yaml
# If the job misses its window by more than 300 seconds, skip this run.
startingDeadlineSeconds: 300

# If not set: Kubernetes tracks up to 100 missed schedules.
# If more than 100 are missed, the CronJob is suspended with the error:
# "too many missed start times"
```

For jobs that MUST run even after long maintenance windows, consider using a Job with `Persistent=true` behavior instead:

```yaml
# Helm hook pattern: ensure the job runs on each deployment
apiVersion: batch/v1
kind: Job
metadata:
  name: ensure-db-cleaned
  annotations:
    helm.sh/hook: post-upgrade
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: cleanup
          image: registry.example.com/db-tools:v1.0.0
          command: ["/usr/local/bin/cleanup-old-records.sh"]
```

### Job History Management

```bash
# View CronJob history
kubectl get cronjob database-backup -n production

# List recent jobs created by the CronJob
kubectl get jobs -n production -l job-name=database-backup \
  --sort-by=.metadata.creationTimestamp

# Check logs from the most recent run
LAST_JOB=$(kubectl get jobs -n production \
  -l job-name=database-backup \
  --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[-1].metadata.name}')

kubectl logs -n production \
  -l job-name="${LAST_JOB}" \
  --container backup

# Manual trigger for testing
kubectl create job --from=cronjob/database-backup \
  manual-backup-$(date +%Y%m%d-%H%M%S) \
  -n production

# Suspend a CronJob (emergency pause)
kubectl patch cronjob database-backup -n production \
  -p '{"spec":{"suspend":true}}'

# Resume
kubectl patch cronjob database-backup -n production \
  -p '{"spec":{"suspend":false}}'
```

### Complex CronJob Patterns

#### Distributed Locking for Multi-Cluster Environments

When the same CronJob runs across multiple clusters, use distributed locking to prevent duplicate execution:

```yaml
containers:
  - name: job
    image: registry.example.com/job-runner:v1.0.0
    command:
      - /bin/sh
      - -c
      - |
        # Acquire Redis lock
        LOCK_KEY="cronjob:daily-report:$(date +%Y%m%d)"
        LOCK_ACQUIRED=$(redis-cli \
          -h "${REDIS_HOST}" \
          SET "$LOCK_KEY" "$(hostname)" \
          NX EX 3600)

        if [ "$LOCK_ACQUIRED" = "OK" ]; then
          echo "Lock acquired, running job"
          /usr/local/bin/generate-daily-report.sh
          EXIT_CODE=$?
          redis-cli -h "${REDIS_HOST}" DEL "$LOCK_KEY"
          exit $EXIT_CODE
        else
          echo "Lock not acquired — another instance is running"
          exit 0
        fi
```

#### Parallel Job Pattern

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: shard-processor
  namespace: production
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      completions: 8        # Total jobs to complete
      parallelism: 4        # Run 4 in parallel
      completionMode: Indexed  # Each pod gets an index (0-7)
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: processor
              image: registry.example.com/processor:v1.0.0
              env:
                - name: JOB_INDEX
                  valueFrom:
                    fieldRef:
                      fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
                - name: TOTAL_SHARDS
                  value: "8"
              command:
                - /bin/sh
                - -c
                - |
                  echo "Processing shard ${JOB_INDEX} of ${TOTAL_SHARDS}"
                  /usr/local/bin/process-shard.sh --shard=${JOB_INDEX} --total=${TOTAL_SHARDS}
```

## Comparison: Choosing the Right Scheduler

### Decision Matrix

| Requirement | cron | systemd Timer | Kubernetes CronJob |
|---|---|---|---|
| Host-level jobs (not containerized) | Yes | Yes (preferred) | No |
| Service dependency awareness | No | Yes | Limited (init containers) |
| Missed job recovery after downtime | No (by default) | Yes (Persistent=true) | Configurable |
| Structured logging | No | Yes (journald) | Yes (pod logs) |
| Concurrent run prevention | Manual (flock) | systemd handles | concurrencyPolicy |
| Resource limits | No | cgroups via Service | Yes (pod limits) |
| Distributed execution | No | No | Yes (multi-node) |
| Secret management | Environment only | systemd secrets | Kubernetes Secrets |
| Container-native workloads | No | No | Yes |
| Monitoring/alerting integration | Manual | Prometheus + journald | Prometheus + events |
| Timezone support | Limited | Yes | Kubernetes 1.27+ |
| Idempotency enforcement | Manual | Manual | concurrencyPolicy: Forbid |

### When to Use cron

Use cron when:
- The system does not use systemd (embedded Linux, Alpine containers)
- The job is simple and dependencies are minimal
- The codebase already has extensive cron infrastructure
- Quick iteration speed is more important than operational rigor

### When to Use systemd Timers

Use systemd timers when:
- The job depends on other services being ready (database, network)
- Missed executions during maintenance windows must be caught up
- Structured logging to journald/Loki is required
- Resource limiting via cgroups is needed
- The system already uses systemd (most modern Linux distributions)

### When to Use Kubernetes CronJobs

Use Kubernetes CronJobs when:
- The workload runs in containers
- Secrets are managed by Kubernetes
- The job needs to scale (parallel execution, multiple instances)
- Kubernetes-native monitoring (pod events, Prometheus) is in use
- The cluster manages the deployment environment

## Monitoring Scheduled Jobs

### Prometheus Alerting for cron Jobs

```bash
# Heartbeat monitoring pattern: cron job pushes to Prometheus Pushgateway
*/5 * * * * \
  /usr/local/bin/health-check.sh && \
  curl -s --max-time 5 \
    -X POST \
    "http://pushgateway:9091/metrics/job/health-check/instance/$(hostname)" \
    --data-binary "job_last_success_time_seconds $(date +%s)\n"
```

```yaml
# Alert if health-check hasn't pushed in 15 minutes
groups:
  - name: scheduled_jobs
    rules:
      - alert: ScheduledJobMissed
        expr: |
          time() - push_time_seconds{job="health-check"} > 900
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Scheduled job {{ $labels.job }} has not run in 15 minutes"
```

### Kubernetes CronJob Monitoring

```yaml
# PrometheusRule for CronJob monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cronjob-alerts
  namespace: monitoring
spec:
  groups:
    - name: kubernetes.cronjobs
      rules:
        - alert: CronJobFailed
          expr: |
            kube_job_status_failed{
              job_name=~".*"
            } > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Kubernetes job {{ $labels.job_name }} has failed pods"

        - alert: CronJobNotScheduled
          expr: |
            time() - kube_cronjob_status_last_schedule_time > 7200
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CronJob {{ $labels.cronjob }} has not been scheduled in 2 hours"

        - alert: CronJobSuspended
          expr: |
            kube_cronjob_spec_suspend == 1
          for: 30m
          labels:
            severity: info
          annotations:
            summary: "CronJob {{ $labels.cronjob }} is suspended"
```

### Dead Man's Switch Pattern

For critical scheduled jobs, implement a dead man's switch: alert if the job does NOT check in:

```bash
#!/usr/bin/env bash
# backup-with-healthcheck.sh

set -euo pipefail

HEALTHCHECK_URL="${HEALTHCHECK_URL:?HEALTHCHECK_URL required}"

# Signal start
curl -fsS -m 10 "${HEALTHCHECK_URL}/start" || true

# Run the actual job
/usr/local/bin/backup-postgres.sh

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  # Signal success
  curl -fsS -m 10 "${HEALTHCHECK_URL}" || true
else
  # Signal failure
  curl -fsS -m 10 "${HEALTHCHECK_URL}/fail" || true
fi

exit $EXIT_CODE
```

## Summary

cron, systemd timers, and Kubernetes CronJobs serve overlapping but distinct purposes. cron remains appropriate for simple host-level tasks but lacks the dependency awareness, structured logging, and resource control that production systems need. systemd timers address every cron limitation while integrating with the service management layer. Kubernetes CronJobs are the appropriate choice for containerized workloads in Kubernetes clusters.

Across all three systems, the operational disciplines are similar: prevent concurrent execution, handle missed runs explicitly, log structured output to a queryable system, and monitor with dead man's switches or push-based heartbeats. The specific implementation differs; the operational requirements do not.
