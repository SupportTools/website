---
title: "Kubernetes Falco v0.38: Custom Rules, gRPC Output, Audit Events, and Sidekick Alerting Integrations"
date: 2031-12-15T00:00:00-05:00
draft: false
tags: ["Falco", "Kubernetes", "Security", "eBPF", "Runtime Security", "SIEM", "Sidekick", "Audit Logging"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Falco v0.38 covering custom rule authoring, gRPC output plugins, Kubernetes audit event integration, and Falcosidekick alerting pipelines for production security monitoring."
more_link: "yes"
url: "/kubernetes-falco-v038-custom-rules-grpc-audit-sidekick-enterprise-guide/"
---

Falco v0.38 represents a substantial leap in cloud-native runtime security, introducing a modernized plugin architecture, improved gRPC output stability, native Kubernetes audit event ingestion through the k8saudit plugin, and a richer rule language that enables more precise behavioral detection. For enterprise security teams running Kubernetes at scale, mastering these capabilities is the difference between a security tool that generates noise and one that provides actionable, high-fidelity signals.

This guide walks through every major capability introduced or refined in Falco v0.38, providing production-ready configurations, custom rule patterns, and a complete Falcosidekick alerting pipeline that integrates with PagerDuty, Slack, and a SIEM.

<!--more-->

# Kubernetes Falco v0.38: Custom Rules, gRPC Output, Audit Events, and Sidekick Alerting

## Section 1: Falco Architecture in v0.38

Falco operates as a runtime security engine that intercepts system calls and cloud-native event streams to detect anomalous behavior. The v0.38 architecture consists of four major subsystems.

### 1.1 Event Sources

Falco v0.38 supports multiple event sources simultaneously through its plugin framework:

- **Syscall source** — intercepts kernel system calls via eBPF (preferred), the classic kernel module, or ptrace (deprecated)
- **k8saudit plugin** — consumes Kubernetes audit log events from a webhook receiver
- **cloudtrail plugin** — ingests AWS CloudTrail events for cloud-level detection
- **okta / github plugins** — SaaS identity and SCM event streams

Each plugin registers its own event types, fields, and condition extractors. Rules declare which source they apply to using the `source` field.

### 1.2 The Falco Rules Engine

The rules engine evaluates a three-level hierarchy:

```
Lists → Macros → Rules
```

Lists are reusable sets of values. Macros are reusable condition fragments. Rules combine a condition with metadata and an output template. This hierarchy avoids duplication and enables community-maintained rule sets to be safely overridden at the list or macro level.

### 1.3 Deployment Models

For Kubernetes production environments, Falco is deployed as a DaemonSet to ensure every node is covered. The Helm chart provided by the Falco project supports:

- eBPF driver (preferred for kernel >= 4.14)
- Kernel module driver (requires privileged container)
- userspace instrumentation via Falco libs

```yaml
# values.yaml excerpt
driver:
  kind: ebpf
  ebpf:
    path: "${HOME}/.falco/falco-bpf.o"
    buffering: true

collectors:
  enabled: true
  docker:
    enabled: true
  containerd:
    enabled: true
    socket: /run/containerd/containerd.sock
  crio:
    enabled: true
    socket: /run/crio/crio.sock
```

## Section 2: Installing Falco v0.38 via Helm

### 2.1 Helm Repository Setup

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update
```

### 2.2 Production Helm Values

Create a comprehensive values file for your cluster:

```yaml
# falco-values.yaml
image:
  registry: docker.io
  repository: falcosecurity/falco-no-driver
  tag: "0.38.0"
  pullPolicy: IfNotPresent

driver:
  enabled: true
  kind: ebpf
  loader:
    enabled: true
    initContainer:
      image:
        registry: docker.io
        repository: falcosecurity/falco-driver-loader
        tag: "0.38.0"

falco:
  grpc:
    enabled: true
    bind_address: "unix:///run/falco/falco.sock"
    threadiness: 8

  grpc_output:
    enabled: true

  json_output: true
  json_include_output_property: true
  json_include_tags_property: true

  log_stderr: true
  log_syslog: false
  log_level: info

  priority: debug

  buffered_outputs: false

  syscall_event_drops:
    actions:
      - log
      - alert
    rate: 0.03333
    max_burst: 10

  output_timeout: 2000

  outputs:
    - rate: 100
      max_burst: 1000

  rules_file:
    - /etc/falco/falco_rules.yaml
    - /etc/falco/falco_rules.local.yaml
    - /etc/falco/rules.d

  plugins:
    - name: k8saudit
      library_path: libk8saudit.so
      init_config:
        maxEventSize: 262144
        webhookMaxBatchSize: 12582912
        sslCertificate: /etc/falco/falco.pem
      open_params: "http://:9765/k8s-audit"
    - name: json
      library_path: libjson.so
      init_config: ""

  load_plugins:
    - k8saudit
    - json

resources:
  requests:
    cpu: 100m
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 1024Mi

tolerations:
  - effect: NoSchedule
    key: node-role.kubernetes.io/control-plane
  - effect: NoSchedule
    key: node-role.kubernetes.io/master

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8765"
  prometheus.io/path: "/metrics"

serviceAccount:
  create: true
  name: falco

rbac:
  create: true

falcoctl:
  artifact:
    install:
      enabled: true
    follow:
      enabled: true
  config:
    artifact:
      allowedTypes:
        - rulesfile
        - plugin
      install:
        refs:
          - falco-rules:3
          - k8saudit-rules:0.7
      follow:
        refs:
          - falco-rules:3
          - k8saudit-rules:0.7
```

### 2.3 Install

```bash
kubectl create namespace falco

helm install falco falcosecurity/falco \
  --namespace falco \
  --values falco-values.yaml \
  --version 4.3.0 \
  --wait \
  --timeout 10m
```

### 2.4 Verify Installation

```bash
# Check pods are running on all nodes
kubectl get pods -n falco -o wide

# Check driver loader completed
kubectl logs -n falco -l app.kubernetes.io/name=falco -c falco-driver-loader --tail=20

# Verify Falco is receiving events
kubectl logs -n falco -l app.kubernetes.io/name=falco -c falco --tail=50 | grep -i "rule\|output"

# Test with a known trigger
kubectl run test-shell --image=ubuntu --restart=Never --rm -it -- sh -c "cat /etc/shadow"
```

## Section 3: Custom Rule Authoring

### 3.1 Rule Structure

A complete Falco rule has the following structure:

```yaml
- rule: Descriptive Rule Name
  desc: >
    What this rule detects and why it is security-relevant.
  condition: >
    syscall.type = execve and
    proc.name in (sensitive_binaries) and
    not proc.pname in (allowed_parents)
  output: >
    Sensitive binary executed (user=%user.name uid=%user.uid
    command=%proc.cmdline parent=%proc.pname container=%container.name
    image=%container.image.repository:%container.image.tag
    k8s_ns=%k8s.ns.name k8s_pod=%k8s.pod.name)
  priority: WARNING
  source: syscall
  tags: [process, security, custom]
  exceptions:
    - name: known_processes
      fields: [proc.name, proc.pname]
      comps: [in, in]
      values:
        - [apt-get, dpkg]
        - [yum, rpm]
```

### 3.2 Building a Custom Rules Library

Create a structured custom rules file:

```yaml
# /etc/falco/rules.d/custom-enterprise-rules.yaml

#######################################################################
# LISTS
#######################################################################

- list: enterprise_sensitive_files
  items:
    - /etc/shadow
    - /etc/passwd
    - /root/.ssh/authorized_keys
    - /root/.ssh/id_rsa
    - /etc/kubernetes/pki/ca.key
    - /var/lib/etcd

- list: enterprise_privileged_binaries
  items:
    - nsenter
    - unshare
    - capsh
    - setuid
    - setcap

- list: enterprise_crypto_binaries
  items:
    - openssl
    - gpg
    - gpg2
    - ssh-keygen

- list: enterprise_network_tools
  items:
    - ncat
    - nmap
    - masscan
    - hping3
    - tcpdump
    - wireshark

- list: trusted_image_registries
  items:
    - registry.example.com
    - 123456789012.dkr.ecr.us-east-1.amazonaws.com
    - gcr.io/enterprise-project

- list: ci_service_accounts
  items:
    - system:serviceaccount:ci:jenkins
    - system:serviceaccount:ci:gitlab-runner
    - system:serviceaccount:argocd:argocd-application-controller

#######################################################################
# MACROS
#######################################################################

- macro: enterprise_sensitive_read
  condition: >
    open_read and
    (fd.name in (enterprise_sensitive_files) or
     fd.directory in (/etc/kubernetes/pki, /root/.ssh, /home/%/.ssh))

- macro: spawned_in_container
  condition: container.id != host

- macro: not_privileged_pod
  condition: not container.privileged=true

- macro: business_hours
  condition: >
    (evt.time.hour >= 8 and evt.time.hour <= 18 and
     evt.time.wday >= 1 and evt.time.wday <= 5)

- macro: untrusted_registry
  condition: >
    container.image.repository != "" and
    not (container.image.repository startswith "registry.example.com/" or
         container.image.repository startswith "123456789012.dkr.ecr.us-east-1.amazonaws.com/" or
         container.image.repository startswith "gcr.io/enterprise-project/")

#######################################################################
# RULES
#######################################################################

- rule: Enterprise - Sensitive Credential File Read
  desc: >
    Detects attempts to read sensitive credential or PKI files.
    These files should never be accessed by application workloads
    and access outside of known system processes is suspicious.
  condition: >
    enterprise_sensitive_read and
    spawned_in_container and
    not proc.name in (enterprise_crypto_binaries) and
    not (proc.name = "falco" and fd.name startswith "/etc/falco")
  output: >
    Sensitive credential file read in container
    (file=%fd.name user=%user.name uid=%user.uid
    command=%proc.cmdline parent=%proc.pname
    container_id=%container.id container_name=%container.name
    image=%container.image.repository:%container.image.tag
    k8s_ns=%k8s.ns.name k8s_pod=%k8s.pod.name
    k8s_deployment=%k8s.deployment.name)
  priority: CRITICAL
  source: syscall
  tags: [credential-access, container, enterprise, T1552]

- rule: Enterprise - Container Using Untrusted Registry
  desc: >
    A container is running an image from an untrusted registry.
    All production container images must originate from approved
    internal registries with validated image signatures.
  condition: >
    container.id != "" and
    container.id != host and
    container is not null and
    untrusted_registry and
    evt.type = container
  output: >
    Container started from untrusted registry
    (image=%container.image.repository:%container.image.tag
    container_id=%container.id container_name=%container.name
    k8s_ns=%k8s.ns.name k8s_pod=%k8s.pod.name
    k8s_deployment=%k8s.deployment.name)
  priority: ERROR
  source: syscall
  tags: [supply-chain, container, enterprise, T1610]

- rule: Enterprise - Privileged Container Network Tool Execution
  desc: >
    Network reconnaissance tools executed inside a container.
    These tools are not present in production images and their
    presence indicates a compromised container or insider threat.
  condition: >
    spawned_process and
    spawned_in_container and
    proc.name in (enterprise_network_tools)
  output: >
    Network tool executed in container
    (tool=%proc.name args=%proc.args user=%user.name uid=%user.uid
    container_id=%container.id container_name=%container.name
    image=%container.image.repository:%container.image.tag
    k8s_ns=%k8s.ns.name k8s_pod=%k8s.pod.name)
  priority: WARNING
  source: syscall
  tags: [discovery, network, container, enterprise, T1046]

- rule: Enterprise - etcd Data Directory Access
  desc: >
    Direct access to the etcd data directory outside of the etcd
    process is a strong indicator of data exfiltration or tampering
    with cluster state.
  condition: >
    open_read and
    fd.name startswith "/var/lib/etcd" and
    not proc.name = "etcd" and
    not proc.name in (backup_tools)
  output: >
    etcd data directory accessed by non-etcd process
    (file=%fd.name proc=%proc.name pid=%proc.pid
    user=%user.name uid=%user.uid
    container_id=%container.id)
  priority: CRITICAL
  source: syscall
  tags: [credential-access, persistence, kubernetes, enterprise, T1552.007]

- rule: Enterprise - Outbound Connection to Non-Approved CIDR
  desc: >
    A container process is establishing a connection to an external
    IP that falls outside approved network ranges. This may indicate
    C2 communication or data exfiltration.
  condition: >
    outbound and
    spawned_in_container and
    not fd.sip in (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and
    not fd.sip in (approved_external_ips) and
    not proc.name in (approved_external_processes)
  output: >
    Outbound connection to unapproved external IP
    (proc=%proc.name cmd=%proc.cmdline
    src_ip=%fd.cip src_port=%fd.cport
    dst_ip=%fd.sip dst_port=%fd.sport
    container_id=%container.id container_name=%container.name
    image=%container.image.repository:%container.image.tag
    k8s_ns=%k8s.ns.name k8s_pod=%k8s.pod.name)
  priority: WARNING
  source: syscall
  tags: [exfiltration, command-and-control, enterprise, T1041]

- rule: Enterprise - Crypto Mining Process Detected
  desc: >
    Common cryptocurrency mining binaries or patterns detected.
    Mining processes consume significant CPU and represent a
    resource theft attack vector.
  condition: >
    spawned_process and
    (proc.name in (xmrig, minergate, cpuminer, ethminer, bfgminer) or
     proc.cmdline contains "--donate-level" or
     proc.cmdline contains "stratum+tcp://" or
     proc.cmdline contains "pool.minexmr.com" or
     proc.cmdline contains "xmrpool.eu")
  output: >
    Cryptocurrency mining process detected
    (proc=%proc.name cmd=%proc.cmdline pid=%proc.pid
    user=%user.name uid=%user.uid
    container_id=%container.id container_name=%container.name
    image=%container.image.repository:%container.image.tag
    k8s_ns=%k8s.ns.name k8s_pod=%k8s.pod.name)
  priority: CRITICAL
  source: syscall
  tags: [impact, crypto-mining, enterprise, T1496]
```

### 3.3 Exception-Based Rule Refinement

Falco v0.38 provides the `exceptions` mechanism to reduce false positives without forking rules:

```yaml
# Override exceptions for the built-in "Write below binary dir" rule
- rule: Write below binary dir
  exceptions:
    - name: java_jvm_temp
      fields: [proc.name, fd.directory]
      comps: [in, in]
      values:
        - [java, /usr/lib/jvm]
    - name: nodejs_npm_install
      fields: [proc.name, fd.name]
      comps: [=, startswith]
      values:
        - [npm, /usr/local/lib/node_modules]
    - name: golang_build
      fields: [proc.name, fd.directory]
      comps: [=, startswith]
      values:
        - [go, /usr/local/go]
```

### 3.4 Rule Testing with falco-testing

```bash
# Install falco-testing framework
pip install falco-testing

# Write a unit test for a custom rule
cat > test_enterprise_rules.py << 'EOF'
from falco_testing import FalcoTestRunner

runner = FalcoTestRunner(
    rules_file="custom-enterprise-rules.yaml",
    base_rules=["falco_rules.yaml"]
)

def test_sensitive_file_read_triggers():
    result = runner.run_trace("traces/sensitive-file-read.scap")
    assert result.has_alert("Enterprise - Sensitive Credential File Read")
    assert result.alert_count("Enterprise - Sensitive Credential File Read") >= 1

def test_approved_registry_no_trigger():
    result = runner.run_trace("traces/approved-registry-container.scap")
    assert not result.has_alert("Enterprise - Container Using Untrusted Registry")

def test_mining_detection():
    result = runner.run_trace("traces/xmrig-execution.scap")
    alert = result.get_alert("Enterprise - Crypto Mining Process Detected")
    assert alert is not None
    assert alert.priority == "CRITICAL"
EOF

python -m pytest test_enterprise_rules.py -v
```

## Section 4: gRPC Output Configuration

### 4.1 gRPC Unix Socket Output

Falco v0.38 exposes a stable gRPC API over a Unix domain socket, preferred over TCP for co-located consumers:

```yaml
# falco.yaml gRPC section
grpc:
  enabled: true
  bind_address: "unix:///run/falco/falco.sock"
  threadiness: 4

grpc_output:
  enabled: true
```

### 4.2 Writing a gRPC Consumer in Go

```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"

    // Import generated Falco gRPC client code
    // go get github.com/falcosecurity/client-go
    falcov1 "github.com/falcosecurity/client-go/pkg/api/output/v1"
    outputs "github.com/falcosecurity/client-go/pkg/client"
)

func main() {
    // Connect via Unix socket
    conn, err := grpc.Dial(
        "unix:///run/falco/falco.sock",
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
        grpc.WithTimeout(10*time.Second),
    )
    if err != nil {
        log.Fatalf("failed to connect to Falco gRPC: %v", err)
    }
    defer conn.Close()

    client := outputs.NewServiceClient(conn)

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Subscribe to all output events
    stream, err := client.Subscribe(ctx, &falcov1.Request{})
    if err != nil {
        log.Fatalf("failed to subscribe: %v", err)
    }

    log.Println("Connected to Falco gRPC output stream")

    for {
        response, err := stream.Recv()
        if err != nil {
            log.Printf("stream error: %v", err)
            return
        }

        // Process the event
        event := response.GetResponse()
        if event == nil {
            continue
        }

        fmt.Printf("[%s] Priority=%s Rule=%s\n",
            event.GetTime().AsTime().Format(time.RFC3339),
            event.GetPriority().String(),
            event.GetRule(),
        )
        fmt.Printf("  Output: %s\n", event.GetOutput())
        fmt.Printf("  Fields: %v\n", event.GetOutputFields())
        fmt.Println()

        // Route critical events to incident management
        if event.GetPriority() >= falcov1.Priority_PRIORITY_CRITICAL {
            handleCriticalEvent(event)
        }
    }
}

func handleCriticalEvent(event *falcov1.Response) {
    // Implement your SIEM/incident routing logic here
    log.Printf("CRITICAL EVENT - Rule: %s, Output: %s",
        event.GetRule(), event.GetOutput())
}
```

### 4.3 gRPC Version Service

```go
// Query Falco version via gRPC
import versionv1 "github.com/falcosecurity/client-go/pkg/api/version/v1"

func queryFalcoVersion(conn *grpc.ClientConn) {
    versionClient := versionv1.NewServiceClient(conn)
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    resp, err := versionClient.Version(ctx, &versionv1.Request{})
    if err != nil {
        log.Printf("version query failed: %v", err)
        return
    }

    log.Printf("Falco version: %s (API: %d.%d.%d)",
        resp.GetVersion(),
        resp.GetEngineVersionMajor(),
        resp.GetEngineVersionMinor(),
        resp.GetEngineVersionPatch(),
    )
}
```

## Section 5: Kubernetes Audit Event Integration

### 5.1 Configuring the Kubernetes API Server Webhook

The k8saudit plugin receives audit events via an HTTP webhook. Configure the API server:

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
  - RequestReceived
rules:
  # Log all exec and attach requests with full body
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["pods/exec", "pods/attach", "pods/portforward"]

  # Log secret access at metadata level
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Log RBAC changes at request response level
  - level: RequestResponse
    resources:
      - group: "rbac.authorization.k8s.io"
        resources:
          - clusterroles
          - clusterrolebindings
          - roles
          - rolebindings

  # Log workload changes
  - level: Request
    resources:
      - group: apps
        resources:
          - deployments
          - daemonsets
          - statefulsets
          - replicasets
      - group: ""
        resources: ["pods"]
    verbs: ["create", "update", "patch", "delete"]

  # Log namespace creation/deletion
  - level: Request
    resources:
      - group: ""
        resources: ["namespaces"]
    verbs: ["create", "delete"]

  # Skip high-volume noisy requests
  - level: None
    users: ["system:kube-proxy"]
    verbs: ["watch"]
    resources:
      - group: ""
        resources: ["endpoints", "services", "services/status"]

  - level: None
    userGroups: ["system:nodes"]
    verbs: ["get"]
    resources:
      - group: ""
        resources: ["nodes", "nodes/status"]

  # Default: log metadata only
  - level: Metadata
    omitStages:
      - RequestReceived
```

Add the webhook backend configuration to the API server:

```yaml
# /etc/kubernetes/audit-webhook-config.yaml
apiVersion: v1
kind: Config
clusters:
  - name: falco-webhook
    cluster:
      server: http://falco.falco.svc.cluster.local:9765/k8s-audit
      # For TLS: certificate-authority: /etc/kubernetes/falco-ca.crt
preferences: {}
contexts:
  - name: falco-context
    context:
      cluster: falco-webhook
      user: ""
current-context: falco-context
```

Add these flags to the kube-apiserver manifest:

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml (excerpt)
spec:
  containers:
  - command:
    - kube-apiserver
    # ... existing flags ...
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    - --audit-webhook-config-file=/etc/kubernetes/audit-webhook-config.yaml
    - --audit-webhook-batch-max-size=400
    - --audit-webhook-batch-max-wait=5s
    - --audit-webhook-initial-backoff=10s
    volumeMounts:
    - mountPath: /etc/kubernetes/audit-policy.yaml
      name: audit-policy
      readOnly: true
    - mountPath: /etc/kubernetes/audit-webhook-config.yaml
      name: audit-webhook
      readOnly: true
  volumes:
  - hostPath:
      path: /etc/kubernetes/audit-policy.yaml
      type: File
    name: audit-policy
  - hostPath:
      path: /etc/kubernetes/audit-webhook-config.yaml
      type: File
    name: audit-webhook
```

### 5.2 k8saudit Plugin Rules

```yaml
# k8saudit custom rules
- rule: Kubernetes - ClusterRole with Wildcard Permissions Created
  desc: >
    A ClusterRole was created or modified to include wildcard resource
    permissions. This grants overly broad access and violates least
    privilege principles.
  condition: >
    k8s_audit and
    jevt.value[/verb] in (create, update, patch) and
    jevt.value[/objectRef/resource] = clusterroles and
    jevt.value[/responseStatus/code] in (200, 201) and
    (jevt.value[/requestObject/rules/0/resources/0] = "*" or
     jevt.value[/requestObject/rules/0/verbs/0] = "*")
  output: >
    ClusterRole with wildcard permissions created or modified
    (user=%jevt.value[/user/username]
    role=%jevt.value[/objectRef/name]
    verb=%jevt.value[/verb]
    userAgent=%jevt.value[/userAgent])
  priority: WARNING
  source: k8saudit
  tags: [privilege-escalation, rbac, kubernetes, enterprise, T1078]

- rule: Kubernetes - Pod Exec by Non-Admin User
  desc: >
    kubectl exec was used to enter a running pod by a user who is not
    in the approved administrators list. This may indicate unauthorized
    access to production workloads.
  condition: >
    k8s_audit and
    jevt.value[/verb] = create and
    jevt.value[/objectRef/subresource] = exec and
    not jevt.value[/user/username] in (kubernetes_admin_users) and
    not jevt.value[/user/groups] contains "system:masters"
  output: >
    Unauthorized pod exec attempt
    (user=%jevt.value[/user/username]
    pod=%jevt.value[/objectRef/name]
    ns=%jevt.value[/objectRef/namespace]
    command=%jevt.value[/requestObject/command]
    sourceIP=%jevt.value[/sourceIPs/0])
  priority: WARNING
  source: k8saudit
  tags: [execution, kubernetes, enterprise, T1609]

- rule: Kubernetes - Secret Created in kube-system Namespace
  desc: >
    A new secret was created directly in the kube-system namespace
    by a non-system service account. This is unusual and may indicate
    an attempt to plant credentials or backdoors.
  condition: >
    k8s_audit and
    jevt.value[/verb] = create and
    jevt.value[/objectRef/resource] = secrets and
    jevt.value[/objectRef/namespace] = kube-system and
    not jevt.value[/user/username] startswith "system:" and
    jevt.value[/responseStatus/code] in (200, 201)
  output: >
    Secret created in kube-system by non-system user
    (user=%jevt.value[/user/username]
    secret=%jevt.value[/objectRef/name]
    sourceIP=%jevt.value[/sourceIPs/0])
  priority: ERROR
  source: k8saudit
  tags: [persistence, credentials, kubernetes, enterprise, T1552.007]

- list: kubernetes_admin_users
  items:
    - admin
    - cluster-admin-user
    - sre-on-call

- macro: k8s_audit
  condition: jevt.value[/kind] = Event
```

## Section 6: Falcosidekick Deployment and Integration

### 6.1 Falcosidekick Architecture

Falcosidekick is a companion service that receives Falco JSON output (via HTTP or gRPC) and fans it out to dozens of downstream targets including Slack, PagerDuty, Elasticsearch, Splunk, Datadog, and custom webhooks.

### 6.2 Falcosidekick Helm Values

```yaml
# falcosidekick-values.yaml
replicaCount: 2

image:
  registry: docker.io
  repository: falcosecurity/falcosidekick
  tag: "2.29.0"

service:
  type: ClusterIP
  port: 2801

config:
  debug: false
  customfields: "cluster:production,region:us-east-1,team:security"
  checkcert: true

  slack:
    webhookurl: "<slack-webhook-url-placeholder>"
    channel: "#security-alerts"
    username: "Falco Security"
    icon: "https://falco.org/img/logos/falco-primary-logo.png"
    outputformat: "all"
    minimumpriority: "warning"
    messageformat: >
      *[{{.Priority}}]* {{.Rule}} | {{.Output}}
    mutualtls: false

  pagerduty:
    routingkey: "<pagerduty-routing-key-placeholder>"
    minimumpriority: "error"
    region: "us"

  elasticsearch:
    hostport: "http://elasticsearch.monitoring.svc.cluster.local:9200"
    index: "falco"
    type: "_doc"
    minimumpriority: "debug"
    suffix: "daily"
    mutualtls: false
    username: "falco"
    password: "<elasticsearch-password-placeholder>"
    enablecompression: true

  webhook:
    address: "http://siem-ingestor.security.svc.cluster.local:8080/falco"
    method: POST
    minimumpriority: "debug"
    customheaders: "X-Cluster-ID:production-us-east-1,X-Source:falco"
    mutualtls: false
    checkcert: false

  alertmanager:
    hostport: "http://alertmanager.monitoring.svc.cluster.local:9093"
    minimumpriority: "warning"
    endpoint: "/api/v2/alerts"
    expiresafter: 300

  grafana:
    hostport: "http://grafana.monitoring.svc.cluster.local:3000"
    apikey: "<grafana-api-key-placeholder>"
    dashboardid: 1
    panelid: 1
    allfieldsastags: true
    minimumpriority: "debug"
    mutualtls: false

resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 256Mi

podDisruptionBudget:
  enabled: true
  minAvailable: 1

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 5
  targetCPUUtilizationPercentage: 70
```

### 6.3 Install Falcosidekick

```bash
helm install falcosidekick falcosecurity/falcosidekick \
  --namespace falco \
  --values falcosidekick-values.yaml \
  --version 0.7.14
```

### 6.4 Connect Falco to Falcosidekick

Update the Falco values to forward HTTP output to Falcosidekick:

```yaml
# Add to falco-values.yaml
falco:
  http_output:
    enabled: true
    url: "http://falcosidekick.falco.svc.cluster.local:2801/"
    user_agent: "falcosecurity/falco"
```

### 6.5 Priority-Based Routing with Falcosidekick UI

```yaml
# Enable the web UI for alert visualization
falcosidekick:
  webui:
    enabled: true
    replicaCount: 1
    image:
      registry: docker.io
      repository: falcosecurity/falcosidekick-ui
      tag: "v2.2.0"
    redis:
      enabled: true
      storageEnabled: true
      storageSize: 1Gi
    ingress:
      enabled: true
      annotations:
        kubernetes.io/ingress.class: nginx
        nginx.ingress.kubernetes.io/auth-type: basic
        nginx.ingress.kubernetes.io/auth-secret: falco-ui-basic-auth
      hosts:
        - host: falco-ui.internal.example.com
          paths:
            - path: /
              pathType: Prefix
```

## Section 7: Metrics and Observability

### 7.1 Falco Prometheus Metrics

Falco v0.38 exposes native Prometheus metrics:

```yaml
# Enable metrics in falco.yaml
metrics:
  enabled: true
  interval: 15s
  output_rule: true
  rules_counters_enabled: true
  resource_utilization_enabled: true
  state_counters_enabled: true
  kernel_event_counters_enabled: true
  libbpf_stats_enabled: true
  convert_memory_to_mb: true
  include_empty_values: false
```

### 7.2 Prometheus ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: falco-metrics
  namespace: falco
  labels:
    app: falco
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: falco
  namespaceSelector:
    matchNames:
      - falco
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
```

### 7.3 Grafana Dashboard Queries

```promql
# Rule trigger rate by priority
sum(rate(falco_events_total[5m])) by (priority, rule)

# Top 10 most active rules
topk(10, sum(rate(falco_events_total[1h])) by (rule))

# Drop rate (events lost due to buffer overflow)
rate(falco_syscall_event_drops_total[5m])

# CPU usage by driver
rate(falco_cpu_usage_perc[5m])

# Memory usage
falco_memory_rss / 1024 / 1024
```

## Section 8: Production Operations

### 8.1 Hot-Reloading Rules

Falco v0.38 supports SIGHUP-based rule reload without process restart:

```bash
# Send SIGHUP to reload rules
FALCO_PID=$(kubectl exec -n falco ds/falco -- cat /var/run/falco.pid)
kubectl exec -n falco ds/falco -- kill -HUP $FALCO_PID

# Alternatively use the gRPC API (v0.38+)
falcoctl rule reload --grpc-unix-socket unix:///run/falco/falco.sock
```

### 8.2 Rule Performance Profiling

High-complexity rules with many string comparisons can impact syscall processing throughput. Profile with:

```bash
# Enable kernel event counters and check drop rate
kubectl exec -n falco ds/falco -- \
  curl -s http://localhost:8765/metrics | \
  grep -E "falco_syscall_event_drops|falco_cpu_usage"

# Check rule evaluation time distribution
kubectl logs -n falco ds/falco | grep "Performance" | tail -20
```

### 8.3 Tuning for High-Traffic Nodes

```yaml
# High-throughput node tuning in falco.yaml
syscall_buf_size_preset: 4        # 4 = 8MB ring buffer
syscall_event_drops:
  actions:
    - log
  rate: 0.03333
  max_burst: 10

# Increase output worker threads
outputs:
  - rate: 1000
    max_burst: 5000
```

### 8.4 Multi-Cluster Centralization

```yaml
# Deploy Falcosidekick with centralized Elasticsearch for multi-cluster
config:
  customfields: "cluster:${CLUSTER_NAME},env:${ENV}"
  elasticsearch:
    hostport: "https://elastic.central-siem.example.com:9200"
    index: "falco-${CLUSTER_NAME}"
    username: "falco-writer"
    password: "<elasticsearch-password-placeholder>"
    mutualtls: true
    certs: /etc/falcosidekick/tls
```

## Section 9: Troubleshooting

### 9.1 Common Issues

**Falco not detecting events:**

```bash
# Verify eBPF program is loaded
kubectl exec -n falco ds/falco -- falco --version
kubectl exec -n falco ds/falco -- ls /sys/kernel/debug/tracing/events/syscalls/

# Check kernel version compatibility
uname -r
falco-driver-loader --check

# Inspect driver loader logs
kubectl logs -n falco ds/falco -c falco-driver-loader
```

**k8saudit plugin not receiving events:**

```bash
# Test webhook connectivity
kubectl run test-curl --image=curlimages/curl --restart=Never --rm -it -- \
  curl -v http://falco.falco.svc.cluster.local:9765/k8s-audit \
  -H "Content-Type: application/json" \
  -d '{"kind":"EventList","items":[]}'

# Check API server audit webhook config
kubectl get --raw /healthz/ready
kubectl logs -n kube-system kube-apiserver-* | grep audit | tail -20
```

**High drop rate:**

```bash
# Increase ring buffer size
kubectl patch configmap falco-config -n falco \
  --patch '{"data":{"falco.yaml": "syscall_buf_size_preset: 4\n"}}'

# Or tune the kernel parameter
sysctl -w kernel.perf_event_max_stack=127
```

### 9.2 Rule Debugging

```bash
# Test a rule against a captured trace
falco -r custom-enterprise-rules.yaml \
      -e captured-trace.scap \
      --option "log_level=debug" 2>&1 | grep -i "rule\|error"

# Validate rule syntax
falco --validate /etc/falco/rules.d/custom-enterprise-rules.yaml
```

## Summary

Falco v0.38 provides a mature, production-grade runtime security platform for Kubernetes environments. The key capabilities covered in this guide:

- Installing Falco with the eBPF driver via Helm with production-ready values
- Authoring custom rules using lists, macros, conditions, and the exceptions mechanism
- Consuming alerts programmatically via the stable gRPC Unix socket API
- Integrating Kubernetes audit events through the k8saudit plugin and API server webhook
- Deploying Falcosidekick for multi-destination alert routing to Slack, PagerDuty, and Elasticsearch
- Exposing Prometheus metrics and building Grafana dashboards for operational visibility

The combination of syscall-level detection, Kubernetes audit integration, and flexible output routing makes this stack a solid foundation for a cloud-native SIEM. The investment in custom rule authoring pays dividends by eliminating noise and surfacing the behavioral anomalies that matter to your environment.
