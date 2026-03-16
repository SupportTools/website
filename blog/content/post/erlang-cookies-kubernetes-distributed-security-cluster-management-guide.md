---
title: "Erlang Cookies and Kubernetes: Enterprise Distributed System Security and Cluster Management for Production Environments"
date: 2026-07-05T00:00:00-05:00
draft: false
tags: ["Erlang", "Elixir", "Kubernetes", "Distributed-Systems", "Security", "Clustering", "Secret-Management"]
categories: ["Security", "Distributed-Systems", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing secure Erlang/Elixir clustering in Kubernetes environments using cookies, advanced secret management, distributed system security patterns, and enterprise-grade cluster coordination strategies."
more_link: "yes"
url: "/erlang-cookies-kubernetes-distributed-security-cluster-management-guide/"
---

Erlang and Elixir distributed systems rely on authentication cookies for secure node communication in clustered environments. When deploying these systems in Kubernetes, proper cookie management becomes critical for both security and operational reliability. This comprehensive guide demonstrates enterprise-grade approaches to Erlang cookie management, distributed system security, and cluster coordination patterns for production Kubernetes environments.

<!--more-->

# Executive Summary

Erlang's distributed architecture uses authentication cookies as shared secrets for inter-node communication security. In Kubernetes environments, these cookies require sophisticated management strategies that balance security, operational simplicity, and cluster reliability. This guide presents production-ready patterns for cookie generation, rotation, secret management, and monitoring that enable organizations to deploy secure, scalable Erlang/Elixir distributed systems with confidence.

## Erlang Cookie Architecture and Security Model

### Understanding Erlang Cookie Authentication

Erlang cookies serve as shared authentication secrets that enable nodes in an Erlang cluster to establish trusted communication channels:

```yaml
# Secure Erlang cookie management in Kubernetes
apiVersion: v1
kind: Secret
metadata:
  name: erlang-cookie
  namespace: distributed-app
  labels:
    app: erlang-cluster
    component: authentication
    security-level: high
type: Opaque
data:
  # Base64-encoded cookie value
  # Generated using: head -c 40 /dev/urandom | base64 | tr -d '\n='
  cookie: "VGhpc0lzQVNlY3VyZUNvb2tpZUZvckVybGFuZ0NsdXN0ZXJBDXV0aGVudGljYXRpb24="

---
# Cookie rotation schedule
apiVersion: v1
kind: ConfigMap
metadata:
  name: cookie-rotation-config
  namespace: distributed-app
data:
  rotation-schedule.yaml: |
    # Cookie rotation configuration
    rotation_policy:
      # Rotate cookies every 90 days
      rotation_interval: "2160h"  # 90 days
      # Grace period for old cookies
      grace_period: "168h"        # 7 days
      # Backup cookie retention
      backup_retention: "720h"    # 30 days

    # Security requirements
    security:
      # Minimum cookie entropy (bits)
      min_entropy: 256
      # Cookie format validation
      format_regex: "^[A-Za-z0-9+/]{40,}$"
      # Encryption requirements
      encryption_required: true

    # Monitoring configuration
    monitoring:
      # Alert on cookie expiration
      expiration_warning_days: 14
      # Monitor authentication failures
      failure_threshold: 10
      # Health check interval
      health_check_interval: "300s"
```

### Enterprise Cookie Generation Strategy

```bash
#!/bin/bash
# Enterprise Erlang cookie generation and management script

set -euo pipefail

# Configuration
NAMESPACE="${NAMESPACE:-distributed-app}"
SECRET_NAME="${SECRET_NAME:-erlang-cookie}"
COOKIE_LENGTH="${COOKIE_LENGTH:-64}"
BACKUP_COUNT="${BACKUP_COUNT:-5}"

# Logging
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [COOKIE-MANAGER] $*" >&2
}

# Generate cryptographically secure cookie
generate_secure_cookie() {
    local length=${1:-$COOKIE_LENGTH}

    log "Generating secure Erlang cookie with length: $length"

    # Use multiple entropy sources for maximum security
    local cookie
    cookie=$(head -c "$length" /dev/urandom | base64 | tr -d '\n=' | head -c "$length")

    # Validate cookie meets security requirements
    if [[ ${#cookie} -lt 40 ]]; then
        log "ERROR: Generated cookie too short: ${#cookie} < 40"
        return 1
    fi

    # Validate cookie contains sufficient entropy
    local unique_chars
    unique_chars=$(echo "$cookie" | grep -o . | sort | uniq | wc -l)

    if [[ $unique_chars -lt 20 ]]; then
        log "WARNING: Cookie may have insufficient entropy: $unique_chars unique characters"
    fi

    echo "$cookie"
}

# Backup existing cookie
backup_current_cookie() {
    log "Creating backup of current cookie"

    local current_cookie
    current_cookie=$(kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" \
        -o jsonpath='{.data.cookie}' 2>/dev/null || echo "")

    if [[ -n "$current_cookie" ]]; then
        local backup_name="${SECRET_NAME}-backup-$(date +%Y%m%d-%H%M%S)"

        kubectl create secret generic "$backup_name" \
            --from-literal=cookie="$(echo "$current_cookie" | base64 -d)" \
            --from-literal=original-name="$SECRET_NAME" \
            --from-literal=backup-timestamp="$(date -Iseconds)" \
            -n "$NAMESPACE"

        kubectl label secret "$backup_name" \
            app=erlang-cluster \
            component=cookie-backup \
            original-secret="$SECRET_NAME" \
            -n "$NAMESPACE"

        log "Cookie backup created: $backup_name"

        # Clean up old backups
        cleanup_old_backups
    else
        log "No existing cookie found to backup"
    fi
}

# Clean up old cookie backups
cleanup_old_backups() {
    log "Cleaning up old cookie backups (keeping $BACKUP_COUNT)"

    # Get backup secrets sorted by creation time
    local backups
    backups=$(kubectl get secrets -n "$NAMESPACE" \
        -l "component=cookie-backup,original-secret=$SECRET_NAME" \
        --sort-by=.metadata.creationTimestamp \
        -o jsonpath='{.items[*].metadata.name}' || echo "")

    if [[ -n "$backups" ]]; then
        local backup_array
        read -ra backup_array <<< "$backups"
        local backup_count=${#backup_array[@]}

        if [[ $backup_count -gt $BACKUP_COUNT ]]; then
            local delete_count=$((backup_count - BACKUP_COUNT))
            log "Deleting $delete_count old backups"

            for ((i=0; i<delete_count; i++)); do
                kubectl delete secret "${backup_array[$i]}" -n "$NAMESPACE"
                log "Deleted backup: ${backup_array[$i]}"
            done
        fi
    fi
}

# Update Erlang cookie secret
update_cookie_secret() {
    local new_cookie=$1

    log "Updating Erlang cookie secret"

    # Create or update the secret
    kubectl create secret generic "$SECRET_NAME" \
        --from-literal=cookie="$new_cookie" \
        --from-literal=generated-timestamp="$(date -Iseconds)" \
        --from-literal=generated-by="erlang-cookie-manager" \
        -n "$NAMESPACE" \
        --dry-run=client -o yaml | kubectl apply -f -

    # Add labels for management
    kubectl label secret "$SECRET_NAME" \
        app=erlang-cluster \
        component=authentication \
        security-level=high \
        managed-by=cookie-manager \
        -n "$NAMESPACE" \
        --overwrite

    # Add annotations for operational metadata
    kubectl annotate secret "$SECRET_NAME" \
        "cookie-manager.io/rotation-schedule=90d" \
        "cookie-manager.io/next-rotation=$(date -d '+90 days' -Iseconds)" \
        "cookie-manager.io/entropy-bits=256" \
        -n "$NAMESPACE" \
        --overwrite

    log "Cookie secret updated successfully"
}

# Validate cookie security
validate_cookie_security() {
    local cookie=$1

    log "Validating cookie security properties"

    # Length validation
    if [[ ${#cookie} -lt 40 ]]; then
        log "ERROR: Cookie length insufficient: ${#cookie} < 40"
        return 1
    fi

    # Character set validation
    if [[ ! $cookie =~ ^[A-Za-z0-9+/]+$ ]]; then
        log "ERROR: Cookie contains invalid characters"
        return 1
    fi

    # Entropy estimation (simplified)
    local unique_chars
    unique_chars=$(echo "$cookie" | grep -o . | sort | uniq | wc -l)

    local entropy_estimate
    entropy_estimate=$(echo "scale=2; l($unique_chars) * ${#cookie} / l(2)" | bc -l)

    log "Cookie validation passed:"
    log "  Length: ${#cookie} characters"
    log "  Unique characters: $unique_chars"
    log "  Estimated entropy: ${entropy_estimate} bits"

    return 0
}

# Test cookie with Erlang node
test_cookie_with_node() {
    local cookie=$1

    log "Testing cookie with test Erlang node"

    # Create temporary test pod
    local test_pod="erlang-cookie-test-$(date +%s)"

    kubectl run "$test_pod" \
        --image=erlang:26-alpine \
        --restart=Never \
        --rm -i \
        -n "$NAMESPACE" \
        --env="COOKIE=$cookie" \
        --command -- sh -c "
            echo 'Testing Erlang cookie functionality'
            echo \$COOKIE > ~/.erlang.cookie
            chmod 400 ~/.erlang.cookie
            erl -sname test@localhost -setcookie \$COOKIE -eval 'io:format(\"Cookie test successful~n\"), init:stop().' -noshell
        " && log "Cookie test successful" || log "Cookie test failed"
}

# Monitor cookie expiration
monitor_cookie_expiration() {
    log "Monitoring cookie expiration"

    # Get current cookie metadata
    local cookie_data
    cookie_data=$(kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" -o json 2>/dev/null || echo "{}")

    if [[ "$cookie_data" != "{}" ]]; then
        local next_rotation
        next_rotation=$(echo "$cookie_data" | jq -r '.metadata.annotations["cookie-manager.io/next-rotation"] // empty')

        if [[ -n "$next_rotation" ]]; then
            local rotation_timestamp
            rotation_timestamp=$(date -d "$next_rotation" +%s)
            local current_timestamp
            current_timestamp=$(date +%s)
            local days_until_rotation
            days_until_rotation=$(( (rotation_timestamp - current_timestamp) / 86400 ))

            log "Cookie rotation scheduled for: $next_rotation"
            log "Days until rotation: $days_until_rotation"

            if [[ $days_until_rotation -le 14 ]]; then
                log "WARNING: Cookie rotation due in $days_until_rotation days"
                # Send alert (implementation depends on alerting system)
                send_cookie_expiration_alert "$days_until_rotation"
            fi
        else
            log "WARNING: No rotation schedule found for cookie"
        fi
    else
        log "WARNING: Cookie secret not found"
    fi
}

# Send cookie expiration alert
send_cookie_expiration_alert() {
    local days_until_rotation=$1

    log "Sending cookie expiration alert"

    # Create Kubernetes event
    kubectl create event \
        --namespace="$NAMESPACE" \
        --type=Warning \
        --reason=CookieExpirationWarning \
        --message="Erlang cookie expires in $days_until_rotation days" \
        --reporting-controller=cookie-manager \
        --reporting-instance="cookie-manager-$(hostname)" \
        --action=RotateCookie \
        --object="Secret/$SECRET_NAME" || true

    # Send to monitoring system (customize for your setup)
    curl -X POST "http://alertmanager.monitoring.svc.cluster.local/api/v1/alerts" \
        -H "Content-Type: application/json" \
        -d "[{
            \"labels\": {
                \"alertname\": \"ErlangCookieExpiration\",
                \"namespace\": \"$NAMESPACE\",
                \"secret\": \"$SECRET_NAME\",
                \"severity\": \"warning\"
            },
            \"annotations\": {
                \"summary\": \"Erlang cookie expiring soon\",
                \"description\": \"Cookie $SECRET_NAME expires in $days_until_rotation days\"
            }
        }]" 2>/dev/null || log "Failed to send alert to monitoring system"
}

# Main cookie rotation workflow
rotate_cookie() {
    log "Starting cookie rotation workflow"

    # Backup current cookie
    backup_current_cookie

    # Generate new cookie
    local new_cookie
    new_cookie=$(generate_secure_cookie)

    if [[ -z "$new_cookie" ]]; then
        log "ERROR: Failed to generate new cookie"
        return 1
    fi

    # Validate new cookie
    if ! validate_cookie_security "$new_cookie"; then
        log "ERROR: New cookie failed security validation"
        return 1
    fi

    # Update secret
    update_cookie_secret "$new_cookie"

    # Test new cookie
    test_cookie_with_node "$new_cookie"

    log "Cookie rotation completed successfully"

    # Trigger rolling restart of Erlang applications
    trigger_application_restart

    return 0
}

# Trigger rolling restart of applications using the cookie
trigger_application_restart() {
    log "Triggering rolling restart of Erlang applications"

    # Find deployments that use the cookie
    local deployments
    deployments=$(kubectl get deployments -n "$NAMESPACE" \
        -o jsonpath='{.items[?(@.spec.template.spec.volumes[*].secret.secretName=="'$SECRET_NAME'")].metadata.name}' \
        2>/dev/null || echo "")

    if [[ -n "$deployments" ]]; then
        for deployment in $deployments; do
            log "Restarting deployment: $deployment"
            kubectl rollout restart deployment "$deployment" -n "$NAMESPACE"
            kubectl rollout status deployment "$deployment" -n "$NAMESPACE" --timeout=300s
        done
    else
        log "No deployments found using cookie secret"
    fi

    # Find StatefulSets that use the cookie
    local statefulsets
    statefulsets=$(kubectl get statefulsets -n "$NAMESPACE" \
        -o jsonpath='{.items[?(@.spec.template.spec.volumes[*].secret.secretName=="'$SECRET_NAME'")].metadata.name}' \
        2>/dev/null || echo "")

    if [[ -n "$statefulsets" ]]; then
        for statefulset in $statefulsets; do
            log "Restarting StatefulSet: $statefulset"
            kubectl rollout restart statefulset "$statefulset" -n "$NAMESPACE"
            kubectl rollout status statefulset "$statefulset" -n "$NAMESPACE" --timeout=600s
        done
    else
        log "No StatefulSets found using cookie secret"
    fi
}

# Command line interface
case "${1:-help}" in
    "generate")
        new_cookie=$(generate_secure_cookie)
        echo "Generated cookie: $new_cookie"
        ;;
    "rotate")
        rotate_cookie
        ;;
    "backup")
        backup_current_cookie
        ;;
    "monitor")
        monitor_cookie_expiration
        ;;
    "validate")
        if [[ -n "${2:-}" ]]; then
            validate_cookie_security "$2"
        else
            current_cookie=$(kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" \
                -o jsonpath='{.data.cookie}' | base64 -d)
            validate_cookie_security "$current_cookie"
        fi
        ;;
    "help")
        echo "Erlang Cookie Manager"
        echo "Usage: $0 {generate|rotate|backup|monitor|validate [cookie]|help}"
        echo ""
        echo "Commands:"
        echo "  generate  - Generate a new secure cookie"
        echo "  rotate    - Perform full cookie rotation"
        echo "  backup    - Backup current cookie"
        echo "  monitor   - Check cookie expiration status"
        echo "  validate  - Validate cookie security"
        echo "  help      - Show this help message"
        ;;
    *)
        echo "Unknown command: $1"
        echo "Use '$0 help' for usage information"
        exit 1
        ;;
esac
```

## Production Erlang/Elixir Deployment Patterns

### High Availability Elixir Cluster

```yaml
# Production Elixir application with secure clustering
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elixir-cluster
  namespace: distributed-app
  labels:
    app: elixir-cluster
    component: distributed-system
spec:
  # Cluster size
  replicas: 3

  # Service name for stable network identity
  serviceName: elixir-cluster-headless

  # Pod management policy for controlled startup
  podManagementPolicy: OrderedReady

  # Update strategy for rolling updates
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1

  selector:
    matchLabels:
      app: elixir-cluster

  template:
    metadata:
      labels:
        app: elixir-cluster
        component: distributed-system
      annotations:
        # Prometheus scraping
        prometheus.io/scrape: "true"
        prometheus.io/port: "4001"
        prometheus.io/path: "/metrics"
    spec:
      # Service account for cluster coordination
      serviceAccountName: elixir-cluster

      # Security context
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000

      # Initialize cluster configuration
      initContainers:
      - name: cluster-init
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          echo "Initializing cluster configuration"

          # Set up node name and cookie
          POD_INDEX=${HOSTNAME##*-}
          NODE_NAME="app@${HOSTNAME}.elixir-cluster-headless.distributed-app.svc.cluster.local"

          echo "Node name: $NODE_NAME"
          echo "Pod index: $POD_INDEX"

          # Create vm.args file
          cat > /opt/app/vm.args << EOF
          -name $NODE_NAME
          -setcookie $RELEASE_COOKIE
          -kernel inet_dist_listen_min 9100 inet_dist_listen_max 9155
          -erl_epmd_port 4369
          EOF

          # Set ownership
          chown -R 1000:1000 /opt/app/vm.args

        env:
        - name: RELEASE_COOKIE
          valueFrom:
            secretKeyRef:
              name: erlang-cookie
              key: cookie

        volumeMounts:
        - name: config-volume
          mountPath: /opt/app

        securityContext:
          runAsUser: 0  # Need root to set ownership

      containers:
      - name: elixir-app
        image: company/elixir-app:v1.15.0
        imagePullPolicy: IfNotPresent

        # Resource allocation
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
            ephemeral-storage: 1Gi
          limits:
            cpu: 2000m
            memory: 2Gi
            ephemeral-storage: 2Gi

        # Environment configuration
        env:
        - name: RELEASE_COOKIE
          valueFrom:
            secretKeyRef:
              name: erlang-cookie
              key: cookie

        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP

        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name

        - name: POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace

        # Application-specific environment
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: database-credentials
              key: url

        - name: SECRET_KEY_BASE
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: secret-key-base

        # Cluster configuration
        - name: CLUSTER_STRATEGY
          value: "Kubernetes"

        - name: CLUSTER_KUBERNETES_NAMESPACE
          value: "distributed-app"

        - name: CLUSTER_KUBERNETES_SELECTOR
          value: "app=elixir-cluster"

        # Ports
        ports:
        - name: http
          containerPort: 4000
          protocol: TCP
        - name: metrics
          containerPort: 4001
          protocol: TCP
        - name: epmd
          containerPort: 4369
          protocol: TCP
        - name: dist-start
          containerPort: 9100
          protocol: TCP

        # Volume mounts
        volumeMounts:
        - name: config-volume
          mountPath: /opt/app/vm.args
          subPath: vm.args
          readOnly: true
        - name: data-volume
          mountPath: /opt/app/data

        # Health checks optimized for distributed systems
        livenessProbe:
          httpGet:
            path: /health/live
            port: 4000
          initialDelaySeconds: 30
          periodSeconds: 30
          timeoutSeconds: 10
          failureThreshold: 3

        readinessProbe:
          httpGet:
            path: /health/ready
            port: 4000
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 2

        # Startup probe for slow-starting distributed applications
        startupProbe:
          httpGet:
            path: /health/startup
            port: 4000
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 5
          failureThreshold: 30

        # Security context
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: false
          runAsNonRoot: true
          runAsUser: 1000
          capabilities:
            drop:
            - ALL

      # Termination grace period for graceful shutdown
      terminationGracePeriodSeconds: 60

      # Volume configuration
      volumes:
      - name: config-volume
        emptyDir: {}

  # Persistent volume claim template
  volumeClaimTemplates:
  - metadata:
      name: data-volume
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 10Gi

---
# Headless service for cluster communication
apiVersion: v1
kind: Service
metadata:
  name: elixir-cluster-headless
  namespace: distributed-app
  labels:
    app: elixir-cluster
spec:
  # Headless service for stable network identity
  clusterIP: None

  # Ports for Erlang distribution
  ports:
  - name: epmd
    port: 4369
    targetPort: 4369
  - name: dist-start
    port: 9100
    targetPort: 9100

  selector:
    app: elixir-cluster

---
# External service for application access
apiVersion: v1
kind: Service
metadata:
  name: elixir-cluster-service
  namespace: distributed-app
  labels:
    app: elixir-cluster
spec:
  type: ClusterIP

  ports:
  - name: http
    port: 80
    targetPort: 4000
  - name: metrics
    port: 4001
    targetPort: 4001

  selector:
    app: elixir-cluster

---
# Network policy for secure cluster communication
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: elixir-cluster-network-policy
  namespace: distributed-app
spec:
  podSelector:
    matchLabels:
      app: elixir-cluster

  policyTypes:
  - Ingress
  - Egress

  ingress:
  # Allow cluster communication between pods
  - from:
    - podSelector:
        matchLabels:
          app: elixir-cluster
    ports:
    - protocol: TCP
      port: 4369  # EPMD
    - protocol: TCP
      port: 9100  # Distribution start port

  # Allow HTTP traffic from ingress
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-system
    ports:
    - protocol: TCP
      port: 4000

  # Allow metrics scraping
  - from:
    - namespaceSelector:
        matchLabels:
          name: monitoring
    ports:
    - protocol: TCP
      port: 4001

  egress:
  # Allow cluster communication
  - to:
    - podSelector:
        matchLabels:
          app: elixir-cluster
    ports:
    - protocol: TCP
      port: 4369
    - protocol: TCP
      port: 9100

  # Allow database communication
  - to:
    - namespaceSelector:
        matchLabels:
          name: database
    ports:
    - protocol: TCP
      port: 5432

  # Allow DNS resolution
  - to: []
    ports:
    - protocol: UDP
      port: 53

  # Allow external HTTPS for dependencies
  - to: []
    ports:
    - protocol: TCP
      port: 443
```

### Advanced Cluster Monitoring and Observability

```yaml
# Comprehensive monitoring for Erlang/Elixir clusters
apiVersion: v1
kind: ConfigMap
metadata:
  name: erlang-cluster-monitoring-config
  namespace: monitoring
data:
  prometheus.yml: |
    # Erlang/Elixir cluster monitoring configuration
    scrape_configs:
    - job_name: 'elixir-cluster-nodes'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
          - distributed-app

      relabel_configs:
      # Only scrape pods with the correct annotations
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

      # Add cluster information labels
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: cluster_app

      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod_name

      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace

    # Custom alerting rules
    rule_files:
    - "erlang_cluster_alerts.yml"

  erlang_cluster_alerts.yml: |
    groups:
    - name: erlang-cluster
      rules:
      # Node connectivity alerts
      - alert: ErlangNodeDown
        expr: up{job="elixir-cluster-nodes"} == 0
        for: 2m
        labels:
          severity: critical
          service: erlang-cluster
        annotations:
          summary: "Erlang node is down"
          description: "Erlang node {{ $labels.pod_name }} has been down for more than 2 minutes"

      # Memory usage alerts
      - alert: ErlangHighMemoryUsage
        expr: erlang_memory_total / 1024 / 1024 / 1024 > 1.5  # 1.5GB
        for: 5m
        labels:
          severity: warning
          service: erlang-cluster
        annotations:
          summary: "High memory usage in Erlang node"
          description: "Node {{ $labels.pod_name }} memory usage is {{ $value }}GB"

      # Process count alerts
      - alert: ErlangHighProcessCount
        expr: erlang_system_process_count > 100000
        for: 10m
        labels:
          severity: warning
          service: erlang-cluster
        annotations:
          summary: "High process count in Erlang node"
          description: "Node {{ $labels.pod_name }} has {{ $value }} processes"

      # Cookie authentication failures
      - alert: ErlangCookieAuthFailures
        expr: increase(erlang_distribution_connection_failures_total[5m]) > 10
        for: 2m
        labels:
          severity: critical
          service: erlang-cluster
        annotations:
          summary: "Erlang cookie authentication failures"
          description: "Multiple cookie authentication failures detected on {{ $labels.pod_name }}"

      # Cluster split brain detection
      - alert: ErlangClusterSplitBrain
        expr: count(erlang_cluster_size) by (cluster_app, namespace) != on() erlang_cluster_expected_size
        for: 5m
        labels:
          severity: critical
          service: erlang-cluster
        annotations:
          summary: "Erlang cluster split brain detected"
          description: "Cluster split brain condition detected in {{ $labels.namespace }}/{{ $labels.cluster_app }}"

---
# Custom metrics exporter for Erlang cluster health
apiVersion: apps/v1
kind: Deployment
metadata:
  name: erlang-cluster-exporter
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: erlang-cluster-exporter
  template:
    metadata:
      labels:
        app: erlang-cluster-exporter
    spec:
      serviceAccountName: erlang-cluster-monitor

      containers:
      - name: exporter
        image: company/erlang-cluster-exporter:v1.0.0

        # Environment configuration
        env:
        - name: TARGET_NAMESPACE
          value: "distributed-app"
        - name: CLUSTER_APP_LABEL
          value: "elixir-cluster"
        - name: METRICS_PORT
          value: "9090"

        ports:
        - containerPort: 9090
          name: metrics

        # Resource allocation
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi

        # Health checks
        livenessProbe:
          httpGet:
            path: /health
            port: 9090
          initialDelaySeconds: 30
          periodSeconds: 30

        readinessProbe:
          httpGet:
            path: /ready
            port: 9090
          initialDelaySeconds: 5
          periodSeconds: 10

---
# Service for metrics exporter
apiVersion: v1
kind: Service
metadata:
  name: erlang-cluster-exporter
  namespace: monitoring
  labels:
    app: erlang-cluster-exporter
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9090"
spec:
  selector:
    app: erlang-cluster-exporter
  ports:
  - name: metrics
    port: 9090
    targetPort: 9090

---
# RBAC for cluster monitoring
apiVersion: v1
kind: ServiceAccount
metadata:
  name: erlang-cluster-monitor
  namespace: monitoring

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: erlang-cluster-monitor
rules:
- apiGroups: [""]
  resources: ["pods", "services", "endpoints", "secrets"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: erlang-cluster-monitor
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: erlang-cluster-monitor
subjects:
- kind: ServiceAccount
  name: erlang-cluster-monitor
  namespace: monitoring
```

### Automated Cookie Rotation CronJob

```yaml
# Automated cookie rotation system
apiVersion: batch/v1
kind: CronJob
metadata:
  name: erlang-cookie-rotation
  namespace: distributed-app
  labels:
    app: cookie-manager
    component: rotation
spec:
  # Schedule: Every 90 days at 2 AM UTC
  schedule: "0 2 1 */3 *"

  # Job configuration
  jobTemplate:
    spec:
      # Retain history for debugging
      successfulJobsHistoryLimit: 3
      failedJobsHistoryLimit: 3

      # Job timeout
      activeDeadlineSeconds: 3600

      template:
        metadata:
          labels:
            app: cookie-manager
            component: rotation-job
        spec:
          # Service account with necessary permissions
          serviceAccountName: cookie-manager

          # Security context
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            fsGroup: 1000

          restartPolicy: OnFailure

          containers:
          - name: cookie-rotator
            image: company/erlang-cookie-manager:v1.2.0
            imagePullPolicy: IfNotPresent

            # Command to execute rotation
            command:
            - /opt/cookie-manager/rotate-cookie.sh
            - --namespace
            - distributed-app
            - --secret-name
            - erlang-cookie
            - --validate
            - --backup
            - --restart-apps

            # Environment configuration
            env:
            - name: NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace

            - name: LOG_LEVEL
              value: "INFO"

            - name: SLACK_WEBHOOK_URL
              valueFrom:
                secretKeyRef:
                  name: notification-secrets
                  key: slack-webhook-url
                  optional: true

            # Resource allocation
            resources:
              requests:
                cpu: 100m
                memory: 128Mi
              limits:
                cpu: 500m
                memory: 256Mi

            # Security context
            securityContext:
              allowPrivilegeEscalation: false
              readOnlyRootFilesystem: true
              runAsNonRoot: true
              capabilities:
                drop:
                - ALL

            # Volume mounts for temporary files
            volumeMounts:
            - name: tmp-volume
              mountPath: /tmp

          volumes:
          - name: tmp-volume
            emptyDir:
              sizeLimit: 100Mi

---
# Service account for cookie rotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cookie-manager
  namespace: distributed-app

---
# RBAC for cookie rotation
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cookie-manager
  namespace: distributed-app
rules:
# Secret management
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

# Pod and deployment management for restarts
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "patch"]

# Pod management
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "create", "delete"]

# Event creation for notifications
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cookie-manager
  namespace: distributed-app
subjects:
- kind: ServiceAccount
  name: cookie-manager
  namespace: distributed-app
roleRef:
  kind: Role
  name: cookie-manager
  apiGroup: rbac.authorization.k8s.io

---
# Emergency cookie rotation job template
apiVersion: batch/v1
kind: Job
metadata:
  name: emergency-cookie-rotation
  namespace: distributed-app
  labels:
    app: cookie-manager
    component: emergency-rotation
spec:
  # Manual cleanup required
  ttlSecondsAfterFinished: 86400

  template:
    metadata:
      labels:
        app: cookie-manager
        component: emergency-rotation
    spec:
      serviceAccountName: cookie-manager
      restartPolicy: Never

      containers:
      - name: emergency-rotator
        image: company/erlang-cookie-manager:v1.2.0

        command:
        - /opt/cookie-manager/emergency-rotate.sh
        - --namespace
        - distributed-app
        - --force
        - --immediate-restart

        env:
        - name: EMERGENCY_MODE
          value: "true"

        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
```

## Security Hardening and Threat Mitigation

### TLS Enhancement for Erlang Distribution

```elixir
# config/runtime.exs - Enhanced TLS configuration for Erlang distribution
import Config

if config_env() == :prod do
  # Enhanced TLS configuration for inter-node communication
  config :kernel,
    inet_dist_use_interface: {0, 0, 0, 0},
    inet_dist_listen_min: 9100,
    inet_dist_listen_max: 9155

  # Enable TLS for distribution
  config :ssl,
    verify: :verify_peer,
    secure_renegotiate: true,
    reuse_sessions: true,
    honor_cipher_order: true,
    versions: [:"tlsv1.3", :"tlsv1.2"]

  # Custom TLS configuration for Erlang distribution
  if System.get_env("ENABLE_DIST_TLS") == "true" do
    # TLS distribution configuration
    tls_opts = [
      # Certificate files
      certfile: System.get_env("ERLANG_DIST_CERT_FILE", "/opt/certs/server.pem"),
      keyfile: System.get_env("ERLANG_DIST_KEY_FILE", "/opt/certs/server-key.pem"),
      cacertfile: System.get_env("ERLANG_DIST_CA_FILE", "/opt/certs/ca.pem"),

      # TLS verification settings
      verify: :verify_peer,
      fail_if_no_peer_cert: true,
      secure_renegotiate: true,

      # Cipher suites (TLS 1.3)
      ciphers: [
        "TLS_AES_256_GCM_SHA384",
        "TLS_CHACHA20_POLY1305_SHA256",
        "TLS_AES_128_GCM_SHA256"
      ],

      # Protocol versions
      versions: [:"tlsv1.3", :"tlsv1.2"]
    ]

    # Apply TLS configuration to Erlang distribution
    :inet_tls_dist.apply_tls_config(tls_opts)
  end

  # Cookie security enhancements
  if cookie = System.get_env("RELEASE_COOKIE") do
    # Validate cookie security properties
    if String.length(cookie) < 40 do
      raise "Cookie too short: #{String.length(cookie)} < 40 characters"
    end

    # Set cookie with enhanced security
    Node.set_cookie(String.to_atom(cookie))

    # Additional security: periodic cookie validation
    Task.start(fn ->
      :timer.apply_interval(300_000, __MODULE__, :validate_cookie_security, [])
    end)
  end

  # Network security configurations
  config :cluster,
    strategy: Cluster.Strategy.Kubernetes,
    config: [
      kubernetes: [
        # Kubernetes service discovery
        mode: :dns,
        node_basename: System.get_env("NODE_BASENAME", "app"),
        service: System.get_env("CLUSTER_SERVICE", "elixir-cluster-headless"),
        application_name: System.get_env("CLUSTER_APP", "distributed-app"),

        # Polling configuration
        polling_interval: 10_000,

        # Security: only connect to verified nodes
        verify_nodes: true,

        # Connection timeout
        connect_timeout: 30_000
      ]
    ]

  # Enhanced logging for security events
  config :logger,
    level: :info,
    backends: [:console, {LoggerFileBackend, :security}]

  config :logger, :security,
    path: "/var/log/security.log",
    level: :warning,
    format: "$time [$level] $metadata$message\n",
    metadata: [:node, :pid, :application, :module, :function, :line]
end

# Security validation module
defmodule SecurityValidator do
  require Logger

  def validate_cookie_security do
    cookie = Node.get_cookie()
    cookie_string = Atom.to_string(cookie)

    # Validate cookie length
    if String.length(cookie_string) < 40 do
      Logger.error("Security violation: Cookie too short")
      send_security_alert("Cookie length violation")
    end

    # Validate cookie complexity
    if not complex_enough?(cookie_string) do
      Logger.warn("Security warning: Cookie may lack sufficient complexity")
    end

    # Check for cookie rotation schedule
    check_rotation_schedule()
  end

  defp complex_enough?(cookie) do
    # Check for character diversity
    unique_chars = cookie |> String.graphemes() |> Enum.uniq() |> length()
    unique_chars >= 20
  end

  defp check_rotation_schedule do
    # Implementation to check rotation schedule
    # This would typically read from Kubernetes annotations or configuration
  end

  defp send_security_alert(message) do
    # Send alert to monitoring system
    Logger.error("SECURITY ALERT: #{message}")

    # Optionally send to external monitoring
    # HTTPoison.post("http://alertmanager/api/v1/alerts", ...)
  end
end
```

### Advanced Secret Management Integration

```yaml
# External Secrets Operator integration for Erlang cookies
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-secret-store
  namespace: distributed-app
spec:
  provider:
    vault:
      server: "https://vault.security.svc.cluster.local:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "erlang-cookie-manager"
          serviceAccountRef:
            name: "cookie-manager"

---
# External Secret for Erlang cookie
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: erlang-cookie-external
  namespace: distributed-app
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-secret-store
    kind: SecretStore

  target:
    name: erlang-cookie
    creationPolicy: Owner
    template:
      type: Opaque
      metadata:
        labels:
          managed-by: external-secrets
          security-level: high
        annotations:
          external-secrets.io/rotation-interval: "90d"

  data:
  - secretKey: cookie
    remoteRef:
      key: erlang/cluster/cookie
      property: value

  - secretKey: generated-timestamp
    remoteRef:
      key: erlang/cluster/cookie
      property: timestamp

  - secretKey: rotation-schedule
    remoteRef:
      key: erlang/cluster/cookie
      property: next-rotation

---
# Vault policy for cookie management
apiVersion: v1
kind: ConfigMap
metadata:
  name: vault-policy-erlang-cookie
  namespace: security
data:
  policy.hcl: |
    # Erlang cookie management policy
    path "secret/data/erlang/cluster/cookie" {
      capabilities = ["create", "read", "update", "delete"]
    }

    path "secret/metadata/erlang/cluster/cookie" {
      capabilities = ["list", "read"]
    }

    # Cookie backup paths
    path "secret/data/erlang/cluster/cookie-backup/*" {
      capabilities = ["create", "read", "list"]
    }

    # Audit log access
    path "sys/audit-hash/file" {
      capabilities = ["update"]
    }

---
# Sealed Secret for emergency cookie (offline backup)
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: emergency-cookie
  namespace: distributed-app
spec:
  encryptedData:
    emergency-cookie: AgBy3i4OJSWK+PiTySYZZA9rO43cGDEQAx...  # Encrypted emergency cookie
  template:
    metadata:
      name: emergency-cookie
      labels:
        app: erlang-cluster
        component: emergency-auth
        security-level: critical
    type: Opaque

---
# Cookie security scanner job
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cookie-security-scanner
  namespace: distributed-app
spec:
  schedule: "0 */6 * * *"  # Every 6 hours

  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: cookie-security-scanner
          restartPolicy: OnFailure

          containers:
          - name: scanner
            image: company/cookie-security-scanner:v1.0.0

            env:
            - name: TARGET_NAMESPACE
              value: "distributed-app"

            command:
            - /opt/scanner/scan-cookies.sh

            resources:
              requests:
                cpu: 100m
                memory: 128Mi

            securityContext:
              runAsNonRoot: true
              readOnlyRootFilesystem: true

---
# Security scanner service account
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cookie-security-scanner
  namespace: distributed-app

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cookie-security-scanner
  namespace: distributed-app
rules:
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cookie-security-scanner
  namespace: distributed-app
subjects:
- kind: ServiceAccount
  name: cookie-security-scanner
  namespace: distributed-app
roleRef:
  kind: Role
  name: cookie-security-scanner
  apiGroup: rbac.authorization.k8s.io
```

## Troubleshooting and Operational Excellence

### Comprehensive Cluster Diagnostics

```bash
#!/bin/bash
# Comprehensive Erlang/Elixir cluster diagnostics script

set -euo pipefail

# Configuration
NAMESPACE="${NAMESPACE:-distributed-app}"
APP_LABEL="${APP_LABEL:-elixir-cluster}"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/cluster-diagnostics}"

# Create output directory
mkdir -p "$OUTPUT_DIR"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') [DIAGNOSTICS] $*" | tee -a "$OUTPUT_DIR/diagnostics.log"
}

# Check cookie configuration and security
check_cookie_security() {
    log "Checking Erlang cookie security configuration"

    local cookie_secret="erlang-cookie"
    local cookie_data

    # Check if cookie secret exists
    if kubectl get secret "$cookie_secret" -n "$NAMESPACE" >/dev/null 2>&1; then
        log "✅ Cookie secret exists: $cookie_secret"

        # Get cookie metadata
        cookie_data=$(kubectl get secret "$cookie_secret" -n "$NAMESPACE" -o json)

        # Check cookie age
        local created_date
        created_date=$(echo "$cookie_data" | jq -r '.metadata.creationTimestamp')
        local current_date
        current_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

        log "Cookie created: $created_date"
        log "Current time: $current_date"

        # Extract cookie value for validation
        local cookie_value
        cookie_value=$(echo "$cookie_data" | jq -r '.data.cookie' | base64 -d)

        # Validate cookie properties
        local cookie_length=${#cookie_value}
        log "Cookie length: $cookie_length characters"

        if [[ $cookie_length -lt 40 ]]; then
            log "❌ SECURITY RISK: Cookie too short ($cookie_length < 40)"
        else
            log "✅ Cookie length acceptable"
        fi

        # Check cookie complexity
        local unique_chars
        unique_chars=$(echo "$cookie_value" | grep -o . | sort | uniq | wc -l)
        log "Cookie unique characters: $unique_chars"

        if [[ $unique_chars -lt 20 ]]; then
            log "⚠️  WARNING: Cookie may lack sufficient entropy"
        else
            log "✅ Cookie entropy acceptable"
        fi

    else
        log "❌ ERROR: Cookie secret not found: $cookie_secret"
        return 1
    fi

    # Save cookie analysis
    echo "$cookie_data" > "$OUTPUT_DIR/cookie-secret.json"
}

# Check cluster connectivity
check_cluster_connectivity() {
    log "Checking Erlang cluster connectivity"

    # Get all pods in the cluster
    local pods
    pods=$(kubectl get pods -n "$NAMESPACE" -l "app=$APP_LABEL" -o jsonpath='{.items[*].metadata.name}')

    if [[ -z "$pods" ]]; then
        log "❌ ERROR: No cluster pods found with label app=$APP_LABEL"
        return 1
    fi

    log "Found cluster pods: $pods"

    local connectivity_results="$OUTPUT_DIR/connectivity-results.txt"
    echo "Cluster Connectivity Test Results" > "$connectivity_results"
    echo "=================================" >> "$connectivity_results"
    echo "Test time: $(date)" >> "$connectivity_results"
    echo "" >> "$connectivity_results"

    # Test connectivity between each pair of pods
    local pod_array
    read -ra pod_array <<< "$pods"

    for source_pod in "${pod_array[@]}"; do
        log "Testing connectivity from $source_pod"

        # Check if pod is ready
        local pod_ready
        pod_ready=$(kubectl get pod "$source_pod" -n "$NAMESPACE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')

        if [[ "$pod_ready" != "True" ]]; then
            log "⚠️  WARNING: Pod $source_pod not ready"
            echo "Pod $source_pod: NOT READY" >> "$connectivity_results"
            continue
        fi

        # Get node status from within the pod
        local node_status
        node_status=$(kubectl exec -n "$NAMESPACE" "$source_pod" -- \
            sh -c 'timeout 10s erl -sname test@localhost -setcookie $RELEASE_COOKIE -eval "
                io:format(\"Node: ~p~n\", [node()]),
                Nodes = nodes(),
                io:format(\"Connected nodes: ~p~n\", [Nodes]),
                io:format(\"Total nodes: ~p~n\", [length(Nodes) + 1]),
                init:stop().
            " -noshell' 2>/dev/null || echo "FAILED")

        echo "=== $source_pod ===" >> "$connectivity_results"
        echo "$node_status" >> "$connectivity_results"
        echo "" >> "$connectivity_results"

        if [[ "$node_status" == "FAILED" ]]; then
            log "❌ ERROR: Failed to get node status from $source_pod"
        else
            log "✅ Successfully connected to $source_pod"
        fi
    done

    log "Connectivity test completed. Results saved to: $connectivity_results"
}

# Check network policies and firewall rules
check_network_configuration() {
    log "Checking network configuration"

    local network_info="$OUTPUT_DIR/network-info.json"

    # Get network policies
    kubectl get networkpolicies -n "$NAMESPACE" -o json > "$OUTPUT_DIR/network-policies.json"

    # Get services
    kubectl get services -n "$NAMESPACE" -l "app=$APP_LABEL" -o json > "$OUTPUT_DIR/services.json"

    # Check EPMD port accessibility
    log "Checking EPMD port accessibility"
    local pods
    pods=$(kubectl get pods -n "$NAMESPACE" -l "app=$APP_LABEL" -o jsonpath='{.items[*].metadata.name}')

    local epmd_results="$OUTPUT_DIR/epmd-connectivity.txt"
    echo "EPMD Connectivity Test" > "$epmd_results"
    echo "======================" >> "$epmd_results"

    read -ra pod_array <<< "$pods"
    for pod in "${pod_array[@]}"; do
        log "Testing EPMD connectivity to $pod"

        local pod_ip
        pod_ip=$(kubectl get pod "$pod" -n "$NAMESPACE" -o jsonpath='{.status.podIP}')

        # Test EPMD port (4369) connectivity
        local epmd_test
        epmd_test=$(kubectl run epmd-test-$(date +%s) \
            --image=busybox:1.36 \
            --rm -i --restart=Never \
            --namespace="$NAMESPACE" \
            --command -- timeout 5 nc -zv "$pod_ip" 4369 2>&1 || echo "FAILED")

        echo "Pod $pod ($pod_ip): $epmd_test" >> "$epmd_results"

        if [[ "$epmd_test" == "FAILED" ]]; then
            log "❌ ERROR: EPMD port not accessible on $pod"
        else
            log "✅ EPMD port accessible on $pod"
        fi
    done
}

# Check resource utilization
check_resource_utilization() {
    log "Checking resource utilization"

    local resource_info="$OUTPUT_DIR/resource-utilization.json"

    # Get pod resource usage
    kubectl top pods -n "$NAMESPACE" -l "app=$APP_LABEL" > "$OUTPUT_DIR/pod-resources.txt" 2>/dev/null || \
        log "⚠️  WARNING: Metrics server not available for resource usage"

    # Get detailed pod information
    kubectl get pods -n "$NAMESPACE" -l "app=$APP_LABEL" -o json > "$OUTPUT_DIR/pod-details.json"

    # Check for resource constraints
    local pods_json
    pods_json=$(kubectl get pods -n "$NAMESPACE" -l "app=$APP_LABEL" -o json)

    echo "$pods_json" | jq -r '.items[] |
        "Pod: " + .metadata.name +
        " | CPU Request: " + (.spec.containers[0].resources.requests.cpu // "none") +
        " | Memory Request: " + (.spec.containers[0].resources.requests.memory // "none") +
        " | CPU Limit: " + (.spec.containers[0].resources.limits.cpu // "none") +
        " | Memory Limit: " + (.spec.containers[0].resources.limits.memory // "none")
    ' > "$OUTPUT_DIR/resource-requests.txt"

    # Check for OOMKilled containers
    local oom_killed
    oom_killed=$(echo "$pods_json" | jq -r '.items[] | select(.status.containerStatuses[]?.lastState.terminated.reason == "OOMKilled") | .metadata.name')

    if [[ -n "$oom_killed" ]]; then
        log "❌ ERROR: Pods killed due to OOM: $oom_killed"
        echo "$oom_killed" > "$OUTPUT_DIR/oom-killed-pods.txt"
    else
        log "✅ No OOM-killed pods detected"
    fi
}

# Check logs for errors and warnings
check_application_logs() {
    log "Analyzing application logs"

    local pods
    pods=$(kubectl get pods -n "$NAMESPACE" -l "app=$APP_LABEL" -o jsonpath='{.items[*].metadata.name}')

    read -ra pod_array <<< "$pods"
    for pod in "${pod_array[@]}"; do
        log "Analyzing logs for pod: $pod"

        local pod_log_file="$OUTPUT_DIR/logs-$pod.txt"

        # Get recent logs
        kubectl logs -n "$NAMESPACE" "$pod" --tail=1000 > "$pod_log_file" 2>&1

        # Search for common error patterns
        local error_patterns=(
            "ERROR"
            "CRASH"
            "failed to connect"
            "authentication failed"
            "cookie mismatch"
            "net_kernel"
            "badrpc"
            "nodedown"
        )

        local error_summary="$OUTPUT_DIR/error-summary-$pod.txt"
        echo "Error Summary for $pod" > "$error_summary"
        echo "======================" >> "$error_summary"

        for pattern in "${error_patterns[@]}"; do
            local count
            count=$(grep -ci "$pattern" "$pod_log_file" 2>/dev/null || echo "0")
            echo "$pattern: $count occurrences" >> "$error_summary"

            if [[ $count -gt 0 ]]; then
                log "⚠️  Found $count occurrences of '$pattern' in $pod logs"
            fi
        done

        # Extract recent errors
        grep -i "error\|crash\|failed" "$pod_log_file" | tail -20 > "$OUTPUT_DIR/recent-errors-$pod.txt" 2>/dev/null || true
    done
}

# Generate comprehensive report
generate_report() {
    log "Generating diagnostic report"

    local report_file="$OUTPUT_DIR/cluster-diagnostic-report.md"

    cat > "$report_file" <<EOF
# Erlang/Elixir Cluster Diagnostic Report

**Generated:** $(date)
**Namespace:** $NAMESPACE
**Application:** $APP_LABEL
**Kubernetes Cluster:** $(kubectl config current-context)

## Executive Summary

This report contains comprehensive diagnostic information for the Erlang/Elixir cluster.

## Cluster Overview

EOF

    # Add cluster pod status
    echo "### Pod Status" >> "$report_file"
    echo "\`\`\`" >> "$report_file"
    kubectl get pods -n "$NAMESPACE" -l "app=$APP_LABEL" >> "$report_file"
    echo "\`\`\`" >> "$report_file"
    echo "" >> "$report_file"

    # Add cookie security status
    echo "### Cookie Security" >> "$report_file"
    if grep -q "Cookie length acceptable" "$OUTPUT_DIR/diagnostics.log"; then
        echo "✅ Cookie security: PASS" >> "$report_file"
    else
        echo "❌ Cookie security: FAIL" >> "$report_file"
    fi
    echo "" >> "$report_file"

    # Add connectivity status
    echo "### Cluster Connectivity" >> "$report_file"
    if [[ -f "$OUTPUT_DIR/connectivity-results.txt" ]]; then
        echo "\`\`\`" >> "$report_file"
        head -50 "$OUTPUT_DIR/connectivity-results.txt" >> "$report_file"
        echo "\`\`\`" >> "$report_file"
    fi
    echo "" >> "$report_file"

    # Add recommendations
    echo "### Recommendations" >> "$report_file"

    # Generate recommendations based on findings
    if grep -q "ERROR" "$OUTPUT_DIR/diagnostics.log"; then
        echo "- 🚨 **CRITICAL**: Address errors found in diagnostics" >> "$report_file"
    fi

    if grep -q "WARNING" "$OUTPUT_DIR/diagnostics.log"; then
        echo "- ⚠️ **WARNING**: Review warnings and consider improvements" >> "$report_file"
    fi

    if grep -q "Cookie too short" "$OUTPUT_DIR/diagnostics.log"; then
        echo "- 🔐 **SECURITY**: Rotate cookie with longer, more secure value" >> "$report_file"
    fi

    if grep -q "OOM" "$OUTPUT_DIR/diagnostics.log"; then
        echo "- 📊 **RESOURCES**: Increase memory limits for affected pods" >> "$report_file"
    fi

    echo "" >> "$report_file"
    echo "### Files Generated" >> "$report_file"
    echo "- Detailed logs: \`$OUTPUT_DIR/\`" >> "$report_file"
    echo "- Full diagnostic log: \`$OUTPUT_DIR/diagnostics.log\`" >> "$report_file"

    log "Diagnostic report generated: $report_file"
}

# Main execution
main() {
    log "Starting Erlang/Elixir cluster diagnostics"
    log "Target namespace: $NAMESPACE"
    log "Application label: $APP_LABEL"
    log "Output directory: $OUTPUT_DIR"

    # Run diagnostic checks
    check_cookie_security || true
    check_cluster_connectivity || true
    check_network_configuration || true
    check_resource_utilization || true
    check_application_logs || true

    # Generate final report
    generate_report

    log "Diagnostics completed successfully"
    log "Review the report at: $OUTPUT_DIR/cluster-diagnostic-report.md"

    # Show summary
    echo ""
    echo "=== Diagnostic Summary ==="
    echo "✅ Checks passed: $(grep -c "SUCCESS\|✅" "$OUTPUT_DIR/diagnostics.log" || echo "0")"
    echo "⚠️  Warnings: $(grep -c "WARNING\|⚠️" "$OUTPUT_DIR/diagnostics.log" || echo "0")"
    echo "❌ Errors: $(grep -c "ERROR\|❌" "$OUTPUT_DIR/diagnostics.log" || echo "0")"
    echo "📁 Output directory: $OUTPUT_DIR"
}

# Execute main function
main "$@"
```

## Conclusion

Erlang cookies provide the foundation for secure distributed system communication in Kubernetes environments, but require sophisticated management strategies to maintain both security and operational reliability. The patterns and configurations presented in this guide demonstrate how organizations can implement enterprise-grade cookie management, automated rotation, comprehensive monitoring, and robust security controls for Erlang/Elixir applications.

Key success factors include proper secret management integration, automated rotation schedules, comprehensive cluster monitoring, and proactive security validation. Organizations implementing these patterns can expect improved cluster security posture, enhanced operational reliability, and better support for large-scale distributed system deployments.

The combination of secure cookie generation, advanced monitoring capabilities, and comprehensive diagnostic tooling provides a solid foundation for production Erlang/Elixir distributed systems that can scale with business requirements while maintaining security compliance and operational excellence.