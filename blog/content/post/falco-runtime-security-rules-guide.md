---
title: "Falco Runtime Security: Custom Rules and Production Threat Detection"
date: 2027-10-01T00:00:00-05:00
draft: false
tags: ["Falco", "Security", "Kubernetes", "Runtime Security", "eBPF"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Falco rule development for production Kubernetes — custom rules for privilege escalation, container drift, network anomalies, Falco Sidekick output routing, eBPF driver tuning, and SIEM integration."
more_link: "yes"
url: "/falco-runtime-security-rules-guide/"
---

Runtime security fills the gap that admission controllers and image scanning cannot address: detecting malicious behavior at the moment it occurs in a running container. Falco, the CNCF-graduated runtime security tool, hooks into the Linux kernel via eBPF or kernel module to observe every system call and evaluate them against security rules in real time. This guide covers advanced rule development — privilege escalation detection, container drift monitoring, network anomaly detection — along with Falco Sidekick integration for multi-channel alerting, eBPF driver performance tuning, and patterns for integrating Falco alerts into SIEM platforms.

<!--more-->

# Falco Runtime Security: Custom Rules and Production Threat Detection

## Section 1: Falco Architecture and Detection Model

Falco processes kernel events through a rules engine. Each rule evaluates a condition expression against event metadata and fires an alert when a match occurs.

### How Falco Works

```
┌─────────────────────────────────────────────────────────┐
│                   Linux Kernel                          │
│  System Calls: open, execve, connect, bind, ptrace...  │
└─────────────────────────┬───────────────────────────────┘
                          │ eBPF probe
┌─────────────────────────▼───────────────────────────────┐
│              Falco Kernel Driver (eBPF)                  │
│  Captures events with process context, container ID,    │
│  user, namespace, network information                   │
└─────────────────────────┬───────────────────────────────┘
                          │ Structured events
┌─────────────────────────▼───────────────────────────────┐
│              Falco Userspace Engine                      │
│  Rules Parser → Condition Evaluator → Alert Dispatcher │
└─────────────────────────┬───────────────────────────────┘
                          │ Alerts
              ┌───────────┼──────────────┐
              ▼           ▼              ▼
         stdout        gRPC        Falco Sidekick
         (JSON)      (plugins)    (Slack, PD, ES...)
```

### Event Fields Available in Rules

```
Process fields:
  proc.name       - executable name
  proc.exepath    - full executable path
  proc.cmdline    - full command line
  proc.pid        - process ID
  proc.ppid       - parent process ID
  proc.pname      - parent process name
  proc.pcmdline   - parent command line
  proc.user       - user name
  proc.uid        - user ID

Container fields:
  container.id    - container ID
  container.name  - container name
  container.image.repository - image name
  container.image.tag        - image tag
  k8s.ns.name     - Kubernetes namespace
  k8s.pod.name    - Kubernetes pod name
  k8s.deployment.name - Kubernetes deployment

File fields:
  fd.name         - file descriptor path
  fd.typechar     - type (f=file, 4=IPv4, 6=IPv6)
  fd.directory    - directory of file

Network fields:
  fd.sip          - source IP
  fd.dip          - destination IP
  fd.sport        - source port
  fd.dport        - destination port
  fd.l4proto      - TCP or UDP
```

## Section 2: Installing Falco with eBPF Driver

### Helm Installation

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

# Install Falco with eBPF driver (preferred for modern kernels)
helm upgrade --install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --set driver.kind=ebpf \
  --set tty=true \
  --set falco.grpc.enabled=true \
  --set falco.grpcOutput.enabled=true \
  --set falcoctl.artifact.install.enabled=true \
  --set falcoctl.artifact.follow.enabled=true \
  --set "falcoctl.config.artifact.follow.refs[0]=falco-rules:3" \
  --set metrics.enabled=true \
  --set serviceMonitor.create=true \
  --version 4.6.0 \
  --wait
```

### Verify Installation

```bash
# Check Falco is running
kubectl get pods -n falco
kubectl logs -n falco -l app.kubernetes.io/name=falco --tail=20

# Test a rule by triggering a shell in a container
kubectl run test-shell --image=alpine --restart=Never --rm -it -- \
  /bin/sh -c "cat /etc/shadow"

# Check if Falco detected it
kubectl logs -n falco -l app.kubernetes.io/name=falco --tail=5 | \
  grep -i "shadow"
```

## Section 3: Rule Syntax and Macros

Falco rules use a YAML-based DSL with conditions written in a predicate logic language.

### Rule Structure

```yaml
# Rule anatomy
- rule: Rule Name
  desc: Human-readable description
  condition: <boolean expression using event fields and macros>
  output: <formatted string with field interpolation>
  priority: CRITICAL|ERROR|WARNING|NOTICE|INFO|DEBUG
  tags: [tag1, tag2]
  enabled: true
```

### Essential Macros

```yaml
# falco-macros.yaml
- macro: container
  condition: container.id != host

- macro: k8s_containers
  condition: >
    container.image.repository in (
      "k8s.gcr.io/kube-proxy",
      "k8s.gcr.io/coredns",
      "registry.k8s.io/pause"
    )

- macro: user_known_write_root_directories
  condition: >
    fd.name startswith /dev or
    fd.name startswith /proc or
    fd.name startswith /sys

- macro: spawned_process
  condition: evt.type = execve and evt.dir = <

- macro: open_write
  condition: >
    (evt.type = open or evt.type = openat or evt.type = openat2) and
    evt.is_open_write = true and
    fd.typechar = 'f' and
    fd.num >= 0

- macro: never_true
  condition: (evt.num = 0)

- macro: always_true
  condition: (evt.num >= 0)

# Kubernetes-specific macros
- macro: kube_system_containers
  condition: k8s.ns.name = "kube-system"

- macro: privileged_containers
  condition: container.privileged = true
```

## Section 4: Custom Rules for Threat Detection

### Privilege Escalation Detection

```yaml
# falco-privilege-escalation-rules.yaml

# Detect attempts to run sudo or su
- rule: Sudo or Su Execution in Container
  desc: Detects sudo or su execution which may indicate privilege escalation
  condition: >
    spawned_process and
    container and
    proc.name in (sudo, su) and
    not k8s_containers
  output: >
    Sudo/su executed in container
    (user=%user.name user_uid=%user.uid command=%proc.cmdline
     pid=%proc.pid parent=%proc.pname image=%container.image.repository
     container=%container.id k8s_ns=%k8s.ns.name pod=%k8s.pod.name)
  priority: WARNING
  tags: [container, privilege_escalation, T1548]

# Detect setuid binary execution
- rule: Setuid/Setgid Binary Executed
  desc: Detects execution of setuid or setgid binaries from containers
  condition: >
    spawned_process and
    container and
    (proc.is_suid_exec = true or proc.is_sgid_exec = true) and
    not proc.name in (ping, traceroute, sudo)
  output: >
    Setuid/setgid binary executed
    (user=%user.name uid=%user.uid cmd=%proc.cmdline
     image=%container.image.repository container=%container.id)
  priority: WARNING
  tags: [container, privilege_escalation, T1548.001]

# Detect capability changes
- rule: Linux Capability Granted to Container Process
  desc: A container process was granted Linux capabilities
  condition: >
    evt.type = capset and
    container and
    (evt.arg.cap_effective contains CAP_SYS_ADMIN or
     evt.arg.cap_effective contains CAP_SYS_PTRACE or
     evt.arg.cap_effective contains CAP_NET_ADMIN or
     evt.arg.cap_effective contains CAP_SYS_MODULE)
  output: >
    Dangerous capability granted
    (user=%user.name uid=%user.uid pid=%proc.pid
     exe=%proc.exepath cap=%evt.arg.cap_effective
     container=%container.id k8s_pod=%k8s.pod.name)
  priority: CRITICAL
  tags: [container, privilege_escalation, T1548.001]

# Detect nsenter or container escape attempts
- rule: Container Namespace Escape Attempt
  desc: Detects use of tools commonly used for container escapes
  condition: >
    spawned_process and
    container and
    proc.name in (nsenter, unshare, capsh) and
    not proc.pname in (docker, containerd, runc)
  output: >
    Namespace escape tool executed in container
    (user=%user.name cmd=%proc.cmdline
     image=%container.image.repository container=%container.id
     k8s_ns=%k8s.ns.name pod=%k8s.pod.name)
  priority: CRITICAL
  tags: [container, escape, T1611]

# Detect /proc filesystem access
- rule: Container Read Sensitive Proc Files
  desc: Detects reads from sensitive /proc paths that may indicate container escape
  condition: >
    open_read and
    container and
    (fd.name startswith /proc/1/ or
     fd.name = /proc/sysrq-trigger or
     fd.name = /proc/kcore) and
    not k8s_containers
  output: >
    Sensitive /proc file read from container
    (user=%user.name file=%fd.name
     image=%container.image.repository container=%container.id)
  priority: ERROR
  tags: [container, escape, filesystem, T1083]
```

### Container Drift Detection

Container drift occurs when a running container's filesystem changes after startup — a common indicator of compromise or misconfiguration.

```yaml
# falco-container-drift-rules.yaml

# Detect new executables created in container at runtime
- rule: Drift Detected in Container - New Executable
  desc: >
    Detects when a new executable file is created in a running container,
    indicating the container's immutable image has been modified
  condition: >
    open_write and
    container and
    not k8s_containers and
    (fd.name endswith ".sh" or
     fd.name endswith ".py" or
     fd.name endswith ".rb" or
     fd.name endswith ".pl" or
     fd.name startswith /usr/local/bin/ or
     fd.name startswith /usr/bin/ or
     fd.name startswith /bin/ or
     fd.name startswith /tmp/) and
    not (proc.name in (pip, npm, apt, yum, apk) and
         k8s.ns.name = "ci-build")
  output: >
    New executable written to container filesystem (drift detected)
    (user=%user.name pid=%proc.pid cmd=%proc.cmdline
     file=%fd.name image=%container.image.repository
     container=%container.id k8s_ns=%k8s.ns.name pod=%k8s.pod.name)
  priority: ERROR
  tags: [container, drift, T1059]

# Detect modifications to /etc files
- rule: Write Below Etc in Container
  desc: Detects writes to /etc directory in container which may indicate config tampering
  condition: >
    open_write and
    container and
    fd.name startswith /etc and
    not (fd.name startswith /etc/resolv.conf or
         fd.name startswith /etc/hosts or
         fd.name startswith /etc/hostname)
  output: >
    File written to /etc in container
    (user=%user.name pid=%proc.pid cmd=%proc.cmdline
     file=%fd.name image=%container.image.repository
     container=%container.id)
  priority: WARNING
  tags: [container, filesystem, T1565.001]

# Detect package managers running in production containers
- rule: Package Manager Executed in Production Container
  desc: Package managers should not run in production containers
  condition: >
    spawned_process and
    container and
    proc.name in (apt, apt-get, yum, dnf, apk, pip, pip3, npm, yarn) and
    k8s.ns.name in (production, prod, payments, orders, checkout)
  output: >
    Package manager executed in production container
    (user=%user.name cmd=%proc.cmdline pid=%proc.pid
     image=%container.image.repository container=%container.id
     k8s_ns=%k8s.ns.name pod=%k8s.pod.name)
  priority: ERROR
  tags: [container, drift, supply_chain, T1072]
```

### Network Anomaly Detection

```yaml
# falco-network-rules.yaml

# Detect unexpected outbound connections
- rule: Unexpected Outbound Connection from Container
  desc: Detects connections to external IPs on unexpected ports
  condition: >
    (evt.type = connect or evt.type = sendmsg) and
    container and
    fd.typechar = 4 and
    not fd.snet in (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and
    not fd.dport in (80, 443, 53) and
    not k8s_containers and
    not proc.name in (curl, wget, ping, nslookup, dig, ssh)
  output: >
    Unexpected outbound connection from container
    (user=%user.name pid=%proc.pid cmd=%proc.cmdline
     connection=%fd.name image=%container.image.repository
     container=%container.id k8s_ns=%k8s.ns.name pod=%k8s.pod.name)
  priority: WARNING
  tags: [network, anomaly, T1071]

# Detect port scanning behavior
- rule: Network Port Scan Detected in Container
  desc: Detects rapid sequential connection attempts suggesting port scanning
  condition: >
    evt.type = connect and
    container and
    fd.typechar = 4 and
    evt.failed = true and
    proc.name not in (kubectl, helm, k9s)
  output: >
    Possible port scan from container
    (user=%user.name pid=%proc.pid cmd=%proc.cmdline
     target=%fd.dip dport=%fd.dport container=%container.id)
  priority: NOTICE
  tags: [network, scan, T1046]

# Detect connections to known malicious IPs (example using custom list)
- list: known_malicious_cidrs
  items:
    - "198.51.100.0/24"  # TEST-NET-3 — replace with actual threat intel
    - "203.0.113.0/24"   # TEST-NET-3 — replace with actual threat intel

- rule: Connection to Known Malicious IP
  desc: Detects connection to IPs in known malicious CIDR ranges
  condition: >
    (evt.type = connect or evt.type = sendmsg) and
    container and
    fd.typechar = 4 and
    fd.dnet in (known_malicious_cidrs)
  output: >
    Connection to known malicious IP from container
    (user=%user.name pid=%proc.pid cmd=%proc.cmdline
     dest=%fd.dip dport=%fd.dport
     container=%container.id k8s_pod=%k8s.pod.name)
  priority: CRITICAL
  tags: [network, threat_intel, T1071]

# Detect DNS exfiltration patterns (long subdomains)
- rule: Suspicious DNS Query Length
  desc: Very long DNS queries may indicate DNS tunneling or exfiltration
  condition: >
    evt.type = sendmsg and
    container and
    fd.dport = 53 and
    fd.typechar in (4, 6) and
    evt.buflen > 200
  output: >
    Suspicious long DNS query from container
    (user=%user.name pid=%proc.pid cmd=%proc.cmdline
     size=%evt.buflen container=%container.id pod=%k8s.pod.name)
  priority: WARNING
  tags: [network, dns, exfiltration, T1048]
```

### Kubernetes-Specific Rules

```yaml
# falco-k8s-rules.yaml

# Detect exec into pods
- rule: Terminal Shell in Container
  desc: A shell was spawned via exec in a container
  condition: >
    container and
    (proc.name = bash or proc.name = sh or proc.name = zsh) and
    (proc.pname = runc or proc.pname = containerd-shim or
     proc.pname = kubectl or proc.pname = crictl)
  output: >
    Shell spawned in container via exec
    (user=%user.name shell=%proc.name parent=%proc.pname
     image=%container.image.repository container=%container.id
     k8s_ns=%k8s.ns.name pod=%k8s.pod.name)
  priority: NOTICE
  tags: [container, shell, T1059.004]

# Detect sensitive K8s API access from pods
- rule: Container Accessing Kubernetes API
  desc: A container is making direct calls to the Kubernetes API server
  condition: >
    (evt.type = connect or evt.type = sendmsg) and
    container and
    fd.typechar = 4 and
    fd.dport in (443, 6443, 8443) and
    not proc.name in (kubectl, helm, kustomize, terraform, k9s) and
    not k8s_containers
  output: >
    Container accessing Kubernetes API
    (user=%user.name pid=%proc.pid cmd=%proc.cmdline
     dest=%fd.dip dport=%fd.dport
     container=%container.id k8s_pod=%k8s.pod.name)
  priority: WARNING
  tags: [kubernetes, api, T1552.007]

# Detect service account token reads
- rule: Service Account Token Read
  desc: A process read a Kubernetes service account token
  condition: >
    open_read and
    container and
    fd.name startswith /var/run/secrets/kubernetes.io/serviceaccount/ and
    not proc.name in (java, python, python3, node, ruby, go) and
    not k8s_containers
  output: >
    Service account token read by unexpected process
    (user=%user.name pid=%proc.pid cmd=%proc.cmdline
     file=%fd.name container=%container.id pod=%k8s.pod.name)
  priority: WARNING
  tags: [kubernetes, credentials, T1552.007]
```

## Section 5: Falco Sidekick — Output Routing

Falco Sidekick subscribes to Falco's output stream and forwards alerts to multiple destinations simultaneously.

### Falco Sidekick Installation

```bash
helm upgrade --install falco-sidekick falcosecurity/falcosidekick \
  --namespace falco \
  --set config.debug=false \
  --set config.slack.webhookurl="https://hooks.slack.com/services/your/webhook/url" \
  --set config.slack.minimumpriority=warning \
  --set config.slack.messageformat='{"text":"*Falco Alert* :rotating_light:\n*Rule:* {{.Rule}}\n*Priority:* {{.Priority}}\n*Pod:* {{index .OutputFields \"k8s.pod.name\"}}\n*Namespace:* {{index .OutputFields \"k8s.ns.name\"}}\n*Image:* {{index .OutputFields \"container.image.repository\"}}"}' \
  --set config.pagerduty.routingkey="your-pagerduty-routing-key" \
  --set config.pagerduty.minimumpriority=critical \
  --set config.elasticsearch.hostport="http://elasticsearch-master.logging.svc.cluster.local:9200" \
  --set config.elasticsearch.index="falco-events" \
  --set config.elasticsearch.minimumpriority=notice \
  --set config.prometheusgateway.hostport="http://prometheus-pushgateway.monitoring.svc.cluster.local:9091" \
  --set webui.enabled=true \
  --version 0.8.0 \
  --wait
```

### Advanced Sidekick Configuration

```yaml
# falco-sidekick-values.yaml
config:
  debug: false

  # Slack for warning and above
  slack:
    webhookurl: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
    channel: "#security-alerts"
    minimumpriority: warning
    icon: ":warning:"
    username: "Falco Security"

  # PagerDuty for critical only
  pagerduty:
    routingkey: "your-routing-key-here"
    minimumpriority: critical

  # Elasticsearch for all events
  elasticsearch:
    hostport: "http://elasticsearch-master.logging.svc.cluster.local:9200"
    index: "falco"
    type: "_doc"
    minimumpriority: debug
    mutualtls: false
    checkcert: true
    enablecompressed: false

  # Loki for log aggregation
  loki:
    hostport: "http://loki.monitoring.svc.cluster.local:3100"
    minimumpriority: notice
    endpoint: "/loki/api/v1/push"
    extralabels: "source=falco,environment=production"

  # Webhook for custom SIEM integration
  webhook:
    address: "https://siem.acme.internal/api/events/falco"
    customheaders: "X-API-Key=replace-with-actual-api-key,Content-Type=application/json"
    minimumpriority: notice

  # Prometheus metrics
  prometheusgateway:
    hostport: "http://prometheus-pushgateway.monitoring.svc.cluster.local:9091"
    job: "falco"
    nameinlabels: true
    minimumpriority: notice
```

## Section 6: Performance Tuning with eBPF Driver

### eBPF vs Kernel Module Trade-offs

```
Driver Type     Kernel Req   Safety   Performance   Container Support
──────────────────────────────────────────────────────────────────────
kmod            Any          Lower    Highest       Limited
eBPF            4.14+        High     High          Full
modern eBPF     5.8+         Highest  High          Full
```

### Falco Configuration Tuning

```yaml
# falco-values-perf.yaml
falco:
  # Reduce event buffer size for low-memory nodes
  driver:
    kind: ebpf
    ebpf:
      path: "${HOME}/.falco/falco-bpf.o"
      bufSizePreset: 4  # 0=auto, 1-10 custom sizes
      dropFailedExit: false

  # Engine configuration
  engineKind: modern_ebpf

  # Output buffer settings
  outputs:
    rate: 1
    maxBurst: 1000

  # Disable expensive rules on high-throughput nodes
  rules_file:
    - /etc/falco/falco_rules.yaml
    - /etc/falco/falco_rules.local.yaml
    - /etc/falco/custom_rules/

  # Metadata cache TTL
  metadata_download:
    max_mb: 100
    chunk_wait_us: 1000
    watch_freq_sec: 1

  # gRPC settings
  grpc:
    enabled: true
    bind_address: "unix:///run/falco/falco.sock"
    threadiness: 8

  # Syscall filter to reduce overhead
  syscall_event_drops:
    actions:
      - log
      - alert
    rate: 0.03333
    max_burst: 10

  # Base syscalls - reduce overhead by limiting what Falco captures
  base_syscalls:
    custom_set:
      - open
      - openat
      - openat2
      - execve
      - execveat
      - connect
      - bind
      - accept
      - accept4
      - socket
      - clone
      - clone3
      - fork
      - vfork
      - setuid
      - setgid
      - capset
      - ptrace
      - mmap
      - write
      - writev
    repair: true
```

### Resource Requests for Falco DaemonSet

```yaml
# Falco Helm values for resource tuning
resources:
  requests:
    cpu: "100m"
    memory: "256Mi"
  limits:
    cpu: "1000m"
    memory: "1024Mi"
```

## Section 7: Tagging for SOC Integration

Standardized MITRE ATT&CK tags enable automated triage in SOC workflows.

### Tagged Rule Example

```yaml
# falco-mitre-tagged-rules.yaml
- rule: Cryptomining Process Detected
  desc: Detects execution of known cryptocurrency mining tools
  condition: >
    spawned_process and
    container and
    (proc.name in (xmrig, minerd, cpuminer, cgminer, bfgminer) or
     proc.cmdline contains "--stratum+tcp://" or
     proc.cmdline contains "stratum+ssl://" or
     proc.cmdline contains "xmr.pool" or
     proc.cmdline contains "monero")
  output: >
    Cryptomining software detected
    (user=%user.name cmd=%proc.cmdline pid=%proc.pid
     image=%container.image.repository container=%container.id
     k8s_ns=%k8s.ns.name pod=%k8s.pod.name)
  priority: CRITICAL
  tags:
    - container
    - cryptomining
    - T1496             # Resource Hijacking
    - container.escape
    - mitre_impact

- rule: Reverse Shell Attempt
  desc: Detects common reverse shell patterns
  condition: >
    spawned_process and
    container and
    (proc.cmdline contains "bash -i >&" or
     proc.cmdline contains "sh -i >&" or
     proc.cmdline contains "/dev/tcp/" or
     proc.cmdline contains "nc -e /bin" or
     (proc.name = nc and proc.cmdline contains "-e") or
     (proc.name = ncat and proc.cmdline contains "--exec"))
  output: >
    Reverse shell attempt detected
    (user=%user.name cmd=%proc.cmdline pid=%proc.pid
     image=%container.image.repository container=%container.id
     k8s_ns=%k8s.ns.name pod=%k8s.pod.name)
  priority: CRITICAL
  tags:
    - container
    - reverse_shell
    - T1059.004          # Unix Shell
    - T1071.001          # Web Protocols
    - mitre_execution
    - mitre_command_and_control
```

## Section 8: SIEM Integration

### Elasticsearch Alert Pipeline

```yaml
# elasticsearch-index-template.yaml
# Apply this index template before Falco events arrive
PUT _index_template/falco-events
{
  "index_patterns": ["falco-*"],
  "template": {
    "settings": {
      "number_of_shards": 2,
      "number_of_replicas": 1,
      "index.lifecycle.name": "falco-policy",
      "index.lifecycle.rollover_alias": "falco"
    },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "rule": { "type": "keyword" },
        "priority": { "type": "keyword" },
        "output": { "type": "text" },
        "hostname": { "type": "keyword" },
        "tags": { "type": "keyword" },
        "output_fields": {
          "properties": {
            "k8s.pod.name": { "type": "keyword" },
            "k8s.ns.name": { "type": "keyword" },
            "container.id": { "type": "keyword" },
            "container.image.repository": { "type": "keyword" },
            "proc.cmdline": { "type": "text" },
            "user.name": { "type": "keyword" },
            "fd.name": { "type": "keyword" },
            "fd.dip": { "type": "ip" },
            "fd.sip": { "type": "ip" }
          }
        }
      }
    }
  }
}
```

### Splunk HEC Integration via Sidekick

```yaml
# Add to falco-sidekick-values.yaml
config:
  splunk:
    hostport: "https://splunk-hec.acme.internal:8088"
    token: "hec-token-here"
    index: "falco_security"
    sourcetype: "falco:alert"
    minimumpriority: notice
    checkcert: true
```

### Falco Alert Enrichment Script

```python
#!/usr/bin/env python3
# falco-enricher.py — Enrich Falco alerts with additional context
# Run as a sidecar or webhook enrichment service

from flask import Flask, request, jsonify
import requests
import json
import os

app = Flask(__name__)

KUBERNETES_API = os.environ.get('KUBERNETES_API', 'https://kubernetes.default.svc')
THREAT_INTEL_URL = os.environ.get('THREAT_INTEL_URL', 'http://threatintel.security.svc.cluster.local:8080')

def get_pod_labels(namespace, pod_name):
    """Fetch pod labels for additional context"""
    try:
        resp = requests.get(
            f"{KUBERNETES_API}/api/v1/namespaces/{namespace}/pods/{pod_name}",
            headers={"Authorization": f"Bearer {open('/var/run/secrets/kubernetes.io/serviceaccount/token').read()}"},
            verify='/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
            timeout=2
        )
        if resp.status_code == 200:
            pod = resp.json()
            return pod.get('metadata', {}).get('labels', {})
    except Exception:
        pass
    return {}

def check_ip_reputation(ip_address):
    """Check IP against threat intelligence"""
    try:
        resp = requests.get(
            f"{THREAT_INTEL_URL}/api/v1/ip/{ip_address}",
            timeout=2
        )
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return {"score": 0, "categories": []}

@app.route('/webhook', methods=['POST'])
def enrich_alert():
    alert = request.get_json()

    output_fields = alert.get('output_fields', {})
    namespace = output_fields.get('k8s.ns.name', '')
    pod_name = output_fields.get('k8s.pod.name', '')
    dest_ip = output_fields.get('fd.dip', '')

    # Enrich with pod labels
    if namespace and pod_name:
        labels = get_pod_labels(namespace, pod_name)
        alert['enrichment'] = {
            'pod_labels': labels,
            'team': labels.get('team', 'unknown'),
            'cost_center': labels.get('cost-center', 'unknown'),
        }

    # Enrich with IP reputation
    if dest_ip:
        reputation = check_ip_reputation(dest_ip)
        alert['enrichment'] = alert.get('enrichment', {})
        alert['enrichment']['ip_reputation'] = reputation

    # Add severity score
    priority_scores = {
        'CRITICAL': 10, 'ERROR': 8, 'WARNING': 6,
        'NOTICE': 4, 'INFO': 2, 'DEBUG': 1
    }
    alert['severity_score'] = priority_scores.get(alert.get('priority', 'INFO'), 2)

    print(json.dumps(alert))
    return jsonify({'status': 'enriched', 'alert': alert})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
```

## Section 9: Testing Falco Rules

### Rule Testing with falco-tester

```bash
#!/bin/bash
# test-falco-rules.sh
set -euo pipefail

NAMESPACE="${1:-default}"

echo "=== Testing Falco rule detection ==="

# Test 1: Shell in container
echo "[1] Testing: Terminal shell detection"
kubectl run falco-test-shell \
  --image=alpine:3.19 \
  --restart=Never \
  --rm \
  -it \
  --namespace="${NAMESPACE}" \
  -- /bin/sh -c "echo 'test'; exit 0" || true

# Test 2: Sensitive file read
echo "[2] Testing: Sensitive file read"
kubectl run falco-test-file \
  --image=alpine:3.19 \
  --restart=Never \
  --rm \
  -it \
  --namespace="${NAMESPACE}" \
  -- /bin/sh -c "cat /etc/shadow 2>/dev/null || cat /etc/passwd" || true

# Test 3: Package manager execution
echo "[3] Testing: Package manager in container"
kubectl run falco-test-pkg \
  --image=ubuntu:22.04 \
  --restart=Never \
  --rm \
  --namespace="${NAMESPACE}" \
  -- /bin/bash -c "apt list --installed 2>/dev/null; exit 0" || true

echo ""
echo "Check Falco logs for alerts:"
kubectl logs -n falco -l app.kubernetes.io/name=falco --since=2m | \
  grep -E "CRITICAL|ERROR|WARNING" | head -20
```

## Section 10: Custom Rule Deployment via ConfigMap

```yaml
# falco-custom-rules-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: falco-custom-rules
  namespace: falco
data:
  custom-rules.yaml: |
    - macro: acme_production_namespaces
      condition: k8s.ns.name in (payments, orders, checkout, api-gateway)

    - macro: acme_cicd_namespaces
      condition: k8s.ns.name in (jenkins, tekton, argocd, ci-build)

    - rule: Production Database Direct Access
      desc: Detects direct database connections from non-authorized pods
      condition: >
        (evt.type = connect) and
        container and
        fd.typechar = 4 and
        fd.dport in (5432, 3306, 27017, 6379, 9042) and
        acme_production_namespaces and
        not proc.name in (java, python, python3, node, ruby, go, psql, mysql) and
        not k8s.pod.label.role = "db-migration"
      output: >
        Unexpected direct database connection
        (user=%user.name pid=%proc.pid cmd=%proc.cmdline
         dest=%fd.dip dport=%fd.dport
         container=%container.id pod=%k8s.pod.name ns=%k8s.ns.name)
      priority: ERROR
      tags: [database, lateral_movement, T1210]
```

## Summary

Falco provides runtime visibility that no other security tool in the Kubernetes stack can match. The key to production effectiveness is:

1. Start with the default ruleset, suppress known-false-positive rules for your environment
2. Add custom macros that reflect your infrastructure (namespaces, allowed images, expected processes)
3. Layer in drift detection, privilege escalation, and network anomaly rules specific to your threat model
4. Route alerts through Falco Sidekick to both incident management (PagerDuty for CRITICAL) and SIEM (Elasticsearch for all events)
5. Tag rules with MITRE ATT&CK IDs to enable automated SOC triage workflows

Performance overhead with the eBPF driver on a moderately loaded node is typically 1-3% CPU with default rules, rising to 3-8% with aggressive custom rules. Monitor the `falco_events_processed_total` and `falco_events_dropped_total` metrics to detect buffer exhaustion on high-traffic nodes.
