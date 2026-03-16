---
title: "Tetragon eBPF Security Enforcement: Proactive Kubernetes Threat Prevention Guide"
date: 2026-12-27T00:00:00-05:00
draft: false
tags: ["Tetragon", "eBPF", "Security", "Kubernetes", "Runtime Enforcement", "Cilium", "SIEM", "Threat Prevention"]
categories:
- Security
- Kubernetes
- eBPF
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Tetragon for eBPF-based security enforcement: TracingPolicies, process tree visibility, network enforcement, file access controls, SIGKILL enforcement, and SIEM integration."
more_link: "yes"
url: "/tetragon-ebpf-security-enforcement-kubernetes-production-guide/"
---

**Tetragon** represents a fundamental shift in Kubernetes runtime security: from detection to enforcement. Where Falco observes and alerts when a threat is detected — giving an attacker seconds to minutes of unimpeded execution — Tetragon uses eBPF programs loaded directly into the Linux kernel to intercept and terminate malicious processes before any damage occurs. The SIGKILL arrives at the same kernel execution context as the attack, with zero roundtrip latency to userspace.

This enforcement distinction is not merely academic. In a typical crypto-mining incident, the miner binary executes, connects to a mining pool, and begins consuming CPU within milliseconds. A detection-only approach triggers an alert that pages an on-call engineer, who investigates, confirms, and remediates — a process measured in minutes even with excellent tooling. Tetragon's enforcement mode kills the process at `execve()` or at the first outbound TCP connection, before any CPU is consumed or any exfiltration occurs.

This guide covers Tetragon architecture, **TracingPolicy** authoring for the most common enforcement scenarios, SIEM event export, and the operational discipline of transitioning from audit to enforce mode safely.

<!--more-->

## Tetragon vs Falco: Enforcement vs Detection

The architectural distinction between Tetragon and Falco is important for selecting the right tool for each use case — they are complementary, not competing.

**Falco** runs as a userspace daemon that receives events from the kernel (via eBPF probe or kernel module), evaluates rules, and emits alerts through output channels. The detection-to-action loop necessarily involves userspace: kernel event → Falco process → alert output → human or automation response. The minimum latency for automated response is tens of milliseconds; for human response it is minutes.

**Tetragon** loads eBPF programs that execute synchronously in the kernel execution path. A `TracingPolicy` with action `Sigkill` causes the kernel to send SIGKILL to the offending process before the BPF program returns. The enforcement action executes at the same CPU instruction as the detected behavior — there is no latency, no roundtrip to userspace, and no possibility of the process completing the malicious operation.

The operational model is:

- **Tetragon** for enforcement of well-understood, high-confidence threat signatures (known crypto miners, reverse shell patterns, explicit file path protections). Fast detection is more valuable than investigation flexibility.
- **Falco** for detection and investigation of novel or low-confidence behaviors (anomalous system call patterns, policy changes, kubectl exec events). Alert richness and low false-positive rate matter more than response latency.

Running both is the production standard for security-conscious Kubernetes operators.

### Process Tree Visibility

A distinguishing capability of Tetragon is **process tree visibility**: every kernel event is annotated with the full process ancestry (PID, binary, arguments) from the container's PID 1 down to the offending process. This enrichment answers "how did this process get here?" — the container image, the initial entrypoint, every exec call in the chain. For forensic investigation after an incident, this context is the difference between knowing that `xmrig` ran and understanding the injection vector that placed it there.

## Installation with Helm

Tetragon is deployed as a DaemonSet using the official Helm chart from the Cilium repository:

```yaml
# tetragon-values.yaml — validated
exportFilename: /var/run/cilium/tetragon/tetragon.log

tetragonOperator:
  enabled: true

tetragon:
  exportAllowList: |-
    {"event_set":["PROCESS_EXEC","PROCESS_EXIT","PROCESS_KPROBE","PROCESS_UPROBE","PROCESS_TRACEPOINT"]}
  exportFileMaxBackups: 5
  exportFileMaxSizeMB: 100
  grpc:
    address: "localhost:54321"
  prometheus:
    enabled: true
    port: 2112
    serviceMonitor:
      enabled: true
```

Install:

```bash
#!/bin/bash
set -euo pipefail

# Install Tetragon
helm repo add cilium https://helm.cilium.io/
helm repo update

helm upgrade --install tetragon cilium/tetragon \
  --namespace kube-system \
  --create-namespace \
  --values tetragon-values.yaml \
  --wait

# Install tetra CLI
TETRA_VERSION="1.1.0"
curl -Lo /tmp/tetra.tar.gz \
  "https://github.com/cilium/tetragon/releases/download/v${TETRA_VERSION}/tetra-linux-amd64.tar.gz"
tar -xzf /tmp/tetra.tar.gz -C /tmp
sudo mv /tmp/tetra /usr/local/bin/tetra
```

Verify the installation:

```bash
#!/bin/bash
# Verify Tetragon is running and loading policies
kubectl -n kube-system rollout status ds/tetragon

# Confirm eBPF programs are loaded
kubectl -n kube-system exec ds/tetragon -- \
  tetra bugtool | grep -i "bpf programs"

# List loaded TracingPolicies
kubectl get tracingpolicies,tracingpoliciesnamespaced
```

## TracingPolicy Anatomy: kprobes, uprobes, Tracepoints

**TracingPolicy** is the core CRD through which Tetragon's enforcement behavior is configured. A TracingPolicy attaches eBPF programs to one of three kernel hook points:

**kprobes** attach to kernel function entry or return points. They fire when the kernel function is called, regardless of how the call was initiated. Most Tetragon enforcement policies use kprobes on security functions (`security_bprm_check` for exec, `security_file_open` for file access, `tcp_connect` for network).

**uprobes** attach to userspace function entry or return points within specific binaries. Useful for monitoring library-level events (OpenSSL `SSL_write`, glibc `malloc`) without modifying the application.

**Tracepoints** attach to statically defined kernel instrumentation points. They are more stable across kernel versions than kprobes because they are explicit ABI. Use tracepoints when available for common events like `sys_enter_execve`.

A TracingPolicy specifies:
- The function to hook (`call`)
- Whether to hook entry or return (`return: true/false`)
- Argument types to extract (`args`)
- Match conditions (`selectors`) that determine when the policy applies
- Actions to take when conditions match (`matchActions`)

## Process Execution Visibility Policy

The foundation of process security monitoring is a policy that captures every `execve` call with full argument and environment context:

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: process-execution-visibility
spec:
  kprobes:
    - call: "security_bprm_check"
      syscall: false
      return: false
      args:
        - index: 0
          type: "linux_binprm"
      selectors:
        - matchActions:
            - action: Post
```

This policy attaches to `security_bprm_check`, the Linux Security Module hook called for every binary program check. The `Post` action sends the event to the Tetragon event ring buffer for export. The `linux_binprm` argument type instructs Tetragon to extract the binary path, arguments, environment variables, and credentials automatically.

Deploy this policy as an audit-first foundation: it generates no enforcement actions but populates the event stream with process ancestry data that enriches all subsequent investigation.

## Network Egress Enforcement

Blocking unexpected outbound connections is one of the highest-value enforcement actions for container security. Containers that establish connections to unknown external IPs are a reliable signal of compromise or misconfiguration. The following policy kills any process that attempts a TCP connection outside the RFC 1918 private address space:

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-outbound-network
spec:
  kprobes:
    - call: "tcp_connect"
      syscall: false
      return: false
      args:
        - index: 0
          type: "sock"
      selectors:
        - matchArgs:
            - index: 0
              operator: "NotDAddr"
              values:
                - "10.0.0.0/8"
                - "172.16.0.0/12"
                - "192.168.0.0/16"
                - "127.0.0.1/8"
          matchActions:
            - action: Sigkill
```

The `NotDAddr` operator matches when the destination address does NOT fall within any of the listed CIDR ranges. The `Sigkill` action is delivered synchronously: the process is killed before `tcp_connect` returns.

### Namespace-Scoped Network Enforcement

For production workloads, scope the policy to a specific namespace using `TracingPolicyNamespaced`:

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: network-egress-enforce
  namespace: production
spec:
  kprobes:
    - call: "tcp_connect"
      syscall: false
      return: false
      args:
        - index: 0
          type: "sock"
      selectors:
        - matchNamespaces:
            - operator: In
              values:
                - production
          matchArgs:
            - index: 0
              operator: "NotDAddr"
              values:
                - "10.0.0.0/8"
          matchActions:
            - action: Post
            - action: Sigkill
```

The `Post` action before `Sigkill` ensures the enforcement event is exported to the event stream for SIEM ingestion, even though the process is killed. Both actions execute in the BPF program — there is no ordering ambiguity.

## Sensitive File Access Monitoring and Blocking

Kubernetes secrets, service account tokens, and SSH keys are high-value targets accessible from within compromised pods. Monitor and selectively block access to these paths:

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: sensitive-file-monitor
spec:
  kprobes:
    - call: "security_file_open"
      syscall: false
      return: false
      args:
        - index: 0
          type: "file"
      selectors:
        - matchArgs:
            - index: 0
              operator: "Prefix"
              values:
                - "/etc/shadow"
                - "/etc/passwd"
                - "/root/.ssh"
                - "/var/run/secrets"
                - "/proc/self/environ"
          matchActions:
            - action: Post
```

To add enforcement — blocking the open call and killing the process — change the action:

```yaml
          matchActions:
            - action: Post
            - action: Sigkill
```

The `Prefix` operator matches paths that start with any of the listed strings. `/var/run/secrets` catches all service account token reads regardless of the specific token path, while remaining specific enough to avoid false positives on unrelated files.

## Cryptocurrency Miner Detection and SIGKILL Enforcement

Crypto miners are reliably detectable by binary name at execution time. Enforcement at `execve()` prevents the miner from establishing any network connections or consuming CPU:

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: crypto-miner-kill
spec:
  kprobes:
    - call: "security_bprm_check"
      syscall: false
      return: false
      args:
        - index: 0
          type: "linux_binprm"
      selectors:
        - matchArgs:
            - index: 0
              operator: "Equal"
              values:
                - "xmrig"
                - "minerd"
                - "cpuminer"
                - "ethminer"
          matchActions:
            - action: Sigkill
        - matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/xmrig"
                - "/minerd"
          matchActions:
            - action: Sigkill
```

Two selectors handle both basename and full-path matching. The `Equal` selector catches cases where the miner is executed directly by name (e.g., a container image entrypoint `xmrig`). The `Postfix` selector catches cases where the miner is stored at an arbitrary path but retains its standard binary name (e.g., `/tmp/.hidden/xmrig`).

### Defense Against Renamed Miners

Sophisticated attackers rename miner binaries to evade name-based detection. For environments requiring stronger enforcement, combine name-based detection with a network-based detection policy that kills any process connecting to common mining pool port ranges (3333, 4444, 14444, 45560):

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: mining-pool-connection-kill
spec:
  kprobes:
    - call: "tcp_connect"
      syscall: false
      return: false
      args:
        - index: 0
          type: "sock"
      selectors:
        - matchArgs:
            - index: 0
              operator: "DPort"
              values:
                - "3333"
                - "4444"
                - "14444"
                - "45560"
          matchActions:
            - action: Post
            - action: Sigkill
```

This policy is aggressive: port 3333 is also used by some development tools. Deploy in audit mode (`Post` only) in development clusters and `Sigkill` mode in production after validating that no legitimate workloads use these ports.

## Exporting Events to Elasticsearch and Loki

Tetragon writes events to a JSON log file and exposes them via gRPC. Configure export to Elasticsearch for SIEM integration:

```yaml
exportFilename: /var/run/cilium/tetragon/tetragon.log

tetragonOperator:
  enabled: true

tetragon:
  exportAllowList: |-
    {"event_set":["PROCESS_EXEC","PROCESS_EXIT","PROCESS_KPROBE","PROCESS_UPROBE","PROCESS_TRACEPOINT"]}
  exportFileMaxBackups: 5
  exportFileMaxSizeMB: 100
  grpc:
    address: "localhost:54321"
  prometheus:
    enabled: true
    port: 2112
    serviceMonitor:
      enabled: true
```

Deploy a Fluent Bit sidecar or DaemonSet to ship the Tetragon log file to Elasticsearch:

```bash
#!/bin/bash
# Configure Fluent Bit to read Tetragon events and forward to Elasticsearch
# Add to Fluent Bit ConfigMap:
cat << 'FLUENTBIT'
[INPUT]
    Name  tail
    Path  /var/run/cilium/tetragon/tetragon.log
    Tag   tetragon.*
    Parser json

[FILTER]
    Name  record_modifier
    Match tetragon.*
    Record source tetragon
    Record cluster production

[OUTPUT]
    Name  es
    Match tetragon.*
    Host  elasticsearch.logging.svc.cluster.local
    Port  9200
    Index tetragon-events
    Type  _doc
FLUENTBIT
```

For Loki integration, replace the Fluent Bit output with the Loki output plugin. Tetragon events in Loki enable LogQL-based investigation alongside application logs — correlating the security event timestamp with application behavior in the same query interface.

## tetra CLI for Real-Time Event Inspection

The `tetra` CLI provides direct access to Tetragon's gRPC event stream. It is the primary tool for live monitoring and policy validation during development:

```bash
#!/bin/bash
# Real-time event inspection with tetra CLI
tetra getevents --output json | jq 'select(.process_exec != null)'

# Filter for specific namespace
tetra getevents --namespace production --output compact

# Watch for policy violations
tetra getevents --output json \
  | jq 'select(.process_kprobe.action == "KPROBE_ACTION_SIGKILL")'

# Show process tree
tetra getevents --output json \
  | jq '{
      pid: .process_exec.process.pid,
      binary: .process_exec.process.binary,
      parent: .process_exec.parent.binary,
      pod: .process_exec.process.pod.name,
      namespace: .process_exec.process.pod.namespace
    } | select(.pid != null)'
```

The `select(.process_kprobe.action == "KPROBE_ACTION_SIGKILL")` filter in the second example is the production monitoring query: it shows only events where Tetragon enforced an action, the highest-signal stream for security operations.

### tetra for Policy Development

During TracingPolicy development, use `tetra` to verify that the policy captures the intended events before enabling enforcement:

```bash
#!/bin/bash
# Watch for events matching a specific policy while testing
tetra getevents --output json \
  | jq 'select(.process_kprobe.policy_name == "crypto-miner-kill")'

# Test that a known-good binary is not blocked
# (run in a test pod, observe tetra output)
kubectl run test-pod \
  --image=alpine \
  --restart=Never \
  --rm -it \
  -- sh -c "echo 'hello world'"

# Verify the test-pod exec appears in tetra output
tetra getevents --namespace default --output compact \
  | grep test-pod
```

## Policy Tuning: Moving from Audit to Enforce Mode

The path from policy deployment to production enforcement requires a structured transition period to identify false positives and refine match conditions.

### Phase 1: Audit Mode (2 Weeks)

Deploy all policies with `action: Post` only. No enforcement occurs. Collect the event stream and analyze it for false positives:

```bash
#!/bin/bash
set -euo pipefail

# Count events by policy in the last 24 hours
# (assumes Tetragon events are in Elasticsearch)
curl -s "http://elasticsearch.logging:9200/tetragon-events/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "size": 0,
    "query": {
      "range": {
        "@timestamp": {"gte": "now-24h"}
      }
    },
    "aggs": {
      "by_policy": {
        "terms": {
          "field": "process_kprobe.policy_name",
          "size": 50
        }
      }
    }
  }' | jq '.aggregations.by_policy.buckets[]'
```

Classify events: legitimate workloads that would be killed (false positives), confirmed malicious patterns (true positives), and noise (events that do not require enforcement). Refine `matchArgs` conditions or add `matchNamespaces` exclusions to eliminate false positives.

### Phase 2: Enforce in Non-Production

Enable `Sigkill` enforcement in development and staging namespaces. Monitor application behavior for unexpected terminations. Deploy test suites — if integration tests fail, a legitimate workload is triggering a policy. Investigate and add a targeted exclusion.

Common false-positive sources:
- **Monitoring agents** that read `/proc/self/environ` for process metadata
- **Service mesh sidecars** that establish TCP connections before application containers start
- **Log collectors** that access sensitive log files in `/var/log`
- **Init containers** that download configuration from external URLs

For each false positive, add a `matchBinaries` exclusion that explicitly permits the known-good binary while maintaining enforcement for all other processes:

```yaml
      selectors:
        - matchArgs:
            - index: 0
              operator: "Prefix"
              values:
                - "/var/run/secrets"
          matchBinaries:
            - operator: "NotIn"
              values:
                - "/usr/bin/vault-agent"
                - "/usr/bin/filebeat"
          matchActions:
            - action: Sigkill
```

### Phase 3: Production Enforcement

Promote policies to production namespace scope after two weeks of clean operation in staging. Monitor the `tetragon_policy_enforcement_total` Prometheus metric for enforcement count by policy. A sudden spike indicates either a new attack or a previously unseen legitimate code path — investigate both.

### Policy Version Control

Manage TracingPolicies in a Git repository alongside application manifests. The `TracingPolicy` spec is declarative and idempotent — applying the same manifest twice has no effect. Use Argo CD or Flux to ensure policy state matches the Git repository, preventing drift between environments.

```bash
#!/bin/bash
# List all active TracingPolicies and their enforcement state
kubectl get tracingpolicies -A \
  -o custom-columns='NAME:.metadata.name,NAMESPACE:.metadata.namespace,STATE:.status.state'

# View enforcement events for a specific policy
kubectl -n kube-system logs ds/tetragon \
  | jq 'select(.process_kprobe.policy_name == "crypto-miner-kill")' \
  | jq '{
      time: .time,
      binary: .process_kprobe.process.binary,
      action: .process_kprobe.action,
      pod: .process_kprobe.process.pod.name,
      namespace: .process_kprobe.process.pod.namespace
    }'
```

## Prometheus Metrics and Alerting

Tetragon exposes enforcement metrics that should drive production alerts:

- `tetragon_process_exec_total` — total process executions observed (baseline for anomaly detection)
- `tetragon_policy_enforcement_total` — enforcement actions by policy name (alert on unexpected spikes)
- `tetragon_handler_errors_total` — BPF program handling errors (alert on any non-zero value)
- `tetragon_event_cache_misses_total` — process context lookups that missed cache (high values indicate resource pressure)

Create a Prometheus alert for enforcement spikes:

```yaml
groups:
  - name: tetragon.rules
    rules:
      - alert: TetragonEnforcementSpike
        expr: >
          rate(tetragon_policy_enforcement_total[5m]) > 0.1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Tetragon enforcement policy is firing frequently"
          description: >
            Policy {{ $labels.policy_name }} has enforced
            {{ $value | humanize }} actions/second over the last 5 minutes.
            Investigate for active attack or false positive.

      - alert: TetragonHandlerErrors
        expr: rate(tetragon_handler_errors_total[5m]) > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Tetragon BPF handler errors detected"
          description: "Tetragon may not be enforcing policies correctly."
```

## Integrating Tetragon with Incident Response

Tetragon enforcement events contain the complete forensic context needed to reconstruct an incident: the binary that was killed, its full argument list, the container identity, the pod, the namespace, and the process ancestry chain. This structured data enables automated incident response that is orders of magnitude faster than manual investigation.

### Automated Response Workflows

A Falcosidekick-equivalent approach for Tetragon uses the gRPC event stream as input to an automation engine. When a `KPROBE_ACTION_SIGKILL` event is received, the automation can:

1. Annotate the pod with the incident timestamp and policy name
2. Capture a forensic snapshot: `kubectl describe pod`, `kubectl logs`, and pod resource metrics at the time of enforcement
3. Cordon the node if the policy fires repeatedly (indicating active compromise, not a one-time event)
4. Create a PagerDuty incident with the full event context pre-populated

```bash
#!/bin/bash
# Watch Tetragon enforcement events and capture forensic snapshots
tetra getevents --output json \
  | jq -c 'select(.process_kprobe.action == "KPROBE_ACTION_SIGKILL")' \
  | while IFS= read -r event; do
      pod=$(echo "${event}" | jq -r '.process_kprobe.process.pod.name // empty')
      ns=$(echo "${event}"  | jq -r '.process_kprobe.process.pod.namespace // empty')
      policy=$(echo "${event}" | jq -r '.process_kprobe.policy_name // empty')

      if [ -n "${pod}" ] && [ -n "${ns}" ]; then
        echo "Enforcement event: pod=${pod} ns=${ns} policy=${policy}"

        # Annotate pod with enforcement event
        kubectl annotate pod "${pod}" -n "${ns}" \
          "security.tetragon.io/enforcement-time=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          "security.tetragon.io/policy=${policy}" \
          --overwrite

        # Capture forensic snapshot
        mkdir -p "/tmp/incidents/${pod}"
        kubectl describe pod "${pod}" -n "${ns}" \
          > "/tmp/incidents/${pod}/describe.txt"
        kubectl logs "${pod}" -n "${ns}" --all-containers=true \
          > "/tmp/incidents/${pod}/logs.txt" 2>&1
        echo "${event}" | jq . \
          > "/tmp/incidents/${pod}/tetragon-event.json"

        echo "Forensic snapshot captured at /tmp/incidents/${pod}/"
      fi
    done
```

This loop runs continuously, processing the Tetragon event stream and capturing forensic data for every enforcement action. In production, replace the local file write with an upload to object storage (S3, GCS) for durable incident artifacts.

### Node Isolation on Repeated Enforcement

A pod that repeatedly triggers enforcement policies is either under active attack or misconfigured. After three enforcement events within a rolling 10-minute window, cordon the node to prevent new pod scheduling and notify the security team for manual investigation:

```bash
#!/bin/bash
set -euo pipefail

# Count enforcement events per node in the last 10 minutes
# (assumes events are in Elasticsearch)
THRESHOLD=3
HIGH_EVENT_NODES=$(curl -sf \
  "http://elasticsearch.logging:9200/tetragon-events/_search" \
  -H "Content-Type: application/json" \
  -d "{
    \"size\": 0,
    \"query\": {
      \"bool\": {
        \"must\": [
          {\"range\": {\"@timestamp\": {\"gte\": \"now-10m\"}}},
          {\"match\": {\"process_kprobe.action\": \"KPROBE_ACTION_SIGKILL\"}}
        ]
      }
    },
    \"aggs\": {
      \"by_node\": {
        \"terms\": {\"field\": \"process_kprobe.process.pod.node_name\", \"size\": 10},
        \"aggs\": {
          \"over_threshold\": {\"bucket_selector\": {
            \"buckets_path\": {\"count\": \"_count\"},
            \"script\": \"params.count >= ${THRESHOLD}\"
          }}
        }
      }
    }
  }" \
  | jq -r '.aggregations.by_node.buckets[].key')

for node in ${HIGH_EVENT_NODES}; do
  echo "Cordoning node ${node} due to repeated enforcement events"
  kubectl cordon "${node}"
done
```

## Tetragon and Compliance Frameworks

Tetragon's process execution and file access audit capabilities map directly to requirements in several compliance frameworks:

**PCI DSS v4.0 Requirement 10.3**: Log all individual user access to cardholder data. Tetragon's `security_file_open` kprobe policy satisfies this when applied to paths containing cardholder data, capturing the exact process, user ID, and timestamp of every file access.

**SOC 2 Type II CC6.8**: Detect and prevent unauthorized software. The crypto miner kill policy and process execution visibility policy together demonstrate automated controls that prevent execution of unauthorized software and generate audit evidence of attempted violations.

**NIST SP 800-190 Container Security**: Monitor container runtime behavior. Tetragon's process tree visibility and network enforcement policies fulfill the runtime monitoring requirements at a depth that network-layer tools cannot provide.

### Generating Compliance Evidence

```bash
#!/bin/bash
set -euo pipefail

# Generate monthly enforcement report for compliance auditors
MONTH=$(date -d "last month" +%Y-%m)

echo "Tetragon Enforcement Report — ${MONTH}"
echo "========================================="

# Total enforcement actions by policy
curl -sf "http://elasticsearch.logging:9200/tetragon-events/_search" \
  -H "Content-Type: application/json" \
  -d "{
    \"size\": 0,
    \"query\": {
      \"bool\": {
        \"must\": [
          {\"range\": {\"@timestamp\": {\"gte\": \"${MONTH}-01\", \"lt\": \"now/M\"}}},
          {\"exists\": {\"field\": \"process_kprobe.action\"}}
        ]
      }
    },
    \"aggs\": {
      \"by_policy\": {
        \"terms\": {\"field\": \"process_kprobe.policy_name\", \"size\": 20},
        \"aggs\": {
          \"by_action\": {
            \"terms\": {\"field\": \"process_kprobe.action\", \"size\": 5}
          }
        }
      }
    }
  }" | jq -r '
    .aggregations.by_policy.buckets[] |
    "Policy: " + .key + " — " + (.doc_count | tostring) + " events" +
    "\n  Actions: " + (.by_action.buckets | map(.key + "=" + (.doc_count | tostring)) | join(", "))
  '
```

This report provides auditors with quantitative evidence that enforcement controls are active and firing, satisfying continuous monitoring requirements without manual log review.

## Conclusion

Tetragon's eBPF enforcement model changes the economics of container security: instead of detecting attacks and scrambling to respond, attacks are terminated at the system call boundary before any impact occurs. The operational challenge is building the confidence to deploy enforcement policies in production — which requires the disciplined audit-then-enforce methodology, robust monitoring of enforcement events, and version-controlled policies that can be quickly reverted if a false positive disrupts a production workload.

The TracingPolicy patterns in this guide — process visibility, network egress enforcement, sensitive file protection, and crypto miner SIGKILL — cover the most common attack scenarios against Kubernetes workloads. Deployed alongside Falco for detection breadth and Cilium for network policy enforcement, Tetragon completes a defense-in-depth architecture where each layer independently catches and terminates different threat classes. This layered approach is the current best practice for Kubernetes security at the kernel level.
