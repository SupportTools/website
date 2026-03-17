---
title: "Falco Runtime Security: Writing Custom Detection Rules for Kubernetes"
date: 2028-09-18T00:00:00-05:00
draft: false
tags: ["Falco", "Security", "Kubernetes", "Runtime Security", "eBPF"]
categories:
- Falco
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Falco deployment with eBPF probe, writing custom rules with condition syntax, macros, lists, falcosidekick alerting to Slack/PagerDuty, Falco Talon automated response, and detecting privilege escalation and container escapes."
more_link: "yes"
url: "/falco-runtime-security-detection-rules-guide/"
---

Static security scanning catches known vulnerabilities at build time. Runtime security detects what actually happens when containers are running: a process that should never spawn a shell spawning one, a container that should only read files writing to unexpected paths, a binary running with capabilities it was never supposed to have. Falco monitors Linux system calls via an eBPF probe and matches them against rules expressed in a straightforward condition language. When a rule fires, Falco emits a structured alert that can trigger Slack notifications, PagerDuty incidents, or automated remediation via Falco Talon. This guide covers the full stack: deployment, rule syntax, building a detection library for common attack patterns, and automated response.

<!--more-->

# Falco Runtime Security: Writing Custom Detection Rules for Kubernetes

## How Falco Works

Falco's eBPF probe hooks into the Linux kernel's tracepoint infrastructure to observe every syscall made by every process on the node. The Falco rules engine evaluates these events against a ruleset in real time. The eBPF approach is preferable to the older kernel module approach for two reasons: eBPF is sandboxed and verified by the kernel (cannot crash the node), and it works on nodes where loading unsigned kernel modules is restricted.

A rule in Falco is a YAML object with:
- **condition**: a Boolean expression over syscall event fields
- **output**: a string template rendered when the condition matches
- **priority**: EMERGENCY, ALERT, CRITICAL, ERROR, WARNING, NOTICE, INFORMATIONAL, DEBUG

## Section 1: Installing Falco with eBPF

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

kubectl create namespace falco
```

```yaml
# falco-values.yaml
driver:
  enabled: true
  kind: ebpf    # Use eBPF instead of kernel module

# Collectors for Kubernetes metadata enrichment
collectors:
  enabled: true
  docker:
    enabled: false
  containerd:
    enabled: true
    socket: /run/containerd/containerd.sock
  cri:
    enabled: true
    socket: /run/containerd/containerd.sock

# Load custom rules from ConfigMaps
falcoctl:
  artifact:
    install:
      enabled: true
      refs:
        - falco-rules:3
        - falco-incubating-rules:3
        - falco-sandbox-rules:3
    follow:
      enabled: true
      refs:
        - falco-rules:3

# Custom rules from ConfigMap
customRules:
  acme-custom-rules.yaml: ""  # Populated from ConfigMap below

# falcosidekick for alerting
falcosidekick:
  enabled: true
  config:
    slack:
      webhookurl: "https://hooks.slack.com/services/T00/B00/XXXXX"
      channel: "#security-alerts"
      minimumpriority: warning
    pagerduty:
      routingKey: "your-pd-integration-key"
      minimumpriority: critical
    alertmanager:
      hostport: "http://alertmanager.monitoring.svc.cluster.local:9093"
      minimumpriority: warning
    loki:
      hostport: "http://loki-gateway.monitoring.svc.cluster.local"
      minimumpriority: debug
      customlabels: "app:falco,cluster:production"
    outputfieldformat: json
    metricserver:
      enabled: true

# Prometheus metrics
metrics:
  enabled: true
  serviceMonitor:
    enabled: true

resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 1000m
    memory: 1Gi

tolerations:
  - key: node-role.kubernetes.io/control-plane
    effect: NoSchedule
  - operator: Exists
    effect: NoSchedule
```

```bash
helm upgrade --install falco falcosecurity/falco \
  --namespace falco \
  --values falco-values.yaml \
  --wait \
  --timeout 10m

# Verify Falco is running
kubectl get pods -n falco
kubectl logs -n falco -l app.kubernetes.io/name=falco --tail=20
```

## Section 2: Rule Syntax Deep Dive

Falco's condition language operates on event fields. Every syscall event has fields like `proc.name`, `user.name`, `container.name`, `fd.name`, etc.

### Basic Rule Structure

```yaml
# Rules are organized by file. Load order matters — macros/lists must be defined before use.

# Lists — reusable sets of values
- list: acme_privileged_images
  items:
    - gcr.io/acme-corp/security-scanner
    - gcr.io/acme-corp/node-agent
    - quay.io/prometheus/node-exporter

- list: acme_safe_shells
  items: [bash, sh, dash, zsh, fish]

- list: acme_allowed_outbound_ports
  items: [80, 443, 8080, 8443, 9090]

# Macros — reusable condition fragments
- macro: container
  condition: container.id != host

- macro: interactive
  condition: >
    ((proc.aname=sshd and proc.name != sshd) or
    proc.name=bash or
    proc.name=sh)
    and proc.tty != 0

- macro: spawned_process
  condition: evt.type = execve and evt.dir = <

- macro: open_write
  condition: >
    (evt.type in (open, openat, openat2) and
     evt.is_open_write=true and
     fd.typechar='f' and
     fd.num>=0)

- macro: kubernetes_client_tool
  condition: >
    proc.name in (kubectl, helm, k9s, kubeadm) or
    proc.cmdline startswith "kubectl " or
    proc.cmdline startswith "helm "

- macro: acme_privileged_container
  condition: >
    container and
    container.image.repository in (acme_privileged_images)
```

### Detection Rules for Common Attack Patterns

```yaml
# Shell spawned inside container
- rule: Shell Spawned in Container
  desc: >
    A shell was spawned inside a container. This is unusual in production
    and may indicate an active intrusion or debugging session.
  condition: >
    spawned_process and
    container and
    not acme_privileged_container and
    proc.name in (acme_safe_shells) and
    not proc.pname in (containerd-shim, runc) and
    not (proc.pname = sudo and proc.name = bash) and
    not k8s.ns.name = "interactive-tools"
  output: >
    Shell spawned inside container
    (user=%user.name user_loginuid=%user.loginuid
     container_id=%container.id container_name=%container.name
     image=%container.image.repository:%container.image.tag
     shell=%proc.name parent=%proc.pname cmdline=%proc.cmdline
     ns=%k8s.ns.name pod=%k8s.pod.name)
  priority: WARNING
  tags: [container, shell, mitre_execution]

# Privilege escalation via setuid binary
- rule: Setuid Binary Executed in Container
  desc: >
    A setuid binary was executed inside a container. Attackers use
    setuid binaries to escalate privileges.
  condition: >
    spawned_process and
    container and
    proc.is_suid = true and
    not proc.name in (su, sudo) and
    not acme_privileged_container
  output: >
    Setuid binary executed
    (user=%user.name container=%container.name
     image=%container.image.repository
     binary=%proc.name cmdline=%proc.cmdline
     uid=%user.uid euid=%user.euid)
  priority: CRITICAL
  tags: [container, privilege_escalation, mitre_privilege_escalation]

# Write to sensitive host path
- rule: Write to Sensitive Host Path
  desc: >
    A file write was detected to a sensitive path on the host filesystem
    mounted into a container.
  condition: >
    open_write and
    container and
    (fd.name startswith /etc/passwd or
     fd.name startswith /etc/shadow or
     fd.name startswith /etc/sudoers or
     fd.name startswith /proc/sys or
     fd.name startswith /sys/kernel) and
    not acme_privileged_container
  output: >
    Write to sensitive host path
    (user=%user.name container=%container.name
     image=%container.image.repository
     path=%fd.name proc=%proc.name cmdline=%proc.cmdline)
  priority: CRITICAL
  tags: [container, filesystem, mitre_defense_evasion]

# Container namespace escape via nsenter
- rule: Namespace Escape via nsenter
  desc: >
    nsenter was executed, which can escape container namespaces and
    gain access to the host.
  condition: >
    spawned_process and
    proc.name = nsenter
  output: >
    nsenter executed - possible container escape attempt
    (user=%user.name container=%container.name
     cmdline=%proc.cmdline parent=%proc.pname
     pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: CRITICAL
  tags: [container, escape, mitre_defense_evasion]

# Unexpected network tool
- rule: Network Tool Executed in Container
  desc: >
    A network reconnaissance or exfiltration tool was executed
    inside a container.
  condition: >
    spawned_process and
    container and
    proc.name in (nmap, nc, netcat, ncat, nping,
                  tcpdump, wireshark, tshark,
                  curl, wget, ftp, sftp,
                  socat, iperf, hping3,
                  masscan, zmap)
  output: >
    Network tool executed in container
    (user=%user.name tool=%proc.name
     container=%container.name image=%container.image.repository
     cmdline=%proc.cmdline
     pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: WARNING
  tags: [container, network, mitre_discovery, mitre_collection]

# Cryptominer detection via CPU-intensive process patterns
- rule: Cryptominer Process Started
  desc: >
    A process commonly associated with cryptocurrency mining was started.
  condition: >
    spawned_process and
    (proc.name in (xmrig, minerd, cpuminer, cgminer,
                   ethminer, t-rex, gminer, nbminer,
                   claymore, phoenixminer) or
     proc.cmdline contains "stratum+tcp" or
     proc.cmdline contains "stratum+ssl" or
     proc.cmdline contains "--donate-level" or
     proc.cmdline contains "-o pool." or
     proc.cmdline contains "xmrig")
  output: >
    Cryptominer process detected
    (user=%user.name proc=%proc.name cmdline=%proc.cmdline
     container=%container.name image=%container.image.repository
     pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: CRITICAL
  tags: [container, cryptominer, mitre_impact]

# Kubernetes API server access from container
- rule: Kubernetes API Server Contacted from Container
  desc: >
    A container contacted the Kubernetes API server. Unless expected,
    this could indicate lateral movement or credential theft.
  condition: >
    evt.type = connect and
    container and
    fd.typechar = 4 and
    (fd.ip = k8s.api_server or
     fd.rport = 6443 or
     fd.rport = 8443) and
    not proc.name in (kubectl, helm, kube-proxy, cilium-agent) and
    not k8s.ns.name in (kube-system, monitoring, falco) and
    not acme_privileged_container
  output: >
    Container connected to Kubernetes API server
    (container=%container.name image=%container.image.repository
     proc=%proc.name cmdline=%proc.cmdline
     ip=%fd.rip port=%fd.rport
     pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: WARNING
  tags: [container, network, mitre_lateral_movement]

# File modified in read-only container filesystem
- rule: Write in Read-Only Container Filesystem
  desc: >
    A write was attempted in a container configured with a read-only
    root filesystem. This may indicate tampering or a misconfiguration.
  condition: >
    open_write and
    container and
    container.mount.dest[0] = "/" and
    not fd.name startswith /dev and
    not fd.name startswith /proc and
    not fd.name startswith /tmp and
    not fd.name startswith /var/run
  output: >
    Write in read-only container filesystem
    (user=%user.name container=%container.name
     path=%fd.name proc=%proc.name
     pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: ERROR
  tags: [container, filesystem, mitre_defense_evasion]

# Sensitive environment variable exposure
- rule: Sensitive Environment Variable Read
  desc: >
    A process attempted to read environment variables that may contain
    credentials or secrets. May indicate credential harvesting.
  condition: >
    open_read and
    container and
    fd.name in (/proc/1/environ, /proc/self/environ) and
    not proc.name in (ps, grep, env, printenv) and
    not acme_privileged_container
  output: >
    Sensitive environment read
    (user=%user.name container=%container.name proc=%proc.name
     cmdline=%proc.cmdline
     pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: WARNING
  tags: [container, credentials, mitre_credential_access]
```

## Section 3: Apply Rules via ConfigMap

```bash
# Apply custom rules
kubectl create configmap acme-falco-rules \
  --namespace falco \
  --from-file=acme-rules.yaml \
  --dry-run=client -o yaml | kubectl apply -f -

# Patch the DaemonSet to mount the ConfigMap
kubectl patch daemonset falco -n falco --type='json' -p='[
  {
    "op": "add",
    "path": "/spec/template/spec/volumes/-",
    "value": {
      "name": "acme-rules",
      "configMap": {"name": "acme-falco-rules"}
    }
  },
  {
    "op": "add",
    "path": "/spec/template/spec/containers/0/volumeMounts/-",
    "value": {
      "name": "acme-rules",
      "mountPath": "/etc/falco/acme-rules"
    }
  }
]'

# Reload Falco hot (no restart)
kubectl exec -n falco -it $(kubectl get pod -n falco -l app.kubernetes.io/name=falco -o name | head -1) \
  -- kill -1 1
```

## Section 4: Falco Talon — Automated Response

Falco Talon subscribes to Falco alerts and takes automated action when specific rules fire.

```bash
helm upgrade --install falco-talon falcosecurity/falco-talon \
  --namespace falco \
  --set config.watcherPort=2803 \
  --wait
```

```yaml
# talon-rules.yaml
- action: Terminate Cryptominer Pod
  actionner: kubernetes:terminate
  match:
    rules:
      - Cryptominer Process Started
    namespaces:
      except:
        - kube-system
        - falco
  parameters:
    grace_period_seconds: 0  # Immediate termination

- action: Cordon Node After Escape Attempt
  actionner: kubernetes:label
  match:
    rules:
      - Namespace Escape via nsenter
      - Write to Sensitive Host Path
  parameters:
    labels:
      quarantine: "true"
      quarantine-reason: "falco-escape-detection"
  # After labeling, a separate process should investigate

- action: Notify and Isolate Shell in Container
  actionner: kubernetes:networkpolicy
  match:
    rules:
      - Shell Spawned in Container
    priority:
      min: CRITICAL
  parameters:
    allow:
      # Keep only DNS and observability during investigation
      egress:
        - ports: ["53/UDP", "53/TCP", "9090/TCP"]
```

## Section 5: Testing Your Rules

```bash
#!/bin/bash
# test-falco-rules.sh — trigger specific Falco rules and verify alerts fire

echo "=== Test 1: Shell in Container ==="
kubectl run test-shell --image=alpine --restart=Never \
  --namespace=default \
  -- sh -c "echo 'testing shell spawn'; sleep 5"
sleep 3
kubectl delete pod test-shell --namespace=default

echo "Checking for Falco alert..."
kubectl logs -n falco -l app.kubernetes.io/name=falco --tail=20 | grep "Shell Spawned"

echo ""
echo "=== Test 2: Network Tool Execution ==="
kubectl run test-nettools --image=alpine --restart=Never \
  --namespace=default \
  -- sh -c "apk add --no-cache nmap 2>/dev/null; nmap -sn 10.0.0.0/24; sleep 2"
sleep 5
kubectl delete pod test-nettools --namespace=default

echo "Checking for Falco alert..."
kubectl logs -n falco -l app.kubernetes.io/name=falco --tail=20 | grep "Network tool"

echo ""
echo "=== Test 3: Write to /etc/passwd ==="
kubectl run test-write --image=ubuntu --restart=Never \
  --namespace=default \
  -- bash -c "echo 'attacker:x:0:0:root:/root:/bin/bash' >> /etc/passwd; sleep 2"
sleep 3
kubectl delete pod test-write --namespace=default

echo "Checking for Falco alert..."
kubectl logs -n falco -l app.kubernetes.io/name=falco --tail=20 | grep "Write to Sensitive"
```

## Section 6: Prometheus Metrics and Dashboard

```yaml
# PrometheusRule for Falco alert rates
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: falco-alert-rates
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: falco.security
      rules:
        - record: falco:alerts_rate
          expr: |
            sum by (rule, priority, namespace) (
              rate(falco_alerts_total[5m])
            )

        - alert: FalcoCriticalAlertRate
          expr: |
            sum by (rule) (rate(falco_alerts_total{priority="CRITICAL"}[1m])) > 0.1
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Falco CRITICAL rule '{{ $labels.rule }}' firing at {{ $value | humanize }} events/s"
            description: "A critical security rule is consistently firing. Immediate investigation required."

        - alert: FalcoNodeOffline
          expr: |
            count(kube_daemonset_status_number_ready{daemonset="falco", namespace="falco"}) <
            count(kube_node_info)
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Falco is not running on all nodes"
            description: "Some nodes may lack runtime security coverage."
```

## Section 7: Rule Tuning — Reducing False Positives

The default Falco rules generate noise in active development clusters. Here is a practical approach to tuning:

```yaml
# Exceptions using the append mechanism
# Append to existing rules without modifying the upstream rule file

# Silence the "Write below etc" rule for init containers that configure DNS
- rule: Write below etc
  exceptions:
    - name: known_init_containers
      fields: [proc.pname, fd.name]
      values:
        - [kube-dns, /etc/resolv.conf]
        - [cilium-agent, /etc/cni/net.d]
        - [node-local-dns, /etc/resolv.conf]

# Disable a noisy rule entirely for non-production namespaces
- rule: Redirect STDOUT/STDIN to Network Connection in Container
  condition: >
    evt.type = dup and
    container and
    not k8s.ns.label.environment in (production, staging)
  enabled: false

# Add exceptions to "Shell Spawned in Container" for legitimate uses
- rule: Shell Spawned in Container
  exceptions:
    - name: legitimate_debug_pods
      fields: [k8s.pod.label.debug]
      values:
        - ["true"]
    - name: ci_containers
      fields: [k8s.ns.name]
      values:
        - ["ci-runners"]
        - ["buildkit"]
```

## Conclusion

Falco's eBPF-based runtime security fills the gap that admission controllers and image scanning leave wide open: what actually happens at runtime. A carefully tuned ruleset, properly categorized against the MITRE ATT&CK framework, gives your security team actionable alerts rather than noise. The integration with falcosidekick routes alerts to the right channels, and Falco Talon closes the loop with automated response for high-confidence detections like cryptominers where waiting for a human is too slow. Start with the provided detection rules for your highest-risk workloads, measure false positive rates over two weeks, tune aggressively, then expand coverage incrementally.
