---
title: "Falco Custom Rules: Writing Detection Rules for Container Escape and Privilege Escalation"
date: 2029-03-06T00:00:00-05:00
draft: false
tags: ["Falco", "Security", "Kubernetes", "Container Security", "eBPF", "Threat Detection"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to writing Falco custom rules for detecting container escape techniques, privilege escalation attempts, and lateral movement patterns in Kubernetes clusters."
more_link: "yes"
url: "/falco-custom-rules-container-escape-privilege-escalation-deep-dive/"
---

Falco's built-in ruleset covers well-known attack patterns, but enterprise security teams routinely encounter detection gaps: application-specific privilege escalation paths, cloud metadata service access from container workloads, unusual kernel module loading, and supply-chain attacks that bypass signature-based detection. Writing effective custom Falco rules requires understanding the Falco condition language, the syscall event model, Falco's field extraction system, and the performance implications of kernel-level filtering. This post covers the complete ruleset authoring workflow for container escape and privilege escalation detection.

<!--more-->

## Falco Architecture and Rule Evaluation

Falco operates in two kernel-facing modes:

1. **Kernel module** (older): A traditional LKM that intercepts syscalls via tracepoints
2. **eBPF probe** (recommended): A BPF program attached to tracepoints, audited by the verifier

Both modes feed events to the Falco userspace engine, which evaluates rules against a stream of enriched syscall events. The enrichment layer adds container metadata (pod name, namespace, image), process metadata (comm, exe, args), and network metadata (saddr, daddr, port) to each event.

### Rule Structure

```yaml
- rule: Descriptive Rule Name
  desc: >
    What this rule detects and why it matters.
  condition: >
    <falco_condition_expression>
  output: >
    Alert message with field substitutions %proc.name %container.id %evt.time
  priority: CRITICAL|ERROR|WARNING|NOTICE|INFO|DEBUG
  tags: [container, filesystem, network, process, syscall]
  exceptions:
    - name: trusted_binaries
      fields: [proc.name, proc.pname]
      comps: [in, in]
      values:
        - [known_tool, expected_parent]
```

## Macros and Lists: Building Reusable Rule Components

### Establishing a Known-Good Baseline

```yaml
# custom-macros.yaml
# Containers that are intentionally privileged
- list: privileged_container_images
  items:
    - "falcosecurity/falco"
    - "prom/node-exporter"
    - "datadog/agent"
    - "us-docker.pkg.dev/k8s-artifacts-prod/images/pause"

# Known debugging tools that appear in incident response
- list: incident_response_tools
  items:
    - strace
    - ltrace
    - tcpdump
    - wireshark
    - tshark

# Namespaces excluded from all custom rules
- list: excluded_namespaces
  items:
    - kube-system
    - kube-public
    - monitoring
    - logging

# Sensitive host paths that containers should not read
- list: sensitive_host_paths
  items:
    - /etc/shadow
    - /etc/sudoers
    - /etc/sudoers.d
    - /root/.ssh
    - /proc/sysrq-trigger
    - /proc/kcore
    - /sys/kernel/debug

- macro: container
  condition: (container.id != host)

- macro: interactive
  condition: >
    ((proc.aname[2] = "sshd" or proc.aname[3] = "sshd" or proc.aname[4] = "sshd") and
     proc.name != "sshd")

- macro: kubernetes_pod
  condition: >
    container.id != host and k8s.pod.name != ""

- macro: excluded_namespace
  condition: >
    k8s.ns.name in (excluded_namespaces)

- macro: privileged_container
  condition: >
    container.privileged = true or
    (container.image.repository in (privileged_container_images))
```

## Container Escape Detection Rules

### Detecting nsenter and Namespace Escape Attempts

```yaml
# nsenter allows a process to enter the namespaces of another process.
# In containers, this is used to escape to the host namespace.
- rule: Container Namespace Escape via nsenter
  desc: >
    Detects execution of nsenter inside a container, which can be used to enter
    the host's PID, network, mount, or IPC namespaces, effectively escaping
    the container boundary.
  condition: >
    spawned_process and
    container and
    not excluded_namespace and
    proc.name = "nsenter"
  output: >
    Namespace escape attempt via nsenter (user=%user.name user_uid=%user.uid
    command=%proc.cmdline pid=%proc.pid container=%container.id
    image=%container.image.repository:%container.image.tag
    pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: CRITICAL
  tags: [container, escape, process, T1611]

# Detecting /proc/<pid>/ns access from within containers
- rule: Container Reading Host Process Namespace Files
  desc: >
    A process in a container is reading namespace files from /proc on other processes.
    This is a common technique to identify host PIDs for namespace joining.
  condition: >
    open_read and
    container and
    not excluded_namespace and
    fd.name glob "/proc/*/ns/*" and
    not proc.name in (incident_response_tools)
  output: >
    Container process reading host namespace files (user=%user.name
    command=%proc.cmdline file=%fd.name container=%container.id
    image=%container.image.repository pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: WARNING
  tags: [container, escape, filesystem, T1611]
```

### Detecting cgroup Escape (CVE-2022-0492 Pattern)

```yaml
- rule: Container cgroup Release Agent Write
  desc: >
    Detects writes to cgroup release_agent files from within containers.
    This is the technique used in CVE-2022-0492 to escape container boundaries
    by executing arbitrary commands in the host's context.
  condition: >
    open_write and
    container and
    not excluded_namespace and
    fd.name glob "/sys/fs/cgroup/*/release_agent" and
    not privileged_container
  output: >
    Potential cgroup release_agent escape attempt (user=%user.name
    command=%proc.cmdline file=%fd.name container=%container.id
    image=%container.image.repository pod=%k8s.pod.name ns=%k8s.ns.name
    parent=%proc.pname)
  priority: CRITICAL
  tags: [container, escape, filesystem, CVE-2022-0492, T1611]

# runc/containerd escape via /proc/self/exe
- rule: Container Symlink Attack on Runtime Binary
  desc: >
    Detects creation of symbolic links to runtime binaries (/runc, /containerd-shim).
    CVE-2019-5736 exploited this pattern to overwrite the runc binary during container
    start by symlinking /proc/self/exe to the runc binary.
  condition: >
    syscall.type = symlink and
    container and
    not excluded_namespace and
    (evt.arg.target glob "*/runc*" or
     evt.arg.target glob "*/containerd-shim*" or
     evt.arg.target glob "/proc/self/exe")
  output: >
    Possible runtime binary symlink attack (user=%user.name
    command=%proc.cmdline target=%evt.arg.target linkpath=%evt.arg.linkpath
    container=%container.id image=%container.image.repository
    pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: CRITICAL
  tags: [container, escape, CVE-2019-5736, T1574]
```

## Privilege Escalation Detection

### setuid/setgid Binary Execution

```yaml
- list: allowed_setuid_binaries
  items:
    - sudo
    - su
    - newgrp
    - passwd
    - ping

- rule: Setuid Binary Executed in Container
  desc: >
    A setuid binary was executed inside a container. Setuid binaries run with
    the file owner's privileges regardless of who executes them. In containers,
    this typically indicates privilege escalation attempts or misconfigured images.
  condition: >
    spawned_process and
    container and
    not excluded_namespace and
    proc.is_suid_exe = true and
    not proc.name in (allowed_setuid_binaries) and
    not privileged_container
  output: >
    Setuid binary executed in container (user=%user.name user_uid=%user.uid
    command=%proc.cmdline exe=%proc.exe container=%container.id
    image=%container.image.repository pod=%k8s.pod.name ns=%k8s.ns.name
    parent=%proc.pname parent_uid=%proc.puid)
  priority: ERROR
  tags: [process, privilege_escalation, T1548.001]
```

### Capability Manipulation Detection

```yaml
- rule: Container Process Gaining Capabilities via setcap
  desc: >
    Detects execution of setcap inside a container. Applications using setcap
    to grant capabilities to binaries is a sign of privilege escalation or
    an attempt to maintain elevated access beyond the container runtime grant.
  condition: >
    spawned_process and
    container and
    not excluded_namespace and
    proc.name = "setcap"
  output: >
    setcap executed in container (user=%user.name command=%proc.cmdline
    container=%container.id image=%container.image.repository
    pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: ERROR
  tags: [process, privilege_escalation, T1548]

# CAP_SYS_ADMIN is nearly equivalent to root. Detect processes using it.
- rule: Process Using CAP_SYS_ADMIN in Unexpected Container
  desc: >
    A process is using a syscall that requires CAP_SYS_ADMIN (mount, unshare,
    clone with CLONE_NEWUSER). This capability provides near-root privileges and
    should not be available in standard application containers.
  condition: >
    container and
    not excluded_namespace and
    not privileged_container and
    (evt.type = mount or
     (evt.type = clone and evt.arg.flags contains CLONE_NEWUSER) or
     (evt.type = unshare and evt.arg.flags contains CLONE_NEWUSER))
  output: >
    CAP_SYS_ADMIN usage in unprivileged container (user=%user.name
    syscall=%evt.type args=%evt.args container=%container.id
    image=%container.image.repository pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: CRITICAL
  tags: [container, privilege_escalation, T1611]
```

### Detecting SUID/SGID Binary Creation

```yaml
- rule: SUID/SGID Binary Written in Container
  desc: >
    A file with setuid or setgid bits is being written inside a container.
    Attackers use this technique to create persistent privilege escalation paths
    that survive container process boundaries.
  condition: >
    open_write and
    container and
    not excluded_namespace and
    (evt.arg.flags contains O_CREAT) and
    (fd.name glob "/tmp/*" or fd.name glob "/var/*" or fd.name glob "/dev/shm/*") and
    (evt.arg.mode & 04000 > 0 or evt.arg.mode & 02000 > 0)
  output: >
    SUID/SGID binary created in container (user=%user.name
    command=%proc.cmdline file=%fd.name mode=%evt.arg.mode
    container=%container.id image=%container.image.repository
    pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: CRITICAL
  tags: [filesystem, privilege_escalation, T1548.001]
```

## Cloud Metadata Service Access

```yaml
# IMDSv1 is accessible without authentication — critical to detect
- rule: Cloud Metadata Service Access from Container
  desc: >
    A container process is accessing the cloud instance metadata service (IMDS).
    In AWS, this exposes IAM role credentials. In GCP, it exposes service account
    tokens. Unless the application explicitly requires cloud API access, this is
    a strong indicator of credential theft or SSRF exploitation.
  condition: >
    (evt.type = connect or evt.type = sendto) and
    container and
    not excluded_namespace and
    fd.sip in ("169.254.169.254", "fd00:ec2::254", "metadata.google.internal") and
    not k8s.pod.labels["iam.amazonaws.com/role"] exists and
    not k8s.pod.annotations["iam.amazonaws.com/role"] exists
  output: >
    Cloud metadata service access from container (user=%user.name
    command=%proc.cmdline destination=%fd.sip container=%container.id
    image=%container.image.repository pod=%k8s.pod.name ns=%k8s.ns.name
    parent=%proc.pname)
  priority: CRITICAL
  tags: [network, credential_access, T1552.005]
```

## Kernel Module and eBPF Program Loading

```yaml
- rule: Kernel Module Loaded from Container
  desc: >
    A kernel module is being loaded from within a container. This is an effective
    container escape technique since kernel modules execute at ring 0. Legitimate
    containers should never load kernel modules.
  condition: >
    evt.type = finit_module and
    container and
    not excluded_namespace
  output: >
    Kernel module loaded from container (user=%user.name
    command=%proc.cmdline module=%evt.arg.fd container=%container.id
    image=%container.image.repository pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: CRITICAL
  tags: [container, escape, T1547.006]

- rule: Unexpected eBPF Program Loaded
  desc: >
    An eBPF program is being loaded outside of known monitoring agents.
    Attackers use eBPF rootkits to intercept syscalls, hide processes, and
    exfiltrate data at the kernel level. Only approved monitoring tools
    should load eBPF programs.
  condition: >
    evt.type = bpf and
    evt.arg.cmd = BPF_PROG_LOAD and
    not proc.name in (falco, node-exporter, cilium-agent, datadog-agent, tetragon)
  output: >
    Unexpected eBPF program loaded (user=%user.name
    command=%proc.cmdline prog_type=%evt.arg.prog_type
    container=%container.id image=%container.image.repository
    pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: CRITICAL
  tags: [process, escape, T1014]
```

## Lateral Movement Detection

```yaml
# SSH key exfiltration
- rule: SSH Private Key Read from Container
  desc: >
    A container process is reading SSH private key files. This is commonly
    performed during lateral movement to access other systems using stolen
    credentials.
  condition: >
    open_read and
    container and
    not excluded_namespace and
    (fd.name glob "*/id_rsa" or
     fd.name glob "*/id_ed25519" or
     fd.name glob "*/id_ecdsa" or
     fd.name glob "*/.ssh/authorized_keys") and
    not proc.name in (sshd, ssh, sftp, rsync)
  output: >
    SSH private key accessed from container (user=%user.name
    command=%proc.cmdline file=%fd.name container=%container.id
    image=%container.image.repository pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: ERROR
  tags: [filesystem, credential_access, T1552.004]

# Kubernetes service account token access
- rule: Kubernetes Service Account Token Read Outside Startup
  desc: >
    A process is reading the Kubernetes service account token after initial
    container startup. While pods legitimately read this token at startup for
    API server authentication, reading it repeatedly or from unexpected processes
    can indicate token theft for lateral movement within the cluster.
  condition: >
    open_read and
    container and
    not excluded_namespace and
    fd.name glob "/run/secrets/kubernetes.io/serviceaccount/*" and
    proc.name != "kubelet" and
    not proc.name in (java, python3, python, node, ruby, go) and
    container.start_ts > 30000000000  # 30 seconds after container start
  output: >
    Service account token read in running container (user=%user.name
    command=%proc.cmdline file=%fd.name container=%container.id
    image=%container.image.repository pod=%k8s.pod.name ns=%k8s.ns.name
    age_ns=%container.start_ts)
  priority: WARNING
  tags: [filesystem, credential_access, lateral_movement, T1528]
```

## Rule Performance Optimization

Rules that match frequently but rarely trigger alerts waste CPU cycles. Use `priority: DEBUG` with exception lists to tune expensive rules:

```bash
# Test rule performance with falco-driver-loader
falco -L  # List all loaded rules

# Profile rule evaluation cost
falco --stats-interval=5 2>&1 | grep -E "syscall_drops|rule_eval"

# Simulate rules against captured events without kernel driver
falco -e /var/log/audit/audit.log -r /etc/falco/custom_rules.yaml

# Validate rule syntax without running
falco --validate /etc/falco/custom_rules.yaml
```

## Deploying Custom Rules in Kubernetes

```yaml
# custom-falco-rules-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: falco-custom-rules
  namespace: falco
data:
  custom-rules.yaml: |
    # Include all rules from the deep-dive above
    # (content truncated for brevity in this snippet)
    - rule: Container Namespace Escape via nsenter
      desc: Detects nsenter execution inside containers
      condition: >
        spawned_process and container and not excluded_namespace and
        proc.name = "nsenter"
      output: >
        Namespace escape via nsenter (pod=%k8s.pod.name ns=%k8s.ns.name
        image=%container.image.repository command=%proc.cmdline)
      priority: CRITICAL
      tags: [escape, T1611]
```

```yaml
# falco-values.yaml for Helm deployment
falco:
  rules_file:
    - /etc/falco/falco_rules.yaml
    - /etc/falco/falco_rules.local.yaml
    - /etc/falco/custom_rules.yaml

  extraVolumes:
    - name: custom-rules
      configMap:
        name: falco-custom-rules

  extraVolumeMounts:
    - name: custom-rules
      mountPath: /etc/falco/custom_rules.yaml
      subPath: custom-rules.yaml

  json_output: true
  json_include_output_property: true

  grpc:
    enabled: true
    bind_address: "unix:///run/falco/falco.sock"
    threadiness: 4

  grpc_output:
    enabled: true

falcosidekick:
  enabled: true
  config:
    slack:
      webhookurl: "https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>"
      minimumpriority: "warning"
    pagerduty:
      routingkey: "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
      minimumpriority: "critical"
    elasticsearch:
      hostport: "https://elasticsearch.logging.svc.cluster.local:9200"
      index: falco-alerts
      minimumpriority: "notice"
```

## Testing Custom Rules

```bash
#!/bin/bash
# test-falco-rules.sh — smoke test custom rules
set -euo pipefail

echo "=== Testing Namespace Escape Rule ==="
# This should trigger the nsenter rule
kubectl run test-escape --rm -it --image=ubuntu:22.04 \
  --restart=Never -- \
  bash -c "apt-get install -yq util-linux 2>/dev/null; nsenter --help; echo DONE"

echo "=== Testing Metadata Service Rule ==="
# This should trigger the metadata service access rule
kubectl run test-metadata --rm -it --image=curlimages/curl:8.5.0 \
  --restart=Never -- \
  curl --max-time 2 -s http://169.254.169.254/latest/meta-data/ || true

echo "=== Checking Falco alerts ==="
kubectl logs -n falco -l app=falco --since=2m | \
  python3 -c "
import sys, json
for line in sys.stdin:
    try:
        alert = json.loads(line)
        if alert.get('priority') in ['CRITICAL', 'ERROR', 'WARNING']:
            print(f\"[{alert['priority']}] {alert['rule']}: {alert['output']}\")
    except:
        pass
"
```

## Summary

Effective Falco rules share three characteristics:

1. **Precision**: Conditions are narrow enough to avoid flooding with false positives. Macro hierarchies (`container`, `excluded_namespace`, `privileged_container`) pre-filter events before the rule condition is evaluated.
2. **Context**: Output fields include enough metadata (pod, namespace, image, command, user) for incident responders to assess severity and act without additional investigation.
3. **MITRE ATT&CK mapping**: Tags reference technique IDs, enabling correlation with threat intelligence platforms and automated triage workflows.

The rules in this post cover the most commonly exploited container escape vectors (namespace joining, cgroup release_agent, runtime binary symlinks), privilege escalation techniques (setuid execution, capability manipulation), and lateral movement patterns (metadata service access, SSH key theft, service account token access).
