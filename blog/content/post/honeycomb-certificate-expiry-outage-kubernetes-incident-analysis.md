---
title: "Honeycomb Certificate Expiry Outage: 2.5-Hour Production Incident Analysis"
date: 2026-08-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Certificate Management", "Production Incidents", "cert-manager", "PKI", "Monitoring", "Automation"]
categories: ["Kubernetes", "Security", "Incident Response"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Honeycomb's 2.5-hour production outage caused by expired Kubernetes API certificates, with comprehensive strategies for certificate lifecycle management, monitoring, and automation."
more_link: "yes"
url: "/honeycomb-certificate-expiry-outage-kubernetes-incident-analysis/"
---

On April 27, 2022, Honeycomb experienced a 2.5-hour production outage that affected their entire Kubernetes infrastructure. The root cause was deceptively simple: expired certificates for the Kubernetes API server. This incident highlights a critical blindspot in many production Kubernetes deployments—certificate lifecycle management. In this comprehensive analysis, we'll examine the incident, its root causes, and implement production-ready solutions to prevent similar failures.

<!--more-->

## Executive Summary

Certificate expiry is one of the most preventable yet common causes of production outages in Kubernetes environments. Despite being a known issue, organizations continue to face severe disruptions due to inadequate certificate monitoring and renewal processes. This post provides a complete framework for managing certificate lifecycles in production Kubernetes clusters, including automated renewal, comprehensive monitoring, and disaster recovery procedures.

## The Incident Timeline

### Initial Detection (T+0 minutes)

At 14:23 UTC on April 27, 2022, Honeycomb's monitoring systems began alerting on widespread API server failures across their production Kubernetes clusters. Multiple services simultaneously lost connectivity to the Kubernetes API, triggering cascading failures throughout their infrastructure.

```bash
# Initial error messages observed in kubelet logs
Apr 27 14:23:15 node-1 kubelet[1234]: E0427 14:23:15.123456    1234 reflector.go:138]
k8s.io/client-go/informers/factory.go:134: Failed to watch *v1.Pod:
failed to list *v1.Pod: Get "https://api.k8s.cluster.local:6443/api/v1/pods":
x509: certificate has expired or is not yet valid

Apr 27 14:23:15 node-1 kubelet[1234]: E0427 14:23:15.234567    1234 kubelet.go:2347]
node "node-1" not found

Apr 27 14:23:15 node-1 kubelet[1234]: E0427 14:23:15.345678    1234 kubelet_node_status.go:92]
Unable to register node "node-1" with API server: Post "https://api.k8s.cluster.local:6443/api/v1/nodes":
x509: certificate has expired or is not yet valid
```

### Root Cause Identification (T+15 minutes)

The incident response team quickly identified that the Kubernetes API server certificates had expired. The certificates had a 365-day validity period and had been issued exactly one year prior during the initial cluster setup.

```bash
# Checking certificate expiry on the API server
$ openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -dates
notBefore=Apr 27 14:00:00 2021 GMT
notAfter=Apr 27 14:00:00 2022 GMT

# Current time was past the expiry
$ date -u
Wed Apr 27 14:23:00 UTC 2022
```

### Recovery Process (T+15 to T+150 minutes)

The recovery process involved:

1. Emergency certificate renewal on all control plane nodes
2. Restarting kube-apiserver pods to load new certificates
3. Verifying cluster health and service restoration
4. Validating that all workloads resumed normal operation

## Understanding Kubernetes Certificate Architecture

Before implementing solutions, it's critical to understand the complete certificate landscape in a Kubernetes cluster.

### Certificate Types and Purposes

```yaml
# Complete Kubernetes PKI certificate inventory
Cluster CA:
  - /etc/kubernetes/pki/ca.crt
  - /etc/kubernetes/pki/ca.key
  Purpose: Root CA for all cluster certificates
  Used by: All Kubernetes components
  Typical validity: 10 years

API Server Certificates:
  - /etc/kubernetes/pki/apiserver.crt
  - /etc/kubernetes/pki/apiserver.key
  Purpose: API server TLS serving certificate
  Used by: kube-apiserver
  Typical validity: 1 year

  - /etc/kubernetes/pki/apiserver-kubelet-client.crt
  - /etc/kubernetes/pki/apiserver-kubelet-client.key
  Purpose: Client certificate for API server to kubelet communication
  Used by: kube-apiserver -> kubelet
  Typical validity: 1 year

Kubelet Certificates:
  - /var/lib/kubelet/pki/kubelet-client-current.pem
  Purpose: Kubelet client certificate for API communication
  Used by: kubelet -> kube-apiserver
  Typical validity: 1 year (auto-renewed)

  - /var/lib/kubelet/pki/kubelet.crt
  - /var/lib/kubelet/pki/kubelet.key
  Purpose: Kubelet serving certificate
  Used by: kube-apiserver -> kubelet, kubectl logs/exec
  Typical validity: 1 year

Front Proxy Certificates:
  - /etc/kubernetes/pki/front-proxy-ca.crt
  - /etc/kubernetes/pki/front-proxy-ca.key
  Purpose: CA for front proxy
  Used by: Extension API servers
  Typical validity: 10 years

  - /etc/kubernetes/pki/front-proxy-client.crt
  - /etc/kubernetes/pki/front-proxy-client.key
  Purpose: Client certificate for front proxy
  Used by: kube-apiserver
  Typical validity: 1 year

Etcd Certificates:
  - /etc/kubernetes/pki/etcd/ca.crt
  - /etc/kubernetes/pki/etcd/ca.key
  Purpose: Etcd cluster CA
  Used by: etcd cluster
  Typical validity: 10 years

  - /etc/kubernetes/pki/etcd/server.crt
  - /etc/kubernetes/pki/etcd/server.key
  Purpose: Etcd server certificate
  Used by: etcd
  Typical validity: 1 year

  - /etc/kubernetes/pki/etcd/peer.crt
  - /etc/kubernetes/pki/etcd/peer.key
  Purpose: Etcd peer communication
  Used by: etcd cluster members
  Typical validity: 1 year

  - /etc/kubernetes/pki/apiserver-etcd-client.crt
  - /etc/kubernetes/pki/apiserver-etcd-client.key
  Purpose: API server client certificate for etcd
  Used by: kube-apiserver -> etcd
  Typical validity: 1 year

Service Account Keys:
  - /etc/kubernetes/pki/sa.key
  - /etc/kubernetes/pki/sa.pub
  Purpose: Service account token signing
  Used by: kube-controller-manager, kube-apiserver
  Typical validity: Never expires (key pair)
```

### Certificate Dependency Map

```
┌─────────────────────────────────────────────────────────────┐
│                      Cluster CA (ca.crt)                     │
│                   (Root of Trust - 10 years)                 │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┬────────────────┐
        │               │               │                │
        ▼               ▼               ▼                ▼
┌──────────────┐ ┌─────────────┐ ┌──────────┐  ┌──────────────┐
│  apiserver   │ │ apiserver-  │ │ front-   │  │   Various    │
│  .crt        │ │ kubelet-    │ │ proxy-   │  │   kubelet    │
│  (1 year)    │ │ client.crt  │ │ client   │  │   certs      │
│              │ │  (1 year)   │ │ (1 year) │  │  (1 year)    │
└──────────────┘ └─────────────┘ └──────────┘  └──────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Etcd CA (etcd/ca.crt)                     │
│                         (10 years)                            │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┬────────────────┐
        │               │               │                │
        ▼               ▼               ▼                ▼
┌──────────────┐ ┌─────────────┐ ┌──────────┐  ┌──────────────┐
│ etcd/server  │ │ etcd/peer   │ │ apiserver│  │              │
│ .crt         │ │ .crt        │ │ -etcd-   │  │              │
│ (1 year)     │ │ (1 year)    │ │ client   │  │              │
│              │ │             │ │ (1 year) │  │              │
└──────────────┘ └─────────────┘ └──────────┘  └──────────────┘
```

## Comprehensive Certificate Audit Script

First, let's create a comprehensive script to audit all certificates in your cluster:

```bash
#!/bin/bash
# certificate-audit.sh - Comprehensive Kubernetes certificate auditing

set -euo pipefail

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Configuration
CERT_DIRS=(
  "/etc/kubernetes/pki"
  "/etc/kubernetes/pki/etcd"
  "/var/lib/kubelet/pki"
)

WARN_DAYS=30
CRITICAL_DAYS=7

# Output file
OUTPUT_FILE="/var/log/k8s-cert-audit-$(date +%Y%m%d-%H%M%S).json"

echo "Starting Kubernetes Certificate Audit - $(date)"
echo "================================================"
echo ""

# Function to check certificate expiry
check_cert() {
  local cert_file=$1
  local cert_name=$(basename "$cert_file")
  local cert_dir=$(dirname "$cert_file")

  if [[ ! -f "$cert_file" ]]; then
    return
  fi

  # Skip if not a certificate file
  if ! openssl x509 -in "$cert_file" -noout 2>/dev/null; then
    return
  fi

  # Get certificate details
  local not_after=$(openssl x509 -in "$cert_file" -noout -enddate | cut -d= -f2)
  local not_before=$(openssl x509 -in "$cert_file" -noout -startdate | cut -d= -f2)
  local subject=$(openssl x509 -in "$cert_file" -noout -subject | sed 's/subject=//')
  local issuer=$(openssl x509 -in "$cert_file" -noout -issuer | sed 's/issuer=//')
  local serial=$(openssl x509 -in "$cert_file" -noout -serial | cut -d= -f2)

  # Calculate days until expiry
  local expire_epoch=$(date -d "$not_after" +%s)
  local current_epoch=$(date +%s)
  local days_until_expiry=$(( ($expire_epoch - $current_epoch) / 86400 ))

  # Determine status
  local status="OK"
  local color=$GREEN

  if [[ $days_until_expiry -lt 0 ]]; then
    status="EXPIRED"
    color=$RED
  elif [[ $days_until_expiry -lt $CRITICAL_DAYS ]]; then
    status="CRITICAL"
    color=$RED
  elif [[ $days_until_expiry -lt $WARN_DAYS ]]; then
    status="WARNING"
    color=$YELLOW
  fi

  # Output results
  echo -e "${color}Certificate: $cert_file${NC}"
  echo "  Status: $status"
  echo "  Days Until Expiry: $days_until_expiry"
  echo "  Not Before: $not_before"
  echo "  Not After: $not_after"
  echo "  Subject: $subject"
  echo "  Issuer: $issuer"
  echo "  Serial: $serial"
  echo ""

  # JSON output for monitoring systems
  cat >> "$OUTPUT_FILE" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "certificate": "$cert_file",
  "status": "$status",
  "days_until_expiry": $days_until_expiry,
  "not_before": "$not_before",
  "not_after": "$not_after",
  "subject": "$subject",
  "issuer": "$issuer",
  "serial": "$serial"
}
EOF
}

# Function to check kubeconfig certificates
check_kubeconfig() {
  local kubeconfig=$1

  if [[ ! -f "$kubeconfig" ]]; then
    return
  fi

  echo "Checking kubeconfig: $kubeconfig"

  # Extract client certificate
  local cert_data=$(grep 'client-certificate-data' "$kubeconfig" | awk '{print $2}' | base64 -d)

  if [[ -n "$cert_data" ]]; then
    local not_after=$(echo "$cert_data" | openssl x509 -noout -enddate | cut -d= -f2)
    local expire_epoch=$(date -d "$not_after" +%s)
    local current_epoch=$(date +%s)
    local days_until_expiry=$(( ($expire_epoch - $current_epoch) / 86400 ))

    local status="OK"
    local color=$GREEN

    if [[ $days_until_expiry -lt 0 ]]; then
      status="EXPIRED"
      color=$RED
    elif [[ $days_until_expiry -lt $CRITICAL_DAYS ]]; then
      status="CRITICAL"
      color=$RED
    elif [[ $days_until_expiry -lt $WARN_DAYS ]]; then
      status="WARNING"
      color=$YELLOW
    fi

    echo -e "${color}  Client Certificate Status: $status${NC}"
    echo "  Days Until Expiry: $days_until_expiry"
    echo "  Not After: $not_after"
    echo ""
  fi
}

# Main execution
echo "=== Filesystem Certificate Check ==="
echo ""

for cert_dir in "${CERT_DIRS[@]}"; do
  if [[ -d "$cert_dir" ]]; then
    echo "Scanning directory: $cert_dir"
    echo "-----------------------------------"
    find "$cert_dir" -name "*.crt" -o -name "*.pem" | while read cert_file; do
      check_cert "$cert_file"
    done
  fi
done

echo "=== Kubeconfig Certificate Check ==="
echo ""

# Check admin kubeconfig
check_kubeconfig "/etc/kubernetes/admin.conf"
check_kubeconfig "/etc/kubernetes/controller-manager.conf"
check_kubeconfig "/etc/kubernetes/scheduler.conf"
check_kubeconfig "$HOME/.kube/config"

echo "=== In-Cluster Certificate Check ==="
echo ""

# Check certificates for running pods
if command -v kubectl &> /dev/null; then
  # Check API server certificate
  echo "Checking API Server Certificate:"
  kubectl get --raw /healthz/verbose 2>&1 | grep -i cert || true
  echo ""

  # Get certificate info from API server
  API_SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
  if [[ -n "$API_SERVER" ]]; then
    HOST=$(echo "$API_SERVER" | sed -e 's|^https://||' -e 's|:.*||')
    PORT=$(echo "$API_SERVER" | sed -e 's|^https://[^:]*:||' -e 's|/.*||')
    PORT=${PORT:-443}

    echo "Checking certificate for $HOST:$PORT"
    echo | openssl s_client -connect "$HOST:$PORT" 2>/dev/null | \
      openssl x509 -noout -dates -subject -issuer
    echo ""
  fi
fi

echo "================================================"
echo "Certificate Audit Complete - $(date)"
echo "Full JSON output written to: $OUTPUT_FILE"
echo ""

# Summary
EXPIRED=$(grep -c '"status": "EXPIRED"' "$OUTPUT_FILE" 2>/dev/null || echo 0)
CRITICAL=$(grep -c '"status": "CRITICAL"' "$OUTPUT_FILE" 2>/dev/null || echo 0)
WARNING=$(grep -c '"status": "WARNING"' "$OUTPUT_FILE" 2>/dev/null || echo 0)

echo "Summary:"
echo "  Expired: $EXPIRED"
echo "  Critical: $CRITICAL"
echo "  Warning: $WARNING"

if [[ $EXPIRED -gt 0 ]]; then
  exit 2
elif [[ $CRITICAL -gt 0 ]]; then
  exit 1
elif [[ $WARNING -gt 0 ]]; then
  exit 0
else
  exit 0
fi
```

## Implementing cert-manager for Automated Certificate Management

cert-manager is the industry-standard solution for automated certificate management in Kubernetes. Here's a complete production deployment:

### cert-manager Installation

```yaml
# cert-manager-values.yaml
# Production-grade cert-manager configuration

global:
  # High availability configuration
  replicaCount: 3

  # Resource limits for production
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

  # Pod disruption budget
  podDisruptionBudget:
    enabled: true
    minAvailable: 2

  # Affinity rules for multi-zone deployment
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchExpressions:
          - key: app.kubernetes.io/name
            operator: In
            values:
            - cert-manager
        topologyKey: kubernetes.io/hostname
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
            - key: app.kubernetes.io/name
              operator: In
              values:
              - cert-manager
          topologyKey: topology.kubernetes.io/zone

# Prometheus monitoring integration
prometheus:
  enabled: true
  servicemonitor:
    enabled: true
    prometheusInstance: default
    targetPort: 9402
    path: /metrics
    interval: 60s
    scrapeTimeout: 30s
    labels:
      prometheus: kube-prometheus

# Webhook configuration
webhook:
  replicaCount: 3
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi

# CA injector configuration
cainjector:
  replicaCount: 3
  resources:
    requests:
      cpu: 50m
      memory: 128Mi
    limits:
      cpu: 200m
      memory: 512Mi

# Enable feature gates
featureGates: "ExperimentalCertificateSigningRequestControllers=true"

# Certificate renewal settings
# Renew certificates when they have 2/3 of their lifetime remaining
# For 1-year certs, this means renewal at 4 months (120 days) remaining
config:
  apiVersion: controller.config.cert-manager.io/v1alpha1
  kind: ControllerConfiguration
  renewBefore: 2160h  # 90 days
```

```bash
# Install cert-manager using Helm
helm repo add jetstack https://charts.jetstack.io
helm repo update

# Install CRDs
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.crds.yaml

# Install cert-manager
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --values cert-manager-values.yaml \
  --version v1.13.0

# Verify installation
kubectl wait --for=condition=Available --timeout=300s \
  -n cert-manager deployment/cert-manager

kubectl wait --for=condition=Available --timeout=300s \
  -n cert-manager deployment/cert-manager-webhook

kubectl wait --for=condition=Available --timeout=300s \
  -n cert-manager deployment/cert-manager-cainjector
```

### Internal CA Configuration for Kubernetes Components

```yaml
# internal-ca-issuer.yaml
# Self-signed CA for internal Kubernetes certificate management

apiVersion: v1
kind: Namespace
metadata:
  name: cert-manager-system
---
# Self-signed ClusterIssuer for root CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
---
# Root CA Certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: kubernetes-root-ca
  namespace: cert-manager-system
spec:
  isCA: true
  commonName: kubernetes-root-ca
  subject:
    organizations:
      - Support Tools
    organizationalUnits:
      - Infrastructure
  secretName: kubernetes-root-ca-secret
  duration: 87600h  # 10 years
  renewBefore: 8760h  # 1 year before expiry
  privateKey:
    algorithm: RSA
    size: 4096
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
    group: cert-manager.io
---
# CA Issuer using the root CA
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: kubernetes-ca-issuer
spec:
  ca:
    secretName: kubernetes-root-ca-secret
---
# API Server Certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: kubernetes-apiserver
  namespace: kube-system
spec:
  secretName: kubernetes-apiserver-certs
  duration: 8760h  # 1 year
  renewBefore: 2160h  # 90 days before expiry
  subject:
    organizations:
      - system:masters
  commonName: kube-apiserver
  dnsNames:
    - kubernetes
    - kubernetes.default
    - kubernetes.default.svc
    - kubernetes.default.svc.cluster.local
    - api.k8s.cluster.local
    - localhost
  ipAddresses:
    - 127.0.0.1
    - 10.96.0.1  # Kubernetes service ClusterIP
  usages:
    - digital signature
    - key encipherment
    - server auth
  issuerRef:
    name: kubernetes-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
---
# API Server Kubelet Client Certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: kubernetes-apiserver-kubelet-client
  namespace: kube-system
spec:
  secretName: kubernetes-apiserver-kubelet-client-certs
  duration: 8760h  # 1 year
  renewBefore: 2160h  # 90 days
  subject:
    organizations:
      - system:masters
  commonName: kube-apiserver-kubelet-client
  usages:
    - digital signature
    - key encipherment
    - client auth
  issuerRef:
    name: kubernetes-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
---
# Front Proxy Client Certificate
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: kubernetes-front-proxy-client
  namespace: kube-system
spec:
  secretName: kubernetes-front-proxy-client-certs
  duration: 8760h  # 1 year
  renewBefore: 2160h  # 90 days
  subject:
    organizations:
      - system:masters
  commonName: front-proxy-client
  usages:
    - digital signature
    - key encipherment
    - client auth
  issuerRef:
    name: kubernetes-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
```

### Automated Certificate Rotation with Kubeadm Integration

For kubeadm-managed clusters, we need to integrate cert-manager with kubeadm's certificate management:

```bash
#!/bin/bash
# kubeadm-cert-rotation.sh
# Automated certificate rotation for kubeadm clusters using cert-manager

set -euo pipefail

BACKUP_DIR="/var/backups/kubernetes-pki-$(date +%Y%m%d-%H%M%S)"
PKI_DIR="/etc/kubernetes/pki"
KUBECONFIG="/etc/kubernetes/admin.conf"

echo "Starting kubeadm certificate rotation..."

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Backup existing certificates
echo "Backing up existing certificates to $BACKUP_DIR"
cp -r "$PKI_DIR" "$BACKUP_DIR/"
cp "$KUBECONFIG" "$BACKUP_DIR/"

# Check current certificate expiry
echo "Current certificate status:"
kubeadm certs check-expiration

# Renew certificates
echo "Renewing certificates..."
kubeadm certs renew all

# Restart control plane components
echo "Restarting control plane components..."

# Method 1: Using static pod manifest modification (triggers kubelet restart)
for component in kube-apiserver kube-controller-manager kube-scheduler; do
  manifest="/etc/kubernetes/manifests/${component}.yaml"
  if [[ -f "$manifest" ]]; then
    # Add/update annotation to force pod restart
    kubectl annotate pod -n kube-system \
      -l component=${component} \
      kubectl.kubernetes.io/restartedAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --overwrite || true

    # Alternative: Touch the manifest file
    touch "$manifest"
  fi
done

# Wait for API server to be ready
echo "Waiting for API server to be ready..."
timeout=300
elapsed=0
while ! kubectl cluster-info &>/dev/null; do
  if [[ $elapsed -ge $timeout ]]; then
    echo "ERROR: API server did not become ready within ${timeout}s"
    exit 1
  fi
  echo "Waiting for API server... (${elapsed}s/${timeout}s)"
  sleep 5
  elapsed=$((elapsed + 5))
done

echo "API server is ready"

# Update kubeconfig for admin user
echo "Updating kubeconfig..."
cp /etc/kubernetes/admin.conf "$HOME/.kube/config"
chown $(id -u):$(id -g) "$HOME/.kube/config"

# Verify new certificates
echo "Verifying new certificates:"
kubeadm certs check-expiration

# Test cluster functionality
echo "Testing cluster functionality..."
kubectl get nodes
kubectl get pods -A

echo "Certificate rotation complete!"
echo "Backup location: $BACKUP_DIR"
```

## Prometheus Monitoring and Alerting

Comprehensive monitoring is critical for preventing certificate expiry incidents:

```yaml
# prometheus-cert-monitoring.yaml
# Prometheus ServiceMonitor and alerting rules for certificate monitoring

apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-cert-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
data:
  cert-manager.rules.yaml: |
    groups:
    - name: cert-manager
      interval: 60s
      rules:
      # Certificate expiry warnings
      - alert: CertificateExpirySoon
        expr: |
          certmanager_certificate_expiration_timestamp_seconds - time() < (30 * 24 * 3600)
        for: 15m
        labels:
          severity: warning
          component: cert-manager
        annotations:
          summary: "Certificate {{ $labels.name }} expiring soon"
          description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}"
          runbook_url: "https://support.tools/runbooks/certificate-expiry"

      - alert: CertificateExpiryCritical
        expr: |
          certmanager_certificate_expiration_timestamp_seconds - time() < (7 * 24 * 3600)
        for: 5m
        labels:
          severity: critical
          component: cert-manager
          pager: "true"
        annotations:
          summary: "Certificate {{ $labels.name }} expiring VERY soon"
          description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} expires in {{ $value | humanizeDuration }}. IMMEDIATE ACTION REQUIRED"
          runbook_url: "https://support.tools/runbooks/certificate-expiry"

      - alert: CertificateExpired
        expr: |
          certmanager_certificate_expiration_timestamp_seconds - time() <= 0
        for: 1m
        labels:
          severity: critical
          component: cert-manager
          pager: "true"
        annotations:
          summary: "Certificate {{ $labels.name }} HAS EXPIRED"
          description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} has expired. Services may be impacted."
          runbook_url: "https://support.tools/runbooks/certificate-expiry"

      # Certificate renewal failures
      - alert: CertificateRenewalFailed
        expr: |
          certmanager_certificate_ready_status{condition="False"} == 1
        for: 15m
        labels:
          severity: critical
          component: cert-manager
        annotations:
          summary: "Certificate {{ $labels.name }} renewal failed"
          description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} has failed to renew. Check cert-manager logs."
          runbook_url: "https://support.tools/runbooks/certificate-renewal-failure"

      # cert-manager controller health
      - alert: CertManagerControllerDown
        expr: |
          up{job="cert-manager"} == 0
        for: 5m
        labels:
          severity: critical
          component: cert-manager
          pager: "true"
        annotations:
          summary: "cert-manager controller is down"
          description: "cert-manager controller has been down for more than 5 minutes. Certificate renewals will not occur."
          runbook_url: "https://support.tools/runbooks/cert-manager-down"

      # Kubernetes API server certificate monitoring
      - alert: KubernetesAPIServerCertExpiringSoon
        expr: |
          apiserver_client_certificate_expiration_seconds_bucket{le="2592000"} > 0
        for: 15m
        labels:
          severity: warning
          component: kubernetes
        annotations:
          summary: "Kubernetes API Server certificate expiring soon"
          description: "API server certificate expires in less than 30 days"
          runbook_url: "https://support.tools/runbooks/api-server-cert-expiry"

      - alert: KubernetesAPIServerCertExpiryCritical
        expr: |
          apiserver_client_certificate_expiration_seconds_bucket{le="604800"} > 0
        for: 5m
        labels:
          severity: critical
          component: kubernetes
          pager: "true"
        annotations:
          summary: "Kubernetes API Server certificate expiring VERY soon"
          description: "API server certificate expires in less than 7 days. IMMEDIATE ACTION REQUIRED"
          runbook_url: "https://support.tools/runbooks/api-server-cert-expiry"
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cert-manager
  namespace: monitoring
  labels:
    app: cert-manager
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: cert-manager
  namespaceSelector:
    matchNames:
      - cert-manager
  endpoints:
  - port: tcp-prometheus-servicemonitor
    interval: 60s
    scrapeTimeout: 30s
    path: /metrics
    scheme: http
---
# Custom exporter for kubeadm certificate monitoring
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kubernetes-cert-exporter
  namespace: kube-system
  labels:
    app: kubernetes-cert-exporter
spec:
  selector:
    matchLabels:
      app: kubernetes-cert-exporter
  template:
    metadata:
      labels:
        app: kubernetes-cert-exporter
    spec:
      hostNetwork: true
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      containers:
      - name: cert-exporter
        image: joeelliott/cert-exporter:v2.8.0
        args:
        - --include-cert-glob=/etc/kubernetes/pki/**/*.crt
        - --include-cert-glob=/var/lib/kubelet/pki/**/*.pem
        - --exclude-cert-glob=/etc/kubernetes/pki/etcd/ca.crt
        - --exclude-cert-glob=/etc/kubernetes/pki/ca.crt
        - --logtostderr
        ports:
        - containerPort: 8080
          name: metrics
        volumeMounts:
        - name: kubernetes-pki
          mountPath: /etc/kubernetes/pki
          readOnly: true
        - name: kubelet-pki
          mountPath: /var/lib/kubelet/pki
          readOnly: true
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi
        securityContext:
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 65534
      volumes:
      - name: kubernetes-pki
        hostPath:
          path: /etc/kubernetes/pki
          type: Directory
      - name: kubelet-pki
        hostPath:
          path: /var/lib/kubelet/pki
          type: Directory
---
apiVersion: v1
kind: Service
metadata:
  name: kubernetes-cert-exporter
  namespace: kube-system
  labels:
    app: kubernetes-cert-exporter
spec:
  type: ClusterIP
  clusterIP: None
  selector:
    app: kubernetes-cert-exporter
  ports:
  - name: metrics
    port: 8080
    targetPort: 8080
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kubernetes-cert-exporter
  namespace: monitoring
  labels:
    app: kubernetes-cert-exporter
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: kubernetes-cert-exporter
  namespaceSelector:
    matchNames:
      - kube-system
  endpoints:
  - port: metrics
    interval: 60s
    scrapeTimeout: 30s
```

## Grafana Dashboard for Certificate Monitoring

```json
{
  "dashboard": {
    "title": "Kubernetes Certificate Monitoring",
    "tags": ["kubernetes", "certificates", "security"],
    "timezone": "browser",
    "panels": [
      {
        "title": "Certificate Expiry Timeline",
        "type": "graph",
        "targets": [
          {
            "expr": "(certmanager_certificate_expiration_timestamp_seconds - time()) / 86400",
            "legendFormat": "{{ namespace }}/{{ name }}"
          }
        ],
        "yaxes": [
          {
            "label": "Days Until Expiry",
            "format": "short"
          }
        ],
        "thresholds": [
          {
            "value": 7,
            "colorMode": "critical"
          },
          {
            "value": 30,
            "colorMode": "warning"
          }
        ]
      },
      {
        "title": "Certificates Expiring Soon",
        "type": "table",
        "targets": [
          {
            "expr": "sort_desc((certmanager_certificate_expiration_timestamp_seconds - time()) / 86400 < 90)",
            "format": "table",
            "instant": true
          }
        ],
        "transformations": [
          {
            "id": "organize",
            "options": {
              "excludeByName": {
                "Time": true,
                "job": true
              },
              "renameByName": {
                "name": "Certificate",
                "namespace": "Namespace",
                "Value": "Days Until Expiry"
              }
            }
          }
        ]
      },
      {
        "title": "Certificate Renewal Success Rate",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(certmanager_certificate_ready_status{condition=\"True\"}) / sum(certmanager_certificate_ready_status) * 100"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "percent",
            "thresholds": {
              "mode": "absolute",
              "steps": [
                {"value": 0, "color": "red"},
                {"value": 95, "color": "yellow"},
                {"value": 99, "color": "green"}
              ]
            }
          }
        }
      },
      {
        "title": "Kubernetes PKI Certificate Expiry",
        "type": "graph",
        "targets": [
          {
            "expr": "(ssl_certificate_expiry_seconds - time()) / 86400",
            "legendFormat": "{{ filepath }}"
          }
        ],
        "yaxes": [
          {
            "label": "Days Until Expiry",
            "format": "short"
          }
        ],
        "thresholds": [
          {
            "value": 7,
            "colorMode": "critical"
          },
          {
            "value": 30,
            "colorMode": "warning"
          }
        ]
      }
    ]
  }
}
```

## Disaster Recovery Procedures

When certificates do expire, having a tested recovery procedure is critical:

```bash
#!/bin/bash
# certificate-disaster-recovery.sh
# Emergency certificate recovery procedure for expired Kubernetes certificates

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${RED}================================${NC}"
echo -e "${RED}KUBERNETES CERTIFICATE EMERGENCY RECOVERY${NC}"
echo -e "${RED}================================${NC}"
echo ""

# Verify we're running on a control plane node
if [[ ! -f /etc/kubernetes/manifests/kube-apiserver.yaml ]]; then
  echo -e "${RED}ERROR: This script must run on a control plane node${NC}"
  exit 1
fi

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}ERROR: This script must be run as root${NC}"
   exit 1
fi

echo -e "${YELLOW}WARNING: This procedure will restart control plane components${NC}"
echo -e "${YELLOW}Ensure you have a backup of /etc/kubernetes/pki${NC}"
echo ""
read -p "Continue? (yes/no): " confirm

if [[ "$confirm" != "yes" ]]; then
  echo "Aborted"
  exit 0
fi

BACKUP_DIR="/var/backups/k8s-pki-recovery-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo ""
echo "Step 1: Backing up current certificates"
cp -r /etc/kubernetes/pki "$BACKUP_DIR/"
cp -r /etc/kubernetes/*.conf "$BACKUP_DIR/"
echo -e "${GREEN}Backup completed: $BACKUP_DIR${NC}"

echo ""
echo "Step 2: Checking certificate expiry status"
kubeadm certs check-expiration || true

echo ""
echo "Step 3: Renewing all certificates"

# For severely expired certificates, we may need to force renewal
# by temporarily modifying system time (DANGEROUS - use only as last resort)
read -p "Are certificates severely expired (> 30 days)? (yes/no): " severely_expired

if [[ "$severely_expired" == "yes" ]]; then
  echo -e "${YELLOW}Using emergency time modification procedure${NC}"

  # Save current time
  CURRENT_TIME=$(date +%s)

  # Calculate date before expiry (1 month before expiry)
  # This assumes 1-year certificates that expired recently
  RECOVERY_DATE=$(date -d "1 year ago + 11 months" +"%Y-%m-%d %H:%M:%S")

  echo "Setting system time to: $RECOVERY_DATE"
  timedatectl set-ntp false
  date -s "$RECOVERY_DATE"

  # Renew certificates
  kubeadm certs renew all

  # Restore time
  echo "Restoring system time"
  date -s "@$CURRENT_TIME"
  timedatectl set-ntp true
else
  # Standard renewal
  kubeadm certs renew all
fi

echo ""
echo "Step 4: Updating kubeconfig files"

# Update admin kubeconfig
cp /etc/kubernetes/admin.conf /root/.kube/config
chown root:root /root/.kube/config
chmod 600 /root/.kube/config

# Update controller manager kubeconfig
kubeadm init phase kubeconfig controller-manager

# Update scheduler kubeconfig
kubeadm init phase kubeconfig scheduler

echo ""
echo "Step 5: Restarting control plane components"

# Move manifests temporarily to stop pods
MANIFEST_DIR="/etc/kubernetes/manifests"
TEMP_DIR="/tmp/k8s-manifests-$(date +%s)"
mkdir -p "$TEMP_DIR"

mv "$MANIFEST_DIR"/*.yaml "$TEMP_DIR/"

echo "Waiting for control plane pods to stop..."
sleep 30

# Restore manifests to start pods with new certificates
mv "$TEMP_DIR"/*.yaml "$MANIFEST_DIR/"
rmdir "$TEMP_DIR"

echo "Waiting for control plane to start..."
sleep 60

echo ""
echo "Step 6: Verifying cluster health"

# Wait for API server
echo "Waiting for API server..."
timeout=300
elapsed=0
while ! kubectl cluster-info &>/dev/null; do
  if [[ $elapsed -ge $timeout ]]; then
    echo -e "${RED}ERROR: API server did not become ready${NC}"
    echo "Check logs: journalctl -u kubelet -n 100"
    exit 1
  fi
  echo -n "."
  sleep 5
  elapsed=$((elapsed + 5))
done
echo ""

# Verify certificate renewal
echo ""
echo "New certificate expiry dates:"
kubeadm certs check-expiration

# Test cluster functionality
echo ""
echo "Testing cluster functionality:"
kubectl get nodes
kubectl get pods -A | head -20

# Check etcd health
echo ""
echo "Checking etcd health:"
kubectl exec -n kube-system etcd-$(hostname) -- \
  etcdctl --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}Recovery completed successfully!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo "Backup location: $BACKUP_DIR"
echo ""
echo "IMPORTANT NEXT STEPS:"
echo "1. Verify all workloads are functioning"
echo "2. Check cert-manager is operational"
echo "3. Review monitoring alerts"
echo "4. Document incident timeline"
echo "5. Implement preventive measures"
```

## Continuous Compliance and Testing

Regularly test your certificate management procedures:

```yaml
# certificate-compliance-cronjob.yaml
# Automated certificate compliance testing

apiVersion: batch/v1
kind: CronJob
metadata:
  name: certificate-compliance-check
  namespace: kube-system
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 7
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: certificate-compliance-checker
          restartPolicy: OnFailure
          containers:
          - name: compliance-checker
            image: bitnami/kubectl:latest
            command:
            - /bin/bash
            - -c
            - |
              #!/bin/bash
              set -euo pipefail

              echo "Starting certificate compliance check - $(date)"

              # Check all cert-manager certificates
              echo "Checking cert-manager certificates..."
              kubectl get certificates -A -o json | \
                jq -r '.items[] |
                  select(.status.notAfter != null) |
                  "\(.metadata.namespace)/\(.metadata.name): \(.status.notAfter)"'

              # Check for certificates expiring soon
              EXPIRING=$(kubectl get certificates -A -o json | \
                jq -r --arg date "$(date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ)" \
                '.items[] |
                  select(.status.notAfter != null and .status.notAfter < $date) |
                  "\(.metadata.namespace)/\(.metadata.name)"')

              if [[ -n "$EXPIRING" ]]; then
                echo "WARNING: Certificates expiring within 30 days:"
                echo "$EXPIRING"
              else
                echo "All certificates have > 30 days validity"
              fi

              # Check cert-manager health
              echo "Checking cert-manager health..."
              kubectl get pods -n cert-manager -o wide

              # Generate compliance report
              cat > /tmp/compliance-report.json <<EOF
              {
                "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
                "certificates_total": $(kubectl get certificates -A --no-headers | wc -l),
                "certificates_ready": $(kubectl get certificates -A -o json | jq '[.items[] | select(.status.conditions[]? | select(.type=="Ready" and .status=="True"))] | length'),
                "certificates_expiring_30d": $(echo "$EXPIRING" | grep -c . || echo 0),
                "cert_manager_healthy": $(kubectl get pods -n cert-manager -o json | jq '[.items[] | select(.status.phase=="Running")] | length')
              }
              EOF

              echo "Compliance report:"
              cat /tmp/compliance-report.json | jq .

              echo "Certificate compliance check complete - $(date)"
            resources:
              requests:
                cpu: 100m
                memory: 128Mi
              limits:
                cpu: 500m
                memory: 256Mi
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: certificate-compliance-checker
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: certificate-compliance-checker
rules:
- apiGroups: ["cert-manager.io"]
  resources: ["certificates"]
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: certificate-compliance-checker
subjects:
- kind: ServiceAccount
  name: certificate-compliance-checker
  namespace: kube-system
roleRef:
  kind: ClusterRole
  name: certificate-compliance-checker
  apiGroup: rbac.authorization.k8s.io
```

## Conclusion

The Honeycomb certificate expiry incident demonstrates that even simple, preventable issues can cause severe production outages when proper automation and monitoring aren't in place. By implementing comprehensive certificate lifecycle management with cert-manager, robust monitoring with Prometheus, and tested disaster recovery procedures, organizations can eliminate certificate expiry as a source of production incidents.

Key takeaways:

1. **Automate Everything**: Manual certificate renewal is a recipe for disaster. Use cert-manager or equivalent automation.

2. **Monitor Proactively**: Alert on certificates at 90, 30, and 7 days before expiry with escalating severity.

3. **Test Recovery Procedures**: Regularly test your disaster recovery procedures in non-production environments.

4. **Document and Train**: Ensure your team knows how to handle certificate emergencies.

5. **Implement Defense in Depth**: Use multiple layers of monitoring and automation to catch issues early.

Certificate management is not glamorous, but it's critical infrastructure hygiene that can prevent hours of downtime and significant business impact. Invest the time to do it right.