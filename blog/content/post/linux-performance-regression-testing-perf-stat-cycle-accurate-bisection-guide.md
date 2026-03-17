---
title: "Linux Performance Regression Testing: Benchmark Before/After with perf stat, Cycle-Accurate Profiling, and Bisection"
date: 2031-12-10T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "perf", "Profiling", "Benchmarking", "Regression Testing", "Systems Engineering"]
categories: ["Linux", "Performance Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A systematic guide to Linux performance regression testing using perf stat for cycle-accurate measurement, statistical analysis of benchmark results, automated before/after comparison workflows, and git bisect integration for locating performance regressions to specific commits."
more_link: "yes"
url: "/linux-performance-regression-testing-perf-stat-cycle-accurate-bisection-guide/"
---

Performance regressions are insidious because they rarely cause failures — they just make everything slower. Without a disciplined measurement methodology, a 15% throughput regression can ship to production undetected because manual testing has too much variance to reliably distinguish signal from noise. This guide covers the complete workflow: establishing baseline measurements with statistical rigor, cycle-accurate hardware counter profiling with perf, automating before/after comparison, and using git bisect to identify the exact commit that introduced a regression.

<!--more-->

# Linux Performance Regression Testing

## Measurement Fundamentals

### Why Raw Timing Is Insufficient

```bash
# This tells you almost nothing about what happened
time ./my-program

# real    0m1.234s
# user    0m1.180s
# sys     0m0.054s
```

Variance sources that make wall-clock time unreliable:
- CPU frequency scaling (turbo boost, thermal throttling)
- NUMA effects (memory allocated on wrong node)
- THP (Transparent Huge Pages) allocation timing
- System jitter (kernel background work, IRQs)
- Cache state at program start

### Hardware Performance Counters via perf stat

`perf stat` reads hardware performance monitoring unit (PMU) counters:

```bash
# Basic perf stat
perf stat ./my-program

# Example output:
#  Performance counter stats for './my-program':
#
#       1,234.56 msec task-clock                #    0.998 CPUs utilized
#             42      context-switches          #   34.026 /sec
#              8      cpu-migrations            #    6.481 /sec
#          1,024      page-faults               #  829.480 /sec
#  3,456,789,012      cycles                    #    2.800 GHz
#  4,123,456,789      instructions              #    1.19  insn per cycle
#    987,654,321      branches                  #  799.800 M/sec
#      2,345,678      branch-misses             #    0.24% of all branches
#  1,234,567,890      cache-references          # 1000.000 M/sec
#     12,345,678      cache-misses              #    1.00% of all cache refs
#
#       1.236867193 seconds time elapsed
```

Key metrics:
- **Instructions per cycle (IPC)**: Higher is better. Modern CPUs can issue 4+ IPC; if you see <1, you have stalls.
- **Branch miss rate**: >2% is worth investigating.
- **Cache miss rate**: Depends heavily on workload; sudden increases indicate data structure changes.
- **Task clock vs elapsed**: Large discrepancy means the process was blocked (I/O, locks).

## Setting Up a Controlled Test Environment

### Disable CPU Frequency Scaling

```bash
#!/usr/bin/env bash
# setup-perf-env.sh — Establish a stable CPU environment for benchmarking

set -euo pipefail

echo "=== Configuring CPU for stable benchmarking ==="

# Disable turbo boost (Intel)
if [ -f /sys/devices/system/cpu/intel_pstate/no_turbo ]; then
    echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo
    echo "Intel turbo boost disabled"
fi

# Disable turbo boost (AMD)
if [ -f /sys/devices/system/cpu/cpufreq/boost ]; then
    echo 0 > /sys/devices/system/cpu/cpufreq/boost
    echo "AMD boost disabled"
fi

# Set performance governor on all CPUs
for cpu in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_governor; do
    if [ -f "${cpu}" ]; then
        echo performance > "${cpu}"
    fi
done
echo "CPU governor set to performance"

# Disable NUMA balancing (reduces jitter)
echo 0 > /proc/sys/kernel/numa_balancing
echo "NUMA balancing disabled"

# Set process priority and CPU affinity for benchmarks
echo "To run benchmarks with isolation:"
echo "  taskset -c 2,3 nice -n -20 ./benchmark"
echo ""
echo "To verify CPU frequency is stable:"
echo "  watch -n0.5 'grep MHz /proc/cpuinfo | head -4'"
```

### Disabling Transparent Huge Pages

```bash
# THP can cause huge outliers as the kernel collapses pages mid-run
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Verify
cat /sys/kernel/mm/transparent_hugepage/enabled
# always madvise [never]
```

### Isolating CPUs with isolcpus

For repeatable results, isolate CPUs from scheduler interference:

```bash
# Add to kernel command line (requires reboot):
# isolcpus=2,3,4,5 nohz_full=2,3,4,5 rcu_nocbs=2,3,4,5

# After reboot, verify:
cat /proc/cmdline | grep -o 'isolcpus=[^ ]*'

# Run benchmarks on isolated cores:
taskset -c 2,3 ./benchmark
```

## The perf stat Benchmark Script

```bash
#!/usr/bin/env bash
# bench.sh — Statistically rigorous benchmark with perf stat
# Usage: bench.sh <runs> <label> <program> [args...]

set -euo pipefail

RUNS="${1:?usage: $0 <runs> <label> <program> [args...]}"
LABEL="${2:?}"
PROGRAM="${3:?}"
shift 3
PROGRAM_ARGS=("$@")
OUTPUT_DIR="./bench-results/${LABEL}"
mkdir -p "${OUTPUT_DIR}"

# perf events to collect
EVENTS="cycles,instructions,cache-references,cache-misses,branch-instructions,branch-misses,task-clock,page-faults,context-switches"

echo "Running benchmark: ${LABEL} (${RUNS} iterations)"
echo "Program: ${PROGRAM} ${PROGRAM_ARGS[*]:-}"
echo ""

for i in $(seq 1 "${RUNS}"); do
    printf "  Run %3d/%d... " "${i}" "${RUNS}"

    # perf stat output format: json for machine parsing
    perf stat \
        --repeat 1 \
        --event "${EVENTS}" \
        --output "${OUTPUT_DIR}/run-${i}.perf" \
        --field-separator "," \
        -- "${PROGRAM}" "${PROGRAM_ARGS[@]:-}" \
        > "${OUTPUT_DIR}/stdout-${i}.txt" 2>&1

    # Also capture wall clock time with nanosecond precision
    /usr/bin/time -f "%e %U %S %M" -o "${OUTPUT_DIR}/time-${i}.txt" \
        "${PROGRAM}" "${PROGRAM_ARGS[@]:-}" \
        >> "${OUTPUT_DIR}/stdout-${i}.txt" 2>&1 || true

    echo "done"
done

echo ""
echo "Results saved to ${OUTPUT_DIR}/"
echo "Run analyze-bench.py to compare results."
```

### Python Analysis Script

```python
#!/usr/bin/env python3
# analyze-bench.py — Statistical analysis of perf stat results

import os
import sys
import re
import json
import statistics
import argparse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

@dataclass
class PerfSample:
    cycles: float = 0
    instructions: float = 0
    cache_references: float = 0
    cache_misses: float = 0
    branch_instructions: float = 0
    branch_misses: float = 0
    task_clock_ms: float = 0
    elapsed_s: float = 0
    ipc: float = 0
    cache_miss_rate: float = 0
    branch_miss_rate: float = 0

def parse_perf_output(filepath: str) -> Optional[PerfSample]:
    """Parse perf stat --field-separator ',' output"""
    sample = PerfSample()
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split(',')
            if len(parts) < 3:
                continue
            try:
                value = float(parts[0].replace(',', ''))
                metric = parts[2].strip()
            except (ValueError, IndexError):
                continue

            if metric == 'cycles':
                sample.cycles = value
            elif metric == 'instructions':
                sample.instructions = value
            elif metric == 'cache-references':
                sample.cache_references = value
            elif metric == 'cache-misses':
                sample.cache_misses = value
            elif metric == 'branch-instructions':
                sample.branch_instructions = value
            elif metric == 'branch-misses':
                sample.branch_misses = value
            elif metric == 'task-clock' or metric == 'task-clock:u':
                sample.task_clock_ms = value
            elif 'seconds time elapsed' in line:
                try:
                    sample.elapsed_s = float(line.split()[0])
                except ValueError:
                    pass

    if sample.cycles > 0 and sample.instructions > 0:
        sample.ipc = sample.instructions / sample.cycles
    if sample.cache_references > 0:
        sample.cache_miss_rate = sample.cache_misses / sample.cache_references * 100
    if sample.branch_instructions > 0:
        sample.branch_miss_rate = sample.branch_misses / sample.branch_instructions * 100

    return sample


def summarize(samples: list[PerfSample], label: str) -> dict:
    """Compute statistics across multiple runs"""
    if not samples:
        return {}

    def stats(values: list[float]) -> dict:
        if not values:
            return {}
        return {
            "mean": statistics.mean(values),
            "median": statistics.median(values),
            "stdev": statistics.stdev(values) if len(values) > 1 else 0,
            "min": min(values),
            "max": max(values),
            "cv_pct": (statistics.stdev(values) / statistics.mean(values) * 100)
                      if len(values) > 1 and statistics.mean(values) != 0 else 0,
        }

    return {
        "label": label,
        "n": len(samples),
        "cycles": stats([s.cycles for s in samples]),
        "instructions": stats([s.instructions for s in samples]),
        "ipc": stats([s.ipc for s in samples]),
        "cache_miss_rate_pct": stats([s.cache_miss_rate for s in samples]),
        "branch_miss_rate_pct": stats([s.branch_miss_rate for s in samples]),
        "elapsed_s": stats([s.elapsed_s for s in samples]),
    }


def compare(baseline: dict, candidate: dict) -> None:
    """Print a comparison table with regression detection"""
    print(f"\n{'='*70}")
    print(f"Performance Comparison: {baseline['label']} vs {candidate['label']}")
    print(f"{'='*70}")

    metrics = [
        ("Elapsed time (s)", "elapsed_s", "mean", True),    # lower is better
        ("Cycles", "cycles", "mean", True),
        ("IPC", "ipc", "mean", False),                      # higher is better
        ("Cache miss rate (%)", "cache_miss_rate_pct", "mean", True),
        ("Branch miss rate (%)", "branch_miss_rate_pct", "mean", True),
    ]

    for label, key, stat, lower_is_better in metrics:
        b_val = baseline.get(key, {}).get(stat, 0)
        c_val = candidate.get(key, {}).get(stat, 0)
        c_stdev = candidate.get(key, {}).get("stdev", 0)

        if b_val == 0:
            continue

        pct_change = (c_val - b_val) / b_val * 100
        is_regression = (pct_change > 2) if lower_is_better else (pct_change < -2)
        flag = "REGRESSION" if is_regression else ("IMPROVEMENT" if abs(pct_change) > 2 else "stable")

        # Check if change is statistically significant (>2 sigma)
        if c_stdev > 0:
            z_score = abs(c_val - b_val) / c_stdev
            sig = f"(z={z_score:.1f})" if z_score > 2 else "(not significant)"
        else:
            sig = ""

        print(f"  {label:<25} {b_val:>12.3f} -> {c_val:>12.3f} "
              f"  {pct_change:+7.2f}%  [{flag}] {sig}")

    print(f"\n  Coefficient of variation for elapsed time:")
    print(f"    baseline:  {baseline.get('elapsed_s', {}).get('cv_pct', 0):.1f}%")
    print(f"    candidate: {candidate.get('elapsed_s', {}).get('cv_pct', 0):.1f}%")
    print("  (CV > 5% indicates high variance — increase run count)")
    print()


def main():
    parser = argparse.ArgumentParser(description="Analyze perf stat benchmark results")
    parser.add_argument("baseline_dir", help="Directory containing baseline perf results")
    parser.add_argument("candidate_dir", help="Directory containing candidate perf results")
    args = parser.parse_args()

    baseline_samples = []
    for f in sorted(Path(args.baseline_dir).glob("run-*.perf")):
        s = parse_perf_output(str(f))
        if s:
            baseline_samples.append(s)

    candidate_samples = []
    for f in sorted(Path(args.candidate_dir).glob("run-*.perf")):
        s = parse_perf_output(str(f))
        if s:
            candidate_samples.append(s)

    baseline_name = Path(args.baseline_dir).name
    candidate_name = Path(args.candidate_dir).name

    baseline_summary = summarize(baseline_samples, baseline_name)
    candidate_summary = summarize(candidate_samples, candidate_name)

    compare(baseline_summary, candidate_summary)


if __name__ == "__main__":
    main()
```

## Flamegraph Generation with perf record

```bash
#!/usr/bin/env bash
# generate-flamegraph.sh — CPU flamegraph for a program

set -euo pipefail

PROGRAM="${1:?usage: $0 <program> [args...]}"
shift
ARGS=("$@")
LABEL="${LABEL:-flamegraph}"
DURATION="${DURATION:-30}"

echo "Profiling: ${PROGRAM} for ${DURATION}s"

# Option 1: Profile the running process
# perf record -F 999 -g -p <pid> -- sleep ${DURATION}

# Option 2: Run and profile simultaneously
perf record \
    --freq 999 \
    --call-graph dwarf \
    --output "${LABEL}.perf.data" \
    -- "${PROGRAM}" "${ARGS[@]:-}"

# Convert to flamegraph using perf script + FlameGraph tools
# git clone https://github.com/brendangregg/FlameGraph
FLAMEGRAPH_DIR="${FLAMEGRAPH_DIR:-$HOME/FlameGraph}"

if [ ! -d "${FLAMEGRAPH_DIR}" ]; then
    git clone https://github.com/brendangregg/FlameGraph "${FLAMEGRAPH_DIR}"
fi

perf script --input "${LABEL}.perf.data" | \
    "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" | \
    "${FLAMEGRAPH_DIR}/flamegraph.pl" \
    --title "${LABEL}" \
    --width 1800 \
    > "${LABEL}.svg"

echo "Flamegraph: ${LABEL}.svg"
echo "Open in browser: xdg-open ${LABEL}.svg"
```

## Differential Flamegraph for Regression Analysis

```bash
#!/usr/bin/env bash
# differential-flamegraph.sh
# Produces a flamegraph showing what got SLOWER between baseline and candidate

BASELINE_PERF="${1:?usage: $0 <baseline.perf.data> <candidate.perf.data>}"
CANDIDATE_PERF="${2:?}"
FLAMEGRAPH_DIR="${FLAMEGRAPH_DIR:-$HOME/FlameGraph}"

echo "Creating differential flamegraph..."

# Fold both profiles
perf script -i "${BASELINE_PERF}" | \
    "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" > baseline.folded

perf script -i "${CANDIDATE_PERF}" | \
    "${FLAMEGRAPH_DIR}/stackcollapse-perf.pl" > candidate.folded

# Diff: positive values (red) = more time in candidate (regression)
#        negative values (blue) = less time (improvement)
"${FLAMEGRAPH_DIR}/difffolded.pl" baseline.folded candidate.folded | \
    "${FLAMEGRAPH_DIR}/flamegraph.pl" \
    --title "Differential Flamegraph (red=regression, blue=improvement)" \
    --width 1800 \
    --colors hot \
    > differential.svg

echo "Differential flamegraph: differential.svg"
```

## git bisect for Performance Regression Location

### Manual bisect workflow

```bash
#!/usr/bin/env bash
# git-bisect-perf.sh — Use git bisect to find performance regression
# Usage: ./git-bisect-perf.sh <good-commit> <bad-commit>

set -euo pipefail

GOOD_COMMIT="${1:?usage: $0 <good-commit> <bad-commit>}"
BAD_COMMIT="${2:?}"
THRESHOLD_PCT="${THRESHOLD_PCT:-10}"  # Regression threshold: 10%
BENCH_RUNS="${BENCH_RUNS:-10}"
BUILD_CMD="${BUILD_CMD:-make build}"
BENCH_CMD="${BENCH_CMD:-./my-benchmark}"

echo "Starting bisect: good=${GOOD_COMMIT} bad=${BAD_COMMIT}"
echo "Regression threshold: ${THRESHOLD_PCT}%"

# Establish baseline performance from good commit
git stash
git checkout "${GOOD_COMMIT}"
eval "${BUILD_CMD}"

echo "Measuring baseline performance at ${GOOD_COMMIT}..."
total=0
for i in $(seq 1 "${BENCH_RUNS}"); do
    result=$(perf stat --event task-clock -- ${BENCH_CMD} 2>&1 | \
        grep 'task-clock' | awk '{print $1}' | tr -d ',')
    total=$(echo "${total} + ${result}" | bc)
done
BASELINE_MS=$(echo "scale=2; ${total} / ${BENCH_RUNS}" | bc)
echo "Baseline: ${BASELINE_MS} ms"

# Write the bisect test script
cat > /tmp/bisect-test.sh << BISECT_SCRIPT
#!/usr/bin/env bash
set -e
${BUILD_CMD} || exit 125  # 125 = skip this commit (build failed)

total=0
runs=${BENCH_RUNS}
for i in \$(seq 1 \${runs}); do
    result=\$(perf stat --event task-clock -- ${BENCH_CMD} 2>&1 | \
        grep 'task-clock' | awk '{print \$1}' | tr -d ',')
    total=\$(echo "\${total} + \${result}" | bc)
done
candidate_ms=\$(echo "scale=2; \${total} / \${runs}" | bc)

pct_change=\$(echo "scale=2; (\${candidate_ms} - ${BASELINE_MS}) / ${BASELINE_MS} * 100" | bc)
echo "Candidate: \${candidate_ms} ms (${BASELINE_MS} ms baseline, \${pct_change}% change)"

if (( \$(echo "\${pct_change} > ${THRESHOLD_PCT}" | bc -l) )); then
    echo "SLOW — marking as BAD"
    exit 1  # bad
else
    echo "FAST — marking as GOOD"
    exit 0  # good
fi
BISECT_SCRIPT
chmod +x /tmp/bisect-test.sh

# Run the automated bisect
git bisect start
git bisect bad "${BAD_COMMIT}"
git bisect good "${GOOD_COMMIT}"
git bisect run /tmp/bisect-test.sh

echo ""
echo "Bisect complete. The regression was introduced by:"
git show --stat HEAD
```

### Automated CI Regression Gate

```bash
#!/usr/bin/env bash
# ci-perf-gate.sh — Run in CI to catch performance regressions before merge

set -euo pipefail

# Compare current branch against main
MAIN_SHA=$(git rev-parse origin/main)
BRANCH_SHA=$(git rev-parse HEAD)
BENCH_RUNS=20
REGRESSION_THRESHOLD=5  # 5% regression fails the build

run_bench() {
    local label="$1"
    local build_ref="$2"
    local output_dir="bench-results/${label}"

    mkdir -p "${output_dir}"
    git stash
    git checkout "${build_ref}"
    make build

    for i in $(seq 1 "${BENCH_RUNS}"); do
        perf stat \
            --event cycles,instructions,cache-references,cache-misses,task-clock \
            --field-separator "," \
            --output "${output_dir}/run-${i}.perf" \
            -- ./benchmark 2>&1 | tee "${output_dir}/stdout-${i}.txt" > /dev/null
    done

    git checkout -
}

echo "=== CI Performance Gate ==="
echo "Main: ${MAIN_SHA}"
echo "Branch: ${BRANCH_SHA}"

run_bench "main" "${MAIN_SHA}"
run_bench "branch" "${BRANCH_SHA}"

# Run Python analysis
REGRESSION=$(python3 analyze-bench.py bench-results/main bench-results/branch 2>&1 | \
    grep -c "REGRESSION" || true)

python3 analyze-bench.py bench-results/main bench-results/branch

if [ "${REGRESSION}" -gt "0" ]; then
    echo ""
    echo "ERROR: ${REGRESSION} performance regression(s) detected."
    echo "Review the comparison above and optimize before merging."
    exit 1
fi

echo ""
echo "Performance gate PASSED — no regressions detected."
```

## Cycle-Accurate Profiling with perf annotate

Once you know WHICH function is slow, `perf annotate` shows you WHICH INSTRUCTIONS are responsible:

```bash
# Record with DWARF call graph for accurate attribution
perf record \
    --freq 99999 \
    --call-graph dwarf \
    -o perf.data \
    -- ./my-program

# Show top functions
perf report --input perf.data --no-browser

# Annotate a specific function with instruction-level attribution
perf annotate \
    --input perf.data \
    --symbol my_hot_function \
    --no-browser

# Example annotated output:
#  Percent | Source code & Disassembly
# --------+---------------------------
#          : void my_hot_function(int *arr, int n) {
#          :     int sum = 0;
#    0.12  :     xor    %eax,%eax
#   89.23  : ↑   movslq (%rsi,%rax,4),%rdx    ; cache miss here!
#    0.45  :     add    %rdx,%rcx
#    1.23  :     inc    %rax
#    8.97  :     cmp    %rdi,%rax
#          :   ↑ jl     <my_hot_function+0x8>
```

## Cache Miss Analysis with perf mem

```bash
# Profile memory access patterns (requires precise PMU)
perf mem record -- ./my-program

# Show memory access statistics
perf mem report --no-browser

# Look for high-latency loads
perf mem report --sort=mem --no-browser | head -40
```

## Microbenchmark Framework Integration

For Go programs, integrate `perf stat` with `testing.B`:

```go
// main_test.go
package mypackage_test

import (
    "os"
    "os/exec"
    "testing"
)

func BenchmarkHotPath(b *testing.B) {
    // Warm up the CPU branch predictor and caches
    for i := 0; i < 100; i++ {
        hotPath(testData)
    }

    b.ResetTimer()
    b.ReportAllocs()

    for i := 0; i < b.N; i++ {
        hotPath(testData)
    }
}
```

```bash
# Run Go benchmarks under perf stat
perf stat \
    --event cycles,instructions,cache-misses,branch-misses \
    -- go test -bench=BenchmarkHotPath -benchtime=10s -count=1 ./...

# For cycle-accurate annotation of Go code:
# 1. Build with debug symbols
go build -gcflags="-N -l" -o myprogram .

# 2. Profile
perf record -F 9999 -g -o go.perf.data -- ./myprogram

# 3. Generate flamegraph
# NOTE: Go's runtime makes perf symbol resolution non-trivial
# Use go-torch or pprof for Go-specific flamegraphs
go test -bench=. -cpuprofile cpu.out ./...
go tool pprof -http=:8080 cpu.out
```

## Reporting and Tracking Regressions Over Time

```bash
#!/usr/bin/env bash
# record-benchmark-to-influxdb.sh
# Store benchmark results in InfluxDB for trend tracking

set -euo pipefail

INFLUX_URL="${INFLUX_URL:-http://influxdb.monitoring.svc.cluster.local:8086}"
INFLUX_DB="${INFLUX_DB:-benchmarks}"
COMMIT_SHA=$(git rev-parse HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
TIMESTAMP=$(date +%s%N)  # nanoseconds since epoch

# Run benchmark and parse output
perf stat \
    --event cycles,instructions,task-clock,cache-misses \
    --field-separator "," \
    -- ./benchmark > /dev/null 2> perf.out

CYCLES=$(grep cycles perf.out | awk -F, '{print $1}' | tr -d ',')
INSTRUCTIONS=$(grep instructions perf.out | awk -F, '{print $1}' | tr -d ',')
TASK_CLOCK=$(grep task-clock perf.out | awk -F, '{print $1}' | tr -d ',')
CACHE_MISSES=$(grep cache-misses perf.out | awk -F, '{print $1}' | tr -d ',')

# Write to InfluxDB line protocol
curl -s -XPOST "${INFLUX_URL}/write?db=${INFLUX_DB}" --data-binary \
"benchmark_result,branch=${BRANCH},commit=${COMMIT_SHA} \
cycles=${CYCLES},instructions=${INSTRUCTIONS},task_clock_ms=${TASK_CLOCK},cache_misses=${CACHE_MISSES} \
${TIMESTAMP}"

echo "Benchmark metrics recorded to InfluxDB"
echo "  Cycles: ${CYCLES}"
echo "  Instructions: ${INSTRUCTIONS}"
echo "  Task clock (ms): ${TASK_CLOCK}"
```

## Summary

Reliable performance regression testing requires three elements: a controlled measurement environment (fixed CPU frequency, no THP, isolated cores), statistical rigor (multiple runs, coefficient of variation check, significance testing), and cycle-accurate hardware counters from perf stat rather than wall-clock time alone. The differential flamegraph workflow quickly visualizes WHERE a regression manifests at the function level, while `perf annotate` drills down to individual machine instructions. git bisect automation with a perf-based pass/fail script can locate a regression to a specific commit in O(log n) builds, making it practical to bisect even large histories. Store benchmark results in a time-series database to track performance trends across releases and catch gradual regressions that no single comparison would surface.
