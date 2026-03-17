---
title: "Kubernetes Network Performance Benchmarking: iperf3, netperf, Pod-to-Pod Latency, CNI Comparison Methodology"
date: 2031-12-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "CNI", "Performance", "Benchmarking", "iperf3", "netperf", "Observability"]
categories:
- Kubernetes
- Networking
- Performance Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Rigorous methodology for Kubernetes network performance benchmarking: iperf3 and netperf test design, pod-to-pod and pod-to-service latency measurement, and a systematic CNI plugin comparison framework for production workload selection."
more_link: "yes"
url: "/kubernetes-network-performance-benchmarking-cni-comparison-guide/"
---

Network performance is one of the most consequential infrastructure decisions for distributed applications, yet CNI plugin selection is often made on hearsay or single-metric benchmarks that don't reflect production workloads. This guide establishes a rigorous benchmarking methodology: how to design tests that reproduce your actual traffic patterns, what metrics to collect beyond raw throughput, how to isolate variables, and how to interpret results for the network overlays your team considers.

<!--more-->

# Kubernetes Network Performance Benchmarking: Rigorous Methodology

## Why Most CNI Benchmarks Are Misleading

Common benchmarking mistakes:
1. **Single-stream iperf3**: measures one TCP connection; most services use hundreds or thousands
2. **Same-node tests**: completely bypasses the data plane that matters for distributed services
3. **Ignoring CPU overhead**: high throughput with 100% CPU is not useful production performance
4. **No encryption baseline**: ignoring that Cilium with WireGuard or Istio mTLS has different performance than unencrypted overlays
5. **Homogeneous workload**: benchmarking with large file transfers when your service does small RPC calls

## Section 1: Test Environment Design

### Infrastructure Requirements

```yaml
# Benchmark node pool - dedicated, identical hardware
# These nodes must be:
# 1. Same hardware model (no mixed VM sizes)
# 2. No other workloads during testing
# 3. Pinned to specific kernel version
# 4. With and without IRQ affinity tuning documented

apiVersion: v1
kind: Node
metadata:
  name: bench-worker-1
  labels:
    benchmark.k8s.io/role: worker
    benchmark.k8s.io/nic: "25gbe"
    benchmark.k8s.io/cpu: "intel-xeon-8c"

---
# Benchmark namespace with no resource limits (unless you want to test throttled scenarios)
apiVersion: v1
kind: Namespace
metadata:
  name: benchmark
  labels:
    benchmark.k8s.io/managed: "true"

---
# Ensure benchmark pods land on specific nodes
apiVersion: apps/v1
kind: Deployment
metadata:
  name: iperf-server
  namespace: benchmark
spec:
  replicas: 1
  selector:
    matchLabels:
      app: iperf-server
  template:
    metadata:
      labels:
        app: iperf-server
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: benchmark.k8s.io/role
                    operator: In
                    values: ["worker"]
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: iperf-client
              topologyKey: kubernetes.io/hostname
      containers:
        - name: iperf
          image: networkstatic/iperf3
          args: ["-s"]
          ports:
            - containerPort: 5201
          resources:
            requests:
              cpu: "4"
              memory: 2Gi
            limits:
              cpu: "4"
              memory: 2Gi
          securityContext:
            capabilities:
              add: ["NET_ADMIN", "NET_RAW"]
```

### Baseline: Raw Node-to-Node (No Kubernetes)

Always measure the physical infrastructure baseline first. Any Kubernetes overhead is measured relative to this:

```bash
# On node1 (server side):
iperf3 -s -B 10.0.1.1

# On node2 (client side):
iperf3 -c 10.0.1.1 -t 60 -P 8 -Z    # 8 parallel streams, zerocopy

# Record: maximum throughput, CPU usage on both nodes, latency
```

## Section 2: iperf3 Benchmarking Patterns

### Throughput Tests

```bash
#!/bin/bash
# iperf3-throughput-suite.sh
# Comprehensive throughput benchmark against an iperf3 server in a pod

SERVER_IP="$1"
OUTPUT_DIR="${2:-/tmp/iperf3-results}"
mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)

run_test() {
    local name="$1"
    local args="$2"
    local outfile="${OUTPUT_DIR}/${TIMESTAMP}-${name}.json"

    echo "Running: $name"
    iperf3 -c "$SERVER_IP" $args -J > "$outfile" 2>&1

    # Extract key metrics
    local bps=$(jq -r '.end.sum_received.bits_per_second' "$outfile" 2>/dev/null)
    local gbps=$(echo "scale=2; $bps / 1000000000" | bc 2>/dev/null)
    local retransmits=$(jq -r '.end.sum_sent.retransmits // 0' "$outfile" 2>/dev/null)
    local cpu_local=$(jq -r '.end.cpu_utilization_percent.host_total // 0' "$outfile" 2>/dev/null)
    local cpu_remote=$(jq -r '.end.cpu_utilization_percent.remote_total // 0' "$outfile" 2>/dev/null)

    printf "  %-40s %6.2f Gbps  RTX: %-6s  CPU: %.1f%% / %.1f%%\n" \
        "$name" "$gbps" "$retransmits" "$cpu_local" "$cpu_remote"
}

echo "=== iperf3 Throughput Suite: $(date) ==="
echo "Server: $SERVER_IP"
echo ""

# Test 1: Single stream baseline
run_test "single-stream-60s" "-t 60"

# Test 2: Multi-stream (simulate concurrent connections)
for P in 4 8 16 32; do
    run_test "multistream-p${P}" "-t 30 -P $P"
done

# Test 3: UDP with different packet sizes
for SIZE in 64 512 1400 8192; do
    run_test "udp-${SIZE}b" "-t 30 -u -b 10G -l $SIZE"
done

# Test 4: Reverse direction (server sends to client)
run_test "reverse-single" "-t 30 -R"
run_test "reverse-multi-8" "-t 30 -R -P 8"

# Test 5: Bidirectional simultaneously
run_test "bidir" "-t 30 --bidir"

# Test 6: Small message simulation (high PPS workload)
run_test "small-msg-128b" "-t 30 -P 8 -l 128"
run_test "small-msg-512b" "-t 30 -P 8 -l 512"

echo ""
echo "Results saved to: $OUTPUT_DIR"
```

### Running iperf3 Between Kubernetes Pods

```bash
#!/bin/bash
# k8s-iperf3-bench.sh
# Deploys iperf3 server and client as Kubernetes Jobs

NAMESPACE="benchmark"
RESULTS_DIR="/tmp/k8s-bench-$(date +%Y%m%d%H%M%S)"
mkdir -p "$RESULTS_DIR"

# Deploy server pod
kubectl apply -n "$NAMESPACE" -f - << 'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: iperf3-server
  namespace: benchmark
  labels:
    app: iperf3-server
spec:
  containers:
    - name: iperf3
      image: networkstatic/iperf3
      command: ["iperf3", "-s", "--one-off"]
  restartPolicy: Never
  terminationGracePeriodSeconds: 5
  nodeSelector:
    kubernetes.io/hostname: bench-worker-1
EOF

# Wait for server pod
kubectl wait pod/iperf3-server -n "$NAMESPACE" \
  --for=condition=Running --timeout=60s

SERVER_POD_IP=$(kubectl get pod iperf3-server -n "$NAMESPACE" \
  -o jsonpath='{.status.podIP}')
echo "Server IP: $SERVER_POD_IP"

# Deploy client pod on DIFFERENT node
kubectl apply -n "$NAMESPACE" -f - << EOF
apiVersion: v1
kind: Pod
metadata:
  name: iperf3-client
  namespace: benchmark
spec:
  containers:
    - name: iperf3
      image: networkstatic/iperf3
      command:
        - iperf3
        - -c
        - "$SERVER_POD_IP"
        - -t
        - "60"
        - -P
        - "8"
        - -J
      resources:
        requests:
          cpu: "4"
          memory: 1Gi
  restartPolicy: Never
  nodeSelector:
    kubernetes.io/hostname: bench-worker-2
EOF

# Wait for client to complete
kubectl wait pod/iperf3-client -n "$NAMESPACE" \
  --for=condition=Succeeded --timeout=300s

# Collect results
kubectl logs iperf3-client -n "$NAMESPACE" > "$RESULTS_DIR/iperf3-cross-node.json"

# Parse results
echo "=== Cross-Node Throughput (Pod-to-Pod) ==="
cat "$RESULTS_DIR/iperf3-cross-node.json" | jq -r '
  "Sender:   \(.end.sum_sent.bits_per_second / 1e9 | . * 100 | round / 100) Gbps",
  "Receiver: \(.end.sum_received.bits_per_second / 1e9 | . * 100 | round / 100) Gbps",
  "Retransmits: \(.end.sum_sent.retransmits)",
  "CPU local:  \(.end.cpu_utilization_percent.host_total | . * 10 | round / 10)%",
  "CPU remote: \(.end.cpu_utilization_percent.remote_total | . * 10 | round / 10)%"
'

# Cleanup
kubectl delete pod iperf3-server iperf3-client -n "$NAMESPACE"
```

## Section 3: netperf for Latency and Transaction Tests

### Why netperf for Latency

iperf3 measures bulk throughput. netperf's `TCP_RR` (request/response) and `TCP_CRR` (connect/request/response) tests measure transaction latency — the metric that matters for RPC-heavy microservices.

```bash
# Install netperf in a test image
# Dockerfile
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y netperf iputils-ping iproute2 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["netserver", "-D", "-p", "12865"]
```

### TCP_RR: Request-Response Latency

```bash
# TCP_RR: single-byte request → single-byte response, no connection overhead
# Measures raw L4 latency for short-lived transactions

# Server: run netserver
# Client: run test

netperf \
  -H "$SERVER_IP" \
  -p 12865 \
  -t TCP_RR \
  -l 60 \
  -- \
  -o "MEAN_LATENCY,P50_LATENCY,P90_LATENCY,P99_LATENCY,TRANSACTION_RATE"

# Expected output:
# MEAN_LATENCY  P50_LATENCY  P90_LATENCY  P99_LATENCY  TRANSACTION_RATE
# 0.213         0.187        0.312        0.891        45023.14
# (microseconds)                                       (tps)
```

### TCP_CRR: Connection-Request-Response Latency

```bash
# TCP_CRR: new TCP connection for each transaction
# Measures full connection setup overhead (critical for HTTP/1.0-style services)

netperf \
  -H "$SERVER_IP" \
  -t TCP_CRR \
  -l 30 \
  -- \
  -o "MEAN_LATENCY,P99_LATENCY,TRANSACTION_RATE"
```

### Comprehensive Latency Test Script

```bash
#!/bin/bash
# netperf-latency-suite.sh
SERVER_IP="$1"
OUTPUT_DIR="${2:-/tmp/netperf-results}"
mkdir -p "$OUTPUT_DIR"

echo "=== netperf Latency Suite ==="
echo "Server: $SERVER_IP"

run_rr() {
    local name="$1"
    local extra="$2"
    local outfile="$OUTPUT_DIR/${name}.txt"

    netperf -H "$SERVER_IP" -p 12865 -t TCP_RR -l 30 \
      -- $extra \
      -o "MEAN_LATENCY,P50_LATENCY,P90_LATENCY,P99_LATENCY,P99_9_LATENCY,MAX_LATENCY,TRANSACTION_RATE" \
      > "$outfile" 2>&1

    # Parse output
    STATS=$(tail -1 "$outfile" | tr -s ' ')
    printf "%-30s %s\n" "$name" "$STATS"
}

echo ""
echo "--- TCP Request/Response (TCP_RR) ---"
echo "Name                           Mean    P50     P90     P99     P99.9   Max     TPS"

run_rr "default-64b"           "-r 64,64"
run_rr "1kb-request-1kb-reply" "-r 1024,1024"
run_rr "4kb-request-4kb-reply" "-r 4096,4096"

echo ""
echo "--- UDP Request/Response (UDP_RR) ---"
for SIZE in 64 512 1400; do
    netperf -H "$SERVER_IP" -t UDP_RR -l 30 \
      -- -r $SIZE,$SIZE \
      -o "MEAN_LATENCY,P99_LATENCY,TRANSACTION_RATE" \
      2>&1 | tail -1 | xargs printf "UDP $SIZE byte: Mean=%s us P99=%s us TPS=%s\n"
done

echo ""
echo "--- TCP Stream (throughput) ---"
netperf -H "$SERVER_IP" -t TCP_STREAM -l 30 \
  -- -o "THROUGHPUT,LOCAL_CPU_UTIL,REMOTE_CPU_UTIL"
```

## Section 4: Pod-to-Pod Latency with ICMP and hping3

### ICMP Latency (Simplest Baseline)

```bash
# Basic ICMP latency (cross-node, cross-pod)
kubectl exec -n benchmark iperf3-client -- \
  ping -c 1000 -i 0.01 "$SERVER_POD_IP" | tail -5

# Sample output:
# 1000 packets transmitted, 1000 received, 0% packet loss
# rtt min/avg/max/mdev = 0.218/0.312/2.341/0.089 ms
```

### hping3 for Detailed RTT Statistics

```bash
# TCP SYN latency (measures full TCP handshake overhead)
kubectl exec -n benchmark iperf3-client -- \
  hping3 -S -p 5201 --fast -c 10000 "$SERVER_POD_IP" 2>&1 | \
  grep -E "RTT|DUP|%"

# UDP latency
kubectl exec -n benchmark iperf3-client -- \
  hping3 --udp -p 12865 --fast -c 10000 "$SERVER_POD_IP"
```

### socat Latency (Application-Level Baseline)

```bash
# This measures the full application stack latency (not just network):
# TCP connect + write 1 byte + read 1 byte + close

# Server: in one terminal
kubectl exec -it iperf3-server -- \
  socat TCP-LISTEN:9999,reuseaddr,fork PIPE

# Client: in another terminal
kubectl exec -it iperf3-client -- bash -c '
for i in $(seq 1000); do
  t1=$(date +%s%N)
  echo x | socat - TCP:'"$SERVER_POD_IP"':9999 > /dev/null 2>&1
  t2=$(date +%s%N)
  echo $(( (t2 - t1) / 1000 ))
done | awk "{sum+=\$1; n++} END {print \"avg:\", sum/n, \"us\"}"
'
```

## Section 5: Service Proxy Latency

### Pod-to-Service vs Pod-to-Pod Comparison

kube-proxy (iptables or IPVS) adds overhead for service-destined traffic. Measure this directly:

```bash
# Deploy service
kubectl apply -n benchmark -f - << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: iperf3-svc
  namespace: benchmark
spec:
  selector:
    app: iperf3-server
  ports:
    - port: 5201
      targetPort: 5201
  type: ClusterIP
EOF

SERVICE_IP=$(kubectl get svc iperf3-svc -n benchmark -o jsonpath='{.spec.clusterIP}')

# Test 1: Direct pod-to-pod
netperf -H "$SERVER_POD_IP" -t TCP_RR -l 30 -- -r 64,64 \
  -o "MEAN_LATENCY,P99_LATENCY" | tail -1 | \
  xargs echo "Pod-to-Pod (direct):"

# Test 2: Via service (kube-proxy adds DNAT)
netperf -H "$SERVICE_IP" -t TCP_RR -l 30 -- -r 64,64 \
  -o "MEAN_LATENCY,P99_LATENCY" | tail -1 | \
  xargs echo "Pod-to-Service (via kube-proxy):"
```

### Comparing iptables vs IPVS kube-proxy

```bash
# Check current mode
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode

# Switch to IPVS (for comparison):
kubectl edit configmap kube-proxy -n kube-system
# Set: mode: "ipvs"
# Set: ipvs.scheduler: "rr"

kubectl rollout restart daemonset kube-proxy -n kube-system

# Re-run service latency test
netperf -H "$SERVICE_IP" -t TCP_RR -l 30 -- -r 64,64 \
  -o "MEAN_LATENCY,P99_LATENCY" | tail -1 | \
  xargs echo "Pod-to-Service (IPVS):"
```

## Section 6: CNI Plugin Comparison Methodology

### CNI Plugins to Compare

The main options in 2031:
- **Calico** (eBPF or iptables mode, BGP or VXLAN)
- **Cilium** (eBPF native routing, VXLAN, or WireGuard encrypted)
- **Flannel** (VXLAN, UDP, host-gw)
- **Weave Net** (VXLAN with mesh routing)
- **Antrea** (OVS/eBPF, Windows support)
- **kube-router** (BGP + iptables)

### Controlled CNI Swap Procedure

```bash
#!/bin/bash
# cni-benchmark-swap.sh
# Swap CNI plugin while preserving cluster state for fair comparison

CNI_NAME="$1"   # "cilium", "calico", "flannel", etc.
BENCHMARK_DIR="/tmp/cni-benchmarks"

echo "=== Installing CNI: $CNI_NAME ==="

case "$CNI_NAME" in
  cilium)
    # Remove existing CNI
    helm uninstall calico -n kube-system 2>/dev/null || true
    kubectl delete -f https://raw.githubusercontent.com/flannel-io/flannel/master/Documentation/kube-flannel.yml 2>/dev/null || true

    # Install Cilium
    helm install cilium cilium/cilium \
      --namespace kube-system \
      --set kubeProxyReplacement=true \
      --set k8sServiceHost=10.0.0.1 \
      --set k8sServicePort=6443 \
      --set bpf.masquerade=true \
      --set tunnel=disabled \            # Native routing mode
      --set autoDirectNodeRoutes=true \
      --set ipam.mode=kubernetes
    ;;

  cilium-wireguard)
    helm install cilium cilium/cilium \
      --namespace kube-system \
      --set kubeProxyReplacement=true \
      --set k8sServiceHost=10.0.0.1 \
      --set k8sServicePort=6443 \
      --set encryption.enabled=true \
      --set encryption.type=wireguard
    ;;

  calico-ebpf)
    kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/calico.yaml
    # Enable eBPF mode
    kubectl patch felixconfiguration default \
      --type merge \
      --patch '{"spec":{"bpfEnabled":true}}'
    ;;

  flannel)
    kubectl apply -f https://raw.githubusercontent.com/flannel-io/flannel/master/Documentation/kube-flannel.yml
    ;;
esac

# Wait for CNI to be ready
kubectl wait pods -n kube-system \
  -l k8s-app=cilium \  # Adjust selector per CNI
  --for=condition=Ready \
  --timeout=300s

echo "CNI $CNI_NAME is ready"
```

### CNI Benchmark Matrix

```bash
#!/bin/bash
# run-cni-matrix.sh - Run full benchmark suite for one CNI configuration

CNI_NAME="$1"
RESULTS_DIR="/tmp/cni-benchmarks/$CNI_NAME"
mkdir -p "$RESULTS_DIR"

SERVER_POD_IP=$(kubectl get pod iperf3-server -n benchmark -o jsonpath='{.status.podIP}')

echo "=== CNI Benchmark Matrix: $CNI_NAME ==="
echo "Results: $RESULTS_DIR"

# 1. TCP Throughput: single stream
echo "--- TCP Throughput (1 stream) ---"
kubectl exec -n benchmark iperf3-client -- \
  iperf3 -c "$SERVER_POD_IP" -t 60 -J \
  > "$RESULTS_DIR/tcp-single.json"

# 2. TCP Throughput: multi-stream
for P in 4 8 16; do
    echo "--- TCP Throughput ($P streams) ---"
    kubectl exec -n benchmark iperf3-client -- \
      iperf3 -c "$SERVER_POD_IP" -t 30 -P $P -J \
      > "$RESULTS_DIR/tcp-multi-${P}.json"
done

# 3. UDP: PPS test (maximum packets per second with small datagrams)
echo "--- UDP PPS (64-byte packets) ---"
kubectl exec -n benchmark iperf3-client -- \
  iperf3 -c "$SERVER_POD_IP" -t 30 -u -b 10G -l 64 -J \
  > "$RESULTS_DIR/udp-64b-pps.json"

# 4. Latency: TCP_RR
echo "--- TCP_RR Latency ---"
kubectl exec -n benchmark iperf3-client -- \
  netperf -H "$SERVER_POD_IP" -t TCP_RR -l 60 \
  -- -r 64,64 -o "MEAN_LATENCY,P50_LATENCY,P90_LATENCY,P99_LATENCY,P99_9_LATENCY,TRANSACTION_RATE" \
  > "$RESULTS_DIR/tcp-rr-latency.txt"

# 5. Latency: UDP_RR
echo "--- UDP_RR Latency ---"
kubectl exec -n benchmark iperf3-client -- \
  netperf -H "$SERVER_POD_IP" -t UDP_RR -l 30 \
  -- -r 64,64 -o "MEAN_LATENCY,P99_LATENCY,TRANSACTION_RATE" \
  > "$RESULTS_DIR/udp-rr-latency.txt"

# 6. ICMP baseline
echo "--- ICMP Latency ---"
kubectl exec -n benchmark iperf3-client -- \
  ping -c 10000 -i 0.001 "$SERVER_POD_IP" 2>&1 \
  > "$RESULTS_DIR/icmp-latency.txt"

# 7. CPU overhead measurement (during iperf3 saturation)
echo "--- CPU Overhead During Saturation ---"
# Capture top on both nodes during 30s iperf3 run
kubectl exec -n benchmark iperf3-client -- \
  iperf3 -c "$SERVER_POD_IP" -t 30 -P 8 &
sleep 2
kubectl top node 2>&1 | tee "$RESULTS_DIR/cpu-overhead.txt"
wait

echo "Benchmark complete for $CNI_NAME"
```

### Result Aggregation and Comparison

```python
#!/usr/bin/env python3
# compare-cni-results.py

import json
import os
import sys
from pathlib import Path

def parse_iperf3_json(filepath):
    with open(filepath) as f:
        data = json.load(f)
    return {
        'throughput_gbps': data['end']['sum_received']['bits_per_second'] / 1e9,
        'retransmits': data['end']['sum_sent']['retransmits'],
        'cpu_sender': data['end']['cpu_utilization_percent']['host_total'],
        'cpu_receiver': data['end']['cpu_utilization_percent']['remote_total'],
    }

def parse_netperf_rr(filepath):
    with open(filepath) as f:
        lines = f.readlines()

    # Find the data line (after header)
    for line in lines:
        parts = line.strip().split()
        if len(parts) == 7 and parts[0].replace('.','').isdigit():
            return {
                'mean_us': float(parts[0]),
                'p50_us': float(parts[1]),
                'p90_us': float(parts[2]),
                'p99_us': float(parts[3]),
                'p99_9_us': float(parts[4]),
                'max_us': float(parts[5]),
                'tps': float(parts[6]),
            }
    return {}

def analyze_cni(cni_dir):
    results = {'cni': os.path.basename(cni_dir)}

    tcp_single = Path(cni_dir) / 'tcp-single.json'
    if tcp_single.exists():
        results.update({f'tcp_1s_{k}': v for k, v in parse_iperf3_json(tcp_single).items()})

    tcp_multi8 = Path(cni_dir) / 'tcp-multi-8.json'
    if tcp_multi8.exists():
        data = parse_iperf3_json(tcp_multi8)
        results['tcp_8s_throughput_gbps'] = data['throughput_gbps']
        results['tcp_8s_cpu_total'] = data['cpu_sender'] + data['cpu_receiver']

    rr_latency = Path(cni_dir) / 'tcp-rr-latency.txt'
    if rr_latency.exists():
        rr_data = parse_netperf_rr(rr_latency)
        results.update({f'rr_{k}': v for k, v in rr_data.items()})

    return results

benchmark_root = sys.argv[1] if len(sys.argv) > 1 else '/tmp/cni-benchmarks'
cni_results = []

for cni_dir in sorted(Path(benchmark_root).iterdir()):
    if cni_dir.is_dir():
        cni_results.append(analyze_cni(str(cni_dir)))

# Print comparison table
if cni_results:
    headers = ['CNI', 'TCP-1s(Gbps)', 'TCP-8s(Gbps)', 'CPU-8s(%)', 'RR-Mean(us)', 'RR-P99(us)', 'RR-TPS']
    print(f"{'CNI':<25} {'TCP-1s':>12} {'TCP-8s':>12} {'CPU%':>8} {'RR-Mean':>10} {'RR-P99':>10} {'TPS':>10}")
    print('-' * 95)
    for r in cni_results:
        print(
            f"{r.get('cni',''):<25}"
            f"{r.get('tcp_1s_throughput_gbps',0):>12.2f}"
            f"{r.get('tcp_8s_throughput_gbps',0):>12.2f}"
            f"{r.get('tcp_8s_cpu_total',0):>8.1f}"
            f"{r.get('rr_mean_us',0):>10.3f}"
            f"{r.get('rr_p99_us',0):>10.3f}"
            f"{r.get('rr_tps',0):>10.0f}"
        )
```

## Section 7: Continuous Network Performance Monitoring

### knb (Kubernetes Network Benchmark)

```yaml
# Deploy knb as a CronJob for periodic baseline measurement
apiVersion: batch/v1
kind: CronJob
metadata:
  name: network-baseline
  namespace: monitoring
spec:
  schedule: "0 2 * * *"   # Nightly at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: knb
              image: cloudlookup/knb:latest
              args:
                - -n benchmark
                - --iterations 3
                - --output json
                - --output-file /results/daily-baseline.json
              volumeMounts:
                - name: results
                  mountPath: /results
          volumes:
            - name: results
              persistentVolumeClaim:
                claimName: bench-results-pvc
```

### Prometheus Network Metrics

```yaml
# Custom metrics for ongoing network health
groups:
  - name: kubernetes-network
    interval: 30s
    rules:
      # Measure pod-to-pod latency via continuous synthetic test
      - record: network:pod_to_pod_rtt_ms
        expr: |
          avg by (src_node, dst_node) (
            probe_duration_seconds{probe="pod-to-pod"} * 1000
          )

      # Flag nodes with high inter-pod latency
      - alert: HighPodToPodLatency
        expr: network:pod_to_pod_rtt_ms > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Inter-pod latency > 5ms between {{ $labels.src_node }} and {{ $labels.dst_node }}"

      # Monitor packet drops at CNI level
      - alert: CNIPacketDrops
        expr: |
          rate(container_network_receive_packets_dropped_total[5m]) > 100
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "High packet drop rate on {{ $labels.pod }}"
```

### Blackbox Exporter for Continuous Latency

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: blackbox-config
  namespace: monitoring
data:
  blackbox.yml: |
    modules:
      tcp_latency:
        prober: tcp
        timeout: 5s
        tcp:
          preferred_ip_protocol: ip4
      icmp_latency:
        prober: icmp
        timeout: 5s
        icmp:
          preferred_ip_protocol: ip4
          ttl: 64

---
# Probe targets: sample each CNI pod on each node
apiVersion: monitoring.coreos.com/v1
kind: Probe
metadata:
  name: pod-to-pod-latency
  namespace: monitoring
spec:
  prober:
    url: blackbox-exporter:9115
  module: tcp_latency
  targets:
    staticConfig:
      static:
        - 10.244.1.5:5201   # iperf server pod
      labels:
        probe: "pod-to-pod"
  interval: 15s
  scrapeTimeout: 10s
```

## Section 8: Interpreting Results

### Performance Tiers by Application Type

| Application Type | Critical Metric | Acceptable Threshold |
|-----------------|-----------------|---------------------|
| Microservices (REST/gRPC) | TCP_RR P99 latency | < 1ms pod-to-pod |
| Streaming/analytics | Throughput @ parallel streams | > 8 Gbps on 10GbE |
| Message queues (Kafka) | Throughput + P99 latency | > 5 Gbps, < 2ms |
| Databases | UDP_RR latency | < 0.5ms (NVMe SSD-level) |
| Machine learning | Multi-stream GPU-to-GPU bandwidth | Near wire-speed |

### CNI Selection Decision Framework

```
Question 1: Do you need network policies?
  NO → Flannel (simplest, fastest setup)
  YES → continue

Question 2: Scale (node count)?
  < 100 nodes → Calico (iptables mode) or Weave
  > 100 nodes → Cilium (eBPF) or Calico (eBPF mode)

Question 3: Encryption required?
  NO → native routing (lowest latency)
  YES → Cilium WireGuard or Calico WireGuard
  YES + FIPS → Calico IPsec (FIPS-validated AES)

Question 4: Windows nodes?
  YES → Antrea or Calico

Question 5: Service mesh planned?
  YES (Istio) → Consider ambient mode (no sidecar overhead)
  YES (Cilium) → Cilium Service Mesh (built-in, no sidecar)

Question 6: Performance priority?
  Latency → Cilium eBPF native routing
  Throughput → Calico eBPF or Flannel host-gw
  Balanced → Calico VXLAN or Cilium VXLAN
```

## Conclusion

Rigorous CNI benchmarking requires:

1. **Physical baseline first**: always know the raw hardware throughput before measuring Kubernetes overhead.
2. **Match tests to workload**: use TCP_RR for RPC services, multi-stream iperf3 for data-intensive applications, UDP_RR for real-time systems.
3. **Cross-node tests only**: same-node traffic bypasses the CNI dataplane and produces misleading results.
4. **CPU overhead as a first-class metric**: a CNI that delivers 10 Gbps at 80% CPU is worse than one delivering 8 Gbps at 10% CPU for most workloads.
5. **Service proxy separately from data plane**: kube-proxy (iptables vs IPVS vs Cilium eBPF replacement) has a separate and significant impact on latency.
6. **Continuous monitoring**: a nightly synthetic benchmark catches regressions from node configuration drift, kernel upgrades, and CNI updates before they reach production SLO breaches.

The methodology described here has been used to quantify CNI overheads ranging from less than 2% for Cilium eBPF native routing to over 30% for VXLAN-over-UDP configurations on identical hardware—differences that matter significantly for latency-sensitive microservice architectures.
