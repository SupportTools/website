---
title: "Falco Custom Rules and Runtime Security: Kubernetes Threat Detection Guide"
date: 2026-12-24T00:00:00-05:00
draft: false
tags: ["Falco", "Runtime Security", "Kubernetes", "Threat Detection", "eBPF", "Security", "SIEM"]
categories:
- Security
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive Falco guide: custom rule authoring, exception management, Falcosidekick alerting to Slack/PagerDuty, eBPF driver configuration, MITRE ATT&CK mapping, and incident response integration."
more_link: "yes"
url: "/falco-custom-rules-runtime-security-kubernetes-guide/"
---

**Falco** is the de facto open-source runtime security tool for Kubernetes. Where container image scanners and static analysis find vulnerabilities at build time, Falco detects threats at execution time — the moment a process misbehaves, a sensitive file is read, or a shell is spawned inside a container. For production Kubernetes clusters handling regulated workloads, Falco provides the kernel-level visibility that network-layer tools and admission controllers cannot: what processes actually ran, what files they touched, and what network connections they attempted.

This guide moves beyond the default rule set into production-grade custom rule authoring, systematic false positive reduction, **Falcosidekick** alert routing to Slack, PagerDuty, and Elasticsearch, and the operational discipline of mapping detections to **MITRE ATT&CK** tactics. All rule YAML is validated and directly deployable.

<!--more-->

## Falco Architecture: Driver Options

Falco captures kernel events through one of three driver mechanisms, each with different tradeoff profiles:

**Kernel module driver** is the original mechanism. A kernel module (`falco.ko`) is inserted into the running kernel and exports system call events to a userspace ring buffer. It is the most mature and performant option but requires kernel headers at installation time and introduces the risk of kernel panics on driver bugs or version mismatches. Use it on static, fully controlled node images.

**eBPF probe** uses a BPF CO-RE (Compile Once, Run Everywhere) program loaded via `bpf()` system call. It requires a kernel version of 4.14 or later and avoids the kernel panic risk of a kernel module. The BPF program runs in a restricted, verified execution environment. This is the recommended driver for GKE, EKS, AKS, and other managed Kubernetes services where node images change regularly.

**Modern eBPF** (available since Falco 0.35) uses the BTF-enabled CO-RE approach with ring buffer maps instead of perf event arrays, delivering higher throughput and lower CPU overhead at high event rates. It requires kernel 5.8 or later. For new deployments on modern kernels, this is the preferred choice.

## Helm Installation with eBPF Driver

Install Falco using the official Helm chart with the modern eBPF driver:

```yaml
# falco-values.yaml — validated
driver:
  kind: ebpf

falco:
  grpc:
    enabled: true
    bind_address: "unix:///run/falco/falco.sock"
    threadiness: 8
  grpcOutput:
    enabled: true
  jsonOutput: true
  jsonIncludeOutputProperty: true
  logLevel: info
  priority: debug
  bufferedOutputs: false
  syscallEventDrops:
    actions:
      - log
      - alert
    rate: 0.03333
    maxBurst: 10

falcoctl:
  artifact:
    install:
      enabled: true
    follow:
      enabled: true

resources:
  requests:
    cpu: 100m
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 1024Mi
```

Apply with Helm:

```bash
#!/bin/bash
set -euo pipefail

helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

helm upgrade --install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --values falco-values.yaml \
  --wait

# Verify Falco is running and loading rules
kubectl -n falco logs ds/falco | grep -E "(Starting|Loaded)" | tail -20
```

### Configuring syscallEventDrops

The `syscallEventDrops` section is critical for production. Falco processes events from a kernel ring buffer. If the userspace consumer falls behind, events are dropped. The `alert` action emits a `Falco internal: syscall event drop` warning, enabling Prometheus to alert on drops. The `rate` and `maxBurst` values implement a token bucket to prevent alerting storms during brief CPU saturation. Tune `resources.limits.cpu` up before increasing `threadiness`.

## Understanding Rule Anatomy

Every Falco rule consists of five core fields:

- **`condition`**: A boolean expression over Falco's event fields that determines whether the rule fires. Conditions use the Falco filtering syntax, which supports logical operators, comparison operators, and set membership tests.
- **`output`**: A format string that produces the alert message. Fields from the event context are interpolated using `%field.name` syntax.
- **`priority`**: The severity level — `DEBUG`, `INFORMATIONAL`, `NOTICE`, `WARNING`, `ERROR`, `CRITICAL`, `ALERT`, `EMERGENCY`.
- **`tags`**: A list of labels for categorization, routing, and MITRE ATT&CK mapping.
- **`desc`**: A human-readable description of what the rule detects.

Falco also supports **macros** (named condition fragments for reuse) and **lists** (named value collections for `in` operators). Default rules make extensive use of macros like `spawned_process` and `container`. Custom rules should import and extend these rather than rewriting them.

## Writing Custom Rules

### Detecting Cryptocurrency Miners

Cryptocurrency mining is the most common malicious workload found in compromised Kubernetes clusters. Miners are identifiable by binary names, command-line arguments (pool addresses, donation levels), or anomalous CPU utilization patterns. The following rule covers all common detection vectors:

```yaml
customRules:
  crypto-miner-detection.yaml: |-
    - rule: Crypto Miner Execution
      desc: Detect execution of common crypto mining binaries
      condition: >
        spawned_process and
        (proc.name in (xmrig, minerd, cpuminer, ethminer, t-rex, nbminer, lolminer, teamredminer) or
         proc.cmdline contains "stratum+tcp" or
         proc.cmdline contains "stratum+ssl" or
         proc.cmdline contains "--donate-level" or
         (proc.cmdline contains "pool." and proc.cmdline contains "-u") )
      output: >
        Crypto miner execution detected
        (user=%user.name user_uid=%user.uid command=%proc.cmdline
        pid=%proc.pid parent=%proc.pname container=%container.name
        image=%container.image.repository)
      priority: CRITICAL
      tags: [host, container, process, mitre_execution, T1496]
```

The `T1496` tag maps to MITRE ATT&CK technique "Resource Hijacking." This tag enables automated SIEM correlation with other T1496 signals from network-layer and cloud-trail detection sources.

### Detecting Reverse Shells

Reverse shells are among the most reliable indicators of active exploitation. An attacker who has achieved code execution in a pod typically pivots to a reverse shell for interactive access. The signature is a shell process with a network file descriptor as stdin/stdout:

```yaml
customRules:
  reverse-shell.yaml: |-
    - rule: Reverse Shell Detected
      desc: Detect processes that may indicate a reverse shell
      condition: >
        spawned_process and
        (proc.name in (bash, sh, zsh, ksh, dash) and
         (proc.cmdline contains "/dev/tcp/" or
          proc.cmdline contains "/dev/udp/" or
          (proc.args contains "-i" and
           (fd.type = ipv4 or fd.type = ipv6))))
      output: >
        Reverse shell activity detected
        (user=%user.name user_uid=%user.uid command=%proc.cmdline
        pid=%proc.pid parent=%proc.pname container=%container.name
        image=%container.image.repository k8s_pod=%k8s.pod.name
        k8s_ns=%k8s.ns.name)
      priority: CRITICAL
      tags: [host, container, network, shell, mitre_execution, T1059.004]
```

### Detecting Sensitive File Access

Kubernetes secrets and host-level credentials are high-value targets. The following rule fires whenever a process not on an explicit allowlist reads files that should be off-limits for containerized workloads:

```yaml
customRules:
  sensitive-files.yaml: |-
    - rule: Sensitive File Access
      desc: Detect reads to sensitive files by unexpected processes
      condition: >
        open_read and
        (fd.name in (/etc/shadow, /etc/passwd, /etc/sudoers,
                     /root/.ssh/id_rsa, /root/.ssh/authorized_keys,
                     /proc/self/environ) or
         fd.name startswith /etc/kubernetes/ or
         fd.name startswith /var/run/secrets/kubernetes.io/)
        and not proc.name in (sshd, sudo, kubernetes, kubelet, vault)
        and not container.image.repository startswith "k8s.gcr.io"
      output: >
        Sensitive file accessed
        (user=%user.name command=%proc.cmdline file=%fd.name
        container=%container.name image=%container.image.repository
        k8s_pod=%k8s.pod.name k8s_ns=%k8s.ns.name)
      priority: WARNING
      tags: [filesystem, container, mitre_credential_access, T1552.001]
```

`T1552.001` maps to MITRE ATT&CK "Unsecured Credentials: Credentials in Files."

## Rule Exceptions to Reduce False Positives

The biggest operational challenge with Falco in production is managing false positives. Default rules generate significant noise against legitimate workloads — debugging containers, CI/CD agents, monitoring sidecars. Rather than weakening rules globally, Falco's **exception** mechanism allows precise exemptions:

```yaml
customRules:
  exceptions-example.yaml: |-
    - rule: Reverse Shell Detected
      exceptions:
        - name: trusted_debug_pods
          fields: [k8s.ns.name, k8s.pod.name]
          comps: [=, startswith]
          values:
            - [debug, debug-pod-]
        - name: known_tools
          fields: [proc.name, proc.pname]
          comps: [=, =]
          values:
            - [bash, kubectl]
            - [sh, helm]
```

Exceptions are scoped: the `trusted_debug_pods` exception only suppresses the `Reverse Shell Detected` rule for pods in the `debug` namespace whose names start with `debug-pod-`. The rule remains active for all other namespaces and pods. This surgical suppression is far preferable to modifying the rule condition globally.

### Exception Governance

Track exceptions in version control alongside the rules themselves. Each exception should carry a comment linking to the incident ticket or approved change request that justified it. Regular reviews — monthly for critical rules — identify exceptions that no longer apply and should be removed. An accumulation of undocumented exceptions is a significant audit finding in SOC 2 and ISO 27001 assessments.

## Falcosidekick: Alert Routing

**Falcosidekick** is a sidecar that consumes Falco's gRPC event stream and routes alerts to dozens of output targets. Deploy it alongside Falco to avoid implementing alert routing in the main Falco process:

```yaml
falcosidekick:
  enabled: true
  config:
    slack:
      webhookurl: "https://hooks.slack.com/services/T000/B000/XXXX"
      channel: "#security-alerts"
      footer: "Falco Security Alert"
      minimumpriority: "warning"
    pagerduty:
      routingKey: "your-pagerduty-routing-key"
      minimumpriority: "critical"
    elasticsearch:
      hostport: "http://elasticsearch.logging:9200"
      index: "falco-alerts"
      minimumpriority: "debug"
    webhook:
      address: "http://alert-manager.monitoring:9093/api/v1/alerts"
      minimumpriority: "warning"
  replicaCount: 2
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi
```

### Priority Routing Strategy

Route alerts by priority to different destinations:

- `CRITICAL` and `ALERT`: PagerDuty (immediate page) + Slack + Elasticsearch
- `WARNING` and `ERROR`: Slack + Elasticsearch (no page)
- `NOTICE`, `INFORMATIONAL`, `DEBUG`: Elasticsearch only (SIEM enrichment, no human notification)

This tiered approach prevents alert fatigue while ensuring all events are preserved for forensic investigation. Elasticsearch retains `DEBUG`-priority events for 90 days, providing the raw event history required for incident reconstruction.

## Elasticsearch Integration for SIEM

Falco events flowing through Falcosidekick to Elasticsearch create a structured security event log suitable for SIEM correlation:

```yaml
falcosidekick:
  enabled: true
  config:
    elasticsearch:
      hostport: "http://elasticsearch.logging:9200"
      index: "falco-alerts"
      minimumpriority: "debug"
    webhook:
      address: "http://alert-manager.monitoring:9093/api/v1/alerts"
      minimumpriority: "warning"
  replicaCount: 2
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi
```

In Elasticsearch, apply an index template that maps Falco's JSON output fields for efficient querying:

```bash
#!/bin/bash
# Create Falco index template in Elasticsearch
curl -X PUT "http://elasticsearch.logging:9200/_index_template/falco" \
  -H "Content-Type: application/json" \
  -d '{
    "index_patterns": ["falco-*"],
    "template": {
      "mappings": {
        "properties": {
          "time":      {"type": "date"},
          "rule":      {"type": "keyword"},
          "priority":  {"type": "keyword"},
          "output":    {"type": "text"},
          "hostname":  {"type": "keyword"},
          "tags":      {"type": "keyword"},
          "output_fields": {
            "properties": {
              "k8s.ns.name":  {"type": "keyword"},
              "k8s.pod.name": {"type": "keyword"},
              "proc.name":    {"type": "keyword"},
              "proc.cmdline": {"type": "text"},
              "fd.name":      {"type": "keyword"},
              "container.name": {"type": "keyword"}
            }
          }
        }
      }
    }
  }'
```

SIEM detection rules can then correlate Falco alerts with network-layer signals: for example, a Falco `Reverse Shell Detected` event in the same pod within 5 minutes of an inbound connection from a known bad IP creates a high-confidence incident with minimal analyst investigation required.

## MITRE ATT&CK Tag Mapping

Mapping Falco rules to MITRE ATT&CK enables integration with threat intelligence platforms and structured incident reporting. The convention is to include both the tactic tag (e.g., `mitre_execution`) and the specific technique ID (e.g., `T1059.004`) in the rule's `tags` field:

```yaml
customRules:
  mitre-mapped.yaml: |-
    - rule: Container Escape via Privileged Exec
      desc: Detect attempts to escape container via privileged execution
      condition: >
        spawned_process and
        container and
        proc.name = nsenter and
        proc.args contains "--target 1"
      output: >
        Possible container escape via nsenter
        (user=%user.name command=%proc.cmdline container=%container.name
        image=%container.image.repository k8s_pod=%k8s.pod.name
        k8s_ns=%k8s.ns.name)
      priority: CRITICAL
      tags: [container, privilege_escalation, mitre_privilege_escalation, T1611]

    - rule: Kubectl Exec into Pod
      desc: Detect kubectl exec commands targeting production pods
      condition: >
        k8s_audit and
        ka.verb = "create" and
        ka.target.subresource = "exec" and
        not ka.user.name startswith "system:serviceaccount:kube-system"
      output: >
        kubectl exec into pod detected
        (user=%ka.user.name pod=%ka.target.name ns=%ka.target.namespace
        container=%ka.req.pod.containers.image)
      priority: NOTICE
      tags: [k8s_audit, mitre_lateral_movement, T1021]
```

`T1611` maps to "Escape to Host" — a critical technique for container security. `T1021` maps to "Remote Services" under Lateral Movement. SIEM platforms that ingest MITRE tags can automatically correlate Falco alerts with other techniques in the same kill chain.

### ATT&CK Coverage Dashboard

After deploying tagged rules, generate a coverage matrix:

```bash
#!/bin/bash
# Extract all MITRE technique IDs from deployed rules
kubectl -n falco get configmap falco \
  -o jsonpath='{.data.falco_rules\.yaml}' \
  | grep -oP 'T\d{4}(\.\d{3})?' \
  | sort -u \
  | while read -r technique; do
      echo "Technique: ${technique}"
    done
```

This inventory feeds directly into security posture reporting and identifies detection gaps for prioritized rule development.

## Rule Testing with event-generator

The **event-generator** tool deliberately triggers Falco rules, allowing validation that rules fire correctly in the deployment environment before relying on them for production alerting:

```bash
#!/bin/bash
set -euo pipefail

# Install event-generator for testing Falco rules
kubectl run event-generator \
  --image=falcosecurity/event-generator \
  --restart=Never \
  --namespace=default \
  -- run syscall --loop

# Test specific rule category
kubectl run event-generator-test \
  --image=falcosecurity/event-generator \
  --restart=Never \
  --namespace=default \
  -- run syscall.ReadSensitiveFileUntrusted
```

Run event-generator in a non-production namespace and watch the Falco output simultaneously:

```bash
#!/bin/bash
# Tail Falco alerts while running event-generator
kubectl logs -n falco ds/falco -f | jq 'select(.priority == "CRITICAL")'

# Check Falco metrics
curl -s http://localhost:8765/metrics | grep falco_

# Reload rules without restart
kubectl exec -n falco ds/falco -- kill -1 1
```

The `kill -1 1` sends SIGHUP to the Falco process (PID 1 inside the container), triggering a hot reload of custom rules. This is safe to run in production for rule updates that do not require driver reload.

### Continuous Rule Validation in CI

Integrate event-generator into CI pipelines to catch rule regressions before deployment:

```bash
#!/bin/bash
set -euo pipefail

# Deploy Falco with new rules to staging namespace
helm upgrade --install falco-staging falcosecurity/falco \
  --namespace falco-staging \
  --create-namespace \
  --values falco-staging-values.yaml \
  --wait

# Run event-generator and capture Falco output
kubectl -n falco-staging exec ds/falco -- \
  falco-event-generator run syscall 2>&1 | tee /tmp/falco-test-output.txt

# Assert expected rules fired
EXPECTED_RULES=("Reverse Shell Detected" "Sensitive File Access" "Crypto Miner Execution")
for rule in "${EXPECTED_RULES[@]}"; do
  if ! grep -q "${rule}" /tmp/falco-test-output.txt; then
    echo "FAIL: Expected rule '${rule}' did not fire"
    exit 1
  fi
  echo "PASS: Rule '${rule}' fired correctly"
done
```

## Tuning Falco for High-Throughput Environments

In clusters running high-frequency workloads (batch jobs, high-volume APIs), Falco can generate significant CPU and memory overhead if rules are not tuned. The following Helm values optimize Falco for throughput.

### Adaptive Event Sampling

For namespaces running trusted, high-volume batch workloads, use conditional sampling macros to reduce the event rate passed to rule evaluation without creating security gaps. Define a macro that marks known-safe namespaces:

```bash
#!/bin/bash
# Check current Falco syscall drop rate (non-zero means capacity issue)
kubectl -n falco exec ds/falco -- \
  curl -s http://localhost:8765/metrics \
  | grep falco_events_dropped_total

# If drops are occurring, check threadiness vs CPU allocation
kubectl -n falco get ds falco \
  -o jsonpath='{.spec.template.spec.containers[0].resources}'
```

Increase `threadiness` in Helm values when `falco_events_dropped_total` is rising. Each thread handles events from a separate ring buffer CPU core. Set `threadiness` to match the number of CPUs allocated in `resources.limits.cpu`.

The Helm values for throughput optimization:

```yaml
driver:
  kind: ebpf

falco:
  grpc:
    enabled: true
    bind_address: "unix:///run/falco/falco.sock"
    threadiness: 8
  grpcOutput:
    enabled: true
  jsonOutput: true
  jsonIncludeOutputProperty: true
  logLevel: info
  priority: debug
  bufferedOutputs: false
  syscallEventDrops:
    actions:
      - log
      - alert
    rate: 0.03333
    maxBurst: 10

falcoctl:
  artifact:
    install:
      enabled: true
    follow:
      enabled: true

resources:
  requests:
    cpu: 100m
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 1024Mi
```

### Reducing Event Volume

- Set `falco.priority: notice` instead of `debug` to suppress low-priority events from processing
- Add namespace-level exclusions using `k8s.ns.name` conditions to skip monitoring namespaces running unthreatened batch jobs
- Use `append: true` on list overrides to add to the default allowlists rather than creating separate rules that evaluate in addition to defaults
- Prefer `and not proc.name in (list_name)` over individual `and not proc.name = X` conditions — list membership checks are O(1) in Falco's engine

### Multi-Rule Anti-Patterns

Avoid creating many narrow rules covering slight variations of the same behavior. Falco evaluates every rule against every event. Ten rules that each cover one miner binary name cost 10x the evaluation overhead of one rule covering all ten names in a list. Consolidate related detections into single rules using lists and complex conditions.

## Kubernetes Audit Log Integration

Falco supports two event sources: the syscall source (the kernel driver) and the **Kubernetes audit log** source. Combining both provides complete coverage of the control plane and the data plane.

The audit log source captures events from the Kubernetes API server: pod creations, RBAC permission grants, secret reads, and `kubectl exec` sessions. These events are invisible to the syscall source because they occur entirely in the API server process, not in workload processes.

### Configuring Audit Log Rules

Enable the audit log plugin in Falco configuration:

```bash
#!/bin/bash
# Patch Falco ConfigMap to enable K8s audit log webhook
kubectl -n falco get configmap falco -o yaml \
  | grep -q "k8saudit" \
  || echo "k8saudit plugin not enabled — check falco-values.yaml"

# The K8s API server must be configured to send webhooks to Falco
# Add to kube-apiserver: --audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
```

Rules for Kubernetes audit events use the `k8s_audit` tag and reference fields prefixed with `ka.`:

```yaml
customRules:
  k8s-audit-rules.yaml: |-
    - rule: Secret or ConfigMap Read by Unknown Process
      desc: Detect when secrets or configmaps are read outside of expected service accounts
      condition: >
        k8s_audit and
        ka.verb in (get, list, watch) and
        ka.target.resource in (secrets, configmaps) and
        not ka.user.name startswith "system:serviceaccount:kube-system" and
        not ka.user.name = "system:apiserver" and
        not ka.user.name startswith "system:node:"
      output: >
        Unexpected secret or configmap read
        (user=%ka.user.name resource=%ka.target.resource name=%ka.target.name
        ns=%ka.target.namespace verb=%ka.verb)
      priority: WARNING
      tags: [k8s_audit, mitre_credential_access, T1552.007]

    - rule: Privileged Pod Created
      desc: Detect creation of pods with privileged security context
      condition: >
        k8s_audit and
        ka.verb = "create" and
        ka.target.resource = "pods" and
        ka.req.pod.containers.privileged = true
      output: >
        Privileged pod created
        (user=%ka.user.name pod=%ka.target.name ns=%ka.target.namespace
        image=%ka.req.pod.containers.image)
      priority: WARNING
      tags: [k8s_audit, container, mitre_privilege_escalation, T1610]

    - rule: ClusterRole or ClusterRoleBinding Created
      desc: Detect creation of cluster-level RBAC resources
      condition: >
        k8s_audit and
        ka.verb in (create, update, patch) and
        ka.target.resource in (clusterroles, clusterrolebindings)
      output: >
        Cluster RBAC resource created or modified
        (user=%ka.user.name verb=%ka.verb resource=%ka.target.resource
        name=%ka.target.name)
      priority: WARNING
      tags: [k8s_audit, mitre_persistence, T1098]
```

`T1552.007` maps to MITRE "Unsecured Credentials: Container API" — accessing Kubernetes secrets through the API server. `T1610` maps to "Deploy Container" for privilege escalation via privileged pods.

### Combining Syscall and Audit Sources

The two sources are independent detection channels that reinforce each other. A pod compromise often generates signals on both:

1. Kubernetes audit log: `kubectl exec` creates a `create` verb event on the `pods/exec` subresource.
2. Syscall source: The shell spawned via exec generates a `spawned_process` event with the parent process being the container runtime exec handler.

Correlating these events in a SIEM (matching by pod name, namespace, and timestamp) produces a high-confidence incident signal that neither source would achieve alone.

## Incident Response Integration

When a Falco alert fires at `CRITICAL` priority, the structured JSON output provides the raw material for automated incident response workflows. A Falcosidekick webhook target can trigger a Lambda function, GitHub Actions workflow, or Argo Events trigger that:

1. Captures a `kubectl describe pod` and `kubectl logs` snapshot of the offending pod
2. Cordons the node to prevent new pod scheduling if severity warrants
3. Annotates the pod with the incident ticket ID for audit trail
4. Notifies the on-call engineer via PagerDuty with pre-populated runbook link

The `k8s.pod.name`, `k8s.ns.name`, and `container.image.repository` fields in Falco's JSON output provide all context needed to automate these first-responder actions without human intervention in the critical first minutes of an incident.

## Falco Performance Monitoring

Falco exposes Prometheus metrics that reveal its own health and the load it is processing. Monitor these to avoid silent coverage gaps:

```bash
#!/bin/bash
# Port-forward Falco metrics endpoint
kubectl -n falco port-forward ds/falco 8765:8765 &

# Check key metrics
curl -s http://localhost:8765/metrics | grep -E "^falco_"
```

Key metrics to alert on:

- `falco_events_processed_total`: Total events consumed from the ring buffer. A plateau indicates the driver is dropping events.
- `falco_events_dropped_total`: Events dropped by the kernel driver due to buffer overflow. Non-zero values mean Falco has a visibility gap.
- `falco_rules_matching_total`: Events matched by at least one rule. Useful for baselining rule hit rates and detecting rule regressions after updates.
- `falco_sw_filters`: Number of Falco rules active. Sudden drop indicates a configuration load failure.

### Capacity Planning

Falco's CPU overhead scales with both the event rate and the rule complexity. As a general guideline:

- A node running 50 containers with moderate syscall rates: 50-150m CPU for Falco
- A high-throughput batch node (thousands of short-lived processes/second): 500m-1000m CPU

If `falco_events_dropped_total` increases under load, increase the ring buffer size through the `syscallBufSizePreset` Helm value or reduce rule complexity by moving expensive string match conditions into priority exclusion macros that short-circuit evaluation.

## Falco Rule Governance and Change Management

In regulated environments, every change to the Falco rule set is a security control change and requires proper governance. Treat Falco rules as security policy artifacts subject to the same review and approval process as firewall rules or IAM policies.

### Rule Version Control Workflow

Store all custom rules in a dedicated Git repository with branch protection:

```bash
#!/bin/bash
set -euo pipefail

# Validate all custom rule YAML files before committing
find ./rules -name "*.yaml" | while read -r rule_file; do
  python3 -c "import yaml; yaml.safe_load(open('${rule_file}'))" \
    && echo "YAML OK: ${rule_file}" \
    || { echo "YAML INVALID: ${rule_file}"; exit 1; }
done

# Deploy updated rules to staging via Helm
helm upgrade falco falcosecurity/falco \
  --namespace falco \
  --reuse-values \
  --set-file "customRules.custom-rules\.yaml=./rules/custom-rules.yaml" \
  --wait

# Run event-generator to verify rules still fire correctly
kubectl run falco-test \
  --image=falcosecurity/event-generator \
  --restart=Never \
  --namespace=falco-test \
  -- run syscall.ReadSensitiveFileUntrusted

# Collect alerts for 30 seconds
sleep 30
kubectl -n falco logs ds/falco \
  | jq 'select(.rule == "Read sensitive file untrusted")' \
  | head -5

# Clean up test pod
kubectl delete pod falco-test -n falco-test --ignore-not-found
```

Each rule change requires:

1. **Author review**: Rule logic, condition correctness, and output field completeness checked by the author
2. **Peer review**: Second engineer reviews for false positive risk and MITRE mapping accuracy
3. **Staging validation**: event-generator confirms the rule fires and Falcosidekick delivers alerts
4. **Production deployment**: Merged to main, applied to production via GitOps controller

This workflow ensures that the runtime security posture of the cluster matches the reviewed and approved rule set at all times.

## Conclusion

Falco's value as a production security tool is proportional to the quality of its rule set and the discipline of its false positive management. Default rules catch known-bad patterns but generate noise against legitimate workloads. Custom rules targeting the specific threat profile of each workload type — financial services APIs face different attacker TTPs than batch data pipelines — provide actionable, low-noise signals that on-call engineers actually respond to.

The combination of eBPF-based event capture, MITRE ATT&CK tagging, Falcosidekick routing, and Elasticsearch retention creates a complete runtime security posture: real-time alerting for critical events, structured SIEM data for correlation and forensics, and an audit trail that satisfies SOC 2, PCI DSS, and HIPAA requirements for continuous monitoring.
