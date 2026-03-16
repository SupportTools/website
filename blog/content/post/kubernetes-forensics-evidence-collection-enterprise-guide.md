---
title: "Kubernetes Forensics and Evidence Collection: Enterprise Incident Response Guide"
date: 2026-08-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Forensics", "Incident Response", "Security", "Evidence Collection", "Container Security", "Enterprise"]
categories: ["DevOps", "Security", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes forensics and evidence collection for incident response, including cluster state preservation, container analysis, and chain of custody procedures for enterprise environments."
more_link: "yes"
url: "/kubernetes-forensics-evidence-collection-enterprise-guide/"
---

Master Kubernetes forensics and evidence collection for enterprise incident response with comprehensive techniques for cluster state preservation, container analysis, and maintaining proper chain of custody in production environments.

<!--more-->

# Kubernetes Forensics and Evidence Collection: Enterprise Incident Response Guide

## Executive Summary

When security incidents occur in Kubernetes environments, the ability to collect and preserve evidence quickly and properly is critical for investigation, remediation, and potential legal proceedings. This comprehensive guide covers enterprise-grade forensics techniques, evidence collection procedures, and chain of custody practices for Kubernetes clusters. We'll explore automated collection tools, manual investigation techniques, and production-tested procedures that minimize disruption while maximizing evidence integrity.

## Understanding Kubernetes Forensics Challenges

### Ephemeral Nature of Containers

Containers are designed to be ephemeral, creating unique forensics challenges:

- **Container Termination**: Evidence disappears when pods are deleted
- **Auto-Scaling**: Clusters automatically remove evidence during scale-down
- **Rolling Updates**: Deployments replace pods, destroying potential evidence
- **Log Rotation**: Critical logs may be overwritten or discarded
- **State Loss**: In-memory data is lost on container restart

### Multi-Layer Architecture Complexity

Kubernetes forensics requires analyzing multiple layers:

```
Application Layer (User Code)
    ↓
Container Runtime (containerd/CRI-O)
    ↓
Kubernetes Control Plane
    ↓
Node Operating System
    ↓
Cloud/Hypervisor Infrastructure
```

Each layer requires different collection techniques and tools.

## Evidence Collection Framework

### Immediate Response Priorities

When an incident is detected, follow this priority order:

**Priority 1: Volatile Data (Collect Immediately)**
- Running process memory
- Network connections and traffic
- In-memory logs and state
- Active authentication tokens

**Priority 2: Kubernetes Resources (Collect Within Minutes)**
- Pod specifications and status
- ConfigMaps and Secrets
- Service accounts and RBAC
- Network policies and ingress rules

**Priority 3: Persistent Data (Collect Within Hours)**
- Persistent volume contents
- Audit logs
- Application logs
- Metrics and monitoring data

**Priority 4: Historical Data (Collect Within Days)**
- Archived logs
- Backup snapshots
- Change management records
- Git repository history

### Evidence Collection Toolkit

Create a dedicated forensics toolkit namespace:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: forensics-toolkit
  labels:
    name: forensics-toolkit
    security.forensics/toolkit: "true"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: forensics-collector
  namespace: forensics-toolkit
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: forensics-collector
rules:
# Read all resources for evidence collection
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["get", "list", "watch"]
# Execute into pods for live analysis
- apiGroups: [""]
  resources: ["pods/exec", "pods/log"]
  verbs: ["create", "get"]
# Access events
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: forensics-collector
subjects:
- kind: ServiceAccount
  name: forensics-collector
  namespace: forensics-toolkit
roleRef:
  kind: ClusterRole
  name: forensics-collector
  apiGroup: rbac.authorization.k8s.io
```

## Automated Evidence Collection

### Comprehensive Cluster State Snapshot

Create an automated snapshot tool that captures complete cluster state:

```bash
#!/bin/bash
# k8s-forensics-snapshot.sh - Comprehensive Kubernetes Forensics Collection
# Usage: ./k8s-forensics-snapshot.sh <incident-id>

set -euo pipefail

INCIDENT_ID="${1:-unknown}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR="./evidence-${INCIDENT_ID}-${TIMESTAMP}"
NAMESPACE="${K8S_FORENSICS_NAMESPACE:-default}"

# Create evidence directory structure
mkdir -p "${EVIDENCE_DIR}"/{cluster,nodes,namespaces,network,storage,security,logs,metrics}

# Log all actions with timestamps
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${EVIDENCE_DIR}/collection.log"
}

# Calculate and record checksums
record_checksum() {
    local file="$1"
    if [[ -f "$file" ]]; then
        sha256sum "$file" >> "${EVIDENCE_DIR}/checksums.txt"
    fi
}

log "Starting evidence collection for incident: ${INCIDENT_ID}"
log "Kubernetes context: $(kubectl config current-context)"
log "Collector: $(whoami)@$(hostname)"

# ===== CLUSTER-LEVEL EVIDENCE =====
log "Collecting cluster-level information..."

# Cluster version and configuration
kubectl version -o yaml > "${EVIDENCE_DIR}/cluster/version.yaml" 2>&1
kubectl cluster-info dump > "${EVIDENCE_DIR}/cluster/cluster-info.txt" 2>&1
kubectl get componentstatuses -o yaml > "${EVIDENCE_DIR}/cluster/component-status.yaml" 2>&1

# API server configuration
kubectl get --raw /api > "${EVIDENCE_DIR}/cluster/api-resources.json" 2>&1
kubectl get --raw /apis > "${EVIDENCE_DIR}/cluster/api-groups.json" 2>&1

# ===== NODE EVIDENCE =====
log "Collecting node information..."

kubectl get nodes -o yaml > "${EVIDENCE_DIR}/nodes/nodes.yaml"
kubectl top nodes > "${EVIDENCE_DIR}/nodes/node-metrics.txt" 2>&1

# Detailed node information
for node in $(kubectl get nodes -o jsonpath='{.items[*].metadata.name}'); do
    log "Collecting evidence from node: ${node}"

    mkdir -p "${EVIDENCE_DIR}/nodes/${node}"

    kubectl describe node "${node}" > "${EVIDENCE_DIR}/nodes/${node}/describe.txt"
    kubectl get --raw "/api/v1/nodes/${node}/proxy/stats/summary" > "${EVIDENCE_DIR}/nodes/${node}/stats.json" 2>&1
    kubectl get --raw "/api/v1/nodes/${node}/proxy/configz" > "${EVIDENCE_DIR}/nodes/${node}/kubelet-config.json" 2>&1

    # Collect node conditions and events
    kubectl get events --all-namespaces --field-selector involvedObject.name="${node}" -o yaml > "${EVIDENCE_DIR}/nodes/${node}/events.yaml"
done

# ===== NAMESPACE AND POD EVIDENCE =====
log "Collecting namespace and pod information..."

# Get all namespaces
kubectl get namespaces -o yaml > "${EVIDENCE_DIR}/namespaces/namespaces.yaml"

# Iterate through all namespaces
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
    log "Collecting evidence from namespace: ${ns}"

    mkdir -p "${EVIDENCE_DIR}/namespaces/${ns}"

    # All resources in namespace
    kubectl get all -n "${ns}" -o yaml > "${EVIDENCE_DIR}/namespaces/${ns}/all-resources.yaml" 2>&1

    # Pods with detailed status
    kubectl get pods -n "${ns}" -o yaml > "${EVIDENCE_DIR}/namespaces/${ns}/pods.yaml"
    kubectl describe pods -n "${ns}" > "${EVIDENCE_DIR}/namespaces/${ns}/pods-describe.txt"
    kubectl top pods -n "${ns}" > "${EVIDENCE_DIR}/namespaces/${ns}/pod-metrics.txt" 2>&1

    # ConfigMaps and Secrets (metadata only for secrets)
    kubectl get configmaps -n "${ns}" -o yaml > "${EVIDENCE_DIR}/namespaces/${ns}/configmaps.yaml"
    kubectl get secrets -n "${ns}" -o yaml | grep -v "data:" > "${EVIDENCE_DIR}/namespaces/${ns}/secrets-metadata.yaml"

    # Services and endpoints
    kubectl get services,endpoints -n "${ns}" -o yaml > "${EVIDENCE_DIR}/namespaces/${ns}/services.yaml"

    # Workload controllers
    kubectl get deployments,statefulsets,daemonsets,jobs,cronjobs -n "${ns}" -o yaml > "${EVIDENCE_DIR}/namespaces/${ns}/controllers.yaml"

    # Events in namespace
    kubectl get events -n "${ns}" --sort-by='.lastTimestamp' -o yaml > "${EVIDENCE_DIR}/namespaces/${ns}/events.yaml"

    # PVCs
    kubectl get pvc -n "${ns}" -o yaml > "${EVIDENCE_DIR}/namespaces/${ns}/pvcs.yaml"
done

# ===== NETWORK EVIDENCE =====
log "Collecting network configuration..."

kubectl get networkpolicies --all-namespaces -o yaml > "${EVIDENCE_DIR}/network/network-policies.yaml"
kubectl get ingresses --all-namespaces -o yaml > "${EVIDENCE_DIR}/network/ingresses.yaml"
kubectl get services --all-namespaces -o yaml > "${EVIDENCE_DIR}/network/services.yaml"

# Service mesh configurations (if Istio is present)
if kubectl get ns istio-system &>/dev/null; then
    log "Collecting Istio service mesh configuration..."
    kubectl get virtualservices,destinationrules,gateways,serviceentries --all-namespaces -o yaml > "${EVIDENCE_DIR}/network/istio-config.yaml"
fi

# ===== STORAGE EVIDENCE =====
log "Collecting storage information..."

kubectl get pv -o yaml > "${EVIDENCE_DIR}/storage/persistent-volumes.yaml"
kubectl get pvc --all-namespaces -o yaml > "${EVIDENCE_DIR}/storage/persistent-volume-claims.yaml"
kubectl get storageclasses -o yaml > "${EVIDENCE_DIR}/storage/storage-classes.yaml"
kubectl get volumeattachments -o yaml > "${EVIDENCE_DIR}/storage/volume-attachments.yaml" 2>&1

# ===== SECURITY EVIDENCE =====
log "Collecting security configurations..."

# RBAC
kubectl get clusterroles,clusterrolebindings -o yaml > "${EVIDENCE_DIR}/security/cluster-rbac.yaml"
kubectl get roles,rolebindings --all-namespaces -o yaml > "${EVIDENCE_DIR}/security/namespace-rbac.yaml"
kubectl get serviceaccounts --all-namespaces -o yaml > "${EVIDENCE_DIR}/security/service-accounts.yaml"

# Pod Security Policies/Standards
kubectl get podsecuritypolicies -o yaml > "${EVIDENCE_DIR}/security/pod-security-policies.yaml" 2>&1

# Security contexts
kubectl get pods --all-namespaces -o json | jq -r '.items[] | select(.spec.securityContext != null) | {namespace: .metadata.namespace, name: .metadata.name, securityContext: .spec.securityContext}' > "${EVIDENCE_DIR}/security/pod-security-contexts.json"

# Admission controllers
kubectl get validatingwebhookconfigurations -o yaml > "${EVIDENCE_DIR}/security/validating-webhooks.yaml" 2>&1
kubectl get mutatingwebhookconfigurations -o yaml > "${EVIDENCE_DIR}/security/mutating-webhooks.yaml" 2>&1

# ===== LOG COLLECTION =====
log "Collecting pod logs..."

mkdir -p "${EVIDENCE_DIR}/logs/pods"

# Collect logs from all pods (current and previous)
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
    for pod in $(kubectl get pods -n "${ns}" -o jsonpath='{.items[*].metadata.name}'); do
        log "Collecting logs from pod: ${ns}/${pod}"

        # Current logs
        kubectl logs -n "${ns}" "${pod}" --all-containers=true > "${EVIDENCE_DIR}/logs/pods/${ns}_${pod}_current.log" 2>&1

        # Previous logs (if pod restarted)
        kubectl logs -n "${ns}" "${pod}" --all-containers=true --previous > "${EVIDENCE_DIR}/logs/pods/${ns}_${pod}_previous.log" 2>&1 || true
    done
done

# Control plane logs (if accessible)
if kubectl get pods -n kube-system &>/dev/null; then
    log "Collecting control plane logs..."
    mkdir -p "${EVIDENCE_DIR}/logs/control-plane"

    for component in kube-apiserver kube-controller-manager kube-scheduler etcd; do
        kubectl logs -n kube-system -l component="${component}" --all-containers=true > "${EVIDENCE_DIR}/logs/control-plane/${component}.log" 2>&1 || true
    done
fi

# ===== METRICS COLLECTION =====
log "Collecting metrics..."

# Metrics server data
kubectl top nodes --no-headers > "${EVIDENCE_DIR}/metrics/node-metrics.txt" 2>&1 || true
kubectl top pods --all-namespaces --no-headers > "${EVIDENCE_DIR}/metrics/pod-metrics.txt" 2>&1 || true

# Prometheus metrics (if available)
if kubectl get svc -n monitoring prometheus-k8s &>/dev/null; then
    log "Collecting Prometheus metrics..."
    kubectl port-forward -n monitoring svc/prometheus-k8s 9090:9090 &
    PF_PID=$!
    sleep 5

    curl -s 'http://localhost:9090/api/v1/query?query=up' > "${EVIDENCE_DIR}/metrics/prometheus-up.json" 2>&1 || true
    curl -s 'http://localhost:9090/api/v1/targets' > "${EVIDENCE_DIR}/metrics/prometheus-targets.json" 2>&1 || true

    kill $PF_PID 2>/dev/null || true
fi

# ===== AUDIT LOGS =====
log "Collecting audit logs (if available)..."

# This requires access to the API server audit log location
# Typically requires node access or specific configuration

# ===== GENERATE CHECKSUMS =====
log "Generating checksums for all collected files..."

find "${EVIDENCE_DIR}" -type f -not -name "checksums.txt" -exec sha256sum {} \; > "${EVIDENCE_DIR}/checksums.txt"

# ===== CREATE MANIFEST =====
log "Creating evidence manifest..."

cat > "${EVIDENCE_DIR}/MANIFEST.txt" << EOF
EVIDENCE COLLECTION MANIFEST
============================

Incident ID: ${INCIDENT_ID}
Collection Timestamp: ${TIMESTAMP}
Collector: $(whoami)@$(hostname)
Kubernetes Context: $(kubectl config current-context)
Kubernetes Version: $(kubectl version --short 2>/dev/null | head -n1)

Evidence Directory Structure:
$(tree -L 2 "${EVIDENCE_DIR}" 2>/dev/null || find "${EVIDENCE_DIR}" -type d)

Total Files Collected: $(find "${EVIDENCE_DIR}" -type f | wc -l)
Total Size: $(du -sh "${EVIDENCE_DIR}" | cut -f1)

Chain of Custody:
- Collected by: $(whoami)
- Collection time: $(date)
- Collection host: $(hostname)
- Collection method: Automated k8s-forensics-snapshot.sh

Checksum Algorithm: SHA-256
Checksums file: checksums.txt

Notes:
- All timestamps are in UTC
- Secrets data is not included, only metadata
- Logs are collected from current and previous container instances
- Node-level data requires appropriate permissions

EOF

# ===== COMPRESS EVIDENCE =====
log "Compressing evidence package..."

tar -czf "evidence-${INCIDENT_ID}-${TIMESTAMP}.tar.gz" "${EVIDENCE_DIR}"
sha256sum "evidence-${INCIDENT_ID}-${TIMESTAMP}.tar.gz" > "evidence-${INCIDENT_ID}-${TIMESTAMP}.tar.gz.sha256"

log "Evidence collection complete!"
log "Evidence package: evidence-${INCIDENT_ID}-${TIMESTAMP}.tar.gz"
log "Package checksum: $(cat evidence-${INCIDENT_ID}-${TIMESTAMP}.tar.gz.sha256)"
log "Total collection time: ${SECONDS} seconds"

echo ""
echo "Evidence collection summary:"
echo "- Evidence directory: ${EVIDENCE_DIR}"
echo "- Compressed package: evidence-${INCIDENT_ID}-${TIMESTAMP}.tar.gz"
echo "- Package size: $(du -h evidence-${INCIDENT_ID}-${TIMESTAMP}.tar.gz | cut -f1)"
echo "- SHA-256: $(cat evidence-${INCIDENT_ID}-${TIMESTAMP}.tar.gz.sha256 | cut -d' ' -f1)"
```

### Pod Memory and Process State Capture

Capture running process state and memory from suspected pods:

```bash
#!/bin/bash
# capture-pod-state.sh - Capture live pod state for forensics

POD_NAME="$1"
NAMESPACE="${2:-default}"
EVIDENCE_DIR="./pod-evidence-${POD_NAME}-$(date +%Y%m%d-%H%M%S)"

mkdir -p "${EVIDENCE_DIR}"

echo "Capturing state from pod: ${NAMESPACE}/${POD_NAME}"

# Get pod specification
kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o yaml > "${EVIDENCE_DIR}/pod-spec.yaml"

# Get containers in pod
CONTAINERS=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.containers[*].name}')

for container in ${CONTAINERS}; do
    echo "Processing container: ${container}"

    mkdir -p "${EVIDENCE_DIR}/${container}"

    # Process list
    kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- ps auxww > "${EVIDENCE_DIR}/${container}/processes.txt" 2>&1 || true

    # Network connections
    kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- netstat -tunap > "${EVIDENCE_DIR}/${container}/network-connections.txt" 2>&1 || true

    # Open files
    kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- lsof > "${EVIDENCE_DIR}/${container}/open-files.txt" 2>&1 || true

    # Environment variables
    kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- env > "${EVIDENCE_DIR}/${container}/environment.txt" 2>&1 || true

    # Running commands
    kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%mem > "${EVIDENCE_DIR}/${container}/process-tree.txt" 2>&1 || true

    # Memory maps for each process
    PIDS=$(kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- ps -eo pid --no-headers 2>/dev/null || true)

    for pid in ${PIDS}; do
        kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- cat /proc/${pid}/maps > "${EVIDENCE_DIR}/${container}/proc-${pid}-maps.txt" 2>&1 || true
        kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- cat /proc/${pid}/status > "${EVIDENCE_DIR}/${container}/proc-${pid}-status.txt" 2>&1 || true
    done

    # Capture process memory (requires gcore or gdb)
    kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- bash -c 'for pid in $(ps -eo pid --no-headers); do gcore -o /tmp/core $pid 2>/dev/null || true; done' || true

    # Copy core dumps if they exist
    kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${container}" -- ls /tmp/core.* > /dev/null 2>&1 && \
        kubectl cp "${NAMESPACE}/${POD_NAME}:${container}:/tmp/" "${EVIDENCE_DIR}/${container}/core-dumps/" || true
done

echo "Pod state captured to: ${EVIDENCE_DIR}"
```

## Container Filesystem Analysis

### Exporting Container Filesystems

Export entire container filesystems for offline analysis:

```bash
#!/bin/bash
# export-container-filesystem.sh - Export container filesystem for forensics

POD_NAME="$1"
NAMESPACE="${2:-default}"
CONTAINER="${3:-}"
OUTPUT_DIR="./container-fs-${POD_NAME}-$(date +%Y%m%d-%H%M%S)"

mkdir -p "${OUTPUT_DIR}"

# If no container specified, get first container
if [[ -z "${CONTAINER}" ]]; then
    CONTAINER=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.containers[0].name}')
fi

echo "Exporting filesystem from ${NAMESPACE}/${POD_NAME}:${CONTAINER}"

# Method 1: Using kubectl cp (for running containers)
echo "Attempting to copy filesystem using kubectl cp..."
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c "${CONTAINER}" -- tar czf /tmp/filesystem-backup.tar.gz / 2>/dev/null || true
kubectl cp "${NAMESPACE}/${POD_NAME}:/tmp/filesystem-backup.tar.gz" "${OUTPUT_DIR}/filesystem.tar.gz" || true

# Method 2: Using crictl (requires node access)
echo "Attempting to export using crictl..."

# Get node name
NODE=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.nodeName}')
echo "Pod is running on node: ${NODE}"

# Get container ID
CONTAINER_ID=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath="{.status.containerStatuses[?(@.name=='${CONTAINER}')].containerID}" | sed 's/.*:\/\///')

if [[ -n "${CONTAINER_ID}" ]]; then
    echo "Container ID: ${CONTAINER_ID}"

    # This requires SSH access to the node or privileged pod
    cat > "${OUTPUT_DIR}/export-instructions.txt" << EOF
To export the container filesystem using crictl, run these commands on node ${NODE}:

# Export container filesystem
sudo crictl export ${CONTAINER_ID} > container-${CONTAINER_ID}.tar

# Or using docker/containerd directly
sudo docker export ${CONTAINER_ID} > container-${CONTAINER_ID}.tar

# Or mount the container overlay filesystem
MOUNT_POINT=\$(sudo crictl inspect ${CONTAINER_ID} | jq -r '.info.runtimeSpec.root.path')
sudo tar czf container-${CONTAINER_ID}.tar.gz -C "\${MOUNT_POINT}" .

EOF
    cat "${OUTPUT_DIR}/export-instructions.txt"
fi

# Method 3: Create forensics pod with access to container filesystem
cat > "${OUTPUT_DIR}/forensics-pod.yaml" << EOF
apiVersion: v1
kind: Pod
metadata:
  name: forensics-${POD_NAME}
  namespace: ${NAMESPACE}
spec:
  nodeName: ${NODE}
  hostPID: true
  hostNetwork: true
  containers:
  - name: forensics
    image: busybox
    command: ['sleep', 'infinity']
    securityContext:
      privileged: true
    volumeMounts:
    - name: host-root
      mountPath: /host
  volumes:
  - name: host-root
    hostPath:
      path: /
EOF

echo "Forensics pod manifest created: ${OUTPUT_DIR}/forensics-pod.yaml"
echo "Deploy it with: kubectl apply -f ${OUTPUT_DIR}/forensics-pod.yaml"
```

### Analyzing Container Images

Analyze container images for vulnerabilities and malware:

```bash
#!/bin/bash
# analyze-container-image.sh - Comprehensive container image analysis

IMAGE="$1"
EVIDENCE_DIR="./image-analysis-$(echo ${IMAGE} | tr '/:' '_')-$(date +%Y%m%d-%H%M%S)"

mkdir -p "${EVIDENCE_DIR}"

echo "Analyzing image: ${IMAGE}"

# Pull image
docker pull "${IMAGE}" || podman pull "${IMAGE}"

# Export image
docker save "${IMAGE}" -o "${EVIDENCE_DIR}/image.tar" || podman save "${IMAGE}" -o "${EVIDENCE_DIR}/image.tar"

# Image inspection
docker inspect "${IMAGE}" > "${EVIDENCE_DIR}/image-inspect.json" || podman inspect "${IMAGE}" > "${EVIDENCE_DIR}/image-inspect.json"

# Image history
docker history "${IMAGE}" --no-trunc > "${EVIDENCE_DIR}/image-history.txt" || podman history "${IMAGE}" --no-trunc > "${EVIDENCE_DIR}/image-history.txt"

# Vulnerability scanning with Trivy
echo "Running Trivy vulnerability scan..."
trivy image --format json --output "${EVIDENCE_DIR}/trivy-scan.json" "${IMAGE}"
trivy image --format table --output "${EVIDENCE_DIR}/trivy-scan.txt" "${IMAGE}"

# Scan with Grype
echo "Running Grype vulnerability scan..."
grype "${IMAGE}" -o json > "${EVIDENCE_DIR}/grype-scan.json"
grype "${IMAGE}" -o table > "${EVIDENCE_DIR}/grype-scan.txt"

# Scan with Syft for SBOM
echo "Generating SBOM with Syft..."
syft "${IMAGE}" -o json > "${EVIDENCE_DIR}/sbom.json"
syft "${IMAGE}" -o spdx-json > "${EVIDENCE_DIR}/sbom-spdx.json"

# Extract filesystem
echo "Extracting image filesystem..."
mkdir -p "${EVIDENCE_DIR}/filesystem"
docker create --name temp-forensics "${IMAGE}" || podman create --name temp-forensics "${IMAGE}"
docker export temp-forensics | tar -C "${EVIDENCE_DIR}/filesystem" -xf - || podman export temp-forensics | tar -C "${EVIDENCE_DIR}/filesystem" -xf -
docker rm temp-forensics || podman rm temp-forensics

# Analyze filesystem
echo "Analyzing extracted filesystem..."

# Find SUID/SGID binaries
find "${EVIDENCE_DIR}/filesystem" -type f \( -perm -4000 -o -perm -2000 \) -ls > "${EVIDENCE_DIR}/suid-sgid-files.txt"

# Find world-writable files
find "${EVIDENCE_DIR}/filesystem" -type f -perm -002 -ls > "${EVIDENCE_DIR}/world-writable-files.txt"

# Find hidden files
find "${EVIDENCE_DIR}/filesystem" -name ".*" -ls > "${EVIDENCE_DIR}/hidden-files.txt"

# Extract configuration files
mkdir -p "${EVIDENCE_DIR}/configs"
find "${EVIDENCE_DIR}/filesystem/etc" -type f 2>/dev/null | while read file; do
    cp --parents "$file" "${EVIDENCE_DIR}/configs/" 2>/dev/null || true
done

# Check for suspicious files
echo "Checking for suspicious patterns..."
{
    echo "=== Checking for embedded credentials ==="
    grep -r -i -E "(password|passwd|pwd|secret|token|api[_-]?key)" "${EVIDENCE_DIR}/filesystem" --include="*.conf" --include="*.env" --include="*.properties" 2>/dev/null | head -n 100

    echo ""
    echo "=== Checking for cryptocurrency miners ==="
    grep -r -i -E "(xmrig|minerd|cpuminer|stratum\+tcp)" "${EVIDENCE_DIR}/filesystem" 2>/dev/null

    echo ""
    echo "=== Checking for reverse shells ==="
    grep -r -i -E "(nc -l|/bin/sh|bash -i|python.*socket)" "${EVIDENCE_DIR}/filesystem" --include="*.sh" 2>/dev/null

    echo ""
    echo "=== Checking for cron jobs ==="
    find "${EVIDENCE_DIR}/filesystem" -path "*/cron*" -type f -exec cat {} \; 2>/dev/null

} > "${EVIDENCE_DIR}/suspicious-patterns.txt"

# ClamAV scan
if command -v clamscan &> /dev/null; then
    echo "Running ClamAV malware scan..."
    clamscan -r "${EVIDENCE_DIR}/filesystem" > "${EVIDENCE_DIR}/clamav-scan.txt" 2>&1
fi

# Generate report
cat > "${EVIDENCE_DIR}/ANALYSIS-REPORT.txt" << EOF
Container Image Analysis Report
================================

Image: ${IMAGE}
Analysis Date: $(date)
Analysis Host: $(hostname)

Image Details:
$(docker inspect "${IMAGE}" --format '- Image ID: {{.Id}}
- Created: {{.Created}}
- Size: {{.Size}} bytes
- Architecture: {{.Architecture}}
- OS: {{.Os}}' || podman inspect "${IMAGE}" --format '- Image ID: {{.Id}}
- Created: {{.Created}}
- Size: {{.Size}} bytes
- Architecture: {{.Architecture}}
- OS: {{.Os}}')

Vulnerability Summary:
$(jq -r '.Results[].Vulnerabilities | length' "${EVIDENCE_DIR}/trivy-scan.json" 2>/dev/null | awk '{sum+=$1} END {print "Total vulnerabilities found: " sum}')

Critical Findings:
$(jq -r '.Results[].Vulnerabilities[] | select(.Severity=="CRITICAL") | "- \(.VulnerabilityID): \(.PkgName) \(.InstalledVersion)"' "${EVIDENCE_DIR}/trivy-scan.json" 2>/dev/null | head -n 20)

SUID/SGID Binaries: $(wc -l < "${EVIDENCE_DIR}/suid-sgid-files.txt")
World-Writable Files: $(wc -l < "${EVIDENCE_DIR}/world-writable-files.txt")

Suspicious Patterns Found:
$(grep -c -i "password\|secret\|token" "${EVIDENCE_DIR}/suspicious-patterns.txt" || echo "0")

For detailed results, see:
- Vulnerability scans: trivy-scan.txt, grype-scan.txt
- SBOM: sbom.json
- Suspicious patterns: suspicious-patterns.txt
- Filesystem analysis: filesystem/

EOF

cat "${EVIDENCE_DIR}/ANALYSIS-REPORT.txt"
echo ""
echo "Full analysis saved to: ${EVIDENCE_DIR}"
```

## Network Traffic Capture

### Pod-Level Packet Capture

Capture network traffic for specific pods:

```bash
#!/bin/bash
# capture-pod-traffic.sh - Capture network traffic from specific pod

POD_NAME="$1"
NAMESPACE="${2:-default}"
DURATION="${3:-60}"
EVIDENCE_DIR="./network-capture-${POD_NAME}-$(date +%Y%m%d-%H%M%S)"

mkdir -p "${EVIDENCE_DIR}"

echo "Capturing network traffic from ${NAMESPACE}/${POD_NAME} for ${DURATION} seconds"

# Get pod IP
POD_IP=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.status.podIP}')
echo "Pod IP: ${POD_IP}"

# Get node name
NODE=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.nodeName}')
echo "Node: ${NODE}"

# Method 1: Deploy tcpdump sidecar (requires pod modification)
cat > "${EVIDENCE_DIR}/tcpdump-sidecar.yaml" << EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${POD_NAME}-tcpdump
  namespace: ${NAMESPACE}
spec:
  hostNetwork: true
  nodeName: ${NODE}
  containers:
  - name: tcpdump
    image: nicolaka/netshoot
    command:
    - tcpdump
    - -i
    - any
    - -w
    - /captures/capture.pcap
    - host
    - ${POD_IP}
    securityContext:
      capabilities:
        add:
        - NET_ADMIN
        - NET_RAW
    volumeMounts:
    - name: captures
      mountPath: /captures
  volumes:
  - name: captures
    hostPath:
      path: /tmp/k8s-captures
      type: DirectoryOrCreate
EOF

kubectl apply -f "${EVIDENCE_DIR}/tcpdump-sidecar.yaml"

echo "Waiting for capture to complete..."
sleep "${DURATION}"

# Copy capture file
kubectl cp "${NAMESPACE}/${POD_NAME}-tcpdump:/captures/capture.pcap" "${EVIDENCE_DIR}/capture.pcap"

# Cleanup
kubectl delete pod -n "${NAMESPACE}" "${POD_NAME}-tcpdump"

# Analyze capture
if command -v tshark &> /dev/null; then
    echo "Analyzing captured traffic..."

    # Protocol hierarchy
    tshark -r "${EVIDENCE_DIR}/capture.pcap" -q -z io,phs > "${EVIDENCE_DIR}/protocol-hierarchy.txt"

    # Conversations
    tshark -r "${EVIDENCE_DIR}/capture.pcap" -q -z conv,tcp > "${EVIDENCE_DIR}/tcp-conversations.txt"
    tshark -r "${EVIDENCE_DIR}/capture.pcap" -q -z conv,udp > "${EVIDENCE_DIR}/udp-conversations.txt"

    # DNS queries
    tshark -r "${EVIDENCE_DIR}/capture.pcap" -Y "dns.flags.response == 0" -T fields -e dns.qry.name > "${EVIDENCE_DIR}/dns-queries.txt"

    # HTTP requests
    tshark -r "${EVIDENCE_DIR}/capture.pcap" -Y "http.request" -T fields -e http.request.method -e http.host -e http.request.uri > "${EVIDENCE_DIR}/http-requests.txt"

    # TLS/SSL info
    tshark -r "${EVIDENCE_DIR}/capture.pcap" -Y "ssl.handshake.type == 1" -T fields -e ip.src -e ip.dst -e ssl.handshake.extensions_server_name > "${EVIDENCE_DIR}/tls-connections.txt"
fi

echo "Network capture saved to: ${EVIDENCE_DIR}"
```

## Chain of Custody and Evidence Preservation

### Evidence Chain of Custody System

Implement a comprehensive chain of custody system:

```go
// chain-of-custody.go - Chain of custody tracking system
package main

import (
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "io"
    "os"
    "time"
)

// CustodyRecord represents a single chain of custody entry
type CustodyRecord struct {
    Timestamp      time.Time         `json:"timestamp"`
    Action         string            `json:"action"`
    Custodian      string            `json:"custodian"`
    Location       string            `json:"location"`
    EvidenceHash   string            `json:"evidence_hash"`
    Notes          string            `json:"notes"`
    PreviousHash   string            `json:"previous_hash"`
    RecordHash     string            `json:"record_hash"`
}

// ChainOfCustody maintains the complete custody chain
type ChainOfCustody struct {
    IncidentID     string           `json:"incident_id"`
    EvidenceID     string           `json:"evidence_id"`
    Description    string           `json:"description"`
    OriginalHash   string           `json:"original_hash"`
    CreatedAt      time.Time        `json:"created_at"`
    Records        []CustodyRecord  `json:"records"`
}

// CalculateFileHash computes SHA-256 hash of a file
func CalculateFileHash(filepath string) (string, error) {
    file, err := os.Open(filepath)
    if err != nil {
        return "", err
    }
    defer file.Close()

    hash := sha256.New()
    if _, err := io.Copy(hash, file); err != nil {
        return "", err
    }

    return hex.EncodeToString(hash.Sum(nil)), nil
}

// CalculateRecordHash computes hash of the custody record
func (cr *CustodyRecord) CalculateRecordHash() string {
    data := fmt.Sprintf("%v%s%s%s%s%s%s",
        cr.Timestamp,
        cr.Action,
        cr.Custodian,
        cr.Location,
        cr.EvidenceHash,
        cr.Notes,
        cr.PreviousHash,
    )

    hash := sha256.Sum256([]byte(data))
    return hex.EncodeToString(hash[:])
}

// AddRecord adds a new custody record to the chain
func (coc *ChainOfCustody) AddRecord(action, custodian, location, notes string, evidencePath string) error {
    // Calculate current evidence hash
    evidenceHash, err := CalculateFileHash(evidencePath)
    if err != nil {
        return fmt.Errorf("failed to calculate evidence hash: %w", err)
    }

    // Verify evidence integrity
    if len(coc.Records) == 0 {
        // First record - set original hash
        coc.OriginalHash = evidenceHash
    } else {
        // Verify hash matches last record
        lastRecord := coc.Records[len(coc.Records)-1]
        if evidenceHash != lastRecord.EvidenceHash {
            return fmt.Errorf("evidence integrity check failed: hash mismatch")
        }
    }

    // Get previous record hash
    previousHash := ""
    if len(coc.Records) > 0 {
        previousHash = coc.Records[len(coc.Records)-1].RecordHash
    }

    // Create new record
    record := CustodyRecord{
        Timestamp:    time.Now().UTC(),
        Action:       action,
        Custodian:    custodian,
        Location:     location,
        EvidenceHash: evidenceHash,
        Notes:        notes,
        PreviousHash: previousHash,
    }

    // Calculate record hash
    record.RecordHash = record.CalculateRecordHash()

    // Add to chain
    coc.Records = append(coc.Records, record)

    return nil
}

// Verify checks the integrity of the entire chain
func (coc *ChainOfCustody) Verify(evidencePath string) error {
    // Check if chain is empty
    if len(coc.Records) == 0 {
        return fmt.Errorf("chain of custody is empty")
    }

    // Verify current evidence hash
    currentHash, err := CalculateFileHash(evidencePath)
    if err != nil {
        return fmt.Errorf("failed to calculate current evidence hash: %w", err)
    }

    lastRecord := coc.Records[len(coc.Records)-1]
    if currentHash != lastRecord.EvidenceHash {
        return fmt.Errorf("evidence has been modified: current hash does not match last record")
    }

    // Verify each record in the chain
    for i, record := range coc.Records {
        // Verify record hash
        calculatedHash := record.CalculateRecordHash()
        if calculatedHash != record.RecordHash {
            return fmt.Errorf("record %d has been tampered with", i)
        }

        // Verify chain linkage
        if i > 0 {
            previousRecord := coc.Records[i-1]
            if record.PreviousHash != previousRecord.RecordHash {
                return fmt.Errorf("chain broken at record %d", i)
            }
        }
    }

    return nil
}

// Save writes the chain of custody to a JSON file
func (coc *ChainOfCustody) Save(filepath string) error {
    data, err := json.MarshalIndent(coc, "", "  ")
    if err != nil {
        return err
    }

    return os.WriteFile(filepath, data, 0600)
}

// Load reads a chain of custody from a JSON file
func Load(filepath string) (*ChainOfCustody, error) {
    data, err := os.ReadFile(filepath)
    if err != nil {
        return nil, err
    }

    var coc ChainOfCustody
    if err := json.Unmarshal(data, &coc); err != nil {
        return nil, err
    }

    return &coc, nil
}

// GenerateReport creates a human-readable chain of custody report
func (coc *ChainOfCustody) GenerateReport() string {
    report := fmt.Sprintf(`CHAIN OF CUSTODY REPORT
======================

Incident ID: %s
Evidence ID: %s
Description: %s
Original Hash: %s
Created: %s

CUSTODY RECORDS:
`, coc.IncidentID, coc.EvidenceID, coc.Description, coc.OriginalHash, coc.CreatedAt.Format(time.RFC3339))

    for i, record := range coc.Records {
        report += fmt.Sprintf(`
[Record %d]
Timestamp: %s
Action: %s
Custodian: %s
Location: %s
Evidence Hash: %s
Notes: %s
Record Hash: %s
`, i+1,
            record.Timestamp.Format(time.RFC3339),
            record.Action,
            record.Custodian,
            record.Location,
            record.EvidenceHash,
            record.Notes,
            record.RecordHash,
        )
    }

    return report
}

func main() {
    if len(os.Args) < 2 {
        fmt.Println("Usage:")
        fmt.Println("  Create new chain: chain-of-custody create <incident-id> <evidence-id> <evidence-file>")
        fmt.Println("  Add record: chain-of-custody add <chain-file> <action> <custodian> <location> <notes> <evidence-file>")
        fmt.Println("  Verify chain: chain-of-custody verify <chain-file> <evidence-file>")
        fmt.Println("  Generate report: chain-of-custody report <chain-file>")
        os.Exit(1)
    }

    command := os.Args[1]

    switch command {
    case "create":
        if len(os.Args) != 5 {
            fmt.Println("Usage: chain-of-custody create <incident-id> <evidence-id> <evidence-file>")
            os.Exit(1)
        }

        incidentID := os.Args[2]
        evidenceID := os.Args[3]
        evidencePath := os.Args[4]

        hash, err := CalculateFileHash(evidencePath)
        if err != nil {
            fmt.Printf("Error calculating hash: %v\n", err)
            os.Exit(1)
        }

        coc := &ChainOfCustody{
            IncidentID:   incidentID,
            EvidenceID:   evidenceID,
            Description:  fmt.Sprintf("Evidence collected for incident %s", incidentID),
            OriginalHash: hash,
            CreatedAt:    time.Now().UTC(),
            Records:      []CustodyRecord{},
        }

        hostname, _ := os.Hostname()
        if err := coc.AddRecord("COLLECTED", os.Getenv("USER"), hostname, "Initial evidence collection", evidencePath); err != nil {
            fmt.Printf("Error adding initial record: %v\n", err)
            os.Exit(1)
        }

        chainFile := fmt.Sprintf("chain-of-custody-%s-%s.json", incidentID, evidenceID)
        if err := coc.Save(chainFile); err != nil {
            fmt.Printf("Error saving chain: %v\n", err)
            os.Exit(1)
        }

        fmt.Printf("Chain of custody created: %s\n", chainFile)

    case "add":
        if len(os.Args) != 8 {
            fmt.Println("Usage: chain-of-custody add <chain-file> <action> <custodian> <location> <notes> <evidence-file>")
            os.Exit(1)
        }

        chainFile := os.Args[2]
        action := os.Args[3]
        custodian := os.Args[4]
        location := os.Args[5]
        notes := os.Args[6]
        evidencePath := os.Args[7]

        coc, err := Load(chainFile)
        if err != nil {
            fmt.Printf("Error loading chain: %v\n", err)
            os.Exit(1)
        }

        if err := coc.AddRecord(action, custodian, location, notes, evidencePath); err != nil {
            fmt.Printf("Error adding record: %v\n", err)
            os.Exit(1)
        }

        if err := coc.Save(chainFile); err != nil {
            fmt.Printf("Error saving chain: %v\n", err)
            os.Exit(1)
        }

        fmt.Println("Record added successfully")

    case "verify":
        if len(os.Args) != 4 {
            fmt.Println("Usage: chain-of-custody verify <chain-file> <evidence-file>")
            os.Exit(1)
        }

        chainFile := os.Args[2]
        evidencePath := os.Args[3]

        coc, err := Load(chainFile)
        if err != nil {
            fmt.Printf("Error loading chain: %v\n", err)
            os.Exit(1)
        }

        if err := coc.Verify(evidencePath); err != nil {
            fmt.Printf("Verification FAILED: %v\n", err)
            os.Exit(1)
        }

        fmt.Println("Chain of custody verification PASSED")

    case "report":
        if len(os.Args) != 3 {
            fmt.Println("Usage: chain-of-custody report <chain-file>")
            os.Exit(1)
        }

        chainFile := os.Args[2]

        coc, err := Load(chainFile)
        if err != nil {
            fmt.Printf("Error loading chain: %v\n", err)
            os.Exit(1)
        }

        fmt.Println(coc.GenerateReport())

    default:
        fmt.Printf("Unknown command: %s\n", command)
        os.Exit(1)
    }
}
```

## Kubernetes Audit Log Analysis

### Audit Log Parser and Analyzer

Parse and analyze Kubernetes audit logs for forensic evidence:

```python
#!/usr/bin/env python3
# k8s-audit-analyzer.py - Kubernetes audit log forensics analyzer

import json
import sys
from datetime import datetime
from collections import defaultdict
from typing import Dict, List, Set

class K8sAuditAnalyzer:
    def __init__(self, audit_log_path: str):
        self.audit_log_path = audit_log_path
        self.events = []
        self.load_events()

    def load_events(self):
        """Load audit events from log file"""
        print(f"Loading audit events from {self.audit_log_path}...")

        with open(self.audit_log_path, 'r') as f:
            for line in f:
                try:
                    event = json.loads(line.strip())
                    self.events.append(event)
                except json.JSONDecodeError:
                    continue

        print(f"Loaded {len(self.events)} audit events")

    def analyze_timeline(self, start_time: str = None, end_time: str = None) -> List[Dict]:
        """Analyze events within a time range"""
        filtered_events = []

        for event in self.events:
            event_time = event.get('requestReceivedTimestamp', '')

            if start_time and event_time < start_time:
                continue
            if end_time and event_time > end_time:
                continue

            filtered_events.append(event)

        return filtered_events

    def find_user_actions(self, username: str) -> List[Dict]:
        """Find all actions performed by a specific user"""
        user_events = []

        for event in self.events:
            user = event.get('user', {}).get('username', '')
            if user == username:
                user_events.append(event)

        return user_events

    def find_resource_access(self, resource_type: str, resource_name: str = None) -> List[Dict]:
        """Find all access to a specific resource"""
        resource_events = []

        for event in self.events:
            obj_ref = event.get('objectRef', {})
            if obj_ref.get('resource') == resource_type:
                if resource_name is None or obj_ref.get('name') == resource_name:
                    resource_events.append(event)

        return resource_events

    def find_failed_operations(self) -> List[Dict]:
        """Find all failed API operations"""
        failed_events = []

        for event in self.events:
            status_code = event.get('responseStatus', {}).get('code', 0)
            if status_code >= 400:
                failed_events.append(event)

        return failed_events

    def find_privileged_operations(self) -> List[Dict]:
        """Find operations using privileged service accounts or admin roles"""
        privileged_events = []

        privileged_patterns = [
            'system:masters',
            'cluster-admin',
            'system:admin',
            'admin',
        ]

        for event in self.events:
            user_groups = event.get('user', {}).get('groups', [])
            username = event.get('user', {}).get('username', '')

            if any(pattern in username.lower() or pattern in ' '.join(user_groups).lower()
                   for pattern in privileged_patterns):
                privileged_events.append(event)

        return privileged_events

    def find_secret_access(self) -> List[Dict]:
        """Find all Secret resource access"""
        return self.find_resource_access('secrets')

    def find_exec_operations(self) -> List[Dict]:
        """Find all pod exec operations"""
        exec_events = []

        for event in self.events:
            if event.get('verb') == 'create' and 'exec' in event.get('requestURI', ''):
                exec_events.append(event)

        return exec_events

    def find_deletion_operations(self) -> List[Dict]:
        """Find all resource deletion operations"""
        deletion_events = []

        for event in self.events:
            if event.get('verb') == 'delete':
                deletion_events.append(event)

        return deletion_events

    def analyze_anomalies(self) -> Dict[str, List[Dict]]:
        """Detect potential security anomalies"""
        anomalies = {
            'suspicious_exec': [],
            'secret_exfiltration': [],
            'privilege_escalation': [],
            'unusual_source_ips': [],
            'off_hours_activity': [],
        }

        # Track normal patterns
        common_source_ips = self._get_common_source_ips()

        for event in self.events:
            # Check for suspicious exec operations
            if event.get('verb') == 'create' and 'exec' in event.get('requestURI', ''):
                source_ip = event.get('sourceIPs', [''])[0]
                if source_ip not in common_source_ips:
                    anomalies['suspicious_exec'].append(event)

            # Check for secret access
            obj_ref = event.get('objectRef', {})
            if obj_ref.get('resource') == 'secrets':
                if event.get('verb') in ['get', 'list']:
                    anomalies['secret_exfiltration'].append(event)

            # Check for RBAC modifications
            if obj_ref.get('resource') in ['clusterrolebindings', 'rolebindings']:
                if event.get('verb') in ['create', 'update', 'patch']:
                    anomalies['privilege_escalation'].append(event)

            # Check for unusual source IPs
            source_ip = event.get('sourceIPs', [''])[0]
            if source_ip and source_ip not in common_source_ips and not source_ip.startswith('127.'):
                anomalies['unusual_source_ips'].append(event)

            # Check for off-hours activity (example: 2 AM - 6 AM UTC)
            timestamp = event.get('requestReceivedTimestamp', '')
            if timestamp:
                try:
                    dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                    if 2 <= dt.hour < 6:
                        anomalies['off_hours_activity'].append(event)
                except:
                    pass

        return anomalies

    def _get_common_source_ips(self, threshold: int = 10) -> Set[str]:
        """Identify commonly seen source IPs"""
        ip_counts = defaultdict(int)

        for event in self.events:
            for ip in event.get('sourceIPs', []):
                ip_counts[ip] += 1

        return {ip for ip, count in ip_counts.items() if count >= threshold}

    def generate_forensics_report(self, output_path: str):
        """Generate comprehensive forensics report"""
        print(f"Generating forensics report...")

        with open(output_path, 'w') as f:
            f.write("KUBERNETES AUDIT LOG FORENSICS REPORT\n")
            f.write("=" * 80 + "\n\n")
            f.write(f"Generated: {datetime.now().isoformat()}\n")
            f.write(f"Audit Log: {self.audit_log_path}\n")
            f.write(f"Total Events: {len(self.events)}\n\n")

            # Failed operations
            f.write("FAILED OPERATIONS\n")
            f.write("-" * 80 + "\n")
            failed_ops = self.find_failed_operations()
            f.write(f"Total Failed Operations: {len(failed_ops)}\n\n")
            for event in failed_ops[:50]:  # Limit to first 50
                f.write(f"Time: {event.get('requestReceivedTimestamp', 'N/A')}\n")
                f.write(f"User: {event.get('user', {}).get('username', 'N/A')}\n")
                f.write(f"Verb: {event.get('verb', 'N/A')}\n")
                f.write(f"Resource: {event.get('objectRef', {}).get('resource', 'N/A')}\n")
                f.write(f"Name: {event.get('objectRef', {}).get('name', 'N/A')}\n")
                f.write(f"Status: {event.get('responseStatus', {}).get('code', 'N/A')}\n")
                f.write(f"Message: {event.get('responseStatus', {}).get('message', 'N/A')}\n\n")

            # Privileged operations
            f.write("\nPRIVILEGED OPERATIONS\n")
            f.write("-" * 80 + "\n")
            priv_ops = self.find_privileged_operations()
            f.write(f"Total Privileged Operations: {len(priv_ops)}\n\n")
            for event in priv_ops[:50]:
                f.write(f"Time: {event.get('requestReceivedTimestamp', 'N/A')}\n")
                f.write(f"User: {event.get('user', {}).get('username', 'N/A')}\n")
                f.write(f"Groups: {', '.join(event.get('user', {}).get('groups', []))}\n")
                f.write(f"Verb: {event.get('verb', 'N/A')}\n")
                f.write(f"Resource: {event.get('objectRef', {}).get('resource', 'N/A')}\n")
                f.write(f"Name: {event.get('objectRef', {}).get('name', 'N/A')}\n\n")

            # Exec operations
            f.write("\nPOD EXEC OPERATIONS\n")
            f.write("-" * 80 + "\n")
            exec_ops = self.find_exec_operations()
            f.write(f"Total Exec Operations: {len(exec_ops)}\n\n")
            for event in exec_ops[:50]:
                f.write(f"Time: {event.get('requestReceivedTimestamp', 'N/A')}\n")
                f.write(f"User: {event.get('user', {}).get('username', 'N/A')}\n")
                f.write(f"Source IP: {', '.join(event.get('sourceIPs', []))}\n")
                f.write(f"URI: {event.get('requestURI', 'N/A')}\n\n")

            # Secret access
            f.write("\nSECRET ACCESS OPERATIONS\n")
            f.write("-" * 80 + "\n")
            secret_ops = self.find_secret_access()
            f.write(f"Total Secret Access Operations: {len(secret_ops)}\n\n")
            for event in secret_ops[:50]:
                f.write(f"Time: {event.get('requestReceivedTimestamp', 'N/A')}\n")
                f.write(f"User: {event.get('user', {}).get('username', 'N/A')}\n")
                f.write(f"Verb: {event.get('verb', 'N/A')}\n")
                f.write(f"Namespace: {event.get('objectRef', {}).get('namespace', 'N/A')}\n")
                f.write(f"Secret: {event.get('objectRef', {}).get('name', 'N/A')}\n\n")

            # Deletions
            f.write("\nDELETION OPERATIONS\n")
            f.write("-" * 80 + "\n")
            delete_ops = self.find_deletion_operations()
            f.write(f"Total Deletion Operations: {len(delete_ops)}\n\n")
            for event in delete_ops[:50]:
                f.write(f"Time: {event.get('requestReceivedTimestamp', 'N/A')}\n")
                f.write(f"User: {event.get('user', {}).get('username', 'N/A')}\n")
                f.write(f"Resource: {event.get('objectRef', {}).get('resource', 'N/A')}\n")
                f.write(f"Namespace: {event.get('objectRef', {}).get('namespace', 'N/A')}\n")
                f.write(f"Name: {event.get('objectRef', {}).get('name', 'N/A')}\n\n")

            # Anomalies
            f.write("\nDETECTED ANOMALIES\n")
            f.write("-" * 80 + "\n")
            anomalies = self.analyze_anomalies()
            for anomaly_type, events in anomalies.items():
                f.write(f"\n{anomaly_type.upper().replace('_', ' ')}: {len(events)} events\n")
                for event in events[:20]:
                    f.write(f"  Time: {event.get('requestReceivedTimestamp', 'N/A')}\n")
                    f.write(f"  User: {event.get('user', {}).get('username', 'N/A')}\n")
                    f.write(f"  Action: {event.get('verb', 'N/A')} {event.get('objectRef', {}).get('resource', 'N/A')}\n")
                    f.write(f"  Source IP: {', '.join(event.get('sourceIPs', []))}\n\n")

        print(f"Report generated: {output_path}")

def main():
    if len(sys.argv) < 2:
        print("Usage: k8s-audit-analyzer.py <audit-log-file> [output-report]")
        sys.exit(1)

    audit_log_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else "forensics-report.txt"

    analyzer = K8sAuditAnalyzer(audit_log_path)
    analyzer.generate_forensics_report(output_path)

if __name__ == "__main__":
    main()
```

## Conclusion

Kubernetes forensics and evidence collection requires a systematic approach that balances the need for comprehensive data gathering with the ephemeral nature of container environments. By implementing automated collection tools, maintaining proper chain of custody, and preserving evidence integrity, organizations can effectively investigate security incidents while maintaining the evidential value required for remediation and potential legal proceedings.

Key takeaways:

1. **Act Quickly**: Container evidence is highly volatile; immediate collection is critical
2. **Automate Collection**: Use automated tools to capture comprehensive cluster state consistently
3. **Maintain Chain of Custody**: Proper documentation and integrity verification are essential
4. **Multi-Layer Analysis**: Examine all layers from application to infrastructure
5. **Preserve, Don't Modify**: Collect evidence without altering the original state
6. **Document Everything**: Maintain detailed logs of all forensics activities

The tools and procedures presented here provide a foundation for enterprise-grade Kubernetes forensics capabilities, enabling security teams to respond effectively to incidents while preserving the evidence needed for thorough investigation and remediation.