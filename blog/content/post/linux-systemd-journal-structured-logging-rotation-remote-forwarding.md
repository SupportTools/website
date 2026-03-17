---
title: "Linux Systemd Journal: Structured Logging, Log Rotation, and Remote Log Forwarding"
date: 2030-10-17T00:00:00-05:00
draft: false
tags: ["Linux", "Systemd", "Journald", "Logging", "Loki", "Rsyslog", "Observability"]
categories:
- Linux
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise journald guide covering structured journal fields, vacuum policies, persistent vs volatile storage, journal-remote for centralized collection, rsyslog and Loki integration, and effective journalctl querying."
more_link: "yes"
url: "/linux-systemd-journal-structured-logging-rotation-remote-forwarding/"
---

The systemd journal is the primary logging subsystem for most modern Linux distributions, collecting logs from the kernel, daemons, containers, and user processes into a single indexed binary store. For infrastructure teams managing Kubernetes nodes, bare-metal servers, and cloud VMs, understanding the journal's internals — from its data model to its remote forwarding capabilities — is essential for building reliable observability pipelines that capture everything from kernel panics to application trace events.

<!--more-->

## Journal Architecture

### Storage Organization

The journal stores log data in binary files organized by boot session and time:

```bash
# Journal storage locations
# /run/log/journal/       - volatile (RAM), cleared on reboot
# /var/log/journal/       - persistent (disk), survives reboot

ls -lh /var/log/journal/$(cat /etc/machine-id)/
# system.journal          - current active journal
# system@<boot-id>.journal - sealed journals from previous boots
# user-1000.journal       - per-user session journal

# Show disk usage per machine
journalctl --disk-usage

# Show journal health
journalctl --verify

# Show journal metadata
journalctl --header | head -30
```

### Journal File Structure

Each journal file contains:
- **Data objects**: Unique values (deduplication reduces storage)
- **Field objects**: Key-value pairs
- **Entry objects**: Log records linking field objects
- **Entry array objects**: Hash tables for fast time-based lookup
- **Hash tables**: Field name and value indexes for O(1) filtering

## Structured Journal Fields

### Standard Fields

```bash
# System-provided fields (always present)
# _HOSTNAME       - machine hostname
# _MACHINE_ID     - /etc/machine-id
# _BOOT_ID        - kernel boot ID
# _PID            - process ID
# _UID/_GID       - process UID/GID
# _COMM           - executable name
# _EXE            - full path to executable
# _CMDLINE        - full command line
# _SYSTEMD_UNIT   - systemd unit name
# __REALTIME_TIMESTAMP - microseconds since epoch
# __MONOTONIC_TIMESTAMP - microseconds since boot

# User-provided fields (from applications)
# MESSAGE         - human-readable log message
# PRIORITY        - syslog priority (0=emerg, 7=debug)
# CODE_FILE       - source file
# CODE_LINE       - source line
# CODE_FUNC       - source function
# SYSLOG_IDENTIFIER - syslog tag equivalent

# View all fields in a specific entry
journalctl -n 1 -o json | python3 -m json.tool | head -40
```

### Writing Structured Log Entries

Applications can write structured data to the journal via systemd's native API or through the journal's socket:

```c
// C example using sd-journal
#include <systemd/sd-journal.h>
#include <stdlib.h>

void log_transaction(const char* txn_id, const char* status, double amount) {
    sd_journal_send(
        "MESSAGE=Payment transaction %s: %s for $%.2f", txn_id, status, amount,
        "TRANSACTION_ID=%s", txn_id,
        "TRANSACTION_STATUS=%s", status,
        "TRANSACTION_AMOUNT_CENTS=%d", (int)(amount * 100),
        "SYSLOG_IDENTIFIER=payment-service",
        "PRIORITY=6",  // Informational
        NULL
    );
}
```

```go
// Go example writing structured logs to journald
// Using the coreos/go-systemd package
package main

import (
    "github.com/coreos/go-systemd/v22/journal"
    "fmt"
)

func logOrderEvent(orderID, status string, amountCents int) error {
    return journal.Send(
        fmt.Sprintf("Order %s transitioned to status %s", orderID, status),
        journal.PriInfo,
        map[string]string{
            "ORDER_ID":           orderID,
            "ORDER_STATUS":       status,
            "AMOUNT_CENTS":       fmt.Sprintf("%d", amountCents),
            "SYSLOG_IDENTIFIER":  "order-service",
            "SERVICE_VERSION":    "2.1.0",
        },
    )
}
```

### Filtering by Custom Fields

```bash
# Filter journal entries by custom structured fields
journalctl ORDER_STATUS=failed
journalctl ORDER_STATUS=failed _SYSTEMD_UNIT=order-service.service

# Combine conditions (logical AND)
journalctl TRANSACTION_STATUS=declined _COMM=payment-service

# Filter by priority range
journalctl -p err..emerg
journalctl -p warning -n 100

# Combine time window and field filter
journalctl ORDER_STATUS=failed --since "1 hour ago" --until "now"

# Show only specific fields in output
journalctl ORDER_STATUS=failed -o json | \
  jq '{time: .__REALTIME_TIMESTAMP, order: .ORDER_ID, status: .ORDER_STATUS}'
```

## Journal Configuration: journald.conf

```ini
# /etc/systemd/journald.conf
[Journal]

# Storage options: auto, volatile, persistent, none
Storage=persistent

# Compression
Compress=yes
#CompressThreshold=512

# Signing (requires gcrypt)
Seal=yes

# Rate limiting for services that log too much
RateLimitIntervalSec=30s
RateLimitBurst=10000

# Maximum journal size
SystemMaxUse=4G
SystemKeepFree=1G
SystemMaxFileSize=256M

# Maximum retention by time (not size)
MaxRetentionSec=30days

# Maximum file count
# SystemMaxFiles=100

# Volatile (RAM) limits
RuntimeMaxUse=512M
RuntimeKeepFree=256M
RuntimeMaxFileSize=64M

# Forwarding
ForwardToSyslog=no
ForwardToKMsg=no
ForwardToConsole=no
ForwardToWall=yes

# Logging socket path
# Socket=/run/systemd/journal/socket

# Audit integration
Audit=yes

# Max line length (lines longer than this are split)
LineMax=48K

# Splitting
MaxFileSec=1week

# Per-service rate limits (override per unit)
# Override in unit file with LogRateLimitIntervalSec= / LogRateLimitBurst=
```

### Per-Service Journal Configuration

```ini
# /etc/systemd/system/high-volume-service.service.d/journal.conf
[Service]
# Override rate limiting for this specific service
LogRateLimitIntervalSec=10s
LogRateLimitBurst=50000

# Set log level filter at the service level
LogLevelMax=info

# Extra fields added to all log entries from this service
LogExtraFields=SERVICE_TIER=production
LogExtraFields=COST_CENTER=platform-engineering
```

## Journal Vacuum Policies

```bash
# Vacuum by size
journalctl --vacuum-size=2G      # Keep at most 2GB
journalctl --vacuum-size=500M    # Keep at most 500MB

# Vacuum by time
journalctl --vacuum-time=30d     # Remove entries older than 30 days
journalctl --vacuum-time=7d

# Vacuum by number of files
journalctl --vacuum-files=50     # Keep at most 50 journal files

# Combine: 2GB max, 30 days max
journalctl --vacuum-size=2G --vacuum-time=30d

# Automated vacuum via systemd timer (already installed by default)
systemctl status systemd-journal-catalog-update.timer
systemctl status systemd-journald-audit@.socket

# Custom vacuum cron job
cat > /etc/cron.daily/journal-vacuum << 'EOF'
#!/bin/bash
journalctl --vacuum-size=4G --vacuum-time=30d
EOF
chmod 755 /etc/cron.daily/journal-vacuum
```

### Journal Namespace Isolation

```bash
# Create a journal namespace for isolated log collection
# (systemd 246+)
mkdir -p /etc/systemd/journald@myapp.conf.d/

cat > /etc/systemd/journald@myapp.conf.d/storage.conf << 'EOF'
[Journal]
Storage=persistent
SystemMaxUse=1G
MaxRetentionSec=14days
EOF

# Start namespace journal
systemctl start systemd-journald@myapp.socket
systemctl start systemd-journald@myapp.service

# Point a service to the namespace
cat > /etc/systemd/system/myapp.service.d/journal-namespace.conf << 'EOF'
[Service]
LogNamespace=myapp
EOF

systemctl daemon-reload
systemctl restart myapp

# Query the namespace journal
journalctl --namespace=myapp -f
```

## journal-remote: Centralized Log Collection

### Server Configuration

```bash
# Install journal-remote
apt-get install -y systemd-journal-remote
# or
dnf install -y systemd-journal-remote

# Create certificate directory
mkdir -p /etc/systemd/journal-remote/

# Generate CA and certificates for TLS
# (Use your organization's PKI; example shows self-signed for testing)
openssl req -x509 -newkey rsa:4096 \
  -keyout /etc/systemd/journal-remote/ca-key.pem \
  -out /etc/systemd/journal-remote/ca-cert.pem \
  -days 3650 -nodes \
  -subj "/C=US/O=Example Org/CN=Journal CA"

openssl req -newkey rsa:4096 \
  -keyout /etc/systemd/journal-remote/server-key.pem \
  -out /etc/systemd/journal-remote/server.csr \
  -nodes \
  -subj "/C=US/O=Example Org/CN=journal-server.internal.example.com"

openssl x509 -req \
  -in /etc/systemd/journal-remote/server.csr \
  -CA /etc/systemd/journal-remote/ca-cert.pem \
  -CAkey /etc/systemd/journal-remote/ca-key.pem \
  -CAcreateserial \
  -out /etc/systemd/journal-remote/server-cert.pem \
  -days 365

chmod 640 /etc/systemd/journal-remote/*.pem
chown root:systemd-journal-remote /etc/systemd/journal-remote/*.pem
```

```ini
# /etc/systemd/journal-remote.conf
[Remote]
# Where to store received journals (one file per sender)
Output=/var/log/journal/remote/

# TLS configuration
ServerKeyFile=/etc/systemd/journal-remote/server-key.pem
ServerCertificateFile=/etc/systemd/journal-remote/server-cert.pem
TrustedCertificateFile=/etc/systemd/journal-remote/ca-cert.pem
```

```bash
# Enable and start the server
systemctl enable --now systemd-journal-remote.socket
systemctl enable --now systemd-journal-remote.service

# Open firewall
firewall-cmd --permanent --add-port=19532/tcp
firewall-cmd --reload

# Verify
systemctl status systemd-journal-remote.service
ss -tlnp | grep 19532
```

### Client Configuration (journal-upload)

```bash
# On each log-sending node
apt-get install -y systemd-journal-remote

# Generate per-node client certificate
openssl req -newkey rsa:4096 \
  -keyout /etc/systemd/journal-upload/client-key.pem \
  -out /etc/systemd/journal-upload/client.csr \
  -nodes \
  -subj "/C=US/O=Example Org/CN=$(hostname -f)"

# Sign with the CA (run on CA host, copy cert back)
openssl x509 -req \
  -in client.csr \
  -CA /etc/systemd/journal-remote/ca-cert.pem \
  -CAkey /etc/systemd/journal-remote/ca-key.pem \
  -CAcreateserial \
  -out /etc/systemd/journal-upload/client-cert.pem \
  -days 365

# Copy the CA cert to the client
cp ca-cert.pem /etc/systemd/journal-upload/
chmod 640 /etc/systemd/journal-upload/*.pem
chown root:systemd-journal-upload /etc/systemd/journal-upload/*.pem
```

```ini
# /etc/systemd/journal-upload.conf
[Upload]
URL=https://journal-server.internal.example.com:19532

ServerKeyFile=/etc/systemd/journal-upload/client-key.pem
ServerCertificateFile=/etc/systemd/journal-upload/client-cert.pem
TrustedCertificateFile=/etc/systemd/journal-upload/ca-cert.pem

# Resume from where we left off after restart
SaveStatePath=/var/lib/systemd/journal-upload/state
```

```bash
systemctl enable --now systemd-journal-upload.service

# Monitor upload progress
journalctl -u systemd-journal-upload -f
```

## Forwarding to Rsyslog

```bash
# Enable journal-to-syslog forwarding
# In /etc/systemd/journald.conf:
# ForwardToSyslog=yes

# Rsyslog configuration to receive from journal and forward to central syslog
cat > /etc/rsyslog.d/10-journal-forward.conf << 'EOF'
# Receive from systemd journal via imjournal module
module(load="imjournal"
  StateFile="/var/lib/rsyslog/imjournal.state"
  IgnorePreviousMessages="on"
  Ratelimit.Burst="20000"
  Ratelimit.Interval="10")

# Forward everything to central syslog with TLS
action(
  type="omfwd"
  Target="syslog.internal.example.com"
  Port="6514"
  Protocol="tcp"
  StreamDriver="gtls"
  StreamDriverMode="1"
  StreamDriverAuthMode="x509/name"
  StreamDriverPermittedPeers="syslog.internal.example.com"
  template="RSYSLOG_ForwardFormat"
  queue.type="LinkedList"
  queue.size="100000"
  queue.maxDiskSpace="2g"
  queue.saveOnShutdown="on"
  queue.filename="syslog-forward-queue"
  action.resumeRetryCount="-1"
)
EOF

systemctl restart rsyslog
```

## Forwarding to Grafana Loki

### Using Promtail for Journal Forwarding

```yaml
# /etc/promtail/config.yaml
server:
  http_listen_port: 9080
  grpc_listen_port: 0
  log_level: info

positions:
  filename: /var/lib/promtail/positions.yaml

clients:
  - url: http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push
    batchwait: 1s
    batchsize: 1048576
    timeout: 10s
    backoff_config:
      min_period: 500ms
      max_period: 5m
      max_retries: 10
    tenant_id: production

scrape_configs:
  # Scrape systemd journal
  - job_name: systemd-journal
    journal:
      max_age: 12h
      # Read from all namespaces
      path: /var/log/journal
      labels:
        job: systemd-journal
        host: __HOSTNAME__
      json: false

    relabel_configs:
      # Add common labels from journal fields
      - source_labels: ['__journal__systemd_unit']
        target_label: unit

      - source_labels: ['__journal__hostname']
        target_label: hostname

      - source_labels: ['__journal_priority_keyword']
        target_label: level

      - source_labels: ['__journal_syslog_identifier']
        target_label: service

      # Drop noisy infrastructure logs
      - source_labels: ['__journal__systemd_unit']
        regex: 'systemd-networkd.*|systemd-resolved.*|systemd-udevd.*'
        action: drop

      # Tag Kubernetes-related logs
      - source_labels: ['__journal__systemd_unit']
        regex: 'kubelet.*|kube-proxy.*|containerd.*|docker.*'
        target_label: component
        replacement: kubernetes

    pipeline_stages:
      # Parse JSON messages from structured loggers
      - match:
          selector: '{job="systemd-journal"}'
          stages:
          - json:
              expressions:
                level: level
                msg: msg
                caller: caller
              source: message
              drop_malformed: true

      # Extract JSON fields when present
      - json:
          expressions:
            parsed_level: level
          source: message

      # Set severity label from syslog priority
      - template:
          source: level
          template: |
            {{ if eq .Value "0" }}critical
            {{ else if eq .Value "1" }}critical
            {{ else if eq .Value "2" }}critical
            {{ else if eq .Value "3" }}error
            {{ else if eq .Value "4" }}warning
            {{ else if eq .Value "5" }}notice
            {{ else if eq .Value "6" }}info
            {{ else }}debug
            {{ end }}

      - labels:
          level:
```

### DaemonSet for Promtail on Kubernetes Nodes

```yaml
# promtail-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: promtail
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: promtail
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: promtail
    spec:
      serviceAccountName: promtail
      priorityClassName: system-node-critical

      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute

      containers:
      - name: promtail
        image: grafana/promtail:3.0.0
        args:
        - -config.file=/etc/promtail/config.yaml
        - -config.expand-env=true

        env:
        - name: HOSTNAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace

        ports:
        - containerPort: 9080
          name: http-metrics

        volumeMounts:
        - name: config
          mountPath: /etc/promtail
        - name: journal
          mountPath: /var/log/journal
          readOnly: true
        - name: machine-id
          mountPath: /etc/machine-id
          readOnly: true
        - name: run-log-journal
          mountPath: /run/log/journal
          readOnly: true
        - name: positions
          mountPath: /var/lib/promtail

        securityContext:
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
            add: ["DAC_READ_SEARCH"]  # Required for reading journal files

        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 256Mi

      volumes:
      - name: config
        configMap:
          name: promtail-config
      - name: journal
        hostPath:
          path: /var/log/journal
      - name: run-log-journal
        hostPath:
          path: /run/log/journal
      - name: machine-id
        hostPath:
          path: /etc/machine-id
          type: File
      - name: positions
        hostPath:
          path: /var/lib/promtail
          type: DirectoryOrCreate
```

## Effective journalctl Queries

### Essential Query Patterns

```bash
# Follow live logs with rich filtering
journalctl -f -u payment-service.service -p warning

# Show logs from the current boot
journalctl -b

# Show logs from the previous boot
journalctl -b -1

# Show all boot IDs
journalctl --list-boots

# Human-readable output with specific fields
journalctl -u nginx.service --since "2 hours ago" \
  -o json \
  | jq -r '[.__REALTIME_TIMESTAMP, .PRIORITY, .MESSAGE] | @tsv' \
  | awk -F'\t' '{
      ts = $1/1000000
      cmd = "date -d @" ts " +\"%Y-%m-%d %H:%M:%S\""
      cmd | getline dt
      close(cmd)
      print dt "\t" $2 "\t" $3
    }'

# Find all unique service names that logged errors
journalctl -p err --since "24 hours ago" -o json \
  | jq -r '._SYSTEMD_UNIT // .SYSLOG_IDENTIFIER // "unknown"' \
  | sort | uniq -c | sort -rn | head -20

# Correlate logs across services by transaction ID
TXID="txn-abc123"
journalctl TRANSACTION_ID="$TXID" \
  --since "1 hour ago" \
  -o short-precise

# Export logs for incident analysis
journalctl --since "2030-10-17 14:00:00" --until "2030-10-17 15:30:00" \
  -o export > incident-20301017.jnl

# Import and analyze exported logs on another machine
journalctl --file incident-20301017.jnl -o json | \
  jq 'select(.PRIORITY <= "3")' | \
  jq -r '.MESSAGE'

# Count log volume by unit in the last hour
journalctl --since "1 hour ago" -o json \
  | jq -r '._SYSTEMD_UNIT // "kernel"' \
  | sort | uniq -c | sort -rn | head -20

# Show kernel messages only
journalctl -k --since "1 hour ago"

# Show OOM kills
journalctl -k -g "killed process\|oom_kill"

# Monitor a path for segfaults
journalctl -k -g "segfault" -f
```

### Advanced Query Automation

```bash
#!/bin/bash
# journal-error-report.sh
# Generate daily error report from systemd journal

set -euo pipefail

SINCE="${1:--24h}"
OUTPUT="${2:-/tmp/journal-error-report-$(date +%Y%m%d).txt}"

{
  echo "=== Journal Error Report: $(date) ==="
  echo "Period: last $SINCE"
  echo ""

  echo "--- Error Count by Service ---"
  journalctl -p err..emerg --since "$SINCE" -o json 2>/dev/null \
    | jq -r '(.SYSLOG_IDENTIFIER // ._SYSTEMD_UNIT // "unknown")' \
    | sort | uniq -c | sort -rn | head -20

  echo ""
  echo "--- OOM Events ---"
  journalctl -k --since "$SINCE" -g "killed process" 2>/dev/null \
    | tail -20 || echo "None"

  echo ""
  echo "--- Service Restart Events ---"
  journalctl -u "*" --since "$SINCE" -g "Started\|stopped\|Failed" \
    -o short-monotonic 2>/dev/null | grep -i "failed\|restarting" | tail -30 \
    || echo "None"

  echo ""
  echo "--- Disk and Filesystem Errors ---"
  journalctl -k --since "$SINCE" \
    -g "I/O error\|EXT4-fs error\|XFS.*error\|SCSI error" 2>/dev/null \
    | tail -20 || echo "None"

  echo ""
  echo "--- SELinux AVC Denials ---"
  journalctl --since "$SINCE" -g "AVC" 2>/dev/null \
    | grep -v "^--" | tail -20 || echo "None"

} > "$OUTPUT"

echo "Report written to: $OUTPUT"
cat "$OUTPUT"
```

## Journal Metrics Integration

```bash
# Prometheus metrics from journal using node_exporter textfile collector
cat > /usr/local/bin/journal-metrics.sh << 'EOF'
#!/bin/bash
# Collect journal metrics for Prometheus scraping

METRICS_DIR="/var/lib/node_exporter/textfile_collector"
TMPFILE="${METRICS_DIR}/journal_metrics.prom.tmp"
OUTFILE="${METRICS_DIR}/journal_metrics.prom"

mkdir -p "$METRICS_DIR"

{
  echo "# HELP journal_disk_usage_bytes Journal disk usage in bytes"
  echo "# TYPE journal_disk_usage_bytes gauge"
  USAGE=$(journalctl --disk-usage 2>/dev/null | grep -oP '\d+(\.\d+)?\s*(G|M|K)' | head -1)
  # Convert to bytes (simplified)
  echo "journal_disk_usage_bytes $(journalctl --disk-usage 2>/dev/null | grep -oP '\d+' | head -1)"

  echo "# HELP journal_errors_total Error entries in the last 5 minutes"
  echo "# TYPE journal_errors_total counter"
  ERROR_COUNT=$(journalctl -p err..emerg --since "5 minutes ago" -o json 2>/dev/null | wc -l)
  echo "journal_errors_total $ERROR_COUNT"

  echo "# HELP journal_oom_events_total OOM kill events in the last 5 minutes"
  echo "# TYPE journal_oom_events_total counter"
  OOM_COUNT=$(journalctl -k --since "5 minutes ago" -g "killed process" 2>/dev/null | grep -c "killed process" || echo 0)
  echo "journal_oom_events_total $OOM_COUNT"

} > "$TMPFILE"

mv "$TMPFILE" "$OUTFILE"
EOF

chmod 755 /usr/local/bin/journal-metrics.sh

# Cron job every minute
echo "* * * * * root /usr/local/bin/journal-metrics.sh" > /etc/cron.d/journal-metrics
```

The systemd journal's combination of binary storage with rich indexing, structured field support, and cryptographic sealing makes it far more capable than traditional syslog for modern observability requirements. The journal-remote transport, combined with either Promtail-to-Loki or rsyslog-to-central-syslog forwarding, provides the foundation for centralized log management across large server fleets.
