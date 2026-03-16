---
title: "SNMP Node Exporter Setup for Infrastructure Monitoring: Complete Enterprise Guide with Prometheus Integration"
date: 2026-11-23T00:00:00-05:00
draft: false
tags: ["SNMP", "Prometheus", "Monitoring", "Infrastructure", "Observability", "Enterprise", "Kubernetes"]
categories: ["Monitoring", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive enterprise guide for deploying SNMP exporters in Kubernetes environments with Prometheus integration, advanced authentication, and production-ready monitoring strategies."
more_link: "yes"
url: "/snmp-node-exporter-infrastructure-monitoring-enterprise-guide/"
---

SNMP (Simple Network Management Protocol) remains a cornerstone technology for monitoring enterprise network infrastructure, storage systems, and IoT devices that lack modern observability capabilities. Integrating SNMP-enabled devices into modern Prometheus-based monitoring stacks requires sophisticated exporters, robust authentication mechanisms, and enterprise-grade deployment patterns.

This comprehensive guide provides production-ready solutions for deploying SNMP exporters in Kubernetes environments, implementing secure SNMPv3 authentication, managing complex MIB configurations, and establishing scalable monitoring architectures for heterogeneous infrastructure environments.

<!--more-->

# Understanding SNMP in Modern Infrastructure

SNMP serves as the primary management protocol for network devices, storage systems, and embedded systems that predate modern metrics APIs. While cloud-native applications embrace pull-based metrics collection, legacy infrastructure requires SNMP exporters to bridge this gap.

## SNMP Version Comparison and Security Considerations

```bash
# SNMPv1/v2c: Community-based authentication (insecure)
snmpget -v2c -c public 192.168.1.100 1.3.6.1.2.1.1.1.0

# SNMPv3: Comprehensive security framework
snmpget -v3 -u snmpuser \
        -l authPriv \
        -a MD5 -A "authpassword" \
        -x DES -X "privpassword" \
        192.168.1.100 1.3.6.1.2.1.1.1.0
```

### Security Level Comparison

| Version | Authentication | Encryption | Enterprise Suitability |
|---------|----------------|------------|----------------------|
| SNMPv1  | Community strings | None | ❌ Deprecated |
| SNMPv2c | Community strings | None | ⚠️ Internal only |
| SNMPv3  | Username/password | AES/DES | ✅ Production ready |

# SNMP Exporter Architecture and Deployment

## Kubernetes-Native SNMP Exporter Deployment

Deploy the SNMP exporter with enterprise-grade configuration management:

```yaml
# snmp-exporter-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring-system
  labels:
    name: monitoring-system
    purpose: infrastructure-monitoring
---
# snmp-exporter-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: snmp-exporter-config
  namespace: monitoring-system
data:
  snmp.yml: |
    # Global SNMP configuration
    auths:
      # Production SNMPv3 configuration
      snmpv3_auth_priv:
        security_level: authPriv
        username: monitoring-user
        password: "SecureAuthPassword123!"
        auth_protocol: SHA
        priv_protocol: AES
        priv_password: "SecurePrivPassword456!"
        version: 3

      # Development SNMPv2c configuration (internal only)
      snmpv2c_internal:
        community: monitoring-community
        security_level: noAuthNoPriv
        version: 2

    modules:
      # Standard interface monitoring
      if_mib:
        walk:
          - 1.3.6.1.2.1.2.2.1.2    # ifDescr
          - 1.3.6.1.2.1.2.2.1.3    # ifType
          - 1.3.6.1.2.1.2.2.1.5    # ifSpeed
          - 1.3.6.1.2.1.2.2.1.7    # ifAdminStatus
          - 1.3.6.1.2.1.2.2.1.8    # ifOperStatus
          - 1.3.6.1.2.1.2.2.1.10   # ifInOctets
          - 1.3.6.1.2.1.2.2.1.16   # ifOutOctets
          - 1.3.6.1.2.1.2.2.1.13   # ifInDiscards
          - 1.3.6.1.2.1.2.2.1.14   # ifInErrors
          - 1.3.6.1.2.1.2.2.1.19   # ifOutDiscards
          - 1.3.6.1.2.1.2.2.1.20   # ifOutErrors
        lookups:
          - source_indexes: [ifIndex]
            lookup: 1.3.6.1.2.1.2.2.1.2  # ifDescr
            drop_source_indexes: false
        overrides:
          ifType:
            type: EnumAsInfo
          ifAdminStatus:
            type: EnumAsStateSet
          ifOperStatus:
            type: EnumAsStateSet

      # System information module
      system_info:
        walk:
          - 1.3.6.1.2.1.1.1.0    # sysDescr
          - 1.3.6.1.2.1.1.2.0    # sysObjectID
          - 1.3.6.1.2.1.1.3.0    # sysUpTime
          - 1.3.6.1.2.1.1.4.0    # sysContact
          - 1.3.6.1.2.1.1.5.0    # sysName
          - 1.3.6.1.2.1.1.6.0    # sysLocation

      # Storage monitoring for NAS/SAN devices
      storage_monitoring:
        walk:
          - 1.3.6.1.2.1.25.2.1.1   # hrStorageIndex
          - 1.3.6.1.2.1.25.2.1.2   # hrStorageType
          - 1.3.6.1.2.1.25.2.1.3   # hrStorageDescr
          - 1.3.6.1.2.1.25.2.1.4   # hrStorageAllocationUnits
          - 1.3.6.1.2.1.25.2.1.5   # hrStorageSize
          - 1.3.6.1.2.1.25.2.1.6   # hrStorageUsed
        lookups:
          - source_indexes: [hrStorageIndex]
            lookup: 1.3.6.1.2.1.25.2.1.3  # hrStorageDescr
        overrides:
          hrStorageAllocationUnits:
            type: gauge
          hrStorageSize:
            type: gauge
          hrStorageUsed:
            type: gauge

      # Synology NAS specific monitoring
      synology_nas:
        walk:
          - 1.3.6.1.4.1.6574.1.1      # Synology system
          - 1.3.6.1.4.1.6574.2.1      # Synology disk
          - 1.3.6.1.4.1.6574.3.1      # Synology RAID
          - 1.3.6.1.4.1.6574.4.1      # Synology UPS
          - 1.3.6.1.4.1.6574.5.1      # Synology system fan
          - 1.3.6.1.4.1.6574.6.1      # Synology temperature
        auth: snmpv3_auth_priv

      # Cisco device monitoring
      cisco_device:
        walk:
          - 1.3.6.1.4.1.9.2.1         # Cisco local variables
          - 1.3.6.1.4.1.9.9.109.1.1   # Cisco CPU usage
          - 1.3.6.1.4.1.9.9.48.1.1    # Cisco memory pool
        auth: snmpv3_auth_priv
---
# snmp-exporter-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: snmp-credentials
  namespace: monitoring-system
type: Opaque
stringData:
  snmpv3-username: monitoring-user
  snmpv3-auth-password: SecureAuthPassword123!
  snmpv3-priv-password: SecurePrivPassword456!
  snmpv2c-community: monitoring-community
---
# snmp-exporter-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: snmp-exporter
  namespace: monitoring-system
  labels:
    app: snmp-exporter
    component: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: snmp-exporter
  template:
    metadata:
      labels:
        app: snmp-exporter
        component: monitoring
    spec:
      serviceAccountName: snmp-exporter
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
      containers:
      - name: snmp-exporter
        image: prom/snmp-exporter:v0.25.0
        ports:
        - containerPort: 9116
          name: http-metrics
          protocol: TCP
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /health
            port: http-metrics
          initialDelaySeconds: 30
          timeoutSeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: http-metrics
          initialDelaySeconds: 5
          timeoutSeconds: 5
          periodSeconds: 10
        env:
        - name: SNMPV3_USERNAME
          valueFrom:
            secretKeyRef:
              name: snmp-credentials
              key: snmpv3-username
        - name: SNMPV3_AUTH_PASSWORD
          valueFrom:
            secretKeyRef:
              name: snmp-credentials
              key: snmpv3-auth-password
        - name: SNMPV3_PRIV_PASSWORD
          valueFrom:
            secretKeyRef:
              name: snmp-credentials
              key: snmpv3-priv-password
        volumeMounts:
        - name: config-volume
          mountPath: /etc/snmp_exporter
          readOnly: true
        args:
        - --config.file=/etc/snmp_exporter/snmp.yml
        - --log.level=info
        - --web.listen-address=0.0.0.0:9116
      volumes:
      - name: config-volume
        configMap:
          name: snmp-exporter-config
          items:
          - key: snmp.yml
            path: snmp.yml
---
# snmp-exporter-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: snmp-exporter
  namespace: monitoring-system
  labels:
    app: snmp-exporter
    component: monitoring
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9116"
    prometheus.io/path: "/metrics"
spec:
  type: ClusterIP
  ports:
  - port: 9116
    targetPort: http-metrics
    protocol: TCP
    name: http-metrics
  selector:
    app: snmp-exporter
---
# snmp-exporter-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: snmp-exporter
  namespace: monitoring-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: snmp-exporter
rules:
- apiGroups: [""]
  resources: ["nodes", "services", "endpoints", "pods"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: snmp-exporter
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: snmp-exporter
subjects:
- kind: ServiceAccount
  name: snmp-exporter
  namespace: monitoring-system
```

# Advanced SNMP Configuration Management

## Multi-Device Configuration Generator

Generate device-specific SNMP configurations dynamically:

```python
#!/usr/bin/env python3
# snmp-config-generator.py
import yaml
import argparse
from typing import Dict, List, Any

class SNMPConfigGenerator:
    def __init__(self):
        self.base_config = {
            'auths': {},
            'modules': {}
        }

    def add_snmpv3_auth(self, name: str, username: str, auth_password: str,
                       priv_password: str, auth_protocol: str = 'SHA',
                       priv_protocol: str = 'AES') -> None:
        """Add SNMPv3 authentication configuration"""
        self.base_config['auths'][name] = {
            'security_level': 'authPriv',
            'username': username,
            'password': auth_password,
            'auth_protocol': auth_protocol,
            'priv_protocol': priv_protocol,
            'priv_password': priv_password,
            'version': 3
        }

    def add_device_module(self, module_name: str, device_type: str,
                         custom_oids: List[str] = None) -> None:
        """Add device-specific monitoring module"""

        # Standard OID collections by device type
        device_oids = {
            'router': [
                '1.3.6.1.2.1.2.2.1.2',    # ifDescr
                '1.3.6.1.2.1.2.2.1.8',    # ifOperStatus
                '1.3.6.1.2.1.2.2.1.10',   # ifInOctets
                '1.3.6.1.2.1.2.2.1.16',   # ifOutOctets
                '1.3.6.1.4.1.9.9.109.1.1' # Cisco CPU (if applicable)
            ],
            'switch': [
                '1.3.6.1.2.1.2.2.1.2',    # ifDescr
                '1.3.6.1.2.1.2.2.1.8',    # ifOperStatus
                '1.3.6.1.2.1.2.2.1.10',   # ifInOctets
                '1.3.6.1.2.1.2.2.1.16',   # ifOutOctets
                '1.3.6.1.2.1.17.1.4',     # dot1dTpLearnedEntryDiscards
            ],
            'storage': [
                '1.3.6.1.2.1.25.2.1.3',   # hrStorageDescr
                '1.3.6.1.2.1.25.2.1.5',   # hrStorageSize
                '1.3.6.1.2.1.25.2.1.6',   # hrStorageUsed
                '1.3.6.1.4.1.6574.1.1',   # Synology system (if applicable)
            ],
            'ups': [
                '1.3.6.1.2.1.33.1.1.1',   # upsIdentManufacturer
                '1.3.6.1.2.1.33.1.2.1',   # upsBatteryStatus
                '1.3.6.1.2.1.33.1.2.2',   # upsSecondsOnBattery
                '1.3.6.1.2.1.33.1.4.4.1', # upsOutputVoltage
            ]
        }

        oids = device_oids.get(device_type, [])
        if custom_oids:
            oids.extend(custom_oids)

        self.base_config['modules'][module_name] = {
            'walk': oids,
            'lookups': [
                {
                    'source_indexes': ['ifIndex'],
                    'lookup': '1.3.6.1.2.1.2.2.1.2'  # ifDescr
                }
            ] if 'ifDescr' in str(oids) else []
        }

    def generate_kubernetes_configmap(self, name: str = 'snmp-exporter-config',
                                    namespace: str = 'monitoring-system') -> str:
        """Generate Kubernetes ConfigMap YAML"""
        configmap = {
            'apiVersion': 'v1',
            'kind': 'ConfigMap',
            'metadata': {
                'name': name,
                'namespace': namespace
            },
            'data': {
                'snmp.yml': yaml.dump(self.base_config, default_flow_style=False)
            }
        }

        return yaml.dump(configmap, default_flow_style=False)

# Example usage
def main():
    generator = SNMPConfigGenerator()

    # Add authentication profiles
    generator.add_snmpv3_auth('prod_network', 'netmon', 'SecureAuth123!', 'SecurePriv456!')
    generator.add_snmpv3_auth('storage_auth', 'storage_user', 'StorageAuth789!', 'StoragePriv012!')

    # Add device modules
    generator.add_device_module('cisco_routers', 'router')
    generator.add_device_module('storage_arrays', 'storage')
    generator.add_device_module('datacenter_ups', 'ups')

    # Generate ConfigMap
    configmap_yaml = generator.generate_kubernetes_configmap()

    with open('generated-snmp-config.yaml', 'w') as f:
        f.write(configmap_yaml)

    print("SNMP configuration generated successfully!")

if __name__ == '__main__':
    main()
```

## Device Discovery and Auto-Configuration

Implement automated device discovery for large environments:

```bash
#!/bin/bash
# snmp-device-discovery.sh

NETWORK_RANGES=(
    "192.168.1.0/24"
    "10.0.1.0/24"
    "172.16.1.0/24"
)

SNMP_COMMUNITIES=("public" "private" "monitoring")
SNMP_TIMEOUT=2
DISCOVERY_LOG="/var/log/snmp-discovery.log"

discover_snmp_devices() {
    local network_range="$1"
    local discovered_devices=()

    echo "🔍 Scanning network range: $network_range" | tee -a "$DISCOVERY_LOG"

    # Use nmap to find responsive hosts
    local live_hosts=$(nmap -sn "$network_range" 2>/dev/null | grep "Nmap scan report" | awk '{print $5}')

    for host in $live_hosts; do
        # Test SNMP connectivity
        for community in "${SNMP_COMMUNITIES[@]}"; do
            local snmp_response=$(snmpget -v2c -c "$community" -t "$SNMP_TIMEOUT" -r 1 \
                                 "$host" 1.3.6.1.2.1.1.1.0 2>/dev/null)

            if [[ -n "$snmp_response" ]]; then
                echo "✅ SNMP device found: $host (community: $community)" | tee -a "$DISCOVERY_LOG"

                # Get device information
                local sys_descr=$(snmpget -v2c -c "$community" -t "$SNMP_TIMEOUT" -r 1 \
                                "$host" 1.3.6.1.2.1.1.1.0 2>/dev/null | cut -d: -f4-)
                local sys_name=$(snmpget -v2c -c "$community" -t "$SNMP_TIMEOUT" -r 1 \
                               "$host" 1.3.6.1.2.1.1.5.0 2>/dev/null | cut -d: -f4-)

                echo "   Description: $sys_descr" | tee -a "$DISCOVERY_LOG"
                echo "   System Name: $sys_name" | tee -a "$DISCOVERY_LOG"

                discovered_devices+=("$host:$community:${sys_descr// /_}")
                break
            fi
        done
    done

    printf '%s\n' "${discovered_devices[@]}"
}

generate_prometheus_targets() {
    local devices=("$@")
    local targets_file="/tmp/snmp-targets.yml"

    cat > "$targets_file" << 'EOF'
# Auto-generated SNMP targets for Prometheus
# Generated on: $(date)

targets:
EOF

    for device_info in "${devices[@]}"; do
        IFS=':' read -r host community description <<< "$device_info"

        # Determine appropriate module based on description
        local module="if_mib"  # Default module

        case "$description" in
            *Cisco*|*cisco*)
                module="cisco_device"
                ;;
            *Synology*|*synology*)
                module="synology_nas"
                ;;
            *Switch*|*switch*)
                module="if_mib"
                ;;
        esac

        cat >> "$targets_file" << EOF
  - targets: ['$host']
    labels:
      module: '$module'
      community: '$community'
      device_type: '$(echo "$description" | cut -d'_' -f1)'
      environment: 'production'
EOF
    done

    echo "📝 Generated Prometheus targets file: $targets_file"
}

# Main discovery process
main() {
    echo "🚀 Starting SNMP device discovery..." | tee -a "$DISCOVERY_LOG"

    local all_devices=()

    for network in "${NETWORK_RANGES[@]}"; do
        mapfile -t -O "${#all_devices[@]}" all_devices < <(discover_snmp_devices "$network")
    done

    echo "📊 Discovery complete. Found ${#all_devices[@]} SNMP devices." | tee -a "$DISCOVERY_LOG"

    if [[ ${#all_devices[@]} -gt 0 ]]; then
        generate_prometheus_targets "${all_devices[@]}"

        # Generate Kubernetes ServiceMonitor
        generate_kubernetes_servicemonitor "${all_devices[@]}"
    fi
}

generate_kubernetes_servicemonitor() {
    local devices=("$@")

    cat > /tmp/snmp-servicemonitor.yaml << 'EOF'
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: snmp-devices
  namespace: monitoring-system
  labels:
    app: snmp-exporter
spec:
  selector:
    matchLabels:
      app: snmp-exporter
  endpoints:
  - port: http-metrics
    interval: 60s
    scrapeTimeout: 30s
    path: /snmp
    params:
      module: [if_mib]  # Default, can be overridden per target
    relabelings:
    - sourceLabels: [__address__]
      targetLabel: __param_target
    - sourceLabels: [__param_target]
      targetLabel: instance
    - targetLabel: __address__
      replacement: snmp-exporter.monitoring-system.svc.cluster.local:9116
EOF

    # Add discovered targets as static configuration
    for device_info in "${devices[@]}"; do
        IFS=':' read -r host community description <<< "$device_info"

        cat >> /tmp/snmp-servicemonitor.yaml << EOF
---
apiVersion: v1
kind: Endpoints
metadata:
  name: snmp-target-$host
  namespace: monitoring-system
subsets:
- addresses:
  - ip: $host
  ports:
  - port: 161
    protocol: UDP
EOF
    done

    echo "📝 Generated Kubernetes ServiceMonitor: /tmp/snmp-servicemonitor.yaml"
}

# Execute discovery
main "$@"
```

# Prometheus Integration and Service Discovery

## ServiceMonitor Configuration for Automated Scraping

```yaml
# snmp-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: snmp-infrastructure
  namespace: monitoring-system
  labels:
    app: snmp-exporter
    monitoring: infrastructure
spec:
  selector:
    matchLabels:
      app: snmp-exporter
  endpoints:
  - port: http-metrics
    interval: 30s
    scrapeTimeout: 25s
    path: /snmp
    params:
      module: [if_mib]  # Default module
    relabelings:
    # Set the target parameter for SNMP exporter
    - sourceLabels: [__address__]
      targetLabel: __param_target
    - sourceLabels: [__param_target]
      targetLabel: instance
    # Replace the address with the SNMP exporter service
    - targetLabel: __address__
      replacement: snmp-exporter.monitoring-system.svc.cluster.local:9116
    metricRelabelings:
    # Add location and environment labels
    - sourceLabels: [__name__]
      targetLabel: job
      replacement: snmp-infrastructure
    - sourceLabels: [instance]
      targetLabel: location
      regex: '192\.168\.1\.(.*)'
      replacement: 'datacenter-1'
    - sourceLabels: [instance]
      targetLabel: location
      regex: '10\.0\.1\.(.*)'
      replacement: 'datacenter-2'
---
# Additional ServiceMonitor for different device types
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: snmp-storage-devices
  namespace: monitoring-system
  labels:
    app: snmp-exporter
    monitoring: storage
spec:
  selector:
    matchLabels:
      app: snmp-exporter
  endpoints:
  - port: http-metrics
    interval: 60s
    scrapeTimeout: 45s
    path: /snmp
    params:
      module: [storage_monitoring]
    relabelings:
    - sourceLabels: [__address__]
      targetLabel: __param_target
    - sourceLabels: [__param_target]
      targetLabel: instance
    - targetLabel: __address__
      replacement: snmp-exporter.monitoring-system.svc.cluster.local:9116
```

## Advanced Prometheus Configuration

```yaml
# prometheus-snmp-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-snmp-config
  namespace: monitoring-system
data:
  prometheus.yml: |
    global:
      scrape_interval: 30s
      evaluation_interval: 30s

    rule_files:
      - "/etc/prometheus/rules/*.yml"

    scrape_configs:
    # Multi-target SNMP scraping configuration
    - job_name: 'snmp-multi-target'
      static_configs:
        - targets:
          # Network infrastructure
          - 192.168.1.1    # Core router
          - 192.168.1.2    # Distribution switch
          - 192.168.1.10   # Access switch 1
          - 192.168.1.11   # Access switch 2
          # Storage infrastructure
          - 192.168.1.100  # Primary NAS
          - 192.168.1.101  # Backup NAS
          # UPS systems
          - 192.168.1.200  # Datacenter UPS
          labels:
            environment: production
            location: primary-datacenter

      metrics_path: /snmp
      params:
        module: [if_mib]  # Default module

      relabeling_configs:
      # Override module based on target
      - source_labels: [__address__]
        regex: '192\.168\.1\.(1|2|1[01])'
        target_label: __param_module
        replacement: if_mib
      - source_labels: [__address__]
        regex: '192\.168\.1\.1[01][0-9]'
        target_label: __param_module
        replacement: storage_monitoring
      - source_labels: [__address__]
        regex: '192\.168\.1\.2[0-9][0-9]'
        target_label: __param_module
        replacement: ups_monitoring

      # Set SNMP target
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: snmp-exporter.monitoring-system.svc.cluster.local:9116

    # Separate job for Synology devices with custom auth
    - job_name: 'snmp-synology'
      static_configs:
        - targets:
          - 192.168.1.100
          - 192.168.1.101
          labels:
            device_type: synology

      metrics_path: /snmp
      params:
        module: [synology_nas]
        auth: [snmpv3_auth_priv]

      relabeling_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: snmp-exporter.monitoring-system.svc.cluster.local:9116

    alerting:
      alertmanagers:
        - static_configs:
            - targets:
              - alertmanager.monitoring-system.svc.cluster.local:9093
```

# Advanced Monitoring Patterns and Alerting

## Custom SNMP Metrics and Alerting Rules

```yaml
# snmp-alerting-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: snmp-infrastructure-alerts
  namespace: monitoring-system
  labels:
    app: prometheus
    role: alert-rules
spec:
  groups:
  - name: snmp-interface-monitoring
    interval: 30s
    rules:
    - alert: SNMPInterfaceDown
      expr: ifOperStatus{job="snmp-multi-target"} == 2
      for: 2m
      labels:
        severity: warning
        component: network-interface
      annotations:
        summary: "SNMP Interface {{ $labels.ifDescr }} is down on {{ $labels.instance }}"
        description: "Interface {{ $labels.ifDescr }} on device {{ $labels.instance }} has been down for more than 2 minutes."
        runbook_url: "https://support.tools/runbooks/network-interface-down"

    - alert: SNMPHighInterfaceUtilization
      expr: |
        (
          rate(ifOutOctets{job="snmp-multi-target"}[5m]) * 8 / ifSpeed * 100
        ) > 80
      for: 10m
      labels:
        severity: warning
        component: network-interface
      annotations:
        summary: "High network utilization on {{ $labels.ifDescr }} ({{ $labels.instance }})"
        description: "Interface {{ $labels.ifDescr }} on {{ $labels.instance }} is {{ $value }}% utilized"

    - alert: SNMPInterfaceErrors
      expr: |
        rate(ifInErrors{job="snmp-multi-target"}[5m]) > 1 or
        rate(ifOutErrors{job="snmp-multi-target"}[5m]) > 1
      for: 5m
      labels:
        severity: critical
        component: network-interface
      annotations:
        summary: "Interface errors detected on {{ $labels.ifDescr }} ({{ $labels.instance }})"
        description: "Interface {{ $labels.ifDescr }} is experiencing packet errors"

  - name: snmp-storage-monitoring
    interval: 60s
    rules:
    - alert: SNMPStorageSpaceHigh
      expr: |
        (
          hrStorageUsed{job="snmp-storage-devices"} / hrStorageSize{job="snmp-storage-devices"}
        ) * 100 > 85
      for: 15m
      labels:
        severity: warning
        component: storage
      annotations:
        summary: "Storage {{ $labels.hrStorageDescr }} usage high on {{ $labels.instance }}"
        description: "Storage volume {{ $labels.hrStorageDescr }} is {{ $value }}% full"

    - alert: SNMPStorageSpaceCritical
      expr: |
        (
          hrStorageUsed{job="snmp-storage-devices"} / hrStorageSize{job="snmp-storage-devices"}
        ) * 100 > 95
      for: 5m
      labels:
        severity: critical
        component: storage
      annotations:
        summary: "Storage {{ $labels.hrStorageDescr }} critically full on {{ $labels.instance }}"
        description: "Storage volume {{ $labels.hrStorageDescr }} is {{ $value }}% full - immediate action required"

  - name: snmp-device-availability
    interval: 30s
    rules:
    - alert: SNMPDeviceUnreachable
      expr: up{job=~"snmp-.*"} == 0
      for: 3m
      labels:
        severity: critical
        component: infrastructure
      annotations:
        summary: "SNMP device {{ $labels.instance }} is unreachable"
        description: "SNMP monitoring for {{ $labels.instance }} has been failing for more than 3 minutes"

    - alert: SNMPExporterDown
      expr: up{job="snmp-exporter"} == 0
      for: 1m
      labels:
        severity: critical
        component: monitoring
      annotations:
        summary: "SNMP Exporter is down"
        description: "SNMP Exporter service is not responding - all SNMP monitoring affected"
```

# Enterprise Security and Authentication

## SNMPv3 User Management and Key Rotation

```bash
#!/bin/bash
# snmp-user-management.sh

SNMP_CONFIG_DIR="/etc/snmp"
ENGINE_ID_FILE="$SNMP_CONFIG_DIR/snmpd.conf"
USER_CONFIG_FILE="$SNMP_CONFIG_DIR/snmpd.users"
BACKUP_DIR="/backup/snmp-$(date +%Y%m%d)"

create_snmpv3_user() {
    local username="$1"
    local auth_password="$2"
    local priv_password="$3"
    local auth_protocol="${4:-SHA}"
    local priv_protocol="${5:-AES}"

    # Validate input parameters
    if [[ ${#auth_password} -lt 8 || ${#priv_password} -lt 8 ]]; then
        echo "❌ Passwords must be at least 8 characters long"
        return 1
    fi

    echo "🔐 Creating SNMPv3 user: $username"

    # Generate user configuration
    local user_config="createUser $username $auth_protocol \"$auth_password\" $priv_protocol \"$priv_password\""

    # Stop SNMP service
    systemctl stop snmpd

    # Backup existing configuration
    mkdir -p "$BACKUP_DIR"
    cp "$USER_CONFIG_FILE" "$BACKUP_DIR/" 2>/dev/null || true

    # Add user to configuration
    echo "$user_config" >> "$USER_CONFIG_FILE"

    # Update main configuration with user access
    cat >> "$ENGINE_ID_FILE" << EOF

# User access configuration for $username
group readwrite v3 $username
access readwrite "" v3 authPriv exact all all all
view all included .1
EOF

    # Start SNMP service
    systemctl start snmpd

    # Test user authentication
    local test_result=$(snmpget -v3 -u "$username" \
                               -l authPriv \
                               -a "$auth_protocol" -A "$auth_password" \
                               -x "$priv_protocol" -X "$priv_password" \
                               localhost 1.3.6.1.2.1.1.1.0 2>/dev/null)

    if [[ -n "$test_result" ]]; then
        echo "✅ SNMPv3 user $username created and verified successfully"

        # Update Kubernetes secret with new credentials
        update_kubernetes_credentials "$username" "$auth_password" "$priv_password"
    else
        echo "❌ Failed to verify SNMPv3 user $username"
        # Restore backup
        cp "$BACKUP_DIR/$(basename $USER_CONFIG_FILE)" "$USER_CONFIG_FILE" 2>/dev/null || true
        systemctl restart snmpd
        return 1
    fi
}

update_kubernetes_credentials() {
    local username="$1"
    local auth_password="$2"
    local priv_password="$3"

    echo "🔄 Updating Kubernetes secret with new SNMP credentials..."

    kubectl create secret generic snmp-credentials \
        --from-literal=snmpv3-username="$username" \
        --from-literal=snmpv3-auth-password="$auth_password" \
        --from-literal=snmpv3-priv-password="$priv_password" \
        --namespace=monitoring-system \
        --dry-run=client -o yaml | kubectl apply -f -

    # Restart SNMP exporter to pick up new credentials
    kubectl rollout restart deployment/snmp-exporter -n monitoring-system

    echo "✅ Kubernetes credentials updated and SNMP exporter restarted"
}

rotate_snmp_credentials() {
    local username="$1"
    local new_auth_password="$(openssl rand -base64 32)"
    local new_priv_password="$(openssl rand -base64 32)"

    echo "🔄 Rotating credentials for user: $username"

    # Create new user with rotated passwords
    create_snmpv3_user "${username}_new" "$new_auth_password" "$new_priv_password"

    # Test new credentials across all monitored devices
    local device_list=("192.168.1.1" "192.168.1.100" "192.168.1.200")
    local rotation_successful=true

    for device in "${device_list[@]}"; do
        local test_result=$(snmpget -v3 -u "${username}_new" \
                                   -l authPriv \
                                   -a SHA -A "$new_auth_password" \
                                   -x AES -X "$new_priv_password" \
                                   "$device" 1.3.6.1.2.1.1.1.0 2>/dev/null)

        if [[ -z "$test_result" ]]; then
            echo "⚠️ Credential rotation failed for device: $device"
            rotation_successful=false
        fi
    done

    if [[ "$rotation_successful" == "true" ]]; then
        echo "✅ Credential rotation successful across all devices"

        # Remove old user and rename new user
        remove_snmpv3_user "$username"
        rename_snmpv3_user "${username}_new" "$username"

        # Update Kubernetes with new credentials
        update_kubernetes_credentials "$username" "$new_auth_password" "$new_priv_password"
    else
        echo "❌ Credential rotation failed - removing temporary user"
        remove_snmpv3_user "${username}_new"
        return 1
    fi
}

# Automated credential rotation script
schedule_credential_rotation() {
    cat > /etc/cron.d/snmp-credential-rotation << 'EOF'
# Rotate SNMP credentials monthly
0 2 1 * * root /usr/local/bin/snmp-user-management.sh rotate_credentials monitoring-user
EOF

    echo "📅 Scheduled monthly credential rotation"
}

# Main function handling
case "${1:-}" in
    "create")
        create_snmpv3_user "$2" "$3" "$4" "${5:-SHA}" "${6:-AES}"
        ;;
    "rotate")
        rotate_snmp_credentials "$2"
        ;;
    "schedule")
        schedule_credential_rotation
        ;;
    *)
        echo "Usage: $0 {create|rotate|schedule} [parameters]"
        echo "  create <username> <auth_pass> <priv_pass> [auth_proto] [priv_proto]"
        echo "  rotate <username>"
        echo "  schedule"
        exit 1
        ;;
esac
```

# Performance Optimization and Scaling

## High-Performance SNMP Exporter Configuration

```yaml
# high-performance-snmp-exporter.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: snmp-exporter-hp
  namespace: monitoring-system
  labels:
    app: snmp-exporter-hp
    tier: monitoring
spec:
  replicas: 4
  selector:
    matchLabels:
      app: snmp-exporter-hp
  template:
    metadata:
      labels:
        app: snmp-exporter-hp
        tier: monitoring
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: snmp-exporter-hp
              topologyKey: kubernetes.io/hostname
      containers:
      - name: snmp-exporter
        image: prom/snmp-exporter:v0.25.0
        ports:
        - containerPort: 9116
          name: http-metrics
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        env:
        # Performance tuning environment variables
        - name: GOMAXPROCS
          value: "4"
        - name: GOMEMLIMIT
          value: "3GiB"
        args:
        - --config.file=/etc/snmp_exporter/snmp.yml
        - --log.level=warn  # Reduce logging overhead
        - --web.listen-address=0.0.0.0:9116
        - --web.max-requests=100
        - --web.read-timeout=30s
        - --web.write-timeout=30s
        - --snmp.timeout=20s
        - --snmp.retries=1
        volumeMounts:
        - name: config-volume
          mountPath: /etc/snmp_exporter
          readOnly: true
        livenessProbe:
          httpGet:
            path: /health
            port: 9116
          initialDelaySeconds: 30
          periodSeconds: 30
          timeoutSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 9116
          initialDelaySeconds: 5
          periodSeconds: 10
          timeoutSeconds: 5
      volumes:
      - name: config-volume
        configMap:
          name: snmp-exporter-config
---
# HorizontalPodAutoscaler for dynamic scaling
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: snmp-exporter-hpa
  namespace: monitoring-system
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: snmp-exporter-hp
  minReplicas: 2
  maxReplicas: 8
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 100
        periodSeconds: 60
```

## Load Balancing and Circuit Breaking

```yaml
# snmp-exporter-istio-config.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: snmp-exporter-vs
  namespace: monitoring-system
spec:
  hosts:
  - snmp-exporter.monitoring-system.svc.cluster.local
  http:
  - match:
    - uri:
        prefix: "/snmp"
    route:
    - destination:
        host: snmp-exporter-hp.monitoring-system.svc.cluster.local
        port:
          number: 9116
    timeout: 30s
    retries:
      attempts: 3
      perTryTimeout: 10s
      retryOn: 5xx,reset,connect-failure,refused-stream
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: snmp-exporter-dr
  namespace: monitoring-system
spec:
  host: snmp-exporter-hp.monitoring-system.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      consistentHash:
        httpHeaderName: "X-Target-Device"  # Sticky sessions per device
    connectionPool:
      tcp:
        maxConnections: 50
      http:
        http1MaxPendingRequests: 100
        maxRequestsPerConnection: 20
        maxRetries: 3
        idleTimeout: 30s
    circuitBreaker:
      consecutiveErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
      minHealthPercent: 30
```

# Troubleshooting and Maintenance

## Comprehensive Troubleshooting Toolkit

```bash
#!/bin/bash
# snmp-troubleshooting-toolkit.sh

SNMP_EXPORTER_NAMESPACE="monitoring-system"
SNMP_EXPORTER_DEPLOYMENT="snmp-exporter"
LOG_LEVEL="debug"

diagnose_snmp_connectivity() {
    local target_device="$1"
    local community="${2:-public}"
    local version="${3:-2c}"

    echo "🔍 Diagnosing SNMP connectivity to: $target_device"

    # Test basic connectivity
    if ! ping -c 3 -W 2 "$target_device" >/dev/null 2>&1; then
        echo "❌ Network connectivity failed to $target_device"
        return 1
    fi

    echo "✅ Network connectivity successful"

    # Test SNMP port accessibility
    if ! timeout 5 bash -c "echo >/dev/tcp/$target_device/161" 2>/dev/null; then
        echo "❌ SNMP port (UDP 161) not accessible on $target_device"
        return 1
    fi

    echo "✅ SNMP port accessible"

    # Test SNMP query
    local snmp_response=""
    case "$version" in
        "1"|"2c")
            snmp_response=$(snmpget -v"$version" -c "$community" -t 5 -r 2 \
                           "$target_device" 1.3.6.1.2.1.1.1.0 2>/dev/null)
            ;;
        "3")
            # Requires additional authentication parameters
            echo "⚠️ SNMPv3 testing requires authentication parameters"
            return 0
            ;;
    esac

    if [[ -n "$snmp_response" ]]; then
        echo "✅ SNMP query successful"
        echo "   Response: ${snmp_response:0:100}..."
        return 0
    else
        echo "❌ SNMP query failed"

        # Provide troubleshooting suggestions
        echo "🔧 Troubleshooting suggestions:"
        echo "   - Verify SNMP community string"
        echo "   - Check device SNMP configuration"
        echo "   - Verify firewall rules (UDP 161)"
        echo "   - Test with snmpwalk for broader diagnostics"

        return 1
    fi
}

analyze_exporter_performance() {
    echo "📊 Analyzing SNMP Exporter performance..."

    # Check pod resource utilization
    kubectl top pods -n "$SNMP_EXPORTER_NAMESPACE" -l app="$SNMP_EXPORTER_DEPLOYMENT"

    # Check exporter metrics
    local exporter_pod=$(kubectl get pods -n "$SNMP_EXPORTER_NAMESPACE" \
                        -l app="$SNMP_EXPORTER_DEPLOYMENT" \
                        -o jsonpath='{.items[0].metadata.name}')

    if [[ -n "$exporter_pod" ]]; then
        echo "🔍 Checking exporter metrics from pod: $exporter_pod"

        kubectl port-forward -n "$SNMP_EXPORTER_NAMESPACE" "$exporter_pod" 9116:9116 &
        local pf_pid=$!

        sleep 3

        # Fetch key metrics
        local scrape_duration=$(curl -s http://localhost:9116/metrics | \
                               grep "snmp_collection_duration_seconds" | tail -1)
        local scrape_success=$(curl -s http://localhost:9116/metrics | \
                              grep "snmp_requests_total" | tail -5)

        echo "📈 Recent scrape performance:"
        echo "$scrape_duration"
        echo -e "\n📊 Request statistics:"
        echo "$scrape_success"

        kill $pf_pid 2>/dev/null
    fi
}

validate_snmp_configuration() {
    local config_file="${1:-/etc/snmp_exporter/snmp.yml}"

    echo "🔍 Validating SNMP configuration..."

    # Check if configuration file exists in pod
    local exporter_pod=$(kubectl get pods -n "$SNMP_EXPORTER_NAMESPACE" \
                        -l app="$SNMP_EXPORTER_DEPLOYMENT" \
                        -o jsonpath='{.items[0].metadata.name}')

    if [[ -n "$exporter_pod" ]]; then
        echo "📁 Checking configuration in pod: $exporter_pod"

        # Validate YAML syntax
        if kubectl exec -n "$SNMP_EXPORTER_NAMESPACE" "$exporter_pod" -- \
           python3 -c "import yaml; yaml.safe_load(open('$config_file'))" 2>/dev/null; then
            echo "✅ Configuration YAML syntax valid"
        else
            echo "❌ Configuration YAML syntax invalid"
            kubectl exec -n "$SNMP_EXPORTER_NAMESPACE" "$exporter_pod" -- \
                python3 -c "import yaml; yaml.safe_load(open('$config_file'))"
            return 1
        fi

        # Display loaded modules
        echo "📋 Available SNMP modules:"
        kubectl exec -n "$SNMP_EXPORTER_NAMESPACE" "$exporter_pod" -- \
            grep -A1 "modules:" "$config_file" | head -20
    fi
}

generate_diagnostic_report() {
    local report_file="/tmp/snmp-diagnostic-report-$(date +%Y%m%d-%H%M%S).txt"

    echo "📝 Generating comprehensive diagnostic report..."

    {
        echo "SNMP Exporter Diagnostic Report"
        echo "Generated: $(date)"
        echo "========================================"
        echo ""

        echo "Cluster Information:"
        echo "-------------------"
        kubectl cluster-info
        echo ""

        echo "SNMP Exporter Pod Status:"
        echo "------------------------"
        kubectl get pods -n "$SNMP_EXPORTER_NAMESPACE" -l app="$SNMP_EXPORTER_DEPLOYMENT" -o wide
        echo ""

        echo "SNMP Exporter Service Status:"
        echo "----------------------------"
        kubectl get services -n "$SNMP_EXPORTER_NAMESPACE" -l app="$SNMP_EXPORTER_DEPLOYMENT"
        echo ""

        echo "Recent Pod Events:"
        echo "-----------------"
        kubectl get events -n "$SNMP_EXPORTER_NAMESPACE" --field-selector involvedObject.kind=Pod --sort-by='.lastTimestamp' | tail -20
        echo ""

        echo "Pod Resource Usage:"
        echo "------------------"
        kubectl top pods -n "$SNMP_EXPORTER_NAMESPACE" -l app="$SNMP_EXPORTER_DEPLOYMENT" 2>/dev/null || echo "Metrics not available"
        echo ""

        echo "Recent Pod Logs:"
        echo "---------------"
        kubectl logs -n "$SNMP_EXPORTER_NAMESPACE" -l app="$SNMP_EXPORTER_DEPLOYMENT" --tail=50
        echo ""

        echo "Configuration Status:"
        echo "--------------------"
        kubectl get configmap -n "$SNMP_EXPORTER_NAMESPACE" snmp-exporter-config -o yaml | head -50
        echo ""

    } > "$report_file"

    echo "📊 Diagnostic report generated: $report_file"
    echo "📤 To share this report, run: cat $report_file"
}

# Interactive troubleshooting menu
interactive_troubleshooting() {
    while true; do
        echo ""
        echo "🛠️ SNMP Exporter Troubleshooting Menu"
        echo "====================================="
        echo "1. Test device connectivity"
        echo "2. Analyze exporter performance"
        echo "3. Validate configuration"
        echo "4. Generate diagnostic report"
        echo "5. View recent logs"
        echo "6. Exit"
        echo ""
        read -p "Select option (1-6): " choice

        case $choice in
            1)
                read -p "Enter device IP/hostname: " device
                read -p "Enter SNMP community (default: public): " community
                community=${community:-public}
                diagnose_snmp_connectivity "$device" "$community"
                ;;
            2)
                analyze_exporter_performance
                ;;
            3)
                validate_snmp_configuration
                ;;
            4)
                generate_diagnostic_report
                ;;
            5)
                kubectl logs -n "$SNMP_EXPORTER_NAMESPACE" -l app="$SNMP_EXPORTER_DEPLOYMENT" --tail=100 -f
                ;;
            6)
                echo "👋 Exiting troubleshooting menu"
                break
                ;;
            *)
                echo "❌ Invalid option. Please select 1-6."
                ;;
        esac
    done
}

# Main execution
case "${1:-interactive}" in
    "connectivity")
        diagnose_snmp_connectivity "$2" "$3" "$4"
        ;;
    "performance")
        analyze_exporter_performance
        ;;
    "config")
        validate_snmp_configuration "$2"
        ;;
    "report")
        generate_diagnostic_report
        ;;
    "interactive")
        interactive_troubleshooting
        ;;
    *)
        echo "Usage: $0 {connectivity|performance|config|report|interactive}"
        exit 1
        ;;
esac
```

# Conclusion

SNMP monitoring in modern Kubernetes environments requires sophisticated orchestration of legacy protocols with cloud-native infrastructure. This comprehensive guide provides enterprise-grade solutions for deploying, securing, and scaling SNMP exporters while maintaining operational excellence.

Key implementation highlights:

1. **Secure SNMPv3 Authentication**: Comprehensive credential management with automated rotation capabilities
2. **Scalable Architecture**: Kubernetes-native deployments with horizontal scaling and load balancing
3. **Advanced Configuration**: Device-specific modules with automated discovery and configuration generation
4. **Production Monitoring**: Robust alerting, performance optimization, and troubleshooting capabilities
5. **Enterprise Security**: Comprehensive security hardening, audit logging, and access control

Organizations implementing these patterns can achieve comprehensive infrastructure visibility while maintaining security, scalability, and operational efficiency. The investment in proper SNMP monitoring infrastructure provides critical insights into network performance, storage utilization, and device health across heterogeneous enterprise environments.

Regular maintenance, security updates, and performance optimization ensure that SNMP monitoring remains effective and secure as infrastructure scales and evolves. The automated discovery and configuration management capabilities reduce operational overhead while improving monitoring coverage and accuracy.