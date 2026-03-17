---
title: "Linux Performance Regression Testing: Automated Benchmarking with sysbench and fio"
date: 2030-11-16T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "Benchmarking", "sysbench", "fio", "netperf", "CI/CD", "Monitoring"]
categories:
- Linux
- Performance
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Production benchmark automation: sysbench CPU, memory, and mutex benchmarks, fio for storage I/O, netperf for network throughput, automated regression detection, benchmark result storage and trending, and integrating performance tests into CI/CD."
more_link: "yes"
url: "/linux-performance-regression-testing-sysbench-fio-automation-guide/"
---

Performance regressions in infrastructure are frequently discovered in production rather than in testing, at which point the cost of diagnosis and remediation is orders of magnitude higher than catching them in CI. A systematic benchmark automation pipeline — running sysbench, fio, and netperf against reference baselines, storing results in a time-series database, and alerting on statistically significant regressions — shifts performance validation left and provides a quantitative record of how infrastructure changes affect workload throughput and latency.

<!--more-->

## Benchmark Taxonomy

A complete performance regression suite covers four resource domains:

| Domain | Tool | Metrics |
|--------|------|---------|
| CPU | sysbench cpu | Events/second, latency percentiles |
| Memory | sysbench memory | Throughput (MiB/s), operations/second |
| Synchronization | sysbench mutex | Events/second under lock contention |
| Storage I/O | fio | IOPS, throughput (MiB/s), latency (µs) |
| Network | netperf / iperf3 | Throughput (Gbps), transaction rate |

Each tool measures a different aspect of kernel and hardware performance. A node with excellent CPU benchmark scores can still fail the storage or network regression tests if the storage controller driver was updated or NIC queue settings changed.

## Installing Benchmark Tools

```bash
# Debian/Ubuntu
apt-get update && apt-get install -y \
  sysbench \
  fio \
  netperf \
  iperf3 \
  numactl \
  stress-ng \
  python3-pip

pip3 install influxdb-client pandas scipy matplotlib

# RHEL/CentOS/Rocky
dnf install -y epel-release
dnf install -y sysbench fio netperf iperf3 numactl python3-pip
pip3 install influxdb-client pandas scipy matplotlib
```

## sysbench CPU Benchmarks

sysbench tests CPU throughput by computing prime numbers using trial division. The key variables are thread count and test duration.

### Single-Threaded Baseline

```bash
sysbench cpu \
  --cpu-max-prime=20000 \
  --time=60 \
  --report-interval=5 \
  run
```

Sample output:
```
CPU speed:
    events per second:  1823.47

Latency (ms):
     min:                                   0.54
     avg:                                   0.55
     max:                                   1.12
     95th percentile:                       0.57
     sum:                               33012.56

Threads fairness:
    events (avg/stddev):           109408.0000/0.00
    execution time (avg/stddev):   59.9964/0.00
```

### Multi-Threaded CPU Benchmark Script

```bash
#!/bin/bash
# cpu_bench.sh — Run CPU benchmarks across multiple thread counts

set -euo pipefail

DURATION=120
MAX_PRIME=20000
OUTPUT_DIR=/var/lib/benchmarks/cpu

mkdir -p "${OUTPUT_DIR}"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)

# Determine available logical CPUs
NCPUS=$(nproc)

echo "# System: $(hostname)"
echo "# Date: $(date --iso-8601=seconds)"
echo "# CPUs: ${NCPUS}"
echo "# Kernel: $(uname -r)"

for threads in 1 2 4 8 "${NCPUS}"; do
  [ "${threads}" -gt "${NCPUS}" ] && continue

  echo "--- Running CPU benchmark with ${threads} threads ---"

  result=$(sysbench cpu \
    --cpu-max-prime="${MAX_PRIME}" \
    --time="${DURATION}" \
    --threads="${threads}" \
    --report-interval=0 \
    run)

  events_per_sec=$(echo "${result}" | grep "events per second" | awk '{print $NF}')
  lat_avg=$(echo "${result}" | grep "avg:" | head -1 | awk '{print $NF}')
  lat_p95=$(echo "${result}" | grep "95th percentile" | awk '{print $NF}')

  echo "threads=${threads} events_per_sec=${events_per_sec} lat_avg_ms=${lat_avg} lat_p95_ms=${lat_p95}"

  # Write JSON result
  cat >> "${OUTPUT_DIR}/cpu_${TIMESTAMP}.jsonl" << EOF
{"timestamp":"${TIMESTAMP}","hostname":"$(hostname)","kernel":"$(uname -r)","threads":${threads},"events_per_sec":${events_per_sec},"lat_avg_ms":${lat_avg},"lat_p95_ms":${lat_p95},"benchmark":"cpu"}
EOF
done
```

### Memory Bandwidth Benchmark

```bash
#!/bin/bash
# memory_bench.sh

DURATION=60
BLOCK_SIZE="1K"
TOTAL_SIZE="100G"
NCPUS=$(nproc)

for threads in 1 "${NCPUS}"; do
  for oper in read write; do
    result=$(sysbench memory \
      --memory-block-size="${BLOCK_SIZE}" \
      --memory-total-size="${TOTAL_SIZE}" \
      --memory-oper="${oper}" \
      --memory-access-mode=seq \
      --threads="${threads}" \
      --time="${DURATION}" \
      run)

    throughput_mib=$(echo "${result}" | grep "MiB transferred" | \
      grep -oP '[0-9]+\.[0-9]+ MiB/sec' | awk '{print $1}')

    echo "threads=${threads} oper=${oper} throughput_mib_per_sec=${throughput_mib}"
  done
done
```

### Mutex Contention Benchmark

The mutex benchmark stresses kernel lock contention — a leading indicator of NUMA topology regressions and kernel scheduler changes:

```bash
#!/bin/bash
# mutex_bench.sh

DURATION=60
MUTEX_NUM=8
MUTEX_LOCKS=10000

for threads in 1 2 4 8 16 32; do
  result=$(sysbench mutex \
    --mutex-num="${MUTEX_NUM}" \
    --mutex-locks="${MUTEX_LOCKS}" \
    --mutex-loops=5000 \
    --threads="${threads}" \
    --time="${DURATION}" \
    run 2>&1)

  events_per_sec=$(echo "${result}" | grep "events per second" | awk '{print $NF}')
  lat_p99=$(echo "${result}" | grep "99th percentile" | awk '{print $NF}')

  echo "threads=${threads} events_per_sec=${events_per_sec} lat_p99_ms=${lat_p99}"
done
```

## fio Storage I/O Benchmarks

fio is the standard tool for storage I/O benchmarking. It is critical to match benchmark parameters to the actual workload pattern.

### Standard fio Job Files

```ini
# /etc/benchmarks/fio/random_read_write.fio
[global]
ioengine=libaio
direct=1
numjobs=4
time_based=1
runtime=120
size=10G
filename=/var/lib/benchmarks/fio-test-file
group_reporting=1
log_avg_msec=1000
lat_percentiles=1
percentile_list=50:90:95:99:99.9

[random_read_4k]
rw=randread
bs=4k
iodepth=32
stonewall

[random_write_4k]
rw=randwrite
bs=4k
iodepth=32
stonewall

[random_readwrite_4k]
rw=randrw
rwmixread=70
bs=4k
iodepth=32
stonewall

[sequential_read_128k]
rw=read
bs=128k
iodepth=8
stonewall

[sequential_write_128k]
rw=write
bs=128k
iodepth=8
stonewall
```

### fio Benchmark Runner Script

```bash
#!/bin/bash
# fio_bench.sh — Run fio benchmark suite and output JSON results

set -euo pipefail

BENCH_DIR=/var/lib/benchmarks
FIO_DIR="${BENCH_DIR}/fio"
mkdir -p "${FIO_DIR}"

TIMESTAMP=$(date +%Y%m%dT%H%M%S)
DEVICE="${1:-/dev/nvme0n1}"     # Pass target device as first argument
FIO_FILE="${FIO_DIR}/testfile"

# Pre-create the test file
fio --filename="${FIO_FILE}" --size=10G --rw=write --bs=1M \
  --name=setup --direct=1 --ioengine=libaio > /dev/null

# Run the benchmark suite and capture JSON output
fio \
  --filename="${FIO_FILE}" \
  --output-format=json \
  /etc/benchmarks/fio/random_read_write.fio \
  > "${FIO_DIR}/fio_${TIMESTAMP}_raw.json"

# Parse the JSON output with Python for key metrics
python3 << 'PYEOF'
import json
import sys

with open("${FIO_DIR}/fio_${TIMESTAMP}_raw.json") as f:
    data = json.load(f)

results = []
for job in data.get("jobs", []):
    name = job["jobname"]

    read_stats = job.get("read", {})
    write_stats = job.get("write", {})

    result = {
        "job": name,
        "timestamp": "${TIMESTAMP}",
        "hostname": "$(hostname)",
        "kernel": "$(uname -r)",
        "device": "${DEVICE}",
    }

    if read_stats.get("io_bytes", 0) > 0:
        result["read_iops"] = read_stats.get("iops", 0)
        result["read_bw_kib"] = read_stats.get("bw", 0)
        result["read_lat_us_p50"] = read_stats.get("lat_ns", {}).get("percentile", {}).get("50.000000", 0) / 1000
        result["read_lat_us_p99"] = read_stats.get("lat_ns", {}).get("percentile", {}).get("99.000000", 0) / 1000
        result["read_lat_us_p999"] = read_stats.get("lat_ns", {}).get("percentile", {}).get("99.900000", 0) / 1000

    if write_stats.get("io_bytes", 0) > 0:
        result["write_iops"] = write_stats.get("iops", 0)
        result["write_bw_kib"] = write_stats.get("bw", 0)
        result["write_lat_us_p50"] = write_stats.get("lat_ns", {}).get("percentile", {}).get("50.000000", 0) / 1000
        result["write_lat_us_p99"] = write_stats.get("lat_ns", {}).get("percentile", {}).get("99.000000", 0) / 1000
        result["write_lat_us_p999"] = write_stats.get("lat_ns", {}).get("percentile", {}).get("99.900000", 0) / 1000

    print(json.dumps(result))
    results.append(result)

# Summary table
print("\n=== FIO SUMMARY ===", file=sys.stderr)
for r in results:
    print(f"Job: {r['job']}", file=sys.stderr)
    if "read_iops" in r:
        print(f"  Read:  {r['read_iops']:.0f} IOPS  {r['read_bw_kib']/1024:.0f} MiB/s  "
              f"p50={r['read_lat_us_p50']:.0f}µs  p99={r['read_lat_us_p99']:.0f}µs  "
              f"p99.9={r['read_lat_us_p999']:.0f}µs", file=sys.stderr)
    if "write_iops" in r:
        print(f"  Write: {r['write_iops']:.0f} IOPS  {r['write_bw_kib']/1024:.0f} MiB/s  "
              f"p50={r['write_lat_us_p50']:.0f}µs  p99={r['write_lat_us_p99']:.0f}µs  "
              f"p99.9={r['write_lat_us_p999']:.0f}µs", file=sys.stderr)
PYEOF

# Cleanup test file
rm -f "${FIO_FILE}"
```

## Network Benchmarks with netperf and iperf3

```bash
#!/bin/bash
# network_bench.sh — TCP throughput and transaction rate benchmarks

set -euo pipefail

REMOTE_HOST="${1:?Usage: $0 <remote-host>}"
DURATION=60
TIMESTAMP=$(date +%Y%m%dT%H%M%S)

echo "=== TCP Stream Throughput ==="
# Default: 1 stream
netperf -H "${REMOTE_HOST}" -t TCP_STREAM -l "${DURATION}" -- \
  -s 262144 -S 262144 -m 65536

echo ""
echo "=== TCP Request/Response Transaction Rate ==="
# 1-byte request, 1-byte response — tests kernel scheduler and NIC interrupt handling
netperf -H "${REMOTE_HOST}" -t TCP_RR -l "${DURATION}" -- \
  -r 1,1 -s 16384 -S 16384

echo ""
echo "=== Multi-stream TCP Throughput (8 streams) ==="
TOTAL_THROUGHPUT=0
for i in $(seq 1 8); do
  RESULT=$(netperf -H "${REMOTE_HOST}" -t TCP_STREAM -l "${DURATION}" -- \
    -s 262144 -S 262144 -m 65536 | tail -1)
  BW=$(echo "${RESULT}" | awk '{print $5}')
  TOTAL_THROUGHPUT=$(python3 -c "print(${TOTAL_THROUGHPUT} + ${BW})")
  echo "  Stream ${i}: ${BW} Mbps"
done
echo "  Total: ${TOTAL_THROUGHPUT} Mbps"

echo ""
echo "=== iperf3 Bidirectional ==="
iperf3 -c "${REMOTE_HOST}" -t "${DURATION}" --bidir -P 4 \
  --json | python3 -c "
import json, sys
data = json.load(sys.stdin)
send_bps = data['end']['sum_sent']['bits_per_second']
recv_bps = data['end']['sum_received']['bits_per_second']
print(f'Send: {send_bps/1e9:.2f} Gbps  Recv: {recv_bps/1e9:.2f} Gbps')
"
```

## Automated Regression Detection

### Statistical Regression Analysis

```python
#!/usr/bin/env python3
# regression_detector.py — Compare current benchmark results against baseline

import json
import os
import sys
from pathlib import Path
from scipy import stats
import numpy as np
import argparse

REGRESSION_THRESHOLD_PERCENT = 10.0  # Alert if metric degrades by >10%

def load_results(results_dir: str, benchmark: str, metric: str, limit: int = 30) -> list:
    """Load the last `limit` results for a given benchmark/metric."""
    results = []
    pattern = f"{benchmark}_*.jsonl"

    files = sorted(Path(results_dir).glob(pattern), reverse=True)[:limit]
    for f in files:
        with open(f) as fh:
            for line in fh:
                record = json.loads(line.strip())
                if metric in record:
                    results.append(record[metric])

    return list(reversed(results))


def detect_regression(baseline: list, current: list, metric_name: str, higher_is_better: bool = True) -> dict:
    """
    Uses Welch's t-test to determine if current measurements differ significantly
    from the baseline. Returns a dict with regression details.
    """
    if len(baseline) < 5 or len(current) < 3:
        return {"status": "insufficient_data", "metric": metric_name}

    baseline_mean = np.mean(baseline)
    current_mean = np.mean(current)

    if baseline_mean == 0:
        return {"status": "baseline_zero", "metric": metric_name}

    # Welch's t-test — does not assume equal variance
    t_stat, p_value = stats.ttest_ind(baseline, current, equal_var=False)

    change_pct = ((current_mean - baseline_mean) / baseline_mean) * 100
    is_regression = (
        p_value < 0.05 and  # statistically significant
        (
            (higher_is_better and change_pct < -REGRESSION_THRESHOLD_PERCENT) or
            (not higher_is_better and change_pct > REGRESSION_THRESHOLD_PERCENT)
        )
    )

    return {
        "metric": metric_name,
        "status": "regression" if is_regression else "ok",
        "baseline_mean": round(baseline_mean, 4),
        "current_mean": round(current_mean, 4),
        "change_pct": round(change_pct, 2),
        "p_value": round(p_value, 6),
        "significant": p_value < 0.05,
    }


def main():
    parser = argparse.ArgumentParser(description="Detect benchmark regressions")
    parser.add_argument("--results-dir", default="/var/lib/benchmarks")
    parser.add_argument("--output-format", choices=["text", "json"], default="text")
    args = parser.parse_args()

    checks = [
        # (benchmark, metric, higher_is_better)
        ("cpu", "events_per_sec", True),
        ("cpu", "lat_p95_ms", False),
        ("memory", "throughput_mib_per_sec", True),
        ("mutex", "events_per_sec", True),
        ("fio_random_read_4k", "read_iops", True),
        ("fio_random_read_4k", "read_lat_us_p99", False),
        ("fio_random_write_4k", "write_iops", True),
        ("fio_random_write_4k", "write_lat_us_p99", False),
        ("fio_sequential_read_128k", "read_bw_kib", True),
        ("fio_sequential_write_128k", "write_bw_kib", True),
    ]

    regressions = []
    all_results = []

    for benchmark, metric, higher_is_better in checks:
        # Load baseline: results from 7-30 days ago
        baseline = load_results(
            os.path.join(args.results_dir, "baseline"),
            benchmark, metric, limit=20
        )
        # Load current: last 3 runs
        current = load_results(
            os.path.join(args.results_dir, "current"),
            benchmark, metric, limit=3
        )

        result = detect_regression(baseline, current, metric, higher_is_better)
        all_results.append(result)

        if result.get("status") == "regression":
            regressions.append(result)

    if args.output_format == "json":
        print(json.dumps({"regressions": regressions, "all": all_results}, indent=2))
    else:
        for r in all_results:
            status_icon = "FAIL" if r.get("status") == "regression" else "OK  "
            if r.get("status") == "insufficient_data":
                status_icon = "SKIP"
            change = f"{r.get('change_pct', 0):+.1f}%" if "change_pct" in r else "N/A"
            print(
                f"[{status_icon}] {r['metric']:40s}  "
                f"baseline={r.get('baseline_mean', 'N/A')}  "
                f"current={r.get('current_mean', 'N/A')}  "
                f"change={change}"
            )

    if regressions:
        print(f"\n{len(regressions)} REGRESSION(S) DETECTED", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
```

## Storing Results in InfluxDB

```python
#!/usr/bin/env python3
# push_to_influxdb.py — Write benchmark results to InfluxDB for trending

import json
import sys
from datetime import datetime, timezone
from influxdb_client import InfluxDBClient, Point, WriteOptions
from influxdb_client.client.write_api import SYNCHRONOUS

INFLUX_URL = "http://influxdb.monitoring.svc.cluster.local:8086"
INFLUX_ORG = "company"
INFLUX_BUCKET = "benchmarks"
# In production, read from environment variable, not hardcoded
INFLUX_TOKEN = os.environ.get("INFLUXDB_TOKEN", "")

def write_benchmark_results(results: list[dict]) -> None:
    client = InfluxDBClient(
        url=INFLUX_URL,
        token=INFLUX_TOKEN,
        org=INFLUX_ORG,
    )

    write_api = client.write_api(write_options=SYNCHRONOUS)
    points = []

    for r in results:
        timestamp = datetime.fromisoformat(r["timestamp"]).replace(tzinfo=timezone.utc)

        p = Point("benchmark") \
            .tag("hostname", r.get("hostname", "unknown")) \
            .tag("kernel", r.get("kernel", "unknown")) \
            .tag("benchmark", r.get("benchmark", "unknown")) \
            .time(timestamp)

        # Add all numeric fields
        for key, value in r.items():
            if key in ("timestamp", "hostname", "kernel", "benchmark"):
                continue
            if isinstance(value, (int, float)):
                p = p.field(key, float(value))

        points.append(p)

    write_api.write(bucket=INFLUX_BUCKET, record=points)
    print(f"Wrote {len(points)} data points to InfluxDB")
    client.close()


if __name__ == "__main__":
    results = [json.loads(line) for line in sys.stdin if line.strip()]
    write_benchmark_results(results)
```

## CI/CD Integration

### GitHub Actions Workflow

```yaml
name: Performance Regression Tests

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize]
  schedule:
    # Run nightly at 02:00 UTC on a dedicated benchmark runner
    - cron: "0 2 * * *"

jobs:
  benchmark:
    name: Run Benchmark Suite
    runs-on: [self-hosted, benchmark-runner, bare-metal]
    timeout-minutes: 90
    env:
      RESULTS_DIR: /var/lib/benchmarks
      INFLUXDB_TOKEN: ${{ secrets.INFLUXDB_TOKEN }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Collect system info
        run: |
          echo "### System Information" >> $GITHUB_STEP_SUMMARY
          echo "- Hostname: $(hostname)" >> $GITHUB_STEP_SUMMARY
          echo "- Kernel: $(uname -r)" >> $GITHUB_STEP_SUMMARY
          echo "- CPUs: $(nproc)" >> $GITHUB_STEP_SUMMARY
          echo "- Memory: $(free -h | awk '/^Mem:/{print $2}')" >> $GITHUB_STEP_SUMMARY
          lscpu | grep -E "Model name|Thread|Core|Socket" >> $GITHUB_STEP_SUMMARY

      - name: Run CPU benchmarks
        run: |
          bash scripts/benchmarks/cpu_bench.sh 2>&1 | tee /tmp/cpu_results.jsonl
          cat /tmp/cpu_results.jsonl | python3 scripts/benchmarks/push_to_influxdb.py

      - name: Run memory benchmarks
        run: bash scripts/benchmarks/memory_bench.sh

      - name: Run mutex benchmarks
        run: bash scripts/benchmarks/mutex_bench.sh

      - name: Run fio storage benchmarks
        run: |
          bash scripts/benchmarks/fio_bench.sh /dev/nvme0n1 2>&1 | \
            tee /tmp/fio_results.jsonl
          cat /tmp/fio_results.jsonl | python3 scripts/benchmarks/push_to_influxdb.py

      - name: Run network benchmarks
        if: github.event_name == 'schedule'
        run: bash scripts/benchmarks/network_bench.sh benchmark-peer-node.company.com

      - name: Check for regressions
        id: regression_check
        run: |
          python3 scripts/benchmarks/regression_detector.py \
            --results-dir="${RESULTS_DIR}" \
            --output-format=text 2>&1 | tee /tmp/regression_report.txt

          # Post regression report to PR comment
          echo "## Performance Regression Report" >> $GITHUB_STEP_SUMMARY
          echo '```' >> $GITHUB_STEP_SUMMARY
          cat /tmp/regression_report.txt >> $GITHUB_STEP_SUMMARY
          echo '```' >> $GITHUB_STEP_SUMMARY

      - name: Archive raw results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: benchmark-results-${{ github.sha }}
          path: /tmp/*.jsonl
          retention-days: 90
```

### Dedicated Benchmark Runner Node

The benchmark runner must be isolated to produce reproducible results:

```yaml
# Kubernetes taints and node selectors for benchmark isolation
apiVersion: v1
kind: Node
metadata:
  name: benchmark-runner-01
  labels:
    node-role.kubernetes.io/benchmark: "true"
    dedicated: "benchmark"
spec:
  taints:
    - key: "dedicated"
      value: "benchmark"
      effect: "NoSchedule"
```

OS-level isolation on the benchmark node:

```bash
# Disable CPU frequency scaling for consistent results
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance > "${cpu}"
done

# Disable transparent huge pages
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Pin kernel IRQs to non-benchmark CPUs
# Assumes CPUs 0-3 are reserved for kernel work, 4+ for benchmarks
set_irq_affinity.sh 0-3

# Disable ASLR for memory benchmarks
echo 0 > /proc/sys/kernel/randomize_va_space

# CPU isolation (set at boot via GRUB)
# GRUB_CMDLINE_LINUX="isolcpus=4-31 nohz_full=4-31 rcu_nocbs=4-31"
```

## Grafana Dashboard for Benchmark Trends

Key Grafana panel queries for visualizing benchmark trends in InfluxDB:

```flux
// CPU events/second over time
from(bucket: "benchmarks")
  |> range(start: -30d)
  |> filter(fn: (r) => r._measurement == "benchmark" and
            r.benchmark == "cpu" and
            r._field == "events_per_sec" and
            r.hostname == "benchmark-runner-01")
  |> movingAverage(n: 7)
  |> yield(name: "cpu_trend")
```

```flux
// fio random read IOPS regression window
from(bucket: "benchmarks")
  |> range(start: -14d)
  |> filter(fn: (r) => r._measurement == "benchmark" and
            r.benchmark == "fio_random_read_4k" and
            r._field == "read_iops")
  |> timedMovingAverage(every: 1d, period: 3d)
```

## Interpreting Regression Results

### CPU Regression Causes

A >10% drop in CPU events/second after a kernel update typically indicates:
- New Spectre/Meltdown mitigations enabled by the kernel
- CPU microcode update adding retpoline overhead
- Changed CPU governor or P-state driver behavior

Diagnosis:
```bash
# Compare mitigations before/after
cat /sys/devices/system/cpu/vulnerabilities/*

# Check CPU frequency
watch -n 1 "grep MHz /proc/cpuinfo | sort -u"

# Check P-state driver
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
```

### Storage I/O Regression Causes

A drop in fio IOPS after a storage driver update or kernel change can indicate:
- Changed I/O scheduler (from mq-deadline to bfq)
- Reduced queue depth defaults
- New write barriers enabled

```bash
# Check I/O scheduler
cat /sys/block/nvme0n1/queue/scheduler

# Check queue depth
cat /sys/block/nvme0n1/queue/nr_requests

# Set optimal scheduler
echo mq-deadline > /sys/block/nvme0n1/queue/scheduler
```

## stress-ng for Comprehensive System Stress Testing

`stress-ng` complements sysbench by targeting specific kernel subsystems and hardware components that sysbench does not cover:

```bash
#!/bin/bash
# stress_ng_bench.sh — Run targeted stress-ng benchmarks

DURATION=60
TIMESTAMP=$(date +%Y%m%dT%H%M%S)

echo "=== L1/L2/L3 Cache Stress ==="
# Fill CPU caches and measure access latency
stress-ng --cache 4 \
  --cache-ops 100000 \
  --metrics-brief \
  --timeout "${DURATION}" 2>&1 | grep -E "cache|ops|bogo"

echo "=== Memory Bus Contention ==="
stress-ng --vm 4 \
  --vm-bytes 1G \
  --vm-method all \
  --metrics-brief \
  --timeout "${DURATION}" 2>&1 | grep "vm"

echo "=== Context Switch Rate ==="
stress-ng --context 8 \
  --metrics-brief \
  --timeout "${DURATION}" 2>&1 | grep "context"

echo "=== Pipe Throughput ==="
stress-ng --pipe 8 \
  --metrics-brief \
  --timeout "${DURATION}" 2>&1 | grep "pipe"

echo "=== Filesystem Metadata ==="
stress-ng --dir 8 \
  --dir-ops 50000 \
  --metrics-brief \
  --timeout "${DURATION}" 2>&1 | grep "dir"

echo "=== Atomic Operations ==="
stress-ng --atomic 4 \
  --metrics-brief \
  --timeout "${DURATION}" 2>&1 | grep "atomic"
```

### Targeted NUMA Topology Testing

NUMA topology regressions are subtle and often missed by non-NUMA-aware benchmarks:

```bash
#!/bin/bash
# numa_bench.sh — Test inter-NUMA memory bandwidth

DURATION=60
NUMA_NODES=$(numactl --hardware | grep "available:" | awk '{print $2}')
echo "NUMA nodes: ${NUMA_NODES}"

if [ "${NUMA_NODES}" -lt 2 ]; then
  echo "Single NUMA node system — skipping cross-NUMA test"
  exit 0
fi

echo "=== Local NUMA Memory Bandwidth (node 0, CPUs on node 0) ==="
numactl --cpunodebind=0 --membind=0 \
  sysbench memory \
  --memory-block-size=1K \
  --memory-total-size=50G \
  --memory-access-mode=seq \
  --threads=4 \
  --time="${DURATION}" \
  run | grep -E "MiB transferred|throughput"

echo "=== Remote NUMA Memory Bandwidth (CPUs on node 0, memory on node 1) ==="
numactl --cpunodebind=0 --membind=1 \
  sysbench memory \
  --memory-block-size=1K \
  --memory-total-size=50G \
  --memory-access-mode=seq \
  --threads=4 \
  --time="${DURATION}" \
  run | grep -E "MiB transferred|throughput"

# A >30% difference between local and remote indicates expected NUMA overhead
# A sudden increase in this ratio may indicate NUMA topology regression
# (e.g., after a BIOS update that changed NUMA node assignments)
```

## Benchmark Baseline Establishment Protocol

When setting up benchmarks on a new server or after a major change, establish a statistical baseline over multiple runs to account for natural variance:

```bash
#!/bin/bash
# establish_baseline.sh — Run 10 iterations to establish a statistical baseline

ITERATIONS=10
RESULTS_DIR=/var/lib/benchmarks/baseline
mkdir -p "${RESULTS_DIR}"

for i in $(seq 1 ${ITERATIONS}); do
  echo "Run ${i} of ${ITERATIONS}..."

  # CPU baseline
  result=$(sysbench cpu \
    --cpu-max-prime=20000 \
    --time=60 \
    --threads=$(nproc) \
    run | grep "events per second" | awk '{print $NF}')

  echo "{\"run\": ${i}, \"benchmark\": \"cpu\", \"events_per_sec\": ${result}, \"timestamp\": \"$(date --iso-8601=seconds)\"}" \
    >> "${RESULTS_DIR}/cpu_baseline.jsonl"

  # Wait between runs to allow thermal stabilization
  sleep 30
done

# Calculate statistics
python3 << 'PYEOF'
import json
import statistics

results = []
with open("/var/lib/benchmarks/baseline/cpu_baseline.jsonl") as f:
    for line in f:
        data = json.loads(line.strip())
        results.append(data["events_per_sec"])

print(f"CPU Baseline Statistics (n={len(results)}):")
print(f"  Mean:   {statistics.mean(results):.2f}")
print(f"  Median: {statistics.median(results):.2f}")
print(f"  StdDev: {statistics.stdev(results):.2f}")
print(f"  CV:     {statistics.stdev(results)/statistics.mean(results)*100:.1f}%")
print(f"  Min:    {min(results):.2f}")
print(f"  Max:    {max(results):.2f}")
print(f"  Range:  {(max(results)-min(results))/statistics.mean(results)*100:.1f}%")
print()
print("Recommendations:")
if statistics.stdev(results)/statistics.mean(results) > 0.05:
    print("  WARNING: CV > 5% — high variance. Check for CPU frequency scaling,")
    print("  thermal throttling, or background noise. Consider isolcpus tuning.")
else:
    print("  Baseline is stable (CV < 5%). Suitable for regression detection.")
PYEOF
```

## Summary

A complete performance regression testing pipeline combines sysbench for CPU and memory baselines, fio for storage I/O characterization with percentile latency tracking, and netperf for network throughput validation. Storing all results in InfluxDB enables statistical regression detection using Welch's t-test, which correctly handles variance between benchmark runs without requiring a fixed tolerance threshold. The CI/CD integration ensures that every infrastructure change — kernel update, driver patch, firmware upgrade — is automatically validated against the performance baseline before it reaches production.
