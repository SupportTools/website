---
title: "Enterprise System Monitoring with Telegraf: Advanced Hardware Telemetry and Infrastructure Diagnostics for Production Environments"
date: 2026-11-30T00:00:00-05:00
draft: false
tags: ["Telegraf", "Monitoring", "Hardware", "Telemetry", "Infrastructure", "Observability", "Performance", "Diagnostics"]
categories: ["Monitoring", "Infrastructure", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying Telegraf for enterprise hardware monitoring, system telemetry collection, and advanced infrastructure diagnostics with production-ready configurations and alerting strategies."
more_link: "yes"
url: "/telegraf-enterprise-system-monitoring-hardware-telemetry-production-guide/"
---

Telegraf serves as the cornerstone of modern infrastructure monitoring, providing comprehensive system telemetry collection capabilities that enable organizations to maintain operational excellence across diverse hardware environments. This guide presents enterprise-grade deployment patterns, advanced configuration strategies, and production-ready monitoring architectures for large-scale infrastructure management.

<!--more-->

# Executive Summary

Telegraf's plugin-based architecture and extensive hardware integration capabilities make it the optimal choice for enterprise system monitoring. This comprehensive guide demonstrates advanced telemetry collection patterns, hardware sensor monitoring, performance optimization strategies, and enterprise-grade alerting configurations that enable proactive infrastructure management and operational excellence.

## Telegraf Architecture and Enterprise Deployment Patterns

### Core Architecture Overview

Telegraf operates as a lightweight, plugin-driven agent that collects, processes, and transmits telemetry data from diverse sources to multiple destinations:

```toml
# /etc/telegraf/telegraf.conf
# Enterprise-grade Telegraf configuration

# Global agent configuration
[agent]
  interval = "30s"
  round_interval = true
  metric_batch_size = 5000
  metric_buffer_limit = 50000
  collection_jitter = "5s"
  flush_interval = "30s"
  flush_jitter = "5s"
  precision = ""
  hostname = ""
  omit_hostname = false
  debug = false
  quiet = false

# Logging configuration for enterprise environments
  logfile = "/var/log/telegraf/telegraf.log"
  logfile_rotation_interval = "24h"
  logfile_rotation_max_size = "100MB"
  logfile_rotation_max_archives = 30

# Performance optimizations
  logtarget = "file"
  log_with_timezone = "UTC"
```

### Multi-Output Configuration for Enterprise Observability

```toml
# Primary time-series database output
[[outputs.influxdb_v2]]
  urls = ["https://influxdb.company.com:8086"]
  token = "$INFLUX_TOKEN"
  organization = "enterprise-infrastructure"
  bucket = "system-metrics"
  timeout = "30s"
  user_agent = "telegraf-enterprise"

  # Connection optimization
  content_encoding = "gzip"
  compression_level = 6

  # Retry configuration
  max_retries = 5
  retry_interval = "10s"

  # TLS configuration for enterprise security
  tls_ca = "/etc/telegraf/certs/ca.pem"
  tls_cert = "/etc/telegraf/certs/telegraf.pem"
  tls_key = "/etc/telegraf/certs/telegraf-key.pem"

# Victoria Metrics output for high-performance scenarios
[[outputs.prometheus_client]]
  listen = ":9273"
  metric_version = 2
  collectors_exclude = ["gocollector", "process"]

  # Enterprise security
  tls_cert = "/etc/telegraf/certs/server.pem"
  tls_key = "/etc/telegraf/certs/server-key.pem"
  tls_allowed_cacerts = ["/etc/telegraf/certs/ca.pem"]

# CloudWatch for AWS environments
[[outputs.cloudwatch]]
  region = "us-east-1"
  namespace = "Enterprise/Infrastructure"
  access_key = "$AWS_ACCESS_KEY_ID"
  secret_key = "$AWS_SECRET_ACCESS_KEY"

  # Cost optimization
  high_resolution_metrics = false

  # Tagging strategy
  [outputs.cloudwatch.tagexclude]
    host = true
```

## Advanced Hardware Sensor Monitoring

### Comprehensive Temperature Monitoring

```toml
# Hardware sensors input plugin
[[inputs.sensors]]
  # Remove numbers from field names
  remove_numbers = false

  # Timeout for sensor readings
  timeout = "5s"

  # Additional sensor paths for enterprise hardware
  sensor_paths = [
    "/sys/class/thermal/thermal_zone*/temp",
    "/sys/class/hwmon/hwmon*/temp*_input",
    "/sys/devices/platform/coretemp.*/hwmon/hwmon*/temp*_input",
    "/sys/devices/pci*/*/*/hwmon/hwmon*/temp*_input"
  ]

# Custom sensor monitoring for enterprise hardware
[[inputs.file]]
  files = ["/sys/class/thermal/thermal_zone*/temp"]
  name_override = "cpu_thermal_zones"
  data_format = "value"
  data_type = "integer"

  # Transform raw temperature values (millicelsius to celsius)
  [[inputs.file.processors.converter]]
    [inputs.file.processors.converter.fields]
      integer = ["*"]

  [[inputs.file.processors.regex]]
    [[inputs.file.processors.regex.tags]]
      key = "thermal_zone"
      pattern = "/thermal_zone([0-9]+)/"
      replacement = "zone_${1}"

# Advanced CPU temperature monitoring
[[inputs.exec]]
  commands = ["python3 /usr/local/bin/cpu_temp_monitor.py"]
  name_override = "cpu_detailed_temp"
  data_format = "json"
  timeout = "10s"
  interval = "30s"

# NVMe device temperature monitoring
[[inputs.smart]]
  use_sudo = true
  path_smartctl = "/usr/sbin/smartctl"

  # Monitor all NVMe devices
  devices = ["/dev/nvme*"]

  # Attributes to monitor
  attributes = true
  excludes = ["rotational"]

  # Collection interval
  interval = "60s"

  # Timeout configuration
  timeout = "30s"
```

### Enterprise Network Interface Monitoring

```toml
# Comprehensive network monitoring
[[inputs.net]]
  # Monitor all interfaces
  interfaces = ["*"]

  # Ignore virtual interfaces in containers
  ignore_protocol_stats = false

  # Include interface statistics
  fielddrop = ["icmp*", "udplite*"]

# Advanced network statistics
[[inputs.netstat]]
  # Collect connection statistics
  # No configuration needed - collects all by default

# Network latency monitoring
[[inputs.ping]]
  urls = [
    "8.8.8.8",
    "1.1.1.1",
    "internal-gateway.company.com",
    "primary-dns.company.com"
  ]
  count = 4
  ping_interval = 1.0
  timeout = 3.0
  deadline = 10
  interface = ""

# Bandwidth monitoring
[[inputs.exec]]
  commands = ["/usr/local/bin/bandwidth_monitor.sh"]
  name_override = "bandwidth_usage"
  data_format = "influx"
  timeout = "30s"
  interval = "60s"
```

### Storage and Filesystem Monitoring

```toml
# Disk usage monitoring
[[inputs.disk]]
  # Mount points to monitor
  mount_points = ["/", "/var", "/tmp", "/opt", "/home"]

  # Ignore temporary filesystems
  ignore_fs = ["tmpfs", "devtmpfs", "devfs", "iso9660", "overlay", "aufs", "squashfs"]

# I/O statistics
[[inputs.diskio]]
  # Monitor all devices
  devices = ["sd*", "vd*", "nvme*"]

  # Skip virtual devices
  skip_serial_number = false
  device_tags = ["ID_FS_TYPE", "ID_FS_USAGE", "ID_VENDOR"]

# Advanced filesystem monitoring
[[inputs.filestat]]
  files = [
    "/var/log/telegraf/*.log",
    "/var/log/system.log",
    "/etc/telegraf/telegraf.conf"
  ]

  # File metadata to collect
  md5 = false
  size = true
```

## Enterprise Process and Service Monitoring

### Comprehensive Process Monitoring

```toml
# System process monitoring
[[inputs.procstat]]
  # Monitor critical services by name
  pattern = "^(systemd|dockerd|kubelet|containerd)$"

  # Process metrics to collect
  pid_finder = "pgrep"

  # Additional process information
  pid_tag = true
  cmdline_tag = true

  # Resource utilization
  process_name = "proc_name"

# Database process monitoring
[[inputs.procstat]]
  pattern = "^(postgres|mysql|mongod|redis-server)$"
  pid_finder = "pgrep"

  # Database-specific tagging
  [inputs.procstat.tags]
    service_type = "database"

# Web service monitoring
[[inputs.procstat]]
  pattern = "^(nginx|apache2|httpd)$"
  pid_finder = "pgrep"

  [inputs.procstat.tags]
    service_type = "webserver"

# Container runtime monitoring
[[inputs.docker]]
  endpoint = "unix:///var/run/docker.sock"

  # Container metrics
  gather_services = false
  container_names = []
  container_name_include = []
  container_name_exclude = []

  # Performance optimization
  timeout = "5s"
  perdevice = true
  binary_units = false
```

### Kubernetes Node Monitoring

```toml
# Kubernetes node metrics
[[inputs.kubernetes]]
  url = "https://localhost:10250"
  bearer_token_string = "$KUBELET_TOKEN"
  insecure_skip_verify = true

  # Metric collection
  gather_summary_stats = true
  gather_cpu_stats = true
  gather_mem_stats = true
  gather_node_stats = true
  gather_pod_container_stats = true
  gather_pod_volume_stats = true

# kubelet health monitoring
[[inputs.http_response]]
  urls = ["https://localhost:10250/healthz"]
  bearer_token_string = "$KUBELET_TOKEN"
  insecure_skip_verify = true

  response_timeout = "5s"
  method = "GET"

  [inputs.http_response.tags]
    service = "kubelet"
    health_check = "true"
```

## Production Deployment and Configuration Management

### Systemd Service Configuration

```ini
# /etc/systemd/system/telegraf.service
[Unit]
Description=Telegraf
Documentation=https://docs.influxdata.com/telegraf/
Wants=network-online.target
After=network-online.target
AssertFileIsExecutable=/usr/bin/telegraf

[Service]
Type=notify
User=telegraf
Group=telegraf
ExecStart=/usr/bin/telegraf -config /etc/telegraf/telegraf.conf -config-directory /etc/telegraf/telegraf.d
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartForceExitStatus=SIGPIPE
KillMode=control-group

# Security hardening
NoNewPrivileges=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/log/telegraf
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes

# Resource limits
LimitNOFILE=65536
LimitNPROC=65536

# Environment
Environment="TELEGRAF_CONFIG_PATH=/etc/telegraf/telegraf.conf"
EnvironmentFile=-/etc/default/telegraf

[Install]
WantedBy=multi-user.target
```

### Container Deployment Configuration

```yaml
# Telegraf DaemonSet for Kubernetes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: telegraf
  namespace: monitoring-system
  labels:
    app: telegraf
spec:
  selector:
    matchLabels:
      app: telegraf
  template:
    metadata:
      labels:
        app: telegraf
    spec:
      serviceAccountName: telegraf
      hostNetwork: true
      hostPID: true

      # Security context
      securityContext:
        runAsUser: 0
        runAsGroup: 0
        fsGroup: 0

      containers:
      - name: telegraf
        image: telegraf:1.28-alpine

        # Resource allocation
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi

        # Environment configuration
        env:
        - name: HOST_PROC
          value: "/hostfs/proc"
        - name: HOST_SYS
          value: "/hostfs/sys"
        - name: HOST_MOUNT_PREFIX
          value: "/hostfs"
        - name: INFLUX_TOKEN
          valueFrom:
            secretKeyRef:
              name: telegraf-secrets
              key: influx-token

        # Volume mounts for host monitoring
        volumeMounts:
        - name: config
          mountPath: /etc/telegraf/telegraf.conf
          subPath: telegraf.conf
          readOnly: true
        - name: proc
          mountPath: /hostfs/proc
          readOnly: true
        - name: sys
          mountPath: /hostfs/sys
          readOnly: true
        - name: var-run
          mountPath: /var/run/docker.sock
          readOnly: true
        - name: logs
          mountPath: /var/log/telegraf

        # Health checks
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - ps aux | grep telegraf | grep -v grep
          initialDelaySeconds: 30
          periodSeconds: 30

        readinessProbe:
          httpGet:
            path: /metrics
            port: 9273
          initialDelaySeconds: 10
          periodSeconds: 10

      volumes:
      - name: config
        configMap:
          name: telegraf-config
      - name: proc
        hostPath:
          path: /proc
      - name: sys
        hostPath:
          path: /sys
      - name: var-run
        hostPath:
          path: /var/run/docker.sock
      - name: logs
        hostPath:
          path: /var/log/telegraf
          type: DirectoryOrCreate

      # Node selection and tolerations
      nodeSelector:
        kubernetes.io/os: linux

      tolerations:
      - effect: NoSchedule
        operator: Exists
      - effect: NoExecute
        operator: Exists
```

## Advanced Configuration Patterns

### Multi-Environment Configuration Management

```bash
#!/bin/bash
# Enterprise configuration management script

set -euo pipefail

ENVIRONMENT="${1:-production}"
CONFIG_DIR="/etc/telegraf"
TEMPLATE_DIR="/opt/telegraf/templates"

# Environment-specific variables
case "$ENVIRONMENT" in
    "production")
        INFLUX_URL="https://influxdb-prod.company.com:8086"
        METRICS_INTERVAL="30s"
        LOG_LEVEL="warn"
        ;;
    "staging")
        INFLUX_URL="https://influxdb-staging.company.com:8086"
        METRICS_INTERVAL="60s"
        LOG_LEVEL="info"
        ;;
    "development")
        INFLUX_URL="http://influxdb-dev.company.com:8086"
        METRICS_INTERVAL="60s"
        LOG_LEVEL="debug"
        ;;
esac

# Generate configuration from template
envsubst < "$TEMPLATE_DIR/telegraf.conf.template" > "$CONFIG_DIR/telegraf.conf"

# Validate configuration
telegraf --config "$CONFIG_DIR/telegraf.conf" --test

# Reload service
systemctl reload telegraf

echo "Telegraf configuration updated for $ENVIRONMENT environment"
```

### Custom Plugin Development

```python
#!/usr/bin/env python3
"""
Custom CPU temperature monitoring plugin for enterprise hardware
"""

import json
import subprocess
import sys
from typing import Dict, List, Any

class CPUTempMonitor:
    def __init__(self):
        self.sensor_paths = [
            "/sys/class/thermal/thermal_zone*/temp",
            "/sys/class/hwmon/hwmon*/temp*_input"
        ]

    def get_cpu_temperatures(self) -> Dict[str, Any]:
        """Collect CPU temperature data from multiple sources"""
        temperatures = {}

        try:
            # Core temperatures
            result = subprocess.run(
                ["sensors", "-A", "-j"],
                capture_output=True,
                text=True,
                timeout=10
            )

            if result.returncode == 0:
                sensor_data = json.loads(result.stdout)
                temperatures.update(self._parse_sensors_output(sensor_data))

            # Thermal zone temperatures
            thermal_zones = self._get_thermal_zones()
            temperatures.update(thermal_zones)

            # PCH temperatures
            pch_temp = self._get_pch_temperature()
            if pch_temp:
                temperatures.update(pch_temp)

        except Exception as e:
            print(f"Error collecting temperature data: {e}", file=sys.stderr)
            return {}

        return temperatures

    def _parse_sensors_output(self, sensor_data: Dict) -> Dict[str, float]:
        """Parse lm-sensors JSON output"""
        temps = {}

        for chip_name, chip_data in sensor_data.items():
            if isinstance(chip_data, dict):
                for sensor_name, sensor_info in chip_data.items():
                    if isinstance(sensor_info, dict) and 'temp' in sensor_name.lower():
                        if f"{sensor_name}_input" in sensor_info:
                            temp_value = sensor_info[f"{sensor_name}_input"]
                            temps[f"cpu_{chip_name}_{sensor_name}"] = temp_value

                            # Include critical and max values if available
                            if f"{sensor_name}_crit" in sensor_info:
                                temps[f"cpu_{chip_name}_{sensor_name}_critical"] = \
                                    sensor_info[f"{sensor_name}_crit"]

                            if f"{sensor_name}_max" in sensor_info:
                                temps[f"cpu_{chip_name}_{sensor_name}_max"] = \
                                    sensor_info[f"{sensor_name}_max"]

        return temps

    def _get_thermal_zones(self) -> Dict[str, float]:
        """Read thermal zone temperatures directly"""
        temps = {}

        try:
            result = subprocess.run(
                ["find", "/sys/class/thermal", "-name", "temp", "-type", "f"],
                capture_output=True,
                text=True
            )

            for temp_file in result.stdout.strip().split('\n'):
                if temp_file:
                    try:
                        with open(temp_file, 'r') as f:
                            temp_millic = int(f.read().strip())
                            temp_celsius = temp_millic / 1000.0

                            zone_name = temp_file.split('/')[-2]
                            temps[f"thermal_zone_{zone_name}"] = temp_celsius
                    except (IOError, ValueError) as e:
                        continue

        except subprocess.SubprocessError:
            pass

        return temps

    def _get_pch_temperature(self) -> Dict[str, float]:
        """Get Platform Controller Hub temperature"""
        temps = {}

        try:
            result = subprocess.run(
                ["find", "/sys/devices", "-name", "*pch*", "-path", "*/hwmon/*/temp*_input"],
                capture_output=True,
                text=True
            )

            for temp_file in result.stdout.strip().split('\n'):
                if temp_file:
                    try:
                        with open(temp_file, 'r') as f:
                            temp_millic = int(f.read().strip())
                            temp_celsius = temp_millic / 1000.0
                            temps["pch_temperature"] = temp_celsius
                    except (IOError, ValueError):
                        continue

        except subprocess.SubprocessError:
            pass

        return temps

    def output_metrics(self):
        """Output metrics in InfluxDB line protocol format"""
        temperatures = self.get_cpu_temperatures()

        if not temperatures:
            return

        timestamp = int(subprocess.run(["date", "+%s"], capture_output=True, text=True).stdout.strip()) * 1000000000

        for sensor_name, temp_value in temperatures.items():
            print(f"cpu_temperature,sensor={sensor_name} value={temp_value} {timestamp}")

if __name__ == "__main__":
    monitor = CPUTempMonitor()
    monitor.output_metrics()
```

## Enterprise Alerting and Notification Strategies

### Comprehensive Alerting Rules

```toml
# Critical system alerts
[[outputs.exec]]
  commands = ["/usr/local/bin/alert_manager.py"]
  data_format = "json"

  # Only send critical metrics to alerting system
  namepass = ["cpu_usage", "memory_usage", "disk_usage", "cpu_temperature"]

  # Alert thresholds via tagpass
  [outputs.exec.tagpass]
    alert_level = ["critical", "warning"]

# Custom alerting processor
[[processors.threshold]]
  # CPU temperature alerts
  [[processors.threshold.threshold]]
    field = "cpu_temperature"
    min = 0.0
    max = 85.0

    # Add alert tags based on thresholds
    [processors.threshold.threshold.tags]
      alert_level = "warning"
      severity = "medium"

  [[processors.threshold.threshold]]
    field = "cpu_temperature"
    min = 0.0
    max = 95.0

    [processors.threshold.threshold.tags]
      alert_level = "critical"
      severity = "high"

# Memory usage alerting
  [[processors.threshold.threshold]]
    field = "memory_usage_percent"
    min = 0.0
    max = 85.0

    [processors.threshold.threshold.tags]
      alert_level = "warning"
      component = "memory"

  [[processors.threshold.threshold]]
    field = "memory_usage_percent"
    min = 0.0
    max = 95.0

    [processors.threshold.threshold.tags]
      alert_level = "critical"
      component = "memory"
```

### Alert Management Script

```python
#!/usr/bin/env python3
"""
Enterprise alert management system for Telegraf metrics
"""

import json
import sys
import requests
import smtplib
from datetime import datetime
from typing import Dict, List, Any
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

class AlertManager:
    def __init__(self, config_path: str = "/etc/telegraf/alert_config.json"):
        with open(config_path, 'r') as f:
            self.config = json.load(f)

        self.smtp_server = self.config['smtp']['server']
        self.smtp_port = self.config['smtp']['port']
        self.smtp_user = self.config['smtp']['username']
        self.smtp_pass = self.config['smtp']['password']

        self.slack_webhook = self.config.get('slack', {}).get('webhook_url')
        self.pagerduty_key = self.config.get('pagerduty', {}).get('integration_key')

    def process_metrics(self, metrics_data: str):
        """Process incoming metrics and trigger alerts"""
        try:
            metrics = json.loads(metrics_data)
        except json.JSONDecodeError:
            return

        for metric in metrics:
            if self._should_alert(metric):
                self._trigger_alert(metric)

    def _should_alert(self, metric: Dict) -> bool:
        """Determine if metric should trigger an alert"""
        tags = metric.get('tags', {})
        alert_level = tags.get('alert_level')

        if not alert_level:
            return False

        # Check if this alert has already been sent recently
        alert_key = f"{metric['name']}_{tags.get('host', 'unknown')}_{alert_level}"

        # Implement rate limiting logic here
        return True

    def _trigger_alert(self, metric: Dict):
        """Trigger alert through multiple channels"""
        alert_data = self._format_alert(metric)

        # Send email alert
        if self.config.get('email', {}).get('enabled', False):
            self._send_email_alert(alert_data)

        # Send Slack alert
        if self.config.get('slack', {}).get('enabled', False):
            self._send_slack_alert(alert_data)

        # Send PagerDuty alert for critical issues
        if (alert_data['severity'] == 'critical' and
            self.config.get('pagerduty', {}).get('enabled', False)):
            self._send_pagerduty_alert(alert_data)

    def _format_alert(self, metric: Dict) -> Dict:
        """Format metric data into alert structure"""
        tags = metric.get('tags', {})
        fields = metric.get('fields', {})

        return {
            'timestamp': datetime.now().isoformat(),
            'hostname': tags.get('host', 'unknown'),
            'metric_name': metric['name'],
            'severity': tags.get('alert_level', 'unknown'),
            'value': list(fields.values())[0] if fields else None,
            'message': self._generate_alert_message(metric),
            'tags': tags
        }

    def _generate_alert_message(self, metric: Dict) -> str:
        """Generate human-readable alert message"""
        tags = metric.get('tags', {})
        fields = metric.get('fields', {})

        hostname = tags.get('host', 'unknown')
        metric_name = metric['name']
        severity = tags.get('alert_level', 'unknown').upper()

        if fields:
            value = list(fields.values())[0]
            return f"{severity}: {metric_name} on {hostname} is {value}"
        else:
            return f"{severity}: {metric_name} alert on {hostname}"

    def _send_email_alert(self, alert_data: Dict):
        """Send email alert"""
        try:
            msg = MIMEMultipart()
            msg['From'] = self.smtp_user
            msg['To'] = ', '.join(self.config['email']['recipients'])
            msg['Subject'] = f"Infrastructure Alert: {alert_data['severity'].upper()} - {alert_data['hostname']}"

            body = f"""
            Alert Details:
            - Timestamp: {alert_data['timestamp']}
            - Hostname: {alert_data['hostname']}
            - Metric: {alert_data['metric_name']}
            - Severity: {alert_data['severity']}
            - Value: {alert_data['value']}
            - Message: {alert_data['message']}

            Tags: {json.dumps(alert_data['tags'], indent=2)}
            """

            msg.attach(MIMEText(body, 'plain'))

            server = smtplib.SMTP(self.smtp_server, self.smtp_port)
            server.starttls()
            server.login(self.smtp_user, self.smtp_pass)
            server.sendmail(self.smtp_user, self.config['email']['recipients'], msg.as_string())
            server.quit()

        except Exception as e:
            print(f"Failed to send email alert: {e}", file=sys.stderr)

    def _send_slack_alert(self, alert_data: Dict):
        """Send Slack alert"""
        if not self.slack_webhook:
            return

        color_map = {
            'critical': '#FF0000',
            'warning': '#FFA500',
            'info': '#0080FF'
        }

        payload = {
            'attachments': [{
                'color': color_map.get(alert_data['severity'], '#808080'),
                'title': f"Infrastructure Alert - {alert_data['hostname']}",
                'fields': [
                    {'title': 'Metric', 'value': alert_data['metric_name'], 'short': True},
                    {'title': 'Severity', 'value': alert_data['severity'].upper(), 'short': True},
                    {'title': 'Value', 'value': str(alert_data['value']), 'short': True},
                    {'title': 'Timestamp', 'value': alert_data['timestamp'], 'short': True}
                ],
                'text': alert_data['message']
            }]
        }

        try:
            response = requests.post(self.slack_webhook, json=payload, timeout=10)
            response.raise_for_status()
        except requests.RequestException as e:
            print(f"Failed to send Slack alert: {e}", file=sys.stderr)

if __name__ == "__main__":
    alert_manager = AlertManager()

    # Read metrics from stdin
    metrics_data = sys.stdin.read()
    alert_manager.process_metrics(metrics_data)
```

## Performance Optimization and Troubleshooting

### Memory and CPU Optimization

```toml
# Performance-optimized Telegraf configuration
[agent]
  # Optimize for high-throughput environments
  interval = "30s"
  round_interval = true
  metric_batch_size = 10000      # Increased batch size
  metric_buffer_limit = 100000   # Larger buffer
  collection_jitter = "2s"       # Reduced jitter
  flush_interval = "30s"
  flush_jitter = "2s"

  # Memory optimization
  precision = ""
  debug = false
  quiet = true

  # Connection pooling
  hostname_suffix = ""
  omit_hostname = false

# Output optimization
[[outputs.influxdb_v2]]
  urls = ["https://influxdb.company.com:8086"]
  token = "$INFLUX_TOKEN"
  organization = "enterprise"
  bucket = "metrics"

  # Optimize write performance
  timeout = "10s"
  content_encoding = "gzip"
  compression_level = 6

  # Connection pooling
  max_retries = 3
  retry_interval = "5s"

  # Batch optimization
  write_consistency = "any"
  write_timeout = "10s"
```

### Monitoring Script Performance

```bash
#!/bin/bash
# Telegraf performance monitoring script

set -euo pipefail

LOG_FILE="/var/log/telegraf/performance.log"
TELEGRAF_PID=$(pgrep telegraf)

if [[ -z "$TELEGRAF_PID" ]]; then
    echo "$(date): Telegraf process not found" >> "$LOG_FILE"
    exit 1
fi

# Monitor memory usage
MEMORY_USAGE=$(ps -p "$TELEGRAF_PID" -o rss= | tr -d ' ')
MEMORY_MB=$((MEMORY_USAGE / 1024))

# Monitor CPU usage
CPU_USAGE=$(ps -p "$TELEGRAF_PID" -o pcpu= | tr -d ' ')

# Monitor file descriptors
FD_COUNT=$(ls -1 "/proc/$TELEGRAF_PID/fd" | wc -l)

# Monitor network connections
CONNECTIONS=$(netstat -an | grep -E ":(8086|9273|443)" | wc -l)

# Log performance metrics
echo "$(date): Memory=${MEMORY_MB}MB CPU=${CPU_USAGE}% FD=${FD_COUNT} Connections=${CONNECTIONS}" >> "$LOG_FILE"

# Alert on high resource usage
if [[ $MEMORY_MB -gt 1024 ]]; then
    echo "$(date): WARNING: High memory usage: ${MEMORY_MB}MB" >> "$LOG_FILE"
fi

if [[ $(echo "$CPU_USAGE > 50" | bc -l) -eq 1 ]]; then
    echo "$(date): WARNING: High CPU usage: ${CPU_USAGE}%" >> "$LOG_FILE"
fi

if [[ $FD_COUNT -gt 1000 ]]; then
    echo "$(date): WARNING: High file descriptor count: $FD_COUNT" >> "$LOG_FILE"
fi
```

## Conclusion

Telegraf's comprehensive plugin ecosystem and enterprise-ready architecture make it the optimal choice for large-scale infrastructure monitoring. The configurations and patterns presented in this guide enable organizations to deploy robust, scalable telemetry collection systems capable of monitoring diverse hardware environments with advanced alerting and performance optimization.

Key success factors include proper resource allocation, strategic plugin selection, comprehensive alerting strategies, and proactive performance monitoring. Organizations implementing these patterns can expect significant improvements in infrastructure visibility, faster incident response times, and enhanced operational reliability.

The combination of hardware sensor monitoring, custom plugin development, and enterprise-grade alerting provides a solid foundation for maintaining operational excellence in modern infrastructure environments.