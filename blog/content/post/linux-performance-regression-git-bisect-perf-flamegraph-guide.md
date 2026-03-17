---
title: "Linux Performance Regression Analysis with git bisect, perf, and Flamegraph Automation"
date: 2031-08-22T00:00:00-05:00
draft: false
tags: ["Linux", "Performance", "git bisect", "perf", "Flamegraph", "Profiling", "Debugging"]
categories: ["Linux", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A systematic methodology for diagnosing Linux performance regressions: using git bisect with automated perf benchmarks, generating flamegraphs for CPU and off-CPU analysis, and building a regression CI pipeline."
more_link: "yes"
url: "/linux-performance-regression-git-bisect-perf-flamegraph-guide/"
---

Performance regressions are among the hardest bugs to diagnose. Unlike crashes that produce stack traces, a 20% slowdown leaves no obvious evidence trail. The standard workflow — "what changed recently?" and "let me add some timing" — scales poorly as codebases and teams grow. This guide presents a systematic approach: use `git bisect` with an automated benchmark as the test predicate, use `perf` to generate flamegraphs of the regressing commit versus a known-good commit, and build this into CI so regressions are caught before they reach production.

<!--more-->

# Linux Performance Regression Analysis with git bisect, perf, and Flamegraph Automation

## The Problem with Ad-Hoc Performance Debugging

Typical performance regression timeline:
1. A user reports that operation X is 30% slower than last month
2. Engineering looks at recent commits — there are 200 of them
3. Someone adds timing logs to "narrow it down"
4. Three days later, you find the change that caused it

With `git bisect` and an automated benchmark, step 2-4 collapses to approximately log2(200) = 8 benchmark runs, typically taking 20-40 minutes.

## Prerequisites

```bash
# Install perf (kernel performance events)
apt-get install linux-tools-$(uname -r) linux-tools-generic

# Verify perf works
perf stat ls

# Install flamegraph scripts
git clone https://github.com/brendangregg/FlameGraph /opt/FlameGraph
export PATH=$PATH:/opt/FlameGraph

# Install dependencies for flamegraph generation
apt-get install perl

# Verify flamegraph stack collapse works
perf record -g sleep 1
perf script | stackcollapse-perf.pl | head -5

# Install hyperfine for statistical benchmark comparison
cargo install hyperfine
# or
wget https://github.com/sharkdp/hyperfine/releases/download/v1.18.0/hyperfine_1.18.0_amd64.deb
dpkg -i hyperfine_1.18.0_amd64.deb
```

### Kernel Settings for Perf

```bash
# Allow perf to capture kernel symbols (needed for full flamegraphs)
echo -1 > /proc/sys/kernel/perf_event_paranoid

# Allow kernel symbol resolution
echo 0 > /proc/sys/kernel/kptr_restrict

# Persist these settings (be aware of security implications on shared systems)
cat >> /etc/sysctl.d/99-perf.conf << 'EOF'
kernel.perf_event_paranoid = -1
kernel.kptr_restrict = 0
EOF
```

## Establishing a Baseline Benchmark

Before running git bisect, you need a benchmark that:
1. Produces a single numeric result (pass/fail or a measurable value)
2. Is repeatable (low variance)
3. Runs in seconds, not minutes (git bisect will call it ~10 times)

### Writing a Reliable Benchmark Script

```bash
#!/bin/bash
# benchmark.sh - Used by git bisect as the test predicate
#
# Exit 0: this commit is GOOD (performance acceptable)
# Exit 1: this commit is BAD (performance regression)
# Exit 125: skip this commit (can't build, test doesn't apply)

set -euo pipefail

BINARY=${1:-./bin/server}
THRESHOLD_MS=${2:-50}    # Maximum acceptable p99 latency in ms
ITERATIONS=${3:-5}       # Number of benchmark iterations

# Build the binary from the current commit
if ! make build 2>/dev/null; then
    echo "Build failed - skipping commit"
    exit 125
fi

# Warm up (first run often has cold-cache effects)
$BINARY --benchmark --duration=2s > /dev/null 2>&1 || true

# Run the actual benchmark
LATENCIES=()
for i in $(seq 1 $ITERATIONS); do
    RESULT=$($BINARY --benchmark --duration=5s --output=json 2>/dev/null)
    P99=$(echo "$RESULT" | jq -r '.latency_p99_ms')
    LATENCIES+=("$P99")
done

# Calculate median of the iterations (more robust than mean)
MEDIAN=$(printf '%s\n' "${LATENCIES[@]}" | sort -n | awk '
    BEGIN { n=0 }
    { vals[n++] = $1 }
    END {
        if (n % 2 == 0) { print (vals[n/2-1] + vals[n/2]) / 2 }
        else { print vals[int(n/2)] }
    }
')

echo "P99 latency (median of $ITERATIONS runs): ${MEDIAN}ms (threshold: ${THRESHOLD_MS}ms)"

# Exit 0 if performance is acceptable
if awk "BEGIN { exit ($MEDIAN <= $THRESHOLD_MS) ? 0 : 1 }"; then
    echo "GOOD: latency within threshold"
    exit 0
else
    echo "BAD: latency exceeds threshold"
    exit 1
fi
```

### Variance Control

Before using git bisect, measure your benchmark's variance:

```bash
#!/bin/bash
# measure-variance.sh - Run benchmark 20 times to characterize noise

RESULTS=()
for i in $(seq 1 20); do
    result=$(./benchmark.sh 2>&1 | grep -oP '[\d.]+ ms' | head -1 | grep -oP '[\d.]+')
    RESULTS+=("$result")
    echo "Run $i: ${result}ms"
done

# Calculate coefficient of variation
python3 << 'PYEOF'
import statistics, sys

results = [float(x) for x in """${RESULTS[@]}""".split()]
mean = statistics.mean(results)
stdev = statistics.stdev(results)
cv = stdev / mean * 100

print(f"Mean: {mean:.2f}ms")
print(f"StdDev: {stdev:.2f}ms")
print(f"CV: {cv:.1f}%")
print(f"Min: {min(results):.2f}ms, Max: {max(results):.2f}ms")

if cv > 5:
    print("WARNING: High variance (CV > 5%). git bisect results may be unreliable.")
    print("Consider: CPU frequency scaling, NUMA effects, competing processes.")
else:
    print("Variance is acceptable for git bisect.")
PYEOF
```

If your CV exceeds 5%, address these common sources of noise before bisecting:

```bash
# Fix CPU frequency scaling (use performance governor)
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $cpu
done

# Disable NUMA balancing
echo 0 > /proc/sys/kernel/numa_balancing

# Disable address space layout randomization (for tighter measurements)
echo 0 > /proc/sys/kernel/randomize_va_space

# Pin the benchmark to specific CPUs using taskset
taskset -c 0,1 ./benchmark.sh

# Disable hyperthreading on benchmark CPUs (optional, for maximum consistency)
echo 0 > /sys/devices/system/cpu/cpu1/online  # Disable HT sibling
```

## Running git bisect

```bash
# Start bisect session
git bisect start

# Mark the known-bad commit (could be HEAD or a specific commit)
git bisect bad HEAD

# Mark the known-good commit (last release, 30 days ago, etc.)
git bisect good v2.1.0

# Let git bisect know the range (optional, speeds things up)
git bisect log
# Bisecting: 150 revisions left to test after this (roughly 7 steps)

# Run bisect manually for the first commit to verify the script works
./benchmark.sh
git bisect good  # or: git bisect bad

# Automate the remaining steps
git bisect run ./benchmark.sh

# Example output:
# running ./benchmark.sh
# P99 latency (median of 5 runs): 42ms (threshold: 50ms)
# GOOD: latency within threshold
# Bisecting: 74 revisions left to test after this (roughly 6 steps)
# ...
# running ./benchmark.sh
# P99 latency (median of 5 runs): 67ms (threshold: 50ms)
# BAD: latency exceeds threshold
# ...
# a8f3c91d4e is the first bad commit
# commit a8f3c91d4e
# Author: Jane Developer <jane@example.com>
# Date:   2031-08-10 14:23:11 +0000
#
#     Add request validation middleware
#
# bisect summary:
# good: [abc123] v2.1.0
# bad: [a8f3c91d4e] Add request validation middleware

# Save the result
git bisect log > bisect-result.log

# Reset to HEAD after bisect
git bisect reset
```

## Generating Flamegraphs for Comparison

Once git bisect identifies the culprit commit, generate flamegraphs for the bad commit and its parent to understand what changed.

### CPU Flamegraph

```bash
#!/bin/bash
# generate-cpu-flamegraph.sh
# Usage: ./generate-cpu-flamegraph.sh <label> <binary> [duration_seconds]

LABEL=$1
BINARY=${2:-./bin/server}
DURATION=${3:-30}
OUTPUT_DIR=${4:-./flamegraphs}
mkdir -p "$OUTPUT_DIR"

echo "Recording CPU profile for ${DURATION}s: $LABEL"

# Start the application
$BINARY --benchmark --duration="${DURATION}s" &
APP_PID=$!

# Give it a moment to start accepting load
sleep 2

# Record perf events: sample call graphs at 999Hz
# -g: capture call graphs
# -F 999: sample at 999Hz (avoids harmonics with 1kHz timer)
# --call-graph=dwarf: use DWARF debug info for accurate frames
# --call-graph=fp: use frame pointer (faster but less accurate without -fno-omit-frame-pointer)
perf record \
  -F 999 \
  -g \
  --call-graph=dwarf,65536 \
  -p "$APP_PID" \
  -o "${OUTPUT_DIR}/perf-${LABEL}.data" \
  sleep "$((DURATION - 2))"

wait "$APP_PID" 2>/dev/null || true

# Generate flamegraph
perf script -i "${OUTPUT_DIR}/perf-${LABEL}.data" | \
  stackcollapse-perf.pl --all | \
  flamegraph.pl \
    --title "CPU Flamegraph: ${LABEL}" \
    --width 1400 \
    --height 16 \
    --fontsize 12 \
    --color=hot \
  > "${OUTPUT_DIR}/cpu-flamegraph-${LABEL}.svg"

echo "Generated: ${OUTPUT_DIR}/cpu-flamegraph-${LABEL}.svg"
```

### Off-CPU Flamegraph (Blocked Time Analysis)

Off-CPU flamegraphs show where time is spent waiting (I/O, locks, sleep) rather than executing. This is critical for latency regressions caused by blocking operations:

```bash
#!/bin/bash
# generate-offcpu-flamegraph.sh

LABEL=$1
BINARY=${2:-./bin/server}
DURATION=${3:-30}
OUTPUT_DIR=${4:-./flamegraphs}

# Off-CPU analysis using perf sched or bpftrace
# bpftrace is more accurate for off-CPU analysis

$BINARY --benchmark --duration="${DURATION}s" &
APP_PID=$!
sleep 2

# Collect off-CPU events using bpftrace
bpftrace -e "
profile:hz:99 /pid == $APP_PID/ {
    @cpu_stacks[ustack] = count();
}

tracepoint:sched:sched_switch {
    if (args->prev_pid == $APP_PID) {
        @offcpu_start[$APP_PID] = nsecs;
    }
}

tracepoint:sched:sched_switch {
    if (args->next_pid == $APP_PID && @offcpu_start[$APP_PID] > 0) {
        @offcpu_stacks[ustack] += nsecs - @offcpu_start[$APP_PID];
        delete(@offcpu_start[$APP_PID]);
    }
}
" --duration "${DURATION}" -o "${OUTPUT_DIR}/offcpu-raw-${LABEL}.txt" &
BPFTRACE_PID=$!

wait "$BPFTRACE_PID"
wait "$APP_PID" 2>/dev/null || true

# Process off-CPU data
# (bpftrace output format needs post-processing for FlameGraph)
cat "${OUTPUT_DIR}/offcpu-raw-${LABEL}.txt" | \
  grep -v "^@" | \
  awk '/^\t/{print $0}' | \
  stackcollapse-bpftrace.pl | \
  flamegraph.pl \
    --title "Off-CPU Flamegraph: ${LABEL}" \
    --color=blue \
    --countname=microseconds \
  > "${OUTPUT_DIR}/offcpu-flamegraph-${LABEL}.svg"

echo "Generated: ${OUTPUT_DIR}/offcpu-flamegraph-${LABEL}.svg"
```

### Differential Flamegraph

The most powerful tool for regression analysis: a differential flamegraph shows exactly which code paths increased or decreased in CPU time between two commits:

```bash
#!/bin/bash
# differential-flamegraph.sh
# Compare flamegraphs from 'good' and 'bad' commits

GOOD_COMMIT=${1:-v2.1.0}
BAD_COMMIT=${2:-HEAD}
OUTPUT_DIR=${3:-./flamegraphs}

# Generate folded stacks for both commits
for commit in "$GOOD_COMMIT" "$BAD_COMMIT"; do
    label=$(echo "$commit" | tr '/' '-' | tr ':' '-')

    git checkout "$commit" 2>/dev/null
    make build 2>/dev/null

    echo "Profiling $commit..."
    ./bin/server --benchmark --duration=30s &
    APP_PID=$!
    sleep 2

    perf record -F 999 -g --call-graph=dwarf \
      -p "$APP_PID" \
      -o "${OUTPUT_DIR}/perf-${label}.data" \
      sleep 28

    wait "$APP_PID" 2>/dev/null || true

    perf script -i "${OUTPUT_DIR}/perf-${label}.data" | \
      stackcollapse-perf.pl \
    > "${OUTPUT_DIR}/folded-${label}.txt"

    echo "Folded stacks: ${OUTPUT_DIR}/folded-${label}.txt"
done

# Reset to original commit
git checkout "$BAD_COMMIT" 2>/dev/null

GOOD_LABEL=$(echo "$GOOD_COMMIT" | tr '/' '-' | tr ':' '-')
BAD_LABEL=$(echo "$BAD_COMMIT" | tr '/' '-' | tr ':' '-')

# Generate differential flamegraph
# Blue = slower (more time) in bad vs good
# Red = faster (less time) in bad vs good
difffolded.pl \
  "${OUTPUT_DIR}/folded-${GOOD_LABEL}.txt" \
  "${OUTPUT_DIR}/folded-${BAD_LABEL}.txt" | \
  flamegraph.pl \
    --title "Differential: ${BAD_COMMIT} vs ${GOOD_COMMIT}" \
    --subtitle "Blue = regressed, Red = improved" \
    --width 1600 \
    --negated \
  > "${OUTPUT_DIR}/differential-flamegraph.svg"

echo "Differential flamegraph: ${OUTPUT_DIR}/differential-flamegraph.svg"
echo "Open in a browser to explore the regression interactively."
```

## Automated Perf Comparison

```bash
#!/bin/bash
# perf-compare.sh - Statistical performance comparison between two commits
# Uses hyperfine for statistical rigor

GOOD_COMMIT=${1:-v2.1.0}
BAD_COMMIT=${2:-HEAD}

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "=== Performance Comparison: $GOOD_COMMIT vs $BAD_COMMIT ==="

for commit in "$GOOD_COMMIT" "$BAD_COMMIT"; do
    label=$(echo "$commit" | tr '/' '-')
    echo ""
    echo "--- Building $commit ---"
    git checkout "$commit" 2>/dev/null
    make build -j$(nproc)
    cp ./bin/server "${TMPDIR}/server-${label}"
done

# Reset to current state
git checkout "$BAD_COMMIT" 2>/dev/null

GOOD_BIN="${TMPDIR}/server-$(echo $GOOD_COMMIT | tr '/' '-')"
BAD_BIN="${TMPDIR}/server-$(echo $BAD_COMMIT | tr '/' '-')"

# Use hyperfine for statistically sound comparison
hyperfine \
  --warmup 3 \
  --runs 20 \
  --export-json "${TMPDIR}/results.json" \
  --export-markdown results.md \
  "'${GOOD_BIN} --benchmark --duration=5s'" \
  "'${BAD_BIN} --benchmark --duration=5s'"

echo ""
echo "=== Results ==="
cat results.md

# Extract regression percentage
python3 << PYEOF
import json

with open("${TMPDIR}/results.json") as f:
    data = json.load(f)

results = data["results"]
good_mean = results[0]["mean"]
bad_mean = results[1]["mean"]
regression = (bad_mean - good_mean) / good_mean * 100

print(f"\nRegression: {regression:+.1f}%")
print(f"Good mean: {good_mean*1000:.1f}ms")
print(f"Bad mean: {bad_mean*1000:.1f}ms")

if regression > 5:
    print("STATUS: REGRESSION DETECTED")
    exit(1)
else:
    print("STATUS: No significant regression")
    exit(0)
PYEOF
```

## Perf Stat for Counter Analysis

When flamegraphs show CPU time evenly distributed but performance is degraded, hardware counters often reveal the cause:

```bash
#!/bin/bash
# perf-stat-compare.sh - Compare hardware performance counters

GOOD_BIN=$1
BAD_BIN=$2
DURATION=${3:-10}

for label_bin in "GOOD:$GOOD_BIN" "BAD:$BAD_BIN"; do
    label="${label_bin%%:*}"
    binary="${label_bin#*:}"

    echo "=== $label: $binary ==="
    perf stat \
      -e cycles,instructions,cache-references,cache-misses,\
branch-instructions,branch-misses,\
stalled-cycles-frontend,stalled-cycles-backend,\
context-switches,cpu-migrations,page-faults,\
L1-dcache-loads,L1-dcache-load-misses,LLC-loads,LLC-load-misses \
      "$binary" --benchmark --duration="${DURATION}s" 2>&1 | \
    grep -E "cycles|instructions|cache|branch|stall|IPC|context|migration|fault|LLC"
    echo ""
done
```

Interpreting the output: a regression caused by increased cache misses will show high `LLC-load-misses`, indicating data structure changes that broke cache locality. A regression from branch mispredictions will show high `branch-misses` with low IPC (instructions per cycle).

## Memory Allocation Profiling

Many performance regressions come from increased heap allocation pressure (GC pressure in Go, allocator overhead in C++):

```bash
# For Go applications: use pprof heap profiling
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/heap

# Or capture heap profiles for comparison
curl -s http://localhost:6060/debug/pprof/heap > heap-bad.pprof
git checkout v2.1.0 && make build
# ... restart server ...
curl -s http://localhost:6060/debug/pprof/heap > heap-good.pprof

# Compare allocations
go tool pprof -diff_base=heap-good.pprof heap-bad.pprof
# In the pprof shell:
# (pprof) top20
# (pprof) web    # Opens a flamegraph in the browser

# For allocation count (not just size):
curl -s "http://localhost:6060/debug/pprof/heap?debug=1" | \
  grep -E "allocs|inuse"
```

## CI Integration

Integrate performance regression detection into your CI pipeline:

```yaml
# .github/workflows/perf-regression.yml
name: Performance Regression Check

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  performance-check:
    runs-on: [self-hosted, performance]  # Dedicated benchmark runner for consistent results
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for git bisect

      - name: Set up performance environment
        run: |
          echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
          echo 0 | sudo tee /proc/sys/kernel/numa_balancing
          echo -1 | sudo tee /proc/sys/kernel/perf_event_paranoid

      - name: Build current commit
        run: make build

      - name: Build baseline (main branch)
        run: |
          git stash
          git checkout main
          make build -o /tmp/baseline-binary
          cp ./bin/server /tmp/baseline-server
          git stash pop

      - name: Run performance comparison
        id: perf
        run: |
          ./scripts/perf-compare.sh \
            /tmp/baseline-server \
            ./bin/server \
            10 \
            > perf-results.txt 2>&1
          cat perf-results.txt
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"

      - name: Generate flamegraphs on regression
        if: steps.perf.outputs.exit_code != '0'
        run: |
          ./scripts/generate-cpu-flamegraph.sh baseline /tmp/baseline-server 30
          ./scripts/generate-cpu-flamegraph.sh current ./bin/server 30
          ./scripts/differential-flamegraph.sh main HEAD

      - name: Upload flamegraphs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flamegraphs-${{ github.sha }}
          path: flamegraphs/*.svg
          retention-days: 30

      - name: Comment on PR with results
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const results = fs.readFileSync('perf-results.txt', 'utf8');
            const regression = ${{ steps.perf.outputs.exit_code }} !== 0;

            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## Performance Analysis

            ${regression ? '🔴 **Performance regression detected**' : '✅ No significant regression'}

            <details>
            <summary>Benchmark Results</summary>

            \`\`\`
            ${results}
            \`\`\`

            </details>

            ${regression ? 'Flamegraphs attached to this workflow run.' : ''}
            `
            });

      - name: Fail on regression
        if: steps.perf.outputs.exit_code != '0'
        run: |
          echo "Performance regression exceeds 5% threshold"
          exit 1
```

## Interpreting Flamegraphs

Key patterns to look for:

**Wide towers**: functions consuming significant CPU time. The width represents the percentage of time. Focus on the widest functions in the middle of the flame (not at the top of stacks, which are leaf functions).

**Flat tops**: indicates that a function is itself the hot path (not calling other expensive functions). This is where optimization effort should focus.

**Unexpected frames**: after a regression, look for new frames that did not exist in the good profile. These often directly point to the new code path introduced by the regressing commit.

**Lock contention**: appears as wide frames for `pthread_mutex_lock`, `futex`, or `sync.(*Mutex).Lock` in the off-CPU flamegraph. If these are wide, the regression may be a new lock in the hot path.

**Memory allocation spikes**: `malloc`, `runtime.mallocgc`, or similar frames that are wider in the bad profile indicate increased allocation pressure.

## Summary

The combination of `git bisect run` with a repeatable benchmark and comparative flamegraph generation transforms performance regression investigation from an art form into an engineering process. The key prerequisites are: a benchmark with low variance (CV < 5%), a binary pass/fail criterion for `git bisect`, and a consistent execution environment (fixed CPU frequency, dedicated hardware, reproducible load).

Integrate this workflow into CI from the start rather than retroactively. A performance budget enforced in CI prevents the gradual accumulation of small regressions — each acceptable in isolation — that produce a death-by-a-thousand-cuts performance profile six months after the last major release.
