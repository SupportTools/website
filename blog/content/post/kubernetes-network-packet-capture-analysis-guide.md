---
title: "Network Packet Capture in Kubernetes: Enterprise Traffic Analysis Guide"
date: 2026-09-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Network", "Packet Capture", "Wireshark", "tcpdump", "Security", "Troubleshooting"]
categories: ["Kubernetes", "Networking", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to network packet capture and analysis in Kubernetes environments, including pod-level captures, service mesh traffic inspection, and encrypted traffic analysis for enterprise troubleshooting."
more_link: "yes"
url: "/kubernetes-network-packet-capture-analysis-guide/"
---

Master network packet capture and analysis in Kubernetes with production-ready techniques for pod-level traffic inspection, service mesh analysis, encrypted traffic decryption, and comprehensive troubleshooting workflows for enterprise environments.

<!--more-->

# Network Packet Capture in Kubernetes: Enterprise Traffic Analysis Guide

## Executive Summary

Network troubleshooting and security investigation in Kubernetes require the ability to capture and analyze pod-to-pod traffic, service mesh communications, and external connections. This comprehensive guide covers enterprise-grade techniques for packet capture at various levels of the Kubernetes networking stack, analysis of captured traffic, and troubleshooting workflows for complex networking issues. We'll explore both manual and automated approaches, handling encrypted traffic, and integration with service mesh technologies.

## Understanding Kubernetes Network Layers

### Kubernetes Networking Stack

```
┌─────────────────────────────────────────┐
│        Application (Pod)                │
│  ┌──────────────────────────────────┐   │
│  │ App Process (Port 8080)          │   │
│  └──────────────────────────────────┘   │
├─────────────────────────────────────────┤
│     Service (ClusterIP/NodePort)        │
│  - iptables/nftables rules              │
│  - kube-proxy                           │
├─────────────────────────────────────────┤
│     CNI Plugin (Calico/Cilium/etc)      │
│  - Pod networking                       │
│  - Network policies                     │
├─────────────────────────────────────────┤
│     Node Network Stack                  │
│  - veth pairs                           │
│  - bridges (cni0, docker0)              │
│  - routing tables                       │
├─────────────────────────────────────────┤
│     Physical/Virtual Network            │
│  - Node network interface               │
│  - Underlying network fabric            │
└─────────────────────────────────────────┘
```

### Capture Points

Different capture points provide different perspectives:

1. **Inside Pod**: Application-level traffic before encryption/encapsulation
2. **Pod Network Interface (veth)**: Pod traffic with CNI encapsulation
3. **Node Network Interface**: All pod traffic on the node
4. **Service Mesh Sidecar**: mTLS encrypted service mesh traffic
5. **Ingress/Egress Gateway**: External traffic entry/exit points

## Pod-Level Packet Capture

### Basic Pod Traffic Capture

Capture traffic from a specific pod:

```bash
#!/bin/bash
# pod-packet-capture.sh - Capture traffic from Kubernetes pod

set -euo pipefail

POD_NAME="${1:-}"
NAMESPACE="${2:-default}"
DURATION="${3:-60}"
FILTER="${4:-}"
OUTPUT_DIR="./pcap-${POD_NAME}-$(date +%Y%m%d-%H%M%S)"

if [[ -z "${POD_NAME}" ]]; then
    echo "Usage: $0 <pod-name> [namespace] [duration-seconds] [filter]"
    echo "Example: $0 nginx-pod default 60 'port 80'"
    exit 1
fi

mkdir -p "${OUTPUT_DIR}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${OUTPUT_DIR}/capture.log"
}

log "Starting packet capture for ${NAMESPACE}/${POD_NAME}"

# Get pod information
kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o yaml > "${OUTPUT_DIR}/pod-spec.yaml"

POD_IP=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.status.podIP}')
NODE=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.nodeName}')

log "Pod IP: ${POD_IP}"
log "Node: ${NODE}"

# Build tcpdump filter
TCPDUMP_FILTER="host ${POD_IP}"
if [[ -n "${FILTER}" ]]; then
    TCPDUMP_FILTER="${TCPDUMP_FILTER} and (${FILTER})"
fi

log "Capture filter: ${TCPDUMP_FILTER}"

# Method 1: Ephemeral debug container (Kubernetes 1.18+)
log "METHOD 1: Using ephemeral debug container..."

kubectl debug -n "${NAMESPACE}" "${POD_NAME}" \
    --image=nicolaka/netshoot:latest \
    --target=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.containers[0].name}') \
    -- tcpdump -i any -w /tmp/capture.pcap "${TCPDUMP_FILTER}" -c 10000 &

DEBUG_PID=$!
sleep "${DURATION}"
kill ${DEBUG_PID} 2>/dev/null || true

# Method 2: Deploy tcpdump sidecar on same node
log "METHOD 2: Deploying tcpdump pod on node ${NODE}..."

cat > "${OUTPUT_DIR}/tcpdump-pod.yaml" << EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${POD_NAME}-tcpdump
  namespace: ${NAMESPACE}
  labels:
    app: tcpdump
    target: ${POD_NAME}
spec:
  nodeName: ${NODE}
  hostNetwork: true
  containers:
  - name: tcpdump
    image: nicolaka/netshoot:latest
    command:
    - tcpdump
    - -i
    - any
    - -w
    - /captures/capture.pcap
    - -G
    - "${DURATION}"
    - -W
    - "1"
    - "${TCPDUMP_FILTER}"
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
  restartPolicy: Never
EOF

kubectl apply -f "${OUTPUT_DIR}/tcpdump-pod.yaml"

# Wait for capture pod to be ready
kubectl wait --for=condition=Ready pod -n "${NAMESPACE}" "${POD_NAME}-tcpdump" --timeout=30s

log "Capture pod ready, collecting for ${DURATION} seconds..."
sleep "${DURATION}"

# Wait for tcpdump to finish
log "Waiting for tcpdump to complete..."
kubectl wait --for=condition=Complete pod -n "${NAMESPACE}" "${POD_NAME}-tcpdump" --timeout=60s || true

# Copy capture file
log "Retrieving capture file..."
kubectl cp "${NAMESPACE}/${POD_NAME}-tcpdump:/captures/capture.pcap" "${OUTPUT_DIR}/capture.pcap" || true

# Cleanup
log "Cleaning up capture pod..."
kubectl delete pod -n "${NAMESPACE}" "${POD_NAME}-tcpdump" --grace-period=0 --force || true

# Method 3: Node-level capture using privileged pod
log "METHOD 3: Node-level capture using nsenter..."

cat > "${OUTPUT_DIR}/node-capture-pod.yaml" << EOF
apiVersion: v1
kind: Pod
metadata:
  name: node-capture-${NODE}
  namespace: kube-system
spec:
  nodeName: ${NODE}
  hostPID: true
  hostNetwork: true
  containers:
  - name: nsenter
    image: nicolaka/netshoot:latest
    command: ['sleep', 'infinity']
    securityContext:
      privileged: true
    volumeMounts:
    - name: host
      mountPath: /host
  volumes:
  - name: host
    hostPath:
      path: /
  restartPolicy: Never
EOF

kubectl apply -f "${OUTPUT_DIR}/node-capture-pod.yaml"
kubectl wait --for=condition=Ready pod -n kube-system "node-capture-${NODE}" --timeout=30s

# Get pod's network namespace
CONTAINER_ID=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.status.containerStatuses[0].containerID}' | cut -d'/' -f3)

log "Container ID: ${CONTAINER_ID}"

# Find container PID
kubectl exec -n kube-system "node-capture-${NODE}" -- bash -c "
    crictl inspect ${CONTAINER_ID} | jq -r '.info.pid' > /tmp/container-pid
" 2>/dev/null || kubectl exec -n kube-system "node-capture-${NODE}" -- bash -c "
    docker inspect --format '{{.State.Pid}}' ${CONTAINER_ID} > /tmp/container-pid
" 2>/dev/null

CONTAINER_PID=$(kubectl exec -n kube-system "node-capture-${NODE}" -- cat /tmp/container-pid)

log "Container PID: ${CONTAINER_PID}"

# Capture using nsenter to enter container's network namespace
kubectl exec -n kube-system "node-capture-${NODE}" -- nsenter -t "${CONTAINER_PID}" -n tcpdump \
    -i any -w /host/tmp/capture-nsenter.pcap "${TCPDUMP_FILTER}" -c 10000 &

CAPTURE_PID=$!
sleep "${DURATION}"
kill ${CAPTURE_PID} 2>/dev/null || true

# Copy capture from node
kubectl cp "kube-system/node-capture-${NODE}:/host/tmp/capture-nsenter.pcap" "${OUTPUT_DIR}/capture-nsenter.pcap" || true

# Cleanup node capture pod
kubectl delete pod -n kube-system "node-capture-${NODE}" --force --grace-period=0

# Analyze captures
log "Analyzing captured traffic..."

if [[ -f "${OUTPUT_DIR}/capture.pcap" ]]; then
    analyze_pcap "${OUTPUT_DIR}/capture.pcap" "${OUTPUT_DIR}/analysis.txt"
elif [[ -f "${OUTPUT_DIR}/capture-nsenter.pcap" ]]; then
    analyze_pcap "${OUTPUT_DIR}/capture-nsenter.pcap" "${OUTPUT_DIR}/analysis.txt"
else
    log "WARNING: No capture files found!"
fi

log "Packet capture complete!"
log "Output directory: ${OUTPUT_DIR}"
```

### Advanced Capture with ksniff

Use ksniff for simplified pod packet capture:

```bash
#!/bin/bash
# ksniff-capture.sh - Simplified packet capture using ksniff

POD_NAME="${1:-}"
NAMESPACE="${2:-default}"
DURATION="${3:-60}"
FILTER="${4:-}"

if [[ -z "${POD_NAME}" ]]; then
    echo "Usage: $0 <pod-name> [namespace] [duration] [filter]"
    exit 1
fi

# Install ksniff plugin if not present
if ! kubectl krew list | grep -q sniff; then
    echo "Installing ksniff..."
    kubectl krew install sniff
fi

OUTPUT_FILE="capture-${POD_NAME}-$(date +%Y%m%d-%H%M%S).pcap"

echo "Starting capture with ksniff..."

# Start capture
if [[ -n "${FILTER}" ]]; then
    timeout "${DURATION}" kubectl sniff -n "${NAMESPACE}" "${POD_NAME}" \
        -o "${OUTPUT_FILE}" -f "${FILTER}"
else
    timeout "${DURATION}" kubectl sniff -n "${NAMESPACE}" "${POD_NAME}" \
        -o "${OUTPUT_FILE}"
fi

echo "Capture saved to: ${OUTPUT_FILE}"

# Open in Wireshark if available
if command -v wireshark &> /dev/null; then
    echo "Opening in Wireshark..."
    wireshark "${OUTPUT_FILE}" &
fi
```

## Service Mesh Traffic Capture

### Istio/Envoy Traffic Analysis

Capture and analyze service mesh traffic:

```bash
#!/bin/bash
# service-mesh-capture.sh - Capture Istio/Envoy service mesh traffic

set -euo pipefail

POD_NAME="${1:-}"
NAMESPACE="${2:-default}"
OUTPUT_DIR="./service-mesh-capture-$(date +%Y%m%d-%H%M%S)"

mkdir -p "${OUTPUT_DIR}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${OUTPUT_DIR}/capture.log"
}

log "Analyzing service mesh traffic for ${NAMESPACE}/${POD_NAME}"

# Check if pod has Istio sidecar
if ! kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.spec.containers[*].name}' | grep -q istio-proxy; then
    log "ERROR: Pod does not have istio-proxy sidecar"
    exit 1
fi

# Get Envoy admin interface
POD_IP=$(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.status.podIP}')
log "Pod IP: ${POD_IP}"

# Capture Envoy configuration
log "Capturing Envoy configuration..."
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- curl -s http://localhost:15000/config_dump > "${OUTPUT_DIR}/envoy-config.json"

# Capture Envoy stats
log "Capturing Envoy statistics..."
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- curl -s http://localhost:15000/stats > "${OUTPUT_DIR}/envoy-stats.txt"

# Capture Envoy clusters
log "Capturing Envoy clusters..."
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- curl -s http://localhost:15000/clusters > "${OUTPUT_DIR}/envoy-clusters.txt"

# Capture active connections
log "Capturing active connections..."
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- netstat -tunap > "${OUTPUT_DIR}/connections.txt" 2>&1

# Enable Envoy debug logging temporarily
log "Enabling Envoy debug logging..."
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- curl -X POST "http://localhost:15000/logging?level=debug"

# Capture logs with debug enabled
log "Capturing Envoy logs..."
kubectl logs -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy --tail=1000 > "${OUTPUT_DIR}/envoy-logs.txt"

# Capture actual network traffic
log "Capturing network traffic..."
kubectl debug -n "${NAMESPACE}" "${POD_NAME}" \
    --image=nicolaka/netshoot:latest \
    --target=istio-proxy \
    -- timeout 60 tcpdump -i any -w /tmp/mesh-traffic.pcap &

sleep 65

# Restore logging level
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- curl -X POST "http://localhost:15000/logging?level=info"

# Analyze Envoy access logs
log "Analyzing Envoy access logs..."
kubectl logs -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy | \
    grep -E '(\[.*\])' | \
    tail -n 1000 > "${OUTPUT_DIR}/access-logs.txt"

# Parse access logs for traffic patterns
python3 << 'EOF' > "${OUTPUT_DIR}/traffic-analysis.txt"
import json
import sys
from collections import defaultdict

# Read access logs
with open(sys.argv[1], 'r') as f:
    logs = f.readlines()

# Analyze patterns
endpoints = defaultdict(int)
status_codes = defaultdict(int)
methods = defaultdict(int)

for line in logs:
    try:
        # Parse Envoy access log format
        if '"' in line:
            parts = line.split('"')
            if len(parts) >= 2:
                request = parts[1]
                method, path, _ = request.split(' ', 2)
                methods[method] += 1
                endpoints[path] += 1

            # Extract status code
            if '] ' in line:
                status_part = line.split('] ')[1]
                if ' ' in status_part:
                    status = status_part.split(' ')[0]
                    status_codes[status] += 1
    except:
        pass

print("HTTP Methods:")
for method, count in sorted(methods.items(), key=lambda x: x[1], reverse=True):
    print(f"  {method}: {count}")

print("\nTop Endpoints:")
for endpoint, count in sorted(endpoints.items(), key=lambda x: x[1], reverse=True)[:20]:
    print(f"  {endpoint}: {count}")

print("\nStatus Codes:")
for status, count in sorted(status_codes.items()):
    print(f"  {status}: {count}")
EOF

python3 -u traffic-analysis-script.py "${OUTPUT_DIR}/access-logs.txt"

log "Service mesh capture complete!"
log "Output directory: ${OUTPUT_DIR}"
```

### Decrypt mTLS Traffic

Capture and decrypt service mesh mTLS traffic:

```bash
#!/bin/bash
# decrypt-mtls-traffic.sh - Decrypt Istio mTLS traffic

POD_NAME="${1:-}"
NAMESPACE="${2:-default}"
OUTPUT_DIR="./mtls-decrypt-$(date +%Y%m%d-%H%M%S)"

mkdir -p "${OUTPUT_DIR}"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "${OUTPUT_DIR}/capture.log"
}

log "Extracting certificates and keys for mTLS decryption..."

# Extract Envoy certificates and keys
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- \
    cat /etc/certs/cert-chain.pem > "${OUTPUT_DIR}/cert-chain.pem"

kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- \
    cat /etc/certs/key.pem > "${OUTPUT_DIR}/key.pem"

kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- \
    cat /etc/certs/root-cert.pem > "${OUTPUT_DIR}/root-cert.pem"

# Create combined PEM for Wireshark
cat "${OUTPUT_DIR}/key.pem" "${OUTPUT_DIR}/cert-chain.pem" > "${OUTPUT_DIR}/combined.pem"

log "Certificates extracted successfully"

# Capture traffic with SSL key logging
log "Starting packet capture with SSL key logging..."

# Set SSLKEYLOGFILE for Envoy (requires custom Envoy build)
kubectl exec -n "${NAMESPACE}" "${POD_NAME}" -c istio-proxy -- \
    sh -c 'SSLKEYLOGFILE=/tmp/sslkeylog.txt envoy -c /etc/istio/proxy/envoy-rev0.json &'

# Capture traffic
kubectl debug -n "${NAMESPACE}" "${POD_NAME}" \
    --image=nicolaka/netshoot:latest \
    --target=istio-proxy \
    -- timeout 60 tcpdump -i any -w /tmp/mtls-traffic.pcap host $(kubectl get pod -n "${NAMESPACE}" "${POD_NAME}" -o jsonpath='{.status.podIP}')

# Retrieve SSL key log
kubectl cp "${NAMESPACE}/${POD_NAME}:/tmp/sslkeylog.txt" "${OUTPUT_DIR}/sslkeylog.txt" -c istio-proxy || true

log "To decrypt in Wireshark:"
log "1. Edit -> Preferences -> Protocols -> TLS"
log "2. Set '(Pre)-Master-Secret log filename' to: ${OUTPUT_DIR}/sslkeylog.txt"
log "3. Or import RSA keys from: ${OUTPUT_DIR}/combined.pem"
```

## Network Traffic Analysis

### Automated PCAP Analysis

Analyze captured packets automatically:

```python
#!/usr/bin/env python3
# pcap-analyzer.py - Comprehensive PCAP analysis tool

import sys
import subprocess
import json
from pathlib import Path
from collections import defaultdict
import re

class PCAPAnalyzer:
    def __init__(self, pcap_file: str, output_dir: str):
        self.pcap_file = Path(pcap_file)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)

        self.stats = {
            'total_packets': 0,
            'protocols': defaultdict(int),
            'conversations': [],
            'dns_queries': [],
            'http_requests': [],
            'tls_connections': [],
            'errors': []
        }

    def analyze(self):
        """Run all analysis modules"""
        print(f"Analyzing PCAP: {self.pcap_file}")

        if not self.pcap_file.exists():
            print(f"ERROR: PCAP file not found: {self.pcap_file}")
            return

        self.extract_basic_stats()
        self.analyze_protocols()
        self.analyze_conversations()
        self.analyze_dns()
        self.analyze_http()
        self.analyze_tls()
        self.detect_anomalies()

        self.generate_report()

    def extract_basic_stats(self):
        """Extract basic packet statistics"""
        print("Extracting basic statistics...")

        try:
            result = subprocess.run(
                ['capinfos', '-T', str(self.pcap_file)],
                capture_output=True,
                text=True,
                timeout=30
            )

            # Parse capinfos output
            for line in result.stdout.split('\n'):
                if 'Number of packets' in line:
                    self.stats['total_packets'] = int(line.split(':')[1].strip())
                elif 'File size' in line:
                    self.stats['file_size'] = line.split(':')[1].strip()
                elif 'Data byte rate' in line:
                    self.stats['data_rate'] = line.split(':')[1].strip()
                elif 'Capture duration' in line:
                    self.stats['duration'] = line.split(':')[1].strip()

        except Exception as e:
            print(f"Error extracting stats: {e}")

    def analyze_protocols(self):
        """Analyze protocol hierarchy"""
        print("Analyzing protocols...")

        try:
            result = subprocess.run(
                ['tshark', '-r', str(self.pcap_file), '-q', '-z', 'io,phs'],
                capture_output=True,
                text=True,
                timeout=60
            )

            # Save protocol hierarchy
            with open(self.output_dir / "protocol-hierarchy.txt", 'w') as f:
                f.write(result.stdout)

            # Parse protocol statistics
            lines = result.stdout.split('\n')
            for line in lines:
                match = re.search(r'^\s*([\w\-]+)\s+frames:(\d+)', line)
                if match:
                    protocol = match.group(1)
                    count = int(match.group(2))
                    self.stats['protocols'][protocol] = count

        except Exception as e:
            print(f"Error analyzing protocols: {e}")

    def analyze_conversations(self):
        """Analyze network conversations"""
        print("Analyzing conversations...")

        for conv_type in ['tcp', 'udp', 'ip']:
            try:
                result = subprocess.run(
                    ['tshark', '-r', str(self.pcap_file), '-q', '-z', f'conv,{conv_type}'],
                    capture_output=True,
                    text=True,
                    timeout=60
                )

                output_file = self.output_dir / f"conversations-{conv_type}.txt"
                with open(output_file, 'w') as f:
                    f.write(result.stdout)

                # Parse top conversations
                lines = result.stdout.split('\n')
                for line in lines:
                    if '<->' in line:
                        self.stats['conversations'].append({
                            'type': conv_type,
                            'details': line.strip()
                        })

            except Exception as e:
                print(f"Error analyzing {conv_type} conversations: {e}")

    def analyze_dns(self):
        """Analyze DNS queries"""
        print("Analyzing DNS queries...")

        try:
            result = subprocess.run(
                ['tshark', '-r', str(self.pcap_file),
                 '-Y', 'dns.flags.response == 0',
                 '-T', 'fields',
                 '-e', 'frame.time',
                 '-e', 'ip.src',
                 '-e', 'dns.qry.name',
                 '-e', 'dns.qry.type'],
                capture_output=True,
                text=True,
                timeout=60
            )

            with open(self.output_dir / "dns-queries.txt", 'w') as f:
                f.write(result.stdout)

            # Parse DNS queries
            for line in result.stdout.split('\n'):
                if line.strip():
                    parts = line.split('\t')
                    if len(parts) >= 4:
                        self.stats['dns_queries'].append({
                            'time': parts[0],
                            'source': parts[1],
                            'query': parts[2],
                            'type': parts[3]
                        })

        except Exception as e:
            print(f"Error analyzing DNS: {e}")

    def analyze_http(self):
        """Analyze HTTP traffic"""
        print("Analyzing HTTP traffic...")

        try:
            result = subprocess.run(
                ['tshark', '-r', str(self.pcap_file),
                 '-Y', 'http.request',
                 '-T', 'fields',
                 '-e', 'frame.time',
                 '-e', 'ip.src',
                 '-e', 'http.request.method',
                 '-e', 'http.host',
                 '-e', 'http.request.uri',
                 '-e', 'http.user_agent'],
                capture_output=True,
                text=True,
                timeout=60
            )

            with open(self.output_dir / "http-requests.txt", 'w') as f:
                f.write(result.stdout)

            # Parse HTTP requests
            for line in result.stdout.split('\n'):
                if line.strip():
                    parts = line.split('\t')
                    if len(parts) >= 5:
                        self.stats['http_requests'].append({
                            'time': parts[0],
                            'source': parts[1],
                            'method': parts[2],
                            'host': parts[3],
                            'uri': parts[4],
                            'user_agent': parts[5] if len(parts) > 5 else ''
                        })

        except Exception as e:
            print(f"Error analyzing HTTP: {e}")

    def analyze_tls(self):
        """Analyze TLS/SSL connections"""
        print("Analyzing TLS connections...")

        try:
            result = subprocess.run(
                ['tshark', '-r', str(self.pcap_file),
                 '-Y', 'ssl.handshake.type == 1',
                 '-T', 'fields',
                 '-e', 'frame.time',
                 '-e', 'ip.src',
                 '-e', 'ip.dst',
                 '-e', 'ssl.handshake.extensions_server_name',
                 '-e', 'ssl.handshake.version'],
                capture_output=True,
                text=True,
                timeout=60
            )

            with open(self.output_dir / "tls-connections.txt", 'w') as f:
                f.write(result.stdout)

            # Parse TLS connections
            for line in result.stdout.split('\n'):
                if line.strip():
                    parts = line.split('\t')
                    if len(parts) >= 4:
                        self.stats['tls_connections'].append({
                            'time': parts[0],
                            'source': parts[1],
                            'destination': parts[2],
                            'server_name': parts[3],
                            'version': parts[4] if len(parts) > 4 else ''
                        })

        except Exception as e:
            print(f"Error analyzing TLS: {e}")

    def detect_anomalies(self):
        """Detect network anomalies"""
        print("Detecting anomalies...")

        # Check for common issues

        # 1. TCP retransmissions
        try:
            result = subprocess.run(
                ['tshark', '-r', str(self.pcap_file),
                 '-Y', 'tcp.analysis.retransmission',
                 '-T', 'fields',
                 '-e', 'frame.number',
                 '-e', 'ip.src',
                 '-e', 'ip.dst',
                 '-e', 'tcp.port'],
                capture_output=True,
                text=True,
                timeout=60
            )

            retransmissions = len(result.stdout.split('\n')) - 1
            if retransmissions > 0:
                self.stats['errors'].append({
                    'type': 'TCP Retransmissions',
                    'count': retransmissions,
                    'severity': 'WARNING' if retransmissions < 100 else 'ERROR'
                })

        except Exception as e:
            print(f"Error detecting retransmissions: {e}")

        # 2. TCP resets
        try:
            result = subprocess.run(
                ['tshark', '-r', str(self.pcap_file),
                 '-Y', 'tcp.flags.reset == 1'],
                capture_output=True,
                text=True,
                timeout=60
            )

            resets = len(result.stdout.split('\n')) - 1
            if resets > 0:
                self.stats['errors'].append({
                    'type': 'TCP Resets',
                    'count': resets,
                    'severity': 'WARNING'
                })

        except Exception as e:
            print(f"Error detecting resets: {e}")

        # 3. HTTP errors
        http_errors = sum(1 for req in self.stats['http_requests'] if 'error' in req.get('uri', '').lower())
        if http_errors > 0:
            self.stats['errors'].append({
                'type': 'HTTP Errors',
                'count': http_errors,
                'severity': 'WARNING'
            })

    def generate_report(self):
        """Generate analysis report"""
        print("\nGenerating report...")

        report_file = self.output_dir / "analysis-report.txt"

        with open(report_file, 'w') as f:
            f.write("NETWORK PACKET CAPTURE ANALYSIS REPORT\n")
            f.write("=" * 80 + "\n\n")
            f.write(f"PCAP File: {self.pcap_file}\n")
            f.write(f"Analysis Date: {subprocess.check_output(['date']).decode().strip()}\n\n")

            # Basic Statistics
            f.write("BASIC STATISTICS\n")
            f.write("-" * 80 + "\n")
            f.write(f"Total Packets: {self.stats['total_packets']}\n")
            f.write(f"File Size: {self.stats.get('file_size', 'N/A')}\n")
            f.write(f"Capture Duration: {self.stats.get('duration', 'N/A')}\n")
            f.write(f"Data Rate: {self.stats.get('data_rate', 'N/A')}\n\n")

            # Protocol Statistics
            f.write("PROTOCOL STATISTICS\n")
            f.write("-" * 80 + "\n")
            for protocol, count in sorted(self.stats['protocols'].items(),
                                        key=lambda x: x[1], reverse=True):
                percentage = (count / self.stats['total_packets'] * 100) if self.stats['total_packets'] > 0 else 0
                f.write(f"{protocol:20s}: {count:8d} packets ({percentage:5.2f}%)\n")
            f.write("\n")

            # Top Conversations
            f.write("TOP CONVERSATIONS\n")
            f.write("-" * 80 + "\n")
            for conv in self.stats['conversations'][:20]:
                f.write(f"{conv['type'].upper():5s}: {conv['details']}\n")
            f.write("\n")

            # DNS Queries
            f.write(f"DNS QUERIES ({len(self.stats['dns_queries'])} total)\n")
            f.write("-" * 80 + "\n")
            unique_domains = set(q['query'] for q in self.stats['dns_queries'])
            for domain in sorted(unique_domains)[:50]:
                count = sum(1 for q in self.stats['dns_queries'] if q['query'] == domain)
                f.write(f"{domain:50s}: {count:5d} queries\n")
            f.write("\n")

            # HTTP Requests
            f.write(f"HTTP REQUESTS ({len(self.stats['http_requests'])} total)\n")
            f.write("-" * 80 + "\n")
            method_counts = defaultdict(int)
            host_counts = defaultdict(int)
            for req in self.stats['http_requests']:
                method_counts[req['method']] += 1
                host_counts[req['host']] += 1

            f.write("Methods:\n")
            for method, count in sorted(method_counts.items(), key=lambda x: x[1], reverse=True):
                f.write(f"  {method:10s}: {count}\n")

            f.write("\nTop Hosts:\n")
            for host, count in sorted(host_counts.items(), key=lambda x: x[1], reverse=True)[:20]:
                f.write(f"  {host:50s}: {count}\n")
            f.write("\n")

            # TLS Connections
            f.write(f"TLS CONNECTIONS ({len(self.stats['tls_connections'])} total)\n")
            f.write("-" * 80 + "\n")
            unique_servers = set(conn['server_name'] for conn in self.stats['tls_connections'] if conn['server_name'])
            for server in sorted(unique_servers)[:30]:
                count = sum(1 for conn in self.stats['tls_connections'] if conn['server_name'] == server)
                f.write(f"{server:50s}: {count:5d} connections\n")
            f.write("\n")

            # Anomalies/Errors
            if self.stats['errors']:
                f.write("DETECTED ANOMALIES\n")
                f.write("-" * 80 + "\n")
                for error in self.stats['errors']:
                    f.write(f"[{error['severity']}] {error['type']}: {error['count']}\n")
                f.write("\n")

            # Recommendations
            f.write("RECOMMENDATIONS\n")
            f.write("-" * 80 + "\n")
            if any(e['type'] == 'TCP Retransmissions' for e in self.stats['errors']):
                f.write("- Investigate TCP retransmissions - may indicate network congestion or packet loss\n")
            if any(e['type'] == 'TCP Resets' for e in self.stats['errors']):
                f.write("- Investigate TCP resets - may indicate connection issues or firewall blocks\n")
            if len(self.stats['http_requests']) > 0 and len(self.stats['tls_connections']) == 0:
                f.write("- HTTP traffic detected without TLS - consider enabling HTTPS\n")

        # Save JSON report
        json_file = self.output_dir / "analysis-report.json"
        with open(json_file, 'w') as f:
            json.dump(self.stats, f, indent=2, default=str)

        print(f"Report generated: {report_file}")
        print(f"JSON report: {json_file}")

def main():
    if len(sys.argv) < 2:
        print("Usage: pcap-analyzer.py <pcap-file> [output-dir]")
        sys.exit(1)

    pcap_file = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else "./pcap-analysis"

    analyzer = PCAPAnalyzer(pcap_file, output_dir)
    analyzer.analyze()

if __name__ == "__main__":
    main()
```

## Conclusion

Network packet capture and analysis in Kubernetes requires understanding the multi-layered networking stack and having the right tools and techniques for each layer. By combining pod-level captures, node-level analysis, and service mesh inspection, teams can effectively troubleshoot complex networking issues and investigate security incidents in containerized environments.

Key takeaways:

1. **Multiple Capture Points**: Use different capture methods for different troubleshooting scenarios
2. **Service Mesh Awareness**: Understand mTLS encryption when analyzing service mesh traffic
3. **Automate Analysis**: Use automated tools to quickly identify issues in large packet captures
4. **Security Considerations**: Packet captures may contain sensitive data; handle appropriately
5. **Ephemeral Nature**: Capture quickly as pods and containers may be short-lived

The tools and techniques presented provide a comprehensive foundation for network troubleshooting and forensics in production Kubernetes environments.